// renderer/dom-utils.js
// Shared DOM utility helpers
// Copied from utils/dom-utils.js — no changes needed

/**
 * Escape HTML special characters to prevent XSS when injecting user or AI data via innerHTML.
 * @param {string|null} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
