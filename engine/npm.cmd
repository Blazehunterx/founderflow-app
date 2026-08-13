@echo off
if exist "%~dp0portable-node\node.exe" (
  "%~dp0portable-node\node.exe" "%~dp0portable-node\node_modules\npm\bin\npm-cli.js" %*
) else (
  npm %*
)
