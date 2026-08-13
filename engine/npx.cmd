@echo off
if exist "%~dp0portable-node\node.exe" (
  "%~dp0portable-node\node.exe" "%~dp0portable-node\node_modules\npm\bin\npx-cli.js" %*
) else (
  npx %*
)
