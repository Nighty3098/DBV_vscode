import * as vscode from 'vscode';
import { basename } from 'node:path';
import { WorkbenchSession } from './workbenchSession';
import { logger } from './logger';
import type { ConnectionService } from './connectionService';
import type { QueryHistoryStore } from './historyStore';
import { webviewHtml } from './webviewHtml';

export class SqlEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'dbv.sqlEditor';

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
      SqlEditorProvider.viewType,
      new SqlEditorProvider(context, service, history),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    try {
      const extensionUri = this.context.extensionUri;
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      };
      panel.webview.html = webviewHtml(panel.webview, extensionUri, basename(document.uri.fsPath));
      panel.title = `${basename(document.uri.fsPath)} — DBV`;
      panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'database.svg');

      const savedConnection = this.context.workspaceState.get<string>('dbv.activeConnectionId');
      const activeConnectionId = savedConnection && this.service.getConfig(savedConnection) ? savedConnection : undefined;
      const session = new WorkbenchSession({
        context: this.context,
        service: this.service,
        history: this.history,
        webview: panel.webview,
        mode: 'sql',
        document,
        initialConnectionId: activeConnectionId,
        setActiveConnectionId: async (id) => {
          await this.context.workspaceState.update('dbv.activeConnectionId', id);
        },
      });

      panel.onDidDispose(() => session.dispose());
    } catch (error) {
      logger.error(`Could not initialize SQL editor "${document.uri.fsPath}"`, error);
      throw error;
    }
  }
}
