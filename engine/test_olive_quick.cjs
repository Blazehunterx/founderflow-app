const fs = require('fs');
const https = require('https');
const path = require('path');

const cookiePath = path.resolve(__dirname, 'ig_session_cookies.json');
console.log('=== Olive Session Test (No Browser) ===');

let cookies;
try {
  cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  console.log('Loaded ' + cookies.length + ' cookies');
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(1);
}

const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
const csrf = (cookies.find(c => c.name === 'csrftoken') || {}).value || '';
const dsUserId = (cookies.find(c => c.name === 'ds_user_id') || {}).value || '';
console.log('ds_user_id: ' + dsUserId);

function testAPI(label, folder) {
  return new Promise((resolve) => {
    const folderParam = folder ? '&folder=' + folder : '';
    const options = {
      hostname: 'i.instagram.com',
      path: '/api/v1/direct_v2/inbox/?persistentBadging=true&limit=20' + folderParam,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-IG-App-ID': '936619743392459',
        'User-Agent': 'Instagram 320.0.0.29.123 Android (29/10; 420dpi; 1080x1920; OnePlus; ONEPLUS A6003; OnePlus6; qcom; en_US; 497252543)',
        'Cookie': cookieStr,
        'x-csrftoken': csrf
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log('\n[' + label + '] Status: ' + res.statusCode);
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const threads = data.inbox?.threads || [];
            console.log('  Threads: ' + threads.length);
            for (const t of threads.slice(0, 10)) {
              const handle = t.users?.[0]?.username || 'unknown';
              const lastSender = t.last_sender_id;
              const isThem = lastSender !== dsUserId;
              const lastMsg = t.items?.[0]?.text || t.items?.[0]?.item_type || '';
              console.log('  @' + handle + ' [' + (isThem ? 'THEM' : 'ME') + '] "' + lastMsg.substring(0, 50) + '"');
            }
          } catch (e) {
            console.log('  Parse error: ' + e.message);
          }
        } else if (res.statusCode === 500) {
          console.log('  BROKEN - 500 Internal Server Error');
        } else {
          console.log('  Body: ' + body.substring(0, 200));
        }
        resolve();
      });
    });
    req.on('error', (e) => { console.log('  Error: ' + e.message); resolve(); });
    req.setTimeout(15000, () => { console.log('  TIMEOUT'); req.destroy(); resolve(); });
    req.end();
  });
}

(async () => {
  await testAPI('Primary Inbox', null);
  await testAPI('Requests', 'pending');
  await testAPI('General', 'general');
  console.log('\n=== Done ===');
})();
