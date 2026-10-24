import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CellValue,
  ColumnInfo,
  ConnectionSummary,
  FilterCondition,
  FilterOperator,
  HostMessage,
  QueryHistoryEntry,
  QueryResult,
  Row,
  SchemaInfo,
  SortSpec,
  TablePage,
  TableRef,
  TableStructure,
  WebviewMessage,
  ExportFormat,
} from '../shared/types';
import { FILTER_OPERATORS } from '../core/queryBuilder';
import { primaryKeyOf, parseInputValue } from '../core/mutations';
import { cellToDisplay, formatValueForExport } from '../core/serialization';
import { SqlCodeEditor, type SqlEditorHandle } from './SqlCodeEditor';

const vscode = acquireVsCodeApi<{ mode?: string }>();

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

type Tab = 'data' | 'structure' | 'query' | 'history';

interface InitData {
  mode: 'database' | 'sql';
  documentUri?: string;
  fileName?: string;
  pageSize: number;
  maxResultRows: number;
  confirmDestructive: boolean;
  initialTable?: TableRef;
  history: QueryHistoryEntry[];
  fatalError?: string;
}

interface CellEdit {
  row: Row;
  column: ColumnInfo;
  text: string;
  setNull: boolean;
  readOnly: boolean;
}

interface FilterDraft extends FilterCondition {
  key: number;
}

export function App(): React.ReactElement {
  const [init, setInit] = useState<InitData>();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string>();
  const [catalog, setCatalog] = useState<SchemaInfo[]>([]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [selectedTable, setSelectedTable] = useState<TableRef>();
  const [tab, setTab] = useState<Tab>('query');
  const [page, setPage] = useState<TablePage>();
  const [knownTotal, setKnownTotal] = useState<number | null>(null);
  const [pageOffset, setPageOffset] = useState(0);
  const [pageLimit, setPageLimit] = useState(200);
  const [sort, setSort] = useState<SortSpec>();
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterDrafts, setFilterDrafts] = useState<FilterDraft[]>([]);
  const [structure, setStructure] = useState<TableStructure>();
  const [structureLoading, setStructureLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [cellEdit, setCellEdit] = useState<CellEdit>();
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertFields, setInsertFields] = useState<Record<string, { include: boolean; text: string; setNull: boolean }>>({});
  const [querySql, setQuerySql] = useState('-- Write SQL and press Ctrl/Cmd+Enter\nSELECT 1;\n');
  const [sqlDocument, setSqlDocument] = useState('');
  const [dirty, setDirty] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryResult>();
  const [queryError, setQueryError] = useState<string>();
  const [queryBusy, setQueryBusy] = useState(false);
  const [lastQuery, setLastQuery] = useState<{ sql: string }>();
  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
  const [toasts, setToasts] = useState<Array<{ id: number; kind: string; message: string }>>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const sqlEditorRef = useRef<SqlEditorHandle>(null);
  const pageRequest = useRef('');
  const queryRequest = useRef('');
  const structureRequest = useRef('');
  const requestCounter = useRef(0);
  const initOnce = useRef(false);
  const pendingInitial = useRef<TableRef | undefined>(undefined);
  const selectedTableRef = useRef<TableRef | undefined>(undefined);
  const pageOffsetRef = useRef(0);
  const pageLimitRef = useRef(200);
  const sortRef = useRef<SortSpec | undefined>(undefined);
  const filtersRef = useRef<FilterCondition[]>([]);
  const modeRef = useRef<'database' | 'sql'>('database');
  const sqlDocumentRef = useRef('');

  useEffect(() => {
    sqlDocumentRef.current = sqlDocument;
  }, [sqlDocument]);
  useEffect(() => { selectedTableRef.current = selectedTable; }, [selectedTable]);
  useEffect(() => { pageOffsetRef.current = pageOffset; }, [pageOffset]);
  useEffect(() => { pageLimitRef.current = pageLimit; }, [pageLimit]);
  useEffect(() => { sortRef.current = sort; }, [sort]);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  const notify = useCallback((kind: string, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, kind, message }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4500);
  }, []);

  const loadPage = useCallback((
    table: TableRef,
    offset: number,
    limit: number,
    nextSort: SortSpec | undefined,
    nextFilters: FilterCondition[],
  ) => {
    const requestId = `page:${++requestCounter.current}`;
    pageRequest.current = requestId;
    setPageLoading(true);
    post({
      type: 'loadTablePage',
      requestId,
      table,
      offset,
      limit,
      sort: nextSort,
      filters: nextFilters,
    });
  }, []);

  const loadStructure = useCallback((table: TableRef, show = true) => {
    const requestId = `structure:${++requestCounter.current}`;
    structureRequest.current = requestId;
    setStructureLoading(true);
    if (show) setTab('structure');
    post({ type: 'loadStructure', requestId, table });
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      switch (message.type) {
        case 'init': {
          modeRef.current = message.mode;
          setInit({
            mode: message.mode,
            documentUri: message.documentUri,
            fileName: message.fileName,
            pageSize: message.pageSize,
            maxResultRows: message.maxResultRows,
            confirmDestructive: message.confirmDestructive,
            initialTable: message.initialTable,
            history: message.history,
            fatalError: message.fatalError,
          });
          setConnections(message.connections);
          setActiveConnectionId(message.activeConnectionId);
          setHistory(message.history);
          setPageLimit(message.pageSize);
          pageLimitRef.current = message.pageSize;
          if (message.mode === 'sql') {
            setSqlDocument(message.sqlText ?? '');
            setQuerySql(message.sqlText ?? '');
            setDirty(Boolean(message.dirty));
            setTab('query');
          } else if (message.initialTable) {
            setSelectedTable(message.initialTable);
            pendingInitial.current = message.initialTable;
            setTab('data');
            setQuerySql('-- Write SQL and press Ctrl/Cmd+Enter\nSELECT * FROM ' + message.initialTable.name + ' LIMIT 100;\n');
          } else {
            setTab('query');
          }
          break;
        }
        case 'connections':
          setConnections(message.connections);
          setActiveConnectionId(message.activeConnectionId);
          break;
        case 'catalog':
          setCatalog(message.schemas);
          setCatalogLoading(false);
          setExpandedSchemas((current) => {
            if (current.size) return current;
            return new Set(message.schemas.map((schema) => schema.name));
          });
          break;
        case 'tablePage':
          if (message.requestId !== pageRequest.current) break;
          setPage(message.page);
          setPageLoading(false);
          setPageOffset(message.page.offset);
          setPageLimit(message.page.limit);
          setSelectedRows(new Set());
          setSelectedTable({ schema: message.page.schema, name: message.page.table, type: selectedTableRef.current?.type ?? 'table' });
          if (message.page.total !== null) setKnownTotal(message.page.total);
          break;
        case 'structure':
          if (message.requestId !== structureRequest.current) break;
          setStructure(message.structure);
          setStructureLoading(false);
          break;
        case 'queryResult':
          if (message.requestId !== queryRequest.current) break;
          setQueryResult(message.result);
          setQueryError(undefined);
          setQueryBusy(false);
          break;
        case 'queryError':
          if (message.requestId !== queryRequest.current) break;
          setQueryError(message.message);
          setQueryResult(undefined);
          setQueryBusy(false);
          notify('error', message.message);
          break;
        case 'requestError':
          if (message.requestId === pageRequest.current) {
            setPageLoading(false);
            notify('error', message.message);
          } else if (message.requestId === structureRequest.current) {
            setStructureLoading(false);
            notify('error', message.message);
          } else if (message.requestId === queryRequest.current) {
            setQueryBusy(false);
            setQueryError(message.message);
          } else {
            notify('error', message.message);
          }
          break;
        case 'operationDone':
          if (message.success) {
            notify('success', message.message);
            const table = selectedTableRef.current;
            if (table) {
              loadPage(table, pageOffsetRef.current, pageLimitRef.current, sortRef.current, filtersRef.current);
              if (tab === 'structure') loadStructure(table, false);
            }
            if (message.operation === 'drop' || message.operation === 'truncate') {
              setCatalogLoading(true);
              post({ type: 'refreshCatalog' });
            }
          }
          break;
        case 'busy':
          if (message.requestId === queryRequest.current) setQueryBusy(message.busy);
          break;
        case 'documentChanged':
          setSqlDocument(message.text);
          setQuerySql(message.text);
          setDirty(message.dirty);
          break;
        case 'saved':
          setDirty(false);
          notify('success', 'SQL file saved');
          break;
        case 'history':
          setHistory(message.entries);
          break;
        case 'toast':
          notify(message.kind, message.message);
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', handler);
    if (!initOnce.current) {
      initOnce.current = true;
      post({ type: 'ready' });
    }
    return () => window.removeEventListener('message', handler);
  }, [loadPage, loadStructure, notify, tab]);

  useEffect(() => {
    const table = pendingInitial.current;
    if (!init || !table) return;
    pendingInitial.current = undefined;
    loadPage(table, 0, init.pageSize, undefined, []);
  }, [init, loadPage]);

  useEffect(() => {
    if (!selectedTable || !init || pendingInitial.current) return;
    if (!page && !pageLoading) {
      loadPage(selectedTable, 0, pageLimitRef.current, sortRef.current, filtersRef.current);
    }
  }, [selectedTable, init, page, pageLoading, loadPage]);

  const chooseTable = (table: TableRef) => {
    const changing = selectedTable?.schema !== table.schema || selectedTable?.name !== table.name;
    setSelectedTable(table);
    setTab('data');
    setPage(undefined);
    setKnownTotal(null);
    if (changing) {
      setSort(undefined);
      setFilters([]);
      setFilterDrafts([]);
      setStructure(undefined);
    }
    setPageOffset(0);
    loadPage(table, 0, pageLimitRef.current, changing ? undefined : sort, changing ? [] : filters);
  };

  const refresh = () => {
    if (!selectedTable) return;
    loadPage(selectedTable, pageOffset, pageLimit, sort, filters);
    if (tab === 'structure') loadStructure(selectedTable, false);
  };

  const refreshCatalog = () => {
    setCatalogLoading(true);
    post({ type: 'refreshCatalog' });
  };

  const applySort = (column: string) => {
    if (!selectedTable) return;
    const next = sort?.column !== column ? { column, direction: 'asc' as const }
      : sort.direction === 'asc' ? { column, direction: 'desc' as const } : undefined;
    setSort(next);
    setPageOffset(0);
    setKnownTotal(null);
    loadPage(selectedTable, 0, pageLimit, next, filters);
  };

  const goToPage = (targetOffset: number) => {
    if (!selectedTable) return;
    const offset = Math.max(0, targetOffset);
    setPageOffset(offset);
    loadPage(selectedTable, offset, pageLimit, sort, filters);
  };

  const changePageLimit = (limit: number) => {
    setPageLimit(limit);
    pageLimitRef.current = limit;
    setPageOffset(0);
    if (selectedTable) loadPage(selectedTable, 0, limit, sort, filters);
  };

  const openFilters = () => {
    if (!filterOpen) {
      setFilterDrafts(filters.map((filter) => ({ ...filter, key: Math.random() })));
    }
    setFilterOpen((value) => !value);
  };

  const applyFilters = () => {
    const cleaned: FilterCondition[] = [];
    for (const filter of filterDrafts) {
      const operator = FILTER_OPERATORS.find((item) => item.id === filter.operator);
      if (!filter.column) { notify('warning', 'Choose a column for every filter'); return; }
      if (operator?.arity === 1 && filter.operator !== 'in' && !filter.value) {
        notify('warning', 'A filter value is required'); return;
      }
      if (filter.operator === 'in' && !filter.value?.trim()) {
        notify('warning', 'An IN filter needs at least one comma-separated value'); return;
      }
      cleaned.push({
        column: filter.column,
        operator: filter.operator,
        value: filter.value,
        values: filter.operator === 'in' ? filter.value?.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      });
    }
    setFilters(cleaned);
    setKnownTotal(null);
    setPageOffset(0);
    if (selectedTable) loadPage(selectedTable, 0, pageLimit, sort, cleaned);
    setFilterOpen(false);
  };

  const activeSummary = connections.find((connection) => connection.id === activeConnectionId);

  const executeQuery = (sql: string) => {
    if (!sql.trim()) {
      notify('warning', 'The query is empty');
      return;
    }
    const requestId = `query:${++requestCounter.current}`;
    queryRequest.current = requestId;
    setQueryBusy(true);
    setQueryError(undefined);
    setQueryResult(undefined);
    setLastQuery({ sql });
    post({ type: 'runQuery', requestId, sql, connectionId: modeRef.current === 'sql' ? activeConnectionId : undefined, maxRows: init?.maxResultRows });
  };

  const handleSqlChange = (value: string) => {
    setQuerySql(value);
    if (modeRef.current !== 'sql') return;
    setSqlDocument(value);
    setDirty(true);
    // Sync every edit so closing the editor immediately cannot lose changes.
    post({ type: 'updateText', text: value });
  };

  const saveSql = () => {
    if (modeRef.current !== 'sql') return;
    post({ type: 'updateText', text: sqlDocument });
    post({ type: 'saveDocument' });
  };

  const loadTableInQuery = (table: TableRef) => {
    const name = table.schema ? `${table.schema}.${table.name}` : table.name;
    setQuerySql(`SELECT *\nFROM ${name}\nLIMIT 100;\n`);
    setTab('query');
  };

  const selectedColumnNames = page?.columns.map((column) => column.name) ?? [];

  if (!init) {
    return <div className="loading-screen"><div className="spinner" />Loading DBV…</div>;
  }

  if (init.fatalError) {
    return (
      <div className="fatal-screen">
        <div className="empty-state">
          <div className="empty-icon">⚠</div>
          <h2>Could not open database</h2>
          <p className="error-text">{init.fatalError}</p>
          <p className="muted">
            The file may be corrupt, locked by another process, or not a SQLite database.
            Use “Reopen DBV Editor as Text” from the editor title menu to inspect it as text.
          </p>
        </div>
      </div>
    );
  }

  const isSqlMode = init.mode === 'sql';
  const canEdit = page?.editable ?? false;
  const displayUrl = init.documentUri;
  const tableLabel = selectedTable ? (selectedTable.schema ? `${selectedTable.schema}.${selectedTable.name}` : selectedTable.name) : undefined;
  const totalPages = knownTotal !== null ? Math.max(1, Math.ceil(knownTotal / pageLimit)) : null;

  const renderInsertDialog = () => {
    if (!insertOpen || !page) return null;
    const updateField = (name: string, patch: Partial<{ include: boolean; text: string; setNull: boolean }>) => {
      setInsertFields((current) => ({ ...current, [name]: { ...current[name]!, ...patch } }));
    };
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <div className="modal wide">
          <div className="modal-header">
            <h2>Insert row</h2>
            <button className="icon-button" onClick={() => setInsertOpen(false)} aria-label="Close">×</button>
          </div>
          <p className="muted">Tick a field to include it. Unticked fields use their database default. Type NULL or tick “Set NULL”.</p>
          <div className="insert-grid">
            {page.columns.map((column) => {
              const field = insertFields[column.name] ?? { include: false, text: '', setNull: false };
              return (
                <div className="insert-field" key={column.name}>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={field.include}
                      onChange={(event) => updateField(column.name, { include: event.target.checked })}
                    />
                    <span>{column.name}</span>
                    <span className="type-badge">{column.dataType}</span>
                  </label>
                  <div className="field-row">
                    <input
                      value={field.text}
                      disabled={!field.include || field.setNull}
                      placeholder={column.defaultValue ? `default: ${column.defaultValue}` : 'value'}
                      onChange={(event) => updateField(column.name, { text: event.target.value })}
                    />
                    <label className="null-check" title="Set SQL NULL">
                      <input
                        type="checkbox"
                        disabled={!field.include}
                        checked={field.setNull}
                        onChange={(event) => updateField(column.name, { setNull: event.target.checked })}
                      />
                      NULL
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="modal-actions">
            <button onClick={() => setInsertOpen(false)}>Cancel</button>
            <button
              className="primary"
              onClick={() => {
                const values: Record<string, CellValue> = {};
                for (const column of page.columns) {
                  const field = insertFields[column.name];
                  if (!field?.include) continue;
                  values[column.name] = field.setNull ? null : parseInputValue(field.text);
                }
                if (!Object.keys(values).length) {
                  notify('warning', 'Select at least one field');
                  return;
                }
                post({ type: 'insertRow', table: { schema: page.schema, name: page.table, type: 'table' }, values });
                setInsertOpen(false);
              }}
            >
              Insert row
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderCellDialog = () => {
    if (!cellEdit || !page) return null;
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <div className="modal">
          <div className="modal-header">
            <h2>Edit {cellEdit.column.name}</h2>
            <button className="icon-button" onClick={() => setCellEdit(undefined)} aria-label="Close">×</button>
          </div>
          <p className="muted">{cellEdit.column.dataType}{cellEdit.column.nullable ? ' · nullable' : ' · not null'}</p>
          <textarea
            autoFocus
            rows={6}
            value={cellEdit.setNull ? 'NULL' : cellEdit.text}
            disabled={cellEdit.readOnly || cellEdit.setNull}
            onChange={(event) => setCellEdit({ ...cellEdit, text: event.target.value })}
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={cellEdit.setNull}
              disabled={cellEdit.readOnly}
              onChange={(event) => setCellEdit({ ...cellEdit, setNull: event.target.checked })}
            />
            Set SQL NULL
          </label>
          <div className="modal-actions">
            <button onClick={() => setCellEdit(undefined)}>Cancel</button>
            <button
              className="primary"
              disabled={cellEdit.readOnly}
              onClick={() => {
                const value = cellEdit.setNull ? null : parseInputValue(cellEdit.text);
                post({
                  type: 'updateCell',
                  table: { schema: page.schema, name: page.table, type: 'table' },
                  primaryKey: primaryKeyOf(cellEdit.row, page.primaryKey),
                  column: cellEdit.column.name,
                  value,
                });
                setCellEdit(undefined);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    );
  };

  const openInsert = () => {
    if (!page) return;
    const initial: Record<string, { include: boolean; text: string; setNull: boolean }> = {};
    for (const column of page.columns) {
      initial[column.name] = {
        include: !column.autoIncrement && !column.nullable && column.defaultValue === null,
        text: '',
        setNull: false,
      };
    }
    setInsertFields(initial);
    setInsertOpen(true);
  };

  const renderFilterPanel = () => {
    if (!filterOpen) return null;
    return (
      <div className="filter-panel">
        <div className="filter-head">
          <strong>Filters</strong>
          <button
            className="link-button"
            onClick={() => setFilterDrafts([...filterDrafts, { key: Math.random(), column: selectedColumnNames[0] ?? '', operator: '=', value: '' }])}
          >
            + Add condition
          </button>
        </div>
        {!filterDrafts.length && <div className="muted compact">No conditions. Add one to narrow this table.</div>}
        {filterDrafts.map((filter) => {
          const arity = FILTER_OPERATORS.find((item) => item.id === filter.operator)?.arity ?? 1;
          return (
            <div className="filter-row" key={filter.key}>
              <select
                value={filter.column}
                onChange={(event) => setFilterDrafts(filterDrafts.map((item) => item.key === filter.key ? { ...item, column: event.target.value } : item))}
              >
                {selectedColumnNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <select
                value={filter.operator}
                onChange={(event) => setFilterDrafts(filterDrafts.map((item) => item.key === filter.key ? { ...item, operator: event.target.value as FilterOperator, value: '' } : item))}
              >
                {FILTER_OPERATORS.map((operator) => <option key={operator.id} value={operator.id}>{operator.label}</option>)}
              </select>
              {arity > 0 && (
                <input
                  value={filter.value ?? ''}
                  placeholder={filter.operator === 'in' ? 'value1, value2' : 'value'}
                  onChange={(event) => setFilterDrafts(filterDrafts.map((item) => item.key === filter.key ? { ...item, value: event.target.value } : item))}
                />
              )}
              <button
                className="icon-button danger-hover"
                aria-label="Remove filter"
                onClick={() => setFilterDrafts(filterDrafts.filter((item) => item.key !== filter.key))}
              >×</button>
            </div>
          );
        })}
        <div className="filter-actions">
          <button onClick={() => { setFilters([]); setFilterDrafts([]); setFilterOpen(false); setKnownTotal(null); setPageOffset(0); if (selectedTable) loadPage(selectedTable, 0, pageLimit, sort, []); }}>
            Clear all
          </button>
          <button className="primary" onClick={applyFilters}>Apply filters</button>
        </div>
      </div>
    );
  };

  const renderData = () => {
    if (!selectedTable) {
      return (
        <div className="empty-state">
          <div className="empty-icon">▦</div>
          <h2>Pick a table</h2>
          <p>Select a table or view in the sidebar to browse and edit its rows.</p>
          {!isSqlMode && <button className="primary" onClick={() => setTab('query')}>Write a query</button>}
        </div>
      );
    }
    return (
      <div className="data-view">
        <div className="view-toolbar">
          <div className="table-heading">
            <span className="table-icon">{selectedTable.type === 'view' ? '◉' : '▦'}</span>
            <strong>{tableLabel}</strong>
            {selectedTable.type === 'view' && <span className="pill">VIEW</span>}
            {!canEdit && page && <span className="pill warn" title={page.editReason}>{page.editReason ?? 'Read only'}</span>}
          </div>
          <div className="toolbar-actions">
            <button onClick={openFilters} className={filters.length ? 'active' : ''}>Filters{filters.length ? ` (${filters.length})` : ''}</button>
            <button onClick={refresh} title="Refresh">↻</button>
            <button onClick={openInsert} disabled={!canEdit} title={canEdit ? 'Insert row' : 'This table is read-only'}>+ Row</button>
            <button
              onClick={() => {
                if (!page || !selectedRows.size) return;
                const keys = [...selectedRows].map((index) => page.rows[index]).filter((row): row is Row => Boolean(row)).map((row) => primaryKeyOf(row, page.primaryKey));
                post({ type: 'deleteRows', table: { schema: page.schema, name: page.table, type: selectedTable.type }, primaryKeys: keys });
              }}
              disabled={!canEdit || !selectedRows.size}
              className="danger"
            >
              Delete{selectedRows.size ? ` (${selectedRows.size})` : ''}
            </button>
            <select
              className="export-select"
              value=""
              onChange={(event) => {
                if (!page) return;
                post({ type: 'exportTable', table: { schema: page.schema, name: page.table, type: selectedTable.type }, format: event.target.value as ExportFormat });
                event.target.value = '';
              }}
              aria-label="Export table"
            >
              <option value="">Export…</option>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="jsonl">JSON Lines</option>
              <option value="sql">SQL inserts</option>
            </select>
            {selectedTable.type === 'table' && (
              <details className="more-menu">
                <summary aria-label="More actions">⋯</summary>
                <div className="menu">
                  <button onClick={() => post({ type: 'truncateTable', table: { schema: page?.schema, name: selectedTable.name, type: 'table' } })} disabled={!canEdit}>Empty table</button>
                  <button className="danger" onClick={() => post({ type: 'dropTable', table: { schema: page?.schema, name: selectedTable.name, type: 'table' } })} disabled={!canEdit}>Drop table</button>
                </div>
              </details>
            )}
            <button onClick={() => loadTableInQuery(selectedTable)} title="Open table in query editor">SQL</button>
          </div>
        </div>
        {renderFilterPanel()}
        {pageLoading && <div className="thin-progress" />}
        <div className="grid-wrap">
          {!page && pageLoading && <div className="loading-screen"><div className="spinner" />Loading rows…</div>}
          {page && (
            <table className="data-grid">
              <thead>
                <tr>
                  <th className="select-cell"><input type="checkbox" checked={selectedRows.size > 0 && selectedRows.size === page.rows.length} onChange={(event) => setSelectedRows(event.target.checked ? new Set(page.rows.map((_, index) => index)) : new Set())} aria-label="Select all rows" /></th>
                  {page.columns.map((column) => (
                    <th key={column.name}>
                      <button className="column-head" onClick={() => applySort(column.name)} title={`${column.dataType}${column.nullable ? '' : ' · NOT NULL'} — click to sort`}>
                        <span className="col-name">{column.name}</span>
                        {column.primaryKey && <span className="key-mark" title="Primary key">PK</span>}
                        <span className="col-type">{column.dataType}</span>
                        {sort?.column === column.name && <span className="sort-mark">{sort.direction === 'asc' ? '↑' : '↓'}</span>}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className={selectedRows.has(rowIndex) ? 'selected' : ''}>
                    <td className="select-cell"><input type="checkbox" checked={selectedRows.has(rowIndex)} onChange={(event) => {
                      const next = new Set(selectedRows);
                      if (event.target.checked) next.add(rowIndex); else next.delete(rowIndex);
                      setSelectedRows(next);
                    }} aria-label={`Select row ${page.offset + rowIndex + 1}`} /></td>
                    {page.columns.map((column) => {
                      const value = row[column.name] ?? null;
                      const display = cellToDisplay(value);
                      return (
                        <td
                          key={column.name}
                          className={value === null ? 'null-cell' : typeof value === 'object' ? 'object-cell' : ''}
                          onDoubleClick={() => {
                            if (!canEdit) return;
                            const text = value !== null && typeof value === 'object'
                              ? value.$type === 'blob' ? '' : value.value
                              : value === null ? '' : String(value);
                            const blob = value !== null && typeof value === 'object' && value.$type === 'blob';
                            setCellEdit({ row, column, text, setNull: value === null, readOnly: blob || !page.primaryKey.length });
                          }}
                          title={display}
                        >
                          <span>{display}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {!page.rows.length && <tr><td colSpan={page.columns.length + 1} className="no-rows">No rows match this view.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <div className="pager">
          <div className="pager-info">
            {page ? (
              <>
                Rows {page.offset + 1}–{page.offset + page.rows.length}
                {knownTotal !== null ? ` of ${knownTotal.toLocaleString()}` : ''}
                <span className="muted"> · {page.durationMs} ms</span>
              </>
            ) : 'No data loaded'}
          </div>
          <div className="pager-controls">
            <select value={pageLimit} onChange={(event) => changePageLimit(Number(event.target.value))} aria-label="Rows per page">
              {[100, 200, 500, 1000, 2000].map((size) => <option key={size} value={size}>{size} rows</option>)}
            </select>
            <button onClick={() => goToPage(0)} disabled={!page || page.offset === 0}>« First</button>
            <button onClick={() => goToPage(Math.max(0, pageOffset - pageLimit))} disabled={!page || pageOffset === 0}>‹ Prev</button>
            {totalPages && <span className="page-number">Page {Math.floor(pageOffset / pageLimit) + 1} / {totalPages}</span>}
            <button onClick={() => goToPage(pageOffset + pageLimit)} disabled={!page || (knownTotal !== null ? pageOffset + page.rows.length >= knownTotal : page.rows.length < pageLimit)}>Next ›</button>
            <button onClick={() => knownTotal !== null && goToPage(Math.max(0, (totalPages! - 1) * pageLimit))} disabled={!page || knownTotal === null || totalPages === 1}>Last »</button>
          </div>
        </div>
        {renderInsertDialog()}
        {renderCellDialog()}
      </div>
    );
  };

  const renderStructure = () => {
    if (!selectedTable) return <div className="empty-state"><h2>No table selected</h2></div>;
    if (structureLoading && !structure) return <div className="loading-screen"><div className="spinner" />Loading schema…</div>;
    if (!structure) {
      return <div className="empty-state"><p>Load the schema for {tableLabel}.</p><button onClick={() => loadStructure(selectedTable)}>Load structure</button></div>;
    }
    return (
      <div className="structure-view">
        <div className="view-toolbar">
          <div className="table-heading"><strong>Structure</strong><span className="muted">{structure.columns.length} columns · {structure.indexes.length} indexes</span></div>
          <div className="toolbar-actions">
            <button onClick={() => loadStructure(selectedTable, false)}>↻ Refresh</button>
            {structure.ddl && <button onClick={() => post({ type: 'copyText', text: structure.ddl! })}>Copy DDL</button>}
          </div>
        </div>
        {structureLoading && <div className="thin-progress" />}
        <div className="structure-scroll">
          <section>
            <h3>Columns</h3>
            <table className="meta-grid">
              <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>Primary key</th></tr></thead>
              <tbody>
                {structure.columns.map((column) => (
                  <tr key={column.name}>
                    <td><strong>{column.name}</strong>{column.autoIncrement && <span className="pill">auto</span>}</td>
                    <td><code>{column.dataType}</code></td>
                    <td>{column.nullable ? 'yes' : <strong>NO</strong>}</td>
                    <td>{column.defaultValue ?? <span className="muted">—</span>}</td>
                    <td>{column.primaryKey ? '✓' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {structure.indexes.length > 0 && <section>
            <h3>Indexes</h3>
            <table className="meta-grid">
              <thead><tr><th>Name</th><th>Columns</th><th>Unique</th><th>Primary</th></tr></thead>
              <tbody>{structure.indexes.map((index) => (
                <tr key={index.name}><td>{index.name}</td><td>{index.columns.join(', ')}</td><td>{index.unique ? '✓' : ''}</td><td>{index.primary ? '✓' : ''}</td></tr>
              ))}</tbody>
            </table>
          </section>}
          {structure.foreignKeys.length > 0 && <section>
            <h3>Foreign keys</h3>
            <table className="meta-grid">
              <thead><tr><th>Name</th><th>Columns</th><th>References</th><th>On delete</th></tr></thead>
              <tbody>{structure.foreignKeys.map((foreignKey) => (
                <tr key={foreignKey.name}>
                  <td>{foreignKey.name}</td>
                  <td>{foreignKey.columns.join(', ')}</td>
                  <td>{foreignKey.referencedSchema ? `${foreignKey.referencedSchema}.` : ''}{foreignKey.referencedTable}({foreignKey.referencedColumns.join(', ')})</td>
                  <td>{foreignKey.onDelete ?? ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>}
          {structure.ddl && <section>
            <h3>DDL</h3>
            <pre className="ddl-block">{structure.ddl}</pre>
          </section>}
        </div>
      </div>
    );
  };

  const renderResult = () => {
    if (queryBusy) return <div className="result-placeholder"><div className="spinner" />Running query…</div>;
    if (queryError) return <div className="query-error"><strong>Query failed</strong><pre>{queryError}</pre></div>;
    if (!queryResult) return <div className="result-placeholder">Results will appear here. Press Ctrl/Cmd+Enter to run the current statement.</div>;
    if (queryResult.command) return <div className="result-placeholder success-text">✓ {queryResult.message ?? 'Query completed'} <span className="muted">({queryResult.durationMs} ms)</span></div>;
    return (
      <div className="result-view">
        <div className="result-toolbar">
          <span>{queryResult.rowCount.toLocaleString()} row{queryResult.rowCount === 1 ? '' : 's'}{queryResult.truncated ? ' (truncated)' : ''} · {queryResult.durationMs} ms</span>
          <div className="toolbar-actions">
            {lastQuery && (
              <select className="export-select" value="" aria-label="Export query result" onChange={(event) => {
                post({ type: 'exportQuery', sql: lastQuery.sql, format: event.target.value as ExportFormat });
                event.target.value = '';
              }}>
                <option value="">Export…</option>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="jsonl">JSON Lines</option>
                <option value="sql">SQL inserts</option>
              </select>
            )}
          </div>
        </div>
        <div className="grid-wrap result-grid">
          <table className="data-grid">
            <thead><tr>{queryResult.columns.map((column) => <th key={column.name}><span className="col-name">{column.name}</span></th>)}</tr></thead>
            <tbody>
              {queryResult.rows.map((row, index) => (
                <tr key={index}>
                  {queryResult.columns.map((column) => {
                    const value = row[column.name] ?? null;
                    return <td key={column.name} className={value === null ? 'null-cell' : ''} title={cellToDisplay(value)} onDoubleClick={() => post({ type: 'copyText', text: formatValueForExport(value) })}><span>{cellToDisplay(value)}</span></td>;
                  })}
                </tr>
              ))}
              {!queryResult.rows.length && <tr><td className="no-rows" colSpan={queryResult.columns.length}>Query returned no rows.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderQuery = () => (
    <div className="query-view">
      <div className="query-toolbar">
        {isSqlMode ? (
          <>
            <span className="file-label" title={displayUrl}>{init.fileName}{dirty ? ' ●' : ''}</span>
            <button className="primary" onClick={saveSql} disabled={!dirty}>Save</button>
            {activeSummary ? <span className="connection-chip" title={`${activeSummary.type} · ${activeSummary.host ?? ''}`}>{activeSummary.name}</span> : <span className="pill warn">No connection</span>}
          </>
        ) : (
          <span className="muted">{activeSummary?.name ?? 'Connected database'}</span>
        )}
        <div className="spacer" />
        <button onClick={() => { const sql = sqlEditorRef.current?.getSelectionOrCurrent(); if (sql) executeQuery(sql); }} disabled={queryBusy || !activeSummary}>▶ Run</button>
        <button onClick={() => { const sql = sqlEditorRef.current?.getAll(); if (sql) executeQuery(sql); }} disabled={queryBusy || !activeSummary} title="Run the entire editor">Run all</button>
        <button onClick={() => post({ type: 'openQueryFile', sql: sqlEditorRef.current?.getAll() })} title="Save the query as a .sql file">Save as…</button>
      </div>
      <div className="editor-pane">
        <SqlCodeEditor
          ref={sqlEditorRef}
          value={querySql}
          onChange={(value) => {
            if (isSqlMode) handleSqlChange(value);
            else setQuerySql(value);
          }}
          onRun={executeQuery}
          onSave={isSqlMode ? saveSql : undefined}
          placeholder="SQL query"
        />
      </div>
      {renderResult()}
    </div>
  );

  const renderHistory = () => (
    <div className="history-view">
      <div className="view-toolbar">
        <strong>Query history</strong>
        <div className="toolbar-actions">
          <button onClick={() => post({ type: 'clearHistory' })} disabled={!history.length}>Clear history</button>
        </div>
      </div>
      {!history.length && <div className="empty-state"><p>Queries you run will appear here.</p></div>}
      <div className="history-list">
        {history.map((entry) => (
          <div className="history-entry" key={entry.id}>
            <div className="history-status">{entry.success ? '✓' : '✕'}</div>
            <div className="history-body">
              <pre>{entry.sql}</pre>
              <div className="muted compact">{entry.connectionName} · {entry.rowCount} rows · {entry.durationMs} ms · {new Date(entry.createdAt).toLocaleString()}</div>
              {entry.error && <div className="error-text">{entry.error}</div>}
            </div>
            <div className="history-actions">
              <button onClick={() => { setQuerySql(entry.sql); setTab('query'); }}>Load</button>
              <button className="primary" onClick={() => { setQuerySql(entry.sql); setTab('query'); window.setTimeout(() => executeQuery(entry.sql), 50); }}>Run</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderSidebar = () => {
    const normalized = catalogFilter.trim().toLowerCase();
    const filtered = catalog.map((schema) => ({
      ...schema,
      tables: schema.tables.filter((table) => !normalized || table.name.toLowerCase().includes(normalized) || schema.name.toLowerCase().includes(normalized)),
    })).filter((schema) => !normalized || schema.tables.length || schema.name.toLowerCase().includes(normalized));

    return (
      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        <div className="sidebar-heading">
          <span>Explorer</span>
          <div className="sidebar-actions">
            <button onClick={refreshCatalog} title="Refresh schema" disabled={catalogLoading}>↻</button>
            <button onClick={() => setSidebarOpen(false)} title="Hide sidebar">‹</button>
          </div>
        </div>
        <input className="sidebar-search" value={catalogFilter} onChange={(event) => setCatalogFilter(event.target.value)} placeholder="Filter tables…" aria-label="Filter tables" />
        {isSqlMode && (
          <div className="connection-select-block">
            <label htmlFor="connection-select">Connection</label>
            <select
              id="connection-select"
              value={activeConnectionId ?? ''}
              onChange={(event) => {
                const id = event.target.value || undefined;
                setActiveConnectionId(id);
                setCatalog([]);
                setCatalogLoading(Boolean(id));
                setSelectedTable(undefined);
                setPage(undefined);
                setStructure(undefined);
                post({ type: 'selectConnection', connectionId: id });
              }}
            >
              <option value="">Select a connection…</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>{connection.name} ({connection.type})</option>
              ))}
            </select>
            <div className="connection-buttons">
              <button onClick={() => post({ type: 'addConnection' })}>+ Add</button>
              <button onClick={() => post({ type: 'openSqliteFile' })}>Open SQLite</button>
            </div>
          </div>
        )}
        {isSqlMode && !connections.length && (
          <div className="sidebar-empty">
            <p>No saved connections yet.</p>
            <button className="primary" onClick={() => post({ type: 'addConnection' })}>Add connection</button>
          </div>
        )}
        {!isSqlMode && <div className="sidebar-file" title={displayUrl}>{init.fileName ?? 'SQLite database'}</div>}
        <div className="catalog">
          {catalogLoading && <div className="catalog-loading"><div className="spinner small" />Loading schema…</div>}
          {!catalog.length && !catalogLoading && activeSummary && <div className="catalog-empty">No tables or views.</div>}
          {filtered.map((schema) => {
            const expanded = expandedSchemas.has(schema.name);
            return (
              <div className="schema" key={schema.name}>
                <button className="schema-title" onClick={() => {
                  const next = new Set(expandedSchemas);
                  if (next.has(schema.name)) next.delete(schema.name); else next.add(schema.name);
                  setExpandedSchemas(next);
                }}>
                  <span className="chevron">{expanded ? '▾' : '▸'}</span>
                  <span>{schema.name}</span>
                  <span className="count">{schema.tables.length}</span>
                </button>
                {expanded && schema.tables.map((table) => (
                  <button
                    key={`${table.schema ?? ''}:${table.name}`}
                    className={`table-item ${selectedTable?.name === table.name && selectedTable?.schema === table.schema ? 'active' : ''}`}
                    onClick={() => chooseTable({ ...table, schema: table.schema ?? schema.name })}
                    title={`${schema.name}.${table.name}`}
                  >
                    <span className="object-icon">{table.type === 'view' ? '◉' : '▦'}</span>
                    <span className="table-name">{table.name}</span>
                    {table.type === 'view' && <span className="view-mark">V</span>}
                  </button>
                ))}
              </div>
            );
          })}
          {isSqlMode && activeSummary && !catalog.length && !catalogLoading && <div className="catalog-empty">Schema is empty.</div>}
        </div>
        <div className="sidebar-footer">
          <button onClick={() => post({ type: 'openDocs' })}>Docs</button>
          <button onClick={() => post({ type: 'openQueryFile' })}>New SQL file</button>
        </div>
      </aside>
    );
  };

  const tabButton = (id: Tab, label: string, disabled = false) => (
    <button className={`tab ${tab === id ? 'active' : ''}`} onClick={() => {
      if (id === 'structure' && selectedTable && !structure) loadStructure(selectedTable);
      setTab(id);
    }} disabled={disabled}>{label}</button>
  );

  return (
    <div className="app">
      <header className="titlebar">
        <button className={`icon-button sidebar-toggle ${sidebarOpen ? 'active' : ''}`} onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle explorer">☰</button>
        <div className="brand"><span className="brand-mark">DBV</span><span className="brand-sub">{isSqlMode ? 'SQL Workbench' : 'Database Explorer'}</span></div>
        <div className="titlebar-connection">
          {activeSummary ? <><span className={`status-dot ${activeSummary.connected ? 'online' : ''}`} /><span>{activeSummary.name}</span><span className="muted">{activeSummary.type}{activeSummary.host ? ` · ${activeSummary.host}${activeSummary.port ? `:${activeSummary.port}` : ''}` : ''}</span></> : <span className="muted">No active connection</span>}
        </div>
        <div className="spacer" />
        {!isSqlMode && <button onClick={() => setTab('query')}>New query</button>}
        <button onClick={() => post({ type: 'addConnection' })}>+ Connection</button>
        <button onClick={() => post({ type: 'openSqliteFile' })}>Open file</button>
        <button onClick={() => post({ type: 'openDocs' })} title="Documentation">?</button>
      </header>
      <div className="main">
        {renderSidebar()}
        {!sidebarOpen && <button className="sidebar-reopen" onClick={() => setSidebarOpen(true)} title="Show explorer">›</button>}
        <main className="workspace">
          <div className="tabs">
            {tabButton('data', 'Data', isSqlMode || !selectedTable)}
            {tabButton('structure', 'Structure', isSqlMode || !selectedTable)}
            {tabButton('query', 'Query')}
            {tabButton('history', 'History')}
            <div className="spacer" />
            {!isSqlMode && selectedTable && <span className="table-context">{tableLabel}</span>}
          </div>
          <div className="workspace-content">
            {tab === 'data' && !isSqlMode && renderData()}
            {tab === 'structure' && !isSqlMode && renderStructure()}
            {tab === 'query' && renderQuery()}
            {tab === 'history' && renderHistory()}
            {tab === 'data' && isSqlMode && renderData()}
            {tab === 'structure' && isSqlMode && renderStructure()}
          </div>
        </main>
      </div>
      <div className="statusbar">
        <span>{activeSummary ? `${activeSummary.type}` : 'DBV'}</span>
        {selectedTable && <span>{tableLabel}</span>}
        {isSqlMode && <span>{dirty ? 'Unsaved changes' : 'Saved'}</span>}
        <div className="spacer" />
        <span>DBV · open source</span>
      </div>
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => <div key={toast.id} className={`toast ${toast.kind}`}>{toast.message}</div>)}
      </div>
    </div>
  );
}

declare function acquireVsCodeApi<T>(): {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
};
