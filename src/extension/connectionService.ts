import * as vscode from 'vscode';
import type { ConnectionConfig, ConnectionSummary } from '../shared/types';
import type { ConnectionStore } from './connectionStore';
import type { Driver } from './drivers/base';
import { defaultDriverFactory, type DriverFactory } from './drivers/factory';
import { connectionEndpoint } from '../core/validation';

interface Entry {
  config: ConnectionConfig;
  driver?: Driver;
  connecting?: Promise<Driver>;
}

export class ConnectionService implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly factory: DriverFactory = defaultDriverFactory,
  ) {}

  list(): ConnectionConfig[] {
    return this.store.list();
  }

  getConfig(id: string): ConnectionConfig | undefined {
    return this.store.get(id);
  }

  summary(config: ConnectionConfig): ConnectionSummary {
    const entry = this.entries.get(config.id);
    return {
      ...(this.store.get(config.id) ?? config),
      connected: Boolean(entry?.driver?.isConnected()),
    };
  }

  summaries(): ConnectionSummary[] {
    return this.store.list().map((config) => this.summary(config));
  }

  endpoint(config: ConnectionConfig): string {
    return connectionEndpoint(config);
  }

  async getDriver(id: string): Promise<Driver> {
    const config = this.store.get(id);
    if (!config) throw new Error('Connection not found');
    let entry = this.entries.get(id);
    if (!entry || entry.config.updatedAt !== config.updatedAt) {
      if (entry?.driver) await entry.driver.close().catch(() => undefined);
      entry = { config };
      this.entries.set(id, entry);
    }
    if (entry.driver?.isConnected()) return entry.driver;
    if (entry.connecting) return entry.connecting;

    const password = await this.store.getPassword(id);
    const driver = this.factory.create(config, password);
    entry.connecting = (async () => {
      await driver.connect();
      entry!.driver = driver;
      this.changeEmitter.fire();
      return driver;
    })();
    try {
      return await entry.connecting;
    } catch (error) {
      await driver.close().catch(() => undefined);
      entry.connecting = undefined;
      throw error;
    } finally {
      entry.connecting = undefined;
    }
  }

  async connect(id: string): Promise<void> {
    await this.getDriver(id);
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await entry.driver?.close().catch(() => undefined);
    entry.driver = undefined;
    entry.connecting = undefined;
    this.changeEmitter.fire();
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    this.entries.delete(id);
    await this.store.remove(id);
    this.changeEmitter.fire();
  }

  async save(input: Partial<ConnectionConfig>, password?: string): Promise<ConnectionConfig> {
    if (input.id) await this.disconnect(input.id);
    const config = await this.store.save(input, password);
    this.entries.delete(config.id);
    this.changeEmitter.fire();
    return config;
  }

  async refresh(): Promise<void> {
    for (const [id, entry] of this.entries) {
      const config = this.store.get(id);
      if (!config || config.updatedAt !== entry.config.updatedAt) {
        await this.disconnect(id);
        this.entries.delete(id);
      }
    }
    this.changeEmitter.fire();
  }

  async dispose(): Promise<void> {
    this.changeEmitter.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await entry.driver?.close().catch(() => undefined);
      }),
    );
    this.entries.clear();
  }
}
