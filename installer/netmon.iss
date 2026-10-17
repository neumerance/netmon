; NetMon installer for Windows 10/11 x64 (Inno Setup 6.3 or newer).
;
; Build (from the repository root, on Windows):
;   npm ci && npm --prefix server ci && npm --prefix web ci && npm run build:exe   -> dist-exe\NetMon.exe
;   download WinSW v2.12.0 WinSW-x64.exe to installer\build\WinSW-x64.exe            (see .github/workflows/windows.yml)
;   iscc /DAppVersion=1.0.0 installer\netmon.iss                                     -> installer\Output\NetMon-Setup-1.0.0.exe
;
; What it does:
;   - installs NetMon.exe + WinSW (as NetMonService.exe) to {autopf}\NetMon and registers the "NetMon" Windows service
;     (automatic, delayed start; restarts on failure; logs in %ProgramData%\NetMon\logs)
;   - keeps the data in %ProgramData%\NetMon (Administrators + SYSTEM full control, Users read-only); the data is
;     only deleted on uninstall when the user answers Yes to "Also delete NetMon data?"
;   - network page: "Allow other devices on your network to open NetMon" (HOST=0.0.0.0 + NETMON_ALLOW_LAN=1 and a
;     firewall rule for the port, optionally NETMON_TOKEN) or this PC only (HOST=127.0.0.1); port 1024-65535
;   - Windows Defender Firewall rules for NetMon.exe (local subnet, Private + Domain profiles): the dashboard port
;     (LAN access only) and the UDP discovery traffic (mDNS 5353, SSDP 1900, NetBIOS 137)
;   - Start Menu: Open NetMon, NetMon logs, Uninstall NetMon
;
; Unattended install: NetMon-Setup-x.y.z.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART [/LAN=0|1] [/TOKEN=0|1] [/PORT=4000]
; (defaults: the previous install's choices, otherwise LAN=1 TOKEN=1 PORT=4000). A silent uninstall keeps the data.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
; VersionInfoVersion must be numeric: "1.2.3-beta.1" / "0.0.0-abc1234" -> "1.2.3" / "0.0.0".
#if Pos("-", AppVersion) > 0
  #define AppVersionNumeric Copy(AppVersion, 1, Pos("-", AppVersion) - 1)
#else
  #define AppVersionNumeric AppVersion
#endif
#ifndef NetMonExe
  #define NetMonExe "..\dist-exe\NetMon.exe"
#endif
#ifndef WinSWExe
  #define WinSWExe "build\WinSW-x64.exe"
#endif

[Setup]
AppId={{8C3F5E2A-6B1D-4F7E-9A42-3D5C7B9E1F60}
AppName=NetMon
AppVersion={#AppVersion}
AppVerName=NetMon {#AppVersion}
AppPublisher=NetMon
AppPublisherURL=https://github.com/neumerance/netmon
AppSupportURL=https://github.com/neumerance/netmon/issues
AppUpdatesURL=https://github.com/neumerance/netmon/releases
VersionInfoVersion={#AppVersionNumeric}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoDescription=NetMon Setup
DefaultDirName={autopf}\NetMon
DefaultGroupName=NetMon
DisableProgramGroupPage=yes
DisableDirPage=auto
UsePreviousAppDir=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=Output
OutputBaseFilename=NetMon-Setup-{#AppVersion}
SetupIconFile=netmon.ico
UninstallDisplayIcon={app}\netmon.ico
UninstallDisplayName=NetMon
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
SetupLogging=yes
; The service is stopped in PrepareToInstall, so the Restart Manager has nothing to close.
CloseApplications=no
RestartIfNeededByRun=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Dirs]
; Data + logs outlive the program; the ACL is tightened in [Code] (SecureDataDir).
Name: "{commonappdata}\NetMon"; Flags: uninsneveruninstall
Name: "{commonappdata}\NetMon\logs"; Flags: uninsneveruninstall

[Files]
Source: "{#NetMonExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#WinSWExe}"; DestDir: "{app}"; DestName: "NetMonService.exe"; Flags: ignoreversion
Source: "netmon.ico"; DestDir: "{app}"; Flags: ignoreversion
; Service definition template, rendered to {app}\NetMonService.xml by WriteServiceConfig.
Source: "NetMonService.xml"; Flags: dontcopy
; Third-party licences (WinSW, Node.js) fetched by the build; optional for local builds.
Source: "build\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion skipifsourcedoesntexist

[INI]
; Internet shortcut with the chosen port (and access token, if any).
Filename: "{group}\Open NetMon.url"; Section: "InternetShortcut"; Key: "URL"; String: "{code:GetLocalUrl}"
Filename: "{group}\Open NetMon.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\netmon.ico"
Filename: "{group}\Open NetMon.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\NetMon logs"; Filename: "{commonappdata}\NetMon\logs"
Name: "{group}\Uninstall NetMon"; Filename: "{uninstallexe}"

[Run]
Filename: "{code:GetLocalUrl}"; Description: "Open NetMon now"; Flags: postinstall shellexec nowait skipifsilent runasoriginaluser

[UninstallDelete]
Type: files; Name: "{group}\Open NetMon.url"
Type: files; Name: "{app}\NetMonService.xml"
Type: files; Name: "{app}\*.log"
Type: dirifempty; Name: "{app}"

[Code]
const
  ServiceName = 'NetMon';
  DefaultPort = 4000;
  RuleWeb = 'NetMon - Web dashboard (TCP-In)';
  RuleMdns = 'NetMon - mDNS (UDP-In)';
  RuleSsdpNotify = 'NetMon - SSDP announcements (UDP-In)';
  RuleSsdpReply = 'NetMon - SSDP replies (UDP-In)';
  RuleNetbios = 'NetMon - NetBIOS replies (UDP-In)';

var
  NetPage: TWizardPage;
  LanCheck, TokenCheck: TNewCheckBox;
  PortEdit: TNewEdit;
  { Configuration fixed in PrepareToInstall }
  CfgLan, CfgUseToken: Boolean;
  CfgPort: Integer;
  CfgToken, CfgLanIp: String;

{ ------------------------------------------------------------------ helpers }

function Sys(const Name: String): String;
begin
  Result := ExpandConstant('{sys}\') + Name;
end;

function DataDir(): String;
begin
  Result := ExpandConstant('{commonappdata}\NetMon');
end;

function LogDir(): String;
begin
  Result := DataDir() + '\logs';
end;

function BoolTo01(B: Boolean): String;
begin
  if B then Result := '1' else Result := '0';
end;

function RunHidden(const Exe, Params: String): Integer;
var
  RC: Integer;
begin
  if Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, RC) then
    Result := RC
  else
    Result := -1;
  if Pos('Token', Params) > 0 then
    Log(Format('exec: %s (parameters not logged) -> %d', [Exe, Result]))
  else
    Log(Format('exec: %s %s -> %d', [Exe, Params, Result]));
end;

{ Runs a PowerShell snippet. The snippet must not contain double quotes. }
function RunPowerShell(const Script: String): Integer;
begin
  Result := RunHidden(Sys('WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"');
end;

{ A path as a single-quoted PowerShell string literal. }
function PsQuote(S: String): String;
begin
  StringChangeEx(S, '''', '''''', True);
  Result := '''' + S + '''';
end;

function IsDigits(const S: String): Boolean;
var
  I: Integer;
begin
  Result := Length(S) > 0;
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then Result := False;
end;

{ 1024..65535, or -1 }
function ParsePort(S: String): Integer;
begin
  S := Trim(S);
  Result := -1;
  if IsDigits(S) and (Length(S) <= 5) then
  begin
    Result := StrToIntDef(S, -1);
    if (Result < 1024) or (Result > 65535) then Result := -1;
  end;
end;

{ base64url, 16..128 characters: safe in XML attributes and URLs }
function IsValidToken(const S: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := (Length(S) >= 16) and (Length(S) <= 128);
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if not (((C >= 'A') and (C <= 'Z')) or ((C >= 'a') and (C <= 'z')) or ((C >= '0') and (C <= '9')) or (C = '-') or (C = '_')) then
      Result := False;
  end;
end;

function ReadTempText(const FileName: String): String;
var
  S: AnsiString;
begin
  Result := '';
  if LoadStringFromFile(FileName, S) then Result := Trim(String(S));
  DeleteFile(FileName);
end;

{ 18 random bytes from the OS CSPRNG -> 24 base64url characters }
function GenerateToken(): String;
var
  F: String;
begin
  F := ExpandConstant('{tmp}\netmon-token.txt');
  RunPowerShell('$b = New-Object byte[] 18; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ' +
    '[IO.File]::WriteAllText(' + PsQuote(F) + ', [Convert]::ToBase64String($b).TrimEnd(''='').Replace(''+'', ''-'').Replace(''/'', ''_''))');
  Result := ReadTempText(F);
  if not IsValidToken(Result) then Result := '';
end;

{ Keep the token of the previous install so browsers that already stored it keep working. }
function ReadExistingToken(): String;
var
  Xml: AnsiString;
  S, Marker: String;
  P: Integer;
begin
  Result := '';
  if not LoadStringFromFile(ExpandConstant('{app}\NetMonService.xml'), Xml) then Exit;
  S := String(Xml);
  Marker := 'name="NETMON_TOKEN" value="';
  P := Pos(Marker, S);
  if P = 0 then Exit;
  S := Copy(S, P + Length(Marker), 200);
  P := Pos('"', S);
  if P = 0 then Exit;
  S := Copy(S, 1, P - 1);
  if IsValidToken(S) then Result := S;
end;

{ IPv4 address of the adapter that has the default gateway (shown on the Finish page) }
function DetectLanIp(): String;
var
  F: String;
begin
  F := ExpandConstant('{tmp}\netmon-ip.txt');
  RunPowerShell('$c = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq ''Up'' } | Select-Object -First 1; ' +
    'if ($c -and $c.IPv4Address) { [IO.File]::WriteAllText(' + PsQuote(F) + ', [string]$c.IPv4Address[0].IPAddress) }');
  Result := ReadTempText(F);
  if (Length(Result) < 7) or (Length(Result) > 15) then Result := '';
end;

function TokenQuery(): String;
begin
  if CfgToken <> '' then Result := '?token=' + CfgToken else Result := '';
end;

function GetLocalUrl(Param: String): String;
begin
  Result := 'http://localhost:' + IntToStr(CfgPort) + '/' + TokenQuery();
end;

function GetLanUrl(): String;
var
  Host: String;
begin
  Host := CfgLanIp;
  if Host = '' then Host := '<this PC''s IP address>';
  Result := 'http://' + Host + ':' + IntToStr(CfgPort) + '/' + TokenQuery();
end;

procedure ReportProblem(const Msg: String);
begin
  Log('PROBLEM: ' + Msg);
  SuppressibleMsgBox(Msg, mbError, MB_OK, IDOK);
end;

{ ------------------------------------------------------------------ service }

function ServiceExists(): Boolean;
begin
  { sc query: 0 = exists, 1060 = ERROR_SERVICE_DOES_NOT_EXIST }
  Result := RunHidden(Sys('sc.exe'), 'query ' + ServiceName) = 0;
end;

{ Asks the service to stop (WinSW sends Ctrl+C, NetMon flushes its data) and waits for it.
  Only if it is still running after 45 s: disable it (so the recovery actions cannot restart it) and kill it. }
function StopNetMonService(): Boolean;
var
  WaitScript: String;
begin
  WaitScript := '$s = Get-Service -Name ' + ServiceName + ' -ErrorAction SilentlyContinue; ' +
    'if ($s -and $s.Status -ne ''Stopped'') { try { $s.Stop() } catch {}; ' +
    'try { $s.WaitForStatus(''Stopped'', [TimeSpan]::FromSeconds(45)) } catch { exit 1 } }; exit 0';
  Result := RunPowerShell(WaitScript) = 0;
  if not Result then
  begin
    Log('NetMon service did not stop in time; forcing it');
    RunHidden(Sys('sc.exe'), 'config ' + ServiceName + ' start= disabled');
    RunHidden(Sys('taskkill.exe'), '/F /T /IM NetMonService.exe');
    RunHidden(Sys('taskkill.exe'), '/F /T /IM NetMon.exe');
    Result := RunPowerShell(WaitScript) = 0;
  end;
end;

function RunWinSW(const Command: String): Boolean;
begin
  Result := RunHidden(ExpandConstant('{app}\NetMonService.exe'), Command) = 0;
end;

function WaitForHealth(): Boolean;
var
  Header: String;
begin
  Header := '';
  if CfgToken <> '' then Header := '$q.Headers.Add(''X-NetMon-Token'', ''' + CfgToken + '''); ';
  Result := RunPowerShell('for ($i = 0; $i -lt 60; $i++) { try { ' +
    '$q = [Net.WebRequest]::Create(''http://127.0.0.1:' + IntToStr(CfgPort) + '/api/health''); $q.Proxy = $null; $q.Timeout = 2000; ' +
    Header + '$r = $q.GetResponse(); $c = [int]$r.StatusCode; $r.Close(); if ($c -eq 200) { exit 0 } } catch {}; ' +
    'Start-Sleep -Milliseconds 500 }; exit 1') = 0;
end;

{ ------------------------------------------------------------------ data folder, config, firewall }

{ Administrators + SYSTEM full control, Users read-only, no inherited entries: a normal user must not be able to
  drop a netmon.json there that opens NetMon to the LAN. The service (LocalSystem) can write data and logs. }
procedure SecureDataDir();
begin
  if RunHidden(Sys('icacls.exe'), '"' + DataDir() + '" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX"') <> 0 then
    ReportProblem('Setup could not restrict the permissions of ' + DataDir() + '. NetMon will still work; see the setup log for details.');
end;

procedure WriteServiceConfig();
var
  Xml: AnsiString;
  S, LanEnv: String;
begin
  ExtractTemporaryFile('NetMonService.xml');
  if not LoadStringFromFile(ExpandConstant('{tmp}\NetMonService.xml'), Xml) then
    RaiseException('Cannot read the service template');
  S := String(Xml);
  { LAN access: NetMon refuses a non-loopback HOST unless NETMON_ALLOW_LAN=1 (or a token) is set. }
  LanEnv := '';
  if CfgLan then
  begin
    LanEnv := '<env name="NETMON_ALLOW_LAN" value="1"/>';
    if CfgToken <> '' then
      LanEnv := LanEnv + #13#10 + '  <env name="NETMON_TOKEN" value="' + CfgToken + '"/>';
  end;
  StringChangeEx(S, '<!--@LAN_ENV@-->', LanEnv, True);
  if CfgLan then StringChangeEx(S, '@HOST@', '0.0.0.0', True) else StringChangeEx(S, '@HOST@', '127.0.0.1', True);
  StringChangeEx(S, '@PORT@', IntToStr(CfgPort), True);
  StringChangeEx(S, '@DATA_DIR@', DataDir(), True);
  StringChangeEx(S, '@LOG_DIR@', LogDir(), True);
  if not SaveStringToFile(ExpandConstant('{app}\NetMonService.xml'), AnsiString(S), False) then
    RaiseException('Cannot write ' + ExpandConstant('{app}\NetMonService.xml'));
end;

procedure DeleteFirewallRule(const Name: String);
begin
  { exit code 1 = no such rule, which is fine }
  RunHidden(Sys('netsh.exe'), 'advfirewall firewall delete rule name="' + Name + '"');
end;

procedure RemoveFirewallRules();
begin
  DeleteFirewallRule(RuleWeb);
  DeleteFirewallRule(RuleMdns);
  DeleteFirewallRule(RuleSsdpNotify);
  DeleteFirewallRule(RuleSsdpReply);
  DeleteFirewallRule(RuleNetbios);
end;

function AddFirewallRule(const Name, Protocol, Ports, Description: String): Boolean;
begin
  Result := RunHidden(Sys('netsh.exe'), 'advfirewall firewall add rule name="' + Name + '" dir=in action=allow enable=yes' +
    ' profile=private,domain remoteip=localsubnet protocol=' + Protocol + ' ' + Ports +
    ' program="' + ExpandConstant('{app}\NetMon.exe') + '" description="' + Description + '"') = 0;
end;

procedure ConfigureFirewall();
var
  Ok: Boolean;
begin
  RemoveFirewallRules();
  Ok := True;
  if CfgLan then
    Ok := AddFirewallRule(RuleWeb, 'TCP', 'localport=' + IntToStr(CfgPort), 'NetMon dashboard for other devices on the local network') and Ok;
  { Discovery: mDNS answers and announcements arrive on 5353; SSDP NOTIFY on 1900 and M-SEARCH answers from
    port 1900 to an ephemeral port; NetBIOS name answers from port 137. }
  Ok := AddFirewallRule(RuleMdns, 'UDP', 'localport=5353', 'NetMon device discovery (mDNS / Bonjour)') and Ok;
  Ok := AddFirewallRule(RuleSsdpNotify, 'UDP', 'localport=1900', 'NetMon device discovery (SSDP / UPnP announcements)') and Ok;
  Ok := AddFirewallRule(RuleSsdpReply, 'UDP', 'remoteport=1900', 'NetMon device discovery (SSDP / UPnP replies)') and Ok;
  Ok := AddFirewallRule(RuleNetbios, 'UDP', 'remoteport=137', 'NetMon device discovery (NetBIOS names)') and Ok;
  if not Ok then
    ReportProblem('Setup could not add all Windows Defender Firewall rules for NetMon. ' +
      'Device discovery or access from other devices may not work; see the setup log for details.');
end;

procedure InstallAndStartService();
begin
  if ServiceExists() then
  begin
    { Upgrade / re-run: the registration is kept. Re-enable it in case StopNetMonService had to disable it. }
    RunHidden(Sys('sc.exe'), 'config ' + ServiceName + ' start= delayed-auto');
  end
  else if not RunWinSW('install') then
  begin
    ReportProblem('Setup could not register the NetMon service. See ' + LogDir() + ' and the setup log.');
    Exit;
  end;

  WizardForm.StatusLabel.Caption := 'Starting NetMon...';
  if not RunWinSW('start') then
    ReportProblem('The NetMon service could not be started. See the logs in ' + LogDir() + '.')
  else if not WaitForHealth() then
    ReportProblem('The NetMon service started but does not answer on port ' + IntToStr(CfgPort) + ' yet ' +
      '(is another program using that port?). See the logs in ' + LogDir() + '.');
end;

{ ------------------------------------------------------------------ wizard }

procedure LanCheckClick(Sender: TObject);
begin
  TokenCheck.Enabled := LanCheck.Checked;
end;

function AddText(Top, Indent: Integer; const Text: String): TNewStaticText;
begin
  Result := TNewStaticText.Create(NetPage);
  Result.Parent := NetPage.Surface;
  Result.Left := Indent;
  Result.Top := Top;
  Result.Width := NetPage.SurfaceWidth - Indent;
  Result.AutoSize := False;
  Result.WordWrap := True;
  Result.Caption := Text;
  WizardForm.AdjustLabelHeight(Result);
end;

function AddCheck(Top, Indent: Integer; const Text: String; Checked: Boolean): TNewCheckBox;
begin
  Result := TNewCheckBox.Create(NetPage);
  Result.Parent := NetPage.Surface;
  Result.Left := Indent;
  Result.Top := Top;
  Result.Width := NetPage.SurfaceWidth - Indent;
  Result.Height := ScaleY(17);
  Result.Caption := Text;
  Result.Checked := Checked;
end;

procedure InitializeWizard();
var
  T: TNewStaticText;
  PortLabel: TNewStaticText;
  Y, Indent: Integer;
begin
  NetPage := CreateCustomPage(wpSelectDir, 'Network access', 'Choose who can open the NetMon dashboard.');
  Indent := ScaleX(18);

  LanCheck := AddCheck(0, 0, 'Allow other devices on your network to open NetMon',
    ExpandConstant('{param:LAN|' + GetPreviousData('LanAccess', '1') + '}') = '1');
  LanCheck.OnClick := @LanCheckClick;
  T := AddText(LanCheck.Top + LanCheck.Height + ScaleY(4), Indent,
    'NetMon listens on all network interfaces, and Windows Defender Firewall allows the port from your local ' +
    'subnet on Private and Domain networks. Untick to use NetMon on this PC only.');
  Y := T.Top + T.Height + ScaleY(10);

  TokenCheck := AddCheck(Y, Indent, 'Require an access token (recommended)',
    ExpandConstant('{param:TOKEN|' + GetPreviousData('UseToken', '1') + '}') = '1');
  T := AddText(TokenCheck.Top + TokenCheck.Height + ScaleY(4), Indent * 2,
    'Each device opens NetMon once with a link that contains the token (shown at the end of Setup and used by the ' +
    'Start Menu shortcut). Without a token, anyone on your network can rename or forget devices and change settings.');
  Y := T.Top + T.Height + ScaleY(18);

  PortLabel := AddText(Y + ScaleY(3), 0, 'Port:');
  PortLabel.Width := ScaleX(40);
  PortEdit := TNewEdit.Create(NetPage);
  PortEdit.Parent := NetPage.Surface;
  PortEdit.Left := ScaleX(44);
  PortEdit.Top := Y;
  PortEdit.Width := ScaleX(70);
  PortEdit.MaxLength := 5;
  PortEdit.Text := ExpandConstant('{param:PORT|' + GetPreviousData('Port', IntToStr(DefaultPort)) + '}');
  AddText(PortEdit.Top + PortEdit.Height + ScaleY(6), 0,
    'A number from 1024 to 65535 (default ' + IntToStr(DefaultPort) + '). The dashboard will be at http://localhost:<port>.');

  LanCheckClick(nil);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (NetPage <> nil) and (CurPageID = NetPage.ID) and (ParsePort(PortEdit.Text) < 0) then
  begin
    MsgBox('Enter a port number from 1024 to 65535.', mbError, MB_OK);
    Result := False;
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  Access: String;
begin
  if not LanCheck.Checked then
    Access := 'This PC only'
  else if TokenCheck.Checked then
    Access := 'This PC and other devices on the local network (access token required)'
  else
    Access := 'This PC and other devices on the local network (no access token)';
  Result := MemoDirInfo + NewLine + NewLine +
    'NetMon service:' + NewLine + Space + 'Starts automatically with Windows' + NewLine +
    Space + 'Port ' + Trim(PortEdit.Text) + NewLine + Space + Access + NewLine + NewLine +
    'Data and logs:' + NewLine + Space + DataDir();
end;

{ Fix the configuration and stop a running NetMon before any file is replaced. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  CfgPort := ParsePort(PortEdit.Text);
  if CfgPort < 0 then
  begin
    Result := 'Invalid port "' + PortEdit.Text + '": use a number from 1024 to 65535.';
    Exit;
  end;
  CfgLan := LanCheck.Checked;
  CfgUseToken := CfgLan and TokenCheck.Checked;
  CfgToken := '';
  if CfgUseToken then
  begin
    CfgToken := ReadExistingToken();
    if CfgToken = '' then CfgToken := GenerateToken();
    if CfgToken = '' then
    begin
      Result := 'Setup could not generate an access token (PowerShell failed). Run Setup again, or untick "Require an access token".';
      Exit;
    end;
  end;

  if ServiceExists() then
    if not StopNetMonService() then
      Result := 'The NetMon service could not be stopped. Stop it with "net stop NetMon" (as administrator) and run Setup again.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    SecureDataDir();
    WriteServiceConfig();
    ConfigureFirewall();
    InstallAndStartService();
    if CfgLan then CfgLanIp := DetectLanIp();
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  S: String;
begin
  if CurPageID = wpFinished then
  begin
    S := 'NetMon is installed. It runs in the background as a Windows service and starts with Windows.' + #13#10#13#10 +
      'On this PC, open:' + #13#10 + GetLocalUrl('');
    if CfgLan then
    begin
      S := S + #13#10#13#10 + 'On other devices on your network, open:' + #13#10 + GetLanUrl();
      if CfgToken <> '' then
        S := S + #13#10 + '(the link contains the access token; each browser needs it only once)';
    end;
    S := S + #13#10#13#10 + 'The "Open NetMon" shortcut in the Start Menu opens the dashboard at any time.';
    WizardForm.FinishedLabel.Caption := S;
    WizardForm.AdjustLabelHeight(WizardForm.FinishedLabel);
    WizardForm.RunList.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(12);
  end;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'LanAccess', BoolTo01(CfgLan));
  SetPreviousData(PreviousDataKey, 'UseToken', BoolTo01(TokenCheck.Checked));
  SetPreviousData(PreviousDataKey, 'Port', IntToStr(CfgPort));
end;

{ ------------------------------------------------------------------ uninstall }

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    { Before any file is deleted: stop + unregister the service, remove the firewall rules. }
    if ServiceExists() then
    begin
      StopNetMonService();
      if not RunWinSW('uninstall') then
        RunHidden(Sys('sc.exe'), 'delete ' + ServiceName);
    end;
    RemoveFirewallRules();
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(DataDir()) then
      if SuppressibleMsgBox('Also delete NetMon data?' + #13#10#13#10 +
          'This permanently removes your saved devices, history, settings and logs in ' + DataDir() + '.' + #13#10 +
          'Choose No to keep them for a later reinstall.',
          mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
        DelTree(DataDir(), True, True, True);
  end;
end;
