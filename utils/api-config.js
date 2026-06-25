// utils/api-config.js
// Cloud backend URL and bearer token management.
// Token is stored locally via the Chrome adapter (not through the API adapter to avoid circular deps).

import { createChromeAdapter } from './chrome-storage-adapter.js';

// TODO: Replace with your actual workers.dev URL after first deploy.
// Run `npx wrangler deploy` in the server/ directory to get this URL.
const BACKEND_URL = 'https://smart-translation-api.fukumakino613.workers.dev';

const TOKEN_KEY    = 'cloud_auth_token';
const USER_ID_KEY  = 'cloud_user_id';
const EMAIL_KEY    = 'cloud_user_email';

// Use the Chrome adapter directly here to avoid circular dependency with storage-adapter.js
const _local = createChromeAdapter();

export const getBackendUrl = () => BACKEND_URL;

/** @returns {Promise<string|null>} */
export const getAuthToken    = () => _local.get(TOKEN_KEY);

/** @returns {Promise<string|null>} */
export const getCloudUserId  = () => _local.get(USER_ID_KEY);

/** @returns {Promise<string|null>} */
export const getCloudEmail   = () => _local.get(EMAIL_KEY);

/**
 * Store token + userId + email after successful login.
 * @param {string} token
 * @param {string} userId
 * @param {string} email
 */
export async function setAuthSession(token, userId, email) {
  await _local.set({ [TOKEN_KEY]: token, [USER_ID_KEY]: userId, [EMAIL_KEY]: email });
}

/** Clear session on logout. */
export async function clearAuthSession() {
  await _local.remove([TOKEN_KEY, USER_ID_KEY, EMAIL_KEY]);
}

/** Returns true if a token is stored (user is logged in). */
export async function isLoggedIn() {
  const token = await _local.get(TOKEN_KEY);
  return Boolean(token);
}
