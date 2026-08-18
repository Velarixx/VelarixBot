; Per-user user-session harness (not LocalSystem, not perMachine, not NSSM).
; The binary is the packaged Electron exe + --harness-service so safeStorage
; (DPAPI) still has a live broker. Token is minted at process start — never
; written into this installer command.

!macro customInstall
  DetailPrint "Registering the VelarixBot user-session harness"
  nsExec::ExecToLog '"$SYSDIR\sc.exe" create velarixbot-harness binPath= "$\"$INSTDIR\VelarixBot.exe$\" --harness-service" start= auto type= userown DisplayName= "VelarixBot harness"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start velarixbot-harness'
!macroend

!macro customUnInstall
  DetailPrint "Removing the VelarixBot user-session harness"
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop velarixbot-harness'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete velarixbot-harness'
!macroend
