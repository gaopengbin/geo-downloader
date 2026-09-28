; Independent, per-user GeoD CLI installer. Payload is supplied only by the
; verified portable ZIP builder; this is unrelated to the desktop installer.
#ifndef PackageDir
  #error PackageDir is required
#endif
#ifndef PackageSha256
  #error PackageSha256 is required
#endif
#ifndef CliVersion
  #error CliVersion is required
#endif

[Setup]
AppId={{692CB25C-EC2D-446A-BB70-972F89073D63}
AppName=GeoD CLI
AppVersion={#CliVersion}
AppPublisher=GeoD
AppPublisherURL=https://geod.laogao.xyz/
AppSupportURL=https://github.com/gaopengbin/geo-downloader/issues
DefaultDirName={localappdata}\Programs\GeoD CLI
DefaultGroupName=GeoD CLI
DisableProgramGroupPage=yes
DisableDirPage=no
UsePreviousAppDir=no
UsePreviousTasks=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
ChangesEnvironment=yes
CloseApplications=no
RestartApplications=no
SetupMutex=GeoDCLI_PerUserSetup_692CB25C
UninstallDisplayName=GeoD CLI {#CliVersion}
UninstallDisplayIcon={app}\geod.exe
OutputBaseFilename=geod-cli-{#CliVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile={#PackageDir}\LICENSE
InfoAfterFile={#PackageDir}\README.txt
Uninstallable=yes
VersionInfoVersion={#CliVersion}.0

[Tasks]
Name: userpath; Description: "Add GeoD CLI to my user PATH (open a new terminal after setup)"; Flags: checkedonce

[Files]
Source: "{#PackageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\GeoD CLI Readme"; Filename: "{app}\README.txt"

[Registry]
Root: HKCU; Subkey: "Software\GeoD\CLI\Installer"; ValueType: string; ValueName: InstallDir; ValueData: "{app}"; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\GeoD\CLI\Installer"; ValueType: string; ValueName: PackageSha256; ValueData: "{#PackageSha256}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\GeoD\CLI\Installer"; ValueType: string; ValueName: PathToken; ValueData: "{app}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\GeoD\CLI\Installer"; ValueType: dword; ValueName: PathOwned; ValueData: 0; Flags: uninsdeletevalue

[Code]
const
  OwnerKey = 'Software\GeoD\CLI\Installer';
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{692CB25C-EC2D-446A-BB70-972F89073D63}_is1';
  FileAttributeReparsePoint = $400;
  InvalidFileAttributes = $FFFFFFFF;

var
  AddedPath, FinishedSetup: Boolean;
  AddedToken, UninstallToken: String;
  UninstallOwnsPath: Boolean;

function ExpandEnvironmentStrings(Source, Destination: String; Size: LongWord): LongWord;
  external 'ExpandEnvironmentStringsW@kernel32.dll stdcall';
function GetFileAttributes(Path: String): LongWord;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function NormalizePath(Token: String): String;
var
  Buffer: String;
  Size: LongWord;
begin
  Token := Trim(Token);
  if (Length(Token) >= 2) and (Token[1] = '"') and (Token[Length(Token)] = '"') then
    Token := Copy(Token, 2, Length(Token) - 2);
  SetLength(Buffer, 32768);
  Size := ExpandEnvironmentStrings(Token, Buffer, Length(Buffer));
  if (Size > 0) and (Size <= 32768) then begin
    SetLength(Buffer, Size - 1);
    Token := Buffer;
  end;
  StringChangeEx(Token, '/', '\', True);
  while (Length(Token) > 3) and (Token[Length(Token)] = '\') do
    Delete(Token, Length(Token), 1);
  Result := Lowercase(Token);
end;

function HasPathToken(Paths, Token: String): Boolean;
var
  StartAt, EndAt: Integer;
begin
  Result := False;
  Token := NormalizePath(Token);
  StartAt := 1;
  while StartAt <= Length(Paths) + 1 do begin
    EndAt := StartAt;
    while (EndAt <= Length(Paths)) and (Paths[EndAt] <> ';') do EndAt := EndAt + 1;
    if NormalizePath(Copy(Paths, StartAt, EndAt - StartAt)) = Token then begin
      Result := True;
      Exit;
    end;
    StartAt := EndAt + 1;
  end;
end;

function ReadUserPath(var Value: String): Boolean;
begin
  Value := '';
  Result := not RegValueExists(HKCU, 'Environment', 'Path');
  if not Result then Result := RegQueryStringValue(HKCU, 'Environment', 'Path', Value);
end;

function RemoveOwnedPath(Token: String): Boolean;
var
  OldPath, CheckPath, NewPath: String;
  StartAt, EndAt, Attempt: Integer;
  Found: Boolean;
begin
  Result := False;
  for Attempt := 1 to 3 do begin
    if not ReadUserPath(OldPath) then Exit;
    NewPath := OldPath;
    StartAt := 1;
    Found := False;
    while StartAt <= Length(OldPath) do begin
      EndAt := StartAt;
      while (EndAt <= Length(OldPath)) and (OldPath[EndAt] <> ';') do EndAt := EndAt + 1;
      { Exact token only: never remove an equivalent entry the user rewrote. }
      if Copy(OldPath, StartAt, EndAt - StartAt) = Token then begin
        if StartAt > 1 then Delete(NewPath, StartAt - 1, EndAt - StartAt + 1)
        else if EndAt <= Length(OldPath) then Delete(NewPath, StartAt, EndAt - StartAt + 1)
        else NewPath := '';
        Found := True;
        Break;
      end;
      StartAt := EndAt + 1;
    end;
    if not Found then begin
      Log('Owned PATH token is absent or was edited; other entries are preserved.');
      Result := True;
      Exit;
    end;
    if not ReadUserPath(CheckPath) then Exit;
    if CheckPath = OldPath then begin
      { RegWriteStringValue preserves an existing REG_EXPAND_SZ value type. }
      Result := RegWriteStringValue(HKCU, 'Environment', 'Path', NewPath);
      Exit;
    end;
  end;
end;

function AddUserPath(Token: String): Boolean;
var
  OldPath, CheckPath, NewPath: String;
  Attempt: Integer;
begin
  Result := False;
  for Attempt := 1 to 3 do begin
    if not ReadUserPath(OldPath) then Exit;
    if HasPathToken(OldPath, Token) then begin
      Log('Install directory already exists in user PATH; installer does not own it.');
      Result := True;
      Exit;
    end;
    if OldPath = '' then NewPath := Token else NewPath := OldPath + ';' + Token;
    if Length(NewPath) > 32760 then Exit;
    if not ReadUserPath(CheckPath) then Exit;
    if CheckPath = OldPath then begin
      { Record ownership first. Failed writes never claim success. }
      if not RegWriteDWordValue(HKCU, OwnerKey, 'PathOwned', 1) then Exit;
      if not RegWriteStringValue(HKCU, 'Environment', 'Path', NewPath) then begin
        RegWriteDWordValue(HKCU, OwnerKey, 'PathOwned', 0);
        Exit;
      end;
      AddedPath := True;
      AddedToken := Token;
      Result := True;
      Exit;
    end;
  end;
end;

function NonEmptyDirectory(Path: String): Boolean;
var
  Entry: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(Path) + '*', Entry) then begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') then begin
          Result := True;
          Break;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
end;

function DestinationProblem(Path: String): String;
var
  Parent: String;
  Attributes: LongWord;
begin
  Result := '';
  if (Length(Path) < 4) or (Length(Path) > 220) or (Copy(Path, 2, 2) <> ':\') or
     (Pos(';', Path) > 0) or (Pos('%', Path) > 0) or (Pos('"', Path) > 0) then begin
    Result := 'Choose a local, non-root folder (at most 220 characters, without semicolons, percent signs or quotes).';
    Exit;
  end;
  Parent := Path;
  while Length(Parent) > 3 do begin
    Attributes := GetFileAttributes(Parent);
    if (Attributes <> InvalidFileAttributes) and ((Attributes and FileAttributeReparsePoint) <> 0) then begin
      Result := 'Choose a real directory. Symbolic links and directory junctions are not supported.';
      Exit;
    end;
    Parent := ExtractFileDir(Parent);
  end;
  if FileExists(Path) or NonEmptyDirectory(Path) then
    Result := 'This folder is not empty. Existing files will not be overwritten. Choose an empty folder, or uninstall the previous GeoD CLI installation first.';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  UserPath: String;
begin
  Result := '';
  if RegKeyExists(HKCU, UninstallKey) or RegValueExists(HKCU, OwnerKey, 'InstallDir') then begin
    Result := 'GeoD CLI is already registered for this user. Uninstall it through Windows Settings before installing again. The desktop GeoD app is separate.';
    Exit;
  end;
  Result := DestinationProblem(ExpandConstant('{app}'));
  if Result <> '' then Exit;
  if WizardIsTaskSelected('userpath') and not ReadUserPath(UserPath) then
    Result := 'The user PATH could not be read safely. Cancel, or go back and disable the PATH option.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('userpath') then
    if not AddUserPath(ExpandConstant('{app}')) then
      RaiseException('GeoD CLI could not update the user PATH. Installation did not complete. See the setup log.');
  if CurStep = ssDone then FinishedSetup := True;
end;

procedure DeinitializeSetup;
begin
  if AddedPath and not FinishedSetup then
    if not RemoveOwnedPath(AddedToken) then
      Log('PATH rollback could not finish; remove only the GeoD CLI install directory from your user PATH.');
end;

function InitializeUninstall: Boolean;
var
  OwnerDir: String;
  Owned: Cardinal;
begin
  Result := True;
  UninstallOwnsPath := False;
  if RegQueryStringValue(HKCU, OwnerKey, 'InstallDir', OwnerDir) and
     (NormalizePath(OwnerDir) = NormalizePath(ExpandConstant('{app}'))) and
     RegQueryDWordValue(HKCU, OwnerKey, 'PathOwned', Owned) and (Owned = 1) then
    UninstallOwnsPath := RegQueryStringValue(HKCU, OwnerKey, 'PathToken', UninstallToken) and
      (UninstallToken = OwnerDir);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and UninstallOwnsPath then
    if not RemoveOwnedPath(UninstallToken) then
      RaiseException('The user PATH could not be updated safely. Close other environment editors and retry uninstall.');
end;
