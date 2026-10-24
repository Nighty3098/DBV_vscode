# Research: SQLite Viewer and database-tool analogues

Date: 2026-10-24

DBV was scoped by studying the product pages, READMEs, and feature documentation of the most relevant database extensions and desktop clients. This document records what was learned and how each capability maps to DBV.

## Sources

- [qwtel/sqlite-viewer-vscode README](https://github.com/qwtel/sqlite-viewer-vscode) and the [Open VSX listing](https://open-vsx.org/extension/qwtel/sqlite-viewer)
- [SQLite Viewer project page](https://qwtel.com/projects/sqlite-viewer/)
- [SQLTools documentation](https://vscode-sqltools.mteixeira.dev/en/home.html), [feature docs](https://vscode-sqltools.mteixeira.dev/en/features/executing-queries.html), and [Open VSX listing](https://open-vsx.org/extension/mtxr/sqltools)
- [DBeaver Community](https://dbeaver.io/) and [DBeaver feature comparison](https://dbeaver.com/edition/)
- [DBCode](https://dbcode.io/) and [its marketplace listing](https://marketplace.visualstudio.com/items?itemName=DBCode.dbcode)
- [DuckDB SQL Tools](https://github.com/RandomFractals/duckdb-sql-tools)
- [VS Code custom editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [Node.js `node:sqlite` documentation](https://nodejs.org/api/sqlite.html)

## What SQLite Viewer (qwtel) does

Its README advertises:

- A fast custom editor for SQLite files, launched by clicking `.sqlite`/`.db` files.
- Platform independence and no native dependencies, including web VS Code support.
- Virtualized scrolling, sorting, filtering, and theme integration.
- A polished grid inspired by Airtable and DB Browser for SQLite.

Its documented caveats are equally important:

- **Cached and read-only**: users cannot edit data.
- **200 MB memory cap**: the database is loaded into memory.
- **No query runner**.
- **Paid upgrades and sponsored content** are included.

DBV was explicitly designed to close those gaps:

| Gap in SQLite Viewer | DBV implementation |
| --- | --- |
| Read-only | Parameterized update/insert/delete with primary-key or rowid targeting |
| In-memory, 200 MB cap | `node:sqlite` direct file access plus server-side paging |
| No query runner | CodeMirror workbench, current-statement execution, history, multi-statement support |
| No saved sessions | Global connection store + OS keychain secrets |
| SQLite only | PostgreSQL, MySQL, MariaDB, SQL Server, and SQLite |
| Paid extras | Entirely MIT, no upsell or tracking |

The one deliberate trade-off: qwtel's extension works in web VS Code. DBV declares `extensionKind: workspace` and targets desktop/remote VS Code because direct SQLite file access and server sockets are required. VSCodium is fully supported.

## What SQLTools contributes

SQLTools is the long-standing open-source VS Code database client. Its core feature set:

- Connection explorer.
- Query runner for a file, selection, or current statement.
- Query history and bookmarks.
- Formatting/beautifying SQL.
- INSERT-query generator.
- Pluggable drivers.

DBV adopts the connection explorer, current-statement UX (`Ctrl/Cmd+Enter`), query history, and INSERT export. It intentionally does not require a driver package per engine. Formatting is provided by the editor's normal SQL editing rather than a dedicated formatter in this release.

## What DBeaver contributes

DBeaver popularized the host/port connection wizard, schema navigation, table data editing, SQL editor, and export workflows. DBV's connection flow mirrors the essentials:

1. Pick engine.
2. Host and port.
3. Database and user.
4. Password (stored in Secret Storage, not plaintext).
5. SSL mode and read-only toggle.
6. Name and save.

DBeaver's advanced administration (users, grants, sessions, ER diagrams, data transfer) is outside the first release; see the roadmap.

## What DBCode and modern clients contribute

DBCode emphasizes an integrated editor workflow, saved queries, AI features, and consistent query editing across editors. DBV takes the integrated `.sql` custom editor and saved-query history but deliberately excludes AI and hosted services to remain fully local, free, and open source.

## Feature matrix of DBV v0.1

| Capability | Status |
| --- | --- |
| SQLite file association / custom editor | Yes |
| SQL file custom workbench | Yes (default; reopenable as text) |
| Host/port saved sessions | Yes |
| Password secret storage | Yes |
| PostgreSQL / MySQL / MariaDB / SQL Server | Yes |
| Schema explorer with views | Yes |
| Table page browsing, sort, filter | Yes |
| Insert / update / delete rows | Yes (primary key or SQLite rowid) |
| SQL NULL editing | Yes |
| DDL, columns, indexes, foreign keys | Yes |
| Query runner + selection/current statement | Yes |
| Query history | Yes |
| CSV / JSON / JSONL / SQL export | Yes |
| Read-only connections | Yes |
| Large database page loading | Yes |
| ER diagrams | Roadmap |
| CSV import UI | Roadmap |
| Visual table/index designer | Roadmap |
| Query cancellation | Roadmap |
| Web VS Code | Not supported (requires Node file/socket access) |

## Design decisions

- **No SQLite WASM**: WASM SQLite would either load the database into memory (the exact limitation of the original extension) or depend on OPFS in the browser. The desktop extension runs in Node, so the built-in SQLite engine gives real file access and large-database behavior.
- **Paged data grid**: the UI never receives an unbounded table. This is less seamless than a client-side virtual list but is safe for tables with millions of rows.
- **Metadata allow-list + bound values**: sort/filter columns are validated against the live schema; values are always parameters. Identifiers are quoted per dialect.
- **Primary-key safety**: remote edits require a real primary key. SQLite uses `rowid` only when no explicit key exists. This avoids ambiguous mass updates.
- **Text editor integration**: `.sql` is a custom text editor, so it participates in VS Code save, revert, dirty state, and reopen-as-text workflows.
