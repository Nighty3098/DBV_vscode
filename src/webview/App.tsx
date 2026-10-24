import React, { useCallback, useEffect, useRef, useState } from "react";
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
} from "../shared/types";
import { FILTER_OPERATORS } from "../core/queryBuilder";
import { primaryKeyOf, parseInputValue } from "../core/mutations";
import { cellToDisplay, formatValueForExport } from "../core/serialization";
import { SqlCodeEditor, type SqlEditorHandle } from "./SqlCodeEditor";
import { Icon, type IconName } from "./Icon";

const vscode = acquireVsCodeApi<{ mode?: string }>();

const TOAST_ICONS: Record<string, IconName> = {
  success: "check",
  warning: "alert-triangle",
  error: "alert-circle",
  info: "info",
};

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

type Tab = "data" | "structure" | "query" | "history";

interface InitData {
  mode: "database" | "sql";
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
  const [catalogFilter, setCatalogFilter] = useState("");
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(
    new Set(),
  );
  const [selectedTable, setSelectedTable] = useState<TableRef>();
  const [tab, setTab] = useState<Tab>("query");
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
  const [insertFields, setInsertFields] = useState<
    Record<string, { include: boolean; text: string; setNull: boolean }>
  >({});
  const [querySql, setQuerySql] = useState(
    "-- Write SQL and press Ctrl/Cmd+Enter\nSELECT 1;\n",
  );
  const [sqlDocument, setSqlDocument] = useState("");
  const [dirty, setDirty] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryResult>();
  const [queryError, setQueryError] = useState<string>();
  const [queryBusy, setQueryBusy] = useState(false);
  const [lastQuery, setLastQuery] = useState<{ sql: string }>();
  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
  const [toasts, setToasts] = useState<
    Array<{ id: number; kind: string; message: string }>
  >([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const sqlEditorRef = useRef<SqlEditorHandle>(null);
  const pageRequest = useRef("");
  const queryRequest = useRef("");
  const structureRequest = useRef("");
  const requestCounter = useRef(0);
  const initOnce = useRef(false);
  const pendingInitial = useRef<TableRef | undefined>(undefined);
  const selectedTableRef = useRef<TableRef | undefined>(undefined);
  const pageOffsetRef = useRef(0);
  const pageLimitRef = useRef(200);
  const sortRef = useRef<SortSpec | undefined>(undefined);
  const filtersRef = useRef<FilterCondition[]>([]);
  const modeRef = useRef<"database" | "sql">("database");
  const sqlDocumentRef = useRef("");

  useEffect(() => {
    sqlDocumentRef.current = sqlDocument;
  }, [sqlDocument]);
  useEffect(() => {
    selectedTableRef.current = selectedTable;
  }, [selectedTable]);
  useEffect(() => {
    pageOffsetRef.current = pageOffset;
  }, [pageOffset]);
  useEffect(() => {
    pageLimitRef.current = pageLimit;
  }, [pageLimit]);
  useEffect(() => {
    sortRef.current = sort;
  }, [sort]);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const notify = useCallback((kind: string, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, kind, message }]);
    window.setTimeout(
      () => setToasts((items) => items.filter((item) => item.id !== id)),
      4500,
    );
  }, []);

  const loadPage = useCallback(
    (
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
        type: "loadTablePage",
        requestId,
        table,
        offset,
        limit,
        sort: nextSort,
        filters: nextFilters,
      });
    },
    [],
  );

  const loadStructure = useCallback((table: TableRef, show = true) => {
    const requestId = `structure:${++requestCounter.current}`;
    structureRequest.current = requestId;
    setStructureLoading(true);
    if (show) setTab("structure");
    post({ type: "loadStructure", requestId, table });
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "init": {
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
          if (message.mode === "sql") {
            setSqlDocument(message.sqlText ?? "");
            setQuerySql(message.sqlText ?? "");
            setDirty(Boolean(message.dirty));
            setTab("query");
          } else if (message.initialTable) {
            setSelectedTable(message.initialTable);
            pendingInitial.current = message.initialTable;
            setTab("data");
            setQuerySql(
              "-- Write SQL and press Ctrl/Cmd+Enter\nSELECT * FROM " +
                message.initialTable.name +
                " LIMIT 100;\n",
            );
          } else {
            setTab("query");
          }
          break;
        }
        case "connections":
          setConnections(message.connections);
          setActiveConnectionId(message.activeConnectionId);
          break;
        case "catalog":
          setCatalog(message.schemas);
          setCatalogLoading(false);
          setExpandedSchemas((current) => {
            if (current.size) return current;
            return new Set(message.schemas.map((schema) => schema.name));
          });
          break;
        case "tablePage":
          if (message.requestId !== pageRequest.current) break;
          setPage(message.page);
          setPageLoading(false);
          setPageOffset(message.page.offset);
          setPageLimit(message.page.limit);
          setSelectedRows(new Set());
          setSelectedTable({
            schema: message.page.schema,
            name: message.page.table,
            type: selectedTableRef.current?.type ?? "table",
          });
          if (message.page.total !== null) setKnownTotal(message.page.total);
          break;
        case "structure":
          if (message.requestId !== structureRequest.current) break;
          setStructure(message.structure);
          setStructureLoading(false);
          break;
        case "queryResult":
          if (message.requestId !== queryRequest.current) break;
          setQueryResult(message.result);
          setQueryError(undefined);
          setQueryBusy(false);
          break;
        case "queryError":
          if (message.requestId !== queryRequest.current) break;
          setQueryError(message.message);
          setQueryResult(undefined);
          setQueryBusy(false);
          notify("error", message.message);
          break;
        case "requestError":
          if (message.requestId === pageRequest.current) {
            setPageLoading(false);
            notify("error", message.message);
          } else if (message.requestId === structureRequest.current) {
            setStructureLoading(false);
            notify("error", message.message);
          } else if (message.requestId === queryRequest.current) {
            setQueryBusy(false);
            setQueryError(message.message);
          } else {
            notify("error", message.message);
          }
          break;
        case "operationDone":
          if (message.success) {
            notify("success", message.message);
            const table = selectedTableRef.current;
            if (table) {
              loadPage(
                table,
                pageOffsetRef.current,
                pageLimitRef.current,
                sortRef.current,
                filtersRef.current,
              );
              if (tab === "structure") loadStructure(table, false);
            }
            if (
              message.operation === "drop" ||
              message.operation === "truncate"
            ) {
              setCatalogLoading(true);
              post({ type: "refreshCatalog" });
            }
          }
          break;
        case "busy":
          if (message.requestId === queryRequest.current)
            setQueryBusy(message.busy);
          break;
        case "documentChanged":
          setSqlDocument(message.text);
          setQuerySql(message.text);
          setDirty(message.dirty);
          break;
        case "saved":
          setDirty(false);
          notify("success", "SQL file saved");
          break;
        case "history":
          setHistory(message.entries);
          break;
        case "toast":
          notify(message.kind, message.message);
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", handler);
    if (!initOnce.current) {
      initOnce.current = true;
      post({ type: "ready" });
    }
    return () => window.removeEventListener("message", handler);
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
      loadPage(
        selectedTable,
        0,
        pageLimitRef.current,
        sortRef.current,
        filtersRef.current,
      );
    }
  }, [selectedTable, init, page, pageLoading, loadPage]);

  const chooseTable = (table: TableRef) => {
    const changing =
      selectedTable?.schema !== table.schema ||
      selectedTable?.name !== table.name;
    setSelectedTable(table);
    setTab("data");
    setPage(undefined);
    setKnownTotal(null);
    if (changing) {
      setSort(undefined);
      setFilters([]);
      setFilterDrafts([]);
      setStructure(undefined);
    }
    setPageOffset(0);
    loadPage(
      table,
      0,
      pageLimitRef.current,
      changing ? undefined : sort,
      changing ? [] : filters,
    );
  };

  const refresh = () => {
    if (!selectedTable) return;
    loadPage(selectedTable, pageOffset, pageLimit, sort, filters);
    if (tab === "structure") loadStructure(selectedTable, false);
  };

  const refreshCatalog = () => {
    setCatalogLoading(true);
    post({ type: "refreshCatalog" });
  };

  const applySort = (column: string) => {
    if (!selectedTable) return;
    const next =
      sort?.column !== column
        ? { column, direction: "asc" as const }
        : sort.direction === "asc"
          ? { column, direction: "desc" as const }
          : undefined;
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
      setFilterDrafts(
        filters.map((filter) => ({ ...filter, key: Math.random() })),
      );
    }
    setFilterOpen((value) => !value);
  };

  const applyFilters = () => {
    const cleaned: FilterCondition[] = [];
    for (const filter of filterDrafts) {
      const operator = FILTER_OPERATORS.find(
        (item) => item.id === filter.operator,
      );
      if (!filter.column) {
        notify("warning", "Choose a column for every filter");
        return;
      }
      if (operator?.arity === 1 && filter.operator !== "in" && !filter.value) {
        notify("warning", "A filter value is required");
        return;
      }
      if (filter.operator === "in" && !filter.value?.trim()) {
        notify(
          "warning",
          "An IN filter needs at least one comma-separated value",
        );
        return;
      }
      cleaned.push({
        column: filter.column,
        operator: filter.operator,
        value: filter.value,
        values:
          filter.operator === "in"
            ? filter.value
                ?.split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : undefined,
      });
    }
    setFilters(cleaned);
    setKnownTotal(null);
    setPageOffset(0);
    if (selectedTable) loadPage(selectedTable, 0, pageLimit, sort, cleaned);
    setFilterOpen(false);
  };

  const activeSummary = connections.find(
    (connection) => connection.id === activeConnectionId,
  );

  const executeQuery = (sql: string) => {
    if (!sql.trim()) {
      notify("warning", "The query is empty");
      return;
    }
    const requestId = `query:${++requestCounter.current}`;
    queryRequest.current = requestId;
    setQueryBusy(true);
    setQueryError(undefined);
    setQueryResult(undefined);
    setLastQuery({ sql });
    post({
      type: "runQuery",
      requestId,
      sql,
      connectionId: modeRef.current === "sql" ? activeConnectionId : undefined,
      maxRows: init?.maxResultRows,
    });
  };

  const handleSqlChange = (value: string) => {
    setQuerySql(value);
    if (modeRef.current !== "sql") return;
    setSqlDocument(value);
    setDirty(true);
    // Sync every edit so closing the editor immediately cannot lose changes.
    post({ type: "updateText", text: value });
  };

  const saveSql = () => {
    if (modeRef.current !== "sql") return;
    post({ type: "updateText", text: sqlDocument });
    post({ type: "saveDocument" });
  };

  const loadTableInQuery = (table: TableRef) => {
    const name = table.schema ? `${table.schema}.${table.name}` : table.name;
    setQuerySql(`SELECT *\nFROM ${name}\nLIMIT 100;\n`);
    setTab("query");
  };

  const selectedColumnNames = page?.columns.map((column) => column.name) ?? [];

  if (!init) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        Loading DBV…
      </div>
    );
  }

  if (init.fatalError) {
    return (
      <div className="fatal-screen">
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="alert-triangle" size={30} />
          </div>
          <h2>Could not open database</h2>
          <p className="error-text">{init.fatalError}</p>
          <p className="muted">
            The file may be corrupt, locked by another process, or not a SQLite
            database. Use “Reopen DBV Editor as Text” from the editor title menu
            to inspect it as text.
          </p>
        </div>
      </div>
    );
  }

  const isSqlMode = init.mode === "sql";
  const canEdit = page?.editable ?? false;
  const displayUrl = init.documentUri;
  const tableLabel = selectedTable
    ? selectedTable.schema
      ? `${selectedTable.schema}.${selectedTable.name}`
      : selectedTable.name
    : undefined;
  const totalPages =
    knownTotal !== null ? Math.max(1, Math.ceil(knownTotal / pageLimit)) : null;

  const renderInsertDialog = () => {
    if (!insertOpen || !page) return null;
    const updateField = (
      name: string,
      patch: Partial<{ include: boolean; text: string; setNull: boolean }>,
    ) => {
      setInsertFields((current) => ({
        ...current,
        [name]: { ...current[name]!, ...patch },
      }));
    };
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <div className="modal wide">
          <div className="modal-header">
            <h2>Insert row</h2>
            <button
              className="icon-button"
              onClick={() => setInsertOpen(false)}
              aria-label="Close"
            >
              <Icon name="x" />
            </button>
          </div>
          <p className="muted">
            Tick a field to include it. Unticked fields use their database
            default. Type NULL or tick “Set NULL”.
          </p>
          <div className="insert-grid">
            {page.columns.map((column) => {
              const field = insertFields[column.name] ?? {
                include: false,
                text: "",
                setNull: false,
              };
              return (
                <div className="insert-field" key={column.name}>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={field.include}
                      onChange={(event) =>
                        updateField(column.name, {
                          include: event.target.checked,
                        })
                      }
                    />
                    <span>{column.name}</span>
                    <span className="type-badge">{column.dataType}</span>
                  </label>
                  <div className="field-row">
                    <input
                      value={field.text}
                      disabled={!field.include || field.setNull}
                      placeholder={
                        column.defaultValue
                          ? `default: ${column.defaultValue}`
                          : "value"
                      }
                      onChange={(event) =>
                        updateField(column.name, { text: event.target.value })
                      }
                    />
                    <label className="null-check" title="Set SQL NULL">
                      <input
                        type="checkbox"
                        disabled={!field.include}
                        checked={field.setNull}
                        onChange={(event) =>
                          updateField(column.name, {
                            setNull: event.target.checked,
                          })
                        }
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
                  values[column.name] = field.setNull
                    ? null
                    : parseInputValue(field.text);
                }
                if (!Object.keys(values).length) {
                  notify("warning", "Select at least one field");
                  return;
                }
                post({
                  type: "insertRow",
                  table: {
                    schema: page.schema,
                    name: page.table,
                    type: "table",
                  },
                  values,
                });
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
            <button
              className="icon-button"
              onClick={() => setCellEdit(undefined)}
              aria-label="Close"
            >
              <Icon name="x" />
            </button>
          </div>
          <p className="muted">
            {cellEdit.column.dataType}
            {cellEdit.column.nullable ? " · nullable" : " · not null"}
          </p>
          <textarea
            autoFocus
            rows={6}
            value={cellEdit.setNull ? "NULL" : cellEdit.text}
            disabled={cellEdit.readOnly || cellEdit.setNull}
            onChange={(event) =>
              setCellEdit({ ...cellEdit, text: event.target.value })
            }
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={cellEdit.setNull}
              disabled={cellEdit.readOnly}
              onChange={(event) =>
                setCellEdit({ ...cellEdit, setNull: event.target.checked })
              }
            />
            Set SQL NULL
          </label>
          <div className="modal-actions">
            <button onClick={() => setCellEdit(undefined)}>Cancel</button>
            <button
              className="primary"
              disabled={cellEdit.readOnly}
              onClick={() => {
                const value = cellEdit.setNull
                  ? null
                  : parseInputValue(cellEdit.text);
                post({
                  type: "updateCell",
                  table: {
                    schema: page.schema,
                    name: page.table,
                    type: "table",
                  },
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
    const initial: Record<
      string,
      { include: boolean; text: string; setNull: boolean }
    > = {};
    for (const column of page.columns) {
      initial[column.name] = {
        include:
          !column.autoIncrement &&
          !column.nullable &&
          column.defaultValue === null,
        text: "",
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
            onClick={() =>
              setFilterDrafts([
                ...filterDrafts,
                {
                  key: Math.random(),
                  column: selectedColumnNames[0] ?? "",
                  operator: "=",
                  value: "",
                },
              ])
            }
          >
            <Icon name="plus" size={13} /> Add condition
          </button>
        </div>
        {!filterDrafts.length && (
          <div className="muted compact">
            No conditions. Add one to narrow this table.
          </div>
        )}
        {filterDrafts.map((filter) => {
          const arity =
            FILTER_OPERATORS.find((item) => item.id === filter.operator)
              ?.arity ?? 1;
          return (
            <div className="filter-row" key={filter.key}>
              <select
                value={filter.column}
                onChange={(event) =>
                  setFilterDrafts(
                    filterDrafts.map((item) =>
                      item.key === filter.key
                        ? { ...item, column: event.target.value }
                        : item,
                    ),
                  )
                }
              >
                {selectedColumnNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                value={filter.operator}
                onChange={(event) =>
                  setFilterDrafts(
                    filterDrafts.map((item) =>
                      item.key === filter.key
                        ? {
                            ...item,
                            operator: event.target.value as FilterOperator,
                            value: "",
                          }
                        : item,
                    ),
                  )
                }
              >
                {FILTER_OPERATORS.map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.label}
                  </option>
                ))}
              </select>
              {arity > 0 && (
                <input
                  value={filter.value ?? ""}
                  placeholder={
                    filter.operator === "in" ? "value1, value2" : "value"
                  }
                  onChange={(event) =>
                    setFilterDrafts(
                      filterDrafts.map((item) =>
                        item.key === filter.key
                          ? { ...item, value: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              )}
              <button
                className="icon-button danger-hover"
                aria-label="Remove filter"
                onClick={() =>
                  setFilterDrafts(
                    filterDrafts.filter((item) => item.key !== filter.key),
                  )
                }
              >
                <Icon name="x" />
              </button>
            </div>
          );
        })}
        <div className="filter-actions">
          <button
            onClick={() => {
              setFilters([]);
              setFilterDrafts([]);
              setFilterOpen(false);
              setKnownTotal(null);
              setPageOffset(0);
              if (selectedTable)
                loadPage(selectedTable, 0, pageLimit, sort, []);
            }}
          >
            Clear all
          </button>
          <button className="primary" onClick={applyFilters}>
            Apply filters
          </button>
        </div>
      </div>
    );
  };

  const renderData = () => {
    if (!selectedTable) {
      return (
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="table" size={30} />
          </div>
          <h2>Pick a table</h2>
          <p>
            Select a table or view in the sidebar to browse and edit its rows.
          </p>
          {!isSqlMode && (
            <button className="primary" onClick={() => setTab("query")}>
              Write a query
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="data-view">
        <div className="view-toolbar">
          <div className="table-heading">
            <span className="table-icon">
              <Icon name={selectedTable.type === "view" ? "eye" : "table"} />
            </span>
            <strong>{tableLabel}</strong>
            {selectedTable.type === "view" && (
              <span className="pill">VIEW</span>
            )}
            {!canEdit && page && (
              <span className="pill warn" title={page.editReason}>
                {page.editReason ?? "Read only"}
              </span>
            )}
          </div>
          <div className="toolbar-actions">
            <button
              onClick={openFilters}
              className={filters.length ? "active" : ""}
            >
              <Icon name="filter" /> Filters
              {filters.length ? ` (${filters.length})` : ""}
            </button>
            <button
              className="icon-button"
              onClick={refresh}
              title="Refresh"
              aria-label="Refresh"
            >
              <Icon name="refresh" />
            </button>
            <button
              onClick={openInsert}
              disabled={!canEdit}
              title={canEdit ? "Insert row" : "This table is read-only"}
            >
              <Icon name="plus" /> Row
            </button>
            <button
              onClick={() => {
                if (!page || !selectedRows.size) return;
                const keys = [...selectedRows]
                  .map((index) => page.rows[index])
                  .filter((row): row is Row => Boolean(row))
                  .map((row) => primaryKeyOf(row, page.primaryKey));
                post({
                  type: "deleteRows",
                  table: {
                    schema: page.schema,
                    name: page.table,
                    type: selectedTable.type,
                  },
                  primaryKeys: keys,
                });
              }}
              disabled={!canEdit || !selectedRows.size}
              className="danger"
            >
              <Icon name="trash" /> Delete
              {selectedRows.size ? ` (${selectedRows.size})` : ""}
            </button>
            <label className="toolbar-select" title="Export table">
              <Icon name="download" size={12} />
              <select
                className="export-select"
                value=""
                onChange={(event) => {
                  if (!page) return;
                  post({
                    type: "exportTable",
                    table: {
                      schema: page.schema,
                      name: page.table,
                      type: selectedTable.type,
                    },
                    format: event.target.value as ExportFormat,
                  });
                  event.target.value = "";
                }}
                aria-label="Export table"
              >
                <option value="">Export…</option>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="jsonl">JSON Lines</option>
                <option value="sql">SQL inserts</option>
              </select>
            </label>
            {selectedTable.type === "table" && (
              <details className="more-menu">
                <summary aria-label="More actions">
                  <Icon name="more" />
                </summary>
                <div className="menu">
                  <button
                    onClick={() =>
                      post({
                        type: "truncateTable",
                        table: {
                          schema: page?.schema,
                          name: selectedTable.name,
                          type: "table",
                        },
                      })
                    }
                    disabled={!canEdit}
                  >
                    Empty table
                  </button>
                  <button
                    className="danger"
                    onClick={() =>
                      post({
                        type: "dropTable",
                        table: {
                          schema: page?.schema,
                          name: selectedTable.name,
                          type: "table",
                        },
                      })
                    }
                    disabled={!canEdit}
                  >
                    Drop table
                  </button>
                </div>
              </details>
            )}
            <button
              onClick={() => loadTableInQuery(selectedTable)}
              title="Open table in query editor"
            >
              <Icon name="code" /> SQL
            </button>
          </div>
        </div>
        {renderFilterPanel()}
        {pageLoading && <div className="thin-progress" />}
        <div className="grid-wrap">
          {!page && pageLoading && (
            <div className="loading-screen">
              <div className="spinner" />
              Loading rows…
            </div>
          )}
          {page && (
            <table className="data-grid">
              <thead>
                <tr>
                  <th className="select-cell">
                    <input
                      type="checkbox"
                      checked={
                        selectedRows.size > 0 &&
                        selectedRows.size === page.rows.length
                      }
                      onChange={(event) =>
                        setSelectedRows(
                          event.target.checked
                            ? new Set(page.rows.map((_, index) => index))
                            : new Set(),
                        )
                      }
                      aria-label="Select all rows"
                    />
                  </th>
                  {page.columns.map((column) => (
                    <th key={column.name}>
                      <button
                        className="column-head"
                        onClick={() => applySort(column.name)}
                        title={`${column.dataType}${column.nullable ? "" : " · NOT NULL"} — click to sort`}
                      >
                        <span className="col-name">{column.name}</span>
                        {column.primaryKey && (
                          <span className="key-mark" title="Primary key">
                            PK
                          </span>
                        )}
                        <span className="col-type">{column.dataType}</span>
                        {sort?.column === column.name && (
                          <span className="sort-mark">
                            <Icon
                              name={
                                sort.direction === "asc"
                                  ? "arrow-up"
                                  : "arrow-down"
                              }
                              size={12}
                            />
                          </span>
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row, rowIndex) => (
                  <tr
                    key={rowIndex}
                    className={selectedRows.has(rowIndex) ? "selected" : ""}
                  >
                    <td className="select-cell">
                      <input
                        type="checkbox"
                        checked={selectedRows.has(rowIndex)}
                        onChange={(event) => {
                          const next = new Set(selectedRows);
                          if (event.target.checked) next.add(rowIndex);
                          else next.delete(rowIndex);
                          setSelectedRows(next);
                        }}
                        aria-label={`Select row ${page.offset + rowIndex + 1}`}
                      />
                    </td>
                    {page.columns.map((column) => {
                      const value = row[column.name] ?? null;
                      const display = cellToDisplay(value);
                      return (
                        <td
                          key={column.name}
                          className={
                            value === null
                              ? "null-cell"
                              : typeof value === "object"
                                ? "object-cell"
                                : ""
                          }
                          onDoubleClick={() => {
                            if (!canEdit) return;
                            const text =
                              value !== null && typeof value === "object"
                                ? value.$type === "blob"
                                  ? ""
                                  : value.value
                                : value === null
                                  ? ""
                                  : String(value);
                            const blob =
                              value !== null &&
                              typeof value === "object" &&
                              value.$type === "blob";
                            setCellEdit({
                              row,
                              column,
                              text,
                              setNull: value === null,
                              readOnly: blob || !page.primaryKey.length,
                            });
                          }}
                          title={display}
                        >
                          <span>{display}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {!page.rows.length && (
                  <tr>
                    <td colSpan={page.columns.length + 1} className="no-rows">
                      No rows match this view.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
        <div className="pager">
          <div className="pager-info">
            {page ? (
              <>
                Rows {page.offset + 1}–{page.offset + page.rows.length}
                {knownTotal !== null
                  ? ` of ${knownTotal.toLocaleString()}`
                  : ""}
                <span className="muted"> · {page.durationMs} ms</span>
              </>
            ) : (
              "No data loaded"
            )}
          </div>
          <div className="pager-controls">
            <select
              value={pageLimit}
              onChange={(event) => changePageLimit(Number(event.target.value))}
              aria-label="Rows per page"
            >
              {[100, 200, 500, 1000, 2000].map((size) => (
                <option key={size} value={size}>
                  {size} rows
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              onClick={() => goToPage(0)}
              disabled={!page || page.offset === 0}
              title="First page"
              aria-label="First page"
            >
              <Icon name="chevrons-left" />
            </button>
            <button
              className="icon-button"
              onClick={() => goToPage(Math.max(0, pageOffset - pageLimit))}
              disabled={!page || pageOffset === 0}
              title="Previous page"
              aria-label="Previous page"
            >
              <Icon name="chevron-left" />
            </button>
            {totalPages && (
              <span className="page-number">
                Page {Math.floor(pageOffset / pageLimit) + 1} / {totalPages}
              </span>
            )}
            <button
              className="icon-button"
              onClick={() => goToPage(pageOffset + pageLimit)}
              disabled={
                !page ||
                (knownTotal !== null
                  ? pageOffset + page.rows.length >= knownTotal
                  : page.rows.length < pageLimit)
              }
              title="Next page"
              aria-label="Next page"
            >
              <Icon name="chevron-right" />
            </button>
            <button
              className="icon-button"
              onClick={() =>
                knownTotal !== null &&
                goToPage(Math.max(0, (totalPages! - 1) * pageLimit))
              }
              disabled={!page || knownTotal === null || totalPages === 1}
              title="Last page"
              aria-label="Last page"
            >
              <Icon name="chevrons-right" />
            </button>
          </div>
        </div>
        {renderInsertDialog()}
        {renderCellDialog()}
      </div>
    );
  };

  const renderStructure = () => {
    if (!selectedTable)
      return (
        <div className="empty-state">
          <h2>No table selected</h2>
        </div>
      );
    if (structureLoading && !structure)
      return (
        <div className="loading-screen">
          <div className="spinner" />
          Loading schema…
        </div>
      );
    if (!structure) {
      return (
        <div className="empty-state">
          <p>Load the schema for {tableLabel}.</p>
          <button onClick={() => loadStructure(selectedTable)}>
            Load structure
          </button>
        </div>
      );
    }
    return (
      <div className="structure-view">
        <div className="view-toolbar">
          <div className="table-heading">
            <strong>Structure</strong>
            <span className="muted">
              {structure.columns.length} columns · {structure.indexes.length}{" "}
              indexes
            </span>
          </div>
          <div className="toolbar-actions">
            <button onClick={() => loadStructure(selectedTable, false)}>
              <Icon name="refresh" /> Refresh
            </button>
            {structure.ddl && (
              <button
                onClick={() => post({ type: "copyText", text: structure.ddl! })}
              >
                <Icon name="copy" /> Copy DDL
              </button>
            )}
          </div>
        </div>
        {structureLoading && <div className="thin-progress" />}
        <div className="structure-scroll">
          <section>
            <h3>Columns</h3>
            <table className="meta-grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>Default</th>
                  <th>Primary key</th>
                </tr>
              </thead>
              <tbody>
                {structure.columns.map((column) => (
                  <tr key={column.name}>
                    <td>
                      <strong>{column.name}</strong>
                      {column.autoIncrement && (
                        <span className="pill">auto</span>
                      )}
                    </td>
                    <td>
                      <code>{column.dataType}</code>
                    </td>
                    <td>{column.nullable ? "yes" : <strong>NO</strong>}</td>
                    <td>
                      {column.defaultValue ?? <span className="muted">—</span>}
                    </td>
                    <td>{column.primaryKey ? "✓" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {structure.indexes.length > 0 && (
            <section>
              <h3>Indexes</h3>
              <table className="meta-grid">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Columns</th>
                    <th>Unique</th>
                    <th>Primary</th>
                  </tr>
                </thead>
                <tbody>
                  {structure.indexes.map((index) => (
                    <tr key={index.name}>
                      <td>{index.name}</td>
                      <td>{index.columns.join(", ")}</td>
                      <td>{index.unique ? "✓" : ""}</td>
                      <td>{index.primary ? "✓" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {structure.foreignKeys.length > 0 && (
            <section>
              <h3>Foreign keys</h3>
              <table className="meta-grid">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Columns</th>
                    <th>References</th>
                    <th>On delete</th>
                  </tr>
                </thead>
                <tbody>
                  {structure.foreignKeys.map((foreignKey) => (
                    <tr key={foreignKey.name}>
                      <td>{foreignKey.name}</td>
                      <td>{foreignKey.columns.join(", ")}</td>
                      <td>
                        {foreignKey.referencedSchema
                          ? `${foreignKey.referencedSchema}.`
                          : ""}
                        {foreignKey.referencedTable}(
                        {foreignKey.referencedColumns.join(", ")})
                      </td>
                      <td>{foreignKey.onDelete ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {structure.ddl && (
            <section>
              <h3>DDL</h3>
              <pre className="ddl-block">{structure.ddl}</pre>
            </section>
          )}
        </div>
      </div>
    );
  };

  const renderResult = () => {
    if (queryBusy)
      return (
        <div className="result-placeholder">
          <div className="spinner" />
          Running query…
        </div>
      );
    if (queryError)
      return (
        <div className="query-error">
          <strong>Query failed</strong>
          <pre>{queryError}</pre>
        </div>
      );
    if (!queryResult)
      return (
        <div className="result-placeholder">
          Results will appear here. Press Ctrl/Cmd+Enter to run the current
          statement.
        </div>
      );
    if (queryResult.command)
      return (
        <div className="result-placeholder success-text">
          ✓ {queryResult.message ?? "Query completed"}{" "}
          <span className="muted">({queryResult.durationMs} ms)</span>
        </div>
      );
    return (
      <div className="result-view">
        <div className="result-toolbar">
          <span>
            {queryResult.rowCount.toLocaleString()} row
            {queryResult.rowCount === 1 ? "" : "s"}
            {queryResult.truncated ? " (truncated)" : ""} ·{" "}
            {queryResult.durationMs} ms
          </span>
          <div className="toolbar-actions">
            {lastQuery && (
              <label className="toolbar-select" title="Export query result">
                <Icon name="download" size={12} />
                <select
                  className="export-select"
                  value=""
                  aria-label="Export query result"
                  onChange={(event) => {
                    post({
                      type: "exportQuery",
                      sql: lastQuery.sql,
                      format: event.target.value as ExportFormat,
                    });
                    event.target.value = "";
                  }}
                >
                  <option value="">Export…</option>
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                  <option value="jsonl">JSON Lines</option>
                  <option value="sql">SQL inserts</option>
                </select>
              </label>
            )}
          </div>
        </div>
        <div className="grid-wrap result-grid">
          <table className="data-grid">
            <thead>
              <tr>
                {queryResult.columns.map((column) => (
                  <th key={column.name}>
                    <span className="col-name">{column.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {queryResult.rows.map((row, index) => (
                <tr key={index}>
                  {queryResult.columns.map((column) => {
                    const value = row[column.name] ?? null;
                    return (
                      <td
                        key={column.name}
                        className={value === null ? "null-cell" : ""}
                        title={cellToDisplay(value)}
                        onDoubleClick={() =>
                          post({
                            type: "copyText",
                            text: formatValueForExport(value),
                          })
                        }
                      >
                        <span>{cellToDisplay(value)}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!queryResult.rows.length && (
                <tr>
                  <td className="no-rows" colSpan={queryResult.columns.length}>
                    Query returned no rows.
                  </td>
                </tr>
              )}
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
            <span className="file-label" title={displayUrl}>
              {init.fileName}
              {dirty ? " ●" : ""}
            </span>
            <button onClick={saveSql} disabled={!dirty}>
              <Icon name="save" /> Save
            </button>
            {activeSummary ? (
              <span
                className="connection-chip"
                title={`${activeSummary.type} · ${activeSummary.host ?? ""}`}
              >
                {activeSummary.name}
              </span>
            ) : (
              <span className="pill warn">No connection</span>
            )}
          </>
        ) : activeSummary ? (
          <span
            className="connection-chip"
            title={`${activeSummary.type} · ${activeSummary.host ?? ""}`}
          >
            {activeSummary.name}
          </span>
        ) : (
          <span className="pill warn">No connection</span>
        )}
        <div className="spacer" />
        <button
          className="primary"
          onClick={() => {
            const sql = sqlEditorRef.current?.getSelectionOrCurrent();
            if (sql) executeQuery(sql);
          }}
          disabled={queryBusy || !activeSummary}
        >
          <Icon name="play" /> Run
        </button>
        <button
          onClick={() => {
            const sql = sqlEditorRef.current?.getAll();
            if (sql) executeQuery(sql);
          }}
          disabled={queryBusy || !activeSummary}
          title="Run the entire editor"
        >
          <Icon name="play" /> Run all
        </button>
        <button
          onClick={() =>
            post({ type: "openQueryFile", sql: sqlEditorRef.current?.getAll() })
          }
          title="Save the query as a .sql file"
        >
          <Icon name="file-plus" /> Save as…
        </button>
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
          <button
            onClick={() => post({ type: "clearHistory" })}
            disabled={!history.length}
          >
            <Icon name="trash" /> Clear history
          </button>
        </div>
      </div>
      {!history.length && (
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="history" size={26} />
          </div>
          <p>Queries you run will appear here.</p>
        </div>
      )}
      <div className="history-list">
        {history.map((entry) => (
          <div className="history-entry" key={entry.id}>
            <div className={`history-status ${entry.success ? "ok" : "fail"}`}>
              <Icon name={entry.success ? "check" : "alert-circle"} />
            </div>
            <div className="history-body">
              <pre>{entry.sql}</pre>
              <div className="muted compact">
                {entry.connectionName} · {entry.rowCount} rows ·{" "}
                {entry.durationMs} ms ·{" "}
                {new Date(entry.createdAt).toLocaleString()}
              </div>
              {entry.error && <div className="error-text">{entry.error}</div>}
            </div>
            <div className="history-actions">
              <button
                onClick={() => {
                  setQuerySql(entry.sql);
                  setTab("query");
                }}
              >
                <Icon name="code" /> Load
              </button>
              <button
                className="primary"
                onClick={() => {
                  setQuerySql(entry.sql);
                  setTab("query");
                  window.setTimeout(() => executeQuery(entry.sql), 50);
                }}
              >
                <Icon name="play" /> Run
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const tabButton = (
    id: Tab,
    label: string,
    icon: IconName,
    disabled = false,
  ) => (
    <button
      className={`tab ${tab === id ? "active" : ""}`}
      onClick={() => {
        if (id === "structure" && selectedTable && !structure)
          loadStructure(selectedTable);
        setTab(id);
      }}
      disabled={disabled}
      aria-current={tab === id ? "page" : undefined}
    >
      <Icon name={icon} size={13} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="app">
      <div className="main">
        <main className="workspace">
          <div className="tabs">
            {tabButton("data", "Data", "table", isSqlMode || !selectedTable)}
            {tabButton(
              "structure",
              "Structure",
              "columns",
              isSqlMode || !selectedTable,
            )}
            {tabButton("query", "Query", "code")}
            {tabButton("history", "History", "history")}
            <div className="spacer" />
            {!isSqlMode && selectedTable && (
              <span className="table-context">
                <Icon name="database" size={12} />
                {tableLabel}
              </span>
            )}
          </div>
          <div className="workspace-content">
            {tab === "data" && !isSqlMode && renderData()}
            {tab === "structure" && !isSqlMode && renderStructure()}
            {tab === "query" && renderQuery()}
            {tab === "history" && renderHistory()}
            {tab === "data" && isSqlMode && renderData()}
            {tab === "structure" && isSqlMode && renderStructure()}
          </div>
        </main>
      </div>
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <Icon name={TOAST_ICONS[toast.kind] ?? "info"} size={15} />
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

declare function acquireVsCodeApi<T>(): {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
};
