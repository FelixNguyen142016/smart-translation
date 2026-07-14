# Plan: Flashcard replay speaker + Practice mode split

**Status:** implemented, code-reviewed, 1 critical finding fixed — not yet build/browser-verified
**Scope:** `semantica-tauri` only (legacy `desktop/renderer` Electron app has its own independent copy of this code — left untouched, per this session's established convention)

**Post-implementation note:** code review (`code-reviewer` subagent) found one Critical, real regression not anticipated in this plan — see `Log_09-07.md` §14 for the full writeup. Fixed in `game-controller.js`, not `app.js`/`index.html`. All other acceptance criteria confirmed met by the reviewer.

## Phase 1 — Replay speaker on the flashcard back face

**File:** `semantica-tauri/src/app.js`, `showNextCard()` (~line 2136-2163)

- Add a speaker button to the flashcard back face (`back.innerHTML`), placed near the top next to the word/phonetic. Reuses the exact icon-circle + label pattern already used for the vocab-list play button (~line 833-838): 22px gradient icon circle, `volume-2` lucide icon, "Play" label, hover color transition.
- `onclick`: `e.stopPropagation(); speakText(word.text, word.aiAnalysis?.audioBase64);` — same call already fired automatically once on flip (line 2191); this just makes it manually repeatable.
- No new CSS classes — follows the existing inline-style convention used for this exact type of button elsewhere in the file.

**Acceptance criteria:**
- Flipping a review card still auto-plays audio once, unchanged.
- A speaker button is visible on the card back; clicking it replays the same word's audio on demand, any number of times.
- Works identically whether the word has cached Google TTS audio or falls back to Web Speech API (unchanged `speakText` behavior).

## Phase 2 — Split Practice into "Read and Write" / "Listen and Write" mode cards

**Files:** `semantica-tauri/src/index.html`, `semantica-tauri/src/app.js`

**Mode selection screen** (`index.html`, inside `#practice-view`):
- New sub-screen shown first, reusing the existing `.mode-grid`/`.mode-card` CSS from the Game tab's "Choose a Mode" screen (no new CSS needed for the cards themselves).
- Two cards: "Read and Write" (existing FITB flow, renamed/relabeled only — logic unchanged) and "Listen and Write" (new).
- Add a minimal `.practice-screen { display:none; } .practice-screen.active { display:block; }` pair (2 lines), mirroring `.game-screen`'s identical existing pattern — kept as its own class rather than reusing `.game-screen` to stay scoped to this tab.
- `#practice-container` (existing FITB render target) becomes one `.practice-screen`; the new mode-select markup becomes another.

**Wiring** (`app.js`):
- Tab-click handler (line 291): `renderPractice()` → replaced with a new `showPracticeModeSelect()` that shows the mode-select screen (matches `NO_DISSOLVE` already anticipating sub-screens for this tab).
- Mode-card click handlers (mirroring `game-controller.js`'s `.mode-card` wiring): clicking "Read and Write" shows the practice screen and calls the existing `renderPractice()` (unchanged internals — only the entry point changes, not the FITB logic itself). Clicking "Listen and Write" shows the practice screen and calls a new `renderListenWrite()`.
- Both modes' "session complete" screens get a "← Back to modes" action alongside the existing "Practice Again" button, so there's a way back to the mode picker (existing FITB complete-screen currently has no way back at all beyond re-clicking the tab).

**New `renderListenWrite()` / `_showNextListen()` (new functions in `app.js`, structurally parallel to `renderPractice()`/`_showNextFitb()`):**
- Word pool: **all saved words** (per your answer) — no sentence-length filter, since this mode only needs the word + audio. Same Fisher-Yates shuffle as the existing mode.
- Card UI: word text is hidden entirely (no visual cue). Shows a speaker button (same pattern as Phase 1) that plays `speakText(word.text, word.aiAnalysis?.audioBase64)` — auto-plays once on card entry, and is manually re-clickable for unlimited replays. Text input for the typed answer, "Check" / "Skip" / "Hint" (first-letter, reusing the exact hint pattern from FITB) buttons.
- Answer check: case-insensitive exact match against `word.text` (reuses FITB's `norm()` convention) — no "sentence form" matching needed since there's no sentence here, just the bare word.
- On check: reveal definition + translation **and** the correct spelling (per your answer), reusing FITB's `revealDiv` reveal-block pattern and its correct/wrong `_practiceCorrect`/`_practiceWrong`-equivalent tracking (separate arrays scoped to this mode, so switching modes mid-way doesn't cross-contaminate score tracking).
- Session-complete screen: same score/correct/wrong summary layout as FITB's, reused as closely as possible (`fitb-card` class, same score % calculation) plus the "← Back to modes" action.

**Acceptance criteria:**
- Practice tab now opens on a 2-card mode picker instead of jumping straight into Read and Write.
- "Read and Write" card behaves identically to today's Practice feature — zero regression (same filter, same sentence-blanking, same scoring).
- "Listen and Write" card: shows no word text, plays audio automatically on card load, has a working manual replay button, accepts a typed answer, checks it case-insensitively against the word, and reveals definition+translation+correct spelling after checking — works for every saved word regardless of whether it has an example sentence.
- Both modes have a way back to the mode-picker screen.
- No changes to Review tab, Game tab, or any backend/API/schema.

## Out of scope
- `desktop/renderer` (legacy Electron) — not touched.
- No new dependencies, no server-side changes.
- No changes to SRS/spaced-repetition logic (Review tab) — Practice has no scheduling, matching its current behavior.

## Verification
- `node --check app.js` after each phase.
- Manual walkthrough of both practice modes plus the flashcard replay button (no browser available in this sandbox — flagged as unverified-in-sandbox, same caveat as prior sessions' UI work).
- `code-reviewer` subagent pass before finalize, per `/cook` workflow.
