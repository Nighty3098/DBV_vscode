import mssql from 'mssql';
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

interface MssqlColumnRow {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  ORDINAL_POSITION: number;
  is_identity: number | null;
}

export class MssqlDriver extends BaseDriver {
  readonly type: DatabaseType = 'mssql';
  private pool: mssql.ConnectionPool | undefined;

  constructor(config: ConnectionConfig, private readonly password = '') {
    super(config);
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    const pool = new mssql.ConnectionPool({
      server: this.config.host ?? 'localhost',
      port: this.config.port ?? 1433,
      database: this.config.database,
      user: this.config.user,
      password: this.password,
      connectionTimeout: 15_000,
      requestTimeout: 60_000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
      options: {
        encrypt: Boolean(this.config.ssl),
        trustServerCertificate: this.config.ssl !== 'verify-full',
        enableArithAbort: true,
        appName: 'DBV for VS Code',
      },
    });
    try {
      await pool.connect();
      this.pool = pool;
      this.connected = true;
    } catch (error) {
      await pool.close().catch((closeError: unknown) => {
        logger.warn(`Could not clean up failed SQL Server connection "${this.config.name}"`, closeError);
      });
      throw new Error(`SQL Server connection failed: ${errorMessage(error)}`);
    }
  }

  async close(): Promise<void> {
    await this.pool?.close().catch((error: unknown) => {
      logger.warn(`Could not close SQL Server connection "${this.config.name}"`, error);
    });
    this.pool = undefined;
    this.connected = false;
  }

  private getPool(): mssql.ConnectionPool {
    if (!this.pool) throw new Error('SQL Server connection is not open');
    return this.pool;
  }

  private async queryNative(
    sql: string,
    params: unknown[] = [],
    timeoutMs?: number,
  ): Promise<mssql.IResult<Record<string, unknown>>> {
    const converted = convertPlaceholders(sql, 'mssql');
    const request = this.getPool().request();
    if (timeoutMs) (request as unknown as { timeout: number }).timeout = timeoutMs;
    params.slice(0, converted.count).forEach((value, index) => {
      bindValue(request, `p${index}`, value);
    });
    return request.query(converted.sql);
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const result = await this.queryNative(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    const grouped = new Map<string, SchemaInfo['tables']>();
    for (const row of result.recordset ?? []) {
      const schema = String(row.TABLE_SCHEMA);
      const group = grouped.get(schema) ?? [];
      group.push({
        schema,
        name: String(row.TABLE_NAME),
        type: String(row.TABLE_TYPE).toUpperCase().includes('VIEW') ? 'view' : 'table',
      });
      grouped.set(schema, group);
    }
    return [...grouped.entries()].map(([name, tables]) => ({ name, tables }));
  }

  async getStructure(table: TableRef): Promise<TableStructure> {
    const schema = table.schema ?? this.config.schema ?? 'dbo';
    const columnResult = await this.queryNative(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
              c.ORDINAL_POSITION,
              COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)),
                             c.COLUMN_NAME, 'IsIdentity') AS is_identity
       FROM INFORMATION_SCHEMA.COLUMNS c
       WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
       ORDER BY c.ORDINAL_POSITION`,
      [schema, table.name],
    );
    const pkResult = await this.queryNative(
      `SELECT c.name AS column_name
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       JOIN sys.tables t ON t.object_id = i.object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       WHERE i.is_primary_key = 1 AND s.name = ? AND t.name = ?
       ORDER BY ic.key_ordinal`,
      [schema, table.name],
    );
    const pkNames = new Set((pkResult.recordset ?? []).map((row) => String(row.column_name)));
    const indexResult = await this.queryNative(
      `SELECT i.name, i.is_unique, i.is_primary_key, c.name AS column_name
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       JOIN sys.tables t ON t.object_id = i.object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       WHERE s.name = ? AND t.name = ? AND i.name IS NOT NULL
       ORDER BY i.name, ic.key_ordinal`,
      [schema, table.name],
    );
    const fkResult = await this.queryNative(
      `SELECT fk.name AS constraint_name, pc.name AS column_name,
              rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column,
              fk.delete_referential_action_desc AS delete_action,
              fk.update_referential_action_desc AS update_action
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
       JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       WHERE ps.name = ? AND pt.name = ?
       ORDER BY fk.name, fkc.constraint_column_id`,
      [schema, table.name],
    );
    const columns: ColumnInfo[] = (columnResult.recordset as unknown as MssqlColumnRow[]).map((row) => ({
      name: row.COLUMN_NAME,
      dataType: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      primaryKey: pkNames.has(row.COLUMN_NAME),
      autoIncrement: row.is_identity === 1,
      ordinal: Number(row.ORDINAL_POSITION),
    }));
    const indexMap = new Map<string, IndexInfo>();
    for (const row of indexResult.recordset ?? []) {
      const name = String(row.name);
      const existing = indexMap.get(name) ?? {
        name,
        columns: [],
        unique: Boolean(row.is_unique),
        primary: Boolean(row.is_primary_key),
      };
      existing.columns.push(String(row.column_name));
      indexMap.set(name, existing);
    }
    const fkMap = new Map<string, ForeignKeyInfo>();
    for (const row of fkResult.recordset ?? []) {
      const name = String(row.constraint_name);
      const existing = fkMap.get(name) ?? {
        name,
        columns: [],
        referencedSchema: String(row.ref_schema),
        referencedTable: String(row.ref_table),
        referencedColumns: [],
        onDelete: String(row.delete_action).replace(/_/g, ' '),
        onUpdate: String(row.update_action).replace(/_/g, ' '),
      };
      existing.columns.push(String(row.column_name));
      existing.referencedColumns.push(String(row.ref_column));
      fkMap.set(name, existing);
    }
    return {
      table: { ...table, schema },
      columns,
      indexes: [...indexMap.values()],
      foreignKeys: [...fkMap.values()],
      primaryKey: [...pkNames],
      rowIdAvailable: false,
      ddl: generateMssqlDdl(table, schema, columns, pkNames),
    };
  }

  async executeQuery(sql: string, params: unknown[] = [], options: QueryOptions = {}): Promise<QueryResult> {
    const statements = splitSqlStatements(sql);
    if (!statements.length) throw new Error('SQL statement is empty');
    const maxRows = Math.max(1, options.maxRows ?? 1000);
    let last: QueryResult | undefined;
    for (const raw of statements) {
      const statement = params.length === 0 && options.maxRows
        ? limitSelect(raw, 'mssql', maxRows + 1)
        : raw;
      const started = performance.now();
      const result = await this.queryNative(statement, params, options.timeoutMs);
      const recordset = result.recordset ?? [];
      const columns = recordset.columns ? Object.keys(recordset.columns) : [];
      const rows = (recordset as unknown as Row[]).slice(0, maxRows);
      const affected = result.rowsAffected?.reduce((total, value) => total + value, 0) ?? 0;
      last = serializeResult({
        columns,
        rows,
        rowCount: columns.length ? recordset.length : affected,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        truncated: recordset.length > maxRows,
        message: columns.length ? undefined : `Query OK · ${affected} row(s) affected`,
      });
    }
    return last!;
  }

  protected async executeMutation(mutation: Mutation): Promise<number> {
    const result = await this.queryNative(mutation.sql, mutation.params);
    return result.rowsAffected?.reduce((total, value) => total + value, 0) ?? 0;
  }

  override async dropTable(table: TableRef): Promise<void> {
    this.assertWritable();
    const schema = table.schema ?? this.config.schema ?? 'dbo';
    await this.executeMutation({
      sql: `DROP ${table.type === 'view' ? 'VIEW' : 'TABLE'} ${quoteQualified(schema, table.name, 'mssql')}`,
      params: [],
    });
  }

  override async truncateTable(table: TableRef): Promise<void> {
    this.assertWritable();
    const schema = table.schema ?? this.config.schema ?? 'dbo';
    await this.executeMutation({
      sql: `TRUNCATE TABLE ${quoteQualified(schema, table.name, 'mssql')}`,
      params: [],
    });
  }
}

function bindValue(request: mssql.Request, name: string, value: unknown): void {
  if (value === null || value === undefined) {
    request.input(name, mssql.NVarChar, null);
  } else if (typeof value === 'number') {
    request.input(name, mssql.Float, value);
  } else if (typeof value === 'boolean') {
    request.input(name, mssql.Bit, value);
  } else if (Buffer.isBuffer(value)) {
    request.input(name, mssql.VarBinary, value);
  } else if (value instanceof Date) {
    request.input(name, mssql.DateTime2, value);
  } else {
    request.input(name, mssql.NVarChar, String(value));
  }
}

function generateMssqlDdl(
  table: TableRef,
  schema: string,
  columns: ColumnInfo[],
  primaryKey: Set<string>,
): string {
  const definitions = columns.map((column) => {
    let definition = `  ${quoteIdentifier(column.name, 'mssql')} ${column.dataType}`;
    if (column.autoIncrement) definition += ' IDENTITY(1,1)';
    if (!column.nullable) definition += ' NOT NULL';
    if (column.defaultValue !== null) definition += ` DEFAULT ${column.defaultValue}`;
    return definition;
  });
  if (primaryKey.size) {
    definitions.push(`  PRIMARY KEY (${[...primaryKey].map((name) => quoteIdentifier(name, 'mssql')).join(', ')})`);
  }
  return `CREATE TABLE ${quoteQualified(schema, table.name, 'mssql')} (\n${definitions.join(',\n')}\n);`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
