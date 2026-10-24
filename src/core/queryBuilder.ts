import type { FilterCondition, FilterOperator, SortSpec, TableRef } from '../shared/types';
import { quoteIdentifier, quoteQualified } from './identifiers';
import type { DatabaseType } from '../shared/types';

export const FILTER_OPERATORS: ReadonlyArray<{ id: FilterOperator; label: string; arity: 0 | 1 | 2 }> = [
  { id: '=', label: 'equals', arity: 1 },
  { id: '!=', label: 'not equals', arity: 1 },
  { id: 'contains', label: 'contains', arity: 1 },
  { id: 'startsWith', label: 'starts with', arity: 1 },
  { id: 'endsWith', label: 'ends with', arity: 1 },
  { id: '>', label: 'greater than', arity: 1 },
  { id: '>=', label: 'greater or equal', arity: 1 },
  { id: '<', label: 'less than', arity: 1 },
  { id: '<=', label: 'less or equal', arity: 1 },
  { id: 'isNull', label: 'is null', arity: 0 },
  { id: 'isNotNull', label: 'is not null', arity: 0 },
  { id: 'in', label: 'in list', arity: 1 },
];

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Builds a parameterized WHERE clause. Column names are checked against the
 * allow-list of real columns, and all values are bound as parameters.
 */
export function buildWhere(
  filters: FilterCondition[] | undefined,
  columns: string[],
  type: DatabaseType,
): BuiltQuery {
  if (!filters?.length) return { sql: '', params: [] };
  const allowed = new Set(columns);
  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const filter of filters) {
    if (!allowed.has(filter.column)) {
      throw new Error(`Unknown filter column: ${filter.column}`);
    }
    const id = quoteIdentifier(filter.column, type);
    switch (filter.operator) {
      case 'isNull':
        clauses.push(`${id} IS NULL`);
        break;
      case 'isNotNull':
        clauses.push(`${id} IS NOT NULL`);
        break;
      case 'in': {
        const values = (filter.values ?? (filter.value ?? '').split(','))
          .map((item) => item.trim())
          .filter(Boolean);
        if (!values.length) throw new Error('IN filter requires at least one value');
        clauses.push(`${id} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
        break;
      }
      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        const value = filter.value ?? '';
        const escaped = escapeLike(value);
        const pattern = filter.operator === 'contains'
          ? `%${escaped}%`
          : filter.operator === 'startsWith'
            ? `${escaped}%`
            : `%${escaped}`;
        if (type === 'mssql') {
          clauses.push(`${id} LIKE ? ESCAPE '\\'`);
        } else {
          clauses.push(`${id} LIKE ? ESCAPE '\\'`);
        }
        params.push(pattern);
        break;
      }
      default:
        clauses.push(`${id} ${filter.operator} ?`);
        params.push(filter.value ?? null);
    }
  }

  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

export function buildOrderBy(
  sort: SortSpec | undefined,
  columns: string[],
  type: DatabaseType,
): string {
  if (!sort) return '';
  if (!columns.includes(sort.column)) throw new Error(`Unknown sort column: ${sort.column}`);
  return ` ORDER BY ${quoteIdentifier(sort.column, type)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`;
}

export function buildCountQuery(
  table: TableRef,
  columns: string[],
  type: DatabaseType,
  filters?: FilterCondition[],
): BuiltQuery {
  const where = buildWhere(filters, columns, type);
  return {
    sql: `SELECT COUNT(*) AS ${quoteIdentifier('dbv_count', type)} FROM ${quoteQualified(table.schema, table.name, type)}${where.sql}`,
    params: where.params,
  };
}

export function buildBrowseQuery(
  table: TableRef,
  columns: string[],
  type: DatabaseType,
  options: {
    offset: number;
    limit: number;
    sort?: SortSpec;
    filters?: FilterCondition[];
    rowId?: boolean;
  },
): BuiltQuery {
  const where = buildWhere(options.filters, columns, type);
  const order = buildOrderBy(options.sort, columns, type);
  const projection = options.rowId === true ? 'rowid AS "__dbv_rowid", *' : '*';
  const offset = Math.max(0, Math.trunc(options.offset));
  const limit = Math.max(1, Math.min(5000, Math.trunc(options.limit)));
  let sql = `SELECT ${projection} FROM ${quoteQualified(table.schema, table.name, type)}${where.sql}${order || (options.rowId ? ' ORDER BY rowid' : '')}`;
  if (type === 'mssql') {
    if (!order) sql += ' ORDER BY (SELECT NULL)';
    sql += ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
    return { sql, params: where.params };
  }
  sql += ` LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params: where.params };
}

/** Splits SQL text into statements without breaking quoted strings/comments. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  let dollarTag: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          i++;
        } else {
          quote = null;
        }
      } else if (char === '\\' && quote === "'" && (next === "'" || next === '\\')) {
        i++;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      lineComment = true;
      i++;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      i++;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        i += dollarTag.length - 1;
      }
    } else if (char === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Returns the statement containing the cursor, or the whole text when unavailable. */
export function statementAtCursor(sql: string, cursor: number): string {
  if (cursor <= 0) return sql;
  let start = 0;
  let current = sql;
  for (const statement of splitSqlStatements(sql)) {
    const index = sql.indexOf(statement, start);
    const end = index + statement.length;
    if (cursor <= end) return statement;
    current = statement;
    start = end;
  }
  return current;
}

/** Wraps a query when possible so the server does not return unbounded rows. */
export function limitSelect(sql: string, type: DatabaseType, maxRows: number): string {
  const clean = sql.trim().replace(/;+\s*$/, '');
  if (!/^SELECT\b|^WITH\b|^VALUES\b/i.test(clean)) return clean;
  if (/\bLIMIT\s+\d+/i.test(clean) || /\bOFFSET\s+\d+\s+ROWS\b/i.test(clean)) return clean;
  const limit = Math.max(1, Math.trunc(maxRows));
  if (type === 'mssql') {
    if (/^SELECT\s+DISTINCT\s+/i.test(clean)) {
      return clean.replace(/^SELECT\s+DISTINCT\s+/i, `SELECT DISTINCT TOP ${limit} `);
    }
    return clean.replace(/^SELECT\s+/i, `SELECT TOP ${limit} `);
  }
  return `${clean}\nLIMIT ${limit}`;
}

export function isReadOnlyStatement(sql: string): boolean {
  return splitSqlStatements(sql).every((statement) =>
    /^(SELECT|WITH|PRAGMA|EXPLAIN|VALUES|SHOW|DESCRIBE)\b/i.test(statement.trim()),
  );
}
