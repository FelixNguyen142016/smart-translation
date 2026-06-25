// dashboard/game-render.js
// Pure render helpers for game UI — no state, no side effects

import { getWords } from '../utils/storage.js';
import { formatXPBar, xpPercent } from '../utils/player.js';
import { escapeHtml } from '../utils/dom-utils.js';

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
export function renderResults(profile, sessionStats, newAchievements) {
  const el = document.getElementById('results-content');
  if (!el) return;
  const accuracy = sessionStats.totalAnswered > 0
    ? Math.round((sessionStats.correct / sessionStats.totalAnswered) * 100) : 0;
  const titlesHtml = profile.titles?.length
    ? `<div class="results-titles">${profile.titles.map(t => `<span class="results-title-badge">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  el.innerHTML = `
    <div class="results-stat"><span class="rs-big">${sessionStats.correct}</span><span>Correct</span></div>
    <div class="results-stat"><span class="rs-big">${accuracy}%</span><span>Accuracy</span></div>
    <div class="results-stat"><span class="rs-big">${sessionStats.wordsMastered}</span><span>Mastered</span></div>
    <div class="results-level">Level ${profile.level} · ${formatXPBar(profile)}</div>
    ${titlesHtml}
    ${newAchievements.map(a => `<div class="achievement-unlock">🏆 ${escapeHtml(a.title)}: ${escapeHtml(a.desc)}</div>`).join('')}`;
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

/** Render word review list (relearn + learning state words) */
export async function renderReview() {
  const allWords = await getWords();
  const pending = allWords.filter(w => w.learningState === 'relearn' || w.learningState === 'learning');
  const el = document.getElementById('review-list');
  if (!el) return;
  if (!pending.length) {
    el.innerHTML = '<p style="color:var(--text-muted)">No words need review right now.</p>';
    return;
  }
  el.innerHTML = pending.map(w => `
    <div class="review-item">
      <span class="review-word">${escapeHtml(w.text)}</span>
      <span class="review-state state-${escapeHtml(w.learningState)}">${escapeHtml(w.learningState)}</span>
      <span class="review-def">${escapeHtml(w.aiAnalysis?.definition || '')}</span>
    </div>`).join('');
}
