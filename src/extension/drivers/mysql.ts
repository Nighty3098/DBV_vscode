import mysql, { type Pool, type ResultSetHeader, type FieldPacket, type RowDataPacket } from 'mysql2/promise';
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
import { limitSelect, splitSqlStatements } from '../../core/queryBuilder';
import type { Mutation } from '../../core/mutations';
import { serializeResult } from '../../core/serialization';
import { quoteIdentifier, quoteQualified } from '../../core/identifiers';
import { logger } from '../logger';

const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys'];

interface MySqlColumn {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: 'YES' | 'NO';
  COLUMN_DEFAULT: string | null;
  ORDINAL_POSITION: number;
  EXTRA: string;
  COLUMN_KEY: string;
}

export class MysqlDriver extends BaseDriver {
  readonly type: DatabaseType;
  private pool: Pool | undefined;

  constructor(config: ConnectionConfig, private readonly password = '') {
    super(config);
    this.type = config.type === 'mariadb' ? 'mariadb' : 'mysql';
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    const pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.password,
      database: this.config.database,
      ssl: this.config.ssl
        ? { rejectUnauthorized: this.config.ssl === 'verify-full' }
        : undefined,
      waitForConnections: true,
      connectionLimit: 4,
      connectTimeout: 15_000,
      enableKeepAlive: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    });
    try {
      const connection = await pool.getConnection();
      connection.release();
      this.pool = pool;
      this.connected = true;
    } catch (error) {
      await pool.end().catch((closeError: unknown) => {
        logger.warn(`Could not clean up failed MySQL connection "${this.config.name}"`, closeError);
      });
      throw new Error(`${this.type === 'mariadb' ? 'MariaDB' : 'MySQL'} connection failed: ${errorMessage(error)}`);
    }
  }

  async close(): Promise<void> {
    await this.pool?.end().catch((error: unknown) => {
      logger.warn(`Could not close MySQL connection "${this.config.name}"`, error);
    });
    this.pool = undefined;
    this.connected = false;
  }

  private getPool(): Pool {
    if (!this.pool) throw new Error('MySQL connection is not open');
    return this.pool;
  }

  private defaultSchema(): string {
    return this.config.database ?? '';
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const pool = this.getPool();
    const [schemaRows] = await pool.query<RowDataPacket[]>(
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN (?, ?, ?, ?) ORDER BY SCHEMA_NAME`,
      SYSTEM_SCHEMAS,
    );
    const names = schemaRows.map((row) => String(row.SCHEMA_NAME));
    if (!names.length) return [];
    const [tableRows] = await pool.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
       WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      [names],
    );
    const grouped = new Map<string, SchemaInfo['tables']>();
    for (const name of names) grouped.set(name, []);
    for (const row of tableRows) {
      grouped.get(String(row.TABLE_SCHEMA))?.push({
        schema: String(row.TABLE_SCHEMA),
        name: String(row.TABLE_NAME),
        type: String(row.TABLE_TYPE).toUpperCase().includes('VIEW') ? 'view' : 'table',
      });
    }
    return names.map((name) => ({ name, tables: grouped.get(name) ?? [] }));
  }

  async getStructure(table: TableRef): Promise<TableStructure> {
    const pool = this.getPool();
    const schema = table.schema ?? this.defaultSchema();
    const [columnRows] = await pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION, EXTRA, COLUMN_KEY
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table.name],
    );
    const [indexRows] = await pool.query<RowDataPacket[]>(
      `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schema, table.name],
    );
    const [fkRows] = await pool.query<RowDataPacket[]>(
      `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
              k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
              r.DELETE_RULE, r.UPDATE_RULE, k.ORDINAL_POSITION
       FROM information_schema.KEY_COLUMN_USAGE k
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [schema, table.name],
    );
    const columns: ColumnInfo[] = (columnRows as unknown as MySqlColumn[]).map((row) => ({
      name: row.COLUMN_NAME,
      dataType: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      primaryKey: row.COLUMN_KEY === 'PRI',
      autoIncrement: row.EXTRA.includes('auto_increment'),
      ordinal: Number(row.ORDINAL_POSITION),
    }));
    const indexes: IndexInfo[] = [];
    const indexMap = new Map<string, IndexInfo>();
    for (const row of indexRows) {
      const name = String(row.INDEX_NAME);
      const existing = indexMap.get(name) ?? {
        name,
        columns: [],
        unique: Number(row.NON_UNIQUE) === 0,
        primary: name === 'PRIMARY',
      };
      existing.columns.push(String(row.COLUMN_NAME));
      indexMap.set(name, existing);
    }
    indexes.push(...indexMap.values());
    const fkMap = new Map<string, ForeignKeyInfo>();
    for (const row of fkRows) {
      const name = String(row.CONSTRAINT_NAME);
      const existing = fkMap.get(name) ?? {
        name,
        columns: [],
        referencedSchema: row.REFERENCED_TABLE_SCHEMA ? String(row.REFERENCED_TABLE_SCHEMA) : undefined,
        referencedTable: String(row.REFERENCED_TABLE_NAME),
        referencedColumns: [],
        onDelete: row.DELETE_RULE ? String(row.DELETE_RULE) : undefined,
        onUpdate: row.UPDATE_RULE ? String(row.UPDATE_RULE) : undefined,
      };
      existing.columns.push(String(row.COLUMN_NAME));
      existing.referencedColumns.push(String(row.REFERENCED_COLUMN_NAME));
      fkMap.set(name, existing);
    }
    const primaryKey = columns.filter((column) => column.primaryKey).map((column) => column.name);
    return {
      table: { ...table, schema },
      columns,
      indexes,
      foreignKeys: [...fkMap.values()],
      primaryKey,
      rowIdAvailable: false,
      ddl: generateMysqlDdl(table, schema, columns, primaryKey),
    };
  }

  async executeQuery(sql: string, params: unknown[] = [], options: QueryOptions = {}): Promise<QueryResult> {
    const statements = splitSqlStatements(sql);
    if (!statements.length) throw new Error('SQL statement is empty');
    const maxRows = Math.max(1, options.maxRows ?? 1000);
    let last: QueryResult | undefined;
    for (const raw of statements) {
      const statement = params.length === 0 && options.maxRows
        ? limitSelect(raw, this.type, maxRows + 1)
        : raw;
      const started = performance.now();
      const [result, fields] = await this.getPool().query({
        sql: statement,
        values: params,
        timeout: options.timeoutMs,
      });
      if (Array.isArray(result)) {
        const rows = result.slice(0, maxRows) as Row[];
        last = serializeResult({
          columns: (fields as FieldPacket[] | undefined)?.map((field) => field.name) ?? [],
          rows,
          rowCount: result.length,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
          truncated: result.length > maxRows,
        });
      } else {
        const header = result as ResultSetHeader;
        last = serializeResult({
          columns: [],
          rows: [],
          rowCount: header.affectedRows ?? 0,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
          message: `Query OK · ${header.affectedRows ?? 0} row(s) affected`,
        });
      }
    }
    return last!;
  }

  protected async executeMutation(mutation: Mutation): Promise<number> {
    const [result] = await this.getPool().query(mutation.sql, mutation.params as never[]);
    if (Array.isArray(result)) return result.length;
    return (result as ResultSetHeader).affectedRows ?? 0;
  }

  override async dropTable(table: TableRef): Promise<void> {
    this.assertWritable();
    const schema = table.schema ?? this.defaultSchema();
    await this.executeMutation({
      sql: `DROP ${table.type === 'view' ? 'VIEW' : 'TABLE'} ${quoteQualified(schema, table.name, this.type)}`,
      params: [],
    });
  }

  override async truncateTable(table: TableRef): Promise<void> {
    this.assertWritable();
    const schema = table.schema ?? this.defaultSchema();
    await this.executeMutation({
      sql: `TRUNCATE TABLE ${quoteQualified(schema, table.name, this.type)}`,
      params: [],
    });
  }
}

function generateMysqlDdl(
  table: TableRef,
  schema: string,
  columns: ColumnInfo[],
  primaryKey: string[],
): string {
  const definitions = columns.map((column) => {
    let definition = `  ${quoteIdentifier(column.name, 'mysql')} ${column.dataType}`;
    if (!column.nullable) definition += ' NOT NULL';
    if (column.autoIncrement) definition += ' AUTO_INCREMENT';
    if (column.defaultValue !== null) definition += ` DEFAULT ${column.defaultValue}`;
    return definition;
  });
  if (primaryKey.length) {
    definitions.push(`  PRIMARY KEY (${primaryKey.map((name) => quoteIdentifier(name, 'mysql')).join(', ')})`);
  }
  return `CREATE TABLE ${quoteQualified(schema, table.name, 'mysql')} (\n${definitions.join(',\n')}\n);`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
