import * as vscode from 'vscode';
import type { TableRef } from '../shared/types';
import type { ConnectionService } from './connectionService';
import type { QueryHistoryStore } from './historyStore';
import { WorkbenchSession } from './workbenchSession';
import { webviewHtml } from './webviewHtml';

export class TablePanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ConnectionService,
    private readonly history: QueryHistoryStore,
  ) {}

  async open(connectionId: string, table: TableRef): Promise<void> {
    const config = this.service.getConfig(connectionId);
    if (!config) {
      void vscode.window.showErrorMessage('DBV: connection not found');
      return;
    }
    const key = `${connectionId}:${table.schema ?? ''}:${table.name}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    let driver;
    try {
      driver = await this.service.getDriver(connectionId);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `DBV: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbv.table',
      `${table.name} — ${config.name}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'database.svg');
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, table.name);
    const session = new WorkbenchSession({
      context: this.context,
      service: this.service,
      history: this.history,
      webview: panel.webview,
      mode: 'database',
      fixed: { config, driver },
      initialTable: table,
    });
    this.panels.set(key, panel);
    panel.onDidDispose(() => {
      session.dispose();
      this.panels.delete(key);
    });
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
