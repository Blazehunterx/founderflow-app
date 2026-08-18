const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

// ── Multi-instance support ─────────────────────────
// Parse --workspace=ID from command-line args
const workspaceArg = process.argv.find(a => a.startsWith('--workspace='));
const WORKSPACE_ID = workspaceArg ? workspaceArg.split('=')[1] : null;

let mainWindow = null;
let engineProcess = null;
let engineState = 'stopped';

// ── Paths ─────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const isDev = !app.isPackaged;

// Per-workspace engine directory: engine-{workspaceId}/ or engine/ (default)
const ENGINE_DIR = isDev
  ? path.join(__dirname, 'engine')
  : WORKSPACE_ID
    ? path.join(USER_DATA, `engine-${WORKSPACE_ID}`)
    : path.join(USER_DATA, 'engine');

const ENGINE_SOURCE = isDev
  ? path.join(__dirname, 'engine')
  : path.join(process.resourcesPath, 'engine');

const CONFIG_PATH = path.join(ENGINE_DIR, 'config.json');

// Workspace registry (tracks all connected workspaces)
const WORKSPACES_PATH = path.join(USER_DATA, 'workspaces.json');

function loadWorkspaces() {
  try {
    if (fs.existsSync(WORKSPACES_PATH)) {
      return JSON.parse(fs.readFileSync(WORKSPACES_PATH, 'utf8'));
    }
  } catch {}
  return [];
}

function saveWorkspaces(list) {
  if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(WORKSPACES_PATH, JSON.stringify(list, null, 2));
}

function registerWorkspace(id, name) {
  const list = loadWorkspaces();
  const existing = list.find(w => w.id === id);
  if (existing) {
    existing.name = name || existing.name;
  } else {
    list.push({ id, name: name || id });
  }
  saveWorkspaces(list);
}

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
      if (['node_modules', 'sessions', 'sessions2', 'founderflow_sessions', 'desktop'].includes(file)) continue;
      const subFiles = fs.readdirSync(src);
      for (const sub of subFiles) {
        const subSrc = path.join(src, sub);
        const subDest = path.join(dest, sub);
        if (!fs.existsSync(subDest)) {
          fs.copyFileSync(subSrc, subDest);
        }
      }
    } else {
      if (file === 'config.json' && fs.existsSync(dest)) continue;
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    }
  }
}

// Bundled Node.js path (inside app resources) with fallbacks
function getNodePath() {
  if (isDev) return 'node';
  const platform = process.platform;
  const candidates = [];

  // 1. Bundled node-runtime in app resources
  if (platform === 'win32') {
    candidates.push(path.join(process.resourcesPath, 'node-runtime', 'node.exe'));
  } else {
    // Build downloads into node-runtime/{arch}/bin/node
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    candidates.push(path.join(process.resourcesPath, 'node-runtime', arch, 'bin', 'node'));
    candidates.push(path.join(process.resourcesPath, 'node-runtime', 'bin', 'node'));
  }

  // 2. node-runtime next to the exe
  if (platform === 'win32') {
    candidates.push(path.join(path.dirname(process.execPath), 'node-runtime', 'node.exe'));
  } else {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    candidates.push(path.join(path.dirname(process.execPath), '..', 'Resources', 'node-runtime', arch, 'bin', 'node'));
  }

  // 3. node.exe in C:\Windows (system-wide install)
  if (platform === 'win32') {
    candidates.push('C:\\Windows\\node.exe');
  }

  // 4. System PATH fallback
  candidates.push('node');

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { encoding: 'utf8', stdio: 'pipe' });
      return candidate;
    } catch {}
  }

  return candidates[candidates.length - 1];
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

  // Set window title with workspace name
  const wsName = getWorkspaceName();
  mainWindow.setTitle(wsName ? `FounderFlow — ${wsName}` : 'FounderFlow');

  mainWindow.loadFile('index.html');

  const updatedUI = path.join(ENGINE_DIR, 'desktop', 'index.html');
  if (fs.existsSync(updatedUI)) {
    mainWindow.loadURL('file://' + updatedUI);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    stopEngine();
    mainWindow = null;
  });
}

function getWorkspaceName() {
  if (!WORKSPACE_ID) return null;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return config.workspaceName || null;
    }
  } catch {}
  return WORKSPACE_ID.substring(0, 8);
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

// ── Open New Instance ─────────────────────────────
function openNewInstance(event, targetWorkspaceId) {
  const appPath = isDev ? process.execPath : process.execPath;
  const args = [];

  if (targetWorkspaceId) {
    args.push(`--workspace=${targetWorkspaceId}`);
  }

  // Launch new instance
  spawn(appPath, args, {
    detached: true,
    stdio: 'ignore',
  }).unref();
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

    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(res => setTimeout(res, 3000));

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

            let existing = {};
            if (fs.existsSync(CONFIG_PATH)) {
              try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
            }
            config.igSession = existing.igSession || null;

            if (!fs.existsSync(ENGINE_DIR)) fs.mkdirSync(ENGINE_DIR, { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

            // Register in workspace list
            registerWorkspace(workspaceId, config.workspaceName);

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

// ── Config Refresh from Dashboard ──────────────────
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

            let existing = {};
            if (fs.existsSync(CONFIG_PATH)) {
              try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
            }
            config.igSession = existing.igSession || null;

            if (!fs.existsSync(ENGINE_DIR)) fs.mkdirSync(ENGINE_DIR, { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

            // Update window title
            if (mainWindow && config.workspaceName) {
              mainWindow.setTitle(`FounderFlow — ${config.workspaceName}`);
            }

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

    if (engineProcess) {
      engineProcess.kill('SIGTERM');
      engineProcess = null;
      engineState = 'stopped';
      mainWindow?.webContents.send('engine:status', 'stopped');
    }

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

    const configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;

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

    if (configBackup) {
      fs.writeFileSync(CONFIG_PATH, configBackup);
    }

    syncEngineFiles();

    if (configBackup) {
      fs.writeFileSync(CONFIG_PATH, configBackup);
    }

    fs.unlinkSync(zipPath);

    mainWindow?.webContents.send('engine:log', 'Update complete! Engine files updated.');

    const desktopIndex = path.join(ENGINE_DIR, 'desktop', 'index.html');
    if (fs.existsSync(desktopIndex)) {
      mainWindow?.webContents.send('engine:log', 'Desktop UI updated. Reloading...');
      setTimeout(() => {
        mainWindow?.loadURL('file://' + desktopIndex);
      }, 1000);
    }

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
      aiClientFeedback: config.aiClientFeedback || '',
      calendlyLink: config.calendlyLink || '',
      followupDelays: config.followupDelays || [3, 5, 7],
      followupTemplates: config.followupTemplates || ['', '', ''],
      maxFollowups: config.maxFollowups ?? 3,
      nicheTags: config.nicheTags || [],
      workspaceId: config.workspaceId || null,
      workspaceName: config.workspaceName || null,
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
  config.aiClientFeedback = settings.aiClientFeedback;
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
  let workspaceName = null;
  if (configExists) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      hasSession = !!config.igSession?.sessionid;
      workspaceName = config.workspaceName || null;
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
    workspaceId: WORKSPACE_ID,
    workspaceName,
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
ipcMain.handle('app:open-new-instance', (event, targetWorkspaceId) => openNewInstance(event, targetWorkspaceId));
ipcMain.handle('app:get-workspaces', () => loadWorkspaces());
ipcMain.handle('app:get-workspace-id', () => WORKSPACE_ID);
ipcMain.handle('app:fetch-upcoming-leads', fetchUpcomingLeads);
ipcMain.handle('app:exclude-lead', excludeLead);

// ── Lead Review ───────────────────────────────────
async function fetchUpcomingLeads() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return { success: false, error: 'No workspace configured' };
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config.workspaceId || !config.workspaceSecret) {
      return { success: false, error: 'Workspace not connected' };
    }

    const https = require('https');
    const url = `https://founderflow-dashboard.vercel.app/api/leads/upcoming?limit=500`;

    return new Promise((resolve) => {
      const req = https.get(url, {
        headers: {
          'x-workspace-id': config.workspaceId,
          'x-workspace-secret': config.workspaceSecret,
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) { resolve({ success: false, error: json.error }); return; }
            resolve({ success: true, leads: json.leads || [] });
          } catch (e) {
            resolve({ success: false, error: 'Invalid response from server' });
          }
        });
      }).on('error', (e) => {
        resolve({ success: false, error: e.message });
      });
      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ success: false, error: 'Request timed out' });
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function excludeLead(event, leadId, reason) {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return { success: false, error: 'No workspace configured' };
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config.workspaceId || !config.workspaceSecret) {
      return { success: false, error: 'Workspace not connected' };
    }

    const https = require('https');
    const url = `https://founderflow-dashboard.vercel.app/api/leads/${leadId}/exclude`;

    return new Promise((resolve) => {
      const postData = JSON.stringify({ reason: reason || 'Removed from lead review' });
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'x-workspace-id': config.workspaceId,
          'x-workspace-secret': config.workspaceSecret,
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) { resolve({ success: false, error: json.error }); return; }
            resolve({ success: true });
          } catch (e) {
            resolve({ success: false, error: 'Invalid response from server' });
          }
        });
      }).on('error', (e) => {
        resolve({ success: false, error: e.message });
      });
      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ success: false, error: 'Request timed out' });
      });
      req.write(postData);
      req.end();
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── App Lifecycle ─────────────────────────────────
// Allow multiple instances (each with different --workspace)
app.allowSecondInstance = true;

app.on('second-instance', (event, commandLine) => {
  // When a second instance launches, focus the existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => { syncEngineFiles(); createWindow(); });

app.on('window-all-closed', () => {
  stopEngine();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
