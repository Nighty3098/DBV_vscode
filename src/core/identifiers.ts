import type { DatabaseType } from '../shared/types';

export interface SqlDialect {
  type: DatabaseType;
  label: string;
  quoteStart: string;
  quoteEnd: string;
  supportsSchemas: boolean;
  supportsRowId: boolean;
  defaultPort?: number;
}

export const DIALECTS: Record<DatabaseType, SqlDialect> = {
  sqlite: {
    type: 'sqlite',
    label: 'SQLite',
    quoteStart: '"',
    quoteEnd: '"',
    supportsSchemas: false,
    supportsRowId: true,
  },
  postgres: {
    type: 'postgres',
    label: 'PostgreSQL',
    quoteStart: '"',
    quoteEnd: '"',
    supportsSchemas: true,
    supportsRowId: false,
    defaultPort: 5432,
  },
  mysql: {
    type: 'mysql',
    label: 'MySQL',
    quoteStart: '`',
    quoteEnd: '`',
    supportsSchemas: true,
    supportsRowId: false,
    defaultPort: 3306,
  },
  mariadb: {
    type: 'mariadb',
    label: 'MariaDB',
    quoteStart: '`',
    quoteEnd: '`',
    supportsSchemas: true,
    supportsRowId: false,
    defaultPort: 3306,
  },
  mssql: {
    type: 'mssql',
    label: 'SQL Server',
    quoteStart: '[',
    quoteEnd: ']',
    supportsSchemas: true,
    supportsRowId: false,
    defaultPort: 1433,
  },
};

/** Quotes a single identifier, escaping the dialect's closing quote. */
export function quoteIdentifier(name: string, type: DatabaseType): string {
  const dialect = DIALECTS[type];
  if (!name || name.includes('\0')) {
    throw new Error('Invalid SQL identifier');
  }
  const escaped = name.split(dialect.quoteEnd).join(dialect.quoteEnd + dialect.quoteEnd);
  return `${dialect.quoteStart}${escaped}${dialect.quoteEnd}`;
}

/** Quotes an optionally schema-qualified identifier. */
export function quoteQualified(schema: string | undefined, name: string, type: DatabaseType): string {
  return schema ? `${quoteIdentifier(schema, type)}.${quoteIdentifier(name, type)}` : quoteIdentifier(name, type);
}

export function defaultPort(type: DatabaseType): number | undefined {
  return DIALECTS[type].defaultPort;
}

export function normalizePort(type: DatabaseType, port: number | undefined): number | undefined {
  if (port === undefined || Number.isNaN(port)) return defaultPort(type);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return port;
}
