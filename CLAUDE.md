# Pennystead: notes for Claude

Private personal-finance app. One Node 22 program (`main.js` → `server.js`) serving a plain-JS UI (`public/`), packaged as a single executable for Windows, macOS and Linux. User data lives in a data folder (`lib/config.js` → `paths`), never in the repo.

## Layout
- `lib/core.js`: what the pages and API read (state, overview, wealth, spending, review, transactions) and most mutations.
- `lib/ledger.js`: native ledger engine (balances, prices, conversion). `lib/journal.js` turns stored transactions into journals.
- `lib/sync.js` + `lib/eb.js`: Enable Banking sync. `lib/importer.js`: CSV/Excel import. `lib/updater.js`: in-app updates.
- `lib/llm.js` (OpenRouter chat, AI import help) and `lib/tools.js`: data tools shared by the in-app chat and the MCP server (`mcp.js`).
- `public/app.js` (shell, helpers) and `public/pages.js` (every page). `docs/` is the GitHub Pages bank-redirect relay.

## Rules
- Never hard-code a currency. The main currency comes from the user's own accounts until they confirm one (`detectBase` in `lib/config.js`).
- Don't assume anything about the user's data (bank, country, currency). Ask instead.
- Account balances follow the bank or statement. Imports and deletes shift the opening balance instead of changing today's balance.
- Data sent to an AI is masked by `lib/redact.js` and kept to what the feature needs.

## Before pushing
```
npm test                                   # all tests must pass
node scripts/build.js && node scripts/smoke.js dist/pennystead
```
For UI changes, also run the app (`PENNYSTEAD_DATA=<tmp dir> PENNYSTEAD_NO_BROWSER=1 node main.js`) and check the page in Playwright/Chromium.

## Releasing (how the user gets changes)
1. Bump `version` in `package.json` **and** `package-lock.json` (both places).
2. Commit and push to `main`.
3. Run the **Release** workflow (`release.yml`) on `main` with input `publish: true`. It builds every platform, then creates the tag `v<version>` and the GitHub Release itself (pushing tags from a session may be blocked).
4. Confirm `https://api.github.com/repos/Adamkyl69/Pennystead/releases/latest` shows the new version with `*-setup.exe` and `SHA256SUMS-*.txt`. The app's **Settings → Updates** installs from there.
