' FounderFlow Engine — Silent Background Launcher
' Used by Windows Startup folder and manual double-click.
' Auto-detects portable Node.js or falls back to system node.
Set WshShell = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
engineDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = engineDir

' Prefer node.cmd shim (created by START.hta when portable node was downloaded)
If fso.FileExists(engineDir & "\node.cmd") Then
  WshShell.Run engineDir & "\node.cmd start.cjs auto", 0, False
ElseIf fso.FileExists(engineDir & "\portable-node\node.exe") Then
  WshShell.Run engineDir & "\portable-node\node.exe start.cjs auto", 0, False
Else
  WshShell.Run "node start.cjs auto", 0, False
End If
