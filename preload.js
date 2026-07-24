const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Environment
  checkEnvironment: () => ipcRenderer.invoke('app:check-environment'),

  // Engine
  startEngine: () => ipcRenderer.invoke('app:start-engine'),
  stopEngine: () => ipcRenderer.invoke('app:stop-engine'),
  pauseEngine: () => ipcRenderer.invoke('app:pause-engine'),
  resumeEngine: () => ipcRenderer.invoke('app:resume-engine'),

  // Instagram
  openInstagram: () => ipcRenderer.invoke('app:open-instagram'),
  captureCookies: () => ipcRenderer.invoke('app:capture-cookies'),

  // Settings
  loadSettings: () => ipcRenderer.invoke('app:load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('app:save-settings', settings),
  downloadConfig: (workspaceId) => ipcRenderer.invoke('app:download-config', workspaceId),
  refreshConfig: () => ipcRenderer.invoke('app:refresh-config'),
  updateEngine: () => ipcRenderer.invoke('app:update-engine'),

  // Dependencies
  installDeps: () => ipcRenderer.invoke('app:install-deps'),

  // Misc
  openEngineDir: () => ipcRenderer.invoke('app:open-engine-dir'),
  quit: () => ipcRenderer.invoke('app:quit'),

  // Event listeners
  onLog: (cb) => ipcRenderer.on('engine:log', (_, msg) => cb(msg)),
  onError: (cb) => ipcRenderer.on('engine:error', (_, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('engine:status', (_, status) => cb(status)),
  onDepsLog: (cb) => ipcRenderer.on('deps:log', (_, msg) => cb(msg)),
  onLoginOpened: (cb) => ipcRenderer.on('login:browser-opened', () => cb()),
});
