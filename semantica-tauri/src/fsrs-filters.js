// renderer/fsrs-filters.js
// The 5-way FSRS study filters (Due Today / New / Struggling / Mastered / All)
// and the shared pill-row renderer. Extracted from app.js so game-controller.js
// can reuse them for the Game tab's word-pool filter without a circular import
// (app.js imports initGame from game-controller.js — same reason speakText
// lives in audio-utils.js). app.js imports these back, so Review, Practice,
// and Game all share one filter definition that can't drift.

import { Rating, State as FsrsState } from './fsrs-vendor.js';
import { escapeHtml } from './dom-utils.js';

// Stability (ts-fsrs's `stability` field) is roughly "days until recall
// probability drops to ~90% without another review" — these thresholds are
// a reasonable day-scale default (Anki's own young/mature boundary is a
// similar ~21-day mark) and can be tuned if they don't feel right in practice.
export const STRUGGLING_STABILITY_MAX = 7;   // forgets within a week = struggling
export const MASTERED_STABILITY_MIN   = 21;  // holds for 3+ weeks = mastered

/** True once a word has gone through at least one FSRS review (vs. never-reviewed or pre-migration legacy SM-2 data). */
export function hasFsrsCard(word) {
  return typeof word.srs?.stability === 'number';
}

/**
 * The 5 filters exposed as pills on the Review, Practice, and Game tabs.
 * Each `predicate` takes a word and returns whether it belongs in that
 * filter's queue. Order here is also display order.
 */
export const FSRS_FILTERS = [
  {
    id: 'due', label: 'Due Today',
    predicate: w => !!w.srs?.dueDate && w.srs.dueDate <= Date.now(),
  },
  {
    id: 'new', label: 'New Words',
    predicate: w => !hasFsrsCard(w) || w.srs?.fsrsState === FsrsState.New,
  },
  {
    id: 'struggling', label: 'Struggling',
    predicate: w =>
      w.srs?.lastRating === Rating.Again || w.srs?.lastRating === Rating.Hard ||
      (hasFsrsCard(w) && w.srs.stability < STRUGGLING_STABILITY_MAX) ||
      w.srs?.fsrsState === FsrsState.Relearning,
  },
  {
    id: 'mastered', label: 'Mastered',
    predicate: w =>
      (hasFsrsCard(w) && w.srs.stability >= MASTERED_STABILITY_MIN) ||
      w.srs?.lastRating === Rating.Easy,
  },
  {
    id: 'all', label: 'All Words',
    predicate: () => true,
  },
];

export function getFsrsFilter(id) {
  return FSRS_FILTERS.find(f => f.id === id) ?? FSRS_FILTERS[0];
}

/**
 * Render a row of FSRS filter pills into `containerId`, calling
 * `onSelect(filterId)` when clicked. Shared markup/behavior for the Review
 * strip (alongside its overdue/due-today/upcoming/new counts), the Practice
 * strip, and the Game tab's word-pool picker.
 */
export function renderFsrsFilterPills(containerId, words, activeId, onSelect) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.innerHTML = FSRS_FILTERS.map(f => {
    const count  = words.filter(f.predicate).length;
    const active = f.id === activeId;
    const style  = active
      ? 'background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#fff;border:none;'
      : 'background:var(--brand-soft);color:var(--brand);border:1px solid var(--brand-border);';
    return `<button class="fsrs-filter-btn" data-filter="${f.id}" style="font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;font-weight:600;font-family:inherit;${style}">${escapeHtml(f.label)} (${count})</button>`;
  }).join('');
  wrap.querySelectorAll('.fsrs-filter-btn').forEach(btn => {
    btn.onclick = () => onSelect(btn.dataset.filter);
  });
}
