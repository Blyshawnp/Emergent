; ================================================================
; Mock Testing Suite v3.0 — Inno Setup Installer Script
; ================================================================
; To use: 
;   1. Run build_exe.bat first (creates dist\MockTestingSuite)
;   2. Install Inno Setup from jrsoftware.org/isinfo.php
;   3. Open this file in Inno Setup
;   4. Click Build > Compile (Ctrl+F9)
; ================================================================

[Setup]
AppName=Mock Testing Suite
AppVersion=3.0.0
AppPublisher=Shawn P. Bly
DefaultDirName={autopf}\MockTestingSuite
DefaultGroupName=Mock Testing Suite
OutputBaseFilename=MockTestingSuite_v3_Setup
OutputDir=installer_output
Compression=lzma2/ultra64
SolidCompression=yes
SetupIconFile=frontend\assets\favicon.ico
UninstallDisplayIcon={app}\favicon.ico
WizardStyle=modern
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a Desktop shortcut"; GroupDescription: "Additional icons:"; Flags: checkedonce

[Files]
Source: "dist\MockTestingSuite\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\MockTestingSuite\data\*"; DestDir: "{app}\data"; Flags: ignoreversion recursesubdirs createallsubdirs; Permissions: users-modify

[Icons]
Name: "{group}\Mock Testing Suite"; Filename: "{app}\MockTestingSuite.exe"; IconFilename: "{app}\favicon.ico"
Name: "{group}\Uninstall Mock Testing Suite"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Mock Testing Suite"; Filename: "{app}\MockTestingSuite.exe"; IconFilename: "{app}\favicon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\MockTestingSuite.exe"; Description: "Launch Mock Testing Suite now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}\__pycache__"
