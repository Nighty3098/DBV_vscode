# Contributing to DBV

Thanks for helping make a free database tool better. DBV targets both VS Code and VSCodium, so changes must not depend on proprietary VS Code APIs or marketplace-only services.

## Development setup

Requirements:

- Node.js **22.17 or newer** (the extension uses the built-in `node:sqlite` module).
- npm 10 or newer.
- VS Code 1.105+ or a recent VSCodium build for manual testing.

```bash
npm ci
npm run build      # bundle extension + webview
npm run compile    # TypeScript type-check
npm test           # unit and SQLite integration tests
npm run test:coverage
```

Press `F5` (or run the **Run DBV Extension** launch configuration) to start an Extension Development Host.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/core/` | Pure functions: SQL construction, validation, serialization, export, history. No VS Code imports. |
| `src/extension/` | Activation, commands, tree view, custom editors, and webview sessions. |
| `src/extension/drivers/` | Database drivers implementing a shared contract. |
| `src/shared/` | Types shared by the extension host and webview. |
| `src/webview/` | React workbench, CodeMirror SQL editor, styles. |
| `tests/` | Vitest suites, including real `node:sqlite` integration tests. |

## Guidelines

- Use TypeScript with explicit types at module boundaries. Keep code, comments, identifiers, and user-facing strings in English.
- Keep the extension host authoritative. The webview must not build SQL; it sends intent to the host, which validates and parameterizes queries.
- Quote identifiers and bind values. Never interpolate user-supplied values into SQL strings.
- Preserve large-database behavior: paginate, cap ad-hoc results, and avoid buffering entire tables.
- Prefer the built-in `node:sqlite` driver. Do not add native modules that require per-platform builds.
- Add tests for pure logic and SQLite behavior. Server drivers should remain type-checked and follow the same contract as SQLite.
- Update `README.md`, `CHANGELOG.md`, and `docs/RESEARCH.md` when behavior or feature coverage changes.
- Do not commit credentials, `.env` files, database files, VSIX archives, `dist/`, or coverage output.

## Testing

```bash
npm test                 # all tests
npm run test:coverage    # coverage gate
npx vitest run tests/core.test.ts
```

The coverage gate covers `src/core/**` and `src/extension/drivers/sqlite.ts`. New code in those areas must keep statements, functions, and lines at 100%.

Integration tests create temporary SQLite databases and must not touch user files.

## Commit standards

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <imperative subject>
```

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
- Subject: imperative mood, no trailing period, **50 characters or fewer**.
- One logical change per commit. Do not mix formatting, refactoring, and behavior changes.
- Use the body to explain motivation and security implications, not to restate the diff.
- Reference issues in the footer, for example `Refs: #12`.

Examples:

```
feat(drivers): add mysql ssl modes
fix(webview): quote identifiers in filters
test(core): cover empty sort lists
docs: document sqlite editor setup
```

## Pull requests

- Keep pull requests focused.
- Describe behavior changes, trade-offs, and manual test steps.
- Include screenshots for UI changes.
- Confirm `npm run check` and `npm run build` pass.
- Never include secrets or customer data in issues or pull requests.

## Reporting bugs

Include:

1. VS Code/VSCodium version and OS.
2. DBV version.
3. Database engine and version (redact host names and credentials).
4. Steps to reproduce, expected behavior, and actual behavior.
5. Relevant output from **View → Output → DBV** or the developer console.

For security issues, do not open a public issue with exploit details. Contact the maintainer through the repository security advisory flow.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
