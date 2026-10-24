import type { CellValue, ColumnInfo, QueryResult, Row, Row as DbRow, ScalarValue } from '../shared/types';
import { quoteIdentifier, quoteQualified } from './identifiers';
import type { DatabaseType, TableRef } from '../shared/types';
import { toDbValue } from './mutations';

export const DEFAULT_BLOB_PREVIEW_BYTES = 64 * 1024;

export function truncateCellText(value: string, max = 10_000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Converts arbitrary driver values into structured-clone-safe webview data. */
export function serializeCell(value: unknown, maxBlobBytes = DEFAULT_BLOB_PREVIEW_BYTES): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : { $type: 'date', value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    const bytes = value.byteLength;
    const slice = value.subarray(0, Math.min(bytes, maxBlobBytes));
    return {
      $type: 'blob',
      base64: Buffer.from(slice).toString('base64'),
      bytes,
    };
  }
  if (typeof value === 'object') {
    try {
      return { $type: 'json', value: JSON.stringify(value) };
    } catch {
      return { $type: 'json', value: String(value) };
    }
  }
  return String(value);
}

export function serializeRow(row: DbRow): Row {
  const output: Row = {};
  for (const [key, value] of Object.entries(row)) output[key] = serializeCell(value);
  return output;
}

export function serializeRows(rows: DbRow[]): Row[] {
  return rows.map(serializeRow);
}

export function cellToDisplay(value: CellValue, nullAs = 'NULL'): string {
  if (value === null) return nullAs;
  if (typeof value === 'object') {
    if (value.$type === 'blob') {
      return `BLOB (${value.bytes.toLocaleString()} bytes)`;
    }
    return value.value;
  }
  return String(value);
}

export function cellToPlain(value: CellValue): unknown {
  return toDbValue(value);
}

/** Converts a driver result to a display-safe QueryResult. */
export function serializeResult(input: {
  columns: string[];
  rows: DbRow[];
  rowCount?: number;
  durationMs: number;
  truncated?: boolean;
  message?: string;
}): QueryResult {
  return {
    columns: input.columns.map((name) => ({ name })),
    rows: serializeRows(input.rows),
    rowCount: input.rowCount ?? input.rows.length,
    truncated: input.truncated ?? false,
    durationMs: input.durationMs,
    command: input.columns.length === 0,
    message: input.message,
  };
}

export function formatValueForExport(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'object') {
    if (value.$type === 'blob') return `0x${Buffer.from(value.base64, 'base64').toString('hex')}`;
    return value.value;
  }
  return String(value);
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(result: QueryResult): string {
  const header = result.columns.map((column) => csvEscape(column.name)).join(',');
  const rows = result.rows.map((row) =>
    result.columns.map((column) => csvEscape(formatValueForExport(row[column.name] ?? null))).join(','),
  );
  return [header, ...rows].join('\r\n');
}

export function toJson(result: QueryResult): string {
  const rows = result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column) => [column.name, cellToPlain(row[column.name] ?? null)])),
  );
  return JSON.stringify(rows, null, 2);
}

export function toJsonLines(result: QueryResult): string {
  return result.rows
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(result.columns.map((column) => [column.name, cellToPlain(row[column.name] ?? null)])),
      ),
    )
    .join('\n');
}

function sqlLiteral(value: unknown, type: DatabaseType): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return type === 'postgres' && typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  }
  if (Buffer.isBuffer(value)) {
    const hex = value.toString('hex');
    return type === 'postgres' ? `'\\x${hex}'::bytea` : `X'${hex}'`;
  }
  const text = String(value).replace(/'/g, "''");
  return type === 'mssql' ? `N'${text}'` : `'${text}'`;
}

export function toInsertStatements(
  result: QueryResult,
  table: TableRef,
  type: DatabaseType,
  batchSize = 50,
): string {
  if (!result.rows.length) return '';
  const tableName = quoteQualified(table.schema, table.name, type);
  const names = result.columns.map((column) => column.name);
  const columnList = names.map((name) => quoteIdentifier(name, type)).join(', ');
  const chunks: string[] = [];
  for (let i = 0; i < result.rows.length; i += batchSize) {
    const batch = result.rows.slice(i, i + batchSize);
    const values = batch.map((row) =>
      `(${names.map((name) => sqlLiteral(toDbValue(row[name] ?? null), type)).join(', ')})`,
    );
    chunks.push(`INSERT INTO ${tableName} (${columnList}) VALUES\n${values.join(',\n')};`);
  }
  return chunks.join('\n\n');
}

export interface ExportData {
  content: string;
  defaultFileName: string;
  language: string;
}

export function exportResult(
  result: QueryResult,
  table: TableRef,
  format: 'csv' | 'json' | 'jsonl' | 'sql',
  type: DatabaseType,
): ExportData {
  const base = table.schema ? `${table.schema}.${table.name}` : table.name;
  switch (format) {
    case 'csv':
      return { content: toCsv(result), defaultFileName: `${base}.csv`, language: 'csv' };
    case 'json':
      return { content: toJson(result), defaultFileName: `${base}.json`, language: 'json' };
    case 'jsonl':
      return { content: toJsonLines(result), defaultFileName: `${base}.jsonl`, language: 'jsonl' };
    case 'sql':
      return {
        content: toInsertStatements(result, table, type),
        defaultFileName: `${base}.insert.sql`,
        language: 'sql',
      };
  }
}

export function serializeColumnType(type: string): string {
  return type || 'unknown';
}

export function hasLargeBlob(value: CellValue): boolean {
  return value !== null && typeof value === 'object' && value.$type === 'blob' && value.bytes > DEFAULT_BLOB_PREVIEW_BYTES;
}

export function emptyRow(columns: ColumnInfo[]): Record<string, ScalarValue> {
  return Object.fromEntries(columns.map((column) => [column.name, null]));
}
