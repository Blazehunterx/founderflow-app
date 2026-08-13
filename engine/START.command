#!/bin/bash
cd "$(dirname "$0")"

# Check for Node.js
if ! command -v node &>/dev/null; then
  osascript -e 'display dialog "FounderFlow Engine requires Node.js.\n\nDownload and install from https://nodejs.org (LTS version), then run START.command again." buttons {"Open Download Page","Cancel"} default button "Open Download Page" with title "FounderFlow Engine"'
  if [ $? -eq 0 ]; then
    open "https://nodejs.org"
  fi
  exit 1
fi

# ── First run detection ────────────────────────────
if [ ! -d "node_modules" ] || [ ! -d "sessions/Default" ]; then
  osascript -e 'display dialog "FounderFlow Engine\n\nThis one-time setup will:\n1. Install dependencies\n2. Install browser\n3. Open Instagram login\n4. Start the engine\n\nAfter setup, the engine runs silently in the background." buttons {"Cancel","Continue"} default button "Continue" cancel button "Cancel" with title "FounderFlow Engine"'
  if [ $? -ne 0 ]; then exit; fi

  echo "Installing dependencies..."
  npm install --no-audit --no-fund
  if [ $? -ne 0 ]; then
    osascript -e 'display dialog "npm install failed. Check your internet connection and try again." buttons {"OK"} default button "OK" with title "FounderFlow Engine"'
    exit 1
  fi

  echo "Installing browser..."
  npx playwright install chromium
  if [ $? -ne 0 ]; then
    osascript -e 'display dialog "Browser install failed. Try running again." buttons {"OK"} default button "OK" with title "FounderFlow Engine"'
    exit 1
  fi

  echo "Starting engine..."
  node start.cjs auto
  if [ $? -eq 0 ]; then
    SCRIPT_PATH="$(pwd)/START.command"
    osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$SCRIPT_PATH\", hidden:true}" 2>/dev/null
    osascript -e 'display dialog "Setup Complete\n\nThe engine is running in the background and will auto-start on login.\n\nOpen your dashboard to monitor and control." buttons {"Got It"} default button "Got It" with title "FounderFlow Engine"'
  else
    osascript -e 'display dialog "Engine start failed. Open Terminal and run: node start.cjs auto\nto see the error." buttons {"OK"} default button "OK" with title "FounderFlow Engine"'
  fi
else
  # ── Normal run — launch hidden in background ──
  nohup node start.cjs auto > /dev/null 2>&1 &
fi
