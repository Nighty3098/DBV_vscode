# Publishing DBV to Open VSX

DBV is published to **Eclipse Open VSX** under the extension ID `nighty3098.dbv`. Open VSX is the default registry for VSCodium, code-server, Gitpod, Theia, and other VS Code forks. VS Code users install the same VSIX from the GitHub release.

The `release.yml` workflow builds the VSIX once, publishes it to Open VSX, and attaches it to a GitHub release.

## One-time account setup

1. Sign in at <https://open-vsx.org> with GitHub.
2. Create an Eclipse account and sign the Publisher Agreement, as described in the [Open VSX publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions). This is required before publishing.
3. Create the namespace `nighty3098` (it must match `publisher` in `package.json`, including case):
   ```bash
   OVSX_PAT="<token>"
   npx --yes ovsx create-namespace nighty3098 --pat "$OVSX_PAT"
   ```
4. Create an access token at <https://open-vsx.org/user-settings/tokens>.
5. Add it to the GitHub repository as the secret **`OVSX_PAT`** (Settings → Secrets and variables → Actions → New repository secret). The first release needs this token because Open VSX trusted publishing can only be registered after the extension exists.
6. Verify the token and namespace:
   ```bash
   npx --yes ovsx verify-pat nighty3098 --pat "$OVSX_PAT"
   ```
7. After the first successful publish, switch to tokenless publishing (recommended):
   - Open <https://open-vsx.org/user-settings/trusted-publishers> and pick the `nighty3098` namespace.
   - Provider: **GitHub Actions**.
   - Organization or user: `Nighty3098`.
   - Repository: `DBV_vscode`.
   - Workflow filename: `release.yml`.
   - Environment: leave empty.
   - Delete the `OVSX_PAT` repository secret afterwards. The release workflow automatically uses `ovsx publish --trusted-publishing` when `OVSX_PAT` is absent.

> Open VSX trusted publishing requires `id-token: write` in the workflow. It is already set in `.github/workflows/release.yml`.

## Release workflow

The workflow runs on tags matching `v*.*.*`. It refuses to publish when the tag does not match `package.json#version`.

1. Update the version in `package.json` (SemVer, no pre-release suffix).
2. Add a matching entry at the top of `CHANGELOG.md`.
3. Run the local checks and build the VSIX:
   ```bash
   npm ci
   npm run check
   npm run package
   ```
   `npm run package` runs `vscode:prepublish` (`npm run build`) first, so `dist/` is always fresh.
4. Inspect the package and verify that only runtime files are included:
   ```bash
   npx --yes @vscode/vsce ls --no-dependencies
   unzip -l dbv-<version>.vsix
   ```
5. Install the VSIX in VSCodium and VS Code and run the smoke test below.
6. Commit and tag:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore(release): v<version>"
   git tag v<version>
   git push origin main --tags
   ```
7. The **Release** workflow then:
   - checks the tag against `package.json`;
   - type-checks, lints, and runs the test suite with coverage;
   - packages `dbv.vsix`;
   - publishes to Open VSX with `OVSX_PAT`, or with Open VSX trusted publishing when the secret is absent;
   - creates a GitHub release and attaches the VSIX.

The publish step uses `--skip-duplicate`, so rerunning a failed release is safe. The first Open VSX release requires `OVSX_PAT`; register the trusted publisher afterwards and remove the secret.

## Manual publishing

Use this as a fallback or for the first upload while account access is being verified.

```bash
export OVSX_PAT="..."
npm run publish:openvsx
```

`npm run publish:openvsx` rebuilds `dist/`, packages the current directory, and uploads it. To publish an existing VSIX without rebuilding:

```bash
npx --yes ovsx publish dbv-<version>.vsix --pat "$OVSX_PAT"
```

After the trusted publisher is registered, CI can publish without a token:

```bash
npx --yes ovsx publish dbv.vsix --trusted-publishing
```

Do not commit tokens. Prefer the `OVSX_PAT` environment variable over command-line arguments.

## What is inside the VSIX

`package.json#files` is the allow-list. `vsce` refuses to combine it with a `.vscodeignore` file, so the repository intentionally has no `.vscodeignore`:

- `dist/extension.js`, `dist/webview.js`, `dist/webview.css` — bundled at build time;
- `media/` — icon, activity-bar SVG, and README screenshots;
- `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json`.

`node_modules/`, `src/`, `tests/`, `docs/`, `scripts/`, coverage output, logs, and VSIX archives are excluded. Third-party database drivers are bundled into `dist/extension.js`, so the extension has no native or runtime `node_modules` dependency.

## Pre-flight checklist

- [ ] `publisher` is `nighty3098`, `name` is `dbv`, and the version is the same in `package.json`, `CHANGELOG.md`, and the git tag.
- [ ] `engines.vscode` is `^1.105.0` or newer and matches the Node.js `node:sqlite` requirement.
- [ ] `icon` is a PNG of at least 128×128 px (currently 640×640).
- [ ] `repository`, `homepage`, `bugs`, `license`, and `pricing` are present.
- [ ] All README images are either relative paths included in the VSIX or HTTPS URLs. Badges use HTTPS.
- [ ] README/image changes are committed and pushed to the default branch. `vsce` rewrites relative links to GitHub, so a local-only commit produces broken images on Open VSX.
- [ ] The release commit is on `main`; tags created from an unmerged branch still publish a README that points at `HEAD`.
- [ ] No `.env`, credentials, database files, logs, or `.vsix` archives are packaged.
- [ ] `npx @vscode/vsce ls --no-dependencies` lists only runtime files.
- [ ] The VSIX installs in a recent VSCodium build and in VS Code 1.105+.
- [ ] Smoke test: open a SQLite file, add a server connection, run a query, edit and export a row.
- [ ] `CHANGELOG.md` describes the release.

## Smoke test after publishing

```bash
codium --install-extension nighty3098.dbv
code --install-extension dbv-<version>.vsix
```

Check that:

- the Open VSX page renders the icon, banner, screenshots, and README;
- VSCodium resolves the extension from Open VSX and offers updates;
- the VSIX installs in VS Code;
- the **DBV** activity-bar view and both custom editors open without errors;
- `DBV: Show Query History` and `DBV: Open Documentation` work.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `401`/`403` from `ovsx` | The token is invalid or expired. Generate a new one at <https://open-vsx.org/user-settings/tokens> and update `OVSX_PAT`. |
| `Namespace not found` | Create the `nighty3098` namespace and verify the token with `ovsx verify-pat`. The `publisher` field must match the namespace case exactly. |
| Trusted publishing fails | The extension must already exist with an active version. The registration fields must match owner `Nighty3098`, repository `DBV_vscode`, workflow `release.yml`, and the job must have `id-token: write`. |
| `The extension 'dbv' already exists` | The `name` or `displayName` is taken. Use the `nighty3098.dbv` ID and check the namespace before publishing. |
| Extension fails to activate | `dist/extension.js` missing or stale. Run `npm run build` (also runs automatically via `vscode:prepublish`). |
| Images broken on Open VSX | Use HTTPS or repository-relative paths. `vsce` rewrites relative links to the public GitHub branch and the screenshots are bundled in `media/screenshots/`. |
| VSCodium cannot find the extension | Confirm the Open VSX publish succeeded and refresh the extensions view. |
| `skip-duplicate` hides a mistake | The version already exists and was not replaced. Bump the version before publishing again. |

## Registry links

- Open VSX profile and tokens: <https://open-vsx.org/user-settings/tokens>
- Open VSX trusted publishers: <https://open-vsx.org/user-settings/trusted-publishers>
- Open VSX item (after first publish): <https://open-vsx.org/extension/nighty3098/dbv>
- Open VSX publishing: <https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions>
- Open VSX trusted publishing: <https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing>
- vsce packaging documentation: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
