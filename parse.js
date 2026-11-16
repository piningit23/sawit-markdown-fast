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
    return super.link(src);
  }

  reflink(src, links) {
    const c = src.charCodeAt(0);
    if (c !== 91 && !(c === 33 && src.charCodeAt(1) === 91)) return undefined; // [ or ![
    return super.reflink(src, links);
  }

  emStrong(src, maskedSrc, prevChar) {
    const c = src.charCodeAt(0);
    if (c !== 42 && c !== 95) return undefined; // * or _
    return super.emStrong(src, maskedSrc, prevChar);
  }

  codespan(src) {
    if (src.charCodeAt(0) !== 96) return undefined; // backtick
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
    // del needs the masked source as its second argument: it looks for
    // the closing run of tildes in it, so it must be passed through.
    return super.del(src, maskedSrc);
  }

  autolink(src) {
    if (src.charCodeAt(0) !== 60) return undefined; // <
    return super.autolink(src);
  }

  // url and text are deliberately left to marked. url can open an
  // extended autolink (a scheme, a www. host, or a bare address), so no
  // single first character rules it out; text matches anything.

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
