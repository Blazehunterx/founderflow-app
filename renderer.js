// ── State ───────────────────────────────────────
let logCount = 0;
let env = null;

// ── Init ────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await checkEnvironment();
});

function setupEventListeners() {
  window.api.onLog(msg => appendLog(msg, 'info'));
  window.api.onError(msg => appendLog(msg, 'error'));
  window.api.onStatus(status => updateEngineStatus(status));
  window.api.onDepsLog(msg => appendLog(msg, 'info'));
  window.api.onLoginOpened(() => {
    appendLog('Browser opened. Log into Instagram, then click "Capture Session".', 'warn');
  });
}

// ── Environment Check ───────────────────────────
async function checkEnvironment() {
  appendLog('Checking environment...', 'info');

  env = await window.api.checkEnvironment();

  const setupBody = document.getElementById('setupBody');
  setupBody.innerHTML = '';

  // Step 1: Node.js
  const nodeStep = createStep(
    env.nodeAvailable ? 'done' : 'error',
    '1',
    'Node.js',
    env.nodeAvailable ? `${env.nodeVersion} detected` : 'Not found — reinstall the app',
    null
  );
  setupBody.appendChild(nodeStep);

  if (!env.nodeAvailable) {
    setDot('envPill', 'error');
    return;
  }
  setDot('envPill', 'ok');

  // Step 2: Dependencies
  if (!env.depsInstalled) {
    const depsStep = createStep('active', '2', 'Dependencies', 'Installing packages...', 'install-deps');
    setupBody.appendChild(depsStep);
    setDot('envPill', 'active');

    try {
      await window.api.installDeps();
      depsStep.querySelector('.step-icon').className = 'step-icon done';
      depsStep.querySelector('.step-icon').textContent = '✓';
      depsStep.querySelector('.step-desc').textContent = 'Installed';
      appendLog('Dependencies installed', 'success');
    } catch (err) {
      depsStep.querySelector('.step-icon').className = 'step-icon error';
      depsStep.querySelector('.step-desc').textContent = 'Failed: ' + err.message;
      appendLog('Failed to install dependencies: ' + err.message, 'error');
      return;
    }
  } else {
    const depsStep = createStep('done', '2', 'Dependencies', 'Installed', null);
    setupBody.appendChild(depsStep);
  }

  // Step 3: Instagram Login
  if (!env.hasSession) {
    const igStep = createStep('active', '3', 'Instagram', 'Not logged in', 'ig-login');
    setupBody.appendChild(igStep);
    setDot('igPill', 'active');
  } else {
    const igStep = createStep('done', '3', 'Instagram', 'Logged in ✓', null);
    setupBody.appendChild(igStep);
    setDot('igPill', 'ok');

    // Step 4: Ready
    const readyStep = createStep('done', '4', 'Ready', 'All checks passed. Start the engine.', null);
    setupBody.appendChild(readyStep);
  }

  // Load settings
  await loadSettings();

  appendLog('Environment check complete', 'success');
}

function createStep(state, num, title, desc, action) {
  const step = document.createElement('div');
  step.className = 'setup-step';

  const icon = document.createElement('div');
  icon.className = `step-icon ${state}`;
  icon.textContent = state === 'done' ? '✓' : state === 'error' ? '✕' : num;

  const content = document.createElement('div');
  content.className = 'step-content';

  const titleEl = document.createElement('div');
  titleEl.className = 'step-title';
  titleEl.textContent = title;

  const descEl = document.createElement('div');
  descEl.className = 'step-desc';
  descEl.textContent = desc;

  content.appendChild(titleEl);
  content.appendChild(descEl);

  if (action === 'ig-login') {
    const btn = document.createElement('button');
    btn.className = 'step-btn';
    btn.textContent = 'Login to Instagram';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Opening browser...';
      appendLog('Launching Playwright browser for Instagram login...', 'info');

      const result = await window.api.openInstagram();

      if (result.success) {
        descEl.textContent = `Logged in as @${result.userId || 'unknown'}`;
        icon.className = 'step-icon done';
        icon.textContent = '✓';
        btn.remove();
        setDot('igPill', 'ok');
        appendLog(`Instagram session captured successfully`, 'success');

        const setupBody = document.getElementById('setupBody');
        const readyStep = createStep('done', '4', 'Ready', 'All checks passed. Start the engine.', null);
        setupBody.appendChild(readyStep);
      } else {
        descEl.textContent = result.error;
        icon.className = 'step-icon error';
        btn.textContent = 'Retry Login';
        btn.disabled = false;
        appendLog(`Login failed: ${result.error}`, 'error');
      }
    };
    content.appendChild(btn);
  }

  step.appendChild(icon);
  step.appendChild(content);
  return step;
}

// ── Logs ────────────────────────────────────────
function appendLog(msg, type = 'info') {
  const logArea = document.getElementById('logArea');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = `[${time}] ${msg}`;
  logArea.appendChild(entry);
  logArea.scrollTop = logArea.scrollHeight;
  logCount++;
  document.getElementById('logCount').textContent = logCount;
}

// ── Engine Status ───────────────────────────────
function updateEngineStatus(status) {
  const dot = document.getElementById('engineStatusDot');
  const text = document.getElementById('engineStatusText');
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnStop = document.getElementById('btnStop');

  dot.className = `status-dot ${status}`;
  setDot('enginePill', status === 'running' ? 'ok' : status === 'paused' ? 'active' : 'pending');

  switch (status) {
    case 'running':
      text.textContent = 'Running';
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnStop.disabled = false;
      break;
    case 'paused':
      text.textContent = 'Paused';
      btnStart.disabled = false;
      btnStart.textContent = '▶ Resume';
      btnPause.disabled = true;
      btnStop.disabled = false;
      break;
    case 'stopped':
      text.textContent = 'Stopped';
      btnStart.disabled = false;
      btnStart.textContent = '▶ Start';
      btnPause.disabled = true;
      btnStop.disabled = true;
      break;
    case 'starting':
      text.textContent = 'Starting...';
      btnStart.disabled = true;
      btnPause.disabled = true;
      btnStop.disabled = true;
      break;
    case 'error':
      text.textContent = 'Error';
      btnStart.disabled = false;
      btnStart.textContent = '▶ Start';
      btnPause.disabled = true;
      btnStop.disabled = true;
      break;
  }
}

// ── Controls ────────────────────────────────────
async function startEngine() {
  appendLog('Starting engine...', 'info');
  await window.api.startEngine();
}

async function stopEngine() {
  appendLog('Stopping engine...', 'warn');
  await window.api.stopEngine();
}

async function pauseEngine() {
  appendLog('Pausing engine...', 'warn');
  await window.api.pauseEngine();
  await window.api.resumeEngine(); // Resume since we paused
}

// ── Settings ────────────────────────────────────
async function loadSettings() {
  const settings = await window.api.loadSettings();
  document.getElementById('settingDmTemplate').value = settings.dmTemplate || '';
  document.getElementById('settingAiContext').value = settings.aiTrainingContext || '';
  document.getElementById('settingCalendly').value = settings.calendlyLink || '';
  document.getElementById('settingNiche').value = (settings.nicheTags || []).join(', ');

  if (settings.followupDelays) {
    document.getElementById('delay0').value = settings.followupDelays[0] || 3;
    document.getElementById('delay1').value = settings.followupDelays[1] || 5;
    document.getElementById('delay2').value = settings.followupDelays[2] || 7;
  }
}

async function saveSettings() {
  const settings = {
    dmTemplate: document.getElementById('settingDmTemplate').value,
    aiTrainingContext: document.getElementById('settingAiContext').value,
    calendlyLink: document.getElementById('settingCalendly').value,
    followupDelays: [
      parseInt(document.getElementById('delay0').value) || 3,
      parseInt(document.getElementById('delay1').value) || 5,
      parseInt(document.getElementById('delay2').value) || 7,
    ],
    nicheTags: document.getElementById('settingNiche').value.split(',').map(s => s.trim()).filter(Boolean),
  };

  const result = await window.api.saveSettings(settings);
  if (result.success) {
    appendLog('Settings saved', 'success');
  } else {
    appendLog('Failed to save settings', 'error');
  }
}

// ── Helpers ─────────────────────────────────────
function setDot(pillId, state) {
  const pill = document.getElementById(pillId);
  if (pill) {
    const dot = pill.querySelector('.status-dot');
    if (dot) dot.className = `status-dot ${state}`;
  }
}
