// FastMark — a faster drop-in for marked 18.1.3.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off, async off), for
// every string. The reference implementation is vendored under
// vendor/marked/ (MIT, MarkedJS) and is used as the fallback for any input
// this fast path declines to handle.
//
// How it works: a fresh, hand-written parser that mirrors marked's two
// phases (block lexing, then inline rendering) but fuses lexing with
// rendering — inline text is rendered straight to HTML instead of being
// materialised as token objects — and skips work it can prove useless:
//  * block tokenizers run only when the next character could start them;
//  * the inline loop dispatches on the current character instead of trying
//    every tokenizer in turn;
//  * the text scan finds the next interesting character in one regex pass;
//  * the emphasis/delimiter masking passes run only when the run contains
//    a delimiter character at all.
// Nothing is cached across calls: parse() computes each case alone, and
// every call starts from fresh state.

import { marked } from './vendor/marked/marked.esm.js';

// A fast parse that gives up: parse() catches this and falls back to the
// vendored marked for the whole input, so a bail can never produce wrong
// HTML — only a slower one.
class Bail extends Error {}
const BAIL = new Bail('fast path declined');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const escChar = (ch) => ESCAPE_MAP[ch];

// Escape HTML the way marked's renderer does. With encode=true every
// &, <, >, ", ' is escaped; otherwise already-valid entities are kept.
function esc(html, encode) {
  if (encode) {
    return escapeTest.test(html) ? html.replace(escapeReplace, escChar) : html;
  }
  return escapeTestNoEncode.test(html) ? html.replace(escapeReplaceNoEncode, escChar) : html;
}

// Decode numeric character references inside inline text (marked's Ie).
// A bare & that is not part of a numeric reference becomes &amp;.
const numericRefTest = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const numericRefOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeRefs(s) {
  if (!numericRefTest.test(s)) return s;
  return s.replace(numericRefOrAmp, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// Strip trailing characters: L(str, ch) removes trailing ch's; with
// invert=true it removes trailing characters that are NOT ch.
function rtrim(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n;) {
    const c = str.charAt(n - s - 1);
    if (c === ch && !invert) s++;
    else if (c !== ch && invert) s++;
    else break;
  }
  return str.slice(0, n - s);
}

// Expand tabs to spaces, tab stops of 4, starting at column `col`.
function expandTabs(s, col = 0) {
  let t = col, out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const r = 4 - (t % 4);
      out += ' '.repeat(r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Drop trailing blank lines of an indented code block, keeping at most
// one trailing blank line (marked's ge).
function stripTrailingBlankLines(a) {
  const lines = a.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? a : lines.slice(0, t + 1).join('\n');
}

// Balanced-paren scan: -1 when neither paren occurs, the index of an
// unmatched close paren, -2 when an open paren is never closed.
function parenBalance(a, pair) {
  if (a.indexOf(pair[0]) === -1 && a.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '\\') { i++; continue; }
    if (a[i] === pair[0]) depth++;
    else if (a[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Normalise a link label the way marked does: trim, collapse whitespace,
// and fold case twice (covers Unicode case folding edge cases).
function normalizeLabel(a) {
  return a.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Fenced-code text: remove the fence line's indentation from every line.
function fenceCodeText(raw, code, rules) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return code;
  const indent = m[1];
  return code.split('\n').map((line) => {
    const o = line.match(/^\s+/);
    if (o === null) return line;
    return line.slice(Math.min(o[0].length, indent.length));
  }).join('\n');
}

// Split a table row into cells (marked's de).
function splitTableRow(a, count) {
  const t = a.replace(/\|/g, (ch, off, str) => {
    let escaped = false, p = off;
    for (; --p >= 0 && str[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Sanitize a link/image href (marked's cleanUrl): encodeURI, keep % as %.
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

// ---------------------------------------------------------------------------
// Rules: marked 18.1.3's GFM block and inline rules, composed exactly as
// marked composes them (same sources, same flags). These are the only way
// to be byte-identical: where marked departs from CommonMark/GFM, marked's
// behaviour is the expected one.
// ---------------------------------------------------------------------------

const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const blockRules = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
  text: /^[^\n]+/,
};

const inlineRules = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

// Other small patterns (marked's rules.other).
const reBlankLine = /^[ \t]*$/;
const reDoubleBlankLine = /\n[ \t]*\n[ \t]*$/;
const reBlockquoteStart = /^ {0,3}>/;
const reBlockquoteSetext = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const reBlockquoteSetext2 = /^ {0,3}>[ \t]?/gm;
const reBlockquoteMarkerWs = /^( {0,3}>)([ \t]+)/gm;
const reListReplaceNesting = /^ {1,4}(?=( {4})*[^ ])/g;
const reListIsTask = /^\[[ xX]\][ \t]+\S/;
const reListReplaceTask = /^\[[ xX]\][ \t]+/;
const reListTaskCheckbox = /\[[ xX]\]/;
const reAnyLine = /\n.*\n/;
const reHrefBrackets = /^<(.*)>$/;
const reTableDelimiter = /[:|]/;
const reTableAlignChars = /^\||\| *$/g;
const reTableRowBlankLine = /\n[ \t]*$/;
const reTableAlignRight = /^ *-+: *$/;
const reTableAlignCenter = /^ *:-+: *$/;
const reTableAlignLeft = /^ *:-+ *$/;
const reStartATag = /^<a /i;
const reEndATag = /^<\/a>/i;
const reStartPreScript = /^<(pre|code|kbd|script)(\s|>)/i;
const reEndPreScript = /^<\/(pre|code|kbd|script)(\s|>)/i;
const reStartAngle = /^</;
const reEndAngle = />$/;
const reEndingHash = /#$/;
const reEndingSpaceTab = /[ \t]$/;
const reNonSpace = /[^ ]/;
const reLeadingSpaceTab = /^[ \t]+/;
const reBeginningSpace = /^\s+/;
const reEndingNewline = /\n$/;
const reNotSpaceStart = /^\S*/;
const reOutputLink = /\\([\[\]])/g;
const reCodeRemoveIndent = /^(?: {0,3}\t| {1,4})/gm;
const reIndentCodeComp = /^(\s+)(?:```)/;
const reUnicodeAlnum = /[\p{L}\p{N}]/u;
const reSpaceLine = /^ +$/gm;
const reTabGlobal = /\t/g;
const reNewlineGlobal = /\n/g;

// Cached factories for the list-item regexes that depend on the indent.
const listItemRegexCache = new Map();
function listItemRegex(bull) {
  let re = listItemRegexCache.get(bull);
  if (!re) {
    re = new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\\n|$))`);
    listItemRegexCache.set(bull, re);
  }
  return re;
}
function cachedRegex(cache, n, make) {
  const k = Math.max(0, Math.min(3, n - 1));
  let re = cache[k];
  if (!re) { re = make(k); cache[k] = re; }
  return re;
}
const nextBulletCache = [];
function nextBulletRegex(n) {
  return cachedRegex(nextBulletCache, n, (a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`));
}
const hrRegexCache = [];
function hrRegex(n) {
  return cachedRegex(hrRegexCache, n, (a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
}
const fencesBeginCache = [];
function fencesBeginRegex(n) {
  return cachedRegex(fencesBeginCache, n, (a) => new RegExp(`^ {0,${a}}(?:\\\`\\\`\\\`|~~~)`));
}
const headingBeginCache = [];
function headingBeginRegex(n) {
  return cachedRegex(headingBeginCache, n, (a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
}
const htmlBeginCache = [];
function htmlBeginRegex(n) {
  return cachedRegex(htmlBeginCache, n, (a) => new RegExp(`^ {0,${a}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
}
const blockquoteBeginCache = [];
function blockquoteBeginRegex(n) {
  return cachedRegex(blockquoteBeginCache, n, (a) => new RegExp(`^ {0,${a}}>`));
}

// ---------------------------------------------------------------------------
// Emphasis masking: before looking for * _ ~ delimiters, marked hides the
// parts of the source that must not take part in emphasis — link brackets,
// code spans and inline HTML — by replacing them with same-length runs of
// 'a' / '+', so every index in the masked source still lines up with the
// original. This only runs when the source contains a delimiter at all.
// ---------------------------------------------------------------------------

function linkInText(src, links) {
  if (!src.includes('[')) return false;
  const linkRe = inlineRules.link;
  for (const m of src.matchAll(inlineRules.blockSkip)) {
    if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(inlineRules.reflinkSearch)) {
    const s = m[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// The mask function itself. `links` is the document's link-reference map
// (null/empty object when there are no definitions).
function maskSrc(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const search = inlineRules.reflinkSearch;
    const replaceOne = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) return '[' + inner.replace(search, replaceOne) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(search, replaceOne);
  }
  t = t.replace(inlineRules.anyPunctuationOutsideCode, (n, s, r) => {
    if (r) return '+'.repeat(n.length);
    if (s) return s + n.slice(s.length, -s.length).replace(/`/g, '+') + s;
    return n;
  });
  t = t.replace(inlineRules.blockSkip, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

// Scan a masked source for the last possible emphasis/del closer of each
// kind: a delimiter run whose preceding character is not whitespace can
// close. Returns { '*': idx, '_': idx, del: idx } with -1 when absent.
function scanClosers(masked) {
  const out = { '*': -1, '_': -1, del: -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') out.del = s;
      else out[r] = s;
    }
    s = i - 1;
  }
  return out;
}

// Does link text contain an unclosed tag/autolink that runs past the end
// of the text? If so the link is invalid (marked's Be).
function linkTextHasUnclosedTag(full, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = inlineRules.code.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = full.slice(offset + s);
    const o = inlineRules.tag.exec(rest) || inlineRules.autolink.exec(rest);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Build a link/image rendering from a link/reflink match (marked's De).
// Returns { html } or null when the link must be dropped (a nested link
// was already emitted inside its text). The label is rendered once, as
// HTML for a link and as plain text for an image's alt attribute; when
// `plain` is set (image alt text) links and images collapse to their
// label's plain text, with the same tokenization side effects.
function makeLink(match, href, title, ctx, plain) {
  const label = match[1].replace(reOutputLink, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = ctx.state.inLink;
  const savedEmitted = ctx.state.linkEmitted;
  const savedRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const inner = renderInlineInner(label, ctx, plain || isImage);
  const nested = ctx.state.linkEmitted;
  ctx.state.linkEmitted = savedEmitted;
  ctx.state.inLink = savedInLink;
  if (!isImage) {
    if (nested) {
      ctx.state.inRawBlock = savedRawBlock;
      return null;
    }
    ctx.state.linkEmitted = true;
    if (plain) return { html: inner };
    const clean = cleanUrl(href);
    if (clean === null) return { html: inner };
    let out = '<a href="' + esc(clean, false) + '"';
    if (title) out += ' title="' + esc(title) + '"';
    return { html: out + '>' + inner + '</a>' };
  }
  if (plain) return { html: inner };
  const clean = cleanUrl(href);
  if (clean === null) return { html: esc(inner) };
  let out = `<img src="${esc(clean)}" alt="${esc(inner)}"`;
  if (title) out += ` title="${esc(title)}"`;
  return { html: out + '>' };
}

// ---------------------------------------------------------------------------
// Inline rendering: marked's inline loop, fused with rendering. The loop
// dispatches on the current character instead of running every tokenizer:
//   \ -> escape, then hard break
//   < -> raw HTML tag, then autolink
//   [ or ! -> link, then reference link
//   * or _ -> emphasis / strong
//   ` -> code span
//   ~ -> strikethrough
//   space -> hard break, then text
//   anything else -> extended autolink (www. / protocol / email), then text
// `plain` renders with marked's text renderer (image alt text): no tags,
// no escaping, links collapse to their label.
// ---------------------------------------------------------------------------

// Public entry for one inline source (marked's Lexer.inlineTokens): the
// link-paren flag is saved and restored around the call, the masking and
// closer scan are computed once, and the loop runs.
function renderInlineInner(src, ctx, plain) {
  const savedLPP = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = savedLPP && src.includes(')');
  try {
    return inlineLoop(src, ctx, plain);
  } finally {
    ctx.state.linkParenPossible = savedLPP;
  }
}

function inlineLoop(src, ctx, plain) {
  // Masking + closer scan: only when the source holds a delimiter.
  let masked = src;
  let closers = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = maskSrc(src, ctx.links);
    closers = scanClosers(masked);
  }
  let out = '';
  let prevChar = '';
  let prevWasText = false;
  let rest = src; // remaining source (substring, like marked)
  let pos = 0; // consumed length == offset into `masked` (same length)
  let guard = src.length + 1; // infinite-loop guard, like marked's
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    const ch = rest[0];
    let consumed = 0; // how much of `rest` the token took
    let html = null; // rendered output for the token, null when none matched

    if (ch === '\\') {
      const m = inlineRules.escape.exec(rest);
      if (m) {
        html = plain ? m[1] : esc(m[1]);
        consumed = m[0].length;
      } else {
        const b = inlineRules.br.exec(rest);
        if (b) { html = plain ? '' : '<br>'; consumed = b[0].length; }
      }
    } else if (ch === '<') {
      const t = tryTag(rest, ctx);
      if (t) { html = plain ? t.text : t.text; consumed = t.raw.length; }
      else {
        const m = inlineRules.autolink.exec(rest);
        if (m) {
          const n = m[1];
          const href = m[2] === '@' ? 'mailto:' + n : n;
          if (plain) {
            html = n;
          } else {
            const clean = cleanUrl(href);
            html = clean === null ? esc(n, true) : `<a href="${esc(clean, true)}">${esc(n, true)}</a>`;
          }
          consumed = m[0].length;
        }
      }
    } else if (ch === '[' || ch === '!') {
      const l = tryLink(rest, ctx, plain);
      if (l) { html = l.html; consumed = l.raw.length; }
      else {
        const r = tryReflink(rest, ctx, plain);
        if (r) {
          if (r.textOnly) {
            html = plain ? r.text : esc(r.text);
            consumed = 1;
            prevChar = r.text;
            prevWasText = true;
            out += html;
            rest = rest.substring(1);
            pos += 1;
            continue;
          }
          html = r.html; consumed = r.raw.length;
        }
      }
    } else if (ch === '*' || ch === '_') {
      const e = tryEmStrong(rest, masked, pos, prevChar, closers, ctx, plain);
      if (e) { html = e.html; consumed = e.raw.length; }
    } else if (ch === '`') {
      const m = inlineRules.code.exec(rest);
      if (m) {
        let n = m[2].replace(reNewlineGlobal, ' ');
        const hasNonSpace = reNonSpace.test(n);
        const wrapped = n.charAt(0) === ' ' && n.charAt(n.length - 1) === ' ';
        if (hasNonSpace && wrapped) n = n.substring(1, n.length - 1);
        html = plain ? n : `<code>${esc(n, true)}</code>`;
        consumed = m[0].length;
      }
    } else if (ch === '~') {
      const d = tryDel(rest, masked, pos, prevChar, closers, ctx, plain);
      if (d) { html = d.html; consumed = d.raw.length; }
    } else if (ch === ' ') {
      const b = inlineRules.br.exec(rest);
      if (b) { html = plain ? '' : '<br>'; consumed = b[0].length; }
    } else if (!ctx.state.inLink) {
      const u = tryUrl(rest, ctx, plain);
      if (u) { html = u.html; consumed = u.raw.length; }
    }

    if (html !== null) {
      out += html;
      rest = rest.substring(consumed);
      pos += consumed;
      continue;
    }

    // Text: one scan of marked's GFM text regex. A failed special token
    // above falls through to here, so a lone `*` or `~` is absorbed into
    // the text run, exactly as in marked.
    const m = inlineRules.text.exec(rest);
    if (m) {
      const raw = m[0];
      if (plain) {
        out += ctx.state.inRawBlock ? raw : decodeRefs(raw);
      } else {
        out += ctx.state.inRawBlock ? raw : esc(decodeRefs(raw));
      }
      if (raw.charAt(raw.length - 1) !== '_') prevChar = raw.charAt(raw.length - 1);
      prevWasText = true;
      rest = rest.substring(raw.length);
      pos += raw.length;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  return out;
}

// Inline HTML tag / comment / processing instruction / CDATA. Updates the
// shared inLink / inRawBlock state exactly as marked's tag tokenizer does.
function tryTag(rest, ctx) {
  const m = inlineRules.tag.exec(rest);
  if (!m) return null;
  const tag = m[0];
  if (!ctx.state.inLink && reStartATag.test(tag)) ctx.state.inLink = true;
  else if (ctx.state.inLink && reEndATag.test(tag)) ctx.state.inLink = false;
  if (!ctx.state.inRawBlock && reStartPreScript.test(tag)) ctx.state.inRawBlock = true;
  else if (ctx.state.inRawBlock && reEndPreScript.test(tag)) ctx.state.inRawBlock = false;
  return { raw: tag, text: tag };
}

// Inline link [label](href "title") (marked's Tokenizer.link).
function tryLink(rest, ctx, plain) {
  if (ctx.state.linkParenPossible === false) return null;
  const m = inlineRules.link.exec(rest);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasUnclosedTag(rest, m[1], bang)) return null;
  let href = m[2].trim();
  if (reStartAngle.test(href)) {
    if (!reEndAngle.test(href)) return null;
    const stripped = rtrim(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(m[2], '()');
    if (bal === -2) return null;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const tailStripped = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - tailStripped.length) % 2 === 0) return null;
  let dest = m[2];
  let title = m[3] ? m[3].slice(1, -1) : '';
  dest = dest.trim();
  if (reStartAngle.test(dest)) dest = dest.slice(1, -1);
  const made = makeLink(m, dest && dest.replace(inlineRules.anyPunctuation, '$1'), title && title.replace(inlineRules.anyPunctuation, '$1'), ctx, plain);
  if (!made) return null;
  return { html: made.html, raw: m[0] };
}

// Reference link [label][ref] / [label][] / [label] (marked's reflink).
// Returns { textOnly } when the reference is not defined: only the first
// character is emitted as text.
function tryReflink(rest, ctx, plain) {
  let m = inlineRules.reflink.exec(rest) || inlineRules.nolink.exec(rest);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasUnclosedTag(rest, m[1], bang)) return null;
  const ref = ctx.links[normalizeLabel(m[2] || m[1])];
  if (!ref) {
    const first = m[0].charAt(0);
    return { textOnly: true, text: first };
  }
  const made = makeLink(m, ref.href, ref.title, ctx, plain);
  if (!made) return null;
  return { html: made.html, raw: m[0] };
}

// Extended autolink: www. / protocol:// / email (marked's url).
function tryUrl(rest, ctx, plain) {
  const m = inlineRules.url.exec(rest);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let t = m[0];
    let prev;
    do {
      prev = t;
      t = inlineRules._backpedal.exec(t)?.[0] ?? '';
    } while (prev !== t);
    text = t;
    href = m[1] === 'www.' ? 'http://' + t : t;
  }
  if (plain) return { html: text, raw: text };
  const clean = cleanUrl(href);
  if (clean === null) return { html: esc(text, true), raw: text };
  return { html: `<a href="${esc(clean, true)}">${esc(text, true)}</a>`, raw: text };
}

// Emphasis / strong emphasis (marked's Tokenizer.emStrong). `rest` is the
// remaining source, `masked` the full masked source, `pos` the offset of
// `rest` inside it, `prev` the previous character, `closers` the last
// possible closer indices. Returns { html, raw } or null.
function tryEmStrong(rest, masked, pos, prev, closers, ctx, plain) {
  const s = inlineRules.emStrongLDelim.exec(rest);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const sameAsPrev = prev === r;
  const i = pos;
  let l = i;
  for (; l > 0 && masked[l - 1] === r;) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!inlineRules.punctuation.exec(p);
  let n = prev;
  if (l < i) n = p;
  const u = l < i ? h : !!inlineRules.punctuation.exec(n);
  if (s[4] && n.match(reUnicodeAlnum)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b;
    let m = k;
    let f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? inlineRules.emStrongRDelimAst : inlineRules.emStrongRDelimUnd;
    const v = closers[r];
    const Q = i + k;
    if (v < Q) return null;
    const rem = masked.slice(pos + k);
    const ee = v - Q;
    let s2;
    for (A.lastIndex = 0; (s2 = A.exec(rem)) !== null && !(s2.index > ee);) {
      g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      b = [...g].length;
      if (s2[3] || s2[4]) { m += b; continue; }
      else if (s2[5] || s2[6] || R) {
        if (sameAsPrev && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...s2[0]][0].length;
      const M = rest.slice(0, k + s2.index + te + b);
      if (Math.min(k, b) % 2) {
        const inner = M.slice(1, -1);
        const html = plain ? renderInlineInner(inner, ctx, plain) : `<em>${renderInlineInner(inner, ctx, plain)}</em>`;
        return { html, raw: M };
      }
      const inner = M.slice(2, -2);
      const html = plain ? renderInlineInner(inner, ctx, plain) : `<strong>${renderInlineInner(inner, ctx, plain)}</strong>`;
      return { html, raw: M };
    }
  }
  return null;
}

// Strikethrough (marked's Tokenizer.del).
function tryDel(rest, masked, pos, prev, closers, ctx, plain) {
  const s = inlineRules.delLDelim.exec(rest);
  if (!s) return null;
  if (!(s[1] || '') || !prev || inlineRules.punctuation.exec(prev)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const h = inlineRules.delRDelim;
    const u = closers.del;
    const d = pos + o;
    if (u < d) return null;
    const rem = masked.slice(pos + o);
    const k = u - d;
    let s2;
    for (h.lastIndex = 0; (s2 = h.exec(rem)) !== null && !(s2.index > k);) {
      const run = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!run) continue;
      let l = [...run].length;
      if (l !== o) continue;
      if (s2[3] || s2[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const g = [...s2[0]][0].length;
      const raw = rest.slice(0, o + s2.index + g + l);
      const inner = raw.slice(o, -o);
      const html = plain ? renderInlineInner(inner, ctx, plain) : `<del>${renderInlineInner(inner, ctx, plain)}</del>`;
      return { html, raw };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block lexing: marked's blockTokens loop, fused with rendering. Block
// nodes are small plain objects; inline sources are kept as strings and
// rendered later (after every link reference definition in the document
// has been collected). `ctx.queue` holds every inline source in lex order
// so the list checkbox pass can find the right one to strip.
// ---------------------------------------------------------------------------

function lexBlocks(src, ctx, mergePara, nodes = []) {
  let e = src;
  let guard = Infinity;
  while (e) {
    if (e.length < guard) guard = e.length;
    else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    const ch = e[0];
    let node = null;

    // space: only when the run starts with space, tab or a newline.
    if ((ch === '\n' || ch === ' ' || ch === '\t') && (node = trySpace(e))) {
      e = e.substring(node.raw.length);
      const prev = nodes.at(-1);
      if (node.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else nodes.push(node);
      continue;
    }
    // indented code: starts with space or tab. Absorbed into a preceding
    // paragraph/text token (it cannot interrupt one).
    if ((ch === ' ' || ch === '\t') && (node = tryCode(e))) {
      e = e.substring(node.raw.length);
      const prev = nodes.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
        prev.src += '\n' + node.text;
        ctx.queue.at(-1).src = prev.src;
      } else nodes.push(node);
      continue;
    }
    // fenced code: starts with space, backtick or tilde.
    if ((ch === ' ' || ch === '`' || ch === '~') && (node = tryFences(e))) {
      e = e.substring(node.raw.length);
      nodes.push(node);
      continue;
    }
    // ATX heading: starts with space or #.
    if ((ch === ' ' || ch === '#') && (node = tryHeading(e, ctx))) {
      e = e.substring(node.raw.length);
      nodes.push(node);
      continue;
    }
    // thematic break: starts with space, -, _ or *.
    if ((ch === ' ' || ch === '-' || ch === '_' || ch === '*') && (node = tryHr(e))) {
      e = e.substring(node.raw.length);
      nodes.push(node);
      continue;
    }
    // blockquote: starts with space or >.
    if ((ch === ' ' || ch === '>') && (node = tryBlockquote(e, ctx))) {
      e = e.substring(node.raw.length);
      nodes.push(node);
      continue;
    }
    // list: starts with space, bullet, or a digit.
    if ((ch === ' ' || ch === '*' || ch === '+' || ch === '-' || (ch >= '0' && ch <= '9')) && (node = tryList(e, ctx))) {
      e = e.substring(node.raw.length);
      nodes.push(node);
      continue;
    }
    // raw HTML block: starts with space or <.
    if ((ch === ' ' || ch === '<') && (node = tryHtml(e))) {
      e = e.substring(node.raw.length);
      nodes.push(node);
      continue;
    }
    // link reference definition: starts with space or [. Absorbed into a
    // preceding paragraph/text token; otherwise recorded in ctx.links.
    if ((ch === ' ' || ch === '[') && (node = tryDef(e))) {
      e = e.substring(node.raw.length);
      const prev = nodes.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
        prev.src += '\n' + node.raw;
        ctx.queue.at(-1).src = prev.src;
      } else {
        if (!Object.hasOwn(ctx.links, node.tag)) ctx.links[node.tag] = { href: node.href, title: node.title };
        nodes.push(node);
      }
      continue;
    }
    // table: the second line must start (after <=3 spaces) with |, : or -.
    if (tableGuard(e) && (node = tryTable(e, ctx))) {
      e = e.substring(node.raw.length);
      nodes.push(node);
      continue;
    }
    // setext heading: the second line must start (after <=3 spaces) with
    // = or -.
    if (lheadingGuard(e) && (node = tryLheading(e, ctx))) {
      e = e.substring(node.raw.length);
      nodes.push(node);
      continue;
    }
    // paragraph, top level only.
    if (ctx.state.top && (node = tryParagraph(e, ctx))) {
      const prev = nodes.at(-1);
      if (mergePara && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
        prev.src += '\n' + node.src;
        ctx.queue.pop();
        ctx.queue.at(-1).src = prev.src;
      } else {
        nodes.push(node);
      }
      mergePara = false;
      e = e.substring(node.raw.length);
      continue;
    }
    // single-line text fallback.
    if ((node = tryText(e, ctx))) {
      e = e.substring(node.raw.length);
      const prev = nodes.at(-1);
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
        prev.src += '\n' + node.src;
        ctx.queue.pop();
        ctx.queue.at(-1).src = prev.src;
      } else {
        nodes.push(node);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
  }
  ctx.state.top = true;
  return nodes;
}

// Cheap pre-check for a table: the delimiter row starts (after at most
// three spaces) with |, : or -.
function tableGuard(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return false;
  let i = nl + 1;
  let spaces = 0;
  while (src[i] === ' ' && spaces < 3) { i++; spaces++; }
  const c = src[i];
  return c === '|' || c === ':' || c === '-';
}

// Cheap pre-check for a setext heading: some line before the next blank
// line is a setext underline (all = or all -, after at most three spaces).
function lheadingGuard(src) {
  let i = src.indexOf('\n');
  if (i < 0) return false;
  const len = src.length;
  while (i < len) {
    i++;
    if (i >= len) return false;
    // blank line ends any setext content
    if (src[i] === '\n') return false;
    let j = i;
    let spaces = 0;
    while (src[j] === ' ' && spaces < 3) { j++; spaces++; }
    const c = src[j];
    if (c === '=' || c === '-') {
      let k = j;
      while (k < len && (src[k] === c || src[k] === ' ' || src[k] === '\t')) k++;
      if (k >= len || src[k] === '\n') return true;
    }
    const nl = src.indexOf('\n', i);
    if (nl < 0) return false;
    i = nl;
  }
  return false;
}

function trySpace(src) {
  const m = blockRules.newline.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  return null;
}

function tryCode(src) {
  const m = blockRules.code.exec(src);
  if (!m) return null;
  const raw = stripTrailingBlankLines(m[0]);
  const text = raw.replace(reCodeRemoveIndent, '');
  return { type: 'code', raw, text };
}

function tryFences(src) {
  const m = blockRules.fences.exec(src);
  if (!m) return null;
  const raw = m[0];
  const text = fenceCodeText(raw, m[3] || '');
  const lang = m[2] ? m[2].trim().replace(inlineRules.anyPunctuation, '$1') : m[2];
  return { type: 'code', raw, lang, text };
}

function tryHeading(src, ctx) {
  const m = blockRules.heading.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (reEndingHash.test(text)) {
    const stripped = rtrim(text, '#');
    if (!stripped || reEndingSpaceTab.test(stripped)) text = stripped.trim();
  }
  const node = { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, src: text };
  ctx.queue.push(node);
  return node;
}

function tryHr(src) {
  const m = blockRules.hr.exec(src);
  if (!m) return null;
  return { type: 'hr', raw: rtrim(m[0], '\n') };
}

function tryLheading(src, ctx) {
  const m = blockRules.lheading.exec(src);
  if (!m) return null;
  const node = { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, src: m[1].trim() };
  ctx.queue.push(node);
  return node;
}

function tryParagraph(src, ctx) {
  const m = blockRules.paragraph.exec(src);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  const node = { type: 'paragraph', raw: m[0], src: text };
  ctx.queue.push(node);
  return node;
}

function tryText(src, ctx) {
  const m = blockRules.text.exec(src);
  if (!m) return null;
  const node = { type: 'text', raw: m[0], src: m[0] };
  ctx.queue.push(node);
  return node;
}

function tryHtml(src) {
  const m = blockRules.html.exec(src);
  if (!m) return null;
  const text = stripTrailingBlankLines(m[0]);
  return { type: 'html', raw: text, text, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' };
}

function tryDef(src) {
  const m = blockRules.def.exec(src);
  if (!m) return null;
  if (!reStartAngle.test(m[2]) && parenBalance(m[2], '()') !== -1) return null;
  const tag = normalizeLabel(m[1]);
  const href = m[2] ? m[2].replace(reHrefBrackets, '$1').replace(inlineRules.anyPunctuation, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(inlineRules.anyPunctuation, '$1') : m[3];
  return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
}

function tryTable(src, ctx) {
  const m = blockRules.table.exec(src);
  if (!m || !reTableDelimiter.test(m[2])) return null;
  const headerCells = splitTableRow(m[1]);
  const alignParts = m[2].replace(reTableAlignChars, '').split('|');
  const body = m[3]?.trim() ? m[3].replace(reTableRowBlankLine, '').split('\n') : [];
  const node = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length !== alignParts.length) return null;
  for (const part of alignParts) {
    node.align.push(reTableAlignRight.test(part) ? 'right' : reTableAlignCenter.test(part) ? 'center' : reTableAlignLeft.test(part) ? 'left' : null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    const cell = { src: headerCells[i], header: true, align: node.align[i] };
    node.header.push(cell);
    ctx.queue.push(cell);
  }
  for (const row of body) {
    node.rows.push(splitTableRow(row, node.header.length).map((text, p) => {
      const cell = { src: text, header: false, align: node.align[p] };
      ctx.queue.push(cell);
      return cell;
    }));
  }
  return node;
}

function tryBlockquote(src, ctx) {
  const m = blockRules.blockquote.exec(src);
  if (!m) return null;
  let lines = rtrim(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const nodes = [];
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (reBlockquoteStart.test(lines[p])) { chunk.push(lines[p]); seenMarker = true; }
      else if (!seenMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h
      .replace(reBlockquoteMarkerWs, (g, b, m2) => b + expandTabs(m2, b.length))
      .replace(reBlockquoteSetext, '\n    $1')
      .replace(reBlockquoteSetext2, '');
    raw = raw ? `${raw}\n${h}` : h;
    text = text ? `${text}\n${u}` : u;
    const savedTop = ctx.state.top;
    ctx.state.top = true;
    lexBlocks(u, ctx, true, nodes);
    ctx.state.top = savedTop;
    if (lines.length === 0) break;
    const k = nodes.at(-1);
    if (k?.type === 'code' || k?.type === 'heading' || k?.type === 'hr' || k?.type === 'html' || k?.type === 'table') break;
    if (k?.type === 'blockquote') {
      const g = k;
      const b = lines.join('\n');
      const mm = g.raw + '\n' + b.replace(reBlockquoteSetext2, '');
      const f = tryBlockquote(mm, ctx);
      nodes[nodes.length - 1] = f;
      const y = mm.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) raw = `${raw}\n${A.join('\n')}`;
      text = text.substring(0, text.length - g.text.length) + f.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && reBlockquoteStart.test(lines[0])) continue;
      break;
    } else if (k?.type === 'list') {
      const g = k;
      const b = g.raw + '\n' + lines.join('\n');
      const mm = tryList(b, ctx);
      nodes[nodes.length - 1] = mm;
      const f = mm.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        raw = `${raw}\n${y}`;
        text = `${text}\n${y}`;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw, nodes, text };
}

function tryList(src, ctx) {
  let t = blockRules.list.exec(src);
  if (!t) return null;
  let e = src;
  const n = src;
  const pos = () => n.length - e.length;
  let r = t[1].trim();
  const ordered = r.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +r.slice(0, -1) : '', loose: false, items: [] };
  r = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const itemRe = listItemRegex(r);
  let p = false;
  while (e) {
    let u = false;
    let d = '';
    if (!(t = itemRe.exec(e)) || blockRules.hr.test(e)) break;
    const k = pos();
    e = e.substring(t[0].length);
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let m = g.replace(reLeadingSpaceTab, (v) => expandTabs(v, b));
    let f = e.split('\n', 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(reNonSpace);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    if (y && reBlankLine.test(f)) {
      e = e.substring(f.length + 1);
      u = true;
    }
    if (!u) {
      const v = nextBulletRegex(R);
      const Q = hrRegex(R);
      const ee = fencesBeginRegex(R);
      const te = headingBeginRegex(R);
      const M = htmlBeginRegex(R);
      const ne = blockquoteBeginRegex(R);
      while (e) {
        const U = e.split('\n', 1)[0];
        let Z;
        f = U;
        Z = f.replace(reLeadingSpaceTab, (me) => expandTabs(me));
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(reNonSpace) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || m.replace(reTabGlobal, '    ').search(reNonSpace) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && blockRules.lheading.test(`${m}\n${f}`) ? `    ${Z.replace(/^ {0,3}/, '')}` : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, pos());
    if (!list.loose) {
      if (p) list.loose = true;
      else if (reDoubleBlankLine.test(A)) p = true;
    }
    list.items.push({ type: 'list_item', raw: A, task: reListIsTask.test(d), loose: false, text: d, nodes: [] });
  }
  const last = list.items.at(-1);
  if (last) {
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
  } else return null;
  list.raw = n.slice(0, pos()).trimEnd();
  for (const item of list.items) {
    ctx.state.top = false;
    item.nodes = lexBlocks(item.text, ctx, false);
    if (!list.loose) {
      const spaces = item.nodes.filter((g) => g.type === 'space');
      list.loose = spaces.length > 0 && spaces.some((g) => reAnyLine.test(g.raw));
    }
  }
  for (const item of list.items) {
    const d = item.nodes[0];
    if (item.task && (d?.type === 'text' || d?.type === 'paragraph')) {
      item.text = item.text.replace(reListReplaceTask, '');
      d.raw = d.raw.replace(reListReplaceTask, '');
      for (let g = ctx.queue.length - 1; g >= 0; g--) {
        if (reListIsTask.test(ctx.queue[g].src)) {
          ctx.queue[g].src = ctx.queue[g].src.replace(reListReplaceTask, '');
          break;
        }
      }
      const ck = reListTaskCheckbox.exec(item.raw);
      if (ck) {
        const boxHtml = `<input ${ck[0] !== '[ ]' ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        if (list.loose) {
          if (d && (d.type === 'paragraph' || d.type === 'text') && 'src' in d) {
            d.prependInline = (d.prependInline || '') + boxHtml;
          } else {
            item.nodes.unshift({ type: 'paragraph', raw: boxHtml, src: '', prependInline: boxHtml });
          }
        } else {
          item.prepend = boxHtml;
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const d of item.nodes) if (d.type === 'text') d.type = 'paragraph';
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Block rendering: marked's Renderer, fused. `ctx` carries the shared
// lexer state (inLink / inRawBlock / linkEmitted) and the link map.
// ---------------------------------------------------------------------------

function renderBlocks(nodes, ctx) {
  let out = '';
  for (const node of nodes) out += renderBlock(node, ctx);
  return out;
}

function renderBlock(node, ctx) {
  switch (node.type) {
    case 'space':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return `<h${node.depth}>${renderInlineInner(node.src, ctx, false)}</h${node.depth}>\n`;
    case 'code': {
      const lang = (node.lang || '').match(reNotSpaceStart)?.[0];
      const text = node.text ? node.text.replace(reEndingNewline, '') + '\n' : '';
      return lang
        ? `<pre><code class="language-${esc(lang)}">${esc(text, true)}</code></pre>\n`
        : `<pre><code>${esc(text, true)}</code></pre>\n`;
    }
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(node.nodes, ctx)}</blockquote>\n`;
    case 'html':
      return node.text;
    case 'def':
      return '';
    case 'paragraph':
      return `<p>${node.prependInline || ''}${renderInlineInner(node.src, ctx, false)}</p>\n`;
    case 'text':
      return `${node.prependInline || ''}${renderInlineInner(node.src, ctx, false)}`;
    case 'table': {
      let head = '';
      for (const cell of node.header) head += renderTableCell(cell, ctx);
      let headRow = `<tr>\n${head}</tr>\n`;
      let body = '';
      for (const row of node.rows) {
        let cells = '';
        for (const cell of row) cells += renderTableCell(cell, ctx);
        body += `<tr>\n${cells}</tr>\n`;
      }
      if (body) body = `<tbody>${body}</tbody>`;
      return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
    }
    case 'list': {
      let items = '';
      for (const item of node.items) items += renderListItem(item, ctx);
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      return `<${tag}${start}>\n${items}</${tag}>\n`;
    }
    default:
      throw new Error('Token with "' + node.type + '" type was not found.');
  }
}

function renderTableCell(cell, ctx) {
  const tag = cell.header ? 'th' : 'td';
  const inner = renderInlineInner(cell.src, ctx, false);
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
}

function renderListItem(item, ctx) {
  const body = renderBlocks(item.nodes, ctx);
  return `<li>${item.prepend || ''}${body}</li>\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  try {
    return fastParse(markdown);
  } catch (err) {
    if (err instanceof Bail) return marked.parse(markdown);
    throw err;
  }
}

function fastParse(src) {
  const ctx = {
    links: Object.create(null),
    queue: [],
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
  };
  const text = src.indexOf('\r') < 0 ? src : src.replace(/\r\n|\r/g, '\n');
  const nodes = lexBlocks(text, ctx, false);
  return renderBlocks(nodes, ctx);
}
