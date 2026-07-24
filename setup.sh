#!/bin/bash
# FounderFlow — Mac Setup Script
# Run this from the extracted folder

echo "FounderFlow Setup"
echo "================="

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Install it first:"
  echo "  brew install node"
  echo "  OR download from https://nodejs.org (LTS)"
  exit 1
fi

echo "Node.js $(node --version) detected"

# Install dependencies
echo "Installing dependencies..."
npm install --no-audit --no-fund

# Install Playwright Chromium (needed for login)
echo "Installing Playwright browser..."
npx playwright install chromium

echo ""
echo "Setup complete! Start the app with:"
echo "  npm start"
