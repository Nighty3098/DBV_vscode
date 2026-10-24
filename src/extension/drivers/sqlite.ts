import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  Row,
  SchemaInfo,
  TableRef,
  TableStructure,
} from '../../shared/types';
import type { DatabaseType, ConnectionConfig } from '../../shared/types';
import { BaseDriver, type QueryOptions } from './base';
import { limitSelect, splitSqlStatements } from '../../core/queryBuilder';
import type { Mutation } from '../../core/mutations';
import { serializeResult } from '../../core/serialization';
import { quoteIdentifier, quoteQualified } from '../../core/identifiers';

interface SQLiteColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number | bigint;
}

interface SQLiteIndexRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface SQLiteForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

export class SqliteDriver extends BaseDriver {
  readonly type: DatabaseType = 'sqlite';
  private db: DatabaseSync | undefined;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  async connect(): Promise<void> {
    if (this.db) return;
    const file = this.config.file;
    if (!file) throw new Error('SQLite database path is missing');
    if (!existsSync(file)) throw new Error(`SQLite file does not exist: ${file}`);
    try {
      this.db = new DatabaseSync(file, {
        readOnly: this.config.readonly ?? false,
        timeout: 5000,
        enableForeignKeyConstraints: true,
        readBigInts: true,
      });
      if (this.config.readonly) this.db.exec('PRAGMA query_only = ON');
      this.connected = true;
    } catch (error) {
      throw new Error(`Could not open SQLite database: ${errorMessage(error)}`);
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
    this.connected = false;
  }

  override isConnected(): boolean {
    return Boolean(this.db) && this.connected;
  }

  private database(): DatabaseSync {
    if (!this.db) throw new Error('SQLite connection is not open');
    return this.db;
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const rows = this.database()
      .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string; type: 'table' | 'view' }>;
    return [
      {
        name: 'main',
        tables: rows.map((row) => ({ name: row.name, type: row.type })),
      },
    ];
  }

  async getStructure(table: TableRef): Promise<TableStructure> {
    const db = this.database();
    const escaped = quoteIdentifier(table.name, 'sqlite');
    const info = db.prepare(`PRAGMA table_info(${escaped})`).all() as unknown as SQLiteColumnRow[];
    const master = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`)
      .get(table.name) as { sql?: string } | undefined;
    const tableSql = master?.sql ?? '';
    const autoIncrement = /AUTOINCREMENT/i.test(tableSql);
    const pkColumns = info
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => row.name);
    const isView = table.type === 'view';
    const indexList = !isView
      ? db.prepare(`PRAGMA index_list(${escaped})`).all() as unknown as SQLiteIndexRow[]
      : [];
    let rowIdAvailable = false;
    if (!isView) {
      try {
        db.prepare(`SELECT rowid FROM ${quoteQualified(table.schema, table.name, 'sqlite')} LIMIT 1`).all();
        rowIdAvailable = true;
      } catch {
        rowIdAvailable = false;
      }
    }
    const integerPrimaryKeyIsRowId = rowIdAvailable &&
      pkColumns.length === 1 &&
      info.some((row) => Number(row.pk) === 1 && row.type.trim().toUpperCase() === 'INTEGER') &&
      !indexList.some((index) => index.origin === 'pk');

    const columns: ColumnInfo[] = info.map((row, index) => ({
      name: row.name,
      dataType: row.type || 'ANY',
      nullable: row.notnull === 0 && !(integerPrimaryKeyIsRowId && Number(row.pk) > 0),
      defaultValue: row.dflt_value,
      primaryKey: Number(row.pk) > 0,
      autoIncrement: autoIncrement && Number(row.pk) > 0 && row.type.toUpperCase().includes('INT'),
      ordinal: index + 1,
    }));

    const indexes: IndexInfo[] = [];
    if (!isView) {
      for (const index of indexList) {
        const indexInfo = db
          .prepare(`PRAGMA index_info(${quoteIdentifier(index.name, 'sqlite')})`)
          .all() as unknown as Array<{ name: string | null }>;
        indexes.push({
          name: index.name,
          columns: indexInfo.map((item) => item.name ?? '(expression)'),
          unique: index.unique === 1,
          primary: index.origin === 'pk',
        });
      }
    }

    const foreignKeys: ForeignKeyInfo[] = [];
    if (!isView) {
      const fkRows = db.prepare(`PRAGMA foreign_key_list(${escaped})`).all() as unknown as SQLiteForeignKeyRow[];
      const grouped = new Map<number, SQLiteForeignKeyRow[]>();
      for (const row of fkRows) {
        const group = grouped.get(row.id) ?? [];
        group.push(row);
        grouped.set(row.id, group);
      }
      for (const [id, rows] of grouped) {
        rows.sort((a, b) => a.seq - b.seq);
        foreignKeys.push({
          name: `fk_${table.name}_${id}`,
          columns: rows.map((row) => row.from),
          referencedTable: rows[0]?.table ?? '',
          referencedColumns: rows.map((row) => row.to ?? ''),
          onDelete: rows[0]?.on_delete,
          onUpdate: rows[0]?.on_update,
        });
      }
    }

    return {
      table,
      columns,
      indexes,
      foreignKeys,
      primaryKey: pkColumns.length ? pkColumns : rowIdAvailable ? ['__dbv_rowid'] : [],
      rowIdAvailable,
      ddl: tableSql || undefined,
    };
  }

  async executeQuery(sql: string, params: unknown[] = [], options: QueryOptions = {}): Promise<QueryResult> {
    const started = performance.now();
    const statements = splitSqlStatements(sql);
    if (!statements.length) throw new Error('SQL statement is empty');
    let finalResult: QueryResult | undefined;
    let affected = 0;

    for (const statement of statements) {
      const bounded = params.length === 0 && options.maxRows
        ? limitSelect(statement, 'sqlite', Math.max(1, options.maxRows) + 1)
        : statement;
      const prepared = this.database().prepare(bounded);
      prepared.setReadBigInts(true);
      if (prepared.columns().length > 0) {
        const rawRows = prepared.all(...(params as never[])) as unknown as Row[];
        const columns = prepared.columns().map((column) => column.name);
        const maxRows = Math.max(1, options.maxRows ?? 1000);
        const rows = rawRows.length > maxRows ? rawRows.slice(0, maxRows) : rawRows;
        finalResult = serializeResult({
          columns,
          rows,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
          truncated: rawRows.length > maxRows,
        });
        affected = rows.length;
      } else {
        const result = prepared.run(...(params as never[]));
        affected = Number(result.changes);
        finalResult = serializeResult({
          columns: [],
          rows: [],
          rowCount: affected,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
          message: `Query OK · ${affected} row${affected === 1 ? '' : 's'} affected`,
        });
      }
    }
    return finalResult!;
  }

  protected async executeMutation(mutation: Mutation): Promise<number> {
    const statement: StatementSync = this.database().prepare(mutation.sql);
    const result = statement.run(...(mutation.params as never[]));
    return Number(result.changes);
  }

  override async dropTable(table: TableRef): Promise<void> {
    this.assertWritable();
    if (table.type === 'view') {
      this.database().exec(`DROP VIEW ${quoteIdentifier(table.name, 'sqlite')}`);
    } else {
      this.database().exec(`DROP TABLE ${quoteIdentifier(table.name, 'sqlite')}`);
    }
  }

  override async truncateTable(table: TableRef): Promise<void> {
    this.assertWritable();
    this.database().exec(`DELETE FROM ${quoteIdentifier(table.name, 'sqlite')}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
