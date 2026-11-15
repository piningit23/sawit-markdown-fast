// Sawit Markdown Fast — parse(markdown) returns exactly the HTML that
// marked 18.1.3 renders with its default options (gfm true, breaks false).
//
// marked's own engine does the rendering (vendor/marked/marked.esm.js, MIT,
// see vendor/marked/LICENSE and NOTICE), but the two hottest paths are
// replaced with hand-written equivalents that produce identical tokens:
//
// 1. FastTokenizer — every block/inline tokenizer method first proves,
//    from the first characters of the remaining source, that its own regex
//    *could* match; when it provably cannot, the method returns without
//    ever running the regex. Each pre-check is a superset of "the regex
//    can match" (verified against marked 18.1.3's rules), so the original
//    method still decides every real match.
// 2. FastLexer.inlineTokens — a char-dispatch inline loop (instead of
//    trying ~10 regexes at every token position) plus a hand-written
//    inline-text scanner that reproduces marked's GFM text regex exactly
//    (same stop positions: special chars, protocol/www autolinks, hard
//    breaks, mailto:/email starts). Emphasis, links, code spans and the
//    other hard tokenizers are still marked's own, called at the same
//    positions with the same masked source, so their output is unchanged.
// 3. FastTokenizer.tryFastList — a uniform list ("- text" / "1. text"
//    lines, no blank lines, plain-text items only) is built directly
//    into the list token instead of re-lexing every item through
//    blockTokens (task items included, via the same checkbox second
//    pass); multi-line items are assembled the item loop's own way
//    (indented continuations dedented, other lines lazy-appended).
//    Anything non-uniform (nested lists, blank lines, continuations
//    that would start a block, setext-looking lines) delegates to
//    marked's own list tokenizer, which still decides every real match.
//
// Deliberately NOT overridden: Tokenizer.emStrong and Tokenizer.del. The
// lexer only builds its masked source when those are the originals, so
// overriding them would force a full masking pass on every inline run.
// The masked source itself is rebuilt here (maskSrc) because the original
// lives in a private method; it follows the same steps.

import { Lexer, Parser, Tokenizer, getDefaults } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------- helpers

const SP = 32; const TAB = 9; const LF = 10;
const BANG = 33; const HASH = 35;
const STAR = 42; const PLUS = 43; const MINUS = 45;
const DOT = 46; const LT = 60; const EQ = 61; const GT = 62;
const LBRACK = 91; const BACKSLASH = 92; const UNDER = 95;
const BTICK = 96; const PIPE = 124; const TILDE = 126;

function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isDigit(c) { return c >= 48 && c <= 57; }

// Email address characters in marked's GFM url rule:
// [a-zA-Z0-9.!#$%&'*+/=?`{|}~-] (note: no underscore, no '@').
const EMAIL_CHARS = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?`{|}~-") {
  EMAIL_CHARS[ch.charCodeAt(0)] = 1;
}
function isEmailChar(c) { return c < 128 && EMAIL_CHARS[c] === 1; }

function lower(code) { return code >= 65 && code <= 90 ? code + 32 : code; }

// src[e..] starts with http://, https:// or ftp:// (any letter case).
function isProtocolAt(src, e) {
  const c = src.charCodeAt(e);
  if (c === 104 || c === 72) { // h
    if (lower(src.charCodeAt(e + 1)) !== 116) return false;
    if (lower(src.charCodeAt(e + 2)) !== 116) return false;
    if (lower(src.charCodeAt(e + 3)) !== 112) return false;
    const c4 = lower(src.charCodeAt(e + 4));
    if (c4 === 115) { // https://
      return src.charCodeAt(e + 5) === 58 && src.charCodeAt(e + 6) === 47 && src.charCodeAt(e + 7) === 47;
    }
    return c4 === 58 && src.charCodeAt(e + 5) === 47 && src.charCodeAt(e + 6) === 47;
  }
  if (c === 102 || c === 70) { // f: ftp://
    return lower(src.charCodeAt(e + 1)) === 116 && lower(src.charCodeAt(e + 2)) === 112
      && src.charCodeAt(e + 3) === 58 && src.charCodeAt(e + 4) === 47 && src.charCodeAt(e + 5) === 47;
  }
  return false;
}

const WS_RE = /\s/;
// src[e..] starts with www. preceded by start, whitespace, *, _, ~ or (.
function isWwwAt(src, e) {
  if (src.charCodeAt(e) !== 119 || src.charCodeAt(e + 1) !== 119
    || src.charCodeAt(e + 2) !== 119 || src.charCodeAt(e + 3) !== DOT) return false;
  if (e === 0) return true;
  const prev = src.charCodeAt(e - 1);
  return prev === STAR || prev === UNDER || prev === TILDE || prev === 40 || WS_RE.test(src[e - 1]);
}

// src[p..] starts with mailto: or xmpp: (lowercase only, as in marked).
function isMailtoAt(src, p) {
  if (src.charCodeAt(p) === 109 // mailto:
    && src.charCodeAt(p + 1) === 97 && src.charCodeAt(p + 2) === 105
    && src.charCodeAt(p + 3) === 108 && src.charCodeAt(p + 4) === 116
    && src.charCodeAt(p + 5) === 111 && src.charCodeAt(p + 6) === 58) return true;
  return src.charCodeAt(p) === 120 // xmpp:
    && src.charCodeAt(p + 1) === 109 && src.charCodeAt(p + 2) === 112
    && src.charCodeAt(p + 3) === 112 && src.charCodeAt(p + 4) === 58;
}

// src[p..] matches [email-chars]+@ : an email address starts here.
function emailRunAt(src, p) {
  let j = p;
  while (isEmailChar(src.charCodeAt(j))) j++;
  return j > p && src.charCodeAt(j) === 64; // '@'
}

// End index (exclusive) of the inline text token starting at `start`,
// reproducing marked's GFM text regex: the token ends at the first
// position where a special char, a protocol/www autolink, a hard break,
// a mailto:/xmpp: or an email address begins (with the consuming
// alternatives including the char before the break/address). Found in
// one native scan: a single regex locates every candidate stop in
// position order, and each candidate is validated the same way marked's
// text regex validates it, so the first valid one ends the token.
const TEXT_STOP_RE = /[\\<!\[`*~_]| {2,}\n|:\/\/|www\.|mailto:|xmpp:|@/g;

function textEnd(src, start) {
  const len = src.length;
  const c0 = src.charCodeAt(start);
  // A lone non-alphanumeric char before mailto:/xmpp: is its own token.
  if (!isAlnum(c0) && isMailtoAt(src, start + 1)) return start + 1;
  let i = start;
  if (c0 === BTICK) {
    do { i++; } while (src.charCodeAt(i) === BTICK);
  } else if (c0 === TILDE) {
    do { i++; } while (src.charCodeAt(i) === TILDE);
  } else {
    i = start + 1;
  }
  if (i >= len) return i;

  TEXT_STOP_RE.lastIndex = i;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const p = m.index;
    const ch = src.charCodeAt(p);
    if (ch === SP) {
      // Hard break: the run of 2+ spaces before \n. The token ends at
      // the run's start (the scan point, if the run started before it).
      return p;
    }
    if (ch === 58) { // ':' of '://': a protocol autolink ends at its start.
      let q = -1;
      if (p >= 4 && isProtocolAt(src, p - 4)) q = p - 4;
      else if (p >= 5 && isProtocolAt(src, p - 5)) q = p - 5;
      else if (p >= 3 && isProtocolAt(src, p - 3)) q = p - 3;
      if (q >= i) return q;
      continue;
    }
    if (ch === 119) { // 'w' of 'www.': needs marked's lookbehind.
      if (p === start || isWwwAt(src, p)) return p;
      continue;
    }
    if (ch === 109 || ch === 120) { // 'm' of 'mailto:' or 'x' of 'xmpp:'
      // The char before it must be the token's first character or at or
      // after the scan point, and non-alphanumeric; a mailto: that starts
      // inside the consumed backtick/tilde run cannot stop the token.
      const e = p - 1;
      if ((e === start || e >= i) && !isAlnum(src.charCodeAt(e))) return p;
      continue;
    }
    if (ch === 64) { // '@': an email address starting at the walk-back.
      let s = p;
      while (s > i && isEmailChar(src.charCodeAt(s - 1))) s--;
      if (s < p) return s;
      continue;
    }
    // A special char ends the token.
    return p;
  }
  return len;
}

// Numeric character references, as in marked's helpers.
const NUMERIC_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeNumericCharacterReferences(text) {
  if (!NUMERIC_REF_RE.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP_RE, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Does this text hold a link already? (marked's Lexer.linkInText.)
function linkInText(lexer, text) {
  if (!text.includes('[')) return false;
  const rules = lexer.tokenizer.rules;
  const linkRule = rules.inline.link;
  for (const match of text.matchAll(rules.inline.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(rules.inline.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!'
      || !Object.hasOwn(lexer.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(lexer, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code, html and escapes so emStrong and del do not see their
// delimiters inside them. (marked's Lexer #maskSrc.)
function maskSrc(lexer, src) {
  const rules = lexer.tokenizer.rules;
  let maskedSrc = src;
  if (lexer.tokens.links && Object.keys(lexer.tokens.links).length > 0 && src.includes('[')) {
    const reflinkSearch = rules.inline.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(lexer.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(lexer, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }
  // anyPunctuationOutsideCode only matches code spans (backticks) and
  // backslash escapes, so it cannot match a run holding neither.
  if (maskedSrc.includes('`') || maskedSrc.includes('\\')) {
    maskedSrc = maskedSrc.replace(rules.inline.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  // blockSkip only matches links, code spans and html, so it cannot match
  // a run holding none of '[', '`' and '<'.
  if (maskedSrc.includes('[') || maskedSrc.includes('`') || maskedSrc.includes('<')) {
    maskedSrc = maskedSrc.replace(rules.inline.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  const hook = lexer.options.hooks?.emStrongMask;
  if (hook) maskedSrc = hook.call({ lexer }, maskedSrc) ?? maskedSrc;
  return maskedSrc;
}

// A list-item line is exactly one text token only when it cannot start
// a non-text block. Anything that could tokenize as a heading, fence,
// blockquote, html block, definition, hr or nested list is excluded, so
// the caller delegates to super.list for it. Up to 3 leading spaces are
// allowed (the block rules allow them); 4+ is indented code.
function listItemContentOk(tok, content) {
  let i = 0;
  while (i < 3 && content.charCodeAt(i) === SP) i++;
  if (content.charCodeAt(i) === SP) return false;
  const c0 = content.charCodeAt(i);
  if (c0 === HASH) return !/^ {0,3}#{1,6}(?:\s|$)/.test(content);
  if (c0 === BTICK || c0 === TILDE) return !/^ {0,3}(`{3,}|~{3,})/.test(content);
  if (c0 === GT) return false;
  if (c0 === LT) return !tok.rules.block.html.test(content);
  if (c0 === LBRACK) return !tok.rules.block.def.test(content);
  if (c0 === MINUS || c0 === STAR || c0 === UNDER || c0 === PLUS || isDigit(c0)) {
    return !tok.rules.block.hr.test(content)
      && !/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(content);
  }
  return true;
}

// A line with its leading spaces/tabs expanded to spaces (columns start
// at 0), as in marked's item loop. Lines without a tab in the leading
// whitespace are returned unchanged.
function expandLeadingWhitespace(rawLine) {
  let i = 0;
  while (i < rawLine.length) {
    const c = rawLine.charCodeAt(i);
    if (c !== SP && c !== TAB) break;
    i++;
  }
  if (i === 0) return rawLine;
  let hasTab = false;
  for (let k = 0; k < i; k++) {
    if (rawLine.charCodeAt(k) === TAB) { hasTab = true; break; }
  }
  if (!hasTab) return rawLine;
  let out = '';
  let col = 0;
  for (let k = 0; k < i; k++) {
    if (rawLine.charCodeAt(k) === TAB) {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ' ';
      col++;
    }
  }
  return out + rawLine.slice(i);
}

// A line that could be a setext heading underline (up to 3 spaces, a run
// of '=' or '-', trailing spaces/tabs, then the line end).
const SETEXT_LINE_RE = /^ {0,3}(?:=+|-+) *$/;

// A line that could be a GFM table delimiter row (the align group of
// marked's table rule, anchored to the line). A header line followed by
// one of these makes the item a table token, not text.
const TABLE_DELIM_RE = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

// ------------------------------------------------------- tokenizer (phase 1)

// First non-space character within the 0-3 leading spaces a block rule
// allows (spaces only; a tab stops the scan). NaN when the source ends.
function firstNonSpace(src) {
  let i = 0;
  while (i < 3 && src.charCodeAt(i) === SP) i++;
  return src.charCodeAt(i);
}

// A GFM table needs its delimiter row on the second line: up to 3 spaces,
// an optional pipe with spaces, an optional colon, then a dash run.
function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return false;
  let i = nl + 1;
  let sp = 0;
  while (sp < 3 && src.charCodeAt(i) === SP) { i++; sp++; }
  if (src.charCodeAt(i) === PIPE) {
    i++;
    while (src.charCodeAt(i) === SP) i++;
  }
  if (src.charCodeAt(i) === 58) i++; // ':'
  return src.charCodeAt(i) === MINUS;
}

// A setext heading needs an underline line (up to 3 spaces, a run of '='
// or '-', trailing spaces/tabs, then a line end) before the first blank
// line, because the heading's text cannot cross a blank line. Scans only
// the current paragraph's lines, so the work is linear in the document.
function lheadingPossible(src) {
  let nl = src.indexOf('\n');
  while (nl !== -1) {
    let i = nl + 1;
    let sp = 0;
    while (sp < 3 && src.charCodeAt(i) === SP) { i++; sp++; }
    const c = src.charCodeAt(i);
    if (c === EQ || c === MINUS) {
      let j = i;
      while (src.charCodeAt(j) === c) j++;
      let k = j;
      while (src.charCodeAt(k) === SP || src.charCodeAt(k) === TAB) k++;
      const nc = src.charCodeAt(k);
      if (nc === LF || Number.isNaN(nc)) return true;
    }
    // Blank line (only spaces/tabs) ends the paragraph: stop here.
    const nextNl = src.indexOf('\n', nl + 1);
    const lineEnd = nextNl === -1 ? src.length : nextNl;
    let blank = true;
    for (let p = nl + 1; p < lineEnd; p++) {
      const cc = src.charCodeAt(p);
      if (cc !== SP && cc !== TAB) { blank = false; break; }
    }
    if (blank) return false;
    nl = nextNl;
  }
  return false;
}

class FastTokenizer extends Tokenizer {
  space(src) {
    const c = src.charCodeAt(0);
    if (c !== SP && c !== TAB && c !== LF) return undefined;
    return super.space(src);
  }

  code(src) {
    let i = 0;
    while (i < 4 && src.charCodeAt(i) === SP) i++;
    if (i !== 4 && src.charCodeAt(i) !== TAB) return undefined;
    return super.code(src);
  }

  fences(src) {
    const c = firstNonSpace(src);
    if (c !== BTICK && c !== TILDE) return undefined;
    return super.fences(src);
  }

  heading(src) {
    if (firstNonSpace(src) !== HASH) return undefined;
    return super.heading(src);
  }

  hr(src) {
    const c = firstNonSpace(src);
    if (c !== MINUS && c !== UNDER && c !== STAR) return undefined;
    return super.hr(src);
  }

  blockquote(src) {
    if (firstNonSpace(src) !== GT) return undefined;
    return super.blockquote(src);
  }

  list(src) {
    const c = firstNonSpace(src);
    if (c !== STAR && c !== PLUS && c !== MINUS && !isDigit(c)) return undefined;
    return this.tryFastList(src) ?? super.list(src);
  }

  // Fast path for a flat uniform list: every item is one or more lines
  // "- text" / "1. text" (same bullet, exactly one space, non-empty
  // plain content), no blank lines, and the line after the last item is
  // one that ends the list (end of source, a fence / heading / html /
  // blockquote / hr begin, or a differently-bulleted list). Continuation
  // lines are the item loop's own: indented lines are dedented by the
  // item's indent, other lines are lazy continuations appended raw.
  // Every item line must be plain text (see listItemContentOk), so each
  // item is exactly one text token — blockTokens merges consecutive text
  // tokens the same way. Anything else returns undefined and the caller
  // falls back to super.list. The token built here has exactly the
  // fields Tokenizer.list produces for such a list (tight, single text
  // token per item, checkbox second pass), including its state.top side
  // effect.
  tryFastList(src) {
    const len = src.length;
    const other = this.rules.other;
    const block = this.rules.block;
    // --- first item line ---
    let p = 0;
    while (p < 3 && src.charCodeAt(p) === SP) p++;
    if (src.charCodeAt(p) === SP) return undefined; // 4+ spaces: indented code
    const b0 = src.charCodeAt(p);
    let ordered = false;
    let delim = 0;
    let num = 0;
    if (b0 === STAR || b0 === PLUS || b0 === MINUS) {
      p++;
    } else if (isDigit(b0)) {
      let q = p;
      while (q < p + 9 && isDigit(src.charCodeAt(q))) q++;
      const d = src.charCodeAt(q);
      if (q === p || (d !== DOT && d !== 41)) return undefined;
      ordered = true;
      delim = d;
      num = Number(src.slice(p, q));
      p = q + 1;
    } else {
      return undefined;
    }
    if (src.charCodeAt(p) !== SP) return undefined;
    const c0 = src.charCodeAt(p + 1);
    if (c0 === SP || c0 === TAB || c0 === LF || Number.isNaN(c0)) return undefined;
    let nl = src.indexOf('\n', p + 1);
    if (nl === -1) nl = len;
    const firstContent = src.slice(p + 1, nl);
    if (!listItemContentOk(this, firstContent)) return undefined;
    const items = [];
    // Current item: start/end offsets into src, assembled text, indent,
    // `line` (the previous line's content after dedent, used by the
    // lazy-continuation checks, exactly as in Tokenizer.list) and
    // `prevLine` (the previous line as it appears in the assembled text,
    // used by the setext check).
    let itemStart = 0;
    let itemEnd = nl === len ? len : nl + 1;
    let itemText = firstContent;
    let indent = p + 1;
    let line = ' ' + firstContent;
    let prevLine = firstContent;
    let pos = itemEnd;
    let ended = false;
    const pushItem = () => items.push({ start: itemStart, end: itemEnd, text: itemText });
    // --- following lines ---
    while (pos < len) {
      const lineStart = pos;
      let lineEnd = src.indexOf('\n', pos);
      if (lineEnd === -1) lineEnd = len;
      const rawLine = src.slice(pos, lineEnd);
      // Blank line (spaces/tabs only): loose/continue logic -> delegate.
      let blank = true;
      for (let k = pos; k < lineEnd; k++) {
        const cc = src.charCodeAt(k);
        if (cc !== SP && cc !== TAB) { blank = false; break; }
      }
      if (blank) return undefined;
      // Leading spaces (0..3; more than 3 is a continuation, not an item).
      let L = 0;
      while (L < 3 && src.charCodeAt(pos + L) === SP) L++;
      if (src.charCodeAt(pos + L) === SP) return undefined;
      // A following line is a new bullet only within the current item's
      // indent (cachedIndentRegex clamps indent - 1 to [0, 3]).
      const maxLead = indent - 1 < 0 ? 0 : indent - 1 > 3 ? 3 : indent - 1;
      const bc = src.charCodeAt(pos + L);
      let isBullet = false;
      let sameBullet = false;
      let bLen = 0;
      if (bc === STAR || bc === PLUS || bc === MINUS) {
        isBullet = true;
        bLen = 1;
        sameBullet = !ordered && bc === b0;
      } else if (isDigit(bc)) {
        let q = pos + L;
        while (q < pos + L + 9 && isDigit(src.charCodeAt(q))) q++;
        const d = src.charCodeAt(q);
        if (q > pos + L && (d === DOT || d === 41)) {
          isBullet = true;
          bLen = q - (pos + L) + 1;
          sameBullet = ordered && d === delim;
        }
      }
      if (isBullet) {
        // A bullet needs a space/tab (or line end) after the marker.
        const after = src.charCodeAt(pos + L + bLen);
        if (after !== SP && after !== TAB && after !== LF && !Number.isNaN(after)) {
          isBullet = false; // e.g. "-foo": a plain line, not a bullet
        }
      }
      if (isBullet) {
        if (L > maxLead) return undefined; // indented bullet: continuation
        if (!sameBullet) { pushItem(); ended = true; break; } // a different list starts
        // Same bullet: an hr line ends the list, anything else is a new
        // item of this list.
        if (block.hr.test(src.slice(lineStart))) { pushItem(); ended = true; break; }
        // New item: must be uniform (one space, non-empty, plain content).
        if (src.charCodeAt(pos + L + bLen) !== SP) return undefined;
        const cc0 = src.charCodeAt(pos + L + bLen + 1);
        if (cc0 === SP || cc0 === TAB || cc0 === LF || Number.isNaN(cc0)) return undefined;
        const content = src.slice(pos + L + bLen + 1, lineEnd);
        if (!listItemContentOk(this, content)) return undefined;
        pushItem();
        itemStart = lineStart;
        itemEnd = lineEnd === len ? len : lineEnd + 1;
        itemText = content;
        indent = L + bLen + 1;
        line = ' ' + content;
        prevLine = content;
        pos = itemEnd;
        continue;
      }
      // Not a bullet line: the list ends on a fence / heading / html /
      // blockquote / hr begin.
      if (other.fencesBeginRegex(indent).test(rawLine)
        || other.headingBeginRegex(indent).test(rawLine)
        || other.htmlBeginRegex(indent).test(rawLine)
        || other.blockquoteBeginRegex(indent).test(rawLine)
        || other.hrRegex(indent).test(rawLine)) {
        pushItem();
        ended = true;
        break;
      }
      // Continuation line of the current item.
      const expanded = expandLeadingWhitespace(rawLine);
      let firstNonSpace = 0;
      while (firstNonSpace < expanded.length && expanded.charCodeAt(firstNonSpace) === SP) firstNonSpace++;
      if (firstNonSpace >= indent) {
        // Indented continuation: dedent by the item's indent.
        const cont = expanded.slice(indent);
        if (!listItemContentOk(this, cont)) return undefined;
        // The assembled text must stay one text token: a setext
        // underline or a table delimiter row would make it a heading
        // or a table instead.
        if (SETEXT_LINE_RE.test(cont) && block.lheading.test(prevLine + '\n' + cont)) return undefined;
        if (TABLE_DELIM_RE.test(cont)) return undefined;
        itemText += '\n' + cont;
        line = cont;
        prevLine = cont;
      } else {
        // Lazy continuation: the previous line must not be indented code
        // or the start of a fence / heading / html / hr block.
        if (line.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4
          || other.fencesBeginRegex(indent).test(line)
          || other.headingBeginRegex(indent).test(line)
          || other.htmlBeginRegex(indent).test(line)
          || other.hrRegex(indent).test(line)) {
          pushItem();
          ended = true;
          break;
        }
        // A lazy continuation that looks like a setext underline after
        // the indent is removed is kept in the paragraph by indenting it
        // as code; that changes the item's tokens, so delegate instead.
        // A table delimiter row would likewise make the item a table.
        if (SETEXT_LINE_RE.test(rawLine) && block.lheading.test(prevLine + '\n' + rawLine)) return undefined;
        if (TABLE_DELIM_RE.test(rawLine)) return undefined;
        if (!listItemContentOk(this, rawLine)) return undefined;
        itemText += '\n' + rawLine;
        line = expanded.slice(indent);
        prevLine = rawLine;
      }
      itemEnd = lineEnd === len ? len : lineEnd + 1;
      pos = itemEnd;
    }
    if (!ended) pushItem();
    // --- build the list token (identical fields to Tokenizer.list) ---
    const consumed = pos;
    const list = {
      type: 'list',
      raw: src.slice(0, consumed).trimEnd(),
      ordered,
      start: ordered ? num : '',
      loose: false,
      items: [],
    };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const last = i === items.length - 1;
      let raw = src.slice(it.start, it.end);
      let text = it.text;
      if (last) { raw = raw.trimEnd(); text = text.trimEnd(); }
      const tokens = this.lexer.inline(text);
      list.items.push({
        type: 'list_item',
        raw,
        task: !!this.options.gfm && other.listIsTask.test(text),
        loose: false,
        text,
        tokens: [{ type: 'text', raw: text, text, tokens }],
      });
    }
    // Second pass: task checkboxes (mirrors Tokenizer.list; the list is
    // tight, so the checkbox is unshifted onto the item's tokens).
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        item.text = item.text.replace(other.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
        itemToken.text = itemToken.text.replace(other.listReplaceTask, '');
        for (let j = this.lexer.inlineQueue.length - 1; j >= 0; j--) {
          if (other.listIsTask.test(this.lexer.inlineQueue[j].src)) {
            this.lexer.inlineQueue[j].src = this.lexer.inlineQueue[j].src.replace(other.listReplaceTask, '');
            break;
          }
        }
        const taskRaw = other.listTaskCheckbox.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = { type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
          item.checked = checkboxToken.checked;
          item.tokens.unshift(checkboxToken);
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    // blockTokens sets state.top back to true after each item's tokens.
    this.lexer.state.top = true;
    return list;
  }

  html(src) {
    if (firstNonSpace(src) !== LT) return undefined;
    return super.html(src);
  }

  def(src) {
    if (firstNonSpace(src) !== LBRACK) return undefined;
    return super.def(src);
  }

  table(src) {
    if (!tablePossible(src)) return undefined;
    return super.table(src);
  }

  lheading(src) {
    if (!lheadingPossible(src)) return undefined;
    return super.lheading(src);
  }

  escape(src) {
    if (src.charCodeAt(0) !== BACKSLASH) return undefined;
    return super.escape(src);
  }

  tag(src) {
    if (src.charCodeAt(0) !== LT) return undefined;
    return super.tag(src);
  }

  link(src) {
    const c0 = src.charCodeAt(0);
    if (c0 !== LBRACK && !(c0 === BANG && src.charCodeAt(1) === LBRACK)) return undefined;
    // An inline link needs "](" after its label.
    if (src.indexOf('](') === -1) return undefined;
    return super.link(src);
  }

  reflink(src, links) {
    const c0 = src.charCodeAt(0);
    if (c0 !== LBRACK && !(c0 === BANG && src.charCodeAt(1) === LBRACK)) return undefined;
    // A reference link needs a closing bracket for its label.
    if (src.indexOf(']') === -1) return undefined;
    return super.reflink(src, links);
  }

  codespan(src) {
    if (src.charCodeAt(0) !== BTICK) return undefined;
    return super.codespan(src);
  }

  br(src) {
    const c = src.charCodeAt(0);
    if (c !== SP && c !== BACKSLASH) return undefined;
    return super.br(src);
  }

  autolink(src) {
    if (src.charCodeAt(0) !== LT) return undefined;
    return super.autolink(src);
  }

  url(src) {
    const c = src.charCodeAt(0);
    const ok = isAlnum(c) || c === UNDER || c === DOT || c === PLUS || c === MINUS;
    if (!ok) return undefined;
    return super.url(src);
  }

  inlineText(src) {
    const end = textEnd(src, 0);
    const raw = src.slice(0, end);
    const escaped = this.lexer.state.inRawBlock;
    return {
      type: 'text',
      raw,
      text: escaped ? raw : decodeNumericCharacterReferences(raw),
      escaped,
    };
  }
}

// ------------------------------------------------------------ inline lexer

class FastLexer extends Lexer {
  inlineTokens(src, tokens = []) {
    // Extensions need the original loop.
    if (this.options.extensions?.inline || this.options.extensions?.startInline) {
      return super.inlineTokens(src, tokens);
    }
    // One paren scan per inline run, shared with Tokenizer.link.
    const prevLinkParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
    try {
      return this.tokenizeInlines(src, tokens);
    } finally {
      this.state.linkParenPossible = prevLinkParenPossible;
    }
  }

  tokenizeInlines(src, tokens) {
    const tok = this.tokenizer;
    // The masked source is only read by emStrong and del.
    const maskedSrc = src.includes('*') || src.includes('_') || src.includes('~')
      || this.options.hooks?.emStrongMask
      || tok.emStrong !== Tokenizer.prototype.emStrong
      || tok.del !== Tokenizer.prototype.del
      ? maskSrc(this, src) : src;

    let keepPrevChar = false;
    let prevChar = '';
    const len = src.length;
    let pos = 0;
    let remaining = Infinity;

    while (pos < len) {
      const left = len - pos;
      if (left < remaining) {
        remaining = left;
      } else {
        const byte = src.charCodeAt(pos);
        if (this.options.silent) {
          console.error('Infinite loop on byte: ' + byte);
        } else {
          throw new Error('Infinite loop on byte: ' + byte);
        }
        break;
      }

      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;

      const rest = src.slice(pos);
      const c = src.charCodeAt(pos);
      let token;

      // Dispatch in marked's own order, gated on the first character so
      // only the tokenizers that could match are ever tried.
      if (c === BACKSLASH) {
        if ((token = tok.escape(rest))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
        if ((token = tok.br(rest))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      } else if (c === LT) {
        if ((token = tok.tag(rest))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
        if ((token = tok.autolink(rest))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      } else if (c === LBRACK || (c === BANG && src.charCodeAt(pos + 1) === LBRACK)) {
        if ((token = tok.link(rest))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
        if ((token = tok.reflink(rest, this.tokens.links))) {
          pos += token.raw.length;
          const lastToken = tokens.at(-1);
          if (token.type === 'text' && lastToken?.type === 'text') {
            lastToken.raw += token.raw;
            lastToken.text += token.text;
          } else {
            tokens.push(token);
          }
          continue;
        }
      } else if (c === STAR || c === UNDER) {
        if ((token = tok.emStrong(rest, maskedSrc, prevChar))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      } else if (c === BTICK) {
        if ((token = tok.codespan(rest))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      } else if (c === SP) {
        if ((token = tok.br(rest))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      } else if (c === TILDE) {
        if ((token = tok.del(rest, maskedSrc, prevChar))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      }

      // Extended autolinks, unless already inside a link.
      if (!this.state.inLink && (isAlnum(c) || c === UNDER || c === DOT || c === PLUS || c === MINUS)) {
        if ((token = tok.url(rest))) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      }

      // Plain text.
      token = tok.inlineText(rest);
      if (token) {
        pos += token.raw.length;
        if (token.raw.slice(-1) !== '_') {
          prevChar = token.raw.slice(-1);
        }
        keepPrevChar = true;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      const byte = src.charCodeAt(pos);
      if (this.options.silent) {
        console.error('Infinite loop on byte: ' + byte);
      } else {
        throw new Error('Infinite loop on byte: ' + byte);
      }
      break;
    }

    return tokens;
  }
}

// ------------------------------------------------------------------- entry

const baseOptions = getDefaults();
const fastTokenizer = new FastTokenizer();

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const options = { ...baseOptions, tokenizer: fastTokenizer };
  const lexer = new FastLexer(options);
  const tokens = lexer.lex(markdown);
  return Parser.parse(tokens, options);
}


