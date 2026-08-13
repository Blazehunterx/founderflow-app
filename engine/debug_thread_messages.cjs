// F12 Console diagnostic — check what API returns for specific threads
// Paste in F12 Console on instagram.com/direct/inbox/
// Shows: API thread messages for each thread, including non-text types

(async () => {
  console.log('=== Thread Message Diagnostic ===\n');

  let appId = '936619743392459';
  for (const s of Array.from(document.querySelectorAll('script'))) {
    if (s.textContent.includes('app_id')) {
      const m = s.textContent.match(/"app_id":"(\d+)"/);
      if (m) { appId = m[1]; break; }
    }
  }
  const myId = document.cookie.match(/ds_user_id=(\d+)/)?.[1];
  console.log('Your user ID:', myId);

  // Get all threads from API (first 100)
  const res = await fetch('https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&limit=100', {
    credentials: 'include',
    headers: { 'X-IG-App-ID': appId, 'X-ASBD-ID': '129477', 'X-IG-WWW-Claim': '0', 'X-Requested-With': 'XMLHttpRequest' }
  });
  const data = await res.json();
  if (!data?.inbox?.threads) { console.log('No threads'); return; }

  // Find threads where last message is NOT from us
  const needlesReplies = data.inbox.threads.filter(t => {
    if (!t.items?.length) return false;
    if (t.users?.length > 2) return false; // Skip group chats
    const lastItem = t.items[0];
    const isMe = lastItem.user_id === (t.viewer_id || myId);
    return !isMe; // Last message is from them
  });

  console.log(`Found ${needlesReplies.length} threads where they sent last (out of ${data.inbox.threads.length} total)\n`);

  // Show first 20 with their message details
  for (const t of needlesReplies.slice(0, 20)) {
    const username = t.users?.[0]?.username || 'unknown';
    const fullName = t.users?.[0]?.full_name || '';
    const lastItem = t.items[0];
    const isMe = lastItem.user_id === (t.viewer_id || myId);
    const isUnread = !t.read_state;
    const itemType = lastItem.item_type || 'text';
    const text = lastItem.text || '(no text)';
    
    console.log(`@${username} (${fullName})`);
    console.log(`  Unread: ${isUnread} | Type: ${itemType} | isMe: ${isMe} | msgs: ${t.items?.length}`);
    console.log(`  Last msg: "${text.substring(0, 100)}"`);
    console.log(`  thread_id: ${t.thread_id}`);
    console.log('');
  }

  // Now fetch full thread messages for first 3 to see what API returns
  console.log('\n=== FULL THREAD MESSAGES (first 3) ===\n');
  for (const t of needlesReplies.slice(0, 3)) {
    const username = t.users?.[0]?.username || 'unknown';
    const threadId = t.thread_id;
    
    const threadRes = await fetch(`https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=10`, {
      credentials: 'include',
      headers: { 'X-IG-App-ID': appId, 'X-ASBD-ID': '129477', 'X-IG-WWW-Claim': '0', 'X-Requested-With': 'XMLHttpRequest' }
    });
    const threadData = await threadRes.json();
    
    if (!threadData?.thread?.items) {
      console.log(`@${username}: API returned no items\n`);
      continue;
    }
    
    const items = threadData.thread.items;
    const viewerId = threadData.thread.viewer_id || myId;
    
    console.log(`@${username} (thread ${threadId}) — ${items.length} items:`);
    for (const item of items) {
      const isMe = item.user_id === viewerId;
      const type = item.item_type || 'text';
      const text = item.text || (type === 'reel_share' ? '(reel share: ' + (item.reel_share?.text || '') + ')' :
                   type === 'media' ? '(photo/video)' :
                   type === 'animated_media' ? '(GIF)' :
                   type === 'sticker' ? '(sticker: ' + (item.sticker?.text || '') + ')' :
                   type === 'link' ? '(link: ' + (item.link?.text || '') + ')' :
                   type === 'like' ? '(like)' :
                   '(no text)');
      console.log(`  [${isMe ? 'ME' : 'THEM'}] ${type}: "${String(text).substring(0, 80)}"`);
    }
    console.log('');
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('=== Done ===');
})();