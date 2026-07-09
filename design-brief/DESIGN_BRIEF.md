# Semantica — AI Designer Brief

## What is Semantica?

Semantica is a **desktop app** (Electron, macOS + Windows) for intermediate-to-advanced English learners (B2–C1 CEFR level). It helps users collect vocabulary they encounter while reading or browsing, then study those words using AI-powered definitions, spaced repetition flashcard review, fill-in-the-blank practice, and a gamified mode. The experience is personal, calm, and focused — think a premium vocabulary notebook crossed with a study tool.

---

## Brand Identity

**App name:** Semantica  
**Tagline:** "Build a vocabulary that levels up yourself."  
**Personality:** Smart, clean, focused, slightly playful. Not corporate. Not childish. Think Notion meets Duolingo for adults.

### Colour System

| Token | Value | Usage |
|-------|-------|-------|
| Brand primary | `#06b6d4` (cyan-500) | Active states, highlights, brand elements |
| Brand secondary | `#38bdf8` (sky-400) | Gradients, accent fills |
| Brand deep | `#0891b2` (cyan-600) | Hover states, deep accents |
| Brand soft | `rgba(6,182,212,0.07)` | Subtle backgrounds, tag chips |
| Text main | `#0f172a` | Primary text |
| Text muted | `#64748b` | Secondary text, labels |
| Text soft | `#94a3b8` | Placeholder, disabled text |
| Success | `#16a34a` | Correct answers, saved state |
| Danger | `#ef4444` | Wrong answers, errors |
| Border | `rgba(0,0,0,0.08)` | Card outlines, dividers |
| Background | `#F8FAFC` | App background |
| Dark background | `#0F172A` | Dark mode background |

### Typography
- **Font:** Inter (Google Fonts)
- Headings: `700` weight
- Body: `400–500` weight
- Labels/caps: `600–700` weight, `uppercase`, `0.08em` letter-spacing

### Logo Mark
The Semantica logo is a gradient cyan pill/box containing a **✦ sparkle icon** (Lucide `sparkles`), next to the word "Semantica" in 700-weight Inter with a cyan gradient text fill (`linear-gradient(135deg, #06b6d4, #38bdf8)`).

---

## Screen 1 — Login Page

### Layout
Two-column card, max-width 920px, centered on a `#F8FAFC` background.

**Left panel (form) — white, max-width 420px, padding 56px 48px:**
- Logo mark at top (✦ icon + "Semantica" gradient text)
- Large heading: "Ready to level up?" (32px, 700)
- Subtitle: "Your personal storage for advanced English. Let's elevate your vocabulary today." (13px, muted)
- **Email step:** pill-shaped email input + dark pill button "Send Code"
- **Code step (shown after email sent):** heading "Check your inbox", monospaced 6-digit OTP input (centered, letter-spacing), "Verify & Sign In" button, "← Use a different email" ghost link below
- Inputs have cyan focus ring (`box-shadow: 0 0 0 3px rgba(6,182,212,0.12)`)

**Right panel (illustration) — `#F4F4F0`, flex-1:**
- Large inline SVG illustration (`undraw_creative-flow_t3kz.svg`) — brand-colored paths use `#06b6d4`, dark paths adapt to light/dark mode
- Caption at bottom: "Build a vocabulary that levels up yourself with **Semantica.**"
- 24 scattered decorative SVG icons at 13% opacity in all four corners of the FULL BACKGROUND (not inside the card) — icons used: brain, pencil-sparkles, notebook-pen, gamepad-2, book-open-text, monitor-check — at various sizes (36–56px), rotations, overlapping at top-left, top-right, bottom-left, bottom-right clusters

**Card styling:** `border-radius: 24px`, large drop shadow (`0 20px 60px rgba(15,23,42,0.12)`), `overflow: hidden`

### Transition
On login: login card fades + scales out (`opacity: 0, scale: 0.97`), dashboard slides up from below (`translateY(18px) → 0, opacity: 0 → 1`).

---

## Screen 2 — Main App Navigation Bar

**Height:** 60px, sticky top, `backdrop-filter: blur(18px) saturate(1.8)`, semi-transparent white background (`rgba(248,250,252,0.88)`), bottom border `1px solid rgba(0,0,0,0.07)`.

**Left:** Logo mark (✦ icon in cyan gradient 32×32 pill + "Semantica" text, 700 weight, 15px)

**Center (tabs):** 6 navigation tabs in a row, each with a small Lucide icon + label:
1. 📚 **My Vocabulary** (`library` icon)
2. 🔄 **Review** (`flip-horizontal` icon)
3. ✏️ **Practice** (`pen-line` icon)
4. 🎮 **Game** (`gamepad-2` icon)
5. 📝 **Sentences** (`align-left` icon)
6. ⚙️ **Account & Settings** (`settings` icon)

Tabs are 13px Inter 500. Inactive = muted grey. Active = `#06b6d4` (brand). A **sliding gradient underline indicator** (`height: 2px, background: linear-gradient(90deg, #06b6d4, #38bdf8)`) animates under the active tab with smooth cubic-bezier easing. Tab switching (to My Vocabulary/Sentences/Account) uses a cross-dissolve animation (fade + subtle 6px slide up). Review/Practice/Game tabs switch instantly (no animation — these have internal sub-screens).

**Right:** 🌙 moon icon button (32×32, border-radius 8px) toggles dark mode.

On macOS, a 28px drag region sits above the nav bar to avoid the traffic light buttons.

---

## Screen 3 — My Vocabulary Tab (Default view)

A single white card fills the main content area (max-width 1000px, centered, padding 28px 20px).

### Search Bar
Full-width input with a magnifying glass icon on the left. Placeholder: "Search or define a word…". When a search term is not in the vocabulary, a cyan prompt banner appears below: `"[word]" · Not in your vocabulary — Define this word →` with a small "Define this word →" button.

### Filter System (3 rows of chips, collapsible)
1. **Band pills** — coloured pill per IELTS band level (Band 2=slate, Band 5=teal, Band 6=blue, Band 7=purple, Band 8=amber, Band 9=red). Each shows word count.
2. **IELTS Topic chips** — indigo-tinted chips for topics like "Environment", "Technology", "Health" etc. Each shows word count.
3. **Tag chips** — auto-generated topic tags, collapsed to 2 lines with a "See more ↓" expander.

When a filter is active, a cyan active filter bar appears showing what's selected + a **"▶ Review these words"** button and **"✕ Clear"** button.

### Vocabulary Table
4 columns:

**Column 1 — Word:**
- Word name in gradient text (cyan)
- IPA pronunciation in small muted text below
- 🔊 play button (speaks the word)
- Coloured band pill (e.g. "Band 7" in purple)

**Column 2 — Context & Meaning:**
- Context sentence (if available) in italic muted text
- AI definition card with light cyan gradient background (`linear-gradient(135deg, rgba(236,254,255,0.9), rgba(240,249,255,0.6))`), cyan border
- English definition inside

**Column 3 — Tags:**
- Small rounded pill chips for auto-generated tags (IELTS topics + word categories)
- Each tag has a `×` remove button
- `+ tag` add button at the end

**Column 4 — Actions:**
- Delete button (trash icon)

At the bottom of a long list: "↑ Back to top" ghost button (pill shaped, centered).

---

## Screen 4 — Review Tab (Spaced Repetition Flashcards)

### SRS Strip (top of view)
A white rounded card showing 4 counters:
- 🔴 Overdue (N words)
- 🟡 Due today (N words)
- 🔵 Upcoming (N words)
- ⚪ New (N words)

Two action buttons: **"Due (N)"** and **"All (N)"** — pill shaped, gradient fill.

### Flashcard
A large centered card that flips. Front shows the word. Back shows:
- Full AI definition
- Translation (Vietnamese)
- Example sentence
- Next review date chip (e.g. "🕐 Due now / Tomorrow / In 3 days")
- Review count

### Answer Buttons (shown on card back)
Three buttons in a row:
- 🔴 **Hard** — resets interval
- 🟢 **Good** — standard progression  
- 🔵 **Easy** — fast-tracks the word

---

## Screen 5 — Practice Tab (Fill-in-the-Blank)

A centered card (`max-width: 560px`, rounded 20px, subtle cyan shadow).

- Shows an example sentence with the target word blanked out as `_____`
- A large centered text input (18px, monospace-feel, 2px cyan border)
  - Green border + background on correct answer
  - Red border + background on wrong answer
- "Check" / "Next" button (primary, full width)
- "💡 Hint" button — reveals first 2 characters
- "Show sentence" toggle — reveals the full sentence
- Score progress at top (e.g. "5 / 12")
- End screen: score percentage, green "Correct" word pills, red "Needs Work" word pills, "Restart" button

---

## Screen 6 — Game Tab

### Mode Selection Screen
3 mode cards in a row, each selectable:

1. **🏁 Race Mode** — answer as many words as possible, gain XP for correct answers, lose XP for wrong
2. **💀 Survival Mode** — timed, wrong answers cost seconds, survive as long as possible
3. **🎯 Mission Mode** — complete objectives (e.g. "answer 5 in a row without hints")

Below the mode cards (Race only): a **word count selector** — "5 words / 10 words / 20 words / All words" — pill toggle buttons.

A large gradient "Start Game" button at the bottom.

### In-Game Screen
- Word displayed prominently
- 4 multiple-choice answer buttons in a 2×2 grid
- A "Skip" button
- Live stats: XP counter, streak counter, progress bar (Race) / timer (Survival)
- Correct answer = green flash + XP popup (+15 XP)
- Wrong answer = red flash + XP deduction
- Skip = grey flash

### Results Screen
- XP earned, total XP bar, level indicator
- Achievements unlocked (badge icons with names)
- Streak summary
- **Word Review section** (Race mode only): list of every word answered — each row shows:
  - ✓ green = correct
  - ✗ red = wrong
  - → grey = skipped
  - Word name, translation, short definition

---

## Screen 7 — Sentences Tab

A card listing all saved words that have an example sentence. Each item shows:
- The word (cyan, bold)
- The example sentence with the word highlighted
- Source label ("✦ AI example" if generated by AI vs real context)

---

## Screen 8 — Account & Settings Tab

Sections:
- **Account:** email address, sync status, logout button
- **AI Provider:** dropdown (Cloud / Free/Local)
- **Target Language:** dropdown (Vietnamese default)
- **Theme:** hue slider (changes the brand color across the whole app) + dark mode toggle
- **Sync status chip:** "Last synced: just now" / "Syncing…" / "Offline — using local data"

---

## Screen 9 — Floating Translate Popup Window

Triggered by **Cmd/Ctrl+Shift+T** (copies selected text from any app, analyzes it).  
A small frameless always-on-top window (~340px wide).

**Header:** "Semantica" label + close button (×)

**Loading state:** 3–4 shimmer placeholder bars animating

**Result state:**
- Word (large, bold)
- IPA pronunciation + part of speech
- Vietnamese translation (cyan accent)
- Vietnamese definition
- "English" label + English definition
- Example sentence + translated example sentence

**Already-saved state:** a cyan badge at top "✓ Already in your dashboard" — content loads instantly from cache, no API call

**Footer:**
- "Save to Vocabulary" button (gradient, pill shaped)
- Status text: "Saved ✓" / "Error" / "Already in your dashboard"

---

## Screen 10 — Global Search Bar Window

Triggered by **Cmd/Ctrl+Shift+F** (works system-wide, from any app).  
A slim, pill-shaped frameless always-on-top window (~520×62px), centered near the top of the screen (28% from top).

**Style:** glassmorphism — `backdrop-filter: blur(20px)`, semi-transparent background, rounded `border-radius: 16px`

**Content:** A single search input with a magnifying glass icon + placeholder "Search a word…"
- Press Enter → searches the word
- Press Escape → closes the bar
- Dismisses automatically on blur (clicking outside)
- Dark mode aware

---

## Dark Mode

All screens support dark mode. Key changes:
- Background: `#0F172A`
- Cards: `rgba(30,41,59,0.92)` with `rgba(255,255,255,0.07)` borders
- Text: `#e2e8f0` main, `#94a3b8` muted
- Nav background: darker semi-transparent
- SVG illustration on login: dark paths invert to `#c8d6e8`
- AI cards: dark cyan gradient (`rgba(6,182,212,0.08)`)

---

## Transitions & Micro-interactions

- **Login → Dashboard:** login card fades + scales to 0.97 while dashboard slides up from 18px below
- **Tab switching (My Vocabulary, Sentences, Account):** cross-dissolve — outgoing fades out + slides up 4px (180ms), incoming fades in + slides from 6px (220ms)
- **Tab switching (Review, Practice, Game):** instant — no animation (these have internal sub-screens that manage their own state)
- **Sliding nav indicator:** cyan gradient line slides between tabs (280ms, cubic-bezier)
- **Input focus:** cyan glow ring appears
- **Button hover:** subtle background shift
- **Save button:** spins briefly while saving, shows "Saved ✓" in green
- **Correct answer flash:** green overlay burst
- **Wrong answer flash:** red shake + overlay

---

## Asset Files (in `/assets/` folder)

| File | Usage |
|------|-------|
| `undraw_creative-flow_t3kz.svg` | Main login page illustration (right panel) |
| `undraw_reading-time_jva3.svg` | Alternative illustration (unused, available) |
| `brain (1).svg` | Decorative login background icon |
| `pencil-sparkles.svg` | Decorative login background icon |
| `notebook-pen.svg` | Decorative login background icon |
| `gamepad-2.svg` | Decorative login background icon |
| `book-open-text (1).svg` | Decorative login background icon |
| `monitor-check.svg` | Decorative login background icon |

All decorative icons are placed at 13% opacity, scattered in clusters at all four corners of the login page background (outside the card). They are various sizes (36–56px) with varied rotations (−30° to +30°) to feel organic, not grid-aligned.

---

## What to Design

Prioritise in this order:

1. **Login page** — the first impression. Two-column card layout. High polish.
2. **My Vocabulary tab** — the most-used screen. Word table with band pills, tags, AI definition cards.
3. **Floating popup** — small, elegant, glassmorphism. This is the core interaction.
4. **Game results screen** — the most visually rich screen (word review list, XP bar, achievements).
5. **Dark mode variants** of the above.
6. **Global search bar** — minimal, just a floating pill input.
