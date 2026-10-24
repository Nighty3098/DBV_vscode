import type { QueryHistoryEntry } from '../shared/types';

export const MAX_HISTORY = 200;

export function pushHistory(
  entries: QueryHistoryEntry[],
  entry: QueryHistoryEntry,
  limit = MAX_HISTORY,
): QueryHistoryEntry[] {
  return [entry, ...entries.filter((existing) => existing.id !== entry.id)].slice(0, limit);
}

export function filterHistory(entries: QueryHistoryEntry[], query: string): QueryHistoryEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  return entries.filter(
    (entry) =>
      entry.sql.toLowerCase().includes(normalized) ||
      entry.connectionName.toLowerCase().includes(normalized),
  );
}

export function formatHistoryTitle(entry: QueryHistoryEntry): string {
  const oneLine = entry.sql.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}
