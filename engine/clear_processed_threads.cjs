// Run this on Olive's machine in the engine directory (where state.json is)
// node clear_processed_threads.cjs
// This clears the processedThreads list so all Primary threads get re-evaluated
// Threads where we already replied will be skipped by the lastMsg.isMe check

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.resolve(process.cwd(), 'state.json');

if (!fs.existsSync(STATE_PATH)) {
  console.log('No state.json found in current directory');
  console.log('Current directory:', process.cwd());
  console.log('Make sure you are in the engine folder (where engine.cjs is)');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const before = Array.isArray(state.processedThreads) ? state.processedThreads.length : 0;
console.log(`Before: ${before} processed threads in state.json`);
console.log('Thread IDs being cleared:');
if (Array.isArray(state.processedThreads)) {
  for (const entry of state.processedThreads) {
    const id = typeof entry === 'object' ? entry.id : entry;
    console.log(`  ${id}`);
  }
}

state.processedThreads = [];
const tmp = STATE_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
fs.renameSync(tmp, STATE_PATH);

console.log(`\nAfter: 0 processed threads`);
console.log('Cleared! Next engine pulse will re-evaluate ALL Primary threads.');
console.log('Threads where we already replied will be skipped by the lastMsg.isMe check.');