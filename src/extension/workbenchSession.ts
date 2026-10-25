import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type {
  ConnectionConfig,
  ConnectionSummary,
  ExportFormat,
  HostMessage,
  QueryHistoryEntry,
  QueryResult,
  TableRef,
  WebviewMessage,
} from '../shared/types';
import type { Driver } from './drivers/base';
import type { ConnectionService } from './connectionService';
import type { QueryHistoryStore } from './historyStore';
import { exportResult } from '../core/serialization';
import { normalizeStructureLists } from '../core/structure';
import { logger } from './logger';

export interface FixedConnection {
  config: ConnectionConfig;
  driver: Driver;
}

export interface WorkbenchSessionOptions {
  context: vscode.ExtensionContext;
  service: ConnectionService;
  history: QueryHistoryStore;
  webview: vscode.Webview;
  mode: 'database' | 'sql';
  fixed?: FixedConnection;
  document?: vscode.TextDocument;
  initialTable?: TableRef;
  initialConnectionId?: string;
  setActiveConnectionId?: (id: string | undefined) => Thenable<void>;
  /** Connection failure to show instead of trying to load the catalog. */
  startupError?: string;
}

interface RequestContext {
  requestId?: string;
}

export class WorkbenchSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private activeConnectionId: string | undefined;
  private initialized = false;
  private applyingText = false;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkbenchSessionOptions) {
    this.activeConnectionId = options.initialConnectionId;
    this.disposables.push(
      options.webview.onDidReceiveMessage((message: WebviewMessage) => {
        this.messageQueue = this.messageQueue
          .then(() => this.handle(message))
          .catch((error: unknown) => {
            logger.error('Could not process a webview message', error);
            this.notify('error', errorMessage(error));
          });
      }),
    );
    this.disposables.push(
      options.service.onDidChange(() => {
        if (this.initialized) this.post({ type: 'connections', connections: this.connectionSummaries(), activeConnectionId: this.activeConnectionId });
      }),
    );
    if (options.document) {
      this.disposables.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document !== options.document) return;
          const text = event.document.getText();
          if (!this.applyingText) {
            this.post({ type: 'documentChanged', text, dirty: event.document.isDirty });
          }
        }),
      );
      this.disposables.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
          if (document !== options.document) return;
          if (this.initialized) this.post({ type: 'saved', uri: document.uri.toString() });
        }),
      );
    }
  }

  private post(message: HostMessage): void {
    void this.options.webview.postMessage(message).then(undefined, (error: unknown) => {
      logger.error(`Could not post "${message.type}" message to webview`, error);
    });
  }

  private fixedSummary(): ConnectionSummary | undefined {
    if (!this.options.fixed) return undefined;
    return { ...this.options.fixed.config, connected: this.options.fixed.driver.isConnected() };
  }

  private connectionSummaries(): ConnectionSummary[] {
    const summaries = this.options.service.summaries();
    const fixed = this.fixedSummary();
    if (fixed && !summaries.some((connection) => connection.id === fixed.id)) summaries.unshift(fixed);
    return summaries;
  }

  private async activeSummary(): Promise<ConnectionSummary | undefined> {
    if (this.options.fixed) return this.fixedSummary();
    if (!this.activeConnectionId) return undefined;
    const config = this.options.service.getConfig(this.activeConnectionId);
    return config ? this.options.service.summary(config) : undefined;
  }

  private async resolveDriver(connectionId?: string): Promise<{ driver: Driver; config: ConnectionConfig }> {
    if (this.options.fixed) {
      return { driver: this.options.fixed.driver, config: this.options.fixed.config };
    }
    const id = connectionId ?? this.activeConnectionId;
    if (!id) throw new Error('Select a database connection first');
    const config = this.options.service.getConfig(id);
    if (!config) throw new Error('The selected connection no longer exists');
    const driver = await this.options.service.getDriver(id);
    return { driver, config };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const active = await this.activeSummary();
    this.post({
      type: 'init',
      mode: this.options.mode,
      documentUri: this.options.document?.uri.toString(),
      fileName: this.options.document ? this.basename(this.options.document.uri) : undefined,
      connection: active,
      connections: this.connectionSummaries(),
      pageSize: this.pageSize(),
      maxResultRows: this.maxResultRows(),
      confirmDestructive: this.confirmDestructive(),
      sqlText: this.options.mode === 'sql' ? this.options.document?.getText() : undefined,
      dirty: this.options.document?.isDirty ?? false,
      initialTable: this.options.initialTable,
      activeConnectionId: this.activeConnectionId ?? this.options.fixed?.config.id,
      history: this.options.history.list(),
      fatalError: this.options.startupError,
    });
    if (active && !this.options.startupError) {
      await this.sendCatalog();
    }
  }

  private async handle(message: WebviewMessage): Promise<void> {
    const request: RequestContext = 'requestId' in message ? { requestId: message.requestId } : {};
    try {
      switch (message.type) {
        case 'ready':
          await this.initialize();
          break;
        case 'loadTablePage':
          await this.loadTablePage(message);
          break;
        case 'loadStructure':
          await this.loadStructure(message);
          break;
        case 'runQuery':
          await this.runQuery(message);
          break;
        case 'refreshCatalog':
          await this.sendCatalog();
          break;
        case 'selectConnection':
          await this.selectConnection(message.connectionId);
          break;
        case 'updateCell':
          await this.mutate('update', message.table, async (driver) => {
            await driver.updateRow(message.table, message.primaryKey, message.column, message.value);
          });
          break;
        case 'insertRow':
          await this.mutate('insert', message.table, async (driver) => {
            await driver.insertRow(message.table, message.values);
          });
          break;
        case 'deleteRows':
          if (await this.confirm(`Delete ${message.primaryKeys.length} row(s)? This cannot be undone.`)) {
            await this.mutate('delete', message.table, async (driver) => {
              await driver.deleteRows(message.table, message.primaryKeys);
            }, message.primaryKeys.length);
          }
          break;
        case 'dropTable':
          if (await this.confirm(`Drop ${message.table.type} "${message.table.name}"? This cannot be undone.`)) {
            await this.mutate('drop', message.table, async (driver) => {
              await driver.dropTable(message.table);
            });
            await this.sendCatalog();
          }
          break;
        case 'truncateTable':
          if (await this.confirm(`Delete every row from "${message.table.name}"?`)) {
            await this.mutate('truncate', message.table, async (driver) => {
              await driver.truncateTable(message.table);
            });
            await this.sendCatalog();
          }
          break;
        case 'addConnection':
          await vscode.commands.executeCommand('dbv.addConnection');
          this.post({ type: 'connections', connections: this.connectionSummaries(), activeConnectionId: this.activeConnectionId });
          break;
        case 'editConnection':
          await vscode.commands.executeCommand('dbv.editConnection', { connectionId: message.connectionId });
          this.post({ type: 'connections', connections: this.connectionSummaries(), activeConnectionId: this.activeConnectionId });
          break;
        case 'openSqliteFile':
          await vscode.commands.executeCommand('dbv.openSqliteFile');
          break;
        case 'openQueryFile':
          await vscode.commands.executeCommand('dbv.openSqlFile', message.sql);
          break;
        case 'openTableInEditor':
          await vscode.commands.executeCommand('dbv.openTable', {
            connectionId: this.options.fixed?.config.id ?? this.activeConnectionId,
            table: message.table,
          });
          break;
        case 'exportTable':
          await this.exportTable(message.table, message.format);
          break;
        case 'exportQuery':
          await this.exportQuery(message.sql, message.format);
          break;
        case 'updateText':
          await this.updateText(message.text);
          break;
        case 'saveDocument':
          await this.options.document?.save();
          break;
        case 'revertDocument':
          await vscode.commands.executeCommand('workbench.action.files.revert');
          break;
        case 'clearHistory':
          await this.options.history.clear();
          this.post({ type: 'history', entries: [] });
          break;
        case 'copyText':
          await vscode.env.clipboard.writeText(message.text);
          this.notify('success', 'Copied to clipboard');
          break;
        case 'webviewError': {
          const webviewError = new Error(message.message);
          if (message.stack) webviewError.stack = message.stack;
          logger.error(
            `Webview ${message.source} error: ${message.message}${message.componentStack ? `\nComponent stack:${message.componentStack}` : ''}`,
            webviewError,
          );
          break;
        }
        case 'openDocs':
          await vscode.commands.executeCommand('dbv.openDocs');
          break;
        case 'cancelQuery':
          this.notify('info', 'Query cancellation is not supported by this driver');
          break;
        case 'openTable':
          await this.loadTablePage({
            type: 'loadTablePage',
            requestId: message.requestId,
            table: message.table,
            offset: 0,
            limit: this.pageSize(),
          });
          break;
        default:
          break;
      }
    } catch (error) {
      const detail =
        message.type === 'loadStructure'
          ? ` for table "${message.table.name}"`
          : '';
      logger.error(`Webview action "${message.type}"${detail} failed`, error);
      const text = errorMessage(error);
      if (request.requestId) this.post({ type: 'requestError', requestId: request.requestId, message: text });
      else this.notify('error', text);
    }
  }

  private async loadTablePage(message: Extract<WebviewMessage, { type: 'loadTablePage' }>): Promise<void> {
    const { driver } = await this.resolveDriver();
    const page = await driver.loadPage({
      table: message.table,
      offset: Math.max(0, message.offset),
      limit: Math.max(1, Math.min(5000, message.limit)),
      sort: message.sort,
      filters: message.filters,
      includeCount: message.offset === 0,
    });
    this.post({ type: 'tablePage', requestId: message.requestId, page });
  }

  private async loadStructure(message: Extract<WebviewMessage, { type: 'loadStructure' }>): Promise<void> {
    const { driver } = await this.resolveDriver();
    const result = normalizeStructureLists(
      await driver.getStructure(message.table),
      message.table,
    );
    if (result.malformedFields.length) {
      logger.warn(
        `Malformed structure metadata for table "${message.table.name}"`,
        new Error(result.malformedFields.join('\n')),
      );
    }
    const { structure } = result;
    this.post({ type: 'structure', requestId: message.requestId, structure });
  }

  private async runQuery(message: Extract<WebviewMessage, { type: 'runQuery' }>): Promise<void> {
    const { driver, config } = await this.resolveDriver(message.connectionId);
    if (message.connectionId && !this.options.fixed) {
      this.activeConnectionId = message.connectionId;
      await this.options.setActiveConnectionId?.(message.connectionId);
    }
    this.post({ type: 'busy', requestId: message.requestId, busy: true, label: 'Running query…' });
    const started = Date.now();
    try {
      const result = await driver.executeQuery(message.sql, [], {
        maxRows: message.maxRows ?? this.maxResultRows(),
        timeoutMs: this.queryTimeout(),
      });
      this.post({ type: 'queryResult', requestId: message.requestId, result });
      await this.recordHistory({
        id: randomUUID(),
        sql: message.sql,
        connectionName: config.name,
        connectionId: config.id,
        durationMs: result.durationMs,
        rowCount: result.rowCount,
        success: true,
        createdAt: Date.now(),
      });
    } catch (error) {
      logger.error('SQL query execution failed', error);
      const text = errorMessage(error);
      this.post({ type: 'queryError', requestId: message.requestId, message: text });
      await this.recordHistory({
        id: randomUUID(),
        sql: message.sql,
        connectionName: config.name,
        connectionId: config.id,
        durationMs: Date.now() - started,
        rowCount: 0,
        success: false,
        error: text,
        createdAt: Date.now(),
      });
    } finally {
      this.post({ type: 'busy', requestId: message.requestId, busy: false });
    }
  }

  private async recordHistory(entry: QueryHistoryEntry): Promise<void> {
    const entries = await this.options.history.add(entry);
    this.post({ type: 'history', entries });
  }

  private async sendCatalog(): Promise<void> {
    if (!this.options.fixed && !this.activeConnectionId) {
      this.post({ type: 'connections', connections: this.connectionSummaries(), activeConnectionId: undefined });
      return;
    }
    try {
      const { driver, config } = await this.resolveDriver();
      const schemas = await driver.listSchemas();
      this.post({ type: 'catalog', schemas, connectionName: config.name });
      this.post({
        type: 'connections',
        connections: this.connectionSummaries(),
        activeConnectionId: this.activeConnectionId ?? (this.options.fixed ? config.id : undefined),
      });
    } catch (error) {
      logger.error('Could not load database catalog', error);
      this.notify('error', errorMessage(error));
    }
  }

  private async selectConnection(connectionId: string | undefined): Promise<void> {
    if (this.options.fixed) return;
    this.activeConnectionId = connectionId;
    await this.options.setActiveConnectionId?.(connectionId);
    this.post({ type: 'connections', connections: this.connectionSummaries(), activeConnectionId: connectionId });
    if (connectionId) await this.sendCatalog();
  }

  private async mutate(
    operation: 'update' | 'insert' | 'delete' | 'drop' | 'truncate',
    table: TableRef,
    action: (driver: Driver) => Promise<void>,
    count = 1,
  ): Promise<void> {
    const { driver } = await this.resolveDriver();
    await action(driver);
    const message =
      operation === 'update'
        ? 'Row updated'
        : operation === 'insert'
          ? 'Row inserted'
          : operation === 'delete'
            ? `${count} row(s) deleted`
            : operation === 'drop'
              ? 'Object dropped'
              : 'Table emptied';
    this.post({ type: 'operationDone', operation, success: true, message });
    this.notify('success', message);
    void table;
  }

  private async confirm(message: string): Promise<boolean> {
    if (!this.confirmDestructive()) return true;
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Continue');
    if (choice !== 'Continue') {
      this.notify('info', 'Action cancelled');
      return false;
    }
    return true;
  }

  private async updateText(text: string): Promise<void> {
    const document = this.options.document;
    if (!document || document.getText() === text) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    this.applyingText = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      setTimeout(() => {
        this.applyingText = false;
      }, 0);
    }
  }

  private async exportTable(table: TableRef, format: ExportFormat): Promise<void> {
    const { driver } = await this.resolveDriver();
    const limit = 100_000;
    const batch = 2000;
    let offset = 0;
    let result: QueryResult | undefined;
    while (offset < limit) {
      const page = await driver.loadPage({ table, offset, limit: batch, includeCount: offset === 0 });
      if (!page.rows.length) break;
      if (!result) {
        result = { columns: page.columns.map((column) => ({ name: column.name })), rows: [], rowCount: 0, truncated: false, durationMs: 0, command: false };
      }
      result.rows.push(...page.rows);
      offset += page.rows.length;
      if (page.total !== null && offset >= page.total) break;
      if (page.rows.length < batch) break;
    }
    if (!result?.rows.length) {
      this.notify('warning', 'This table has no rows to export');
      return;
    }
    if (offset >= limit) this.notify('warning', `Export stopped at ${limit.toLocaleString()} rows`);
    await this.saveExport(result, table, format, driver.type);
  }

  private async exportQuery(sql: string, format: ExportFormat): Promise<void> {
    const { driver } = await this.resolveDriver();
    const result = await driver.executeQuery(sql, [], { maxRows: 100_000, timeoutMs: this.queryTimeout() });
    if (result.truncated) this.notify('warning', 'Export contains the first 100,000 rows only');
    await this.saveExport(result, { name: 'query-result', type: 'table' }, format, driver.type);
  }

  private async saveExport(
    result: QueryResult,
    table: TableRef,
    format: ExportFormat,
    type: 'sqlite' | 'postgres' | 'mysql' | 'mariadb' | 'mssql',
  ): Promise<void> {
    const exported = exportResult(result, table, format, type);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(exported.defaultFileName),
      filters: {
        CSV: ['csv'],
        JSON: ['json', 'jsonl'],
        SQL: ['sql'],
      },
      saveLabel: 'Export',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(exported.content, 'utf8'));
    this.notify('success', `Exported ${result.rows.length.toLocaleString()} rows to ${this.basename(uri)}`);
  }

  private notify(kind: 'info' | 'success' | 'warning' | 'error', message: string): void {
    this.post({ type: 'toast', kind, message });
  }

  private basename(uri: vscode.Uri): string {
    return uri.path.split('/').pop() ?? uri.fsPath.split(/[\\/]/).pop() ?? 'file';
  }

  private pageSize(): number {
    return vscode.workspace.getConfiguration('dbv').get<number>('pageSize', 200);
  }

  private maxResultRows(): number {
    return vscode.workspace.getConfiguration('dbv').get<number>('maxResultRows', 1000);
  }

  private queryTimeout(): number {
    return vscode.workspace.getConfiguration('dbv').get<number>('queryTimeout', 60) * 1000;
  }

  private confirmDestructive(): boolean {
    return vscode.workspace.getConfiguration('dbv').get<boolean>('confirmDestructiveActions', true);
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
