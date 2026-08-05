; Windows Firewall pre-seeding.
;
; The app binds its API server on 0.0.0.0 so agent containers (WSL2) can call
; back into it. Without an Allow rule, Windows shows the "Allow access?"
; prompt on first run — and if the user cancels it, Windows writes persistent
; Block rules that silently kill every container->host connection (browser
; launch, tool proxies) while the rest of the app keeps working.
;
; Our installer is per-user (perMachine: false) and normally runs WITHOUT
; elevation — netsh would fail and electron-updater's silent updates must
; never trigger UAC. So this only acts when the installer happens to be
; running elevated (admin account / per-machine contexts); everyone else is
; covered by the in-app firewall banner and its UAC-gated Fix button.
;
; The rule name must stay in sync with ruleDisplayName() in
; src/main/windows-firewall/index.ts ("<exe basename> agent connections") so
; the in-app fix and the installer never create duplicate rules.

!macro customInstall
  UserInfo::GetAccountType
  Pop $R0
  ${If} $R0 == "Admin"
    nsExec::Exec 'netsh advfirewall firewall delete rule name="Gamut agent connections"'
    nsExec::Exec 'netsh advfirewall firewall add rule name="Gamut agent connections" dir=in action=allow program="$INSTDIR\Gamut.exe" enable=yes profile=any'
  ${EndIf}

  ; Download-carried enrollment: the release worker may stamp a one-time
  ; enrollment code into the installer's filename. NSIS has no regex, so just
  ; record the filename verbatim; the app parses and validates it on first
  ; run (and deletes the file either way). $APPDATA\Gamut is the app's
  ; userData dir for the per-user install this targets.
  CreateDirectory "$APPDATA\Gamut"
  ClearErrors
  FileOpen $R1 "$APPDATA\Gamut\pending-download-source" w
  ${IfNot} ${Errors}
    FileWrite $R1 "$EXEFILE"
    FileClose $R1
  ${EndIf}
!macroend

!macro customUnInstall
  UserInfo::GetAccountType
  Pop $R0
  ${If} $R0 == "Admin"
    nsExec::Exec 'netsh advfirewall firewall delete rule name="Gamut agent connections"'
  ${EndIf}
!macroend
