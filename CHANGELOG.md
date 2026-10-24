# Changelog

All notable changes to DBV are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Conventional Commits](https://www.conventionalcommits.org/).

## [0.1.0] - 2026-10-24

### Added

- Custom database editor for SQLite files (`.sqlite`, `.sqlite3`, `.db`, `.db3`, `.s3db`, `.gpkg`).
- SQL workbench custom editor for `.sql` files with CodeMirror, dirty-state sync, save, and reopen-as-text.
- Saved connections with host, port, SSL modes, read-only access, and Secret Storage passwords.
- Drivers for SQLite, PostgreSQL, MySQL, MariaDB, and SQL Server.
- Schema explorer with tables, views, columns, indexes, foreign keys, and DDL.
- Paged table browser with sorting, filters, row selection, and row insert/update/delete.
- SQLite `rowid` fallback for keyless tables.
- Query runner with current-statement/selection execution and history.
- CSV, JSON, JSONL, and SQL INSERT export.
- Connection tree view, commands, configuration, and VS Code/VSCodium packaging.
- Unit and real-SQLite integration tests with coverage gates and CI.
