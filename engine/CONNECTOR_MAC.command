#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "============================================"
echo "  FounderFlow Instagram Connector (Mac)"
echo "============================================"
echo ""

# --- Resolve workspace credentials ---
# Injected values (from dashboard standalone download)
WORKSPACE_ID="%%WORKSPACE_ID%%"
WORKSPACE_SECRET="%%WORKSPACE_SECRET%%"
API_BASE="%%API_BASE%%"
PROXY_HOST="%%PROXY_HOST%%"
PROXY_PORT="%%PROXY_PORT%%"
PROXY_USER="%%PROXY_USER%%"
PROXY_PASS="%%PROXY_PASS%%"

# If placeholders remain (not injected), fall back to config.json (engine ZIP)
if [[ "$WORKSPACE_ID" == *%%* ]] && [ -f "./config.json" ]; then
  WORKSPACE_ID=$(node -e "try{const c=require('./config.json');process.stdout.write(c.workspaceId||'')}catch(e){}" 2>/dev/null)
  WORKSPACE_SECRET=$(node -e "try{const c=require('./config.json');process.stdout.write(c.workspaceSecret||'')}catch(e){}" 2>/dev/null)
  API_BASE="https://founderflow-dashboard.vercel.app"
  PROXY_HOST=$(node -e "try{const c=require('./config.json');const m=c.proxyServer&&c.proxyServer.match(/@([^:]+):(\d+)/);process.stdout.write(m?m[1]:'')}catch(e){}" 2>/dev/null)
  PROXY_PORT=$(node -e "try{const c=require('./config.json');const m=c.proxyServer&&c.proxyServer.match(/@[^:]+:(\d+)/);process.stdout.write(m?m[1]:'36445')}catch(e){}" 2>/dev/null)
  PROXY_PORT=${PROXY_PORT:-36445}
  PROXY_USER=$(node -e "try{const c=require('./config.json');const m=c.proxyServer&&c.proxyServer.match(/\/\/([^:]+):/);process.stdout.write(m?m[1]:'')}catch(e){}" 2>/dev/null)
  PROXY_PASS=$(node -e "try{const c=require('./config.json');const m=c.proxyServer&&c.proxyServer.match(/:([^@]+)@/);process.stdout.write(m?m[1]:'')}catch(e){}" 2>/dev/null)
fi

if [ -z "$WORKSPACE_ID" ] || [ -z "$WORKSPACE_SECRET" ] || [[ "$WORKSPACE_ID" == *%%* ]]; then
  osascript -e 'display dialog "Missing workspace credentials.\n\nDownload the engine ZIP from the dashboard first." buttons {"OK"} default button 1 with icon stop'
  exit 1
fi

echo "Workspace: ${WORKSPACE_ID:0:8}..."

# --- Check Node.js ---
if ! command -v node &>/dev/null; then
  osascript -e 'display dialog "Node.js is required.\n\nInstall from https://nodejs.org then run this again." buttons {"OK"} default button 1 with icon stop'
  exit 1
fi

# Ensure 'ws' module is available (local project dir, or install on the fly)
if [ ! -d "./node_modules/ws" ]; then
  echo "Installing WebSocket module..."
  npm install ws --no-save 2>/dev/null
  if [ ! -d "./node_modules/ws" ]; then
    osascript -e 'display dialog "Could not install the WebSocket module.\n\nOpen Terminal, cd to this folder, run: npm install ws\nThen run this again." buttons {"OK"} default button 1 with icon stop'
    exit 1
  fi
fi

# --- Launch Chrome with proxy fingerprint ---
osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null
sleep 1
pkill -9 "Google Chrome" 2>/dev/null; pkill -9 "Chromium" 2>/dev/null
sleep 1

LOGDIR="/tmp/ig_connector_$(date +%s)"
mkdir -p "$LOGDIR" "$LOGDIR/profile"

PORT=9222
MOBILE_UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

echo "Proxy: $PROXY_HOST:$PROXY_PORT${PROXY_USER:+ (authenticated)}"

# Build proxy string — relay has no auth; direct proxies may have auth
if [ -n "$PROXY_USER" ] && [ -n "$PROXY_PASS" ]; then
  PROXY_STRING="http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}"
else
  PROXY_STRING="http://${PROXY_HOST}:${PROXY_PORT}"
fi

# Launch Chrome to blank page with CDP — mobile emulation is applied via CDP after connection
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=$PORT \
  --user-data-dir="$LOGDIR/profile" \
  --window-size=390,844 \
  --proxy-server="$PROXY_STRING" \
  --no-first-run --no-default-browser-check \
  --lang=th-TH \
  --timezone-for-testing=Asia/Bangkok \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  --enforce-webrtc-ip-permission-check \
  "about:blank" &
CHROME_PID=$!

echo -n "Waiting for Chrome DevTools..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/json/version" >/dev/null 2>&1; then echo " ready"; break; fi
  [ $i -eq 30 ] && osascript -e 'display dialog "Chrome DevTools did not start. Try again." buttons {"OK"} default button 1 with icon stop' && kill $CHROME_PID 2>/dev/null && exit 1
  sleep 1
done

# Mobile emulation + navigation happens via CDP in the node script below
# The dialog is shown AFTER emulation is set up and Instagram has loaded

# --- CDP node script (all in one) ---
# Sets up mobile emulation, navigates to Instagram, shows dialog, captures cookies, uploads
WS_ID="$WORKSPACE_ID" WS_SECRET="$WORKSPACE_SECRET" API="$API_BASE" PORT="$PORT" node -e "
const http = require('http');
const { WebSocket } = require('ws');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 9222;
const WS_ID = process.env.WS_ID;
const WS_SECRET = process.env.WS_SECRET;
const API = process.env.API;

http.get('http://localhost:' + PORT + '/json', (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    let pages;
    try { pages = JSON.parse(data); } catch(e) { process.exit(4); }
    const page = pages.find(p => p.type === 'page') || pages[0];
    if (!page) { process.exit(5); }
    const wsUrl = page.webSocketDebuggerUrl;
    if (!wsUrl) { process.exit(6); }

    const ws = new WebSocket(wsUrl);
    let cmdId = 1;
    const pending = {};
    const sendCmd = (method, params) => {
      const id = cmdId++;
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      return new Promise(resolve => { pending[id] = resolve; });
    };

    // Promise that resolves once CDP setup + navigation is complete
    let setupOk;
    const setupDone = new Promise(resolve => { setupOk = resolve; });

    ws.on('message', (data) => {
      try {
        const r = JSON.parse(data.toString());
        if (r.id && pending[r.id]) {
          pending[r.id](r);
          delete pending[r.id];
        }
      } catch(e) {}
    });

    ws.on('open', async () => {
      try {
        await sendCmd('Network.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        });
        await sendCmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await sendCmd('Emulation.setDeviceMetricsOverride', {
          width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
          screenWidth: 390, screenHeight: 844,
          screenOrientation: { type: 'portraitPrimary', angle: 0 }
        });
        await sendCmd('Page.navigate', { url: 'https://www.instagram.com/' });
        setupOk();
      } catch(e) { ws.close(); process.exit(1); }
    });

    (async () => {
      // Wait for setup + navigation, then give Instagram a moment to render
      await setupDone;
      await new Promise(r => setTimeout(r, 3000));

      // Show native dialog — blocks until user clicks OK
      try {
        execSync('osascript -e \"tell app \\\"Google Chrome\\\" to activate\" -e \"display dialog \\\"Log into your Instagram account in the Chrome window.\\n\\nWhen logged in, click OK to save session.\\\" buttons {\\\"OK\\\"} default button 1\"');
      } catch(e) { ws.close(); process.exit(1); }

      // Poll for sessionid (up to 60s)
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const result = await sendCmd('Network.getAllCookies', {});
          const cks = result.result?.cookies || [];
          if (cks.some(c => c.name === 'sessionid' && c.domain && c.domain.includes('instagram'))) {
            const postData = JSON.stringify({ workspaceId: WS_ID, secret: WS_SECRET, cookies: cks });
            const url = new URL(API + '/api/relay/session');
            const req = http.request({
              hostname: url.hostname, port: url.port || 443, path: url.pathname,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
            }, (res) => {
              res.on('data', () => {});
              res.on('end', () => {
                ws.close();
                process.exit(res.statusCode === 200 ? 0 : 1);
              });
            });
            req.on('error', () => { ws.close(); process.exit(1); });
            req.write(postData); req.end();
            return;
          }
        } catch(e) {}
      }
      ws.close();
      process.exit(2);
    })();
  });
}).on('error', () => process.exit(1));
" 2>&1
RESULT=$?

if [ $RESULT -eq 0 ]; then
  echo "Session uploaded!"
  osascript -e 'display dialog "Instagram session uploaded successfully!\n\nYou can close this window." buttons {"OK"} default button 1 with icon note'
  kill $CHROME_PID 2>/dev/null
  exit 0
elif [ $RESULT -eq 2 ]; then
  echo "No session found"
  osascript -e 'display dialog "No Instagram session found.\n\nMake sure you are logged in to Instagram, then try again." buttons {"OK"} default button 1 with icon caution'
else
  echo "Error exit code: $RESULT"
  osascript -e 'display dialog "An error occurred.\n\nTry again." buttons {"OK"} default button 1 with icon caution'
fi

kill $CHROME_PID 2>/dev/null
exit 1
