// FastMark — a faster drop-in for marked 18.1.3.
//
// parse(markdown) returns exactly the HTML that marked.parse(markdown)
// returns with marked's default options (GFM on, breaks off, pedantic
// off, async off). It does so by running marked's own Lexer and Parser
// with a Tokenizer that refuses impossible matches before marked's
// regular expressions ever run.
//
// Every fast path below is a *necessary* condition for the rule it
// guards: when the check fails, marked's rule could not have matched
// either, so the tokenizer returns undefined exactly as marked would.
// When the check passes, the rule runs unchanged, through super. So no
// output is ever guessed, nothing is cached across cases, and any input
// the fast paths do not recognise falls through to marked itself.
//
// Why this is faster: marked's inline loop tries about a dozen regular
// expressions at every text position, and its block loop tries about as
// many per block. A one-character compare answers most of those tries
// in the negative, leaving only the one or two expressions that could
// possibly match to run. The saving is largest on the long plain-text
// runs that dominate real documents.

import { Lexer, Parser, Tokenizer } from './vendor/marked/marked.esm.js';

// The options marked uses by default. A fresh object is built for every
// call so the Lexer never mutates state shared between calls.
function freshOptions(tokenizer) {
  return {
    async: false,
    breaks: false,
    gfm: true,
    pedantic: false,
    tokenizer
  };
}

// ---- fast inline text ----
//
// marked's inline loop takes a text run by applying a long lazy
// regular expression. The run always takes at least its first
// character and then stops just before the next position where
// another inline rule could start. This scanner finds that stop
// with one cheap pass instead of the lazy expression, and it is
// safe to stop at MORE places than marked does: the loop merges
// neighbouring text tokens, so a shorter run changes nothing as
// long as no run ever swallows a position where a rule would match.
//
// The stops are found in four independent passes, each of them
// backtracking-free:
//   1. a single regex for the short stops (a rule's first character,
//      a hard-break run of spaces, an http/https/ftp scheme);
//   2. an indexOf scan for '@', walked back over the local part of
//      an address and validated by a dot in its domain;
//   3. an indexOf scan for 'www.', kept only where marked lets an
//      address start (at the start, or after a space, '*', '_', '~'
//      or '(' — 'xwww.y' is plain text, not a link);
//   4. an indexOf scan for 'mailto:'/'xmpp:', kept only after a
//      character that is not a letter or digit.

// Short stops. Every branch is a fixed string or a short character
// class, so the scan cannot backtrack far. The last four branches
// are only candidates: '@' may start a bare email, 'www.' a bare
// address, 'mailto:'/'xmpp:' a bare scheme address. Each candidate
// is checked when the scan reaches it; a rejected candidate resumes
// the scan just after it, so the common case costs one scan.
const SIMPLE_STOP = /[\\<\[_*`~]|!\[| {2,}\n|(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]):\/\/|@|www\.|mailto:|xmpp:/g;

// Is `c` (a character code) a character that can appear in the local
// part of a bare email address, in marked's extended-autolink sense?
function isEmailLocal(c) {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
    c === 42 || c === 43 || c === 45 || c === 46 || c === 47 || c === 61 ||
    c === 63 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126
  ); // ! # $ % & ' * + - . / = ? ` { | } ~
}

function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Where the text run starting at src[0] ends: the first position at
// or after the run's first unit where another inline rule could
// start, or src.length when the run goes to the end. The run always
// takes its first unit whole: a leading run of backticks or tildes,
// or a single character otherwise — exactly as marked's text rule
// does, so a code span is never opened from inside a run of
// backticks the rule already consumed.
function textEnd(src) {
  const len = src.length;
  let from = 1;
  const c0 = src.charCodeAt(0);
  if (c0 === 96 || c0 === 126) {
    while (from < len && src.charCodeAt(from) === c0) from++;
  }
  // One scan for the earliest stop. A hard stop ends the run at
  // once; a candidate is validated and only ends the run when it is
  // a real address start, otherwise the scan resumes just after it.
  // The address checks are deliberately lenient (a superset of the
  // addresses marked would link): an extra stop only costs the loop
  // one more round, while a missed stop would swallow a link.
  SIMPLE_STOP.lastIndex = from;
  let m;
  while ((m = SIMPLE_STOP.exec(src)) !== null) {
    const hit = m[0];
    if (hit === '@') {
      const at = m.index;
      let s = at - 1;
      while (s >= 0 && isEmailLocal(src.charCodeAt(s))) s--;
      const start = s + 1;
      // The domain must hold a dot with at least one character on
      // each side of it before the address ends.
      let dot = -1;
      let j = at + 1;
      while (j < len) {
        const c = src.charCodeAt(j);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60 || c === 62 || c === 91 || c === 93 || c === 40 || c === 41) break;
        if (c === 46 && dot === -1) dot = j;
        j++;
      }
      if (dot !== -1 && dot > at + 1 && dot + 1 < j) {
        const p = start < from ? from : start;
        if (p < at) return p;
      }
      // No local character before this '@' (as in 'a@b@c.d'), or no
      // usable dot in the domain: this '@' gives no stop.
      SIMPLE_STOP.lastIndex = at + 1;
      continue;
    }
    if (hit === 'www.') {
      const w = m.index;
      const prev = src.charCodeAt(w - 1);
      if (prev === 32 || prev === 9 || prev === 10 || prev === 11 || prev === 12 || prev === 13 || prev === 42 || prev === 95 || prev === 126 || prev === 40) {
        return w;
      }
      SIMPLE_STOP.lastIndex = w + 1;
      continue;
    }
    if (hit === 'mailto:' || hit === 'xmpp:') {
      const k = m.index;
      if (!isAlnum(src.charCodeAt(k - 1))) return k;
      SIMPLE_STOP.lastIndex = k + 1;
      continue;
    }
    return m.index;
  }
  return len;
}

// Numeric character references are decoded to the character they
// name; named entities are left alone. A zero, a surrogate, or a
// value above the Unicode range becomes the replacement character.
const NUMERIC_ENTITY = /&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g;

function decodeNumeric(text) {
  if (!text.includes('&#')) return text;
  return text.replace(NUMERIC_ENTITY, (match, dec, hex) => {
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(code);
  });
}

class FastTokenizer extends Tokenizer {
  // ---- inline rules ----
  //
  // Each override looks at the first character (or two) of the
  // remaining source. A rule whose regular expression is anchored at
  // the start can only match when that character can begin it.

  escape(src) {
    if (src.charCodeAt(0) !== 92) return undefined; // backslash
    return super.escape(src);
  }

  tag(src) {
    if (src.charCodeAt(0) !== 60) return undefined; // <
    return super.tag(src);
  }

  link(src) {
    const c = src.charCodeAt(0);
    if (c !== 91 && !(c === 33 && src.charCodeAt(1) === 91)) return undefined; // [ or ![
    // A link's text must close with ']' somewhere.
    if (src.indexOf(']', 1) === -1) return undefined;
    return super.link(src);
  }

  reflink(src, links) {
    const c = src.charCodeAt(0);
    if (c !== 91 && !(c === 33 && src.charCodeAt(1) === 91)) return undefined; // [ or ![
    if (src.indexOf(']', 1) === -1) return undefined;
    return super.reflink(src, links);
  }

  emStrong(src, maskedSrc, prevChar) {
    const c = src.charCodeAt(0);
    if (c !== 42 && c !== 95) return undefined; // * or _
    // Emphasis must close with the same marker somewhere later.
    if (src.indexOf(c === 42 ? '*' : '_', 1) === -1) return undefined;
    return super.emStrong(src, maskedSrc, prevChar);
  }

  codespan(src) {
    if (src.charCodeAt(0) !== 96) return undefined; // backtick
    // A code span must close with another backtick somewhere later.
    if (src.indexOf('`', 1) === -1) return undefined;
    return super.codespan(src);
  }

  br(src) {
    // A hard break is two or more spaces before a newline, or a
    // backslash before a newline; both start with space or backslash.
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 92) return undefined; // space or backslash
    return super.br(src);
  }

  del(src, maskedSrc) {
    if (src.charCodeAt(0) !== 126) return undefined; // ~
    // Strikethrough must close with another tilde somewhere later.
    if (src.indexOf('~', 1) === -1) return undefined;
    // del needs the masked source as its second argument: it looks for
    // the closing run of tildes in it, so it must be passed through.
    return super.del(src, maskedSrc);
  }

  autolink(src) {
    if (src.charCodeAt(0) !== 60) return undefined; // <
    return super.autolink(src);
  }

  // url is left to marked: it can open an extended autolink (a
  // scheme, a www. host, or a bare address), so no single first
  // character rules it out.

  // The text rule itself: take the run up to the next stop, found by
  // the scanner above instead of marked's long lazy expression, with
  // numeric character references decoded in the text exactly as
  // marked's does. The token has exactly the shape marked's returns.
  inlineText(src) {
    if (!src) return undefined;
    const end = textEnd(src);
    const raw = src.slice(0, end);
    return { type: 'text', raw, text: decodeNumeric(raw), escaped: false };
  }

  // ---- block rules ----
  //
  // Same idea at block level: a block rule anchored at the start of the
  // remaining source can only match when the first character can begin
  // it. paragraph and the block text rule are left alone, since any line
  // can start a paragraph.

  space(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 10) return undefined; // space, tab, newline
    return super.space(src);
  }

  code(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9) return undefined; // space or tab (indented code)
    return super.code(src);
  }

  fences(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 96 && c !== 126) return undefined; // space, backtick, tilde
    return super.fences(src);
  }

  heading(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 35) return undefined; // space or #
    return super.heading(src);
  }

  hr(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 42 && c !== 45 && c !== 95) return undefined; // space, *, -, _
    return super.hr(src);
  }

  blockquote(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 62) return undefined; // space or >
    return super.blockquote(src);
  }

  list(src) {
    const c = src.charCodeAt(0);
    // A list opens with a bullet (*, -, +), an ordered marker (a digit),
    // or up to three spaces of indent before one of those.
    if (c !== 32 && c !== 42 && c !== 45 && c !== 43 && (c < 48 || c > 57)) return undefined;
    return super.list(src);
  }

  html(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 60) return undefined; // space or <
    return super.html(src);
  }

  def(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 91) return undefined; // space, tab, newline, [
    return super.def(src);
  }

  table(src) {
    // A table needs a header line and a delimiter line, so it needs a
    // newline in the remaining source; a single line can never be one.
    if (src.indexOf('\n') === -1) return undefined;
    return super.table(src);
  }

  lheading(src) {
    // A setext heading needs its underline on the next line, so it too
    // needs a newline in the remaining source.
    if (src.indexOf('\n') === -1) return undefined;
    return super.lheading(src);
  }
}

// Render one document. A fresh Lexer and Parser are built per call, as
// marked.parse does, so no token state survives between documents.
export function parse(markdown) {
  const tokenizer = new FastTokenizer();
  const options = freshOptions(tokenizer);
  const tokens = new Lexer(options).lex(markdown);
  return new Parser(options).parse(tokens);
}
