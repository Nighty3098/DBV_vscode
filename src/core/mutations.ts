import type { CellValue, Row, TableRef } from '../shared/types';
import type { DatabaseType } from '../shared/types';
import { quoteIdentifier, quoteQualified } from './identifiers';

export interface Mutation {
  sql: string;
  params: unknown[];
}

function assertKnownColumn(column: string, allowed: string[]): void {
  if (!allowed.includes(column)) throw new Error(`Unknown column: ${column}`);
}

function quotedRowKey(name: string, type: DatabaseType): string {
  // SQLite fallback key for tables without an explicit primary key.
  return name === '__dbv_rowid' ? 'rowid' : quoteIdentifier(name, type);
}

export function buildUpdate(
  table: TableRef,
  type: DatabaseType,
  columns: string[],
  primaryKey: Record<string, CellValue>,
  values: Record<string, CellValue>,
): Mutation {
  const pkNames = Object.keys(primaryKey);
  const changes = Object.keys(values);
  if (!pkNames.length) throw new Error('Cannot update a row without a primary key');
  if (!changes.length) throw new Error('No values to update');
  const allowed = [...columns, '__dbv_rowid'];
  pkNames.forEach((name) => assertKnownColumn(name, allowed));
  changes.forEach((name) => assertKnownColumn(name, columns));

  const set = changes.map((name) => `${quoteIdentifier(name, type)} = ?`).join(', ');
  const where = pkNames.map((name) => `${quotedRowKey(name, type)} = ?`).join(' AND ');
  return {
    sql: `UPDATE ${quoteQualified(table.schema, table.name, type)} SET ${set} WHERE ${where}`,
    params: [...changes.map((name) => toDbValue(values[name])), ...pkNames.map((name) => toDbValue(primaryKey[name]))],
  };
}

export function buildInsert(
  table: TableRef,
  type: DatabaseType,
  columns: string[],
  values: Record<string, CellValue>,
): Mutation {
  const names = Object.keys(values);
  if (!names.length) throw new Error('No values to insert');
  names.forEach((name) => assertKnownColumn(name, columns));
  const placeholders = names.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO ${quoteQualified(table.schema, table.name, type)} (${names.map((name) => quoteIdentifier(name, type)).join(', ')}) VALUES (${placeholders})`,
    params: names.map((name) => toDbValue(values[name])),
  };
}

export function buildDelete(
  table: TableRef,
  type: DatabaseType,
  columns: string[],
  primaryKey: Record<string, CellValue>,
): Mutation {
  const names = Object.keys(primaryKey);
  if (!names.length) throw new Error('Cannot delete a row without a primary key');
  const allowed = [...columns, '__dbv_rowid'];
  names.forEach((name) => assertKnownColumn(name, allowed));
  return {
    sql: `DELETE FROM ${quoteQualified(table.schema, table.name, type)} WHERE ${names.map((name) => `${quotedRowKey(name, type)} = ?`).join(' AND ')}`,
    params: names.map((name) => toDbValue(primaryKey[name])),
  };
}

export function toDbValue(value: CellValue | undefined): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    if (value.$type === 'blob') return Buffer.from(value.base64, 'base64');
    if (value.$type === 'date') return value.value;
    if (value.$type === 'json') return value.value;
  }
  return value;
}

export function primaryKeyOf(row: Row, primaryKey: string[]): Record<string, CellValue> {
  const result: Record<string, CellValue> = {};
  for (const name of primaryKey) {
    result[name] = row[name] ?? null;
  }
  return result;
}

/** Coerces a text input into a useful database value without losing user intent. */
export function parseInputValue(raw: string, nullToken = 'NULL'): CellValue {
  if (raw === nullToken) return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
    const number = Number(raw);
    if (Number.isFinite(number) && Number.isSafeInteger(number)) return number;
  }
  return raw;
}
