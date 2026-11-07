# Publishing DBV

DBV is published under the same extension ID to two registries:

| Registry              | ID                 | Clients                                              |
| --------------------- | ------------------ | ---------------------------------------------------- |
| VS Code Marketplace   | `nighty3098.dbv`   | VS Code, VS Code Insiders, github.dev (not supported) |
| Eclipse Open VSX      | `nighty3098.dbv`   | VSCodium, code-server, Gitpod, Theia, and other forks |

The VSIX is identical for both registries. The `release.yml` workflow builds it once, publishes it to both, and attaches it to a GitHub release.

## One-time account setup

### VS Code Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with the Microsoft account that will own the extension.
2. Create a publisher whose **ID** is exactly `nighty3098` (it must match `publisher` in `package.json`). The display name can be anything.
3. Configure **Trusted Publishing** (recommended) so CI can publish without a long-lived token:
   - Open the publisher → **Trusted Publishing** → **Create**.
   - Policy name: `Release workflow`.
   - Repository owner: `Nighty3098`.
   - Repository: `DBV_vscode`.
   - Workflow: `release.yml`.
   - Environment: leave empty unless the workflow is later moved into a GitHub environment.
4. Do not create a personal access token unless you need the temporary manual fallback below.

> Azure DevOps is retiring global personal access tokens on **1 December 2026**. Trusted Publishing with GitHub OIDC is the supported path and is already wired into `.github/workflows/release.yml`.

### Eclipse Open VSX

1. Sign in at <https://open-vsx.org> with GitHub.
2. Create an Eclipse account and sign the Publisher Agreement, as described in the [Open VSX publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions). This is required before publishing.
3. Create the namespace `nighty3098` (it must match `publisher` in `package.json`, including case). You can do it in the web UI or with a token:
   ```bash
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
5. Install the VSIX locally in both VS Code and VSCodium and run the smoke test below.
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
   - publishes to the VS Code Marketplace with OIDC (`vsce publish --packagePath dbv.vsix --oidc`);
   - publishes to Open VSX with `OVSX_PAT`, or with Open VSX trusted publishing when the secret is absent;
   - creates a GitHub release and attaches the VSIX.

Both publish steps use `--skip-duplicate`, so rerunning a failed release is safe. The first Open VSX release requires `OVSX_PAT`; register the trusted publisher afterwards and remove the secret.

## Manual publishing

Use this only as a fallback or for the very first upload while account access is being verified.

### VS Code Marketplace

With a temporary personal access token (Marketplace **Manage** scope, all accessible organizations):

```bash
npx --yes @vscode/vsce login nighty3098
npm run publish:marketplace
```

Or publish a VSIX built in CI:

```bash
npx --yes @vscode/vsce publish --packagePath dbv.vsix
```

For Azure Pipelines or local Microsoft Entra ID authentication, use `vsce publish --azure-credential` instead of a PAT. Do not commit tokens.

### Open VSX

```bash
export OVSX_PAT="..."
npm run publish:openvsx
```

`npm run publish:openvsx` rebuilds `dist/`, packages the current directory, and uploads it. To publish an existing VSIX without rebuilding:

```bash
npx --yes ovsx publish dbv-<version>.vsix --pat "$OVSX_PAT"
```

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
- [ ] README/image changes are committed and pushed to the default branch. `vsce` rewrites relative links to GitHub, so a local-only commit produces broken images on the Marketplace.
- [ ] The release commit is on `main`; tags created from an unmerged branch still publish a README that points at `HEAD`.
- [ ] No `.env`, credentials, database files, logs, or `.vsix` archives are packaged.
- [ ] `npx @vscode/vsce ls --no-dependencies` lists only runtime files.
- [ ] The VSIX installs in VS Code 1.105+ and a recent VSCodium build.
- [ ] Smoke test: open a SQLite file, add a server connection, run a query, edit and export a row.
- [ ] `CHANGELOG.md` describes the release.

## Smoke test after publishing

```bash
code --install-extension nighty3098.dbv
codium --install-extension nighty3098.dbv
```

Check that:

- the Marketplace/Open VSX page renders the icon, banner, screenshots, and README;
- VS Code shows the extension as installed and offers updates;
- VSCodium resolves the extension from Open VSX;
- the **DBV** activity-bar view and both custom editors open without errors;
- `DBV: Show Query History` and `DBV: Open Documentation` work.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `401`/`403` from `vsce` | PAT uses the wrong organization or lacks **Marketplace → Manage**. Prefer `--oidc` in CI. |
| OIDC publish fails | Trusted Publishing policy fields must match owner `Nighty3098`, repository `DBV_vscode`, workflow `release.yml`, and the job must have `id-token: write`. For Open VSX, the extension must already exist and the trusted publisher registration must point at `release.yml`. |
| `The extension 'dbv' already exists` | The `name` or `displayName` is taken. Use the `nighty3098.dbv` ID and check the publisher before publishing. |
| `Namespace not found` on Open VSX | Create the `nighty3098` namespace and verify `OVSX_PAT` with `ovsx verify-pat`. The `publisher` field must match the namespace case exactly. |
| Extension fails to activate | `dist/extension.js` missing or stale. Run `npm run build` (also runs automatically via `vscode:prepublish`). |
| Icon rejected | The Marketplace does not accept SVG icons. `media/icon.png` is already a PNG. |
| Images broken on the Marketplace | Use HTTPS or repository-relative paths. `vsce` rewrites relative links to the public GitHub `main` branch and the screenshots are bundled in `media/screenshots/`. |
| VSCodium cannot find the extension | VSCodium uses Open VSX, not the VS Code Marketplace. Confirm the Open VSX publish succeeded. |

## Registry links

- Marketplace management: <https://marketplace.visualstudio.com/manage>
- Marketplace item (after first publish): <https://marketplace.visualstudio.com/items?itemName=nighty3098.dbv>
- Open VSX tokens: <https://open-vsx.org/user-settings/tokens>
- Open VSX trusted publishers: <https://open-vsx.org/user-settings/trusted-publishers>
- Open VSX item (after first publish): <https://open-vsx.org/extension/nighty3098/dbv>
- vsce documentation: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
- Open VSX publishing: <https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions>
- Open VSX trusted publishing: <https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing>
