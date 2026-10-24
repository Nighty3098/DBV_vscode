import { Pool, type QueryConfig, type QueryResult as PgResult } from 'pg';
import type {
  ColumnInfo,
  DatabaseType,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  Row,
  SchemaInfo,
  TableRef,
  TableStructure,
} from '../../shared/types';
import type { ConnectionConfig } from '../../shared/types';
import { BaseDriver, type QueryOptions } from './base';
import { convertPlaceholders } from '../../core/placeholders';
import { limitSelect, splitSqlStatements } from '../../core/queryBuilder';
import type { Mutation } from '../../core/mutations';
import { serializeResult } from '../../core/serialization';
import { quoteIdentifier, quoteQualified } from '../../core/identifiers';
import { logger } from '../logger';

type PgPool = Pool;

export interface DriverSecret {
  password?: string;
}

export class PostgresDriver extends BaseDriver {
  readonly type: DatabaseType = 'postgres';
  private pool: PgPool | undefined;

  constructor(config: ConnectionConfig, private readonly secret: DriverSecret = {}) {
    super(config);
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    const pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.secret.password,
      ssl: this.config.ssl ? { rejectUnauthorized: this.config.ssl === 'verify-full' } : false,
      application_name: 'DBV for VS Code',
      max: 4,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (error: Error) => {
      logger.warn(`PostgreSQL idle connection error for "${this.config.name}"`, error);
    });
    try {
      await pool.query('SELECT 1');
      this.pool = pool;
      this.connected = true;
    } catch (error) {
      await pool.end().catch((closeError: unknown) => {
        logger.warn(`Could not clean up failed PostgreSQL connection "${this.config.name}"`, closeError);
      });
      throw new Error(`PostgreSQL connection failed: ${errorMessage(error)}`);
    }
  }

  async close(): Promise<void> {
    await this.pool?.end().catch((error: unknown) => {
      logger.warn(`Could not close PostgreSQL connection "${this.config.name}"`, error);
    });
    this.pool = undefined;
    this.connected = false;
  }

  private getPool(): PgPool {
    if (!this.pool) throw new Error('PostgreSQL connection is not open');
    return this.pool;
  }

  private async pgQuery(sql: string, values: unknown[] = [], timeoutMs = 60_000): Promise<PgResult> {
    return this.getPool().query({ text: sql, values, query_timeout: timeoutMs } as unknown as QueryConfig);
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const schemasResult = await this.pgQuery(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
       ORDER BY nspname`,
    );
    const names = schemasResult.rows.map((row: { nspname: string }) => row.nspname);
    if (!names.length) return [];
    const tablesResult = await this.pgQuery(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = ANY($1::text[])
       ORDER BY table_schema, table_name`,
      [names],
    );
    const grouped = new Map<string, SchemaInfo['tables']>();
    for (const name of names) grouped.set(name, []);
    for (const row of tablesResult.rows as Array<{ table_schema: string; table_name: string; table_type: string }>) {
      grouped.get(row.table_schema)?.push({
        schema: row.table_schema,
        name: row.table_name,
        type: row.table_type === 'VIEW' ? 'view' : 'table',
      });
    }
    return names.map((name) => ({ name, tables: grouped.get(name) ?? [] }));
  }

  async getStructure(table: TableRef): Promise<TableStructure> {
    const schema = table.schema ?? this.config.schema ?? 'public';
    const columnsResult = await this.pgQuery(
      `SELECT column_name, data_type, is_nullable, column_default, ordinal_position, is_identity
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table.name],
    );
    const pkResult = await this.pgQuery(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [schema, table.name],
    );
    const pkNames = new Set(pkResult.rows.map((row: { column_name: string }) => row.column_name));
    const indexResult = await this.pgQuery(
      `SELECT i.relname AS name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary, a.attname
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       WHERE t.relname = $1 AND n.nspname = $2
       ORDER BY i.relname, a.attnum`,
      [table.name, schema],
    );
    const indexes = groupIndexes(
      indexResult.rows as Array<{ name: string; is_unique: boolean; is_primary: boolean; attname: string }>,
    );
    const fkResult = await this.pgQuery(
      `SELECT con.conname AS name,
              (SELECT array_agg(a.attname ORDER BY k.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
              fn.nspname AS ref_schema, fc.relname AS ref_table,
              (SELECT array_agg(a.attname ORDER BY k.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns,
              con.confdeltype AS delete_action, con.confupdtype AS update_action
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       WHERE con.contype = 'f' AND c.relname = $1 AND n.nspname = $2`,
      [table.name, schema],
    );
    const foreignKeys: ForeignKeyInfo[] = (
      fkResult.rows as Array<{
        name: string;
        columns: string[];
        ref_schema: string;
        ref_table: string;
        ref_columns: string[];
        delete_action: string;
        update_action: string;
      }>
    ).map((row) => ({
      name: row.name,
      columns: row.columns,
      referencedSchema: row.ref_schema,
      referencedTable: row.ref_table,
      referencedColumns: row.ref_columns,
      onDelete: pgAction(row.delete_action),
      onUpdate: pgAction(row.update_action),
    }));
    const columns: ColumnInfo[] = (
      columnsResult.rows as Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        ordinal_position: number;
        is_identity: string;
      }>
    ).map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      primaryKey: pkNames.has(row.column_name),
      autoIncrement: row.is_identity === 'YES' || /nextval\(/i.test(row.column_default ?? ''),
      ordinal: Number(row.ordinal_position),
    }));
    return {
      table: { ...table, schema },
      columns,
      indexes,
      foreignKeys,
      primaryKey: [...pkNames],
      rowIdAvailable: false,
      ddl: generatePostgresDdl(table, schema, columns, pkNames),
    };
  }

  async executeQuery(sql: string, params: unknown[] = [], options: QueryOptions = {}): Promise<QueryResult> {
    const statements = splitSqlStatements(sql);
    if (!statements.length) throw new Error('SQL statement is empty');
    let last: QueryResult | undefined;
    for (const rawStatement of statements) {
      const bounded = params.length === 0 && options.maxRows
        ? limitSelect(rawStatement, 'postgres', Math.max(1, options.maxRows) + 1)
        : rawStatement.replace(/;+$/, '');
      const query = convertPlaceholders(bounded, 'postgres');
      const started = performance.now();
      const result = await this.pgQuery(query.sql, params, options.timeoutMs);
      const maxRows = Math.max(1, options.maxRows ?? 1000);
      const columns = result.fields.map((field) => field.name);
      const rows = result.rows.slice(0, maxRows) as Row[];
      last = serializeResult({
        columns,
        rows,
        rowCount: result.rowCount ?? rows.length,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        truncated: result.rows.length > maxRows,
        message: columns.length ? undefined : `${result.command} ${result.rowCount ?? 0} row(s) affected`,
      });
    }
    return last!;
  }

  protected async executeMutation(mutation: Mutation): Promise<number> {
    const query = convertPlaceholders(mutation.sql, 'postgres');
    const result = await this.pgQuery(query.sql, mutation.params);
    return result.rowCount ?? 0;
  }

  override async dropTable(table: TableRef): Promise<void> {
    this.assertWritable();
    const schema = table.schema ?? this.config.schema ?? 'public';
    await this.executeMutation({
      sql: `DROP ${table.type === 'view' ? 'VIEW' : 'TABLE'} ${quoteQualified(schema, table.name, 'postgres')}`,
      params: [],
    });
  }

  override async truncateTable(table: TableRef): Promise<void> {
    this.assertWritable();
    const schema = table.schema ?? this.config.schema ?? 'public';
    await this.executeMutation({
      sql: `TRUNCATE TABLE ${quoteQualified(schema, table.name, 'postgres')}`,
      params: [],
    });
  }
}

function groupIndexes(
  rows: Array<{ name: string; is_unique: boolean; is_primary: boolean; attname: string }>,
): IndexInfo[] {
  const grouped = new Map<string, IndexInfo>();
  for (const row of rows) {
    const existing = grouped.get(row.name) ?? {
      name: row.name,
      columns: [],
      unique: row.is_unique,
      primary: row.is_primary,
    };
    if (!existing.columns.includes(row.attname)) existing.columns.push(row.attname);
    grouped.set(row.name, existing);
  }
  return [...grouped.values()];
}

function generatePostgresDdl(
  table: TableRef,
  schema: string,
  columns: ColumnInfo[],
  primaryKey: Set<string>,
): string {
  const definitions = columns.map((column) => {
    let definition = `  ${quoteIdentifier(column.name, 'postgres')} ${column.dataType || 'text'}`;
    if (column.defaultValue) definition += ` DEFAULT ${column.defaultValue}`;
    if (!column.nullable) definition += ' NOT NULL';
    return definition;
  });
  if (primaryKey.size) {
    definitions.push(`  PRIMARY KEY (${[...primaryKey].map((name) => quoteIdentifier(name, 'postgres')).join(', ')})`);
  }
  return `CREATE TABLE ${quoteQualified(schema, table.name, 'postgres')} (\n${definitions.join(',\n')}\n);`;
}

function pgAction(code: string): string {
  return (
    {
      a: 'NO ACTION',
      r: 'RESTRICT',
      c: 'CASCADE',
      n: 'SET NULL',
      d: 'SET DEFAULT',
    }[code] ?? code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
