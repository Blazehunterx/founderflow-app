/**
 * AWeber Subscribe Utility
 * Subscribes an email to an AWeber list with tags.
 * Auto-refreshes the OAuth2 access token on 401 if refresh credentials are provided.
 */
const https = require('https');

const AWEBER_API_BASE = 'https://api.aweber.com/1.0';
const AWEBER_AUTH_BASE = 'https://auth.aweber.com';
const AWEBER_ACCOUNT_ID = '2394058'; // Hardcoded — same account for all workspaces

function httpsRequest(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, data });
      });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 0, error: err.message, data: '' });
    });

    if (body) req.write(body);
    req.end();
  });
}

async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  if (!refreshToken || !clientId || !clientSecret) {
    return { success: false, error: 'Missing refresh token, client ID or client secret' };
  }

  const postData = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const result = await httpsRequest({
    hostname: 'auth.aweber.com',
    path: '/oauth2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  }, postData);

  if (result.statusCode !== 200) {
    return { success: false, error: `AWeber refresh failed ${result.statusCode}: ${result.data}` };
  }

  try {
    const parsed = JSON.parse(result.data);
    if (!parsed.access_token) {
      return { success: false, error: 'No access_token in refresh response' };
    }
    return {
      success: true,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token || refreshToken,
      expiresIn: parsed.expires_in,
    };
  } catch (e) {
    return { success: false, error: `Failed to parse refresh response: ${e.message}` };
  }
}

async function persistTokens({ supabase, workspaceId, accessToken, refreshToken, expiresIn }) {
  if (!supabase || !workspaceId) return;
  try {
    const update = {
      aweber_access_token: accessToken,
      updated_at: new Date().toISOString(),
    };
    if (refreshToken) update.aweber_refresh_token = refreshToken;
    if (expiresIn) update.aweber_access_token_expires = new Date(Date.now() + expiresIn * 1000).toISOString();
    await supabase.from('settings').update(update).eq('workspace_id', workspaceId);
  } catch (e) {
    // Silent — engine will keep using refreshed token in memory for this run
  }
}

async function attemptSubscribe({ accessToken, listId, email, name, tags, customFields }) {
  if (!accessToken || !listId || !email) {
    return { success: false, error: 'Missing required parameters (accessToken, listId, email)' };
  }

  const url = `${AWEBER_API_BASE}/accounts/${AWEBER_ACCOUNT_ID}/lists/${listId}/subscribers`;
  const body = JSON.stringify({
    email,
    name,
    tags,
    custom_fields: customFields,
  });

  const urlObj = new URL(url);
  const result = await httpsRequest({
    hostname: urlObj.hostname,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  }, body);

  if (result.statusCode === 201) {
    return { success: true, subscriberUrl: result.headers.location || '' };
  }
  if (result.statusCode === 409) {
    return { success: true, duplicate: true };
  }
  return { success: false, error: `AWeber API ${result.statusCode}: ${result.data}`, statusCode: result.statusCode };
}

/**
 * Subscribe an email to an AWeber list
 * @param {Object} params
 * @param {string} params.accessToken - OAuth2 access token
 * @param {string} params.listId - AWeber list ID
 * @param {string} params.email - Email address
 * @param {string} params.name - Optional name
 * @param {string[]} params.tags - Optional tags
 * @param {Object} params.customFields - Optional custom fields {key: value}
 * @param {string} params.refreshToken - Optional refresh token for auto-refresh
 * @param {string} params.clientId - Optional AWeber client ID
 * @param {string} params.clientSecret - Optional AWeber client secret
 * @param {Object} params.supabase - Optional Supabase client to persist refreshed tokens
 * @param {string} params.workspaceId - Optional workspace ID to persist refreshed tokens
 * @returns {Promise<{success: boolean, subscriberUrl?: string, duplicate?: boolean, error?: string}>}
 */
async function subscribe(params) {
  const {
    accessToken, listId, email, name = '', tags = [], customFields = {},
    refreshToken, clientId, clientSecret, supabase, workspaceId,
  } = params;

  const result = await attemptSubscribe({ accessToken, listId, email, name, tags, customFields });
  if (result.success || result.statusCode !== 401) {
    return result;
  }

  // Token expired — try to refresh
  if (!refreshToken || !clientId || !clientSecret) {
    return { success: false, error: `AWeber token expired and no refresh credentials provided` };
  }

  const refreshResult = await refreshAccessToken({ refreshToken, clientId, clientSecret });
  if (!refreshResult.success) {
    return { success: false, error: `AWeber token expired, refresh failed: ${refreshResult.error}` };
  }

  // Persist refreshed tokens so next engine start uses them
  await persistTokens({
    supabase, workspaceId,
    accessToken: refreshResult.accessToken,
    refreshToken: refreshResult.refreshToken,
    expiresIn: refreshResult.expiresIn,
  });

  // Retry subscribe with new token
  return await attemptSubscribe({
    accessToken: refreshResult.accessToken, listId, email, name, tags, customFields,
  });
}

module.exports = { subscribe };
