/**
 * Quick script to create a lead in Supabase for deep inbox scan replies
 * Usage: node queue_lead.cjs <username> [status] [step]
 */
const path = require('path');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'config.json'), 'utf8'));

const username = process.argv[2];
const status = process.argv[3] || 'dm_sent';
const step = parseInt(process.argv[4] || '1', 10);

if (!username) {
  console.log('Usage: node queue_lead.cjs <username> [status] [step]');
  process.exit(1);
}

async function main() {
  const url = `${config.supabaseUrl}/rest/v1/leads`;
  const headers = {
    'apikey': config.supabaseAnonKey,
    'Authorization': `Bearer ${config.supabaseAnonKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  // Check if lead exists
  const checkUrl = `${url}?workspace_id=eq.${config.workspaceId}&ig_handle=eq.${username}&select=id,ig_handle,status,conversation_step`;
  const checkRes = await fetch(checkUrl, { headers: { apikey: headers.apikey, Authorization: headers.Authorization } });
  const existing = await checkRes.json();

  if (existing && existing.length > 0) {
    console.log(`@${username} already exists: status=${existing[0].status} step=${existing[0].conversation_step}`);
    // Update conversation_step to 1 if it's 0
    if (existing[0].conversation_step === 0) {
      const updateUrl = `${url}?workspace_id=eq.${config.workspaceId}&ig_handle=eq.${username}`;
      await fetch(updateUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ conversation_step: 1, status: 'dm_sent' })
      });
      console.log(`Updated @${username} to step 1, status=dm_sent`);
    }
    return;
  }

  // Create new lead
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workspace_id: config.workspaceId,
      ig_handle: username,
      status: status,
      conversation_step: step,
      source: 'deep_inbox_scan',
      discovered_at: new Date().toISOString()
    })
  });

  if (res.ok) {
    const data = await res.json();
    console.log(`Created lead @${username}: status=${status} step=${step} id=${data?.[0]?.id || 'ok'}`);
  } else {
    const err = await res.text();
    console.error(`Failed to create @${username}: ${res.status} ${err}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
