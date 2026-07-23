// renderer/local-dictionary.js
// Offline dictionary (Oxford 5000-derived) for instant first paint while the
// AI analysis loads. Keys are lowercase headwords; values are arrays of senses:
// { pos, cefr, phon, def, ex }

let _dict = null;

/** Fetch and cache the bundled dictionary. Safe to call repeatedly. */
export async function loadLocalDictionary() {
  if (_dict) return _dict;
  try {
    const res = await fetch('./local-dictionary.json');
    _dict = await res.json();
  } catch {
    _dict = {};
  }
  return _dict;
}

/**
 * Look up a word's senses. Tries the exact form first, then the IELTS headword
 * (inflection → base form) when provided, then naive suffix stripping.
 * @param {string} wordText
 * @param {{ headword?: string }|null} ieltsEntry
 * @returns {Array<{pos:string,cefr:string,phon:string,def:string,ex:string}>|null}
 */
export function lookupLocalDef(wordText, ieltsEntry = null) {
  if (!_dict || !wordText) return null;
  const key = wordText.trim().toLowerCase();
  if (_dict[key]) return _dict[key];

  const head = ieltsEntry?.headword?.toLowerCase();
  if (head && _dict[head]) return _dict[head];

  for (const candidate of inflectionCandidates(key)) {
    if (_dict[candidate]) return _dict[candidate];
  }
  return null;
}

/** Cheap inflection guesses: running → run, studies → study, walked → walk … */
export function inflectionCandidates(word) {
  const c = [];
  if (word.endsWith('ies') && word.length > 4) c.push(word.slice(0, -3) + 'y');
  if (word.endsWith('es'))  c.push(word.slice(0, -2));
  if (word.endsWith('s'))   c.push(word.slice(0, -1));
  if (word.endsWith('ing') && word.length > 5) {
    c.push(word.slice(0, -3));            // walking → walk
    c.push(word.slice(0, -3) + 'e');      // making → make
    if (word.length > 6 && word[word.length - 4] === word[word.length - 5]) {
      c.push(word.slice(0, -4));          // running → run
    }
  }
  if (word.endsWith('ed') && word.length > 4) {
    c.push(word.slice(0, -2));            // walked → walk
    c.push(word.slice(0, -1));            // saved → save
    if (word.length > 5 && word[word.length - 3] === word[word.length - 4]) {
      c.push(word.slice(0, -3));          // stopped → stop
    }
  }
  return c;
}
