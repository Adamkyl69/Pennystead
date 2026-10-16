# Pennystead: your private finance dashboard

See where your money goes, track your net worth, and keep an eye on subscriptions and budgets, **without giving your data to anyone**.
Pennystead runs on your own computer: no account, no cloud, no tracking.

- **Net worth** and *liquid* net worth over time, including property, a car, a pension or crypto you record by hand, plus loans
- **Spending** by category, vendor or account, with budgets (monthly or yearly), drill-down and comparisons
- **Import** a CSV or Excel statement from any bank, or **sync automatically** through Enable Banking (read-only)
- **Subscriptions, price rises, duplicate charges and unusual spending** flagged for you
- **Investments and currencies** valued at current prices
- **Encrypted backups** to a folder and/or your own Google Drive
- **Chat with your data** from Claude through the built-in MCP server (optional)

## Install

Download the file for your computer from the [Releases](https://github.com/Adamkyl69/Pennystead/releases) page, then follow the steps. Pennystead needs nothing else installed (no Node, no hledger).

| Your computer | Download | Then |
|---|---|---|
| **Windows 10/11** | `Pennystead-…-windows-x64-setup.exe` (installer) or the `.zip` (portable) | Run the installer, then open **Pennystead** from the Start menu |
| **macOS 11+** | `Pennystead-…-macos-arm64` (Apple Silicon) or `-x64` (Intel) `.dmg` / `.zip` | Drag **Pennystead** to Applications, then open it |
| **Linux** | `Pennystead-…-linux-x64.tar.gz` | Extract, run `./install.sh` for a menu entry, or just run `./pennystead` |
| **Home server / NAS** | Docker image (see below) | `docker compose up -d` |

Your browser opens Pennystead. On Windows and Linux a small window stays open while it runs; close it or use *Settings → Security → Quit Pennystead* to stop. Starting it twice just reopens the first copy.

**"Windows protected your PC" / "developer cannot be verified":** these builds are not signed with a paid developer certificate, so your system warns on first launch. Windows: *More info → Run anyway*. macOS: right-click the app → *Open* → *Open* (or *System Settings → Privacy & Security → Open Anyway*). Each release publishes SHA-256 checksums so you can verify the download.

**Updates:** *Settings → Updates* shows when a newer release is out (the sidebar shows **Update to …** too) and installs it with one click. Pennystead downloads the file for your computer from this project's Releases, checks it against the SHA-256 checksum published with it, installs it and restarts, and your open window reloads into the new version. Your data is not touched. Checking is one anonymous request to GitHub at start and every 12 hours; you can switch it off there. On macOS, run Pennystead from Applications (not from the disk image) so it can update itself.

**First steps:** the welcome screen offers four ways in: import a statement, connect your bank, add assets by hand, or explore with sample data (one click to clear). Then switch on encrypted backups (*Settings → Backups*).

**Where your data lives:** Windows `%APPDATA%\Pennystead`, macOS `~/Library/Application Support/Pennystead`, Linux `~/.local/share/pennystead`. Uninstalling does not delete it.

## How it works and what it protects

```
bank sync / CSV / Excel / manual entries ─▶ your data folder ─▶ Pennystead (calculates net worth, budgets, detection) ─▶ browser UI
                                                  │                                                                  └▶ MCP server (optional)
                                                  └▶ encrypted backups ─▶ folder / your Google Drive
```

Pennystead is one self-contained program with its own ledger engine. Your data is plain JSON plus standard [hledger](https://hledger.org) journal files that Pennystead regenerates, so you can open them with hledger if you like (optional; Pennystead does not need it, and a test suite proves Pennystead and hledger agree).

**Security model**
- Listens on **this computer only** (`127.0.0.1`). It will refuse to listen on a network address unless a password is set.
- **Host and Origin checks** stop other websites (including DNS-rebinding tricks) from reading or changing your data through your browser; a strict **Content-Security-Policy** forbids inline scripts.
- Optional **password** (salted scrypt hash, rate-limited sign-in, HttpOnly cookie).
- Bank and service **credentials are stored owner-only, never sent to the browser, and never backed up**. Full account numbers are never sent to the browser.
- **No third-party code**: no dependencies at runtime, so nothing to compromise through a package.
- It contacts the internet only for what you set up: Enable Banking, Alpha Vantage, Google Drive.
- Backups are **AES-256 encrypted**, and uploads to Google Drive are refused without a passphrase.

## Pages
| Page | What it does |
|---|---|
| **Overview** | Net worth and *liquid* net worth over time (1M…All), cash flow, this month by category, accounts |
| **Spending** | Week/month/quarter/year, by category / vendor / account, drill into sub-categories, budget bars, vs previous and vs 3-period average, top vendors, **Recurring** view (subscriptions and bills with flags) |
| **Assets** | Bank & cash, investments with gain/loss, **manual assets** |
| **Liabilities** | Mortgages, loans and debts you track by hand |
| **Transactions** | Search and filter; change any transaction's category inline |
| **Import** | Load historical transactions from CSV or Excel: auto-detected columns, preview, duplicate detection, undo |
| **Review** | Merchants no rule matched (assign once → rule created, history re-categorized), unusual activity, subscription flags |
| **Categories** | Category list and monthly budgets |
| **Rules** | Ordered regex rules (counterparty/message → category) |
| **Banks** | Connect, sync, disconnect; update prices |
| **Backups** | Automatic encrypted backups to a local folder and/or Google Drive; restore |
| **Connections** | Your Enable Banking, Alpha Vantage and Google credentials, entered once in the app |
| **Security** | Optional password, start with your computer, Quit |

### Manual assets and liabilities
Anything not at your bank: property, car, private pension, crypto wallet, a loan. Add it, then record a new value whenever you like
(Assets → *Update ▾*). Each entry keeps its full value history, which feeds the net worth chart. Details:
- **Liquid** (can be sold quickly, e.g. crypto) vs **illiquid** (property, pension, vehicle) decides which net worth it counts toward.
- **Secured** debt (mortgage) reduces illiquid net worth; **unsecured** debt (credit) reduces liquid net worth.
- Optional **cost basis** + acquired date gives gain vs cost. Non-base currencies are converted using Alpha Vantage FX rates.
- Entries older than 90 days get a "stale" badge. *Mark as sold / repaid* records a zero value and keeps history intact.
- Under the hood each asset is one unit of an hledger commodity and each value is a price directive, so hledger does the valuation.

## Settings and credentials
Everything is configured in the app, no files to edit:

- **Settings → Connections:** your Enable Banking Application ID and `.pem` private key (bank sync), an Alpha Vantage key (prices), Google Drive client ID and secret (backups). They are stored in `secrets.json` in your data folder (owner-only permissions), are never shown again, never sent to the browser, and never included in a backup.
- **Settings → Security:** an optional password, start-at-login, and Quit.
- **Categories, Rules, Backups** as described above. Advanced options (`holdings`, `cash`, `anomalyMin`) live in `config.json` in the data folder.

Developers can also use environment variables, which take precedence: `APP_ID`, `KEY_PATH`, `ALPHAVANTAGE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BACKUP_PASSPHRASE`, `PENNYSTEAD_PASSWORD`, `PENNYSTEAD_PORT`, `PENNYSTEAD_HOST`, `PENNYSTEAD_DATA`, `PENNYSTEAD_ALLOWED_HOSTS`, `REDACT`, `MCP_WRITE`. (`.env` is read when running from source only.)

Enable Banking only covers bank accounts, so stocks and funds are entered under `holdings` in `config.json`: `{ "symbol": "AAPL", "qty": 10, "cost": 1500, "currency": "USD" }` (`cost` = total cost basis; optional `av` ticker, `since` date). `cash` holds foreign-currency cash: `{ "currency": "USD", "amount": 2000 }`. Alpha Vantage's free tier is 25 requests/day: one per holding plus one per foreign currency per update.

## Import historical data (CSV / Excel)
*Import* loads transactions from a bank export, for history your bank no longer provides, or an account you do not sync.
Upload a `.csv`, `.tsv`, `.txt` or `.xlsx` file (up to 30 MB), check the column mapping, preview, then confirm. Nothing is saved before that.

- **Formats are detected for you:** delimiter (`,` `;` tab `|`), encoding (UTF-8, UTF-16, Windows-1252/ISO-8859-1 for ä ö å), the header row
  (account info above it is skipped), date format (`2024-03-04`, `04.03.2024`, `03/04/2024`, `4 Mar 2024`, Excel dates), number format
  (`1,234.56` vs `1.234,56`, spaces, `(12.50)`, trailing minus), and which columns hold date, description, amount, debit/credit, direction, balance, currency.
  Header names in English, Finnish, Swedish, German, Turkish and others are recognised; adjust any guess in the form.
- **Amounts** can be one signed column, separate debit/credit columns, or an amount plus a direction column (DBIT/CRDT, D/C…).
  A *Flip signs* switch covers files where expenses are positive.
- **Excel:** multi-sheet workbooks (pick the sheet), title rows above the header, real date cells and text dates. Old `.xls` is not supported (Save As .xlsx or CSV).
  Only cell values are read: formulas are not evaluated, so use a file saved by Excel with results cached.
- **Accounts:** import into an existing account or create a new one. A name that matches an existing account reuses it, so monthly statements accumulate in one place.
- **Balances stay correct.** For an account your bank syncs, rows older than the first synced transaction are added as history and the opening balance is
  shifted so today's balance is unchanged. For an imported account, enter the balance after the last row (or map the Balance column) and the account is anchored to it,
  but only if the file reaches the account's latest date, so an old statement can never overwrite today's balance. Without a balance, a new account starts from zero.
- **Duplicates:** rows already in your data are skipped (same date, amount and text), so importing a file twice is harmless. Same date and amount with different text
  is a *possible duplicate*, and rows inside the bank-synced period are *overlap*; both are skipped unless you tick them in the preview.
- **Categories** come from your rules. If the file has a category column you can use it where it matches one of your categories.
  Anything unrecognised lands in *Review*.
- **Undo** any import from the Import page: it removes exactly the transactions that import added and restores the balance (newest import first, per account).
  Your column mapping is remembered for files with the same headers.
- CLI: `node cli.js import <file> --account "<name>" [--currency EUR] [--balance N] [--use-category] [--yes]` (preview unless `--yes`), `node cli.js imports`, `node cli.js undo-import <id>`.
- Rows with a currency different from the account's are rejected rather than silently mixed; rows that cannot be read are listed in the preview with the reason.

## Backups

**Excel copy:** *Backups → Download Excel copy* gives you a spreadsheet with every transaction, today's balances and spending per category per month. Tick *Also save an Excel copy* to write one beside every local backup. The `.bak` file stays the real backup (it holds rules, goals and settings and restores exactly, and is encrypted with your passphrase); the Excel copy is for reading and is not encrypted.
Everything lives in `data/`, so backing up means copying it safely. *Settings → Backups* does that automatically.

- **What is backed up:** your whole `data/` folder (transactions, imports and import mappings, rules, budgets, manual assets and their history, holdings, journals).
  **Never backed up:** your bank session, saved credentials (`secrets.json`), the password hash, the Google token and the backup passphrase
  (keep your Enable Banking `.pem` somewhere safe yourself). After restoring on a new machine, reconnect your bank.
- **Schedule:** off, daily, weekly, or whenever data changes (checked every 10 minutes while Pennystead runs). Scheduled runs skip when nothing
  changed, and a failed run retries after an hour. *Back up now* always runs. The sidebar shows the last backup, or a warning if it is failing.
- **Encryption:** set a passphrase (AES-256-GCM, key derived with scrypt). **Uploads to Google Drive are refused without one**
  (override only with `BACKUP_ALLOW_PLAINTEXT_CLOUD=1`). Lose the passphrase and encrypted backups are unrecoverable.
- **Local folder:** defaults to `data/backups`, which is on the same disk, so point it at another drive or a folder synced by
  Google Drive for desktop / Dropbox / iCloud. That is also the zero-setup way to get "Drive" backups. Each backup is read back and verified.
- **Google Drive (built-in API upload):** one-time setup, about 5 minutes. Enter the credentials under *Settings → Connections*:
  1. console.cloud.google.com → new project → enable the **Google Drive API**.
  2. OAuth consent screen → External → add yourself as a test user → **Publish app**. If you leave it in "Testing", Google expires the
     connection every 7 days. The "unverified app" warning is normal for personal use.
  3. Credentials → Create OAuth client ID → **Desktop app**.
  4. Paste the client ID and secret into *Settings → Connections*, then *Backups → Connect Google Drive*.

  Pennystead requests only the `drive.file` scope: it can see just the "Pennystead Backups" folder it creates, never the rest of your Drive.
  Disconnecting revokes the token; existing backups stay in your Drive.
- **Retention:** keep the last N per destination (defaults 14 local, 30 Drive). Safety copies made before a restore are kept separately.
- **Restore:** from the list (local or Drive) or by uploading a file. A safety copy of your current data is saved first, and your backup
  settings are kept as they are. A restore replaces the contents of `data/`, so anything else you keep in that folder is replaced too (it is in the safety copy).
  CLI: `node cli.js backup`, `node cli.js backups`, `node cli.js restore <file>`.

## Savings goals
Goals page: a target, an optional date, and what it tracks: liquid net worth, net worth, or specific accounts.
- **Several accounts per goal**, and **one account shared by several goals**: each goal takes "up to an amount",
  "a percentage" or "what is left" of an account. Percentages come first, then fixed amounts in goal order, then the
  rest is shared equally by the "what is left" goals, so the same money is never counted twice. "Where your goal money
  sits" shows how each account is divided.
- **Starting point**: count what is already there, or only what you add from the day the goal is set up.
- Progress uses your real month-end balances; the projection continues your pace of the last 6 months (or a monthly
  amount you set, with an optional yearly return). Each goal says on track / behind / reached and the monthly amount
  needed for its deadline, and is checked automatically at the start of every month (track record on the Goals page).

## Chat with your data (MCP)
The installed app is its own MCP server: run `Pennystead --mcp` (add `--write` to allow recording valuations, `--data-dir <dir>` for a custom data folder). The easiest route is Settings → **Chat with AI**, which shows the exact config for your install to paste into Claude Desktop, or a one-line command for Claude Code. From source: `node mcp.js` (Node 20+); it reads the same data folder as the app.
**Guided reviews:** the server also offers MCP prompts, which Claude Desktop shows in its + menu under Pennystead: Monthly money review, Find money I am wasting, Budget check-up, Net worth report and Tidy up my categories.

Read-only tools: `net_worth`, `net_worth_history`, `overview`, `manual_assets`, `monthly_summary`, `spending_by_category`,
`budget_status`, `search_transactions`, `subscriptions`, `anomalies`, `review_queue`, `hledger_query`.
Set `MCP_WRITE=1` to also expose `record_valuation` ("my car is worth 15,500 now"), which only writes `manual-assets.json`.

**Privacy:** whatever the tools return is sent to your AI provider. `REDACT=light` (default) masks IBANs, emails and long
numbers; `REDACT=full` also replaces merchant and asset names with stable aliases and disables `hledger_query`.

## How detection works (and its limits)
- **Subscriptions:** merchants charged at a regular interval with similar amounts. Flags: price increase, new, duplicate charge,
  overlapping services (3+ in one category), costly (≥300/yr), lapsed. It can't know whether you *use* a service.
- **Anomalies:** unusually large for the category (3σ), first-time merchants above your 95th percentile, duplicate charges within
  3 days, month-to-date category spikes (1.5× the 3-month average), price hikes. Needs ~3 months of history.
- **Monthly budgets** are compared with each period and scaled for week/quarter/year views. **Yearly budgets** are not split into 12ths
  (lumpy spending like holidays or gadgets would look wrong): they track year-to-date spend against the annual amount, with a pro-rata
  "even pace" marker and a linear year-end projection, and are kept out of the monthly over/under total. A parent category whose
  children mix monthly and yearly budgets is rolled up as monthly equivalents (yearly ÷ 12).
- Budget projections are linear, so front-loaded charges can look "on pace to exceed" early in the month or year.
- Net worth history values each date at the latest price known *on or before* that date; before an asset's first recorded
  value it is not counted, so record an early valuation (or acquired date + cost) if you want the history to go back further.
- Investment gain uses today's FX rate for both value and cost, so it equals the local-currency return.
- Multi-currency bank transactions are not converted; analysis assumes bank accounts are in the base currency.
- The generated `.journal` files are ASCII-only (ä→a, ş→s) because hledger reads files using the machine's locale and one stray character would break every report.
  Your real names are kept in `transactions.json` and shown in the dashboard; only the hledger command line sees the folded text.
- Google Drive backups were tested against a local mock of Google's OAuth/Drive endpoints, not live Google. Local backups, encryption and restore were tested for real.
- Not built yet: an in-dashboard "Ask" chat. Use the MCP server from Claude for now.

## Run from source, Docker, and building the app

```
git clone https://github.com/Adamkyl69/Pennystead && cd Pennystead
npm start            # needs Node 20+; opens http://localhost:3456
npm run demo         # sample data in ./data-demo
npm test             # 100+ tests; engine-parity tests run when hledger is installed
npm run build        # builds a single-file executable for THIS operating system into dist/
node scripts/package.js   # wraps it into the download for this OS (release/)
node scripts/smoke.js dist/pennystead   # starts the build and drives it over HTTP
```

- **Releases:** push a version tag (`git tag v1.0.0 && git push --tags`). GitHub Actions (`.github/workflows/release.yml`) builds Windows, macOS (Apple Silicon and Intel) and Linux on their own operating systems, smoke-tests each, builds the Windows installer and macOS disk image, and publishes everything with checksums. The workflows live in `.github/workflows` and run automatically on GitHub.
- **Docker / home server:** `PENNYSTEAD_PASSWORD=choose-a-password docker compose up -d`, then open http://localhost:3456. The container refuses to start without a password. To reach it from other devices, use a VPN such as Tailscale and list the name you browse to in `PENNYSTEAD_ALLOWED_HOSTS`. Do not expose it to the open internet.
- **Signing:** builds are unsigned. For wide public distribution, add a Windows code-signing certificate and an Apple Developer ID (notarization) to the release workflow.
- The single-file executable embeds the Node.js runtime (about 120 MB, MIT licence).

## Limits and honest notes
- Bank sync was written against Enable Banking's documented API but has not been run against the live service in testing; check it with their free sandbox first. Their redirect-URL rules for `http://localhost` should be confirmed when you register.
- Windows and macOS builds are produced and smoke-tested by the release workflow on those systems; the Linux build is also tested by hand.
- Google Drive backups are tested against a local stand-in for Google's API, not live Google.
- Not built yet: an in-dashboard "Ask" chat (use the MCP server from Claude), automatic updates, brokerage import.
