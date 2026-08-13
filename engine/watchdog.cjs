/**
 * FounderFlow Watchdog v2 — Zero-dependency persistent poller
 * Uses ONLY Node.js built-in modules. Never breaks from corrupted node_modules.
 * Polls every 30s, processes cloud commands (reset/start/stop), restarts dead engine.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const CWD = __dirname;
const START_SCRIPT = path.join(CWD, 'start.cjs');
const CONFIG_PATH = path.join(CWD, 'config.json');
const LOCK_PATH = path.join(CWD, '.founderflow.lock');
const LOG_FILE = path.join(CWD, 'watchdog.log');
const POLL_MS = 30000;
const DEAD_MS = 300000;
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const crashTimestamps = [];
let crashLimitNotified = false;
let lastSpawnTime = 0;
const SPAWN_GRACE_MS = 120000; // 2 min grace — engine needs time to launch Playwright

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTelegram(config, message) {
  try {
    const token = config.telegramBotToken;
    const chatId = config.telegramChatId;
    if (!token || !chatId) return;
    const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
    const parsed = new URL(`https://api.telegram.org/bot${token}/sendMessage`);
    const req = https.request({
      hostname: parsed.hostname, port: 443, path: parsed.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => {}); });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (e) {}
}

// Generic HTTPS request supporting GET and PATCH
function apiRequest(config, url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { 
        'Accept': 'application/json',
        'apikey': config.supabaseAnonKey || '',
        'x-workspace-secret': config.workspaceSecret || ''
      },
      timeout: 15000,
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          resolve({ error: `HTTP ${res.statusCode}` }); // don't reject so loop continues
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// Supabase REST query
function supabase(config, table, params = {}) {
  const rawUrl = config.supabaseUrl || 'https://thtneidmejdgxdzbwdxj.supabase.co';
  const base = (rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${base}/rest/v1/${table}?${qs}`;
  return apiRequest(config, url, 'GET');
}

// Supabase PATCH (acknowledge command)
function supabasePatch(config, table, id, data) {
  const rawUrl = config.supabaseUrl || 'https://thtneidmejdgxdzbwdxj.supabase.co';
  const base = (rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl);
  const url = `${base}/rest/v1/${table}?id=eq.${id}`;
  return apiRequest(config, url, 'PATCH', JSON.stringify(data));
}

// Kill ALL stale engine processes (not just lock file)
function killAllEngines() {
  const myPid = process.pid;
  try {
    if (process.platform === 'win32') {
      // Nuclear option: kill all node.exe except self and watchdog
      try {
        const out = cp.execSync(
          'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        const lines = out.split('\n').filter(l => l.trim());
        let killed = 0;
        for (const line of lines) {
          const parts = line.split(',');
          if (parts.length < 3) continue;
          const pid = parseInt(parts[parts.length - 1], 10);
          const cmd = parts.slice(1, parts.length - 1).join(',').toLowerCase();
          if (!pid || pid === myPid) continue;
          if (cmd.includes('watchdog')) continue;
          if (cmd.includes('start.cjs') || cmd.includes('engine.cjs')) {
            try {
              cp.execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', windowsHide: true });
              log(`Killed stale engine PID ${pid}`);
              killed++;
            } catch (e) {}
          }
        }
        if (killed === 0) {
          // Fallback: wmic may have failed silently, use PowerShell
          try {
            const psOut = cp.execSync(
              'powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object {$_.Id -ne ' + myPid + '} | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Write-Output $_.Id }"',
              { encoding: 'utf8', timeout: 8000, windowsHide: true }
            );
            const psPids = psOut.split('\n').filter(l => l.trim());
            log(`PowerShell fallback killed ${psPids.length} node process(es)`);
          } catch (e) { log(`PowerShell fallback failed: ${e.message}`); }
        }
      } catch (e) {
        log(`wmic kill failed: ${e.message}`);
      }
    } else {
      // Linux/Mac: use ps + grep
      try {
        const out = cp.execSync(
          "ps aux | grep '[n]ode.*\\(start\\.cjs\\|engine\\.cjs\\)' | grep -v watchdog | awk '{print $2}'",
          { encoding: 'utf8', timeout: 5000 }
        );
        const pids = out.split('\n').filter(l => l.trim());
        for (const pidStr of pids) {
          const pid = parseInt(pidStr, 10);
          if (!pid || pid === myPid) continue;
          try {
            process.kill(pid, 'SIGKILL');
            log(`Killed stale engine PID ${pid}`);
          } catch (e) {}
        }
      } catch (e) {
        log(`ps kill failed: ${e.message}`);
      }
    }
  } catch (e) {
    log(`killAllEngines error: ${e.message}`);
  }
  // Also clean lock file
  try { if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH); } catch (e) {}
}

// Kill existing engine by lock file (legacy fallback)
function killEngine() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10);
      try { process.kill(pid); log(`Killed engine PID ${pid}`); } catch (e) {}
      try { fs.unlinkSync(LOCK_PATH); } catch (e) {}
    }
  } catch (e) {}
}

async function checkRunning(config) {
  try {
    const fiveMinAgo = new Date(Date.now() - DEAD_MS).toISOString();
    const data = await supabase(config, 'engine_heartbeats', {
      'workspace_id': `eq.${config.workspaceId}`,
      'seen_at': `gte.${fiveMinAgo}`,
      'select': 'id', 'limit': '1',
    });
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    log(`Heartbeat error: ${e.message}`);
    return null;
  }
}

async function fetchCommands(config) {
  try {
    return await supabase(config, 'engine_commands', {
      'workspace_id': `eq.${config.workspaceId}`,
      'acknowledged_at': 'is.null',
      'select': 'id,command',
      'order': 'created_at.asc',
    });
  } catch (e) {
    log(`Fetch error: ${e.message}`);
    return [];
  }
}

function startEngine() {
  // Kill ALL stale engine processes first — prevents dual-process conflicts
  killAllEngines();
  // Wait for processes to actually die
  try { cp.execSync('timeout /t 3 /nobreak >nul 2>&1 || sleep 3', { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch (e) {}
  log('Spawning engine...');
  const child = cp.spawn(process.execPath, [START_SCRIPT, 'auto'], {
    stdio: 'ignore', cwd: CWD, detached: true,
    env: { ...process.env, WATCHDOG_MODE: '1' },
  });
  child.unref();
  lastSpawnTime = Date.now();
  log('Engine spawned (PID: ' + child.pid + ')');
}

function doReset(config) {
  log('=== RESET: Full system reset ===');
  killEngine();
  log('Cleaning node_modules...');
  try { fs.rmSync(path.join(CWD, 'node_modules'), { recursive: true, force: true }); } catch (e) {}
  log('Cleaning sessions...');
  try { fs.rmSync(path.join(CWD, 'sessions'), { recursive: true, force: true }); } catch (e) {}
  log('Running npm install...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const proc = cp.spawn(npm, ['install'], { stdio: 'inherit', cwd: CWD });
  proc.on('close', (code) => {
    if (code === 0) {
      log('npm install OK. Starting engine...');
      startEngine();
    } else {
      log(`npm install failed (${code})`);
    }
  });
}

async function processCommands(config, commands) {
  const running = await checkRunning(config);
  for (const cmd of commands) {
    if (cmd.command === 'reset') {
      log(`Processing RESET (#${cmd.id})`);
      try { await supabasePatch(config, 'engine_commands', cmd.id, { acknowledged_at: new Date().toISOString() }); } catch {}
      sendTelegram(config, '⚠️ <b>Watchdog</b> — Full system reset triggered');
      doReset(config);
      return;
    }
    if (cmd.command === 'start' || cmd.command === 'restart') {
      log(`Processing ${cmd.command} (#${cmd.id})`);
      try { await supabasePatch(config, 'engine_commands', cmd.id, { acknowledged_at: new Date().toISOString() }); } catch {}
      killEngine();
      await sleep(2000);
      startEngine();
      sendTelegram(config, `🔄 <b>Watchdog</b> — Engine ${cmd.command}ed`);
      return;
    }
    if (cmd.command === 'stop' || cmd.command === 'shutdown') {
      log(`Acknowledging ${cmd.command} (#${cmd.id}) — watchdog will not restart`);
      try { await supabasePatch(config, 'engine_commands', cmd.id, { acknowledged_at: new Date().toISOString() }); } catch {}
      sendTelegram(config, `⏹ <b>Watchdog</b> — Engine stopped per command`);
      return;
    }
  }
  // Auto-restart: if engine is dead and no stop command was issued
  if (running === false) {
    // Skip if engine was just spawned — Playwright needs time to launch
    if (Date.now() - lastSpawnTime < SPAWN_GRACE_MS) {
      return; // Grace period — don't kill a booting engine
    }
    const activeStop = commands.some(c => c.command === 'stop' || c.command === 'shutdown');
    if (!activeStop) {
      // Crash limiter: max MAX_CRASHES restarts per CRASH_WINDOW_MS
      const now = Date.now();
      while (crashTimestamps.length > 0 && crashTimestamps[0] < now - CRASH_WINDOW_MS) crashTimestamps.shift();
      if (crashTimestamps.length === 0) crashLimitNotified = false; // Reset when window expires
      if (crashTimestamps.length >= MAX_CRASHES) {
        if (!crashLimitNotified) {
          log(`CRASH LIMIT: ${MAX_CRASHES} crashes in ${CRASH_WINDOW_MS/60000}min — stopping auto-restart`);
          sendTelegram(config, `🚨 <b>Watchdog</b> — Engine crashed ${MAX_CRASHES} times in ${CRASH_WINDOW_MS/60000}min. Auto-restart STOPPED. Needs manual intervention.`);
          crashLimitNotified = true;
        }
        return;
      }
      crashTimestamps.push(now);
      log(`Engine dead — auto-restarting (crash ${crashTimestamps.length}/${MAX_CRASHES})...`);
      startEngine();
      sendTelegram(config, `🔁 <b>Watchdog</b> — Engine crashed, auto-restarted (${crashTimestamps.length}/${MAX_CRASHES})`);
    }
  }
}

async function main() {
  log('Watchdog v3 started (PID: ' + process.pid + ')');
  // Kill ALL stale engine processes on startup
  killAllEngines();
  log('Stale processes cleaned. Starting poll loop.');
  const config = loadConfig();
  if (config) {
    sendTelegram(config, `🐕 <b>Watchdog started</b> (PID: ${process.pid})\nPolling every 30s for commands`);
  }
  while (true) {
    try {
      const config = loadConfig();
      if (!config) { await sleep(POLL_MS); continue; }
      const commands = await fetchCommands(config);
      if (commands.length > 0) await processCommands(config, commands);
      else await processCommands(config, []); // just auto-restart check
    } catch (e) { log(`Loop: ${e.message}`); }
    await sleep(POLL_MS);
  }
}

process.on('SIGINT', () => { log('Stopped'); process.exit(0); });
process.on('SIGTERM', () => { log('Stopped'); process.exit(0); });
main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });

