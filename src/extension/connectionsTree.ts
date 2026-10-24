import * as vscode from 'vscode';
import type { ConnectionConfig, SchemaInfo, TableRef } from '../shared/types';
import type { ConnectionService } from './connectionService';
import type { Driver } from './drivers/base';
import { logger } from './logger';

export class ConnectionItem extends vscode.TreeItem {
  constructor(
    readonly config: ConnectionConfig,
    readonly connected: boolean,
  ) {
    super(config.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `connection:${config.id}`;
    this.contextValue = 'connection';
    this.iconPath = new vscode.ThemeIcon(connected ? 'database' : 'debug-disconnect');
    this.description = config.type === 'sqlite'
      ? config.file?.split(/[\\/]/).pop()
      : `${config.host ?? 'localhost'}:${config.port ?? ''}/${config.database ?? ''}`;
    this.tooltip = new vscode.MarkdownString(
      `**${config.name}**\n\nType: \`${config.type}\`\n\nEndpoint: \`${this.description}\`` +
        `${config.readonly ? '\n\nRead-only' : ''}`,
    );
  }
}

export class SchemaItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly schema: SchemaInfo,
    tableCount: number,
  ) {
    super(schema.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `schema:${connectionId}:${schema.name}`;
    this.contextValue = 'schema';
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    this.description = `${tableCount} object${tableCount === 1 ? '' : 's'}`;
  }
}

export class TableItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly table: TableRef,
  ) {
    super(table.name, vscode.TreeItemCollapsibleState.None);
    this.id = `table:${connectionId}:${table.schema ?? ''}:${table.name}`;
    this.contextValue = 'table';
    this.iconPath = new vscode.ThemeIcon(table.type === 'view' ? 'eye' : 'table');
    this.description = table.type === 'view' ? 'view' : undefined;
    this.command = {
      command: 'dbv.openTable',
      title: 'Open Table',
      arguments: [{ connectionId, table }],
    };
  }
}

type Node = ConnectionItem | SchemaItem | TableItem;

export class ConnectionsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly connections: ConnectionService) {
    this.disposables.push(connections.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      return this.connections.list().map((config) => new ConnectionItem(config, this.connections.summary(config).connected));
    }
    if (element instanceof ConnectionItem) {
      try {
        const driver: Driver = await this.connections.getDriver(element.config.id);
        const schemas = await driver.listSchemas();
        return schemas.map((schema) => new SchemaItem(element.config.id, schema, schema.tables.length));
      } catch (error) {
        logger.error(`Could not load connection "${element.config.name}" in connections tree`, error);
        void vscode.window.showErrorMessage(
          `DBV: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    }
    if (element instanceof SchemaItem) {
      return element.schema.tables.map((table) => new TableItem(element.connectionId, table));
    }
    return [];
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.changeEmitter.dispose();
  }
}
