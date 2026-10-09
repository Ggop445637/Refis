; Установщик Refis (Inno Setup 6). Сборка: iscc /DAppVersion=2.0.0 installer\refis.iss
#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif

[Setup]
AppId={{8C4F1A52-6B1E-4C7E-9A1D-2F5B7E3C9D10}
AppName=Refis
AppVersion={#AppVersion}
AppVerName=Refis {#AppVersion}
AppPublisher=Refis
DefaultDirName={localappdata}\Programs\Refis
DefaultGroupName=Refis
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Refis-Setup-{#AppVersion}
SetupIconFile=..\assets\refis.ico
UninstallDisplayIcon={app}\Refis.exe
UninstallDisplayName=Refis
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
LicenseFile=..\LICENSE
ShowLanguageDialog=auto

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\Refis\*"; DestDir: "{app}"; Excludes: "data\*"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Refis"; Filename: "{app}\Refis.exe"
Name: "{autodesktop}\Refis"; Filename: "{app}\Refis.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Refis.exe"; Description: "{cm:LaunchProgram,Refis}"; Flags: nowait postinstall skipifsilent
