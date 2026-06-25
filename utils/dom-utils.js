// utils/dom-utils.js
// Shared DOM utility helpers for dashboard and extension pages.
// NOTE: content.js is a non-module plain script and cannot import from here —
//       it keeps its own identical local copy of escapeHtml.

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
