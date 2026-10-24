import type { ConnectionConfig, DatabaseType } from '../shared/types';
import { defaultPort } from './identifiers';

const SUPPORTED_TYPES: DatabaseType[] = ['sqlite', 'postgres', 'mysql', 'mariadb', 'mssql'];

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateConnection(input: Partial<ConnectionConfig>): ConnectionConfig {
  if (!input.name?.trim()) throw new ValidationError('Connection name is required');
  if (!input.type || !SUPPORTED_TYPES.includes(input.type)) {
    throw new ValidationError('Unsupported database type');
  }
  if (input.type === 'sqlite') {
    if (!input.file?.trim()) throw new ValidationError('SQLite file path is required');
    return {
      id: input.id ?? createConnectionId(),
      name: input.name.trim(),
      type: input.type,
      file: input.file,
      readonly: input.readonly ?? false,
      createdAt: input.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
  }

  if (!input.host?.trim()) throw new ValidationError('Host is required');
  if (!input.database?.trim()) throw new ValidationError('Database name is required');
  if (input.user !== undefined && !input.user.trim()) throw new ValidationError('User cannot be blank');
  const port = input.port ?? defaultPort(input.type);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new ValidationError('Port must be between 1 and 65535');
  }
  return {
    id: input.id ?? createConnectionId(),
    name: input.name.trim(),
    type: input.type,
    host: input.host.trim(),
    port,
    user: input.user?.trim() || undefined,
    database: input.database.trim(),
    schema: input.schema?.trim() || undefined,
    ssl: input.ssl ?? false,
    readonly: input.readonly ?? false,
    createdAt: input.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

export function createConnectionId(): string {
  return `dbv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function connectionEndpoint(config: Pick<ConnectionConfig, 'type' | 'file' | 'host' | 'port' | 'database'>): string {
  if (config.type === 'sqlite') return config.file ?? 'local SQLite file';
  const port = config.port ? `:${config.port}` : '';
  return `${config.host ?? 'localhost'}${port}/${config.database ?? ''}`;
}

export function redactConnection(config: ConnectionConfig): ConnectionConfig {
  return { ...config };
}

/** Secret storage key for a connection password. */
export function passwordKey(id: string): string {
  return `dbv.password.${id}`;
}
