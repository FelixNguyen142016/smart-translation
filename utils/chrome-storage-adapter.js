// utils/chrome-storage-adapter.js
// Chrome-specific StorageAdapter implementation — wraps chrome.storage.local.
// This is the ONLY file in the codebase that may call chrome.storage.local directly.
// All other files go through getAdapter() from storage-adapter.js.

/**
 * @returns {import('./storage-adapter.js').StorageAdapter}
 */
export const createChromeAdapter = () => ({
  /**
   * Get a single value by key. Returns the value (not the wrapper object).
   * @param {string} key
   * @returns {Promise<any>}
   */
  get: async (key) => {
    const result = await chrome.storage.local.get(key);
    return result[key];
  },

  /**
   * Get multiple values at once. Returns the raw result object { key: value, ... }.
   * Needed for cases where callers check result[key] themselves (e.g. settings merging).
   * @param {string|string[]} keys
   * @returns {Promise<object>}
   */
  getMany: (keys) => chrome.storage.local.get(keys),

  /**
   * Set one or more key-value pairs.
   * @param {object} obj
   * @returns {Promise<void>}
   */
  set: (obj) => chrome.storage.local.set(obj),

  /**
   * Remove one or more keys.
   * @param {string|string[]} keys
   * @returns {Promise<void>}
   */
  remove: (keys) => chrome.storage.local.remove(keys),

  /**
   * Get all stored key-value pairs (used by cache cleanup).
   * @returns {Promise<object>}
   */
  getAll: () => chrome.storage.local.get(null),

  /**
   * Subscribe to local storage changes.
   * The callback receives the raw `changes` object ({ key: { oldValue, newValue } })
   * already filtered to the 'local' namespace.
   * @param {(changes: object) => void} cb
   * @returns {() => void} unsubscribe function
   */
  onChanged: (cb) => {
    const fn = (changes, ns) => { if (ns === 'local') cb(changes); };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  },
});
