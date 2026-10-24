import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { ConnectionConfig } from '../shared/types';
import { SqliteDriver } from './drivers/sqlite';
import { WorkbenchSession } from './workbenchSession';
import type { ConnectionService } from './connectionService';
import type { QueryHistoryStore } from './historyStore';
import { webviewHtml } from './webviewHtml';

export class DatabaseEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'dbv.databaseEditor';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ConnectionService,
    private readonly history: QueryHistoryStore,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    service: ConnectionService,
    history: QueryHistoryStore,
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      DatabaseEditorProvider.viewType,
      new DatabaseEditorProvider(context, service, history),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      },
    );
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const extensionUri = this.context.extensionUri;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    panel.webview.html = webviewHtml(panel.webview, extensionUri, basename(document.uri.fsPath));
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'database.svg');

    const config: ConnectionConfig = {
      id: `file:${document.uri.fsPath}`,
      name: basename(document.uri.fsPath),
      type: 'sqlite',
      file: document.uri.fsPath,
      readonly: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const driver = new SqliteDriver(config);
    let startupError: string | undefined;
    try {
      await driver.connect();
      panel.title = `${basename(document.uri.fsPath)} — DBV`;
    } catch (error) {
      startupError = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`DBV: ${startupError}`);
    }
    const session = new WorkbenchSession({
      context: this.context,
      service: this.service,
      history: this.history,
      webview: panel.webview,
      mode: 'database',
      fixed: { config, driver },
      startupError,
    });

    panel.onDidDispose(() => {
      session.dispose();
      void driver.close();
    });
  }
}
