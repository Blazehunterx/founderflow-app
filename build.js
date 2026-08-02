/**
 * build.js - Downloads engine files from dashboard API + Node.js runtime
 * Run: node build.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const DEST_ENGINE = path.join(__dirname, 'engine');
const DEST_NODE = path.join(__dirname, 'node-runtime');
const ENGINE_API_URL = 'https://founderflow-dashboard.vercel.app/api/client/download?engine_update=1&workspace_id=dummy';

console.log('FounderFlow Build Script');
console.log('========================\n');

// Step 1: Download engine files from dashboard API
console.log('1. Downloading engine files from dashboard...');
if (fs.existsSync(DEST_ENGINE)) {
  fs.rmSync(DEST_ENGINE, { recursive: true });
}
fs.mkdirSync(DEST_ENGINE, { recursive: true });

const zipPath = path.join(__dirname, '_engine_download.zip');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('Download failed (HTTP ' + res.statusCode + ')'));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => {
      fs.unlink(dest, () => {});
      reject(e);
    });
  });
}

async function fetchEngineFiles() {
  try {
    await downloadFile(ENGINE_API_URL, zipPath);
    console.log('   Downloaded engine ZIP from dashboard');

    execSync('unzip -o "' + zipPath + '" -d "' + DEST_ENGINE + '"', { stdio: 'inherit' });
    fs.unlinkSync(zipPath);

    // ZIP files may be prefixed with engine-update/ - move them to engine/ root
    const extractedDir = path.join(DEST_ENGINE, 'engine-update');
    if (fs.existsSync(extractedDir)) {
      const subFiles = fs.readdirSync(extractedDir);
      for (const f of subFiles) {
        fs.renameSync(path.join(extractedDir, f), path.join(DEST_ENGINE, f));
      }
      fs.rmSync(extractedDir, { recursive: true });
    }

    const files = fs.readdirSync(DEST_ENGINE);
    console.log('   Extracted ' + files.length + ' files:');
    files.forEach(f => console.log('   + ' + f));

    // Verify package.json exists
    if (!fs.existsSync(path.join(DEST_ENGINE, 'package.json'))) {
      console.log('   WARNING: package.json not found in extracted files');
    } else {
      console.log('   package.json verified');
    }
  } catch (err) {
    console.log('   Download failed: ' + err.message);
    console.log('   Falling back to local client_engine/...');

    const localEngine = path.join(__dirname, '..', 'client_engine');
    if (fs.existsSync(localEngine)) {
      const ENGINE_FILES = [
        'start.cjs', 'login.cjs', 'package.json',
        'engine.cjs', 'ai_setter.cjs', 'harvester.cjs', 'sender.cjs',
        'inject_cookies.cjs', 'ghost.cjs',
        'comment_scanner.cjs', 'wellness_follower_harvester.cjs',
      ];
      for (const file of ENGINE_FILES) {
        const src = path.join(localEngine, file);
        const dest = path.join(DEST_ENGINE, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          console.log('   + ' + file + ' (local)');
        } else {
          console.log('   - ' + file + ' (not found)');
        }
      }
    } else {
      console.log('   No local client_engine/ found either');
    }
  }
}

async function buildNodeRuntime() {
  console.log('\n2. Downloading Node.js runtime...');
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  if (fs.existsSync(DEST_NODE)) {
    fs.rmSync(DEST_NODE, { recursive: true });
  }
  fs.mkdirSync(DEST_NODE, { recursive: true });

  const archsToDownload = platform === 'darwin' ? ['arm64', 'x64'] : [arch];

  try {
    const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
    console.log('   Current Node.js: ' + nodeVersion);

    const version = nodeVersion.replace('v', '');

    for (const dlArch of archsToDownload) {
      console.log('\n   --- Downloading ' + dlArch + ' ---');
      const archDir = path.join(DEST_NODE, dlArch);
      fs.mkdirSync(archDir, { recursive: true });

      if (platform === 'win32') {
        const downloadUrl = 'https://nodejs.org/dist/v' + version + '/node-v' + version + '-win-' + dlArch + '.zip';
        console.log('   Downloading: ' + downloadUrl);
        execSync('powershell -Command "Invoke-WebRequest -Uri \'' + downloadUrl + '\' -OutFile \'' + path.join(archDir, 'node.zip') + '\'"', { stdio: 'inherit' });
        execSync('powershell -Command "Expand-Archive -Path \'' + path.join(archDir, 'node.zip') + '\' -DestinationPath \'' + archDir + '\' -Force"', { stdio: 'inherit' });
        const nestedDir = path.join(archDir, 'node-v' + version + '-win-' + dlArch);
        if (fs.existsSync(nestedDir)) {
          for (const item of fs.readdirSync(nestedDir)) {
            fs.renameSync(path.join(nestedDir, item), path.join(archDir, item));
          }
          fs.rmSync(nestedDir, { recursive: true });
        }
        fs.rmSync(path.join(archDir, 'node.zip'), { force: true });
        console.log('   OK Node.js downloaded (Windows ' + dlArch + ')');
      } else if (platform === 'darwin') {
        const downloadUrl = 'https://nodejs.org/dist/v' + version + '/node-v' + version + '-darwin-' + dlArch + '.tar.gz';
        console.log('   Downloading: ' + downloadUrl);
        execSync('curl -L "' + downloadUrl + '" | tar -xz -C "' + archDir + '" --strip-components=1', { stdio: 'inherit', timeout: 120000 });
        try {
          execSync('xattr -rd com.apple.quarantine "' + archDir + '" 2>/dev/null || true', { stdio: 'pipe' });
        } catch {}
        console.log('   OK Node.js downloaded (Mac ' + dlArch + ')');
      } else {
        const downloadUrl = 'https://nodejs.org/dist/v' + version + '/node-v' + version + '-linux-' + dlArch + '.tar.xz';
        console.log('   Downloading: ' + downloadUrl);
        execSync('curl -L "' + downloadUrl + '" | tar -xJ -C "' + archDir + '" --strip-components=1', { stdio: 'inherit', timeout: 120000 });
        console.log('   OK Node.js downloaded (Linux ' + dlArch + ')');
      }
    }

    for (const dlArch of archsToDownload) {
      const nodeBin = platform === 'win32'
        ? path.join(DEST_NODE, dlArch, 'node.exe')
        : path.join(DEST_NODE, dlArch, 'bin', 'node');
      if (fs.existsSync(nodeBin)) {
        const stat = fs.statSync(nodeBin);
        console.log('   Verified ' + dlArch + ': ' + Math.round(stat.size / 1024 / 1024) + 'MB');
      } else {
        console.log('   WARNING: ' + dlArch + ' binary NOT found');
      }
    }
  } catch (err) {
    console.log('   Could not download Node.js. App will use system Node.js.');
    console.log('   Error: ' + err.message);
    fs.writeFileSync(path.join(DEST_NODE, '.fallback'), 'use system node');
  }
}

fetchEngineFiles()
  .then(() => buildNodeRuntime())
  .then(() => {
    console.log('\nBuild complete! Run "npm start" to test or "npm run build:mac" to package.');
  })
  .catch(err => {
    console.error('Build failed:', err.message);
    process.exit(1);
  });