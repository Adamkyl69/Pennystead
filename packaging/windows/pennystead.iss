; Inno Setup script: per-user install (no administrator rights), Start menu entry, optional desktop shortcut, clean uninstall.
; Built in CI: iscc /DAppVersion=1.0.0 packaging\windows\pennystead.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
[Setup]
AppId={{5E0C7B1A-3D84-4F52-9A6E-C1B8D2F47A93}
AppName=Pennystead
AppVersion={#AppVersion}
AppPublisher=Pennystead
DefaultDirName={autopf}\Pennystead
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\release
OutputBaseFilename=Pennystead-{#AppVersion}-windows-x64-setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\pennystead.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked
[Files]
Source: "..\..\dist\pennystead.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.txt"; DestDir: "{app}"; Flags: ignoreversion
[Icons]
Name: "{autoprograms}\Pennystead"; Filename: "{app}\pennystead.exe"; IconFilename: "{app}\pennystead.exe"
Name: "{autodesktop}\Pennystead"; Filename: "{app}\pennystead.exe"; Tasks: desktopicon
[Run]
Filename: "{app}\pennystead.exe"; Description: "Start Pennystead now"; Flags: nowait postinstall skipifsilent
; In-app update (silent install with /RELAUNCH=1): start the new version again; its open window reloads by itself.
Filename: "{app}\pennystead.exe"; Parameters: "--updated"; Flags: nowait; Check: Relaunch
[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM pennystead.exe /F"; Flags: runhidden; RunOnceId: "StopPennystead"
[Messages]
FinishedLabel=Pennystead is installed. Your data is kept in %APPDATA%\Pennystead and is not removed if you uninstall.
[Code]
function Relaunch(): Boolean;
begin
  Result := ExpandConstant('{param:RELAUNCH|0}') = '1';
end;
