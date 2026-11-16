// FastMark — a faster drop-in for marked 18.1.3 (MIT, vendored upstream under
// vendor/marked/). Written from scratch against marked's public behaviour:
// first-char pre-checks in the block loop, a char-dispatch inline loop with a
// single-scan GFM text matcher, a fast path for uniform lists, and mask guards
// that skip work the input cannot need. No case HTML is hardcoded and nothing
// is cached across cases: parse() computes each case alone.
//
// MD-R3-BUILDER-20261116

// ---------------------------------------------------------------------------
// Regex builder: compose a regex from pieces, like marked's edit() helper.
// ---------------------------------------------------------------------------

const caretRx = /(^|[^\[])\^/g;

/** Start building a regex from a string or regex source, with .replace(). */
function rx(source, flags = '') {
  let src = typeof source === 'string' ? source : source.source;
  const api = {
    replace(search, repl) {
      let r = typeof repl === 'string' ? repl : repl.source;
      r = r.replace(caretRx, '$1');
      src = src.replace(search, r);
      return api;
    },
    getRegex() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

// Does this runtime support lookbehind? (Node 22 does.)
const lookbehindSupported = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)x');
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// "other" helper regexes (shared by block and inline rules)
// ---------------------------------------------------------------------------

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // Cached builders for indent-dependent regexes (keyed by indent-1, clamped).
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: makeCached((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: makeCached((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: makeCached((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: makeCached((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: makeCached(
    (n) =>
      new RegExp(
        `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        'i',
      ),
  ),
  blockquoteBeginRegex: makeCached((n) => new RegExp(`^ {0,${n}}>`)),
};

/** Cache helper: fn(indent-1 clamped to 0..3), mirroring marked's cache. */
function makeCached(fn) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = fn(n));
  };
}

// ---------------------------------------------------------------------------
// Block regexes (GFM)
// ---------------------------------------------------------------------------

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_TEXT = /^[^\n]+/;

const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_LIST = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BULLET)
  .getRegex();

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_COMMENT_CLOSED = rx(HTML_COMMENT).replace('(?:-->|$)', '-->').getRegex();

const BLOCK_HTML = rx(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
  'i',
)
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BLOCK_DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

// Setext heading (GFM): same base as normal, but the table alternative is live.
const LHEADING_BASE =
  /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const BLOCK_LHEADING = rx(LHEADING_BASE)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  // NOTE: non-capturing hr here — a capturing group would shift the indices
  // of the text (1) and marker (2) groups.
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

// GFM table.
const BLOCK_TABLE = rx(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
)
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  )
  .replace('tag', BLOCK_TAGS)
  .getRegex();

// GFM paragraph: stops at hr/heading/table/blockquote/fences/list/html starts.
// tablePattern null means the paragraph has no table alternative at all
// (the blockquote paragraph), otherwise it is the table regex to embed.
const PARAGRAPH_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listPattern, tablePattern) {
  const b = rx(PARAGRAPH_BASE)
    .replace('hr', BLOCK_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '');
  if (tablePattern === null) b.replace('|table', '');
  else b.replace('table', tablePattern);
  return b
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listPattern)
    .replace(
      'html',
      ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    )
    .replace('tag', BLOCK_TAGS)
    .getRegex();
}
const BLOCK_PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, BLOCK_TABLE);

// Blockquote body.
const BLOCK_BLOCKQUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace(
  'paragraph',
  buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null),
).getRegex();

const BLOCK = {
  newline: BLOCK_NEWLINE,
  code: BLOCK_CODE,
  fences: BLOCK_FENCES,
  heading: BLOCK_HEADING,
  hr: BLOCK_HR,
  html: BLOCK_HTML,
  def: BLOCK_DEF,
  table: BLOCK_TABLE,
  lheading: BLOCK_LHEADING,
  list: BLOCK_LIST,
  paragraph: BLOCK_PARAGRAPH,
  blockquote: BLOCK_BLOCKQUOTE,
  text: BLOCK_TEXT,
};

// ---------------------------------------------------------------------------
// Inline regexes (GFM, breaks off)
// ---------------------------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM variants: '~' is not punctuation for '*' delimiters (it is del).
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

const SCHEME = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const BARE_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
// Same pattern with a capture group around '@': the url tokenizer tests
// group 2 to tell a bare email (mailto:) from a scheme/www URL.
const BARE_EMAIL_GROUPED = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTOCOL = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, BARE_EMAIL)
  .getRegex();

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const INLINE_TEXT = rx(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
)
  .replace('protocol', SCHEME)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', lookbehindSupported ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

const EM_STRONG_L_DELIM = rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .replace(/punct/g, PUNCT_NOT_TILDE)
  .getRegex();

const EM_STRONG_R_DELIM_AST_SRC =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const EM_STRONG_R_DELIM_AST = rx(EM_STRONG_R_DELIM_AST_SRC, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE)
  .replace(/punctSpace/g, PUNCT_SPACE_NOT_TILDE)
  .replace(/punct/g, PUNCT_NOT_TILDE)
  .getRegex();

const EM_STRONG_R_DELIM_UND_SRC =
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const EM_STRONG_R_DELIM_UND = rx(EM_STRONG_R_DELIM_UND_SRC, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

const DEL_L_DELIM = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .getRegex();
const DEL_R_DELIM_SRC =
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const DEL_R_DELIM = rx(DEL_R_DELIM_SRC, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

const INLINE_AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace(
    'email',
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  )
  .getRegex();

const INLINE_TAG = rx(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
)
  .replace('comment', HTML_COMMENT_CLOSED)
  .replace(
    'attribute',
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  )
  .getRegex();

const BRACKET_LABEL = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', BRACKET_LABEL)
  .getRegex();
const INLINE_LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LINK_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const INLINE_REFLINK = rx(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LINK_LABEL)
  .replace('ref', LABEL)
  .getRegex();
const INLINE_NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL).getRegex();

// Reflink search (used by the em/strong mask): label may hold nested brackets.
const REFLINK_LABEL_LONG = rx(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
)
  .replace('brackets', BRACKET_LABEL)
  .getRegex();
const REFLINK_REF_LONG = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_SEARCH = rx('reflink|nolink(?!\\()', 'g')
  .replace(
    'reflink',
    rx(/^!?\[(label)\]\[(ref)\]/).replace('label', REFLINK_LABEL_LONG).replace('ref', REFLINK_REF_LONG).getRegex(),
  )
  .replace('nolink', rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', REFLINK_REF_LONG).getRegex())
  .getRegex();

const INLINE_URL = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EMAIL_PROTOCOL)
  .replace('protocol', SCHEME)
  .replace('email', BARE_EMAIL_GROUPED)
  .getRegex();
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const INLINE_PUNCTUATION = rx(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_SPACE)
  .getRegex();
const BLOCK_SKIP = rx(/link|precode-code|html/, 'g')
  .replace(
    'link',
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  )
  .replace('precode-', lookbehindSupported ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();
const ANY_PUNCTUATION = rx(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const ANY_PUNCTUATION_OUTSIDE_CODE = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .getRegex();

const INLINE = {
  escape: INLINE_ESCAPE,
  code: INLINE_CODE,
  br: INLINE_BR,
  text: INLINE_TEXT,
  emStrongLDelim: EM_STRONG_L_DELIM,
  emStrongRDelimAst: EM_STRONG_R_DELIM_AST,
  emStrongRDelimUnd: EM_STRONG_R_DELIM_UND,
  delLDelim: DEL_L_DELIM,
  delRDelim: DEL_R_DELIM,
  autolink: INLINE_AUTOLINK,
  tag: INLINE_TAG,
  link: INLINE_LINK,
  reflink: INLINE_REFLINK,
  nolink: INLINE_NOLINK,
  reflinkSearch: REFLINK_SEARCH,
  url: INLINE_URL,
  _backpedal: URL_BACKPEDAL,
  punctuation: INLINE_PUNCTUATION,
  blockSkip: BLOCK_SKIP,
  anyPunctuation: ANY_PUNCTUATION,
  anyPunctuationOutsideCode: ANY_PUNCTUATION_OUTSIDE_CODE,
};

const RULES = { other, block: BLOCK, inline: INLINE };

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text, encode = false) {
  if (encode) {
    return other.escapeTest.test(text) ? text.replace(other.escapeReplace, (c) => HTML_ESCAPES[c]) : text;
  }
  return other.escapeTestNoEncode.test(text)
    ? text.replace(other.escapeReplaceNoEncode, (c) => HTML_ESCAPES[c])
    : text;
}

/** Decode numeric character references; leave unknown entities alone. */
function unescapeHtml(text) {
  if (!other.numericCharacterReference.test(text)) return text;
  return text.replace(other.numericCharacterReferenceOrAmpersand, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
}

/** Split a table row on unescaped pipes, honouring the column count. */
function splitCells(row, count) {
  const marked = row.replace(other.findPipe, (ch, offset, str) => {
    let escaped = false;
    let p = offset;
    for (; --p >= 0 && str[p] === '\\'; ) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(other.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count; ) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  return cells;
}

/** Trim trailing chars: c when invert is false, non-c chars when true. */
function rtrim(str, c, invert = false) {
  const n = str.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n; ) {
    const ch = str.charAt(n - s - 1);
    if (ch === c && !invert) s++;
    else if (ch !== c && invert) s++;
    else break;
  }
  return str.slice(0, n - s);
}

/** Drop trailing blank lines, keeping at most one blank line at the end. */
function trimBlankLines(str) {
  const lines = str.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && other.blankLine.test(lines[t]); ) t--;
  return lines.length - t <= 2 ? str : lines.slice(0, t + 1).join('\n');
}

/** Normalise a link label for lookup (trim, collapse spaces, fold case). */
function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Find the index of the closing bracket matching the opener at depth 0. */
function findClosingBracket(str, brackets) {
  if (str.indexOf(brackets[0]) === -1 && str.indexOf(brackets[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === brackets[0]) depth++;
    else if (str[i] === brackets[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

/** Expand tabs to spaces on 4-column tab stops. */
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/** Scan for the last possible em/strong/del closer in a (masked) source. */
function scanMask(src) {
  const emStrong = { '*': -1, _: -1 };
  let del = -1;
  const n = src.length;
  for (let s = 0; s < n; s++) {
    const ch = src[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : src[s - 1];
    let i = s + 1;
    for (; i < n && src[i] === ch; ) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = s;
      else emStrong[ch] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: src, lastPossibleEmStrongCloserIndex: emStrong, lastPossibleDelCloserIndex: del };
}

// ---------------------------------------------------------------------------
// Link / image token builder (shared by link and reflink)
// ---------------------------------------------------------------------------

function buildLinkToken(match, ref, raw, lexer) {
  const href = ref.href;
  const title = ref.title || null;
  const text = match[1].replace(other.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const prevInLink = lexer.state.inLink;
  const prevEmitted = lexer.state.linkEmitted;
  const prevRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const emitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = prevEmitted;
  lexer.state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      lexer.state.inRawBlock = prevRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

/** Does the link label contain a raw HTML tag / autolink that must win? */
function labelHasLink(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = INLINE.code.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// FastTokenizer: block tokenizers (GFM). The lexer calls these in marked's
// order; the lexer itself pre-checks first characters so most calls never
// happen for plain paragraphs.
// ---------------------------------------------------------------------------

class FastTokenizer {
  constructor() {
    this.rules = RULES;
    this.lexer = null;
    this.maskStack = [];
  }

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (m) {
      const raw = trimBlankLines(m[0]);
      const text = raw.replace(other.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (m) {
      const raw = m[0];
      const text = fixFenceIndent(raw, m[3] || '', this.rules);
      return {
        type: 'code',
        raw,
        lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
        text,
      };
    }
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (other.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
      }
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, tokens: this.lexer.inline(text) };
    }
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: rtrim(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    const lines = rtrim(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (other.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          inQuote = true;
        } else if (!inQuote) {
          chunk.push(lines[p]);
        } else break;
      }
      lines.splice(0, p);
      const joined = chunk.join('\n');
      const cleaned = joined
        .replace(other.blockquoteMarkerWhitespace, (g, b, m2) => b + expandTabs(m2, b.length))
        .replace(other.blockquoteSetextReplace, '\n    $1')
        .replace(other.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${cleaned}` : cleaned;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(cleaned, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (
        last?.type === 'code' ||
        last?.type === 'heading' ||
        last?.type === 'hr' ||
        last?.type === 'html' ||
        last?.type === 'table'
      ) {
        break;
      }
      if (last?.type === 'blockquote') {
        const prev = last;
        const rest = lines.join('\n');
        const reparsed = prev.raw + '\n' + rest.replace(other.blockquoteSetextReplace2, '');
        const next = this.blockquote(reparsed);
        tokens[tokens.length - 1] = next;
        const leftover = reparsed.substring(next.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const taken = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (taken.length > 0) raw = `${raw}\n${taken.join('\n')}`;
        text = text.substring(0, text.length - prev.text.length) + next.text;
        lines.splice(0, taken.length);
        if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const prev = last;
        const combined = prev.raw + '\n' + lines.join('\n');
        const next = this.list(combined);
        tokens[tokens.length - 1] = next;
        const extra =
          next.raw.length > prev.raw.length ? combined.slice(prev.raw.length + 1, next.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${taken}`;
          text = `${text}\n${taken}`;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return undefined;
    const fast = this.tryFastList(src, m);
    if (fast) return fast;
    return this.listFull(src, m);
  }

  // Fast path for uniform lists: every item is one line, indent 0, same
  // bullet, plain-text content. Anything else returns null and the caller
  // runs the full list tokenizer. Returns null (not undefined) on bail.
  tryFastList(src, firstMatch) {
    const bullet = firstMatch[1].trim();
    const ordered = bullet.length > 1;
    const delim = ordered ? bullet.slice(-1) : null;
    const n = src.length;
    const items = [];
    let pos = 0;
    let start = 0;
    let loose = false;
    if (ordered) start = parseInt(bullet.slice(0, -1), 10);

    const bulletLineLooks = (line) => {
      // Same marker followed by space/tab/EOL (possibly indented): the full
      // tokenizer must decide (empty item, tab separator, nested item...).
      if (ordered) return new RegExp(`^ {0,3}\\d{1,9}\\${delim}(?:[ \\t]|$)`).test(line);
      return new RegExp(`^ {0,3}\\${bullet}(?:[ \\t]|$)`).test(line);
    };
    // A line that ends the list in marked's inner loop (fence / heading /
    // html / blockquote / next bullet / hr start, at the current item's R).
    // First-char pre-check: none of these patterns can start with a
    // plain-text character, so a plain line skips all six regexes.
    const endsList = (line, r) => {
      const sp = firstNonSpaceIdx(line);
      if (sp > 3) return false;
      const fc = line.charCodeAt(sp);
      return (
        ((fc === 96 || fc === 126) && other.fencesBeginRegex(r).test(line)) ||
        (fc === 35 && other.headingBeginRegex(r).test(line)) ||
        (fc === 60 && other.htmlBeginRegex(r).test(line)) ||
        (fc === 62 && other.blockquoteBeginRegex(r).test(line)) ||
        ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) &&
          other.nextBulletRegex(r).test(line)) ||
        ((fc === 45 || fc === 95 || fc === 42) && other.hrRegex(r).test(line))
      );
    };

    // Read one strict item line: null when it is not an item line,
    // { other: true } when it is an item with a different bullet/delimiter.
    const readItem = (line) => {
      const m = ordered
        ? /^ {0,3}(\d{1,9})([.)])( {1,4})([^ \t].*)$/.exec(line)
        : /^ {0,3}([*+-])( {1,4})([^ \t].*)$/.exec(line);
      if (!m) return null;
      let indent = 0;
      while (line.charCodeAt(indent) === 32) indent++;
      if (ordered && m[2] !== delim) return { other: true, indent };
      if (!ordered && m[1] !== bullet) return { other: true, indent };
      return {
        indent,
        content: ordered ? m[4] : m[3],
        r: indent + (ordered ? m[1].length + 1 : 1) + (ordered ? m[3].length : m[2].length),
      };
    };
    // Is the line a new item of THIS list (rather than a nested one)?
    // marked's nextBullet rule allows indent up to min(3, R-1) of the
    // previous item; a deeper indent means continuation, not a new item.
    // The same limit decides whether a different-bullet line starts a new
    // list (break) or is a nested list inside the last item (bail).
    const itemLimit = () =>
      items.length === 0 ? 3 : Math.min(3, items.at(-1).r - 1);
    const isNewItem = (it) =>
      it !== null && !it.other && it.indent <= itemLimit();
    const otherIsNewList = (it) =>
      it !== null && it.other && it.indent <= itemLimit();

    while (pos < n) {
      const nl = src.indexOf('\n', pos);
      const lineEnd = nl === -1 ? n : nl;
      const line = src.slice(pos, lineEnd);
      const nextPos = nl === -1 ? n : nl + 1;

      // An hr at an item start ends the list (marked checks it per item).
      // Test the line only: the hr pattern is single-line and anchored.
      if (items.length > 0 && BLOCK.hr.test(line)) break;

      const item = readItem(line);
      if (item && item.other) {
        // Different bullet/delimiter: a new list only when the indent is
        // shallow enough; deeper it is a nested list in the last item.
        if (otherIsNewList(item)) break;
        return null;
      }
      if (item === null) {
        if (line === '' || /^[ \t]*$/.test(line)) {
          // Blank line(s): if another item of this list follows, the list
          // is loose; if nothing else follows, the list simply ends.
          let p = nextPos;
          while (p < n) {
            const nl2 = src.indexOf('\n', p);
            const le2 = nl2 === -1 ? n : nl2;
            const l2 = src.slice(p, le2);
            if (l2 === '' || /^[ \t]*$/.test(l2)) { p = nl2 === -1 ? n : nl2 + 1; continue; }
            break;
          }
          if (p >= n) break;
          const nl2 = src.indexOf('\n', p);
          const l2 = src.slice(p, nl2 === -1 ? n : nl2);
          const next = readItem(l2);
          if (isNewItem(next)) {
            loose = true;
            pos = p;
            continue;
          }
          // Different bullet after the blank: a new list only when the
          // indent is shallow enough; deeper it is a nested list.
          if (next && next.other) {
            if (otherIsNewList(next)) break;
            return null;
          }
          // A block-start line after the blanks ends the list; a plain line
          // does too (the blank already broke the item). Anything else is
          // a nested/continuation shape: let the full algorithm decide.
          if (endsList(l2, items.at(-1).r)) break;
          if (
            l2[0] !== ' ' && l2[0] !== '\t' &&
            !/^ {0,3}(?:=+|-+) *$/.test(l2) &&
            !bulletLineLooks(l2)
          ) break;
          return null;
        }
        if (line[0] === ' ' || line[0] === '\t') return null; // continuation?
        if (/^ {0,3}(?:=+|-+) *$/.test(line)) return null; // setext-looking
        if (bulletLineLooks(line)) return null; // same bullet, odd shape
        // Any other plain line is a lazy continuation of the last item in
        // marked — only a block-start line actually ends the list.
        if (items.length > 0 && endsList(line, items.at(-1).r)) break;
        return null;
      }
      if (!isNewItem(item)) return null; // nested item, not a new one

      let content = item.content;
      // Content must be a single plain-text token, not another block
      // construct.
      const c0 = content[0];
      if (
        (c0 === '#' && BLOCK.heading.test(content)) ||
        ((c0 === '`' || c0 === '~') && BLOCK.fences.test(content)) ||
        (c0 === '>' && BLOCK.blockquote.test(content)) ||
        (c0 === '<' && BLOCK.html.test(content)) ||
        ((c0 === '-' || c0 === '*' || c0 === '_' || c0 === '+') &&
          (BLOCK.hr.test(content) || BLOCK.list.test(content))) ||
        (c0 >= '0' && c0 <= '9' && BLOCK.list.test(content)) ||
        (c0 === '[' && BLOCK.def.test(content))
      ) {
        return null;
      }

      items.push({ start: pos, end: nextPos, content, r: item.r });
      pos = nextPos;
    }

    if (items.length === 0) return null;
    const consumed = pos;
    // An item's raw runs up to the next item's start (so interior blank
    // lines belong to the item, as in marked).
    for (let i = 0; i < items.length - 1; i++) items[i].end = items[i + 1].start;

    const listToken = {
      type: 'list',
      raw: src.slice(0, consumed).trimEnd(),
      ordered,
      start: ordered ? start : '',
      loose,
      items: [],
    };

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const isLast = i === items.length - 1;
      let text = it.content;
      if (isLast) text = text.trimEnd();
      const itemRaw = isLast
        ? src.slice(it.start, it.end).trimEnd()
        : src.slice(it.start, it.end);
      const task = other.listIsTask.test(text);
      let checked;
      let checkbox = null;
      if (task) {
        const k = other.listTaskCheckbox.exec(itemRaw);
        if (k) {
          checkbox = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
          checked = checkbox.checked;
          text = text.replace(other.listReplaceTask, '');
        }
      }
      // A loose list turns each item's text token into a paragraph; a task
      // checkbox moves inside the paragraph (raw/text prefixed with it).
      let tokens;
      if (loose) {
        const para = {
          type: 'paragraph',
          raw: checkbox ? checkbox.raw + text : text,
          text: checkbox ? checkbox.raw + text : text,
          tokens: [],
        };
        if (checkbox) para.tokens.push(checkbox);
        this.lexer.inline(text, para.tokens);
        tokens = [para];
      } else {
        const textToken = { type: 'text', raw: text, text, tokens: [] };
        this.lexer.inline(text, textToken.tokens);
        tokens = checkbox ? [checkbox, textToken] : [textToken];
      }
      listToken.items.push({
        type: 'list_item',
        raw: itemRaw,
        task,
        loose,
        text,
        tokens,
        ...(checked !== undefined ? { checked } : {}),
      });
    }
    return listToken;
  }

  // Full list tokenizer, transcribed from marked's algorithm.
  listFull(src, firstMatch) {
    const whole = src;
    let rest = src;
    const consumed = () => whole.length - rest.length;
    const firstBullet = firstMatch[1].trim();
    const ordered = firstBullet.length > 1;
    const listToken = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +firstBullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    let bullPattern = ordered ? `\\d{1,9}\\${firstBullet.slice(-1)}` : `\\${firstBullet}`;
    const itemRe = other.listItemRegex(bullPattern);
    let sawDoubleBlank = false;
    let m = firstMatch;
    for (; rest; ) {
      let blankSkipped = false;
      let itemText = '';
      if (!(m = itemRe.exec(rest)) || BLOCK.hr.test(rest)) break;
      const itemStart = consumed();
      rest = rest.substring(m[0].length);
      const afterBullet = m[2].split('\n', 1)[0];
      const bulletLen = m[1].length;
      let line = afterBullet.replace(other.leadingSpaceTab, (v) => expandTabs(v, bulletLen));
      const nextLine = rest.split('\n', 1)[0];
      const isEmpty = !line.trim();
      let indent = 0;
      let prevBlank = isEmpty;
      if (isEmpty) {
        indent = bulletLen + 1;
      } else {
        indent = line.search(other.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = line.slice(indent);
        indent += bulletLen;
      }
      if (isEmpty && other.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        blankSkipped = true;
      }
      if (!blankSkipped) {
        const nextBulletRe = other.nextBulletRegex(indent);
        const hrRe = other.hrRegex(indent);
        const fencesRe = other.fencesBeginRegex(indent);
        const headingRe = other.headingBeginRegex(indent);
        const htmlRe = other.htmlBeginRegex(indent);
        const quoteRe = other.blockquoteBeginRegex(indent);
        for (; rest; ) {
          const curLine = rest.split('\n', 1)[0];
          let expanded;
          // First-char pre-check: every break pattern starts with one of
          // ` ~ # < > * + - digit, after at most 3 spaces. A plain-text
          // line cannot break the item, so skip all six regexes for it.
          const sp = firstNonSpaceIdx(curLine);
          const fc = curLine.charCodeAt(sp);
          if (
            sp <= 3 &&
            (((fc === 96 || fc === 126) && fencesRe.test(curLine)) ||
              (fc === 35 && headingRe.test(curLine)) ||
              (fc === 60 && htmlRe.test(curLine)) ||
              (fc === 62 && quoteRe.test(curLine)) ||
              ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) &&
                nextBulletRe.test(curLine)) ||
              ((fc === 45 || fc === 95 || fc === 42) && hrRe.test(curLine)))
          ) {
            break;
          }
          expanded = curLine.replace(other.leadingSpaceTab, (v) => expandTabs(v));
          if (expanded.search(other.nonSpaceChar) >= indent || !curLine.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            const lsp = firstNonSpaceIdx(line);
            const lfc = line.charCodeAt(lsp);
            if (
              prevBlank ||
              line.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4 ||
              (lsp <= 3 &&
                (((lfc === 96 || lfc === 126) && fencesRe.test(line)) ||
                  (lfc === 35 && headingRe.test(line)) ||
                  (lfc === 60 && htmlRe.test(line)) ||
                  ((lfc === 45 || lfc === 95 || lfc === 42) && hrRe.test(line))))
            ) {
              break;
            }
            const setext =
              /^ {0,3}(?:=+|-+) *$/.test(curLine) && BLOCK.lheading.test(`${line}\n${curLine}`)
                ? `    ${expanded.replace(/^ {0,3}/, '')}`
                : curLine;
            itemText += '\n' + setext;
          }
          prevBlank = !curLine.trim();
          rest = rest.substring(curLine.length + 1);
          line = expanded.slice(indent);
        }
      }
      const itemRaw = whole.slice(itemStart, consumed());
      if (!listToken.loose) {
        if (sawDoubleBlank) listToken.loose = true;
        else if (other.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
      }
      listToken.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: !!other.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const last = listToken.items.at(-1);
    if (!last) return undefined;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    listToken.raw = whole.slice(0, consumed()).trimEnd();

    for (const item of listToken.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listToken.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => other.anyLine.test(t.raw))) listToken.loose = true;
      }
    }
    for (const item of listToken.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(other.listReplaceTask, '');
        first.raw = first.raw.replace(other.listReplaceTask, '');
        first.text = first.text.replace(other.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(other.listReplaceTask, '');
            break;
          }
        }
        const k = other.listTaskCheckbox.exec(item.raw);
        if (k) {
          const box = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
          item.checked = box.checked;
          if (listToken.loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listToken.loose) {
      for (const item of listToken.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return listToken;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (m) {
      const raw = trimBlankLines(m[0]);
      return {
        type: 'html',
        block: true,
        raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text: raw,
      };
    }
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (m) {
      if (!other.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return undefined;
      const tag = normalizeLabel(m[1]);
      const href = m[2] ? m[2].replace(other.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
      const title = m[3]
        ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1')
        : m[3];
      return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
    }
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !other.tableDelimiter.test(m[2])) return undefined;
    const headerCells = splitCells(m[1]);
    const aligns = m[2].replace(other.tableAlignChars, '').split('|');
    const bodyRows = m[3]?.trim() ? m[3].replace(other.tableRowBlankLine, '').split('\n') : [];
    const tableToken = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length === aligns.length) {
      for (const a of aligns) {
        if (other.tableAlignRight.test(a)) tableToken.align.push('right');
        else if (other.tableAlignCenter.test(a)) tableToken.align.push('center');
        else if (other.tableAlignLeft.test(a)) tableToken.align.push('left');
        else tableToken.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        tableToken.header.push({
          text: headerCells[i],
          tokens: this.lexer.inline(headerCells[i]),
          header: true,
          align: tableToken.align[i],
        });
      }
      for (const row of bodyRows) {
        tableToken.rows.push(
          splitCells(row, tableToken.header.length).map((cell, i) => ({
            text: cell,
            tokens: this.lexer.inline(cell),
            header: false,
            align: tableToken.align[i],
          })),
        );
      }
      return tableToken;
    }
  }

  lheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return {
        type: 'heading',
        raw: rtrim(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }

  // ---------------------------------------------------------------
  // Inline tokenizers
  // ---------------------------------------------------------------

  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  }

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (m) {
      if (!this.lexer.state.inLink && other.startATag.test(m[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && other.endATag.test(m[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && other.startPreScriptTag.test(m[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (this.lexer.state.inRawBlock && other.endPreScriptTag.test(m[0])) {
        this.lexer.state.inRawBlock = false;
      }
      return {
        type: 'html',
        raw: m[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false,
        text: m[0],
      };
    }
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return undefined;
    const m = INLINE.link.exec(src);
    if (!m) return undefined;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasLink(src, m[1], bang)) return undefined;
    let href = m[2].trim();
    if (other.startAngleBracket.test(href)) {
      if (!other.endAngleBracket.test(href)) return undefined;
      const trimmed = rtrim(href.slice(0, -1), '\\');
      if ((href.length - trimmed.length) % 2 === 0) return undefined;
    } else {
      const close = findClosingBracket(m[2], '()');
      if (close === -2) return undefined;
      if (close > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const stripped = rtrim(m[0].slice(0, -1), '\\');
    if ((m[0].length - stripped.length) % 2 === 0) return undefined;
    let title = '';
    if (m[3]) title = m[3].slice(1, -1);
    href = m[2].trim();
    if (other.startAngleBracket.test(href)) href = href.slice(1, -1);
    return buildLinkToken(
      m,
      {
        href: href && href.replace(INLINE.anyPunctuation, '$1'),
        title: title && title.replace(INLINE.anyPunctuation, '$1'),
      },
      m[0],
      this.lexer,
    );
  }

  reflink(src, links) {
    let m;
    if ((m = INLINE.reflink.exec(src)) || (m = INLINE.nolink.exec(src))) {
      const bang = m[0].charAt(0) === '!' ? 2 : 1;
      if (labelHasLink(src, m[1], bang)) return undefined;
      const ref = links[normalizeLabel(m[2] || m[1])];
      if (!ref) {
        const ch = m[0].charAt(0);
        return { type: 'text', raw: ch, text: ch };
      }
      return buildLinkToken(m, ref, m[0], this.lexer);
    }
  }

  emStrong(src, maskedSrc, prevChar = '') {
    const m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const delim = m[0][0];
    const prevIsSame = prevChar === delim;
    const offset = maskedSrc.length - src.length;
    let scan = offset;
    while (scan > 0 && maskedSrc[scan - 1] === delim) scan--;
    const before = [...maskedSrc.slice(Math.max(0, scan - 2), scan)].at(-1) ?? '';
    const beforeIsDelimOrPunct =
      before === '*' || before === '_' || !!INLINE.punctuation.exec(before);
    if (scan < offset) prevChar = before;
    const prevIsPunct = scan < offset ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prevChar);
    if (m[4] && prevChar.match(other.unicodeAlphaNumeric)) return undefined;
    const opener = m[1] || m[3] || '';
    if (!opener || !prevChar || prevIsPunct) {
      const openLen = [...m[0]].length - 1;
      let extra = 0;
      let used = openLen;
      const span = offset - scan + openLen;
      const canOpen =
        !!before.trim() && (!!opener || (delim === '*' && !beforeIsDelimOrPunct));
      if (delim !== '*' && delim !== '_') return undefined;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lexer.lastEmStrongCloser(maskedSrc, delim);
      const limit = maskedSrc.length - src.length + openLen;
      if (lastCloser < limit) return undefined;
      const rest = maskedSrc.slice(-1 * src.length + openLen);
      const maxIndex = lastCloser - limit;
      let closer;
      for (closerRe.lastIndex = 0; (closer = closerRe.exec(rest)) !== null && !(closer.index > maxIndex); ) {
        const run = closer[1] || closer[2] || closer[3] || closer[4] || closer[5] || closer[6];
        if (!run) continue;
        const runLen = [...run].length;
        if (closer[3] || closer[4]) {
          used += runLen;
          continue;
        } else if (closer[5] || closer[6] || canOpen) {
          if (prevIsSame && (closer[5] || closer[6])) break;
          if (span % 3 && !((span + runLen) % 3)) {
            extra += runLen;
            continue;
          }
        }
        if ((used -= runLen) > 0) continue;
        const take = Math.min(runLen, runLen + used + extra);
        const firstLen = [...closer[0]][0].length;
        const raw = src.slice(0, openLen + closer.index + firstLen + take);
        if (Math.min(openLen, take) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (m) {
      let text = m[2].replace(other.newLineCharGlobal, ' ');
      const hasNonSpace = other.nonSpaceChar.test(text);
      const padded = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
  }

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  }

  del(src, maskedSrc, prevChar = '') {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return undefined;
    if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const openLen = [...m[0]].length - 1;
      let left = openLen;
      const closerRe = INLINE.delRDelim;
      const lastCloser = this.lexer.lastDelCloser(maskedSrc);
      const limit = maskedSrc.length - src.length + openLen;
      if (lastCloser < limit) return undefined;
      const rest = maskedSrc.slice(-1 * src.length + openLen);
      const maxIndex = lastCloser - limit;
      let closer;
      for (closerRe.lastIndex = 0; (closer = closerRe.exec(rest)) !== null && !(closer.index > maxIndex); ) {
        const run = closer[1] || closer[2] || closer[3] || closer[4] || closer[5] || closer[6];
        if (!run) continue;
        const runLen = [...run].length;
        if (runLen !== openLen) continue;
        if (closer[3] || closer[4]) {
          left += runLen;
          continue;
        }
        if ((left -= runLen) > 0) continue;
        const take = Math.min(runLen, runLen + left);
        const firstLen = [...closer[0]][0].length;
        const raw = src.slice(0, openLen + closer.index + firstLen + take);
        const inner = raw.slice(openLen, -openLen);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[1];
        href = 'mailto:' + text;
      } else {
        text = m[1];
        href = text;
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  }

  url(src) {
    const m = INLINE.url.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + text;
      } else {
        let cur = m[0];
        do {
          const prev = cur;
          cur = INLINE._backpedal.exec(cur)?.[0] ?? '';
          if (prev === cur) break;
        } while (true);
        text = cur;
        href = m[1] === 'www.' ? 'http://' + cur : cur;
        m[0] = cur;
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  }

  inlineText(src) {
    const m = INLINE.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeHtml(m[0]), escaped: inRaw };
    }
  }
}

// Fix fenced-code indentation when the fence itself was indented.
function fixFenceIndent(raw, text, rules) {
  const m = raw.match(rules.other.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(rules.other.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// FastLexer: block loop with first-char pre-checks, inline loop with
// char dispatch and a single-scan text matcher.
// ---------------------------------------------------------------------------

/** First non-space char code of the second line of src, or -1 when there
 * is no second line or it is indented more than 3 spaces (a table delimiter
 * row only allows {0,3} leading spaces there). */
function secondLineFirstChar(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return -1;
  let i = nl + 1;
  let sp = 0;
  while (src.charCodeAt(i) === 32 && sp < 4) { i++; sp++; }
  if (sp >= 4) return -1;
  return src.charCodeAt(i);
}

/** Index of the first non-space character of a line (tabs count as content:
 * the list break regexes only allow literal leading spaces). */
function firstNonSpaceIdx(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  return i;
}

/** Cheap gate: can the URL tokenizer possibly match at the start of src?
 * Only the first word can be a URL/email and schemes are short, so bound
 * the check to the prefix instead of scanning the whole remaining source. */
function couldBeUrl(src) {
  if (src.startsWith('www.')) return true;
  // scheme: (http:, https:, ftp:, mailto:, xmpp:) — at most 32 chars.
  if (/^[A-Za-z][A-Za-z0-9+.-]{0,31}:/.test(src)) return true;
  // Bare email: the first word is [A-Za-z0-9._+-]+ and is followed by '@'.
  const word = /^[A-Za-z0-9._+-]+/.exec(src);
  return !!word && src[word[0].length] === '@';
}

class FastLexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new FastTokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
  }

  static lex(src) {
    return new FastLexer().lex(src);
  }

  lex(src) {
    src = src.replace(other.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(src, tokens = [], inBlockquote = false) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) {
        shortest = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      // First-char pre-checks: skip block tokenizers that cannot match.
      const first = src[0];
      let indent = 0;
      while (indent < 3 && src.charCodeAt(indent) === 32) indent++;
      const after = indent < src.length ? src[indent] : '';
      const canSpace = first === ' ' || first === '\t' || first === '\n';
      const canCode = src.startsWith('    ') || src[indent] === '\t';
      const canFences = after === '`' || after === '~';
      const canHeading = after === '#';
      const canHr = after === '-' || after === '_' || after === '*';
      const canBlockquote = after === '>';
      const canList =
        after === '*' || after === '+' || after === '-' || (after >= '0' && after <= '9');
      const canHtml = after === '<';
      const canDef = after === '[';

      let tok;
      if (canSpace && (tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if (canCode && (tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (canFences && (tok = this.tokenizer.fences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (canHeading && (tok = this.tokenizer.heading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (canHr && (tok = this.tokenizer.hr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (canBlockquote && (tok = this.tokenizer.blockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (canList && (tok = this.tokenizer.list(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (canHtml && (tok = this.tokenizer.html(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (canDef && (tok = this.tokenizer.def(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          this.tokens.links[tok.tag] || (this.tokens.links[tok.tag] = { href: tok.href, title: tok.title });
          tokens.push(tok);
        }
        continue;
      }
      // A table needs a delimiter row on the second line; skip its regex
      // when the second line cannot start one. (Setext headings are left
      // ungated: the underline may sit on any line of the paragraph, and
      // every gate tried for it cost more than the regex itself.)
      const slc = secondLineFirstChar(src);
      if (
        (slc === 124 || slc === 58 || slc === 45) &&
        (tok = this.tokenizer.table(src))
      ) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.lheading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokenizer.paragraph(src))) {
        const prev = tokens.at(-1);
        if (inBlockquote && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(tok);
        }
        inBlockquote = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    this.state.top = true;
    return tokens;
  }

  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (
        !(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && this.linkInText(s.slice(1, r - 1)))
      ) {
        return true;
      }
    }
    return false;
  }

  // Mask the source for em/strong/del: hide link, code and HTML spans so
  // delimiters inside them are not seen as closers. Guards skip each
  // replacement when the input cannot contain its match.
  maskInline(src) {
    let t = src;
    if (this.tokens.links && src.includes('[')) {
      const searchRe = INLINE.reflinkSearch;
      const maskReflink = (match) => {
        const open = match.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match.slice(open + 1, -1)))) return match;
        if (open > 1 && match.charAt(0) !== '!') {
          const inner = match.slice(1, open - 1);
          if (this.linkInText(inner)) {
            return '[' + inner.replace(searchRe, maskReflink) + '][' + 'a'.repeat(match.length - open - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      };
      t = t.replace(searchRe, maskReflink);
    }
    if (t.includes('`') || t.includes('\\')) {
      t = t.replace(INLINE.anyPunctuationOutsideCode, (m, backticks, punct) =>
        punct
          ? '+'.repeat(m.length)
          : backticks
            ? backticks + m.slice(backticks.length, -backticks.length).replace(/`/g, '+') + backticks
            : m,
      );
    }
    if (t.includes('[') || t.includes('`') || t.includes('<')) {
      t = t.replace(INLINE.blockSkip, (m, _a, pre) => {
        const o = pre ? pre.length : 0;
        return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
      });
    }
    return t;
  }

  lastEmStrongCloser(maskedSrc, delim) {
    const top = this.tokenizer.maskStack.at(-1);
    if (top && top.maskedSrc === maskedSrc) return top.lastPossibleEmStrongCloserIndex[delim];
    return scanMask(maskedSrc).lastPossibleEmStrongCloserIndex[delim];
  }

  lastDelCloser(maskedSrc) {
    const top = this.tokenizer.maskStack.at(-1);
    if (top && top.maskedSrc === maskedSrc) return top.lastPossibleDelCloserIndex;
    return scanMask(maskedSrc).lastPossibleDelCloserIndex;
  }

  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineLoop(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineLoop(src, tokens) {
    // The mask only feeds emStrong/del, so skip it (and the scan behind it)
    // when the source holds no delimiter that could open or close one.
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? this.maskInline(src) : src;
    const pushed = needsMask;
    if (pushed) this.tokenizer.maskStack.push(scanMask(masked));
    try {
      let merged = false;
      let prevChar = '';
      let shortest = Infinity;
      while (src) {
        if (src.length < shortest) {
          shortest = src.length;
        } else {
          this.infiniteLoopError(src.charCodeAt(0));
          break;
        }
        if (!merged) prevChar = '';
        merged = false;
        let tok;
        const c = src[0];
        if (c === '\\') {
          tok = this.tokenizer.escape(src) || this.tokenizer.br(src);
        } else if (c === '<') {
          tok = this.tokenizer.tag(src) || this.tokenizer.autolink(src);
        } else if (c === '[' || c === '!') {
          tok = this.tokenizer.link(src);
          if (!tok) {
            tok = this.tokenizer.reflink(src, this.tokens.links);
            if (tok) {
              src = src.substring(tok.raw.length);
              const prev = tokens.at(-1);
              if (tok.type === 'text' && prev?.type === 'text') {
                prev.raw += tok.raw;
                prev.text += tok.text;
              } else {
                tokens.push(tok);
              }
              continue;
            }
          }
        } else if (c === '*' || c === '_') {
          tok = this.tokenizer.emStrong(src, masked, prevChar);
        } else if (c === '`') {
          tok = this.tokenizer.codespan(src);
        } else if (c === '~') {
          tok = this.tokenizer.del(src, masked, prevChar);
        } else if (c === ' ') {
          tok = this.tokenizer.br(src);
        } else if (!this.state.inLink && couldBeUrl(src)) {
          tok = this.tokenizer.url(src);
        }
        if (tok) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        // Plain text: one native regex scan consumes the whole run.
        const textTok = this.tokenizer.inlineText(src);
        if (textTok) {
          src = src.substring(textTok.raw.length);
          if (textTok.raw.slice(-1) !== '_') prevChar = textTok.raw.slice(-1);
          merged = true;
          const prev = tokens.at(-1);
          if (prev?.type === 'text') {
            prev.raw += textTok.raw;
            prev.text += textTok.text;
          } else {
            tokens.push(textTok);
          }
          continue;
        }
        if (src) {
          this.infiniteLoopError(src.charCodeAt(0));
          break;
        }
      }
      return tokens;
    } finally {
      if (pushed) this.tokenizer.maskStack.pop();
    }
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}

// ---------------------------------------------------------------------------
// Renderer / parser
// ---------------------------------------------------------------------------

class FastRenderer {
  constructor() {
    this.parser = null;
  }

  space() {
    return '';
  }

  code({ text, lang, escaped }) {
    const langName = (lang || '').match(other.notSpaceStart)?.[0];
    const body = text ? text.replace(other.endingNewline, '') + '\n' : '';
    const html = escaped ? body : escapeHtml(body, true);
    if (langName) return `<pre><code class="language-${escapeHtml(langName)}">${html}</code></pre>\n`;
    return `<pre><code>${html}</code></pre>\n`;
  }

  blockquote({ tokens }) {
    return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
  }

  html({ text }) {
    return text;
  }

  def() {
    return '';
  }

  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }

  hr() {
    return '<hr>\n';
  }

  list(token) {
    let out = '';
    for (const item of token.items) out += this.listitem(item);
    const tag = token.ordered ? 'ol' : 'ul';
    const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
    return `<${tag}${startAttr}>\n${out}</${tag}>\n`;
  }

  listitem(token) {
    return `<li>${this.parser.parse(token.tokens)}</li>\n`;
  }

  checkbox({ checked }) {
    return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
  }

  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  }

  table(token) {
    let head = '';
    for (const cell of token.header) head += this.tablecell(cell);
    const headRow = this.tablerow({ text: head });
    let body = '';
    for (const row of token.rows) {
      let rowHtml = '';
      for (const cell of row) rowHtml += this.tablecell(cell);
      body += this.tablerow({ text: rowHtml });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
  }

  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  }

  tablecell(token) {
    const inner = this.parser.parseInline(token.tokens);
    const tag = token.header ? 'th' : 'td';
    return (token.align ? `<${tag} align="${token.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }

  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  }

  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  }

  codespan({ text }) {
    return `<code>${escapeHtml(text, true)}</code>`;
  }

  br() {
    return '<br>';
  }

  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`;
  }

  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? escapeHtml(text, true) : this.parser.parseInline(tokens);
    const url = cleanUrl(href);
    if (url === null) return inner;
    const safeHref = escapeHtml(url, autolink);
    let out = `<a href="${safeHref}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    out += `>${inner}</a>`;
    return out;
  }

  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const url = cleanUrl(href);
    if (url === null) return escapeHtml(text);
    let out = `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    out += '>';
    return out;
  }

  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ('escaped' in token && token.escaped) return token.text;
    return escapeHtml(token.text);
  }
}

class FastTextRenderer {
  constructor() {
    this.parser = null;
  }

  strong({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  em({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  codespan({ text }) {
    return text;
  }

  del({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  html({ text }) {
    return text;
  }

  text({ text }) {
    return text;
  }

  link({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  image({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  br() {
    return '';
  }

  checkbox({ raw }) {
    return raw;
  }
}

class FastParser {
  constructor() {
    this.renderer = new FastRenderer();
    this.renderer.parser = this;
    this.textRenderer = new FastTextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space':
          out += this.renderer.space(token);
          break;
        case 'hr':
          out += this.renderer.hr(token);
          break;
        case 'heading':
          out += this.renderer.heading(token);
          break;
        case 'code':
          out += this.renderer.code(token);
          break;
        case 'table':
          out += this.renderer.table(token);
          break;
        case 'blockquote':
          out += this.renderer.blockquote(token);
          break;
        case 'list':
          out += this.renderer.list(token);
          break;
        case 'checkbox':
          out += this.renderer.checkbox(token);
          break;
        case 'html':
          out += this.renderer.html(token);
          break;
        case 'def':
          out += this.renderer.def(token);
          break;
        case 'paragraph':
          out += this.renderer.paragraph(token);
          break;
        case 'text':
          out += this.renderer.text(token);
          break;
        default:
          throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape':
          out += renderer.text(token);
          break;
        case 'html':
          out += renderer.html(token);
          break;
        case 'link':
          out += renderer.link(token);
          break;
        case 'image':
          out += renderer.image(token);
          break;
        case 'checkbox':
          out += renderer.checkbox(token);
          break;
        case 'strong':
          out += renderer.strong(token);
          break;
        case 'em':
          out += renderer.em(token);
          break;
        case 'codespan':
          out += renderer.codespan(token);
          break;
        case 'br':
          out += renderer.br(token);
          break;
        case 'del':
          out += renderer.del(token);
          break;
        case 'text':
          out += renderer.text(token);
          break;
        default:
          throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Public entry: the HTML marked 18.1.3 renders for `markdown`, faster.
// ---------------------------------------------------------------------------

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const lexer = new FastLexer();
  const tokens = lexer.lex(markdown);
  const parser = new FastParser();
  return parser.parse(tokens);
}
