import type {
  CellValue,
  ConnectionConfig,
  DatabaseType,
  QueryResult,
  Row,
  SchemaInfo,
  SortSpec,
  TablePage,
  TableRef,
  TableStructure,
  FilterCondition,
} from '../../shared/types';
import { buildBrowseQuery, buildCountQuery, limitSelect } from '../../core/queryBuilder';
import { buildDelete, buildInsert, buildUpdate, type Mutation } from '../../core/mutations';
import { serializeResult } from '../../core/serialization';
import { quoteIdentifier } from '../../core/identifiers';

export interface QueryOptions {
  maxRows?: number;
  timeoutMs?: number;
}

export interface Driver {
  readonly type: DatabaseType;
  readonly config: ConnectionConfig;
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  listSchemas(): Promise<SchemaInfo[]>;
  getStructure(table: TableRef): Promise<TableStructure>;
  executeQuery(sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult>;
  loadPage(options: {
    table: TableRef;
    offset: number;
    limit: number;
    sort?: SortSpec;
    filters?: FilterCondition[];
    includeCount: boolean;
  }): Promise<TablePage>;
  updateRow(table: TableRef, primaryKey: Record<string, CellValue>, column: string, value: CellValue): Promise<void>;
  insertRow(table: TableRef, values: Record<string, CellValue>): Promise<void>;
  deleteRows(table: TableRef, primaryKeys: Record<string, CellValue>[]): Promise<void>;
  dropTable(table: TableRef): Promise<void>;
  truncateTable(table: TableRef): Promise<void>;
}

export abstract class BaseDriver implements Driver {
  abstract readonly type: DatabaseType;
  protected connected = false;

  constructor(readonly config: ConnectionConfig) {}

  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract listSchemas(): Promise<SchemaInfo[]>;
  abstract getStructure(table: TableRef): Promise<TableStructure>;
  abstract executeQuery(sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult>;
  protected abstract executeMutation(mutation: Mutation): Promise<number>;

  isConnected(): boolean {
    return this.connected;
  }

  async loadPage(options: {
    table: TableRef;
    offset: number;
    limit: number;
    sort?: SortSpec;
    filters?: FilterCondition[];
    includeCount: boolean;
  }): Promise<TablePage> {
    const structure = await this.getStructure(options.table);
    const columnNames = structure.columns.map((column) => column.name);
    const rowId = structure.primaryKey.length === 1 && structure.primaryKey[0] === '__dbv_rowid';
    const start = performance.now();
    const browse = buildBrowseQuery(options.table, columnNames, this.type, {
      offset: options.offset,
      limit: options.limit,
      sort: options.sort,
      filters: options.filters,
      rowId,
    });
    const result = await this.executeQuery(browse.sql, browse.params, { maxRows: options.limit });
    let total: number | null = null;
    if (options.includeCount) {
      const count = buildCountQuery(options.table, columnNames, this.type, options.filters);
      const countResult = await this.executeQuery(count.sql, count.params, { maxRows: 1 });
      const raw = countResult.rows[0]?.dbv_count;
      total = typeof raw === 'number' ? raw : Number(raw ?? 0);
    }
    const primaryKey = structure.primaryKey.filter((name) => name === '__dbv_rowid' || columnNames.includes(name));
    const editable = !this.config.readonly && primaryKey.length > 0;
    return {
      schema: options.table.schema,
      table: options.table.name,
      columns: structure.columns,
      rows: result.rows,
      offset: options.offset,
      limit: options.limit,
      total,
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      primaryKey,
      editable,
      editReason: editable
        ? undefined
        : this.config.readonly
          ? 'Connection is read-only'
          : 'Table has no primary key or rowid',
    };
  }

  async updateRow(
    table: TableRef,
    primaryKey: Record<string, CellValue>,
    column: string,
    value: CellValue,
  ): Promise<void> {
    this.assertWritable();
    const structure = await this.getStructure(table);
    const mutation = buildUpdate(
      table,
      this.type,
      structure.columns.map((item) => item.name),
      primaryKey,
      { [column]: value },
    );
    await this.executeMutation(mutation);
  }

  async insertRow(table: TableRef, values: Record<string, CellValue>): Promise<void> {
    this.assertWritable();
    const structure = await this.getStructure(table);
    const mutation = buildInsert(
      table,
      this.type,
      structure.columns.map((item) => item.name),
      values,
    );
    await this.executeMutation(mutation);
  }

  async deleteRows(table: TableRef, primaryKeys: Record<string, CellValue>[]): Promise<void> {
    this.assertWritable();
    const structure = await this.getStructure(table);
    const allowed = [...structure.columns.map((item) => item.name), '__dbv_rowid'];
    for (const primaryKey of primaryKeys) {
      await this.executeMutation(buildDelete(table, this.type, allowed, primaryKey));
    }
  }

  async dropTable(table: TableRef): Promise<void> {
    this.assertWritable();
    const qualified = table.schema
      ? `${quoteIdentifier(table.schema, this.type)}.${quoteIdentifier(table.name, this.type)}`
      : quoteIdentifier(table.name, this.type);
    await this.executeMutation({
      sql: `DROP ${table.type === 'view' ? 'VIEW' : 'TABLE'} ${qualified}`,
      params: [],
    });
  }

  async truncateTable(table: TableRef): Promise<void> {
    this.assertWritable();
    const qualified = table.schema
      ? `${quoteIdentifier(table.schema, this.type)}.${quoteIdentifier(table.name, this.type)}`
      : quoteIdentifier(table.name, this.type);
    if (this.type === 'sqlite') {
      await this.executeMutation({ sql: `DELETE FROM ${qualified}`, params: [] });
    } else if (this.type === 'mssql') {
      await this.executeMutation({ sql: `DELETE FROM ${qualified}`, params: [] });
    } else {
      await this.executeMutation({ sql: `TRUNCATE TABLE ${qualified}`, params: [] });
    }
  }

  protected assertWritable(): void {
    if (this.config.readonly) throw new Error('This connection is read-only');
  }

  /** Runs a user query with a bounded number of returned rows. */
  protected async runSQL(
    sql: string,
    params: unknown[],
    options: QueryOptions,
    executor: (sql: string, params: unknown[]) => Promise<{
      columns: string[];
      rows: Row[];
      rowCount: number;
      message?: string;
    }>,
  ): Promise<QueryResult> {
    const maxRows = Math.max(1, options.maxRows ?? 1000);
    const started = performance.now();
    const limited = limitSelect(sql, this.type, maxRows + 1);
    const raw = await executor(limited, params);
    return serializeResult({
      columns: raw.columns,
      rows: raw.rows.slice(0, maxRows),
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      truncated: raw.rows.length > maxRows,
      rowCount: raw.rowCount,
      message: raw.message,
    });
  }
}
