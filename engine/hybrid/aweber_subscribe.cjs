/**
 * AWeber Subscribe Utility
 * Subscribes an email to an AWeber list with tags
 */
const https = require('https');

const AWEBER_API_BASE = 'https://api.aweber.com/1.0';
const AWEBER_ACCOUNT_ID = '2394058'; // Hardcoded — same account for all workspaces

/**
 * Subscribe an email to an AWeber list
 * @param {Object} params
 * @param {string} params.accessToken - OAuth2 access token
 * @param {string} params.accountId - AWeber account ID
 * @param {string} params.listId - AWeber list ID
 * @param {string} params.email - Email address
 * @param {string} params.name - Optional name
 * @param {string[]} params.tags - Optional tags
 * @param {Object} params.customFields - Optional custom fields {key: value}
 * @returns {Promise<{success: boolean, subscriberUrl?: string, error?: string}>}
 */
async function subscribe({ accessToken, listId, email, name = '', tags = [], customFields = {} }) {
  if (!accessToken || !listId || !email) {
    return { success: false, error: 'Missing required parameters (accessToken, listId, email)' };
  }

  const url = `${AWEBER_API_BASE}/accounts/${AWEBER_ACCOUNT_ID}/lists/${listId}/subscribers`;

  const body = {
    email,
    name,
    tags,
    custom_fields: customFields,
  };

  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 201) {
          const location = res.headers.location || '';
          resolve({ success: true, subscriberUrl: location });
        } else if (res.statusCode === 409) {
          // Duplicate subscriber — not an error
          resolve({ success: true, duplicate: true });
        } else {
          resolve({ success: false, error: `AWeber API ${res.statusCode}: ${data}` });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    req.write(JSON.stringify(body));
    req.end();
  });
}

module.exports = { subscribe };
