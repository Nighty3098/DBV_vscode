/** Shared, JSON-safe types used by the extension host and the webview. */

export type DatabaseType = 'sqlite' | 'postgres' | 'mysql' | 'mariadb' | 'mssql';

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DatabaseType;
  /** Absolute path for SQLite databases. */
  file?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  schema?: string;
  ssl?: boolean | 'require' | 'verify-full';
  readonly?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionSummary extends ConnectionConfig {
  connected: boolean;
}

export interface TableRef {
  schema?: string;
  name: string;
  type: 'table' | 'view';
}

export interface SchemaInfo {
  name: string;
  tables: TableRef[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  autoIncrement: boolean;
  ordinal: number;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface TableStructure {
  table: TableRef;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  primaryKey: string[];
  rowIdAvailable: boolean;
  ddl?: string;
}

export type ScalarValue = string | number | boolean | null;

export interface BlobValue {
  $type: 'blob';
  base64: string;
  bytes: number;
}

export interface DateValue {
  $type: 'date';
  value: string;
}

export interface JsonValue {
  $type: 'json';
  value: string;
}

export type CellValue = ScalarValue | BlobValue | DateValue | JsonValue;
export type Row = Record<string, CellValue>;

export interface ResultColumn {
  name: string;
  dataType?: string;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Row[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  message?: string;
  /** True when the statement did not return a result set. */
  command: boolean;
}

export interface TablePage {
  schema?: string;
  table: string;
  columns: ColumnInfo[];
  rows: Row[];
  offset: number;
  limit: number;
  total: number | null;
  durationMs: number;
  primaryKey: string[];
  editable: boolean;
  editReason?: string;
}

export type FilterOperator =
  | '='
  | '!='
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'isNull'
  | 'isNotNull'
  | 'in';

export interface FilterCondition {
  column: string;
  operator: FilterOperator;
  value?: string;
  values?: string[];
}

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export type ExportFormat = 'csv' | 'json' | 'jsonl' | 'sql';

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  connectionName: string;
  connectionId: string;
  durationMs: number;
  rowCount: number;
  success: boolean;
  error?: string;
  createdAt: number;
}

export interface ObjectRef {
  schema?: string;
  name: string;
  kind?: 'table' | 'view';
}

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  connectionId?: string;
}

/** Messages sent from the extension host to a webview. */
export type HostMessage =
  | {
      type: 'init';
      mode: 'database' | 'sql';
      documentUri?: string;
      fileName?: string;
      connection?: ConnectionSummary;
      connections: ConnectionSummary[];
      pageSize: number;
      maxResultRows: number;
      confirmDestructive: boolean;
      sqlText?: string;
      dirty?: boolean;
      initialTable?: TableRef;
      activeConnectionId?: string;
      history: QueryHistoryEntry[];
      /** Set when the editor opened a database that could not be connected. */
      fatalError?: string;
    }
  | { type: 'connections'; connections: ConnectionSummary[]; activeConnectionId: string | undefined }
  | { type: 'catalog'; schemas: SchemaInfo[]; connectionName: string }
  | { type: 'tablePage'; requestId: string; page: TablePage }
  | { type: 'structure'; requestId: string; structure: TableStructure }
  | { type: 'queryResult'; requestId: string; result: QueryResult }
  | { type: 'queryError'; requestId: string; message: string }
  | { type: 'requestError'; requestId: string; message: string }
  | {
      type: 'operationDone';
      operation: 'update' | 'insert' | 'delete' | 'drop' | 'truncate';
      success: boolean;
      message: string;
    }
  | { type: 'busy'; requestId?: string; busy: boolean; label?: string }
  | { type: 'toast'; kind: 'info' | 'success' | 'warning' | 'error'; message: string }
  | { type: 'documentChanged'; text: string; dirty: boolean }
  | { type: 'saved'; uri: string }
  | { type: 'history'; entries: QueryHistoryEntry[] };

/** Messages sent from a webview to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'openTable'; table: TableRef; requestId: string }
  | {
      type: 'loadTablePage';
      requestId: string;
      table: TableRef;
      offset: number;
      limit: number;
      sort?: SortSpec;
      filters?: FilterCondition[];
    }
  | { type: 'loadStructure'; requestId: string; table: TableRef }
  | { type: 'runQuery'; requestId: string; sql: string; connectionId?: string; maxRows?: number }
  | { type: 'cancelQuery'; requestId: string }
  | {
      type: 'updateCell';
      table: TableRef;
      primaryKey: Record<string, CellValue>;
      column: string;
      value: CellValue;
    }
  | { type: 'insertRow'; table: TableRef; values: Record<string, CellValue> }
  | { type: 'deleteRows'; table: TableRef; primaryKeys: Record<string, CellValue>[] }
  | { type: 'refreshCatalog' }
  | { type: 'selectConnection'; connectionId?: string }
  | { type: 'addConnection' }
  | { type: 'editConnection'; connectionId: string }
  | { type: 'openSqliteFile' }
  | { type: 'openQueryFile'; sql?: string }
  | { type: 'exportTable'; table: TableRef; format: ExportFormat }
  | { type: 'exportQuery'; sql: string; format: ExportFormat }
  | { type: 'updateText'; text: string }
  | { type: 'saveDocument' }
  | { type: 'revertDocument' }
  | { type: 'clearHistory' }
  | { type: 'openDocs' }
  | { type: 'dropTable'; table: TableRef }
  | { type: 'truncateTable'; table: TableRef }
  | { type: 'openTableInEditor'; table: TableRef }
  | { type: 'copyText'; text: string };
