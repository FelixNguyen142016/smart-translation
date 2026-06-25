// utils/storage-adapter.js
// StorageAdapter interface contract + singleton factory.
//
// Every file that reads or writes storage calls getAdapter() instead of
// touching chrome.storage.local directly. Swapping the adapter (one line:
// setAdapter(new ApiStorageAdapter())) makes the entire codebase portable
// to Firefox/Safari (P2 polyfill) and the backend sync (P3 ApiStorageAdapter).

import { createChromeAdapter } from './chrome-storage-adapter.js';

/**
 * @typedef {{
 *   get(key: string): Promise<any>,
 *   set(obj: object): Promise<void>,
 *   remove(keys: string|string[]): Promise<void>,
 *   getAll(): Promise<object>,
 *   onChanged(cb: (changes: object) => void): () => void
 * }} StorageAdapter
 */

/** @type {StorageAdapter|null} */
let _adapter = null;

/**
 * Returns the active storage adapter.
 * Defaults to ChromeStorageAdapter on first call.
 * @returns {StorageAdapter}
 */
export const getAdapter = () => _adapter ?? (_adapter = createChromeAdapter());

/**
 * Override the active adapter — used in tests and for P3 ApiStorageAdapter.
 * @param {StorageAdapter} adapter
 */
export const setAdapter = (adapter) => { _adapter = adapter; };
