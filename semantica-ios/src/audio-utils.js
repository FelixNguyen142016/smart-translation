// renderer/audio-utils.js
// Shared word-pronunciation playback: cached Google TTS audio when available,
// Web Speech API as a fallback. Extracted out of app.js (where it originally
// lived alongside the vocab list / review flashcard / Listen-and-Write
// practice call sites) so game-controller.js can reuse it for Quick Ear mode
// without creating a circular import — app.js imports initGame from
// game-controller.js, so game-controller.js can't import back from app.js.
// Behavior is unchanged from the original app.js implementation.

import { escapeHtml } from './dom-utils.js';

export function speakText(word, audioBase64) {
  if (!word) return;

  if (audioBase64) {
    try {
      const audio = new Audio(`data:audio/mp3;base64,${audioBase64}`);
      audio.play();
      return;
    } catch (_) { /* fall through to Web Speech */ }
  }

  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  window.speechSynthesis.speak(utterance);
}

// ─── Reusable "speaker" button (icon circle + label) ────────────────────────
// Same markup/behavior used across the vocab list, the review flashcard back,
// and Listen and Write practice — centralized here to avoid drift across
// call sites.
export function createSpeakerButton(word, audioBase64, label = 'Play') {
  const btn = document.createElement('button');
  btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;color:var(--text-muted);background:none;border:none;cursor:pointer;font-size:11px;font-family:inherit;padding:0;transition:color 0.15s;';
  btn.innerHTML = `<span style="width:22px;height:22px;border-radius:50%;background:linear-gradient(rgba(6,182,212,0.14),rgba(6,182,212,0.14)), var(--muted-bg);display:flex;align-items:center;justify-content:center;transition:background 0.15s;"><i data-lucide="volume-2" style="width:11px;height:11px;color:var(--brand);stroke-width:2.5;"></i></span><span>${escapeHtml(label)}</span>`;
  btn.onmouseenter = () => { btn.style.color = 'var(--brand)'; btn.querySelector('span').style.background = 'linear-gradient(rgba(6,182,212,0.26),rgba(6,182,212,0.26)), var(--muted-bg)'; };
  btn.onmouseleave = () => { btn.style.color = 'var(--text-muted)'; btn.querySelector('span').style.background = 'linear-gradient(rgba(6,182,212,0.14),rgba(6,182,212,0.14)), var(--muted-bg)'; };
  btn.onclick = (e) => { e.stopPropagation(); speakText(word, audioBase64); };
  if (window.lucide) window.lucide.createIcons({ nodes: [btn] });
  return btn;
}
