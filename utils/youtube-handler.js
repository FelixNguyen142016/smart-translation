// utils/youtube-handler.js
import { getAdapter } from './storage-adapter.js';

export class YouTubeHandler {
  constructor() {
    this.observer = null;
    this.navObserver = null;
    this.isInitialized = false;
    this.captionContainerSelector = '.ytp-caption-window-container';
    this.captionTextSelector = '.ytp-caption-segment';

    this.savedWords = new Set();         // lowercase saved word texts for O(1) highlight check
    this.savedTranslations = new Map();  // lowercase word → translation string for tooltip
    this.translationCache = new Map();   // caption sentence → translated string (avoid redundant API calls)
    this.activeTooltip = null;
    this.dualSubtitleEl = null;
  }

  async init() {
    if (this.isInitialized) return;
    if (!window.location.pathname.includes('/watch')) return;

    await this.refreshSavedWords();

    // Keep vocabulary cache in sync when words are saved from other sources (e.g. context menu)
    getAdapter().onChanged((changes) => {
      if (changes['vocabulary_list']) this.refreshSavedWords();
    });

    this.startObserving();
    this.isInitialized = true;

    // SPA navigation — YouTube does not do full page reloads between videos
    let lastUrl = location.href;
    this.navObserver = new MutationObserver(() => {
      const url = location.href;
      if (url === lastUrl) return;
      lastUrl = url;
      // Clear per-video state on navigation
      this.translationCache.clear();
      if (this.dualSubtitleEl) { this.dualSubtitleEl.remove(); this.dualSubtitleEl = null; }
      if (url.includes('/watch')) {
        this.startObserving();
      } else {
        this.disconnect();
      }
    });
    this.navObserver.observe(document, { subtree: true, childList: true });
  }

  // Load saved vocabulary from storage into fast-lookup structures
  async refreshSavedWords() {
    const words = (await getAdapter().get('vocabulary_list')) || [];
    this.savedWords = new Set(words.map(w => w.text.toLowerCase()));
    this.savedTranslations = new Map(
      words
        .filter(w => w.aiAnalysis?.translation)
        .map(w => [w.text.toLowerCase(), w.aiAnalysis.translation])
    );
  }

  disconnect() {
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    if (this.navObserver) { this.navObserver.disconnect(); this.navObserver = null; }
    if (this.dualSubtitleEl) { this.dualSubtitleEl.remove(); this.dualSubtitleEl = null; }
    this.isInitialized = false;
  }

  startObserving() {
    if (this.observer) { this.observer.disconnect(); this.observer = null; }

    const container = document.querySelector(this.captionContainerSelector) || document.body;

    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Hide translation when caption segments are removed from the DOM
        if (mutation.removedNodes.length > 0 && this.dualSubtitleEl) {
          if (!document.querySelector(this.captionTextSelector)) {
            this.dualSubtitleEl.style.display = 'none';
          }
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches(this.captionTextSelector)) {
            this.processCaptionSegment(node);
          } else {
            node.querySelectorAll(this.captionTextSelector).forEach(s => this.processCaptionSegment(s));
          }
        }
      }
    });

    this.observer.observe(container, { childList: true, subtree: true });
    // Process any captions already on screen
    document.querySelectorAll(this.captionTextSelector).forEach(s => this.processCaptionSegment(s));
  }

  // Remove leading/trailing punctuation so "world," → "world" before lookup
  cleanWord(raw) {
    return raw.trim().replace(/^[^a-zA-Z\u00C0-\u024F]+|[^a-zA-Z\u00C0-\u024F]+$/g, '');
  }

  processCaptionSegment(segment) {
    if (segment.dataset.processed) return;

    const fullText = segment.textContent;
    segment.innerHTML = '';

    for (const token of fullText.split(/(\s+)/)) {
      // Preserve whitespace tokens as plain text nodes
      if (!token.trim()) {
        segment.appendChild(document.createTextNode(token));
        continue;
      }

      const clean = this.cleanWord(token);
      const isSaved = clean && this.savedWords.has(clean.toLowerCase());

      const span = document.createElement('span');
      span.textContent = token;
      // inline-block needed so position:relative creates a tooltip anchor
      span.style.cssText = 'cursor:pointer;transition:background-color 0.15s;padding:1px 1px;border-radius:3px;position:relative;display:inline-block;';
      // Store cleaned word for event delegation lookup — avoids per-span closure allocations
      if (clean) span.dataset.word = clean;

      // Cyan underline for words already saved to vocabulary
      if (isSaved) {
        span.style.borderBottom = '2px solid #67e8f9';
        span.style.color = '#e0f2fe';
      }

      segment.appendChild(span);
    }

    // 3 delegated listeners on the segment instead of 3N listeners on N spans
    // mouseover/mouseout bubble; check relatedTarget to avoid spurious hide on child transitions
    segment.addEventListener('mouseover', (e) => {
      const span = e.target.closest('span[data-word]');
      if (!span) return;
      span.style.backgroundColor = 'rgba(255,255,255,0.2)';
      this.showTooltip(span, span.dataset.word);
    });
    segment.addEventListener('mouseout', (e) => {
      const span = e.target.closest('span[data-word]');
      if (!span) return;
      // Only clear when the pointer leaves the span entirely (not moving to a child)
      if (!span.contains(e.relatedTarget)) {
        span.style.backgroundColor = '';
        this.hideTooltip();
      }
    });
    segment.addEventListener('click', (e) => {
      const span = e.target.closest('span[data-word]');
      if (!span || !span.dataset.word) return;
      e.stopPropagation();
      e.preventDefault();
      this.handleWordClick(span.dataset.word, fullText);
    });

    segment.dataset.processed = 'true';

    // Fire off dual subtitle translation for this caption line
    this.requestDualSubtitle(fullText);
  }

  showTooltip(span, word) {
    this.hideTooltip();
    const translation = this.savedTranslations.get(word.toLowerCase());
    const tooltip = document.createElement('div');
    tooltip.textContent = translation || 'Click to look up & save';
    tooltip.style.cssText = `
      position:absolute;bottom:130%;left:50%;transform:translateX(-50%);
      background:rgba(15,23,42,0.92);color:${translation ? '#fff' : 'rgba(255,255,255,0.6)'};
      padding:4px 10px;border-radius:6px;font-size:12px;white-space:nowrap;
      z-index:2147483647;pointer-events:none;font-family:-apple-system,sans-serif;
      border-left:3px solid ${translation ? '#22d3ee' : '#64748b'};line-height:1.5;
    `;
    span.appendChild(tooltip);
    this.activeTooltip = tooltip;
  }

  hideTooltip() {
    if (this.activeTooltip) { this.activeTooltip.remove(); this.activeTooltip = null; }
  }

  // Returns false when the extension was reloaded and the context is stale
  isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // Request a sentence-level translation; uses cache to avoid duplicate API calls
  requestDualSubtitle(text) {
    if (this.translationCache.has(text)) {
      this.updateDualSubtitle(this.translationCache.get(text));
      return;
    }
    if (!this.isContextValid()) return;
    try {
      chrome.runtime.sendMessage({ action: 'translateSentence', text }, (res) => {
        if (chrome.runtime.lastError || !res?.translation) return;
        this.translationCache.set(text, res.translation);
        this.updateDualSubtitle(res.translation);
      });
    } catch (err) {
      if (!err.message?.includes('Extension context invalidated'))
        console.error('Language Learning: translateSentence error', err);
    }
  }

  // Renders the translated sentence below the original subtitle line.
  // Uses position:fixed + live getBoundingClientRect so the translation always
  // sits just below wherever YouTube renders its captions (top, middle, or bottom;
  // normal view or fullscreen).
  updateDualSubtitle(translation) {
    // Create the overlay element once and attach to body
    if (!this.dualSubtitleEl) {
      this.dualSubtitleEl = document.createElement('div');
      this.dualSubtitleEl.style.cssText = `
        position:fixed;z-index:2147483646;pointer-events:none;
        text-align:center;color:#fde68a;font-size:14px;
        font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-weight:500;
        text-shadow:0 0 8px rgba(0,0,0,1),0 1px 4px rgba(0,0,0,0.9);
        padding:3px 8px;line-height:1.4;
        transform:translateX(-50%);
      `;
      document.body.appendChild(this.dualSubtitleEl);
    }

    this.dualSubtitleEl.textContent = translation;

    // Measure where the caption segment sits on screen right now and position
    // the translation div just below it, regardless of fullscreen state.
    const segment = document.querySelector(this.captionTextSelector);
    if (segment) {
      const rect = segment.getBoundingClientRect();
      this.dualSubtitleEl.style.top     = (rect.bottom + 4) + 'px';
      this.dualSubtitleEl.style.left    = (rect.left + rect.width / 2) + 'px';
      this.dualSubtitleEl.style.display = 'block';
    } else {
      // No active caption segment — keep hidden until next caption arrives
      this.dualSubtitleEl.style.display = 'none';
    }
  }

  handleWordClick(word, context) {
    if (!this.isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        action: 'lookupAndSave',
        data: { text: word, context, url: window.location.href, title: document.title, timestamp: Date.now() }
      });
    } catch (err) {
      if (!err.message?.includes('Extension context invalidated'))
        console.error('Language Learning: sendMessage failed', err);
    }
  }
}
