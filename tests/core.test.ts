import { describe, expect, it } from 'vitest';
import { defaultPort, normalizePort, quoteIdentifier, quoteQualified } from '../src/core/identifiers';
import {
  buildBrowseQuery,
  buildCountQuery,
  buildOrderBy,
  buildWhere,
  isReadOnlyStatement,
  limitSelect,
  splitSqlStatements,
  statementAtCursor,
} from '../src/core/queryBuilder';
import {
  buildDelete,
  buildInsert,
  buildUpdate,
  parseInputValue,
  primaryKeyOf,
  toDbValue,
} from '../src/core/mutations';
import {
  cellToDisplay,
  emptyRow,
  exportResult,
  formatValueForExport,
  hasLargeBlob,
  serializeCell,
  serializeColumnType,
  serializeResult,
  serializeRow,
  serializeRows,
  toCsv,
  toInsertStatements,
  toJson,
  toJsonLines,
  truncateCellText,
} from '../src/core/serialization';
import { convertPlaceholders } from '../src/core/placeholders';
import { normalizeStructureLists } from '../src/core/structure';
import {
  connectionEndpoint,
  createConnectionId,
  passwordKey,
  redactConnection,
  validateConnection,
  ValidationError,
} from '../src/core/validation';
import { filterHistory, formatHistoryTitle, MAX_HISTORY, pushHistory } from '../src/core/history';
import type { QueryHistoryEntry, QueryResult } from '../src/shared/types';

const table = { name: 'users', type: 'table' as const, schema: 'public' };

describe('table structure metadata', () => {
  it('normalizes malformed column lists and reports the affected fields', () => {
    const result = normalizeStructureLists({
      table,
      columns: [],
      indexes: [
        { name: 'idx_users_name', columns: { 0: 'name' }, unique: false, primary: false },
      ],
      foreignKeys: [
        {
          name: 'fk_users_team',
          columns: 'team_id',
          referencedTable: 'teams',
          referencedColumns: ['id'],
        },
      ],
      primaryKey: ['id'],
      rowIdAvailable: false,
    }, table);

    expect(result.structure.indexes[0]?.columns).toEqual(['name']);
    expect(result.structure.foreignKeys[0]?.columns).toEqual(['team_id']);
    expect(result.malformedFields).toEqual([
      'index "idx_users_name".columns',
      'foreign key "fk_users_team".columns',
    ]);
  });

  it('returns safe empty metadata when structure collections are malformed', () => {
    const result = normalizeStructureLists({
      table,
      columns: {},
      indexes: null,
      foreignKeys: 'unexpected',
      primaryKey: false,
      rowIdAvailable: 'yes',
    }, table);

    expect(result.structure).toMatchObject({
      table,
      columns: [],
      indexes: [],
      foreignKeys: [],
      primaryKey: [],
      rowIdAvailable: false,
    });
    expect(result.malformedFields).toEqual([
      'rowIdAvailable',
      'columns',
      'indexes',
      'foreignKeys',
      'primaryKey',
    ]);
  });
});

describe('identifiers', () => {
  it('quotes identifiers for every dialect', () => {
    expect(quoteIdentifier('a"b', 'sqlite')).toBe('"a""b"');
    expect(quoteIdentifier('a`b', 'mysql')).toBe('`a``b`');
    expect(quoteIdentifier('a]b', 'mssql')).toBe('[a]]b]');
    expect(quoteQualified('s', 't', 'postgres')).toBe('"s"."t"');
    expect(quoteQualified(undefined, 't', 'postgres')).toBe('"t"');
    expect(() => quoteIdentifier('', 'sqlite')).toThrow('Invalid SQL identifier');
    expect(() => quoteIdentifier('a\0b', 'sqlite')).toThrow('Invalid SQL identifier');
  });

  it('normalizes ports', () => {
    expect(defaultPort('postgres')).toBe(5432);
    expect(defaultPort('sqlite')).toBeUndefined();
    expect(normalizePort('mysql', undefined)).toBe(3306);
    expect(normalizePort('mssql', 1444)).toBe(1444);
    expect(() => normalizePort('mysql', 0)).toThrow('Port');
    expect(() => normalizePort('mysql', 1.5)).toThrow('Port');
  });
});

describe('query builder', () => {
  it('builds parameterized filters for all operators', () => {
    const filters = [
      { column: 'name', operator: '=' as const, value: "O'Brien" },
      { column: 'name', operator: 'contains' as const, value: '50%_' },
      { column: 'name', operator: 'startsWith' as const, value: 'A' },
      { column: 'name', operator: 'endsWith' as const, value: 'z' },
      { column: 'age', operator: '>' as const, value: '20' },
      { column: 'age', operator: '>=' as const, value: '20' },
      { column: 'age', operator: '<' as const, value: '20' },
      { column: 'age', operator: '<=' as const, value: '20' },
      { column: 'email', operator: 'isNull' as const },
      { column: 'email', operator: 'isNotNull' as const },
      { column: 'id', operator: 'in' as const, values: ['1', '2'] },
      { column: 'id', operator: '!=' as const, value: '3' },
    ];
    const where = buildWhere(filters, ['id', 'name', 'age', 'email'], 'postgres');
    expect(where.sql).toContain('"name" = ?');
    expect(where.sql).toContain('"name" LIKE ? ESCAPE');
    expect(where.sql).toContain('"id" IN (?, ?)');
    expect(where.params).toContain("O'Brien");
    expect(where.params).toContain('%50\\%\\_%');
    expect(where.sql).toContain('"email" IS NULL');
    expect(buildWhere(undefined, [], 'sqlite')).toEqual({ sql: '', params: [] });
    expect(buildWhere([{ column: 'name', operator: 'contains', value: 'x' }], ['name'], 'mssql').sql).toContain('LIKE');
    expect(() => buildWhere([{ column: 'x', operator: '=', value: '1' }], ['id'], 'sqlite')).toThrow('Unknown filter column');
    expect(() => buildWhere([{ column: 'id', operator: 'in', values: [] }], ['id'], 'sqlite')).toThrow('IN filter');
    expect(buildWhere([{ column: 'id', operator: 'in', value: '1, 2' }], ['id'], 'sqlite').params).toEqual(['1', '2']);
  });

  it('validates sort and builds paging for each dialect', () => {
    expect(buildOrderBy(undefined, [], 'sqlite')).toBe('');
    expect(buildOrderBy({ column: 'a', direction: 'desc' }, ['a'], 'mysql')).toBe(' ORDER BY `a` DESC');
    expect(() => buildOrderBy({ column: 'x', direction: 'asc' }, ['a'], 'sqlite')).toThrow('Unknown sort');
    const browse = buildBrowseQuery(table, ['id'], 'postgres', { offset: 10, limit: 50, sort: { column: 'id', direction: 'asc' } });
    expect(browse.sql).toContain('LIMIT 50 OFFSET 10');
    const rowId = buildBrowseQuery({ ...table, schema: undefined }, ['id'], 'sqlite', { offset: 0, limit: 10, rowId: true });
    expect(rowId.sql).toContain('rowid AS "__dbv_rowid"');
    expect(rowId.sql).toContain('ORDER BY rowid');
    const mssql = buildBrowseQuery(table, ['id'], 'mssql', { offset: 5, limit: 10 });
    expect(mssql.sql).toContain('ORDER BY (SELECT NULL)');
    expect(mssql.sql).toContain('OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY');
    const mssqlSorted = buildBrowseQuery(table, ['id'], 'mssql', { offset: 0, limit: 10, sort: { column: 'id', direction: 'asc' } });
    expect(mssqlSorted.sql).not.toContain('(SELECT NULL)');
    expect(buildCountQuery(table, ['id'], 'sqlite', [{ column: 'id', operator: '=', value: 1 }]).params).toEqual([1]);
  });

  it('splits complex SQL safely', () => {
    const sql = "SELECT ';' AS x; -- comment ;\nSELECT 2; /* ; */ SELECT $$;$$; SELECT \"a;\"";
    expect(splitSqlStatements(sql)).toHaveLength(4);
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements("SELECT 'it''s; fine'; SELECT 1")).toHaveLength(2);
    expect(splitSqlStatements("SELECT 'esc\\'; still';")).toHaveLength(1);
    const withCursor = 'SELECT 1;\nSELECT 2;';
    expect(statementAtCursor(withCursor, 3)).toBe('SELECT 1');
    expect(statementAtCursor(withCursor, 15)).toBe('SELECT 2');
    expect(statementAtCursor(withCursor, 0)).toBe(withCursor);
    expect(statementAtCursor('SELECT 1', 2)).toBe('SELECT 1');
    expect(statementAtCursor(withCursor, 999)).toBe('SELECT 2');
  });

  it('limits and classifies statements', () => {
    expect(limitSelect('SELECT * FROM t', 'postgres', 10)).toContain('LIMIT 10');
    expect(limitSelect('SELECT * FROM t LIMIT 5', 'postgres', 10)).toBe('SELECT * FROM t LIMIT 5');
    expect(limitSelect('SELECT * FROM t', 'mssql', 10)).toContain('TOP 10');
    expect(limitSelect('SELECT DISTINCT name FROM t', 'mssql', 10))
      .toBe('SELECT DISTINCT TOP 10 name FROM t');
    expect(limitSelect('select distinct name from t', 'mssql', 5))
      .toBe('SELECT DISTINCT TOP 5 name from t');
    expect(limitSelect('UPDATE t SET x=1', 'sqlite', 10)).toBe('UPDATE t SET x=1');
    expect(limitSelect('SELECT 1;', 'sqlite', 3)).toBe('SELECT 1\nLIMIT 3');
    expect(limitSelect('WITH x AS (SELECT 1) SELECT * FROM x', 'sqlite', 1)).toContain('LIMIT 1');
    expect(isReadOnlyStatement('select 1; PRAGMA user_version')).toBe(true);
    expect(isReadOnlyStatement('DELETE FROM t')).toBe(false);
  });
});

describe('mutations', () => {
  it('builds update, insert and delete statements', () => {
    expect(buildUpdate(table, 'postgres', ['id', 'name'], { id: 1 }, { name: 'new' })).toEqual({
      sql: 'UPDATE "public"."users" SET "name" = ? WHERE "id" = ?',
      params: ['new', 1],
    });
    expect(buildUpdate({ ...table, schema: undefined }, 'sqlite', ['id'], { __dbv_rowid: 4 }, { id: 2 }).sql)
      .toContain('WHERE rowid = ?');
    expect(buildInsert(table, 'mysql', ['id', 'name'], { id: 1, name: "O'Reilly" })).toEqual({
      sql: 'INSERT INTO `public`.`users` (`id`, `name`) VALUES (?, ?)',
      params: [1, "O'Reilly"],
    });
    expect(buildDelete(table, 'mssql', ['id'], { id: 1 }).sql).toContain('[public].[users]');
    expect(() => buildUpdate(table, 'sqlite', ['id'], {}, { id: 2 })).toThrow('without a primary key');
    expect(() => buildUpdate(table, 'sqlite', ['id'], { id: 1 }, {})).toThrow('No values');
    expect(() => buildUpdate(table, 'sqlite', ['id'], { nope: 1 }, { id: 2 })).toThrow('Unknown column');
    expect(() => buildInsert(table, 'sqlite', ['id'], {})).toThrow('No values');
    expect(() => buildInsert(table, 'sqlite', ['id'], { nope: 1 })).toThrow('Unknown column');
    expect(() => buildDelete(table, 'sqlite', ['id'], {})).toThrow('without a primary key');
    expect(() => buildDelete(table, 'sqlite', ['id'], { nope: 1 })).toThrow('Unknown column');
  });

  it('converts cell values and parses user input', () => {
    expect(toDbValue(undefined)).toBeNull();
    expect(toDbValue(null)).toBeNull();
    expect(toDbValue({ $type: 'blob', base64: 'aGk=', bytes: 2 })).toEqual(Buffer.from('hi'));
    expect(toDbValue({ $type: 'date', value: '2020-01-01' })).toBe('2020-01-01');
    expect(toDbValue({ $type: 'json', value: '{}' })).toBe('{}');
    expect(toDbValue(3)).toBe(3);
    expect(primaryKeyOf({ id: 2, v: 'x' }, ['id', 'missing'])).toEqual({ id: 2, missing: null });
    expect(parseInputValue('NULL')).toBeNull();
    expect(parseInputValue('true')).toBe(true);
    expect(parseInputValue('false')).toBe(false);
    expect(parseInputValue('42')).toBe(42);
    expect(parseInputValue('42.5')).toBe('42.5');
    expect(parseInputValue('')).toBe('');
  });
});

describe('serialization', () => {
  const blob = new Uint8Array([104, 105]);
  it('serializes all driver values', () => {
    expect(serializeCell(undefined)).toBeNull();
    expect(serializeCell(1n)).toBe('1');
    expect(serializeCell('x')).toBe('x');
    expect(serializeCell(2)).toBe(2);
    expect(serializeCell(true)).toBe(true);
    expect(serializeCell(new Date('2020-01-01T00:00:00Z'))).toEqual({ $type: 'date', value: '2020-01-01T00:00:00.000Z' });
    expect(serializeCell(new Date('invalid'))).toBe('Invalid Date');
    expect(serializeCell(blob)).toEqual({ $type: 'blob', base64: 'aGk=', bytes: 2 });
    expect(serializeCell({ a: 1 })).toEqual({ $type: 'json', value: '{"a":1}' });
    expect(serializeCell({ toJSON: () => { throw new Error('no'); } })).toEqual({ $type: 'json', value: '[object Object]' });
    expect(serializeCell(Symbol('x'))).toBe('Symbol(x)');
    expect(hasLargeBlob({ $type: 'blob', base64: '', bytes: 100_000 })).toBe(true);
    expect(hasLargeBlob(null)).toBe(false);
    expect(truncateCellText('abc', 2)).toBe('ab…');
    expect(truncateCellText('a', 2)).toBe('a');
    expect(serializeColumnType('')).toBe('unknown');
    expect(emptyRow([{ name: 'a' } as never])).toEqual({ a: null });
    const row = serializeRow({ a: 1, b: null, c: 2n });
    expect(row).toEqual({ a: 1, b: null, c: '2' });
    expect(serializeRows([{ x: 1 }])).toEqual([{ x: 1 }]);
  });

  it('renders display values', () => {
    expect(cellToDisplay(null)).toBe('NULL');
    expect(cellToDisplay(null, '∅')).toBe('∅');
    expect(cellToDisplay({ $type: 'blob', base64: '', bytes: 1234 })).toContain('1,234');
    expect(cellToDisplay({ $type: 'json', value: '{"x":1}' })).toBe('{"x":1}');
    expect(cellToDisplay('text')).toBe('text');
    expect(formatValueForExport({ $type: 'blob', base64: 'aGk=', bytes: 2 })).toBe('0x6869');
    expect(formatValueForExport({ $type: 'date', value: 'now' })).toBe('now');
    expect(formatValueForExport(null)).toBe('');
  });

  it('exports CSV, JSON, JSONL and SQL', () => {
    const result = serializeResult({
      columns: ['a', 'b'],
      rows: [
        { a: 1, b: 'x,y' },
        { a: 2, b: 'say "hi"\nline' },
        { a: null, b: new Uint8Array([1]) },
      ],
      durationMs: 2,
    });
    expect(result.rowCount).toBe(3);
    expect(result.command).toBe(false);
    expect(toCsv(result)).toContain('"x,y"');
    expect(toCsv(result)).toContain('"say ""hi""');
    expect(toJson(result)).toContain('"a": 1');
    expect(JSON.parse(toJson(result))).toHaveLength(3);
    expect(toJsonLines(result).split('\n')).toHaveLength(3);
    expect(toInsertStatements(result, table, 'sqlite')).toContain("X'01'");
    expect(toInsertStatements(result, table, 'postgres', 1)).toContain("'\\x01'::bytea");
    expect(toInsertStatements(result, table, 'mssql', 1)).toContain("N'x,y'");
    const boolResult = serializeResult({ columns: ['a'], rows: [{ a: true }], durationMs: 0 });
    expect(toInsertStatements(boolResult, table, 'postgres')).toContain('TRUE');
    expect(toInsertStatements(serializeResult({ columns: ['a'], rows: [], durationMs: 0 }), table, 'sqlite')).toBe('');
    expect(exportResult(result, table, 'csv', 'sqlite')).toMatchObject({ defaultFileName: 'public.users.csv', language: 'csv' });
    expect(exportResult(result, table, 'json', 'sqlite').defaultFileName).toBe('public.users.json');
    expect(exportResult(result, table, 'jsonl', 'sqlite').defaultFileName).toBe('public.users.jsonl');
    expect(exportResult(result, table, 'sql', 'sqlite').defaultFileName).toBe('public.users.insert.sql');
    const command = serializeResult({ columns: [], rows: [], durationMs: 1, message: 'ok' });
    expect(command.command).toBe(true);
    expect(command.message).toBe('ok');
  });
});

describe('placeholders', () => {
  it('converts only real placeholders', () => {
    expect(convertPlaceholders("SELECT ?, '?' AS x, \"?\" -- ?\n, $$?$$, ? /* ? */", 'postgres')).toEqual({
      sql: "SELECT $1, '?' AS x, \"?\" -- ?\n, $$?$$, $2 /* ? */",
      count: 2,
    });
    expect(convertPlaceholders('SELECT ?', 'mssql').sql).toBe('SELECT @p1');
    expect(convertPlaceholders('SELECT $1', 'postgres')).toEqual({ sql: 'SELECT $1', count: 0 });
    expect(convertPlaceholders('SELECT `?`', 'postgres').sql).toBe('SELECT `?`');
    expect(convertPlaceholders("SELECT 'it''s ?'", 'postgres')).toEqual({ sql: "SELECT 'it''s ?'", count: 0 });
  });
});

describe('validation', () => {
  it('validates SQLite connections', () => {
    const config = validateConnection({ name: ' local ', type: 'sqlite', file: '/tmp/a.db' });
    expect(config).toMatchObject({ name: 'local', type: 'sqlite', file: '/tmp/a.db', readonly: false });
    expect(config.id).toMatch(/^dbv_/);
    expect(() => validateConnection({ name: '', type: 'sqlite', file: 'x' })).toThrow(ValidationError);
    expect(() => validateConnection({ name: 'x', type: 'oracle' as never, file: 'x' })).toThrow('Unsupported');
    expect(() => validateConnection({ name: 'x', type: 'sqlite' })).toThrow('file path');
  });

  it('validates server connections and endpoints', () => {
    const config = validateConnection({
      name: 'pg',
      type: 'postgres',
      host: ' localhost ',
      database: 'app',
      user: 'me',
    });
    expect(config).toMatchObject({ host: 'localhost', database: 'app', user: 'me', port: 5432, ssl: false });
    expect(connectionEndpoint(config)).toBe('localhost:5432/app');
    expect(connectionEndpoint({ type: 'sqlite', file: '/a.db' } as never)).toBe('/a.db');
    expect(connectionEndpoint({ type: 'sqlite' } as never)).toBe('local SQLite file');
    expect(() => validateConnection({ name: 'x', type: 'mysql', host: '', database: 'x' })).toThrow('Host');
    expect(() => validateConnection({ name: 'x', type: 'mysql', host: 'h', database: '' })).toThrow('Database');
    expect(() => validateConnection({ name: 'x', type: 'mysql', host: 'h', database: 'd', user: ' ' })).toThrow('User');
    expect(() => validateConnection({ name: 'x', type: 'mysql', host: 'h', database: 'd', port: 99999 })).toThrow('Port');
    const existing = validateConnection({ id: 'keep', name: 'x', type: 'sqlite', file: 'a', createdAt: 1, readonly: true });
    const updated = validateConnection({ ...existing, name: 'y' });
    expect(updated.id).toBe('keep');
    expect(updated.readonly).toBe(true);
    expect(updated.createdAt).toBe(1);
    expect(connectionEndpoint({ type: 'mysql', host: 'h', database: 'd' } as never)).toBe('h/d');
    expect(connectionEndpoint({ type: 'postgres', database: 'd' } as never)).toBe('localhost/d');
    expect(validateConnection({ name: 'x', type: 'postgres', host: 'h', database: 'd', schema: '  ', ssl: 'require' })).toMatchObject({ schema: undefined, ssl: 'require' });
    expect(redactConnection(config)).toEqual(config);
    expect(passwordKey('abc')).toBe('dbv.password.abc');
    expect(createConnectionId()).not.toBe(createConnectionId());
  });
});

describe('history', () => {
  const entry = (id: string, sql = 'SELECT 1', name = 'local'): QueryHistoryEntry => ({
    id,
    sql,
    connectionName: name,
    connectionId: 'c',
    durationMs: 1,
    rowCount: 1,
    success: true,
    createdAt: 1,
  });

  it('deduplicates, limits, filters and formats history', () => {
    const entries = pushHistory([entry('a')], entry('b'));
    expect(entries.map((item) => item.id)).toEqual(['b', 'a']);
    const replaced = pushHistory([entry('a', 'SELECT 1'), entry('b')], entry('a', 'SELECT 2'));
    expect(replaced).toHaveLength(2);
    expect(replaced[0]?.sql).toBe('SELECT 2');
    expect(pushHistory([], entry('a'), 0)).toEqual([]);
    expect(MAX_HISTORY).toBe(200);
    expect(filterHistory(replaced, 'select 2')).toHaveLength(1);
    expect(filterHistory(replaced, 'local')).toHaveLength(2);
    expect(filterHistory(replaced, ' ')).toHaveLength(2);
    expect(formatHistoryTitle(entry('x', '  SELECT\n  1  '))).toBe('SELECT 1');
    expect(formatHistoryTitle(entry('x', 'x'.repeat(100)))).toHaveLength(78);
  });
});

describe('shared query result types', () => {
  it('keeps date and json values serializable', () => {
    const result: QueryResult = serializeResult({
      columns: ['a'],
      rows: [{ a: new Date('2020-01-01T00:00:00Z') }],
      durationMs: 1,
    });
    expect(JSON.parse(JSON.stringify(result)).rows[0].a).toEqual({ $type: 'date', value: '2020-01-01T00:00:00.000Z' });
  });
});
