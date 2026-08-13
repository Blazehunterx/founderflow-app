#!/usr/bin/env node
// Opens Chrome with Olive's session, stays open until you close it.
// Then paste the diagnostic in F12 console.
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const COOKIES_PATH = path.join(process.cwd(), 'ig_session_cookies.json');

function findChrome() {
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ]) { if (fs.existsSync(p)) return p; }
  return null;
}

(async () => {
  const chromePath = findChrome();
  if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }
  if (!fs.existsSync(COOKIES_PATH)) { console.error('ig_session_cookies.json not found.'); process.exit(1); }

  const rawCookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  console.log('Loaded', rawCookies.length, 'cookies.');

  const browser = await chromium.launch({ headless: false, executablePath: chromePath, args: ['--no-first-run', '--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  await context.addCookies(rawCookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain || '.instagram.com', path: c.path || '/',
    expires: c.expires ? Math.floor(c.expires) : undefined, secure: c.secure !== false,
    httpOnly: c.httpOnly || false, sameSite: c.sameSite || 'Lax',
  })));

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const loggedIn = await page.evaluate(() => !document.querySelector('input[name="username"]')).catch(() => false);
  if (!loggedIn) { console.error('Session dead. Run: node login.cjs'); await browser.close(); process.exit(1); }

  // Dismiss popups
  await page.click('button:has-text("Not Now")').catch(() => {});
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Not Now")').catch(() => {});

  console.log('');
  console.log('=== Browser is open on Instagram inbox ===');
  console.log('Press F12, go to Console, paste this command:');
  console.log('');
  console.log('(async()=>{const a=[];let c=null,p=0;while(p<5){try{const u="https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&limit=100"+(c?"&cursor="+encodeURIComponent(c):"");const r=await fetch(u,{credentials:"include",headers:{"X-IG-App-ID":"936619743392459","X-ASBD-ID":"129477","X-IG-WWW-Claim":"0","X-Requested-With":"XMLHttpRequest"}});if(!r.ok){const b=await r.text().catch(()=>"");console.error("API",r.status,b);break}const d=await r.json();if(!d?.inbox?.threads)break;const my=d.viewer?.pk||d.inbox.threads[0]?.viewer_id;for(const t of d.inbox.threads){if(!t.items?.length||(t.users?.length>2))continue;const l=t.items[0];a.push({u:t.users?.[0]?.username||"?",unread:!t.read_state,isMe:l.user_id===my,type:l.item_type||"text",msg:(l.text||"").substring(0,80)})}c=d.inbox.next_cursor||d.inbox.oldest_cursor||null;if(!d.inbox.has_older||!c)break;p++;await new Promise(r=>setTimeout(r,2000))}catch(e){console.error(e);break}}const nt=["action_log","reel_share","media","raven_media","animated_media","sticker","link","voice_media"];const u=a.filter(t=>t.unread);const nr=u.filter(t=>!t.isMe&&!nt.includes(t.type));const fm=u.filter(t=>t.isMe&&!nt.includes(t.type));console.log("Total:",a.length,"Unread:",u.length,"NeedReply:",nr.length,"FalseIsMe:",fm.length);console.log("\n--- NEED REPLIES ---");for(const t of nr)console.log(" @"+t.u,t.type,"\x22"+t.msg+"\x22");console.log("\n--- FALSE isMe (API wrong) ---");for(const t of fm.slice(0,30))console.log(" @"+t.u,t.type,"\x22"+t.msg+"\x22");if(fm.length>30)console.log(" ...and "+(fm.length-30)+" more")})();');
  console.log('');
  console.log('Close this window or press Ctrl+C when done.');

  // Keep alive until browser is closed
  browser.on('disconnected', () => { console.log('Browser closed.'); process.exit(0); });
  await new Promise(() => {}); // hang forever
})();
