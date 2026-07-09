// renderer/game-render.js
// Pure render helpers for game UI — no state, no side effects
// Adapted from dashboard/game-render.js: import paths updated to local renderer/

import { getWords } from './storage-shim.js';
import { formatXPBar, xpPercent } from './player.js';
import { escapeHtml } from './dom-utils.js';

/** Render the player profile widget on the main menu */
export function renderMenu(profile) {
  const el = document.getElementById('menu-profile');
  if (!el) return;
  el.innerHTML = `
    <div class="profile-level">Level ${profile.level}</div>
    <div class="profile-xp-bar"><div class="profile-xp-fill" style="width:${xpPercent(profile)}%"></div></div>
    <div class="profile-xp-label">${formatXPBar(profile)}</div>
    <div class="profile-stats">
      <span>🎯 ${profile.accuracy}% accuracy</span>
      <span>🔥 ${profile.streak} day streak</span>
      <span>⭐ ${profile.wordsMastered} mastered</span>
    </div>`;
}

/** Render session summary on the results screen */
export function renderResults(profile, sessionStats, newAchievements, raceLog = null) {
  const el = document.getElementById('results-content');
  if (!el) return;
  const accuracy = sessionStats.totalAnswered > 0
    ? Math.round((sessionStats.correct / sessionStats.totalAnswered) * 100) : 0;
  const titlesHtml = profile.titles?.length
    ? `<div class="results-titles">${profile.titles.map(t => `<span class="results-title-badge">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  // Race-only word review log
  const raceReviewHtml = raceLog?.length ? `
    <div class="race-review">
      <div class="race-review-title">Word Review</div>
      <div class="race-review-list">
        ${raceLog.map(({ word, correct, skipped }) => {
          const icon  = correct ? '✓' : skipped ? '→' : '✗';
          const cls   = correct ? 'rr-correct' : skipped ? 'rr-skip' : 'rr-wrong';
          const trans = word.aiAnalysis?.translation
            ? `<span class="rr-trans">${escapeHtml(word.aiAnalysis.translation)}</span>` : '';
          const def   = word.aiAnalysis?.definition
            ? `<span class="rr-def">${escapeHtml(word.aiAnalysis.definition)}</span>` : '';
          return `<div class="race-review-row ${cls}">
            <span class="rr-icon">${icon}</span>
            <span class="rr-word">${escapeHtml(word.text)}</span>
            ${trans}${def}
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  el.innerHTML = `
    <div class="results-stat"><span class="rs-big">${sessionStats.correct}</span><span>Correct</span></div>
    <div class="results-stat"><span class="rs-big">${accuracy}%</span><span>Accuracy</span></div>
    <div class="results-stat"><span class="rs-big">${sessionStats.wordsMastered}</span><span>Mastered</span></div>
    <div class="results-level">Level ${profile.level} · ${formatXPBar(profile)}</div>
    ${titlesHtml}
    ${newAchievements.map(a => `<div class="achievement-unlock">🏆 ${escapeHtml(a.title)}: ${escapeHtml(a.desc)}</div>`).join('')}
    ${raceReviewHtml}`;
}

/** Render mission objective progress (called each round in mission mode) */
export function renderMissionObjectives(objectives) {
  const el = document.getElementById('mission-objectives');
  if (!el || !objectives) return;
  el.innerHTML = objectives.map(o =>
    `<div class="obj ${o.current >= o.target ? 'done' : ''}">
      ${o.current >= o.target ? '✓' : '○'} ${o.label} (${o.current}/${o.target})
    </div>`).join('');
}

// Selected tags for the Game tab's "Words to Review" filter. Module-level so
// selections persist across re-renders (e.g. toggling a chip) within a session.
const _reviewTagFilter = new Set();

/** Distinct tags on a word: same source as the My Vocabulary tag cloud (app.js renderTagCloud) */
function wordTags(w) {
  return [...new Set([...(w.aiAnalysis?.tags || []), ...(w.userTags || [])])];
}

/** Build the "Filter by tag" pill row above the review list, styled like the My Vocabulary tag cloud */
function renderReviewTagFilter(pending) {
  const wrap    = document.getElementById('review-tag-filter');
  const chipsEl = document.getElementById('review-tag-filter-chips');
  if (!wrap || !chipsEl) return;

  const tagCounts = new Map();
  pending.forEach(w => wordTags(w).forEach(t => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));

  // Drop selections for tags that no longer appear among the pending words
  [..._reviewTagFilter].forEach(t => { if (!tagCounts.has(t)) _reviewTagFilter.delete(t); });

  if (!tagCounts.size) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'block';
  chipsEl.innerHTML = '';

  [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([tag, count]) => {
    const btn = document.createElement('button');
    btn.className = 'tag-chip' + (_reviewTagFilter.has(tag) ? ' active' : '');
    btn.innerHTML = `${escapeHtml(tag)} <span class="tag-count">${count}</span>`;
    btn.addEventListener('click', () => {
      if (_reviewTagFilter.has(tag)) _reviewTagFilter.delete(tag); else _reviewTagFilter.add(tag);
      renderReview();
    });
    chipsEl.appendChild(btn);
  });
}

/** Render word review list (relearn + learning state words), filtered by any selected tags */
export async function renderReview() {
  const allWords = await getWords();
  const pending = allWords.filter(w => w.learningState === 'relearn' || w.learningState === 'learning');

  renderReviewTagFilter(pending);

  const filtered = _reviewTagFilter.size
    ? pending.filter(w => wordTags(w).some(t => _reviewTagFilter.has(t)))
    : pending;

  const el = document.getElementById('review-list');
  if (!el) return;
  if (!filtered.length) {
    el.innerHTML = pending.length
      ? '<p style="color:var(--text-muted)">No words match the selected tag(s).</p>'
      : '<p style="color:var(--text-muted)">No words need review right now.</p>';
    return;
  }
  el.innerHTML = filtered.map(w => `
    <div class="review-item">
      <span class="review-word">${escapeHtml(w.text)}</span>
      <span class="review-state state-${escapeHtml(w.learningState)}">${escapeHtml(w.learningState)}</span>
      <span class="review-def">${escapeHtml(w.aiAnalysis?.definition || '')}</span>
    </div>`).join('');
}
