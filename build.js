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

try {
  // Get current Node.js version
  const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
  console.log(`   Current Node.js: ${nodeVersion}`);

  // Download Node.js binary for distribution
  const version = nodeVersion.replace('v', '');
  let downloadUrl;

  if (platform === 'win32') {
    downloadUrl = `https://nodejs.org/dist/v${version}/node-v${version}-win-${arch}.zip`;
    console.log(`   Downloading: ${downloadUrl}`);
    execSync(`powershell -Command "Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${path.join(DEST_NODE, 'node.zip')}'"`, { stdio: 'inherit' });
    execSync(`powershell -Command "Expand-Archive -Path '${path.join(DEST_NODE, 'node.zip')}' -DestinationPath '${DEST_NODE}' -Force"`, { stdio: 'inherit' });
    // Move files up from nested directory
    const nestedDir = path.join(DEST_NODE, `node-v${version}-win-${arch}`);
    if (fs.existsSync(nestedDir)) {
      for (const item of fs.readdirSync(nestedDir)) {
        fs.renameSync(path.join(nestedDir, item), path.join(DEST_NODE, item));
      }
      fs.rmSync(nestedDir, { recursive: true });
    }
    fs.rmSync(path.join(DEST_NODE, 'node.zip'), { force: true });
    console.log('   ✓ Node.js downloaded (Windows)');
  } else if (platform === 'darwin') {
    downloadUrl = `https://nodejs.org/dist/v${version}/node-v${version}-darwin-${arch}.tar.gz`;
    console.log(`   Downloading: ${downloadUrl}`);
    execSync(`curl -L "${downloadUrl}" | tar -xz -C "${DEST_NODE}" --strip-components=1`, { stdio: 'inherit' });
    console.log('   ✓ Node.js downloaded (Mac)');
  } else {
    downloadUrl = `https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.xz`;
    console.log(`   Downloading: ${downloadUrl}`);
    execSync(`curl -L "${downloadUrl}" | tar -xJ -C "${DEST_NODE}" --strip-components=1`, { stdio: 'inherit' });
    console.log('   ✓ Node.js downloaded (Linux)');
  }
} catch (err) {
  console.log('   ⚠ Could not download Node.js. App will use system Node.js.');
  console.log(`   Error: ${err.message}`);
  // Write a marker so the app knows to fall back to system node
  fs.writeFileSync(path.join(DEST_NODE, '.fallback'), 'use system node');
}

console.log('\nBuild complete! Run "npm start" to test or "npm run build:win" / "npm run build:mac" to package.');
