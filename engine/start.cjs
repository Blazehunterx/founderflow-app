/**
 * FounderFlow Engine - Start Script v4 (Supervisor)
 * Usage: node start.cjs [dm|harvest|both|auto]
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let _WebSocket = null;
function getWebSocket() {
  if (!_WebSocket) {
    try { _WebSocket = require('ws'); } catch (e) { return null; }
  }
  return _WebSocket;
}

const LOCK_PATH = path.resolve(__dirname, '.founderflow.lock');
const SESSION_PATH = path.resolve(__dirname, 'sessions');
const LOG_PATH = path.resolve(__dirname, 'engine.log');
const STARTUP_LOG = path.resolve(__dirname, 'engine-startup.log');
const WATCHDOG_PID_PATH = path.resolve(__dirname, '.watchdog.pid');
const WATCHDOG_SCRIPT = path.resolve(__dirname, 'watchdog.cjs');

let shutdownRequested = false;

// Write directly to startup log so crashes are captured even if stdout is buffered
function slog(msg) {
  try { fs.appendFileSync(STARTUP_LOG, msg + '\n'); } catch (e) {}
  console.log(msg);
}

// 🛡️ ZOMBIE KILLER: Purge any lingering Chromium processes from previous crashes
function killZombies() {
  try {
    if (process.platform === 'win32') {
      // Kill any lingering browsers and their children
      execSync('taskkill /F /IM "chrome.exe" /T', { stdio: 'ignore' });
      execSync('taskkill /F /IM "chromium.exe" /T', { stdio: 'ignore' });
    } else {
      execSync('pkill -f chromium || true', { stdio: 'ignore' });
    }
    slog('[SELF_HEAL] Purged zombie browser processes.');
  } catch (e) {}
}

// 🛡️ STALE ENGINE KILLER: Kill any other node processes running start.cjs or engine.cjs
function killStaleEngines() {
  const myPid = process.pid;
  try {
    if (process.platform === 'win32') {
      try {
        const out = execSync(
          'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        const lines = out.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const parts = line.split(',');
          if (parts.length < 3) continue;
          const pid = parseInt(parts[parts.length - 1], 10);
          const cmd = parts.slice(1, parts.length - 1).join(',').toLowerCase();
          if (!pid || pid === myPid) continue;
          if (cmd.includes('watchdog')) continue;
          if (cmd.includes('start.cjs') || cmd.includes('engine.cjs')) {
            try {
              execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', windowsHide: true });
              slog(`[SELF_HEAL] Killed stale engine PID ${pid}`);
            } catch (e) {}
          }
        }
      } catch (e) {}
    } else {
      try {
        const out = execSync(
          "ps aux | grep '[n]ode.*\\(start\\.cjs\\|engine\\.cjs\\)' | grep -v watchdog | awk '{print $2}'",
          { encoding: 'utf8', timeout: 5000 }
        );
        const pids = out.split('\n').filter(l => l.trim());
        for (const pidStr of pids) {
          const pid = parseInt(pidStr, 10);
          if (!pid || pid === myPid) continue;
          try { process.kill(pid, 'SIGKILL'); slog(`[SELF_HEAL] Killed stale engine PID ${pid}`); } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}
  // Clean lock file too
  try { if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH); } catch (e) {}
}
// Run cleanup on every start attempt
killZombies();
killStaleEngines();

slog(`[${new Date().toISOString()}] START`);

process.on('uncaughtException', (err) => {
  slog(`[${new Date().toISOString()}] UNCAUGHT: ${err.message}`);
  slog(err.stack ? err.stack.substring(0, 500) : '');
});
process.on('unhandledRejection', (err) => {
  slog(`[${new Date().toISOString()}] UNHANDLED_REJECTION: ${err?.message || err}`);
});

// Patch console.log/error to also write to startup file
const origLog = console.log;
const origErr = console.error;
console.log = function(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  try { fs.appendFileSync(STARTUP_LOG, msg + '\n'); } catch (e) {}
  origLog.apply(console, args);
};
console.error = function(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  try { fs.appendFileSync(STARTUP_LOG, '[ERR] ' + msg + '\n'); } catch (e) {}
  origErr.apply(console, args);
};

function removeLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (e) {}
}

// Lock check moved after Phase 0 to allow clean restarts

// ─── PHASE 0: Self-Bootstrap (zero npm dependencies) ─────
// Downloads fresh engine files from cloud BEFORE loading any npm modules.
// Uses execSync with system tools (curl/powershell) - no npm modules needed.
// Even with completely corrupted node_modules, this always works.
const BOOTSTRAP_DOMAIN = 'https://founderflow-dashboard.vercel.app';

function syncDownload(url, outFile) {
  if (process.platform === 'win32') {
    const psOutFile = outFile.replace(/'/g, "''");
    // Invoke-WebRequest throws on HTTP 4xx/5xx (unlike WebClient.DownloadFile which silently gets HTML)
    execSync(`powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${psOutFile}' -UseBasicParsing"`, { timeout: 30000, stdio: 'pipe' });
  } else {
    // -f flag makes curl exit non-zero on HTTP 4xx/5xx
    execSync(`curl -s -f -o "${outFile}" "${url}"`, { timeout: 30000, stdio: 'pipe' });
  }
}

function phase0() {
  try {

    const cfgPath = path.resolve(__dirname, 'config.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg.workspaceId || cfg.workspaceId.includes('__')) return false;

    const versionFile = path.join(__dirname, '.version');
    let currentVer = '';
    if (fs.existsSync(versionFile)) currentVer = fs.readFileSync(versionFile, 'utf8').trim();

    // Fetch version JSON
    const tmpVer = path.join(__dirname, '.version.tmp');
    syncDownload(`${BOOTSTRAP_DOMAIN}/api/version?t=${Date.now()}`, tmpVer);
    if (!fs.existsSync(tmpVer)) return false;
    const verJson = JSON.parse(fs.readFileSync(tmpVer, 'utf8'));
    const ver = verJson.version;
    try { fs.unlinkSync(tmpVer); } catch (e) {}

    if (ver === currentVer) return false;

    console.log('🔄 Phase 0: Downloading fresh engine files...');

    // Download all engine files in parallel (sequential sync)
    const files = ['start.cjs', 'watchdog.cjs', 'engine.cjs', 'ai_setter.cjs', 'harvester.cjs', 'login.cjs', 'sender.cjs', 'inject_cookies.cjs', 'ghost.cjs', 'START.hta', 'START.vbs', 'START.bat', 'START.command'];
    for (const f of files) {
      try {
        syncDownload(`${BOOTSTRAP_DOMAIN}/api/engine-file/${f}?engine_update=1&workspace_id=${cfg.workspaceId}`, path.join(__dirname, f + '.new'));
        // Validate: reject HTML error pages or empty files
        const newContent = fs.readFileSync(path.join(__dirname, f + '.new'), 'utf8');
        if (newContent.trim().startsWith('<') || newContent.length < 20) {
          fs.unlinkSync(path.join(__dirname, f + '.new'));
          console.log(`  ⚠️  ${f}: invalid content (HTML/empty), keeping original`);
          continue;
        }
        // Replace original with validated new file
        const origPath = path.join(__dirname, f);
        if (fs.existsSync(origPath)) fs.unlinkSync(origPath);
        fs.renameSync(path.join(__dirname, f + '.new'), origPath);
      } catch (e) { console.log(`  ⚠️  ${f}: ${e.message}`); }
    }

    // Write version file
    fs.writeFileSync(versionFile, ver);

    // npm install (only if node_modules is missing or package.json changed)
    const nm = path.join(__dirname, 'node_modules');
    if (!fs.existsSync(nm)) {
      console.log('📦 Phase 0: Installing dependencies...');
      try {
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        execSync(`${npmCmd} install --no-audit --no-fund`, { cwd: __dirname, stdio: 'inherit', timeout: 120000 });
      } catch (npmErr) {
        console.log(`⚠️  Phase 0: npm install failed (${npmErr.message}). Dependencies may already be present.`);
      }
    }

    // Clear module cache
    for (const key of Object.keys(require.cache)) delete require.cache[key];

    console.log('🚀 Phase 0: Update complete. Restarting engine...');
    const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit', cwd: __dirname, env: { ...process.env, BOOTSTRAP_BYPASS: '1' },
    });
    child.on('exit', (c) => process.exit(c));
    return true; // phase0 handles everything, stop here
  } catch (e) {
    console.log(`⚠️  Phase 0: ${e.message}`);
    return false;
  }
}

if (process.argv[2] !== 'watchdog' && !process.env.BOOTSTRAP_BYPASS) {
  const spawned = phase0();
  if (spawned) return; // phase0 is handling the restart
}

// ─── Phase 0 Lock Check (Post-bootstrap) ───
// Placed here so the updater can spawn a new process without triggering a lock collision
if (fs.existsSync(LOCK_PATH)) {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10);
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); 
      console.log(`\n\x1b[31m[CRITICAL] Engine is ALREADY RUNNING (PID ${pid}).\x1b[0m`);
      console.log(`[ACTION] Run 'taskkill /F /IM node.exe' to clear it.\n`);
      process.exit(1); 
    }
  } catch (e) {
    try { fs.unlinkSync(LOCK_PATH); } catch(err) {}
  }
}
fs.writeFileSync(LOCK_PATH, process.pid.toString());
process.on('exit', removeLock);



// ─── Companion Watchdog ─────────────────────────────
// Spawn zero-dependency watchdog.cjs if not already running.
// It polls cloud commands every 30s and survives engine crashes.
// WATCHDOG DELETED FOR STABILITY

console.log('\n╔══════════════════════════════════════════╗');
console.log('║   FounderFlow Engine v4                   ║');
console.log('║   DM Outreach + AI Setter + Harvester    ║');
console.log('║   Auto-restart on crash                   ║');
console.log('╚══════════════════════════════════════════╝\n');

const configPath = path.resolve(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('Error: config.json not found. Download from dashboard.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// ─── Watchdog Mode (early exit — no lock, no banner) ────
if (process.argv[2] === 'watchdog') {
  (async () => {
    process.argv = [process.argv[0], process.argv[1], 'auto'];
    let sb;
    try {
      const { createClient } = require('@supabase/supabase-js');
      sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        global: {
          headers: {
            'x-workspace-secret': config.workspaceSecret || ''
          }
        },
        realtime: { transport: getWebSocket() }
      });
    } catch (e) { process.exit(1); }
    const { data: cmds } = await sb.from('engine_commands')
      .select('id').eq('workspace_id', config.workspaceId)
      .in('command', ['start', 'restart']).is('acknowledged_at', null).limit(1);
    const hasStartCmd = cmds && cmds.length > 0;
    const fiveMinAgo = new Date(Date.now() - 300000).toISOString();
    const { data: hb } = await sb.from('engine_heartbeats')
      .select('id').eq('workspace_id', config.workspaceId)
      .gte('seen_at', fiveMinAgo).limit(1);
    const engineRunning = hb && hb.length > 0;
    if (engineRunning) {
      if (hasStartCmd) await sb.from('engine_commands').update({ acknowledged_at: new Date().toISOString() }).eq('workspace_id', config.workspaceId).in('command', ['start', 'restart']).is('acknowledged_at', null);
      process.exit(0);
    }
    const { data: stop } = await sb.from('engine_commands')
      .select('id').eq('workspace_id', config.workspaceId)
      .eq('command', 'stop').is('acknowledged_at', null).limit(1);
    const hasStop = stop && stop.length > 0;
    if (!hasStop || hasStartCmd) {
      if (hasStartCmd) await sb.from('engine_commands').update({ acknowledged_at: new Date().toISOString() }).eq('workspace_id', config.workspaceId).in('command', ['start', 'restart']).is('acknowledged_at', null);
      spawn(process.execPath, [__filename, 'auto'], { stdio: 'inherit', cwd: __dirname, detached: true, env: { ...process.env, WATCHDOG_MODE: '1' } });
    }
    process.exit(0);
  })();
  return;
}

if (config.workspaceId && config.workspaceId.includes('__')) {
  console.log('Error: config.json contains placeholder values. Download a fresh copy from your dashboard.');
  process.exit(1);
}

// 🛡️ Self-Healing Config Logic:
// If the security secret is missing (old version), try to fetch it from the handshake API.
// This prevents Scott and others from having to re-download the ZIP for every security update.
if (!config.workspaceSecret || config.workspaceSecret === '') {
  console.log('🛡️ Security: Missing workspace secret. Attempting auto-repair...');
  try {
    const handshakeUrl = `${BOOTSTRAP_DOMAIN}/api/client/handshake?workspace_id=${config.workspaceId}&t=${Date.now()}`;
    const tmpSecret = path.join(__dirname, '_secret.tmp');
    syncDownload(handshakeUrl, tmpSecret);
    if (fs.existsSync(tmpSecret)) {
      const sdata = JSON.parse(fs.readFileSync(tmpSecret, 'utf8'));
      if (sdata.secret) {
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        existing.workspaceSecret = sdata.secret;
        fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
        config.workspaceSecret = sdata.secret;
        console.log('✅ Security: Workspace secret recovered and installed.');
      }
      fs.unlinkSync(tmpSecret);
    }
  } catch (e) {
    console.log(`⚠️  Repair failed: ${e.message}`);
    console.log('Please download a fresh ZIP if this persists.');
  }
}

const perms = config.permissions || {};

console.log(`Workspace: ${config.workspaceName}`);
console.log(`Plan:      ${perms.status === 'active' ? '✅ Active' : perms.status === 'trial' ? '⏳ Trial' : '⛔ Suspended'}`);
console.log(`DM:        ${perms.canDM === false ? '⛔' : '✅'} ${perms.canDM === false ? 'Disabled' : 'Enabled'}`);
console.log(`Harvester: ${perms.canHarvest === false ? '⛔' : '✅'} ${perms.canHarvest === false ? 'Disabled' : 'Enabled'}`);
console.log(`AI Setter: ${perms.canAISetter === false ? '⛔' : '✅'} ${perms.canAISetter === false ? 'Disabled' : 'Enabled'}`);
console.log(`Training:  ${config.aiTrainingContext ? '✅ Configured' : '⚠️ None set'}`);
console.log(`Gemini:    ${config.geminiApiKey ? '✅ Pre-configured' : '🔍 Checking Supabase...'}`);
console.log(`Grok:      ${config.grokApiKey ? '✅ Pre-configured' : '🔍 Checking Supabase...'}`);
// If not in local config, try fetching from Supabase (so banner is accurate)
if (!config.geminiApiKey || !config.grokApiKey) {
  try { require('@supabase/supabase-js'); } catch (e) {}
  try {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      global: { headers: { 'x-workspace-secret': config.workspaceSecret || '' } }
    });
    sb.from('settings').select('gemini_api_key,grok_api_key,ai_setter_enabled').eq('workspace_id', config.workspaceId).limit(1).then(({ data }) => {
      if (data?.[0]) {
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let changed = false;
        if (data[0].gemini_api_key && !config.geminiApiKey) {
          existing.geminiApiKey = data[0].gemini_api_key;
          config.geminiApiKey = data[0].gemini_api_key;
          changed = true;
        }
        if (data[0].grok_api_key && !config.grokApiKey) {
          existing.grokApiKey = data[0].grok_api_key;
          config.grokApiKey = data[0].grok_api_key;
          changed = true;
        }
        if (data[0].ai_setter_enabled !== undefined) {
          existing.aiSetterEnabled = data[0].ai_setter_enabled;
          config.aiSetterEnabled = data[0].ai_setter_enabled;
          changed = true;
        }
        if (changed) fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
        const aiKey = config.grokApiKey || config.geminiApiKey;
        console.log(`AI Key:    ✅ Fetched from cloud (${config.grokApiKey ? 'Grok' : 'Gemini'})`);
      } else {
        console.log(`AI Key:    ⚠️ Not configured (AI Setter will be skipped)`);
      }
    }).catch(() => {});
  } catch (e) {}
}
if (perms.status === 'trial' && config.trialDaysRemaining !== null && config.trialDaysRemaining !== undefined) {
  console.log(`Trial:     ${config.trialDaysRemaining} day(s) remaining`);
}

// Suspended check
if (perms.status === 'suspended') {
  console.log('\n⛔ Your account has been suspended. Contact your admin.');
  process.exit(0);
}

// Show trial banner
if (perms.status === 'trial') {
  console.log('\n────────────────────────────────────────────');
  console.log(' ⏳ TRIAL MODE');
  console.log('   You have access to:');
  if (perms.canDM !== false) console.log('   ✅ DM Outreach — send messages to leads');
  if (perms.canAISetter !== false) console.log('   ✅ AI Auto-Reply — automatic replies to DMs');
  if (perms.canHarvest !== false) console.log('   ✅ Lead Harvester — find new Instagram leads');
  console.log('');
  if (perms.canHarvest === false) {
    console.log('   ⛔ Lead Harvester is locked in trial.');
    console.log('      Upgrade to get access: contact your admin.');
  }
  console.log('────────────────────────────────────────────');
}

console.log('');

// ─── Health Check Mode ──────────────────────────
if (process.argv[2] === 'health' || process.argv[2] === '--health') {
  runHealthCheck().then(r => process.exit(r ? 0 : 1));
  return;
}

// ─── Watchdog Registration ──────────────────────────
// Registers a Windows Scheduled Task that runs every 2 minutes.
// Called once during run() after first successful engine launch.
async function registerWatchdog() {
  if (process.platform !== 'win32') return;
  const scriptPath = path.resolve(__dirname, 'start.cjs');
  const taskName = 'AntigravityCloudWatchdog';
  try {
    const cp = require('child_process');
    const check = await new Promise((resolve) => {
      cp.exec(`schtasks /Query /TN "${taskName}" /FO CSV /NH`, (err, stdout) => {
        resolve(!err && stdout.includes(taskName));
      });
    });
    if (check) { slog('[WATCHDOG] Scheduled task already registered'); return; }
  } catch (e) { /* ignore */ }

  const cmd = `schtasks /Create /TN "${taskName}" /TR "node \\\"${scriptPath}\\\" watchdog" /SC MINUTE /MO 2 /F /IT /RL LOWEST /V1`;
  try {
    await new Promise((resolve, reject) => {
      const cp = require('child_process');
      cp.exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
    slog('[WATCHDOG] Scheduled task registered (runs every 2 min)');
  } catch (e) {
    slog(`[WATCHDOG] Failed to register scheduled task: ${e.message}`);
  }
}



// Determine mode
let mode = process.argv[2] || 'auto'; 
const validModes = ['dm', 'harvest', 'both', 'auto', 'watchdog', 'health'];
if (!validModes.includes(mode)) {
  mode = 'auto'; // Default to auto instead of exiting
}

// Block modes that permissions don't allow
const needsDM = mode === 'dm' || mode === 'both' || mode === 'auto';
const needsHarvest = mode === 'harvest' || mode === 'both' || mode === 'auto';
if (needsDM && perms.canDM === false) {
  console.log('⚠️  DM outreach disabled — AI Setter inbox mode only.');
  // Don't exit — allow AI setter to continue scanning inbox
}
if (needsHarvest && perms.canHarvest === false) {
  if (mode === 'auto') {
    console.log('⚠️  Harvesting disabled in trial — running DM-only mode.');
    // Fall back to DM-only mode
    mode = 'dm';
  } else {
    console.log('⛔ Lead harvesting is disabled for your account. Contact your admin.');
    process.exit(0);
  }
}

// Check for dependencies
const DEPS = ['playwright', 'adm-zip', '@supabase/supabase-js'];
const missingDeps = DEPS.filter(d => { try { require.resolve(d); return false; } catch (e) { return true; } });

// ─── Self-Healing Launch Loop ──────────────────────────
// Wraps run() in a retry loop so the engine always resurrects,
// even if start.cjs itself crashes (catches unhandled rejections).
async function launch() {
  while (true) {
    if (shutdownRequested) { removeLock(); process.exit(0); }
    try { await run(); } catch (e) { slog(`[LAUNCH_CRASH] ${e.message}`); }
    slog(`[LAUNCH] Engine stopped. Restarting in 5 min...`);
    await new Promise(r => setTimeout(r, 300000));
  }
}

if (missingDeps.length === 0) {
  launch();
} else {
  console.log('Installing dependencies (first run only)...');
   const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
   const install = spawn(npm, ['install'], { stdio: 'inherit', cwd: __dirname, shell: process.platform === 'win32' });
  install.on('close', (code) => {
    if (code !== 0) { console.log('Install failed.'); process.exit(1); }
    console.log('\nInstalling browser...');
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const installBrowser = spawn(npx, ['playwright', 'install', 'chromium'], { stdio: 'inherit', cwd: __dirname, shell: process.platform === 'win32' });
    installBrowser.on('close', (browserCode) => {
      if (browserCode !== 0) { console.log('Browser install failed.'); process.exit(1); }
      launch();
    });
  });
}

// ─── Auto-Update System ───────────────────────────────
async function checkForUpdates() {
  console.log('⏭️  Auto-update disabled for this workspace.');
  return;
  const DASHBOARD_URL = 'https://founderflow-dashboard.vercel.app';
  const VERSION_FILE = path.join(__dirname, '.version');
  
  try {
    // Backup custom files before any update
    const protectedFiles = ['ai_setter.cjs', 'engine.cjs', 'start.cjs'];
    for (const pf of protectedFiles) {
      const src = path.join(__dirname, pf);
      const bak = path.join(__dirname, pf + '.custom-backup');
      if (fs.existsSync(src)) fs.copyFileSync(src, bak);
    }
    console.log('🔄 Checking for updates...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${DASHBOARD_URL}/api/version`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    
    const { version: latestVersion } = await res.json();
    let currentVersion = '';
    if (fs.existsSync(VERSION_FILE)) {
      currentVersion = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    }

    if (currentVersion === latestVersion) {
      console.log('✅ Engine is up to date.');
      return;
    }

    console.log(`🚀 New version found! Downloading update...`);
    const dlController = new AbortController();
    const dlTimeout = setTimeout(() => dlController.abort(), 30000);
    const dlRes = await fetch(`https://founderflow-dashboard.vercel.app/api/client/download?engine_update=1`, { signal: dlController.signal });
    clearTimeout(dlTimeout);
    if (!dlRes.ok) throw new Error('Update download failed');

    const buffer = await dlRes.arrayBuffer();
    const zipPath = path.join(__dirname, 'update.zip');
    fs.writeFileSync(zipPath, Buffer.from(buffer));

    // Try adm-zip first, fall back to system unzip
    let extracted = false;
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      for (const entry of entries) {
        const name = entry.entryName;
        if (name.includes('config.json') || name.includes('sessions/') || name.includes('.env') || name.includes('ai_setter.cjs') || name.includes('start.cjs')) continue;
        const parts = name.split('/');
        let targetName = name;
        if (parts.length > 1 && parts[0].includes('-')) targetName = parts.slice(1).join('/');
        if (!targetName) continue;
        if (entry.isDirectory) {
          const td = path.join(__dirname, targetName);
          if (!fs.existsSync(td)) fs.mkdirSync(td, { recursive: true });
        } else {
          const tf = path.join(__dirname, targetName);
          const parent = path.dirname(tf);
          if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
          fs.writeFileSync(tf, entry.getData());
        }
      }
      extracted = true;
    } catch (admErr) {
      console.log(`  adm-zip failed (${admErr.message}), trying system extract...`);
    }

    // Fallback: use system unzip (PowerShell on Windows, unzip on macOS/Linux)
    if (!extracted) {
      const isWin = process.platform === 'win32';
      if (isWin) {
        await new Promise((res, rej) => {
          const ps = spawn('powershell', [
            '-NoProfile', '-Command',
            `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${__dirname.replace(/'/g, "''")}' -Force`
          ], { stdio: 'pipe' });
          ps.on('close', (code) => code === 0 ? res() : rej(new Error(`Expand-Archive exit code ${code}`)));
          ps.on('error', rej);
        });
        // Post-process: strip engine-update/ prefix if present
        // Restore custom Olive files that were overwritten by unzip
        const protectedFiles = ['ai_setter.cjs', 'start.cjs'];
        for (const pf of protectedFiles) {
          const backup = path.join(__dirname, pf + '.custom-backup');
          const target = path.join(__dirname, pf);
          if (fs.existsSync(backup)) {
            fs.copyFileSync(backup, target);
            console.log('  Restored custom ' + pf + ' from backup');
          }
        }
        const prefixDir = path.join(__dirname, 'engine-update');
        if (fs.existsSync(prefixDir)) {
          for (const file of fs.readdirSync(prefixDir)) {
            const src = path.join(prefixDir, file);
            const dst = path.join(__dirname, file);
            if (fs.statSync(src).isFile()) {
              fs.renameSync(src, dst);
            }
          }
          fs.rmSync(prefixDir, { recursive: true, force: true });
        }
      } else {
        // macOS/Linux: use system unzip
        await new Promise((res, rej) => {
          const uz = spawn('unzip', ['-o', zipPath, '-d', __dirname], { stdio: 'pipe' });
          uz.on('close', (code) => code === 0 ? res() : rej(new Error(`unzip exit code ${code}`)));
          uz.on('error', rej);
        });
      }
      extracted = true;
    }

    // Final fallback: download each file individually via API (no extraction needed)
    if (!extracted) {
      console.log('  Trying individual file download...');
      const files = ['login.cjs', 'harvester.cjs', 'watchdog.cjs', 'sender.cjs', 'inject_cookies.cjs', 'ghost.cjs', 'START.hta', 'START.vbs', 'START.bat', 'START.command'];
      let allOk = true;
      for (const file of files) {
        try {
          const fController = new AbortController();
          const fTimeout = setTimeout(() => fController.abort(), 15000);
          const fRes = await fetch(`${DASHBOARD_URL}/api/engine-file/${file}`, { signal: fController.signal });
          clearTimeout(fTimeout);
          if (!fRes.ok) { console.log(`    ${file}: HTTP ${fRes.status}`); allOk = false; continue; }
          const content = await fRes.text();
          if (content.trim().startsWith('<') || content.length < 20) {
            console.log(`    ${file}: invalid content (HTML/empty), skipping`);
            allOk = false; continue;
          }
          fs.writeFileSync(path.join(__dirname, file), content, 'utf-8');
          console.log(`    ${file}: OK`);
        } catch (e) { console.log(`    ${file}: ${e.message}`); allOk = false; }
      }
      if (allOk) extracted = true;
    }

    if (!extracted) throw new Error('All extraction methods failed');

    fs.writeFileSync(VERSION_FILE, latestVersion);
    try { fs.unlinkSync(zipPath); } catch (e) {}
    console.log('✨ Update installed successfully!\n');
  } catch (e) {
    console.log(`⚠️  Update check failed: ${e.message} (Skipping...)`);
  }
}

// ─── Health Check (pre-flight, no DMs sent) ──────────
async function runHealthCheck() {
  let pass = true;
  const ok = () => { process.stdout.write(' ✅\n'); };
  const fail = (msg) => { process.stdout.write(' ❌\n'); console.log(`     ${msg}`); pass = false; };
  console.log('\n═══════════════════════════════════════════');
  console.log('  FounderFlow — Pre-Flight Health Check');
  console.log('═══════════════════════════════════════════\n');

  process.stdout.write(' Node.js version');
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split('.')[0], 10);
  if (major >= 18) ok(); else { fail(`Node.js ${nodeVer} — need 18+`); }

  process.stdout.write(' config.json');
  if (config.workspaceId && !config.workspaceId.includes('__')) ok(); else fail('Missing or placeholder values');

  process.stdout.write(' Supabase connection');
  try {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      global: {
          headers: {
            'x-workspace-secret': config.workspaceSecret || ''
          }
        },
        realtime: {
          transport: getWebSocket()
        }
      });
    const { error } = await sb.from('workspaces').select('id').limit(1);
    if (error) fail(error.message); else ok();
  } catch (e) { fail(e.message); }

  process.stdout.write(' Instagram session');
  try {
    const { chromium } = require('playwright-core');
    const context = await chromium.launchPersistentContext(SESSION_PATH, { headless: true });
    const cookies = await context.cookies('https://www.instagram.com');
    const hasSession = cookies.some(c => c.name === 'sessionid');
    await context.close();
    if (hasSession) ok(); else fail('No session found. Run login.cjs first.');
  } catch (e) { fail(e.message); }

  process.stdout.write(' Playwright browser');
  try {
    require.resolve('playwright-core');
    const { chromium } = require('playwright-core');
    const exe = await chromium.executablePath();
    if (require('fs').existsSync(exe)) ok(); else fail('Browser binary not found. Run: npx playwright install chromium');
  } catch (e) { fail(e.message); }

  process.stdout.write(' Dependencies');
  const deps = ['@supabase/supabase-js', 'playwright', 'adm-zip'];
  const missing = deps.filter(d => { try { require.resolve(d); return false; } catch (e) { return true; } });
  if (missing.length === 0) ok(); else fail(`Missing: ${missing.join(', ')}`);

  process.stdout.write(' AI API key');
  if (config.grokApiKey || config.geminiApiKey) ok(); else { fail('Not set — AI Setter will be skipped'); }

  process.stdout.write(' Permissions');
  if (config.permissions) ok(); else fail('Missing from config');

  console.log(`\n───────────────────────────────────────────`);
  if (pass) {
    console.log(' ✅ All checks passed — engine is ready to run.');
    console.log('    Run: node start.cjs');
  } else {
    console.log(' ❌ Some checks failed. Fix the issues above, then re-run this check.');
  }
  console.log('───────────────────────────────────────────\n');
  return pass;
}

// ─── Supervisor (Self-Healing) ────────────────────────
const SUPERVISOR = {
  maxRetries: 0,
  backoffBaseMs: 300000,
  backoffMaxMs: 300000,
  backoffResetAfterMs: 300000,
  actionBlockBackoffMs: 86400000, // 24h
};

process.on('SIGINT', () => {
  if (shutdownRequested) { console.log('\nForce exit.'); removeLock(); process.exit(0); }
  shutdownRequested = true;
  console.log('\nShutting down (Ctrl+C again to force)...');
});

process.on('SIGTERM', () => {
  shutdownRequested = true;
});

// ─── Crash Diagnosis & Self-Healing ────────────────────
function getEngineLogLines(count) {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const raw = fs.readFileSync(LOG_PATH, 'utf8');
    return raw.trim().split('\n').filter(l => l).slice(-count);
  } catch (e) { return []; }
}

function diagnoseCrash() {
  const lines = getEngineLogLines(80);
  if (lines.length === 0) return null;

  // Only look at ERROR-level lines for crash diagnosis
  const errors = lines.filter(l => l.includes('] [error] ') || l.includes('] [ERROR] '));
  const text = errors.join('\n').toLowerCase();

  // Priority 1: Action block (needs longest wait)
  if (text.includes('action_blocked') || text.includes('action blocked') || text.includes('we restrict')) {
    return {
      type: 'ACTION_BLOCK',
      delay: SUPERVISOR.actionBlockBackoffMs,
      label: 'Instagram action block detected',
      fix: 'Waiting 24h before retry',
    };
  }

  // Priority 2: Browser crash (clean up temp files)
  if (text.includes('browser_lost') || text.includes('chromium crashed')) {
    return {
      type: 'BROWSER_CRASH',
      delay: SUPERVISOR.backoffBaseMs,
      label: 'Chromium browser crashed',
      fix: 'Clearing browser cache and retrying',
    };
  }

  // Priority 3: Proxy failure
  if (text.includes('err_proxy_connection_failed') || text.includes('err_tunnel_connection_failed') || text.includes('proxy-authentication-failed')) {
    return {
      type: 'PROXY_FAILURE',
      delay: SUPERVISOR.backoffBaseMs * 2,
      label: 'Proxy connection failed',
      fix: 'Attempting to bypass proxy or refresh connection',
    };
  }

  // Priority 4: Session expired (clear cookies, re-login needed)

  // Priority 4: Generic crash
  if (text.includes('crash') || errors.length > 0) {
    return {
      type: 'CRASH',
      delay: null,
      label: 'Unhandled error',
      fix: 'Applying standard backoff',
    };
  }

  return null;
}

function applyFix(diagnosis) {
  if (!diagnosis) return;
  switch (diagnosis.type) {
    case 'BROWSER_CRASH':
    case 'PROXY_FAILURE':
      try {
        if (fs.existsSync(SESSION_PATH)) {
          // Clear everything but the 'Default' folder (where sessions live) to reset the environment
          for (const entry of fs.readdirSync(SESSION_PATH)) {
            if (entry !== 'Default' && entry !== 'sessionid') {
              const p = path.join(SESSION_PATH, entry);
              try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
            }
          }
        }
        killZombies();
        console.log('  🧹 Environment refreshed to bypass proxy/browser hang');
      } catch (e) {}
      break;

    case 'SESSION_EXPIRED':
      try {
        if (fs.existsSync(SESSION_PATH)) {
          fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        }
        console.log('  🧹 Cleared stale Instagram session');
      } catch (e) {}
      break;

    case 'ACTION_BLOCK':
      console.log('  ⏸️  Pausing for 24 hours');
      break;
  }
}

async function supervisedRun(script, args, label) {
  let retries = 0;
  let backoff = SUPERVISOR.backoffBaseMs;
  let skipBackoff = false;

  while (retries <= SUPERVISOR.maxRetries) {
    if (shutdownRequested) { removeLock(); process.exit(0); }

    if (retries > 0 && !skipBackoff) {
      // Diagnose what went wrong
      const diag = diagnoseCrash();
      backoff = diag?.delay || Math.min(backoff * 2, SUPERVISOR.backoffMaxMs);
      const waitSec = Math.ceil(backoff / 1000);

      console.log(`\n⚠️  ${label} stopped [${retries}/${SUPERVISOR.maxRetries}]`);
      if (diag) {
        console.log(`  🔍 ${diag.label}`);
        console.log(`  🛠️  ${diag.fix}`);
        applyFix(diag);
      } else {
        console.log('  🔍 No error pattern identified');
      }

      if (backoff > 60000) {
        const mins = Math.ceil(backoff / 60000);
        console.log(`  ⏳ Restarting in ${mins} min...`);
      } else {
        console.log(`  ⏳ Restarting in ${waitSec}s...`);
      }

      await new Promise(r => setTimeout(r, backoff));
    }
    
    // Increment retries after the first run
    if (!skipBackoff) retries++;

    const child = spawn(process.execPath, [path.resolve(__dirname, script), ...args], {
      stdio: 'inherit', cwd: __dirname, env: { ...process.env },
    });
    skipBackoff = false;

    const startTime = Date.now();

    const exitCode = await new Promise((resolve) => {
      const onSig = () => { shutdownRequested = true; child.kill(); };
      process.on('SIGINT', onSig);
      process.on('SIGTERM', onSig);
      child.on('close', async (code) => {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
        
        // Handle Remote Update Trigger
        if (code === 5) {
          console.log('\n🔄 Remote Update Triggered. Installing updates...');
          try {
            await checkForUpdates();
            retries = 0;
            backoff = SUPERVISOR.backoffBaseMs;
            skipBackoff = true;
          } catch (e) {
            console.log(`\n⚠️ Update failed (${e.message}) — restarting with current code.`);
          }
          resolve(0); // Always restart — even if update failed
        } else if (code === 6) {
          console.log('\n💀 Hard Kill Triggered. Rebooting engine cleanly...');
          skipBackoff = true;
          resolve(0); // Treat as clean exit to restart instantly without backoff
        } else {
          resolve(code);
        }
      });
    });

    if (shutdownRequested) {
      console.log(`\n${label} stopped by user.`);
      removeLock(); process.exit(0);
    }

    // Stable run resets retry counter + backoff
    if (Date.now() - startTime >= SUPERVISOR.backoffResetAfterMs) {
      backoff = SUPERVISOR.backoffBaseMs;
      retries = 0;
    } else if (retries === 0) {
      retries = 1; // first crash after a successful run
    }
  }

  // All retries exhausted — print final diagnosis
  const diag = diagnoseCrash();
  console.log(`\n⛔ ${label} failed ${SUPERVISOR.maxRetries} times.`);
  if (diag) {
    console.log(`   Last error: ${diag.label}`);
    console.log(`   Run: node start.cjs ${mode} to retry manually`);
  }
  removeLock(); process.exit(1);
}

async function run() {
  let updateAttempted = false;

  // ─── Cleanup Stale Scheduled Task ─────────────────
  // Prevents ghost watchdog from spawning duplicate engines after reinstall.
  try {
    const cp = require('child_process');
    cp.exec('schtasks /Delete /TN "AntigravityCloudWatchdog" /F', { timeout: 5000 }, () => {});
  } catch (e) {}

  // ─── Paused State Recovery ────────────────────────
  // If engine was paused before crash/reboot, don't restart — wait for start command.
  const statePath = path.resolve(__dirname, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const engState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (engState.paused) {
        slog('⏸️  Engine was paused before shutdown. Waiting for start command...');
        while (true) {
          if (shutdownRequested) { removeLock(); process.exit(0); }
          // Check for start command
          try {
            const { createClient } = require('@supabase/supabase-js');
            const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
              global: {
          headers: {
            'x-workspace-secret': config.workspaceSecret || ''
          }
        },
        realtime: {
          transport: getWebSocket()
        }
      });
            const { data: starts } = await sb.from('engine_commands')
              .select('id')
              .eq('workspace_id', config.workspaceId)
              .eq('command', 'start')
              .is('acknowledged_at', null)
              .limit(1);
            if (starts && starts.length > 0) {
              engState.paused = false;
              fs.writeFileSync(statePath, JSON.stringify(engState, null, 2));
              await sb.from('engine_commands').update({ acknowledged_at: new Date().toISOString() })
                .eq('workspace_id', config.workspaceId).eq('command', 'start').is('acknowledged_at', null);
              slog('▶️  Start command received. Resuming engine...');
              break;
            }
          } catch (e) { /* retry on next loop */ }
          await new Promise(r => setTimeout(r, 10000));
        }
      }
    } catch (e) { /* corrupted state.json, ignore and continue */ }
  }

  // 1. Dependency Integrity Check (Self-Repair)
  try {
    require('@supabase/supabase-js');
    require('adm-zip');
  } catch (e) {
    slog(`[INTEGRITY] Missing dependencies detected (${e.message}). Forcing repair...`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await new Promise((res) => {
      const install = spawn(npm, ['install'], { stdio: 'inherit', cwd: __dirname, shell: process.platform === 'win32' });
      install.on('close', res);
    });
    // Clear Node's require cache so fresh install is picked up
    for (const key of Object.keys(require.cache)) {
      if (key.includes('node_modules')) delete require.cache[key];
    }
  }

  // 2. Check for remote update commands on startup
  try {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      global: {
          headers: {
            'x-workspace-secret': config.workspaceSecret || ''
          }
        },
        realtime: {
          transport: getWebSocket()
        }
      });
    const { data: pending, error: pe } = await sb
      .from('engine_commands')
      .select('id')
      .eq('workspace_id', config.workspaceId)
      .eq('command', 'update')
      .is('acknowledged_at', null);
      
    if (!pe && pending && pending.length > 0) {
      slog(`🔄 ${pending.length} pending update(s) found. Installing...`);
      await checkForUpdates();
      updateAttempted = true;
      await sb.from('engine_commands').update({ acknowledged_at: new Date().toISOString() }).in('id', pending.map(r => r.id));
    }
    
    // Acknowledge stale stop/hard_kill so engine doesn't immediately exit
    await sb.from('engine_commands').update({ acknowledged_at: new Date().toISOString() })
      .eq('workspace_id', config.workspaceId)
      .is('acknowledged_at', null)
      .in('command', ['hard_kill', 'stop']);
  } catch (e) {
    slog(`⚠️  Startup command check skipped: ${e.message}`);
  }

  // 3. Regular update check (only if not already updated via command)
  if (!updateAttempted) {
    await checkForUpdates();
  }

  slog('[ENGINE] Starting engine process...');
  const { chromium } = require('playwright-core');
  
  // Check session (with cookie backup fallback)
  let hasSession = false;
  try {
    const context = await chromium.launchPersistentContext(SESSION_PATH, { headless: true });
    const cookies = await context.cookies('https://www.instagram.com');
    hasSession = cookies.some(c => c.name === 'sessionid');
    // Cookie backup injection if no session found
    if (!hasSession) {
      const cookiesPath = path.join(__dirname, 'ig_session_cookies.json');
      if (fs.existsSync(cookiesPath)) {
        try {
          const raw = fs.readFileSync(cookiesPath, 'utf8');
          const backupCookies = JSON.parse(raw);
          if (Array.isArray(backupCookies) && backupCookies.length > 0) {
            const playCookies = backupCookies.map(c => ({
              name: c.name, value: c.value, domain: c.domain || '.instagram.com',
              path: c.path || '/', expires: c.expires ? Math.floor(c.expires) : undefined,
              secure: c.secure !== false, httpOnly: c.httpOnly || false, sameSite: c.sameSite || 'Lax',
            }));
            await context.addCookies(playCookies);
            hasSession = (await context.cookies('https://www.instagram.com')).some(c => c.name === 'sessionid');
            slog(hasSession ? '[COOKIE_INJECT_OK] Session restored from backup cookies' : '[COOKIE_INJECT_FAIL] Backup cookies exist but invalid');
          }
        } catch (e) { slog(`[COOKIE_INJECT] Error: ${e.message}`); }
      }
    }
    await context.close();
  } catch (e) { console.error(`[SESSION_CHECK] ${e.message}`); }

  if (!hasSession) {
    console.log('No Instagram session found. Opening browser for login...\n');
    await new Promise((resolve, reject) => {
      const login = spawn(process.execPath, [path.resolve(__dirname, 'login.cjs')], { stdio: 'inherit', cwd: __dirname });
      login.on('close', (code) => {
        if (code === 0) resolve();
        else { console.log('\nLogin cancelled.'); process.exit(1); }
      });
    });
  }

  // Run requested mode with supervisor
  if (mode === 'dm') {
    await supervisedRun('engine.cjs', [''], 'DM Engine');
  } else if (mode === 'harvest') {
    // One-shot — no supervisor
    await new Promise((resolve) => {
      const h = spawn(process.execPath, [path.resolve(__dirname, 'harvester.cjs')], { stdio: 'inherit', cwd: __dirname });
      h.on('close', () => resolve());
    });
  } else if (mode === 'both') {
    await new Promise((resolve) => {
      const h = spawn(process.execPath, [path.resolve(__dirname, 'harvester.cjs')], { stdio: 'inherit', cwd: __dirname });
      h.on('close', () => resolve());
    });
    await supervisedRun('engine.cjs', [''], 'DM Engine');
  } else if (mode === 'auto') {
    await supervisedRun('engine.cjs', ['auto'], 'Auto Engine');
  }
  // Register OS-level watchdog scheduler after first successful run
  try { await registerWatchdog(); } catch (e) { slog(`[WATCHDOG] Registration error: ${e.message}`); }
}


