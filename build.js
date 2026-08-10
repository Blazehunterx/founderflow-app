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

const HYBRID_FILES = [
  'funnel_config.cjs', 'rules_engine.cjs', 'llm_responder.cjs',
  'handler.cjs', 'validator.cjs',
];

const HYBRID_JANI_FILES = [
  'funnel_config_jani.cjs', 'rules_engine_jani.cjs', 'llm_responder_jani.cjs',
  'handler_jani.cjs', 'validator_jani.cjs',
];

console.log('FounderFlow Build Script');
console.log('========================\n');

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

    // Ensure hybrid/ directory exists (downloaded ZIP should include it)
    const hybridDir = path.join(DEST_ENGINE, 'hybrid');
    if (fs.existsSync(hybridDir)) {
      const hybridFiles = fs.readdirSync(hybridDir).filter(f => f.endsWith('.cjs'));
      console.log('   hybrid/ contains ' + hybridFiles.length + ' files: ' + hybridFiles.join(', '));
    } else {
      console.log('   WARNING: hybrid/ directory not found in downloaded files');
      console.log('   Creating hybrid/ from bundled copies...');
      fs.mkdirSync(hybridDir, { recursive: true });

      // Try copying from sibling antigravity-cloud repo
      const SIBLING_HYBRID = path.join(__dirname, '..', '.gemini', 'antigravity', 'playground', 'glacial-apogee', 'antigravity-cloud', 'client_engine', 'hybrid');
      if (fs.existsSync(SIBLING_HYBRID)) {
        for (const file of [...HYBRID_FILES, ...HYBRID_JANI_FILES]) {
          const src = path.join(SIBLING_HYBRID, file);
          const dest = path.join(hybridDir, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            console.log('   + hybrid/' + file + ' (from sibling)');
          }
        }
      } else {
        console.log('   WARNING: No hybrid files available from any source');
      }
    }
  } catch (err) {
    console.log('   Download failed: ' + err.message);
    console.log('   Falling back to local engine/...');

    // Ensure hybrid/ directory exists in local engine
    const localHybrid = path.join(DEST_ENGINE, 'hybrid');
    if (!fs.existsSync(localHybrid)) {
      console.log('   WARNING: hybrid/ directory missing in local engine/');
    } else {
      const hybridFiles = fs.readdirSync(localHybrid).filter(f => f.endsWith('.cjs'));
      console.log('   hybrid/ contains ' + hybridFiles.length + ' files: ' + hybridFiles.join(', '));
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

const zipPath = path.join(__dirname, '_engine_download.zip');

fetchEngineFiles()
  .then(() => buildNodeRuntime())
  .then(() => {
    console.log('\nBuild complete! Run "npm start" to test or "npm run build:mac" to package.');
  })
  .catch(err => {
    console.error('Build failed:', err.message);
    process.exit(1);
  });
