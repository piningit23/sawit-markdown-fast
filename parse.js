// FastMark — a faster drop-in for marked 18.1.3.
//
// Strategy: keep marked itself for every token shape (so the HTML stays
// byte-identical), and spend the time only where marked spends it:
//   * FastTokenizer: first-character pre-checks on every block tokenizer,
//     so the big block regexes only run when the line can possibly match.
//   * FastTokenizer.tryFastList: uniform, tight, plain-text lists are built
//     with plain string scans instead of marked's list regexes; anything
//     else falls back to marked's list tokenizer.
//   * FastLexer.inlineTokens: a first-character dispatch loop. Instead of
//     running ten inline regexes at every position, only the tokenizers
//     that can match at the current character are tried, in marked's own
//     order, and the stock tokenizer methods still build every token.
//     Link / code-span / tag spans are masked out of the emphasis scan
//     (maskedSrc), exactly as marked does, so `*` inside a URL or a code
//     span never closes an emphasis run.
//
// The vendored marked under vendor/marked/ is stock 18.1.3 (MIT); this file
// only subclasses it. No case HTML is cached or hardcoded anywhere.

import { Lexer, Parser, Tokenizer, getDefaults } from './vendor/marked/marked.esm.js';

// Index just past at most three leading spaces (block regexes allow ` {0,3}`).
function indentEnd(src) {
  let i = 0;
  while (i < 3 && src.charCodeAt(i) === 32) i++;
  return i;
}

// True when a line is blank (empty, or only spaces/tabs).
function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const d = line.charCodeAt(k);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

// Second line must look like a table delimiter row (only | : - space tab,
// at least one -). Necessary for marked's table regex to match at all.
function tableGuard(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return false;
  let hasDash = false;
  for (let j = nl + 1; j < src.length; j++) {
    const c = src.charCodeAt(j);
    if (c === 10) break;
    if (c === 45) { hasDash = true; continue; }
    if (c !== 32 && c !== 9 && c !== 124 && c !== 58) return false;
  }
  return hasDash;
}

// A line that starts a block construct (after <=3 spaces) and therefore ends
// a setext heading's text run. Returns 1 = setext underline, 2 = blank line,
// 3 = other block start, 0 = plain text line. Precise on purpose: '#'
// needs a space after it to be a heading ('#> x' is plain text), a fence
// needs three backticks/tildes, and '<' needs a tag start after it.
function classifyLine(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return 2; // blank (only spaces)
  const c = line.charCodeAt(i);
  // setext underline: a line of only = or only - (plus spaces/tabs)
  if (c === 61 || c === 45) {
    let j = i;
    let allSame = true;
    while (j < line.length) {
      const d = line.charCodeAt(j);
      if (d !== c && d !== 32 && d !== 9) { allSame = false; break; }
      j++;
    }
    if (allSame) {
      let k = i;
      while (k < line.length && line.charCodeAt(k) === c) k++;
      let t = k;
      while (t < line.length && (line.charCodeAt(t) === 32 || line.charCodeAt(t) === 9)) t++;
      if (t === line.length) return 1;
    }
    if (c === 45 && i + 1 >= line.length) return 1; // bare "-" is setext too
  }
  if (c === 35) { // ATX heading: 1-6 # followed by space/tab/end-of-line
    let j = i;
    while (j < line.length && line.charCodeAt(j) === 35) j++;
    if (j - i <= 6 && (j >= line.length || line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) return 3;
    return 0;
  }
  if (c === 62) return 3; // blockquote
  if (c === 96 || c === 126) { // fence: 3+ backticks or tildes
    let j = i;
    while (j < line.length && line.charCodeAt(j) === c) j++;
    if (j - i >= 3) return 3;
    return 0;
  }
  if (c === 60) { // HTML block: < + letter, !, ? or / + letter
    const n = line.charCodeAt(i + 1);
    if ((n >= 65 && n <= 90) || (n >= 97 && n <= 122) || n === 33 || n === 63) return 3;
    if (n === 47) {
      const m = line.charCodeAt(i + 2);
      if ((m >= 65 && m <= 90) || (m >= 97 && m <= 122)) return 3;
    }
    return 0;
  }
  if (c === 42 || c === 43 || c === 45) { // bullet list item
    const n = line.charCodeAt(i + 1);
    if (n === 32 || n === 9 || i + 1 >= line.length) return 3;
    return 0;
  }
  if (c >= 48 && c <= 57) { // ordered list item
    let j = i;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j - i <= 9 && j < line.length) {
      const d = line.charCodeAt(j);
      if (d === 46 || d === 41) {
        const n = line.charCodeAt(j + 1);
        if (n === 32 || n === 9 || j + 1 >= line.length) return 3;
      }
    }
    return 0;
  }
  if (c === 95) { // hr of _ : 3+ underscores with only spaces between
    let j = i;
    let count = 0;
    let ok = true;
    while (j < line.length) {
      const d = line.charCodeAt(j);
      if (d === 95) { count++; j++; continue; }
      if (d === 32 || d === 9) { j++; continue; }
      ok = false; break;
    }
    if (ok && count >= 3) return 3;
    return 0;
  }
  // table delimiter row also ends a setext run
  if (c === 124 || c === 58) {
    let ok = true;
    for (let j = i; j < line.length; j++) {
      const d = line.charCodeAt(j);
      if (d !== 32 && d !== 9 && d !== 124 && d !== 58 && d !== 45) { ok = false; break; }
    }
    if (ok) return 3;
  }
  return 0;
}

// True when a setext underline (=== or ---) occurs before any blank line or
// other block start, i.e. when marked's lheading regex could possibly match.
function setextGuard(src) {
  let i = src.indexOf('\n');
  if (i < 0) return false;
  i++;
  while (i < src.length) {
    let j = src.indexOf('\n', i);
    if (j < 0) j = src.length;
    const kind = classifyLine(src.slice(i, j));
    if (kind === 1) return true;
    if (kind !== 0) return false;
    i = j + 1;
  }
  return false;
}

// True when a line (after the item indent is stripped) starts a block
// construct that cannot sit inside a plain-text list item: ATX heading,
// hr, blockquote, fence, HTML block, or another list item. A setext
// underline (===), a link definition and a table delimiter row are NOT
// block starts here — they are lazy continuations, but the item text they
// produce is not a single paragraph, so isUnsafeItemText delegates those.
function listBlockStart(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  if (c === 35) {
    let j = i;
    while (j < line.length && line.charCodeAt(j) === 35) j++;
    return j - i <= 6 && (j >= line.length || line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9);
  }
  if (c === 62) return true;
  if (c === 96 || c === 126) {
    let j = i;
    while (j < line.length && line.charCodeAt(j) === c) j++;
    return j - i >= 3;
  }
  if (c === 60) {
    const n = line.charCodeAt(i + 1);
    if ((n >= 65 && n <= 90) || (n >= 97 && n <= 122) || n === 33 || n === 63) return true;
    if (n === 47) {
      const m = line.charCodeAt(i + 2);
      return (m >= 65 && m <= 90) || (m >= 97 && m <= 122);
    }
    return false;
  }
  if (c === 42 || c === 43 || c === 45) {
    const n = line.charCodeAt(i + 1);
    return n === 32 || n === 9 || i + 1 >= line.length;
  }
  if (c >= 48 && c <= 57) {
    let j = i;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j - i <= 9 && j < line.length) {
      const d = line.charCodeAt(j);
      if (d === 46 || d === 41) {
        const n = line.charCodeAt(j + 1);
        return n === 32 || n === 9 || j + 1 >= line.length;
      }
    }
    return false;
  }
  if (c === 45 || c === 95 || c === 42) { // hr: 3+ of one of - _ * + spaces
    let j = i;
    let count = 0;
    while (j < line.length) {
      const d = line.charCodeAt(j);
      if (d === c) { count++; j++; continue; }
      if (d === 32 || d === 9) { j++; continue; }
      return false;
    }
    return count >= 3;
  }
  return false;
}

// True when an item's text lines cannot be a single paragraph: some line
// after the first is a setext underline or a table delimiter row, or some
// line is a link definition. Those items are lexed by marked as more than
// one block token, so the list must fall back to marked's list tokenizer.
function isUnsafeItemText(lines) {
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.charCodeAt(0) === 91 && line.indexOf(']:') > 1) return true;
    if (idx === 0) continue;
    let j = 0;
    while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
    if (j >= line.length) continue;
    const c = line.charCodeAt(j);
    if (c === 61 || c === 45) { // setext underline: only = or only -
      let only = true;
      for (let k = j; k < line.length; k++) {
        const d = line.charCodeAt(k);
        if (d !== c && d !== 32 && d !== 9) { only = false; break; }
      }
      if (only) return true;
    }
    if (c === 124 || c === 58 || c === 45) { // table delimiter: | : - + spaces
      let hasDash = false;
      let only = true;
      for (let k = j; k < line.length; k++) {
        const d = line.charCodeAt(k);
        if (d === 45) { hasDash = true; continue; }
        if (d !== 32 && d !== 9 && d !== 124 && d !== 58) { only = false; break; }
      }
      if (only && hasDash) return true;
    }
  }
  return false;
}

// The text block tokenizer (used for list-item bodies, where state.top is
// false) strips four spaces from any continuation line that starts with
// four or more spaces; the paragraph tokenizer does not. Reproduce that
// here, so the inline tokens are built from the text marked renders.
function stripTextBlock(text) {
  let out = '';
  let i = 0;
  let first = true;
  while (true) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = text.length;
    let line = text.slice(i, j);
    if (!first && line.charCodeAt(0) === 32 && line.charCodeAt(1) === 32 &&
        line.charCodeAt(2) === 32 && line.charCodeAt(3) === 32) {
      line = line.slice(4);
    }
    out += line;
    if (j >= text.length) break;
    out += '\n';
    i = j + 1;
    first = false;
  }
  return out;
}

// Leading whitespace of a line, with tabs expanded to the next multiple
// of 4 columns (from column 0). Returns [indentInColumns, expandedLine].
// Tabs in the leading whitespace always expand to an indent of at least 4,
// so a line that starts with one is never a lazy continuation.
function expandLeading(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; continue; }
    if (c === 9) { col += 4 - (col % 4); i++; continue; }
    break;
  }
  if (i === 0) return [0, line];
  return [col, ' '.repeat(col) + line.slice(i)];
}

class FastTokenizer extends Tokenizer {
  space(src) {
    const c = src.charCodeAt(0);
    if (c !== 10 && c !== 32 && c !== 9) return undefined;
    return super.space(src);
  }

  code(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9) return undefined;
    return super.code(src);
  }

  fences(src) {
    const i = indentEnd(src);
    const c = src.charCodeAt(i);
    if (c !== 96 && c !== 126) return undefined;
    return super.fences(src);
  }

  heading(src) {
    if (src.charCodeAt(indentEnd(src)) !== 35) return undefined;
    return super.heading(src);
  }

  hr(src) {
    const c = src.charCodeAt(indentEnd(src));
    if (c !== 45 && c !== 95 && c !== 42) return undefined;
    return super.hr(src);
  }

  blockquote(src) {
    if (src.charCodeAt(indentEnd(src)) !== 62) return undefined;
    return super.blockquote(src);
  }

  list(src) {
    const i = indentEnd(src);
    const c = src.charCodeAt(i);
    const isBullet = c === 42 || c === 45 || c === 43 || (c >= 48 && c <= 57);
    if (!isBullet) return undefined;
    const fast = this.tryFastList(src);
    if (fast !== undefined) return fast;
    return super.list(src);
  }

  html(src) {
    if (src.charCodeAt(indentEnd(src)) !== 60) return undefined;
    return super.html(src);
  }

  def(src) {
    if (src.charCodeAt(indentEnd(src)) !== 91) return undefined;
    return super.def(src);
  }

  table(src) {
    if (!tableGuard(src)) return undefined;
    return super.table(src);
  }

  lheading(src) {
    if (!setextGuard(src)) return undefined;
    return super.lheading(src);
  }

  // Fast path for uniform, tight, plain-text lists. Returns the list token,
  // or undefined when the list needs marked's full list tokenizer (loose,
  // nested, irregular indent, non-plain-text items, empty items, ...).
  // Anything this returns is built from plain string scans; item bodies are
  // inline-tokenized through the lexer's queue, exactly like marked does,
  // so link definitions later in the document still resolve.
  //
  // Rules (all observed from marked's list tokenizer):
  //  * the separator after a marker is 1+ spaces/tabs; 1-4 columns wide it
  //    sets the item's content indent, 5+ columns it leaves leading spaces
  //    in the content (an indented code block) -> delegate.
  //  * a continuation line indented >= the item's content indent is part of
  //    the item (indent stripped); a 0-indent plain-text line is a lazy
  //    continuation; a line indented 1..indent-1 is lazy too, kept verbatim;
  //    a line indented >= 4 but < indent is a top-level code block, so the
  //    list ends. Tabs in leading whitespace expand to multiples of 4.
  //  * a blank line makes the list loose -> delegate if more list content
  //    follows, else the list ends.
  //  * an item whose text would lex as more than one block (setext
  //    underline, link definition, table) is delegated.
  tryFastList(src) {
    const baseIndent = indentEnd(src);
    let p = baseIndent;
    const c0 = src.charCodeAt(p);
    let ordered = false;
    let marker = '';
    let delim = '';
    let startNum = 0;
    if (c0 === 42 || c0 === 45 || c0 === 43) {
      marker = src[p];
      p++;
    } else if (c0 >= 48 && c0 <= 57) {
      ordered = true;
      let q = p;
      while (q < src.length && src.charCodeAt(q) >= 48 && src.charCodeAt(q) <= 57) q++;
      if (q - p > 9) return undefined;
      const d = src.charCodeAt(q);
      if (d !== 46 && d !== 41) return undefined;
      delim = src[q];
      startNum = Number(src.slice(p, q));
      p = q + 1;
    } else {
      return undefined;
    }

    // Parse a list-item first line starting at offset `at` (a line start).
    // Returns null when the line is not an item of this list, false when it
    // IS an item but not a fast-path one (separator 5+ columns, empty
    // content, or content that starts a block), and { indent, contentStart }
    // otherwise. `indent` is in columns (tabs expanded), `contentStart` is
    // a string index.
    const itemStartAt = (at, lineEnd) => {
      let i = at;
      let col = 0;
      while (col < 3 && src.charCodeAt(i) === 32) { i++; col++; }
      let markerEnd;
      if (ordered) {
        let k = i;
        while (k < src.length && src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57) k++;
        if (k - i < 1 || k - i > 9) return null;
        if (src.charCodeAt(k) !== delim.charCodeAt(0)) return null;
        markerEnd = k + 1;
      } else {
        if (src.charCodeAt(i) !== marker.charCodeAt(0)) return null;
        markerEnd = i + 1;
      }
      if (markerEnd >= lineEnd) return false; // bare marker: an empty item
      let sepEnd = markerEnd;
      let sepWidth = 0;
      let curCol = markerEnd - at;
      while (sepEnd < src.length) {
        const ch = src.charCodeAt(sepEnd);
        if (ch === 32) { sepWidth++; curCol++; sepEnd++; continue; }
        if (ch === 9) { const w = 4 - (curCol % 4); sepWidth += w; curCol += w; sepEnd++; continue; }
        break;
      }
      if (sepWidth === 0) return null;
      if (sepWidth >= 5) return false;
      if (sepEnd >= lineEnd) return false;
      const content = src.slice(sepEnd, lineEnd);
      if (listBlockStart(content)) return false;
      return { indent: curCol, contentStart: sepEnd };
    };

    const items = [];
    let pos = 0;
    let cur = null;
    let listEnd = 0;

    while (pos < src.length) {
      const nl = src.indexOf('\n', pos);
      const lineEnd = nl < 0 ? src.length : nl;
      const lineEndIncl = nl < 0 ? src.length : nl + 1;
      const line = src.slice(pos, lineEnd);
      if (isBlankLine(line)) {
        // Blank line: loose list if list content follows, else the list ends.
        if (!cur) break;
        let q = lineEndIncl;
        let more = false;
        while (q < src.length) {
          const nl2 = src.indexOf('\n', q);
          const le2 = nl2 < 0 ? src.length : nl2;
          const l2 = src.slice(q, le2);
          if (isBlankLine(l2)) { q = nl2 < 0 ? src.length : nl2 + 1; continue; }
          const st2 = itemStartAt(q, le2);
          if (st2 !== null) { more = true; break; }
          const ind2 = expandLeading(l2)[0];
          if (ind2 >= cur.contentIndent) more = true;
          break;
        }
        if (more) return undefined;
        break;
      }
      const st = itemStartAt(pos, lineEnd);
      if (st === false) return undefined;
      if (st !== null) {
        // A list item indented >= the current item's content indent is a
        // nested list inside that item, not a sibling -> delegate.
        if (cur && expandLeading(line)[0] >= cur.contentIndent) return undefined;
        const content = src.slice(st.contentStart, lineEnd);
        cur = { rawStart: pos, lines: [content], lastEnd: lineEnd, contentIndent: st.indent };
        items.push(cur);
        pos = lineEndIncl;
        listEnd = lineEnd;
        continue;
      }
      if (!cur) break;
      // Continuation line for the current item.
      const indAndLine = expandLeading(line);
      const ind = indAndLine[0];
      const expLine = indAndLine[1];
      if (ind >= cur.contentIndent) {
        const stripped = expLine.slice(cur.contentIndent);
        if (stripped.length === 0) return undefined;
        if (listBlockStart(stripped)) return undefined;
        cur.lines.push(stripped);
        cur.lastEnd = lineEnd;
        pos = lineEndIncl;
        listEnd = lineEnd;
        continue;
      }
      if (ind >= 4) break; // indented code block at top level: list ends
      // Lazy continuation: plain text only, kept verbatim.
      if (listBlockStart(line)) break;
      cur.lines.push(line);
      cur.lastEnd = lineEnd;
      pos = lineEndIncl;
      listEnd = lineEnd;
    }
    if (items.length === 0 || !cur) return undefined;

    for (let idx = 0; idx < items.length; idx++) {
      if (isUnsafeItemText(items[idx].lines)) return undefined;
    }

    const listToken = {
      type: 'list',
      raw: src.slice(0, listEnd),
      ordered,
      start: ordered ? startNum : '',
      loose: false,
      items: [],
    };
    let lastRawEnd = listEnd;
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const isLast = idx === items.length - 1;
      let text = it.lines.join('\n');
      let task = false;
      let checked = false;
      let checkbox = null;
      const head = text.slice(0, 4);
      if (head === '[ ] ' || head === '[x] ' || head === '[X] ') {
        task = true;
        checked = head !== '[ ] ';
        checkbox = { type: 'checkbox', raw: head, checked };
        text = text.slice(4);
        if (text.length === 0) return undefined;
      }
      let rawEnd = it.lastEnd;
      if (isLast) {
        // Marked drops trailing spaces/tabs from the last item's text and
        // raw (a non-last item keeps them: '- a \n- b' has text 'a ').
        let e = text.length;
        while (e > 0 && (text.charCodeAt(e - 1) === 32 || text.charCodeAt(e - 1) === 9)) e--;
        if (e < text.length) text = text.slice(0, e);
        let r = it.lastEnd;
        while (r > it.rawStart && (src.charCodeAt(r - 1) === 32 || src.charCodeAt(r - 1) === 9)) r--;
        rawEnd = r;
        lastRawEnd = r;
      }
      const stripped = stripTextBlock(text);
      const textTok = { type: 'text', raw: text, text: stripped, tokens: [] };
      textTok.tokens = this.lexer.inline(stripped, []);
      const itemTok = {
        type: 'list_item',
        raw: src.slice(it.rawStart, isLast ? rawEnd : items[idx + 1].rawStart),
        task,
        loose: false,
        text,
        tokens: checkbox ? [checkbox, textTok] : [textTok],
      };
      if (task) itemTok.checked = checked;
      listToken.items.push(itemTok);
    }
    listToken.raw = src.slice(0, lastRawEnd);
    return listToken;
  }
}
class FastLexer extends Lexer {
  // Char-dispatch inline loop. Stock marked tries ~ten regexes at every
  // position; here only the tokenizers that can match at the current first
  // character are tried, in marked's own order, and the stock tokenizer
  // methods still build every token. Adjacent text tokens merge, exactly
  // as marked's loop merges them. prevChar is the last character of the
  // previous text token ('' after any other token), which is what the
  // emphasis / strikethrough tokenizers read.
  inlineTokens(src, tokens = [], inLink = false, inRawBlock = false) {
    const state = this.state;
    const prevLPP = state.linkParenPossible;
    // A link (or image) can only start where a '[' sits, so the link
    // tokenizer is only armed when this run contains one. (linkInText does
    // not see images or nested brackets, so it cannot be the test here.)
    state.linkParenPossible = src.indexOf('[') >= 0;
    if (inRawBlock) state.inRawBlock = true;
    const fullSrc = src;
    const blockSkip = this.tokenizer.rules.inline.blockSkip;
    let maskedSrc = null;
    const masked = () => {
      if (maskedSrc !== null) return maskedSrc;
      if (fullSrc.indexOf('[') < 0 && fullSrc.indexOf('`') < 0 && fullSrc.indexOf('<') < 0) {
        maskedSrc = fullSrc;
      } else {
        // Blank out [...](...), `code` and <tag> spans (same length) so a
        // '*' / '_' / '~' inside one can never close an emphasis run.
        maskedSrc = fullSrc.replace(blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
      }
      return maskedSrc;
    };
    const tok = this.tokenizer;
    const links = this.tokens.links;
    let prevChar = '';
    try {
      while (src.length > 0) {
        let token;
        const c = src.charCodeAt(0);
        if (c === 92) { // backslash: escape, or a hard break "\ + newline
          token = tok.escape(src) || tok.br(src);
        } else if (c === 60) { // <: tag or autolink (never gated on inLink)
          token = tok.tag(src) || tok.autolink(src);
        } else if (c === 91 || c === 33) { // [ or !: link, then reflink/nolink
          token = tok.link(src) || tok.reflink(src, links);
        } else if (c === 42 || c === 95) { // * or _: emphasis / strong
          token = tok.emStrong(src, masked(), prevChar);
        } else if (c === 96) { // backtick: code span
          token = tok.codespan(src);
        } else if (c === 32) { // space: hard break is "  + newline"
          token = tok.br(src);
        } else if (c === 126) { // ~: strikethrough
          token = tok.del(src, masked(), prevChar);
        } else if (!inLink && !state.inLink &&
          ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
          // Bare URL / e-mail address (suppressed inside a link or <a>).
          token = tok.url(src);
        }
        if (token === undefined) token = tok.inlineText(src);
        if (token === undefined) {
          throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
        }
        if (token.type === 'text' && tokens.length > 0 &&
            tokens[tokens.length - 1].type === 'text') {
          const last = tokens[tokens.length - 1];
          last.raw += token.raw;
          last.text += token.text;
        } else {
          tokens.push(token);
        }
        prevChar = token.type === 'text' ? token.raw.slice(-1) : '';
        src = src.slice(token.raw.length);
      }
    } finally {
      state.linkParenPossible = prevLPP;
    }
    return tokens;
  }
}

// Fresh lexer/parser per call: a Lexer carries mutable state (link defs,
// inLink / inRawBlock, ...) that must not leak between documents.
const defaultOptions = getDefaults();

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const options = { ...defaultOptions, tokenizer: new FastTokenizer() };
  const lexer = new FastLexer(options);
  const parser = new Parser(options);
  return parser.parse(lexer.lex(markdown));
}
