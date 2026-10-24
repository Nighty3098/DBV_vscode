import * as vscode from 'vscode';
import type { QueryHistoryEntry } from '../shared/types';
import { pushHistory } from '../core/history';

const HISTORY_KEY = 'dbv.queryHistory.v1';

export class QueryHistoryStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): QueryHistoryEntry[] {
    return this.context.globalState.get<QueryHistoryEntry[]>(HISTORY_KEY, []);
  }

  async add(entry: QueryHistoryEntry): Promise<QueryHistoryEntry[]> {
    const entries = pushHistory(this.list(), entry);
    await this.context.globalState.update(HISTORY_KEY, entries);
    return entries;
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(HISTORY_KEY, []);
  }
}
