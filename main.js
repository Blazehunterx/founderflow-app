const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let engineProcess = null;
let engineState = 'stopped'; // stopped | starting | running | paused | error

// ── Paths ─────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const isDev = !app.isPackaged;
const ENGINE_DIR = isDev
  ? path.join(__dirname, 'engine')
  : path.join(USER_DATA, 'engine');
const ENGINE_SOURCE = isDev
  ? path.join(__dirname, 'engine')
  : path.join(process.resourcesPath, 'engine');
const CONFIG_PATH = path.join(ENGINE_DIR, 'config.json');

function syncEngineFiles() {
  if (isDev) return;
  if (!fs.existsSync(ENGINE_SOURCE)) return;
  if (!fs.existsSync(ENGINE_DIR)) fs.mkdirSync(ENGINE_DIR, { recursive: true });

  const files = fs.readdirSync(ENGINE_SOURCE);
  for (const file of files) {
    const src = path.join(ENGINE_SOURCE, file);
    const dest = path.join(ENGINE_DIR, file);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      // Recurse into subdirectories (but skip node_modules, sessions)
      if (['node_modules', 'sessions', 'sessions2', 'founderflow_sessions'].includes(file)) continue;
      const subFiles = fs.readdirSync(src);
      for (const sub of subFiles) {
        const subSrc = path.join(src, sub);
        const subDest = path.join(dest, sub);
        if (!fs.existsSync(subDest)) {
          fs.copyFileSync(subSrc, subDest);
        }
      }
    } else {
      // Overwrite config.json only if it doesn't exist (preserve user edits)
      if (file === 'config.json' && fs.existsSync(dest)) continue;
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    }
  }
}

// Bundled Node.js path (inside app resources)
function getNodePath() {
  const isDev = !app.isPackaged;
  if (isDev) {
    return 'node'; // Use system node in dev
  }
  const platform = process.platform;

  // Check bundled runtime first
  let bundledPath;
  if (platform === 'win32') {
    bundledPath = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
  } else {
    bundledPath = path.join(process.resourcesPath, 'node-runtime', 'bin', 'node');
  }

  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  // Fallback: check for fallback marker (bundled wrong platform)
  const fallbackPath = path.join(process.resourcesPath, 'node-runtime', '.fallback');
  if (fs.existsSync(fallbackPath)) {
    console.log('[getNodePath] Using system node (fallback mode)');
    return 'node';
  }

  // Fallback: try system node on Mac/Linux
  if (platform === 'darwin' || platform === 'linux') {
    try {
      execSync('which node', { encoding: 'utf8', stdio: 'pipe' });
      return 'node';
    } catch {}
  }

  // Last resort: return expected path even if missing (will show error)
  return bundledPath;
}

// ── Window ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? false : true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    stopEngine();
    mainWindow = null;
  });
}

// ── Engine Management ─────────────────────────────
function startEngine() {
  if (engineState === 'running' || engineState === 'starting') return;

  const configExists = fs.existsSync(CONFIG_PATH);
  if (!configExists) {
    mainWindow?.webContents.send('engine:error', 'No config.json found. Please log in to Instagram first.');
    return;
  }

  engineState = 'starting';
  mainWindow?.webContents.send('engine:status', 'starting');

  const nodePath = getNodePath();
  const enginePath = path.join(ENGINE_DIR, 'engine.cjs');

  if (!fs.existsSync(enginePath)) {
    mainWindow?.webContents.send('engine:error', 'engine.cjs not found in engine directory.');
    engineState = 'stopped';
    mainWindow?.webContents.send('engine:status', 'stopped');
    return;
  }

  try {
    engineProcess = spawn(nodePath, [enginePath], {
      cwd: ENGINE_DIR,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    engineState = 'running';
    mainWindow?.webContents.send('engine:status', 'running');

    engineProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        mainWindow?.webContents.send('engine:log', line);
      });
    });

    engineProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        mainWindow?.webContents.send('engine:error', line);
      });
    });

    engineProcess.on('exit', (code, signal) => {
      engineState = 'stopped';
      engineProcess = null;
      mainWindow?.webContents.send('engine:status', 'stopped');
      mainWindow?.webContents.send('engine:log', `Engine exited (code: ${code}, signal: ${signal})`);
    });

    engineProcess.on('error', (err) => {
      engineState = 'error';
      engineProcess = null;
      mainWindow?.webContents.send('engine:error', `Failed to start engine: ${err.message}`);
      mainWindow?.webContents.send('engine:status', 'error');
    });

    mainWindow?.webContents.send('engine:log', 'Engine started — pulse loop active');
  } catch (err) {
    engineState = 'error';
    mainWindow?.webContents.send('engine:error', `Failed to start engine: ${err.message}`);
    mainWindow?.webContents.send('engine:status', 'error');
  }
}

function stopEngine() {
  if (engineProcess) {
    engineProcess.kill('SIGTERM');
    engineProcess = null;
    engineState = 'stopped';
    mainWindow?.webContents.send('engine:status', 'stopped');
    mainWindow?.webContents.send('engine:log', 'Engine stopped');
  }
}

function pauseEngine() {
  if (engineProcess && engineState === 'running') {
    engineProcess.kill('SIGSTOP');
    engineState = 'paused';
    mainWindow?.webContents.send('engine:status', 'paused');
    mainWindow?.webContents.send('engine:log', 'Engine paused');
  }
}

function resumeEngine() {
  if (engineProcess && engineState === 'paused') {
    engineProcess.kill('SIGCONT');
    engineState = 'running';
    mainWindow?.webContents.send('engine:status', 'running');
    mainWindow?.webContents.send('engine:log', 'Engine resumed');
  }
}

// ── Instagram Login (Playwright) ────────────────────
let loginBrowser = null;
let loginContext = null;

async function openInstagramLogin() {
  try {
    const { chromium } = require('playwright-core');
    const sessionDir = path.join(ENGINE_DIR, 'sessions');
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    mainWindow?.webContents.send('deps:log', 'Launching browser for Instagram login...\n');

    // Try system Chrome first, fall back to bundled Chromium
    let launchOpts = {
      headless: false,
      viewport: null,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-automation',
      ],
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };
    try {
      loginContext = await chromium.launchPersistentContext(sessionDir, { ...launchOpts, channel: 'chrome' });
    } catch {
      // No system Chrome — Playwright will use its bundled Chromium
      loginContext = await chromium.launchPersistentContext(sessionDir, launchOpts);
    }

    const page = await loginContext.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    mainWindow?.webContents.send('login:browser-opened');

    for (let r = 0; r < 3; r++) {
      try {
        await page.goto('https://www.instagram.com/accounts/login/', {
          waitUntil: 'networkidle',
          timeout: 60000,
        });
        break;
      } catch (e) {
        if (r === 2) throw new Error('Failed to load Instagram after 3 attempts');
        await new Promise(res => setTimeout(res, 5000));
      }
    }

    mainWindow?.webContents.send('deps:log', 'Browser opened. Log into Instagram in the browser window.\n');
    mainWindow?.webContents.send('deps:log', 'Waiting for login (up to 5 minutes)...\n');

    // Poll for session cookie
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(res => setTimeout(res, 3000));

      // Dismiss common popups
      const popups = [
        'button:has-text("Not now")', 'button:has-text("Not Now")',
        'button:has-text("Later")', 'button:has-text("Cancel")',
        'button:has-text("Save Info")', 'button:has-text("Remind Me Later")',
        'button:has-text("Allow all cookies")',
        'button:has-text("Decline optional cookies")',
        'button:has-text("Allow essential and optional cookies")',
      ];
      for (const sel of popups) {
        try { const btn = await page.$(sel); if (btn) await btn.click(); } catch {}
      }

      const cookies = await loginContext.cookies('https://www.instagram.com');
      const sessionid = cookies.find(c => c.name === 'sessionid');
      if (sessionid) {
        mainWindow?.webContents.send('deps:log', 'Login detected! Saving session...\n');

        const cookieMap = {};
        cookies.filter(c => ['sessionid', 'ds_user_id', 'csrftoken', 'rur'].includes(c.name))
          .forEach(c => { cookieMap[c.name] = c.value; });

        let config = {};
        if (fs.existsSync(CONFIG_PATH)) {
          try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
        }

        config.igSession = {
          sessionid: cookieMap.sessionid,
          ds_user_id: cookieMap.ds_user_id || '',
          csrftoken: cookieMap.csrftoken || '',
          rur: cookieMap.rur || '',
          capturedAt: new Date().toISOString(),
        };

        if (!fs.existsSync(ENGINE_DIR)) fs.mkdirSync(ENGINE_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

        let username = null;
        try {
          username = await page.evaluate(() => {
            const el = document.querySelector('[href*="/accounts/edit"]')
              || document.querySelector('header a[href^="/"]:not([href*="/"])');
            if (el) {
              const href = el.getAttribute('href') || el.closest?.('a')?.getAttribute('href');
              if (href && href !== '/') return href.replace(/^\//, '').split('/')[0];
            }
            return null;
          });
        } catch {}

        await loginContext.close();
        loginContext = null;

        return { success: true, userId: username || cookieMap.ds_user_id };
      }

      if (i % 5 === 0 && i > 0) {
        mainWindow?.webContents.send('deps:log', `Waiting for login... (${i * 3}s / 300s)\n`);
      }
    }

    await loginContext.close();
    loginContext = null;
    return { success: false, error: 'Login timed out after 5 minutes' };
  } catch (err) {
    if (loginContext) { try { await loginContext.close(); } catch {} loginContext = null; }
    return { success: false, error: err.message };
  }
}

async function captureCookies() {
  // Playwright flow auto-captures — this is just a fallback
  if (!fs.existsSync(CONFIG_PATH)) {
    return { success: false, error: 'No session found. Click "Login to Instagram" first.' };
  }
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (config.igSession?.sessionid) {
      return { success: true, userId: config.igSession.ds_user_id };
    }
  } catch {}
  return { success: false, error: 'No valid session found. Click "Login to Instagram" first.' };
}

// ── Config Download from Dashboard ────────────────
async function downloadConfig(event, workspaceId) {
  try {
    const https = require('https');
    const url = `https://founderflow-dashboard.vercel.app/api/client/config?workspace_id=${workspaceId}`;

    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const config = JSON.parse(data);
            if (config.error) { resolve({ success: false, error: config.error }); return; }

            // Preserve existing igSession if present
            let existing = {};
            if (fs.existsSync(CONFIG_PATH)) {
              try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
            }
            config.igSession = existing.igSession || null;

            if (!fs.existsSync(ENGINE_DIR)) fs.mkdirSync(ENGINE_DIR, { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

            resolve({ success: true, workspaceName: config.workspaceName });
          } catch (e) {
            resolve({ success: false, error: 'Invalid response from server' });
          }
        });
      }).on('error', (e) => {
        resolve({ success: false, error: e.message });
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Config Refresh from Dashboard (settings only) ─
async function refreshConfig() {
  try {
    let workspaceId = null;
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        workspaceId = config.workspaceId;
      } catch {}
    }
    if (!workspaceId) {
      return { success: false, error: 'No workspace configured. Connect to dashboard first.' };
    }

    mainWindow?.webContents.send('engine:log', 'Refreshing settings from dashboard...');

    const https = require('https');
    const url = `https://founderflow-dashboard.vercel.app/api/client/config?workspace_id=${workspaceId}`;

    return new Promise((resolve) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const config = JSON.parse(data);
            if (config.error) { resolve({ success: false, error: config.error }); return; }

            // Preserve igSession
            let existing = {};
            if (fs.existsSync(CONFIG_PATH)) {
              try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
            }
            config.igSession = existing.igSession || null;

            if (!fs.existsSync(ENGINE_DIR)) fs.mkdirSync(ENGINE_DIR, { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

            mainWindow?.webContents.send('engine:log', 'Settings refreshed from dashboard.');
            resolve({ success: true, workspaceName: config.workspaceName });
          } catch (e) {
            resolve({ success: false, error: 'Invalid response from server' });
          }
        });
      }).on('error', (e) => {
        resolve({ success: false, error: e.message });
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Engine Update from Dashboard ──────────────────
async function updateEngine() {
  try {
    // Read workspace_id from config
    let workspaceId = null;
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        workspaceId = config.workspaceId;
      } catch {}
    }
    if (!workspaceId) {
      return { success: false, error: 'No workspace configured. Connect to dashboard first.' };
    }

    mainWindow?.webContents.send('engine:log', 'Downloading update from dashboard...');

    // Stop engine if running
    if (engineProcess) {
      engineProcess.kill('SIGTERM');
      engineProcess = null;
      engineState = 'stopped';
      mainWindow?.webContents.send('engine:status', 'stopped');
    }

    // Download ZIP
    const https = require('https');
    const zipPath = path.join(USER_DATA, 'update.zip');
    const url = `https://founderflow-dashboard.vercel.app/api/client/download?engine_update=1&workspace_id=${workspaceId}`;

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(zipPath);
      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed (HTTP ${res.statusCode})`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (e) => {
        fs.unlink(zipPath, () => {});
        reject(e);
      });
    });

    mainWindow?.webContents.send('engine:log', 'Download complete. Extracting...');

    // Preserve config.json and sessions
    const configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
    const sessionDir = path.join(ENGINE_DIR, 'sessions');
    const sessionExists = fs.existsSync(sessionDir);

    // Extract with PowerShell
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${ENGINE_DIR}' -Force"`, {
        encoding: 'utf8',
        timeout: 60000,
      });
    } else {
      execSync(`unzip -o "${zipPath}" -d "${ENGINE_DIR}"`, {
        encoding: 'utf8',
        timeout: 60000,
      });
    }

    // Restore config.json
    if (configBackup) {
      fs.writeFileSync(CONFIG_PATH, configBackup);
    }

    // Re-sync engine files from resources (updates bundled engine files)
    syncEngineFiles();

    // Restore config again (syncEngineFiles might overwrite)
    if (configBackup) {
      fs.writeFileSync(CONFIG_PATH, configBackup);
    }

    // Clean up
    fs.unlinkSync(zipPath);

    mainWindow?.webContents.send('engine:log', 'Update complete! Engine files updated.');

    // Re-install deps if package.json changed
    const nodeModulesExists = fs.existsSync(path.join(ENGINE_DIR, 'node_modules'));
    if (!nodeModulesExists) {
      mainWindow?.webContents.send('engine:log', 'Installing updated dependencies...');
      await installDependencies();
    }

    return { success: true };
  } catch (e) {
    mainWindow?.webContents.send('engine:error', `Update failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ── Settings ──────────────────────────────────────
function loadSettings() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      dmTemplate: config.dmTemplate || '',
      aiTrainingContext: config.aiTrainingContext || '',
      calendlyLink: config.calendlyLink || '',
      followupDelays: config.followupDelays || [3, 5, 7],
      followupTemplates: config.followupTemplates || ['', '', ''],
      maxFollowups: config.maxFollowups ?? 3,
      nicheTags: config.nicheTags || [],
    };
  } catch { return {}; }
}

function saveSettings(settings) {
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  }

  config.dmTemplate = settings.dmTemplate;
  config.aiTrainingContext = settings.aiTrainingContext;
  config.calendlyLink = settings.calendlyLink;
  config.followupDelays = settings.followupDelays;
  config.followupTemplates = settings.followupTemplates;
  config.maxFollowups = settings.maxFollowups;
  config.nicheTags = settings.nicheTags;

  if (!fs.existsSync(ENGINE_DIR)) {
    fs.mkdirSync(ENGINE_DIR, { recursive: true });
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return { success: true };
}

// ── Environment Check ─────────────────────────────
function checkEnvironment() {
  const nodePath = getNodePath();
  let nodeAvailable = false;
  let nodeVersion = '';

  try {
    nodeVersion = execSync(`"${nodePath}" --version`, { encoding: 'utf8' }).trim();
    nodeAvailable = true;
  } catch {
    nodeAvailable = false;
  }

  const configExists = fs.existsSync(CONFIG_PATH);
  let hasSession = false;
  if (configExists) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      hasSession = !!config.igSession?.sessionid;
    } catch {}
  }

  const depsInstalled = fs.existsSync(path.join(ENGINE_DIR, 'node_modules'));

  return {
    nodeAvailable,
    nodeVersion,
    configExists,
    hasSession,
    depsInstalled,
    engineDir: ENGINE_DIR,
  };
}

// ── Install Dependencies ──────────────────────────
function installDependencies() {
  return new Promise((resolve, reject) => {
    try {
      const engineExists = fs.existsSync(path.join(ENGINE_DIR, 'package.json'));
      if (!engineExists) {
        reject(new Error('No package.json in engine directory'));
        return;
      }

      const nodeModulesExists = fs.existsSync(path.join(ENGINE_DIR, 'node_modules'));
      if (nodeModulesExists) {
        resolve({ success: true });
        return;
      }

      mainWindow?.webContents.send('deps:log', 'Installing dependencies via npm install...\n');

      const result = execSync('npm install --no-audit --no-fund', {
        cwd: ENGINE_DIR,
        env: { ...process.env },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 300000,
      });

      mainWindow?.webContents.send('deps:log', result || 'npm install complete\n');
      resolve({ success: true });
    } catch (err) {
      const msg = err.stdout || err.stderr || err.message;
      mainWindow?.webContents.send('deps:log', msg + '\n');
      reject(new Error(msg));
    }
  });
}

// ── IPC Handlers ──────────────────────────────────
ipcMain.handle('app:check-environment', checkEnvironment);
ipcMain.handle('app:start-engine', startEngine);
ipcMain.handle('app:stop-engine', stopEngine);
ipcMain.handle('app:pause-engine', pauseEngine);
ipcMain.handle('app:resume-engine', resumeEngine);
ipcMain.handle('app:open-instagram', openInstagramLogin);
ipcMain.handle('app:capture-cookies', captureCookies);
ipcMain.handle('app:load-settings', loadSettings);
ipcMain.handle('app:save-settings', saveSettings);
ipcMain.handle('app:download-config', downloadConfig);
ipcMain.handle('app:refresh-config', refreshConfig);
ipcMain.handle('app:update-engine', updateEngine);
ipcMain.handle('app:install-deps', installDependencies);
ipcMain.handle('app:open-engine-dir', () => shell.openPath(ENGINE_DIR));
ipcMain.handle('app:quit', () => app.quit());

// ── App Lifecycle ─────────────────────────────────
app.whenReady().then(() => { syncEngineFiles(); createWindow(); });

app.on('window-all-closed', () => {
  stopEngine();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
