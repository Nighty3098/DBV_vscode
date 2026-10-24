import * as vscode from 'vscode';
import { basename, join } from 'node:path';
import type { ConnectionConfig, DatabaseType, TableRef } from '../shared/types';
import { ConnectionStore } from './connectionStore';
import { ConnectionService } from './connectionService';
import { QueryHistoryStore } from './historyStore';
import { ConnectionsProvider, ConnectionItem } from './connectionsTree';
import { DatabaseEditorProvider } from './databaseEditorProvider';
import { SqlEditorProvider } from './sqlEditorProvider';
import { TablePanelManager } from './tablePanel';
import { defaultPort } from '../core/identifiers';
import { connectionEndpoint } from '../core/validation';

interface ConnectionArg {
  connectionId?: string;
  table?: TableRef;
  connection?: ConnectionConfig;
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context);
  const service = new ConnectionService(store);
  const history = new QueryHistoryStore(context);
  const treeProvider = new ConnectionsProvider(service);
  const tablePanels = new TablePanelManager(context, service, history);

  context.subscriptions.push(
    service,
    treeProvider,
    tablePanels,
    vscode.window.createTreeView('dbv.connections', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    }),
    DatabaseEditorProvider.register(context, service, history),
    SqlEditorProvider.register(context, service, history),
  );

  const activeConnectionId = async (arg?: ConnectionArg | ConnectionItem): Promise<string | undefined> => {
    if (arg instanceof ConnectionItem) return arg.config.id;
    if (arg?.connectionId) return arg.connectionId;
    if (arg?.connection) return arg.connection.id;
    const selected = context.workspaceState.get<string>('dbv.activeConnectionId');
    return selected && service.getConfig(selected) ? selected : undefined;
  };

  const setActive = async (id: string | undefined): Promise<void> => {
    await context.workspaceState.update('dbv.activeConnectionId', id);
    treeProvider.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('dbv.addConnection', async () => {
      const config = await promptConnection();
      if (!config) return;
      const saved = await service.save(config.config, config.password);
      await setActive(saved.id);
      await connectAndReport(service, saved);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('dbv.editConnection', async (arg?: ConnectionArg | ConnectionItem) => {
      const id = await selectConnectionId(service, arg, 'Choose a connection to edit');
      if (!id) return;
      const existing = service.getConfig(id);
      if (!existing) return;
      const updated = await promptConnection(existing);
      if (!updated) return;
      await service.save({ ...updated.config, id }, updated.password);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('dbv.removeConnection', async (arg?: ConnectionArg | ConnectionItem) => {
      const id = await selectConnectionId(service, arg, 'Choose a connection to remove');
      if (!id) return;
      const config = service.getConfig(id);
      if (!config) return;
      const choice = await vscode.window.showWarningMessage(
        `Remove connection "${config.name}"? Saved queries are not affected.`,
        { modal: true },
        'Remove',
      );
      if (choice !== 'Remove') return;
      await service.remove(id);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('dbv.connect', async (arg?: ConnectionArg | ConnectionItem) => {
      const id = await selectConnectionId(service, arg, 'Choose a connection to connect');
      if (!id) return;
      await setActive(id);
      await connectAndReport(service, service.getConfig(id));
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('dbv.disconnect', async (arg?: ConnectionArg | ConnectionItem) => {
      const id = await selectConnectionId(service, arg, 'Choose a connection to disconnect');
      if (!id) return;
      await service.disconnect(id);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('dbv.refreshConnections', async () => {
      await service.refresh();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('dbv.openSqliteFile', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        filters: {
          'SQLite databases': ['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'gpkg'],
          'All files': ['*'],
        },
        openLabel: 'Open Database',
      });
      const uri = uris?.[0];
      if (!uri) return;
      await openSqlite(uri);
    }),
    vscode.commands.registerCommand('dbv.newQuery', async (arg?: ConnectionArg | ConnectionItem) => {
      const id = await activeConnectionId(arg);
      if (id) await setActive(id);
      await createScratchQuery(context, '-- Write your SQL query here.\n\nSELECT 1;\n');
    }),
    vscode.commands.registerCommand('dbv.openSqlFile', async (arg?: unknown) => {
      await openSqlFile(context, arg);
    }),
    vscode.commands.registerCommand('dbv.runQuery', async (arg?: unknown) => {
      await runQueryFromEditor(context, service, typeof arg === 'string' ? arg : undefined);
    }),
    vscode.commands.registerCommand('dbv.openTable', async (arg?: ConnectionArg) => {
      const selected = await pickTable(service, arg);
      if (!selected) return;
      await setActive(selected.connectionId);
      await tablePanels.open(selected.connectionId, selected.table);
    }),
    vscode.commands.registerCommand('dbv.exportTable', async (arg?: ConnectionArg) => {
      const selected = await pickTable(service, arg);
      if (!selected) return;
      await setActive(selected.connectionId);
      await tablePanels.open(selected.connectionId, selected.table);
      void vscode.window.showInformationMessage('Use the Export button in the DBV table toolbar to choose CSV, JSON or SQL.');
    }),
    vscode.commands.registerCommand('dbv.openAsText', async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      if (input instanceof vscode.TabInputCustom) {
        await vscode.commands.executeCommand('vscode.openWith', input.uri, 'default');
      }
    }),
    vscode.commands.registerCommand('dbv.showQueryHistory', async () => {
      const entries = history.list();
      if (!entries.length) {
        void vscode.window.showInformationMessage('DBV query history is empty.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: `${entry.success ? '$(check)' : '$(error)'} ${truncate(entry.sql, 90)}`,
          description: `${entry.connectionName} · ${entry.rowCount} rows · ${entry.durationMs} ms`,
          detail: new Date(entry.createdAt).toLocaleString(),
          entry,
        })),
        { title: 'DBV Query History', matchOnDescription: true, matchOnDetail: true },
      );
      if (!picked) return;
      const entry = picked.entry;
      await setActive(entry.connectionId);
      await createScratchQuery(context, entry.sql);
    }),
    vscode.commands.registerCommand('dbv.clearQueryHistory', async () => {
      await history.clear();
      void vscode.window.showInformationMessage('DBV query history cleared.');
    }),
    vscode.commands.registerCommand('dbv.openDocs', async () => {
      await vscode.env.openExternal(
        vscode.Uri.parse('https://github.com/Nighty3098/DBV_vscode#readme'),
      );
    }),
  );

  const openSqlite = async (uri: vscode.Uri): Promise<void> => {
    let config = store.findByFile(uri.fsPath);
    if (!config) {
      const answer = await vscode.window.showInformationMessage(
        `Save "${basename(uri.fsPath)}" to DBV connections for quick access?`,
        'Save Connection',
        'Not Now',
      );
      if (answer === 'Save Connection') {
        const name = await vscode.window.showInputBox({
          title: 'Connection name',
          value: basename(uri.fsPath),
          validateInput: (value) => value.trim() ? undefined : 'Name is required',
        });
        if (name) {
          try {
            config = await service.save({
              name: name.trim(),
              type: 'sqlite',
              file: uri.fsPath,
              readonly: false,
            });
            await setActive(config.id);
            treeProvider.refresh();
          } catch (error) {
            void vscode.window.showErrorMessage(`DBV: ${errorMessage(error)}`);
          }
        }
      }
    } else {
      await setActive(config.id);
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, DatabaseEditorProvider.viewType);
  };

  const autoConnect = vscode.workspace.getConfiguration('dbv').get<boolean>('autoConnect', false);
  if (autoConnect) {
    void (async () => {
      for (const config of store.list()) {
        try {
          await service.getDriver(config.id);
        } catch {
          // A connection failure must not prevent the extension from activating.
        }
      }
      treeProvider.refresh();
    })();
  }
}

export async function deactivate(): Promise<void> {
  // VS Code disposes subscriptions (including ConnectionService) automatically.
}

async function promptConnection(existing?: ConnectionConfig): Promise<{ config: Partial<ConnectionConfig>; password?: string } | undefined> {
  const typePick = existing
    ? undefined
    : await vscode.window.showQuickPick(
        [
          { label: 'SQLite', description: 'Local .sqlite/.db file', type: 'sqlite' as DatabaseType },
          { label: 'PostgreSQL', description: 'Host and port connection', type: 'postgres' as DatabaseType },
          { label: 'MySQL', description: 'Host and port connection', type: 'mysql' as DatabaseType },
          { label: 'MariaDB', description: 'MySQL-compatible server', type: 'mariadb' as DatabaseType },
          { label: 'SQL Server', description: 'Microsoft SQL Server / Azure SQL', type: 'mssql' as DatabaseType },
        ],
        { title: existing ? 'Edit DBV connection' : 'Add DBV connection', placeHolder: 'Choose a database engine' },
      );
  const type = existing?.type ?? typePick?.type;
  if (!type) return undefined;

  if (type === 'sqlite') {
    let file = existing?.file;
    if (!file) {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          'SQLite databases': ['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'gpkg'],
          'All files': ['*'],
        },
        openLabel: 'Choose Database',
      });
      file = uris?.[0]?.fsPath;
      if (!file) return undefined;
    }
    const name = await vscode.window.showInputBox({
      title: 'Connection name',
      value: existing?.name ?? basename(file),
      validateInput: (value) => value.trim() ? undefined : 'Name is required',
    });
    if (name === undefined) return undefined;
    const readonly = await vscode.window.showQuickPick(
      [
        { label: 'Read & write', description: 'Allow editing records', value: false },
        { label: 'Read-only', description: 'Open the database in read-only mode', value: true },
      ],
      { title: 'SQLite access mode' },
    );
    if (!readonly) return undefined;
    return {
      config: {
        id: existing?.id,
        name: name.trim(),
        type,
        file,
        readonly: readonly.value,
        createdAt: existing?.createdAt,
      },
    };
  }

  const host = await vscode.window.showInputBox({
    title: 'Host',
    prompt: 'Hostname or IP address',
    value: existing?.host ?? 'localhost',
    validateInput: (value) => value.trim() ? undefined : 'Host is required',
  });
  if (host === undefined) return undefined;
  const portText = await vscode.window.showInputBox({
    title: 'Port',
    value: String(existing?.port ?? defaultPort(type) ?? ''),
    validateInput: (value) => {
      const port = Number(value);
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? undefined : 'Port must be between 1 and 65535';
    },
  });
  if (portText === undefined) return undefined;
  const database = await vscode.window.showInputBox({
    title: 'Database',
    value: existing?.database ?? '',
    validateInput: (value) => value.trim() ? undefined : 'Database name is required',
  });
  if (database === undefined) return undefined;
  const user = await vscode.window.showInputBox({
    title: 'User',
    value: existing?.user ?? '',
    prompt: type === 'mssql' ? 'SQL login user' : 'Database user',
  });
  if (user === undefined) return undefined;
  const password = await vscode.window.showInputBox({
    title: 'Password',
    password: true,
    prompt: existing ? 'Leave blank to keep the existing password' : 'Password is stored in VS Code Secret Storage',
  });
  if (password === undefined) return undefined;
  const ssl = await vscode.window.showQuickPick(
    [
      { label: 'No SSL', value: false as const },
      { label: 'Require SSL', description: 'Encrypt, do not verify the certificate', value: 'require' as const },
      { label: 'Verify SSL certificate', value: 'verify-full' as const },
    ],
    { title: 'SSL mode', placeHolder: existing?.ssl ? String(existing.ssl) : 'No SSL' },
  );
  if (!ssl) return undefined;
  const name = await vscode.window.showInputBox({
    title: 'Connection name',
    value: existing?.name ?? `${type} ${database.trim()} @ ${host.trim()}`,
    validateInput: (value) => value.trim() ? undefined : 'Name is required',
  });
  if (name === undefined) return undefined;
  const schema = type === 'postgres' || type === 'mssql'
    ? await vscode.window.showInputBox({
        title: 'Default schema (optional)',
        value: existing?.schema ?? (type === 'mssql' ? 'dbo' : 'public'),
      })
    : existing?.schema;
  if (schema === undefined) return undefined;
  const readonly = await vscode.window.showQuickPick(
    [
      { label: 'Read & write', value: false },
      { label: 'Read-only', description: 'DBV will not send edits or destructive commands', value: true },
    ],
    { title: 'Access mode' },
  );
  if (!readonly) return undefined;

  return {
    config: {
      id: existing?.id,
      name: name.trim(),
      type,
      host: host.trim(),
      port: Number(portText),
      database: database.trim(),
      user: user.trim() || undefined,
      schema: schema?.trim() || undefined,
      ssl: ssl.value,
      readonly: readonly.value,
      createdAt: existing?.createdAt,
    },
    password: password || undefined,
  };
}

async function selectConnectionId(
  service: ConnectionService,
  arg: ConnectionArg | ConnectionItem | undefined,
  placeHolder: string,
): Promise<string | undefined> {
  if (arg instanceof ConnectionItem) return arg.config.id;
  if (arg?.connectionId) return arg.connectionId;
  if (arg?.connection) return arg.connection.id;
  const connections = service.list();
  if (!connections.length) {
    void vscode.window.showInformationMessage('DBV: add a connection first.', 'Add Connection').then((choice) => {
      if (choice === 'Add Connection') void vscode.commands.executeCommand('dbv.addConnection');
    });
    return undefined;
  }
  if (connections.length === 1) return connections[0]?.id;
  const picked = await vscode.window.showQuickPick(
    connections.map((config) => ({
      label: config.name,
      description: `${config.type} · ${connectionEndpoint(config)}`,
      config,
    })),
    { title: 'DBV', placeHolder },
  );
  return picked?.config.id;
}

async function connectAndReport(
  service: ConnectionService,
  config: ConnectionConfig | undefined,
): Promise<void> {
  if (!config) return;
  try {
    await service.connect(config.id);
    void vscode.window.showInformationMessage(`DBV connected to ${config.name}`);
  } catch (error) {
    void vscode.window.showErrorMessage(`DBV: ${errorMessage(error)}`);
  }
}

async function pickTable(
  service: ConnectionService,
  arg?: ConnectionArg,
): Promise<{ connectionId: string; table: TableRef } | undefined> {
  let connectionId = arg?.connectionId;
  if (!connectionId) {
    const connections = service.list();
    const picked = await vscode.window.showQuickPick(
      connections.map((config) => ({
        label: config.name,
        description: `${config.type} · ${connectionEndpoint(config)}`,
        id: config.id,
      })),
      { title: 'DBV', placeHolder: 'Choose a connection' },
    );
    connectionId = picked?.id;
  }
  if (!connectionId) return undefined;
  if (arg?.table) return { connectionId, table: arg.table };
  try {
    const driver = await service.getDriver(connectionId);
    const schemas = await driver.listSchemas();
    const items = schemas.flatMap((schema) =>
      schema.tables.map((table) => ({
        label: table.name,
        description: `${schema.name} · ${table.type}`,
        table,
      })),
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: 'DBV',
      placeHolder: 'Choose a table or view',
      matchOnDescription: true,
    });
    return picked ? { connectionId, table: picked.table } : undefined;
  } catch (error) {
    void vscode.window.showErrorMessage(`DBV: ${errorMessage(error)}`);
    return undefined;
  }
}

async function openSqlFile(
  context: vscode.ExtensionContext,
  arg?: unknown,
): Promise<void> {
  if (typeof arg === 'string' && arg.trim()) {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(join(context.globalStorageUri.fsPath, `query-${Date.now()}.sql`)),
      filters: { SQL: ['sql'] },
      saveLabel: 'Save Query',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(arg, 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', uri, SqlEditorProvider.viewType);
    return;
  }
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { SQL: ['sql'] },
    openLabel: 'Open SQL in DBV',
  });
  const uri = uris?.[0];
  if (!uri) return;
  await vscode.commands.executeCommand('vscode.openWith', uri, SqlEditorProvider.viewType);
}

async function createScratchQuery(
  context: vscode.ExtensionContext,
  sql: string,
): Promise<void> {
  try {
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'queries');
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `query-${Date.now()}.sql`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(sql, 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', uri, SqlEditorProvider.viewType);
  } catch (error) {
    void vscode.window.showErrorMessage(`DBV could not create a query file: ${errorMessage(error)}`);
  }
}

async function runQueryFromEditor(
  context: vscode.ExtensionContext,
  service: ConnectionService,
  arg?: string,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const sql = arg ?? (editor
    ? editor.selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(editor.selection)
    : undefined);
  if (!sql?.trim()) {
    void vscode.window.showInformationMessage('DBV: put the cursor in a SQL editor or pass a query.');
    return;
  }
  const connections = service.list();
  if (!connections.length) {
    void vscode.window.showWarningMessage('DBV: add a database connection first.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((config) => ({
      label: config.name,
      description: `${config.type} · ${connectionEndpoint(config)}`,
      id: config.id,
    })),
    { title: 'Open Query with DBV', placeHolder: 'Choose a connection' },
  );
  if (!picked) return;
  await context.workspaceState.update('dbv.activeConnectionId', picked.id);
  await createScratchQuery(context, sql);
  void vscode.window.showInformationMessage('DBV opened the query. Press Ctrl/Cmd+Enter in the workbench to execute it.');
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

