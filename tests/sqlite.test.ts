import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteDriver } from '../src/extension/drivers/sqlite';
import type { ConnectionConfig } from '../src/shared/types';

let dir = '';
let file = '';
let driver: SqliteDriver;
let readonlyDriver: SqliteDriver;
const config: ConnectionConfig = {
  id: 'test',
  name: 'test',
  type: 'sqlite',
  file: '',
  readonly: false,
  createdAt: 0,
  updatedAt: 0,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dbv-test-'));
  file = join(dir, 'test.sqlite');
  await writeFile(file, '');
  const setup = new SqliteDriver({ ...config, file });
  await setup.connect();
  await setup.executeQuery(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      score REAL,
      active INTEGER NOT NULL DEFAULT 1,
      avatar BLOB
    );
    CREATE TABLE notes (body TEXT, user_id INTEGER REFERENCES users(id));
    CREATE TABLE composite_keys (
      left_key TEXT,
      right_key TEXT,
      PRIMARY KEY (left_key, right_key)
    );
    CREATE INDEX idx_users_name ON users(name);
    CREATE VIEW active_users AS SELECT id, name FROM users WHERE active = 1;
    INSERT INTO users (name, email, score, avatar) VALUES
      ('Ada', 'ada@example.com', 9.5, X'6869'),
      ('Grace', 'grace@example.com', 8.25, NULL),
      ('Linus', NULL, 7, NULL);
    INSERT INTO notes (body, user_id) VALUES ('hello', 1);
  `);
  await setup.close();
  driver = new SqliteDriver({ ...config, file });
  await driver.connect();
  readonlyDriver = new SqliteDriver({ ...config, file, readonly: true });
  await readonlyDriver.connect();
});

afterAll(async () => {
  await driver.close();
  await readonlyDriver.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SQLite driver integration', () => {
  it('opens only existing files and reports connection state', async () => {
    const missing = new SqliteDriver({ ...config, file: join(dir, 'missing.db') });
    await expect(missing.connect()).rejects.toThrow('does not exist');
    expect(driver.isConnected()).toBe(true);
    await driver.connect();
  });

  it('lists schemas, tables and views', async () => {
    const schemas = await driver.listSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.tables).toEqual(expect.arrayContaining([
      { name: 'active_users', type: 'view' },
      { name: 'users', type: 'table' },
      { name: 'notes', type: 'table' },
    ]));
  });

  it('reads structure with columns, indexes, foreign keys and DDL', async () => {
    const structure = await driver.getStructure({ name: 'users', type: 'table' });
    expect(structure.columns.find((column) => column.name === 'id')).toMatchObject({
      primaryKey: true,
      autoIncrement: true,
      nullable: false,
    });
    expect(structure.primaryKey).toEqual(['id']);
    expect(structure.indexes.some((index) => index.name === 'idx_users_name' && index.columns.includes('name'))).toBe(true);
    expect(structure.ddl).toContain('CREATE TABLE users');
    const notes = await driver.getStructure({ name: 'notes', type: 'table' });
    expect(notes.foreignKeys[0]).toMatchObject({ referencedTable: 'users', columns: ['user_id'] });
    const view = await driver.getStructure({ name: 'active_users', type: 'view' });
    expect(view.indexes).toEqual([]);
    expect(view.rowIdAvailable).toBe(false);
    const composite = await driver.getStructure({ name: 'composite_keys', type: 'table' });
    expect(composite.columns.find((column) => column.name === 'left_key')).toMatchObject({
      primaryKey: true,
    });
    expect(composite.primaryKey).toEqual(['left_key', 'right_key']);
  });

  it('loads paginated rows with sorting and filters', async () => {
    const page = await driver.loadPage({
      table: { name: 'users', type: 'table' },
      offset: 0,
      limit: 2,
      includeCount: true,
      sort: { column: 'name', direction: 'desc' },
    });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.primaryKey).toEqual(['id']);
    expect(page.editable).toBe(true);
    expect(page.rows[0]?.name).toBe('Linus');
    const filtered = await driver.loadPage({
      table: { name: 'users', type: 'table' },
      offset: 0,
      limit: 10,
      includeCount: false,
      filters: [{ column: 'name', operator: 'contains', value: 'ad' }],
    });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.total).toBeNull();
  });

  it('supports rowid fallback for tables without a primary key', async () => {
    await driver.executeQuery('CREATE TABLE loose (value TEXT)');
    await driver.executeQuery("INSERT INTO loose (value) VALUES ('x')");
    const structure = await driver.getStructure({ name: 'loose', type: 'table' });
    expect(structure.primaryKey).toEqual(['__dbv_rowid']);
    const page = await driver.loadPage({ table: { name: 'loose', type: 'table' }, offset: 0, limit: 10, includeCount: true });
    expect(page.editable).toBe(true);
    expect(page.rows[0]?.__dbv_rowid).toBeTruthy();
    await driver.updateRow({ name: 'loose', type: 'table' }, { __dbv_rowid: page.rows[0]?.__dbv_rowid ?? null }, 'value', 'y');
    expect((await driver.loadPage({ table: { name: 'loose', type: 'table' }, offset: 0, limit: 10, includeCount: false })).rows[0]?.value).toBe('y');
  });

  it('edits, inserts and deletes rows', async () => {
    await driver.updateRow({ name: 'users', type: 'table' }, { id: 1 }, 'name', 'Ada Lovelace');
    let page = await driver.loadPage({ table: { name: 'users', type: 'table' }, offset: 0, limit: 10, includeCount: true, filters: [{ column: 'id', operator: '=', value: '1' }] });
    expect(page.rows[0]?.name).toBe('Ada Lovelace');
    await driver.insertRow({ name: 'users', type: 'table' }, { name: 'Margaret', score: 10 });
    page = await driver.loadPage({ table: { name: 'users', type: 'table' }, offset: 0, limit: 10, includeCount: true, filters: [{ column: 'name', operator: '=', value: 'Margaret' }] });
    expect(page.rows).toHaveLength(1);
    await driver.deleteRows({ name: 'users', type: 'table' }, [{ id: page.rows[0]?.id ?? null }]);
    page = await driver.loadPage({ table: { name: 'users', type: 'table' }, offset: 0, limit: 10, includeCount: true });
    expect(page.total).toBe(3);
    await expect(driver.insertRow({ name: 'users', type: 'table' }, { nope: 1 })).rejects.toThrow('Unknown column');
  });

  it('executes ad-hoc queries, caps rows, commands and multiple statements', async () => {
    const result = await driver.executeQuery('SELECT name, avatar FROM users ORDER BY id', [], { maxRows: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.columns.map((column) => column.name)).toEqual(['name', 'avatar']);
    const command = await driver.executeQuery("INSERT INTO notes(body) VALUES ('a'); INSERT INTO notes(body) VALUES ('b');");
    expect(command.command).toBe(true);
    expect(command.message).toContain('1 row');
    const query = await driver.executeQuery('WITH x AS (SELECT 1 AS n) SELECT n FROM x');
    expect(query.rows[0]?.n).toBe("1");
    await expect(driver.executeQuery('  ')).rejects.toThrow('empty');
    await expect(driver.executeQuery('SELECT * FROM missing_table')).rejects.toThrow('no such table');
    const expired = await driver.executeQuery('SELECT COUNT(*) AS dbv_count FROM users');
    expect(Number(expired.rows[0]?.dbv_count)).toBe(3);
  });

  it('supports views, drops, truncates and read-only protection', async () => {
    await driver.executeQuery("UPDATE users SET active = 0 WHERE name = 'Linus'");
    const view = await driver.loadPage({ table: { name: 'active_users', type: 'view' }, offset: 0, limit: 10, includeCount: true });
    expect(view.total).toBe(2);
    await driver.dropTable({ name: 'active_users', type: 'view' });
    await driver.truncateTable({ name: 'notes', type: 'table' });
    expect((await driver.loadPage({ table: { name: 'notes', type: 'table' }, offset: 0, limit: 10, includeCount: true })).total).toBe(0);
    await driver.executeQuery('CREATE TABLE disposable (id INTEGER)');
    await driver.dropTable({ name: 'disposable', type: 'table' });
    await expect(driver.loadPage({ table: { name: 'disposable', type: 'table' }, offset: 0, limit: 1, includeCount: false })).rejects.toThrow();
    const readOnlyPage = await readonlyDriver.loadPage({ table: { name: 'users', type: 'table' }, offset: 0, limit: 10, includeCount: true });
    expect(readOnlyPage.editable).toBe(false);
    await expect(readonlyDriver.updateRow({ name: 'users', type: 'table' }, { id: 1 }, 'name', 'x')).rejects.toThrow('read-only');
    await expect(readonlyDriver.dropTable({ name: 'users', type: 'table' })).rejects.toThrow('read-only');
  });

  it('close is idempotent', async () => {
    const extra = new SqliteDriver({ ...config, file });
    await extra.connect();
    await extra.close();
    await extra.close();
    expect(extra.isConnected()).toBe(false);
    await expect(extra.listSchemas()).rejects.toThrow('not open');
    const broken = new SqliteDriver({ ...config, file: dir });
    await expect(broken.connect()).rejects.toThrow('Could not open SQLite database');
  });
});
