/**
 * build.js — Copies engine files + Node.js runtime into the app
 * Run: node build.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC_ENGINE = path.join(__dirname, '..', '.gemini', 'antigravity', 'playground', 'glacial-apogee', 'antigravity-cloud', 'client_engine');
const DEST_ENGINE = path.join(__dirname, 'engine');
const DEST_NODE = path.join(__dirname, 'node-runtime');

const ENGINE_FILES = [
  'engine.cjs', 'ai_setter.cjs', 'harvester.cjs', 'sender.cjs',
  'login.cjs', 'comment_scanner.cjs', 'wellness_follower_harvester.cjs',
  'inject_cookies.cjs', 'ghost.cjs', 'package.json',
];

console.log('FounderFlow Build Script');
console.log('========================\n');

// Step 1: Copy engine files
console.log('1. Copying engine files...');
if (fs.existsSync(DEST_ENGINE)) {
  fs.rmSync(DEST_ENGINE, { recursive: true });
}
fs.mkdirSync(DEST_ENGINE, { recursive: true });

for (const file of ENGINE_FILES) {
  const src = path.join(SRC_ENGINE, file);
  const dest = path.join(DEST_ENGINE, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`   ✓ ${file}`);
  } else {
    console.log(`   ✗ ${file} (not found, skipping)`);
  }
}

// Step 2: Download Node.js for the target platform
console.log('\n2. Downloading Node.js runtime...');
const platform = process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

if (fs.existsSync(DEST_NODE)) {
  fs.rmSync(DEST_NODE, { recursive: true });
}
fs.mkdirSync(DEST_NODE, { recursive: true });

// On Mac, download BOTH arm64 and x64 so the app works on any Mac
const archsToDownload = platform === 'darwin' ? ['arm64', 'x64'] : [arch];

try {
  // Get current Node.js version
  const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
  console.log(`   Current Node.js: ${nodeVersion}`);

  const version = nodeVersion.replace('v', '');

  for (const dlArch of archsToDownload) {
    console.log(`\n   --- Downloading ${dlArch} ---`);
    const archDir = path.join(DEST_NODE, dlArch);
    fs.mkdirSync(archDir, { recursive: true });

    let downloadUrl;
    if (platform === 'win32') {
      downloadUrl = `https://nodejs.org/dist/v${version}/node-v${version}-win-${dlArch}.zip`;
      console.log(`   Downloading: ${downloadUrl}`);
      execSync(`powershell -Command "Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${path.join(archDir, 'node.zip')}'"`, { stdio: 'inherit' });
      execSync(`powershell -Command "Expand-Archive -Path '${path.join(archDir, 'node.zip')}' -DestinationPath '${archDir}' -Force"`, { stdio: 'inherit' });
      const nestedDir = path.join(archDir, `node-v${version}-win-${dlArch}`);
      if (fs.existsSync(nestedDir)) {
        for (const item of fs.readdirSync(nestedDir)) {
          fs.renameSync(path.join(nestedDir, item), path.join(archDir, item));
        }
        fs.rmSync(nestedDir, { recursive: true });
      }
      fs.rmSync(path.join(archDir, 'node.zip'), { force: true });
      console.log(`   OK Node.js downloaded (Windows ${dlArch})`);
    } else if (platform === 'darwin') {
      downloadUrl = `https://nodejs.org/dist/v${version}/node-v${version}-darwin-${dlArch}.tar.gz`;
      console.log(`   Downloading: ${downloadUrl}`);
      execSync(`curl -L "${downloadUrl}" | tar -xz -C "${archDir}" --strip-components=1`, { stdio: 'inherit', timeout: 120000 });
      // Strip quarantine attribute so macOS doesn't block the binary
      try {
        execSync(`xattr -rd com.apple.quarantine "${archDir}" 2>/dev/null || true`, { stdio: 'pipe' });
      } catch {}
      console.log(`   OK Node.js downloaded (Mac ${dlArch})`);
    } else {
      downloadUrl = `https://nodejs.org/dist/v${version}/node-v${version}-linux-${dlArch}.tar.xz`;
      console.log(`   Downloading: ${downloadUrl}`);
      execSync(`curl -L "${downloadUrl}" | tar -xJ -C "${archDir}" --strip-components=1`, { stdio: 'inherit', timeout: 120000 });
      console.log(`   OK Node.js downloaded (Linux ${dlArch})`);
    }
  }

  // Verify both binaries exist
  for (const dlArch of archsToDownload) {
    const nodeBin = platform === 'win32'
      ? path.join(DEST_NODE, dlArch, 'node.exe')
      : path.join(DEST_NODE, dlArch, 'bin', 'node');
    if (fs.existsSync(nodeBin)) {
      const stat = fs.statSync(nodeBin);
      console.log(`   Verified ${dlArch}: ${nodeBin} (${Math.round(stat.size / 1024 / 1024)}MB)`);
    } else {
      console.log(`   WARNING: ${dlArch} binary NOT found at ${nodeBin}`);
    }
  }
} catch (err) {
  console.log('   Could not download Node.js. App will use system Node.js.');
  console.log(`   Error: ${err.message}`);
  // Write a marker so the app knows to fall back to system node
  fs.writeFileSync(path.join(DEST_NODE, '.fallback'), 'use system node');
}

console.log('\nBuild complete! Run "npm start" to test or "npm run build:win" / "npm run build:mac" to package.');
