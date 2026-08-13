const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const os = require('os');

const SUPABASE_URL = 'https://thtneidmejdgxdzbwdxj.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRodG5laWRtZWpkZ3hkemJ3ZHhqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODAzNDE4OSwiZXhwIjoyMDkzNjEwMTg5fQ.KiZxG8tUsPXqjfhG1aQucSKltKEHiivZfrYz5GNcQ78';
const CLIENT_ID = 'z8lLZzM3OanKxTUx5MgZM5qVpS5a1RHR';
const REDIRECT_URI = 'http://localhost:3456/callback';

const WORKSPACE_ID = process.argv[2] || 'f200af1c-ce5c-49c0-ab29-c7531b31f3a9';

function openBrowser(url) {
  const platform = os.platform();
  if (platform === 'win32') exec(`start "" "${url}"`);
  else if (platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

function supabaseUpdate(table, match, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'thtneidmejdgxdzbwdxj.supabase.co',
      path: `/rest/v1/${table}?${match}`,
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode);
        else reject(new Error(`Supabase ${res.statusCode}: ${d}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function exchangeCode(code, clientSecret) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: clientSecret,
      code: code,
      redirect_uri: REDIRECT_URI
    }).toString();

    const opts = {
      hostname: 'auth.aweber.com',
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`AWeber ${res.statusCode}: ${d}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchClientSecret() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'thtneidmejdgxdzbwdxj.supabase.co',
      path: `/rest/v1/settings?workspace_id=eq.${WORKSPACE_ID}&select=aweber_client_secret`,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept': 'application/json'
      }
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(d);
          resolve(data[0]?.aweber_client_secret || '');
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const clientSecret = await fetchClientSecret();
  if (!clientSecret) {
    console.error('No aweber_client_secret found in settings for workspace', WORKSPACE_ID);
    process.exit(1);
  }

  const authUrl = `https://auth.aweber.com/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent('account.read list.read list.write subscriber.read subscriber.write')}&state=${WORKSPACE_ID}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:3456`);
    if (url.pathname !== '/callback') {
      res.writeHead(404); res.end('Not found'); return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error || !code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h2>Authorization failed</h2><p>${error || 'No code'}</p>`);
      server.close();
      return;
    }

    try {
      const tokenData = await exchangeCode(code, clientSecret);

      // Get account ID
      const acctRes = await new Promise((resolve, reject) => {
        https.get({
          hostname: 'api.aweber.com',
          path: '/1.0/accounts',
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        }, res2 => {
          let d = '';
          res2.on('data', c => d += c);
          res2.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
        }).on('error', reject);
      });
      const accountId = acctRes.entries?.[0]?.id || '2394058';
      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString();

      await supabaseUpdate('settings', `workspace_id=eq.${WORKSPACE_ID}`, {
        aweber_access_token: tokenData.access_token,
        aweber_refresh_token: tokenData.refresh_token || '',
        aweber_access_token_expires: expiresAt,
        aweber_account_id: accountId,
        updated_at: new Date().toISOString()
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2 style="color:green">AWeber connected for workspace ${WORKSPACE_ID}</h2><p>Tokens saved. You can close this tab.</p>`);
      console.log('\n✅ AWeber tokens saved for workspace', WORKSPACE_ID);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h2>Error</h2><p>${e.message}</p>`);
      console.error('\n❌ Error:', e.message);
    }
    server.close();
  });

  server.listen(3456, () => {
    console.log('Local callback server listening on http://localhost:3456/callback');
    console.log('Opening browser for AWeber authorization...');
    openBrowser(authUrl);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
