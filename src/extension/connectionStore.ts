import * as vscode from 'vscode';
import type { ConnectionConfig } from '../shared/types';
import { passwordKey, validateConnection } from '../core/validation';

const CONNECTIONS_KEY = 'dbv.connections.v1';

export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionConfig[] {
    return this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((connection) => connection.id === id);
  }

  findByFile(file: string): ConnectionConfig | undefined {
    return this.list().find((connection) => connection.type === 'sqlite' && connection.file === file);
  }

  async save(input: Partial<ConnectionConfig>, password?: string): Promise<ConnectionConfig> {
    const existing = input.id ? this.get(input.id) : undefined;
    const config = validateConnection({
      ...existing,
      ...input,
      createdAt: existing?.createdAt,
    });
    const connections = this.list();
    const index = connections.findIndex((connection) => connection.id === config.id);
    if (index >= 0) connections[index] = config;
    else connections.push(config);
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
    if (password !== undefined && config.type !== 'sqlite') {
      await this.context.secrets.store(passwordKey(config.id), password);
    }
    return config;
  }

  async remove(id: string): Promise<void> {
    await this.context.globalState.update(
      CONNECTIONS_KEY,
      this.list().filter((connection) => connection.id !== id),
    );
    await this.context.secrets.delete(passwordKey(id));
  }

  async getPassword(id: string): Promise<string> {
    return (await this.context.secrets.get(passwordKey(id))) ?? '';
  }

  async hasPassword(id: string): Promise<boolean> {
    return Boolean(await this.context.secrets.get(passwordKey(id)));
  }
}
