Pennystead: your private finance dashboard
======================================

Pennystead shows your accounts, spending, budgets, subscriptions and net worth in one place.
Everything stays on THIS computer. Pennystead has no account, no cloud service and no tracking.

START
  Windows : run Pennystead (Start menu, or Pennystead.exe).
  macOS   : open Pennystead.app.
  Linux   : run ./pennystead (or install.sh for a menu entry).
Your web browser opens Pennystead. On Windows and Linux a small window stays open while Pennystead runs;
close it (or use Settings > Security > Quit Pennystead) to stop. If you start Pennystead twice, the second
start just reopens the first.

FIRST STEPS
  1. Import a CSV or Excel statement from your bank (Import), or
  2. connect your bank for automatic syncing (Settings > Connections), or
  3. add things you own or owe by hand (Assets, Liabilities), or
  4. explore with sample data (the welcome screen), which you can clear in one click.
Then turn on encrypted backups (Settings > Backups).

"WINDOWS PROTECTED YOUR PC" / "CANNOT BE OPENED BECAUSE THE DEVELOPER CANNOT BE VERIFIED"
  This build is not signed with a paid developer certificate, so your system warns about it.
  Windows : click "More info", then "Run anyway".
  macOS   : right-click Pennystead.app, choose Open, then Open again. (Or: System Settings > Privacy & Security > Open Anyway.)
  You only need to do this once. You can check the download against the checksums published with it.

YOUR DATA
  Windows : %APPDATA%\Pennystead
  macOS   : ~/Library/Application Support/Pennystead
  Linux   : ~/.local/share/pennystead
  Uninstalling Pennystead does NOT delete this folder. Copy it, or use Backups, to move to another computer.

PRIVACY AND SECURITY
  Pennystead only listens on this computer. It contacts the internet only for the services you set up:
  your bank (via Enable Banking), Alpha Vantage (prices) and Google Drive (backups).
  Set a password in Settings > Security if other people use this computer.

Includes Node.js (MIT licence): https://github.com/nodejs/node/blob/main/LICENSE
