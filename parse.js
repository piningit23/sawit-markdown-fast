// FastMark - a fast, from-scratch CommonMark 0.31.2 + GFM 0.29 renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off, async off).
// Dependency-free, single ES module. Written from the CommonMark/GFM spec,
// not from marked's source: the block pass is line oriented with first-char
// pre-checks, the inline pass is one char-dispatch scan, and uniform lists
// take a fast path that renders plain-text items without the generic
// container machinery.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ENT_RE = /&(#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|\w+);|&|[<>"']/g;
const PLAIN_ESC_RE = /[&<>"']/g;
const HAS_ESC_RE = /[&<>"']/;

// Escape text the way marked does: < > " ' are always escaped, and & is
// escaped unless it starts a valid entity reference. Numeric entities are
// decoded to the character (0, surrogates and > U+10FFFF become U+FFFD);
// named entities pass through verbatim.
function esc(s) {
  if (!HAS_ESC_RE.test(s)) return s;
  return s.replace(ENT_RE, (m, ent) => {
    if (m.length === 1) return m === '&' ? '&amp;' : ESC_MAP[m];
    if (ent.charCodeAt(0) === 35) {
      const hex = ent.charCodeAt(1) === 120 || ent.charCodeAt(1) === 88;
      const cp = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      const ch = cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)
        ? '\uFFFD' : String.fromCodePoint(cp);
      return ESC_MAP[ch] || ch;
    }
    return m;
  });
}

// Plain escape for code spans and code blocks: every & becomes &amp;.
function escPlain(s) {
  if (!HAS_ESC_RE.test(s)) return s;
  return s.replace(PLAIN_ESC_RE, (m) => ESC_MAP[m]);
}

// marked's cleanUrl: encodeURI, then undo the %25 it adds for literal %.
// Returns null when encodeURI throws (lone surrogate in the URL).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

const UNESCAPE_RE = /\\([!"#$%&'()*+,.\/:;<=>?@\[\\\]^_`{|}~-])/g;
function unescape(s) {
  return s.indexOf('\\') === -1 ? s : s.replace(UNESCAPE_RE, '$1');
}

// Unicode case folding for link labels: toLowerCase plus the full-folding
// characters it misses (sharp s and ligatures fold to letter pairs).
const CASEFOLD_MAP = {
  'ß': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
  'ﬅ': 'st', 'ﬆ': 'st',
};

function caseFold(s) {
  const lower = s.toLowerCase();
  if (!/[ßﬀﬁﬂﬃﬄﬅﬆ]/.test(lower)) return lower;
  let out = '';
  for (const ch of lower) out += CASEFOLD_MAP[ch] || ch;
  return out;
}

function normalizeLabel(s) {
  // Labels match on their raw text (backslash escapes are NOT processed
  // when matching), with case folding and whitespace collapsed.
  return caseFold(s).replace(/\s+/g, ' ').trim();
}

function isSpaceCode(cc) {
  return cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 12 || cc === 11;
}

function isAsciiPunctCode(cc) {
  return (cc >= 33 && cc <= 47) || (cc >= 58 && cc <= 64) ||
    (cc >= 91 && cc <= 96) || (cc >= 123 && cc <= 126);
}

const UNI_PUNCT_RE = /[\p{P}\p{S}]/u;
const UNI_SPACE_RE = /\s/;
function isPunctCh(ch) {
  const cc = ch.charCodeAt(0);
  if (cc < 128) return isAsciiPunctCode(cc);
  return UNI_PUNCT_RE.test(ch);
}

function isUniSpaceCh(ch) {
  const cc = ch.charCodeAt(0);
  if (cc < 128) return isSpaceCode(cc);
  return UNI_SPACE_RE.test(ch);
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// Columns of leading whitespace in s, whose first character sits at
// absolute column base. A tab advances to the next multiple of 4.
function indentCols(s, base) {
  let col = base || 0;
  for (let k = 0; k < s.length; k++) {
    const cc = s.charCodeAt(k);
    if (cc === 32) col++;
    else if (cc === 9) col += 4 - (col % 4);
    else break;
  }
  return col - (base || 0);
}

// Remove n columns of leading whitespace from s (first char at absolute
// column base). A tab straddling the boundary turns into the spaces that
// remain of it.
// Expand leading tabs in indented-code content to spaces, based on the
// column of the first character (tabs inside the content are kept as-is,
// and fenced-code content keeps its tabs). Only leading whitespace is
// expanded: the strip already removed the 4-column indent, so a tab
// sitting just past it becomes the spaces up to the next tab stop.
function expandLeadingTabs(s, col) {
  let i = 0;
  let c = col;
  let out = '';
  while (i < s.length) {
    const cc = s.charCodeAt(i);
    if (cc === 32) { out += ' '; c++; i++; }
    else if (cc === 9) { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; }
    else break;
  }
  return out + s.slice(i);
}

function stripCols(s, n, base) {
  let col = base || 0;
  let k = 0;
  const target = col + n;
  while (k < s.length && col < target) {
    const cc = s.charCodeAt(k);
    if (cc === 32) { col++; k++; }
    else if (cc === 9) {
      const w = 4 - (col % 4);
      if (col + w <= target) { col += w; k++; }
      else return ' '.repeat(col + w - target) + s.slice(k + 1);
    } else break;
  }
  return s.slice(k);
}

// Remove the first n columns of s whatever they are (markers included),
// with the same partial-tab handling as stripCols.
function sliceCols(s, n, base) {
  let col = base || 0;
  let k = 0;
  const target = col + n;
  while (k < s.length && col < target) {
    const cc = s.charCodeAt(k);
    if (cc === 32) { col++; k++; }
    else if (cc === 9) {
      const w = 4 - (col % 4);
      if (col + w <= target) { col += w; k++; }
      else return ' '.repeat(col + w - target) + s.slice(k + 1);
    } else { col++; k++; }
  }
  return s.slice(k);
}

// Split a table row on unescaped | outside backtick spans. Backslash
// escapes the next character; a backtick run only ends at a run of the
// same length.
// In a table cell an escaped pipe \| is a literal pipe, and the backslash
// is removed before inline parsing (so `a \| b` in a code span renders
// as `a | b`). Other backslash sequences are left for the inline parser.
function unescapePipe(s) {
  if (s.indexOf('\\|') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { out += '|'; i++; }
    else out += s[i];
  }
  return out;
}

function splitCells(row) {
  const cells = [];
  let start = 0;
  let i = 0;
  const n = row.length;
  while (i < n) {
    const cc = row.charCodeAt(i);
    if (cc === 92) { i += 2; continue; }
    if (cc === 96) {
      let j = i;
      while (j < n && row.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j;
      let closed = false;
      while (k < n) {
        if (row.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && row.charCodeAt(m) === 96) m++;
          if (m - k === run) { i = m; closed = true; break; }
          k = m;
        } else k++;
      }
      if (!closed) i = j;
      continue;
    }
    if (cc === 124) { cells.push(unescapePipe(row.slice(start, i))); start = i + 1; }
    i++;
  }
  cells.push(unescapePipe(row.slice(start)));
  return cells;
}

// Try to read an entity reference at src[i] ('&'). Returns {end, out} or
// null. Named entities pass through verbatim; numeric ones decode.
function tryEntity(src, i) {
  const n = src.length;
  let j = i + 1;
  if (src[j] === '#') {
    j++;
    let hex = false;
    if (src[j] === 'x' || src[j] === 'X') { hex = true; j++; }
    let cp = 0;
    let digits = 0;
    while (j < n) {
      const cc = src.charCodeAt(j);
      let d = -1;
      if (cc >= 48 && cc <= 57) d = cc - 48;
      else if (hex && cc >= 97 && cc <= 102) d = cc - 87;
      else if (hex && cc >= 65 && cc <= 70) d = cc - 55;
      else break;
      cp = cp * (hex ? 16 : 10) + d;
      digits++;
      j++;
    }
    if (digits === 0 || digits > (hex ? 6 : 7) || src[j] !== ';') return null;
    const ch = cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)
      ? '\uFFFD' : String.fromCodePoint(cp);
    return { end: j + 1, out: ESC_MAP[ch] || ch };
  }
  let k = j;
  while (k < n) {
    const cc = src.charCodeAt(k);
    if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) ||
      (cc >= 97 && cc <= 122) || cc === 95) k++;
    else break;
  }
  if (k === j || src[k] !== ';') return null;
  return { end: k + 1, out: src.slice(i, k + 1) };
}

function isAsciiLetterCode(cc) {
  return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
}

function isAlnumCode(cc) {
  return (cc >= 48 && cc <= 57) || isAsciiLetterCode(cc);
}

// Angle-bracket autolink <scheme:...> or <email>. Returns {end, href, text}
// or null. Scheme is 2-32 chars, then ':' then at least one non-space char.
function tryAngleAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j < n && isAsciiLetterCode(src.charCodeAt(j))) {
    let k = j + 1;
    while (k < n && k - j <= 32) {
      const cc = src.charCodeAt(k);
      if (isAlnumCode(cc) || cc === 43 || cc === 46 || cc === 45) k++;
      else break;
    }
    if (k - j >= 2 && k - j <= 32 && src[k] === ':') {
      let m = k + 1;
      while (m < n) {
        const cc = src.charCodeAt(m);
        if (cc === 62) break;
        if (cc <= 32 || cc === 60) return null;
        m++;
      }
      if (m < n && m > k + 1) {
        const text = src.slice(i + 1, m);
        return { end: m + 1, href: cleanUrl(text), text };
      }
      return null;
    }
  }
  // Email: local@domain, domain labels may have no dot here.
  const em = tryEmailAt(src, i + 1, false);
  if (em && src[em.end] === '>') {
    const text = src.slice(i + 1, em.end);
    return { end: em.end + 1, href: 'mailto:' + cleanUrl(text), text };
  }
  return null;
}

// Scan an email address starting at src[i]. Returns {end} or null.
// dotRequired: GFM bare emails need a dot in the domain; angle ones do not.
function tryEmailAt(src, i, dotRequired) {
  const n = src.length;
  let j = i;
  let hasDot = false;
  // local part
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (isAlnumCode(cc) || cc === 46 || cc === 33 || cc === 35 || cc === 36 ||
      cc === 37 || cc === 38 || cc === 39 || cc === 42 || cc === 43 ||
      cc === 47 || cc === 61 || cc === 63 || cc === 94 || cc === 95 ||
      cc === 96 || cc === 123 || cc === 124 || cc === 125 || cc === 126 ||
      cc === 45) j++;
    else break;
  }
  if (j === i || src[j] !== '@') return null;
  j++;
  const domStart = j;
  let labelStart = j;
  let labelLen = 0;
  let lastLabelHasLetter = false;
  let labels = 0;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (isAlnumCode(cc) || cc === 45) {
      if (isAsciiLetterCode(cc)) lastLabelHasLetter = true;
      labelLen++;
      j++;
    } else if (cc === 46) {
      if (labelLen === 0) return null;
      if (src[labelStart] === '-' || src[j - 1] === '-') return null;
      // A '.' not followed by a label character is trailing punctuation
      // (bare emails only); stop before it instead of failing on the
      // empty label it would create.
      if (dotRequired) {
        const nx = j + 1 < n ? src.charCodeAt(j + 1) : -1;
        if (!isAlnumCode(nx) && nx !== 45) break;
      }
      labels++;
      hasDot = true;
      labelStart = j + 1;
      labelLen = 0;
      lastLabelHasLetter = false;
      j++;
    } else break;
  }
  if (labelLen === 0) return null;
  if (src[labelStart] === '-' || src[j - 1] === '-') return null;
  labels++;
  if (dotRequired && !hasDot) return null;
  if (j === domStart) return null;
  return { end: j };
}

// Scan an inline HTML tag starting at src[i] ('<'). Returns the index just
// past the tag, or -1 when this is not a tag.
function scanHtmlTag(src, i) {
  const n = src.length;
  let j = i + 1;
  if (src[j] === '!') {
    if (src.startsWith('<!--', i)) {
      // <!--> and <!---> are complete (empty / '-') comments.
      if (src.startsWith('<!-->', i)) return i + 5;
      if (src.startsWith('<!--->', i)) return i + 6;
      const end = src.indexOf('-->', j + 3);
      if (end === -1) return -1;
      const mid = src.slice(j + 3, end);
      // '--' is forbidden unless it ends a line (a -- followed by a
      // newline is allowed: cm-625).
      if (/--(?!\n)/.test(mid)) return -1;
      if (mid.startsWith('>') || mid.startsWith('->')) return -1;
      if (mid.endsWith('-')) return -1;
      return end + 3;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', j + 8);
      return end === -1 ? -1 : end + 3;
    }
    if (j + 1 < n && isAsciiLetterCode(src.charCodeAt(j + 1))) {
      const end = src.indexOf('>', j + 1);
      return end === -1 ? -1 : end + 1;
    }
    return -1;
  }
  if (src[j] === '?') {
    const end = src.indexOf('?>', j + 1);
    return end === -1 ? -1 : end + 2;
  }
  if (src[j] === '/') {
    j++;
    if (j >= n || !isAsciiLetterCode(src.charCodeAt(j))) return -1;
    while (j < n) {
      const cc = src.charCodeAt(j);
      if (isAlnumCode(cc) || cc === 45) j++;
      else break;
    }
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' ||
      src[j] === '\r' || src[j] === '\f')) j++;
    return src[j] === '>' ? j + 1 : -1;
  }
  if (j >= n || !isAsciiLetterCode(src.charCodeAt(j))) return -1;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (isAlnumCode(cc) || cc === 45) j++;
    else break;
  }
  for (;;) {
    // An attribute must be preceded by whitespace (a tag name or a
    // quoted value followed directly by an attribute is not a tag:
    // <m:abc> and <a href='bar'title=title> are literal text).
    const beforeWs = j;
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' ||
      src[j] === '\r' || src[j] === '\f')) j++;
    if (src[j] === '>') return j + 1;
    if (src[j] === '/' && src[j + 1] === '>') return j + 2;
    if (j >= n) return -1;
    if (j === beforeWs) return -1;
    const ac = src.charCodeAt(j);
    if (!(isAsciiLetterCode(ac) || ac === 95 || ac === 58)) return -1;
    j++;
    while (j < n) {
      const cc = src.charCodeAt(j);
      if (isAlnumCode(cc) || cc === 95 || cc === 46 || cc === 58 || cc === 45) j++;
      else break;
    }
    // Only consume the whitespace after an attribute name when an '='
    // actually follows; otherwise the whitespace separates this
    // (valueless) attribute from the next one, and the next loop
    // iteration must see it.
    let k = j;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' ||
      src[k] === '\r' || src[k] === '\f')) k++;
    if (src[k] === '=') {
      j = k + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' ||
        src[j] === '\r' || src[j] === '\f')) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        j++;
        while (j < n && src[j] !== q) j++;
        if (src[j] !== q) return -1;
        j++;
      } else {
        if (j >= n) return -1;
        const vc = src.charCodeAt(j);
        if (vc <= 32 || vc === 34 || vc === 39 || vc === 61 || vc === 60 ||
          vc === 62 || vc === 96) return -1;
        while (j < n) {
          const cc = src.charCodeAt(j);
          if (cc <= 32 || cc === 34 || cc === 39 || cc === 61 || cc === 60 ||
            cc === 62 || cc === 96) break;
          j++;
        }
      }
    }
  }
}

// Validate a GFM domain starting at src[i]: labels of alphanumerics and
// hyphens (not starting/ending with one), separated by dots. The domain must
// contain a dot and its last label a letter. Returns the end index or -1.
function scanGfmDomain(src, i) {
  const n = src.length;
  let j = i;
  let labels = 0;
  let labelStart = j;
  let labelLen = 0;
  let lastLabelHasLetter = false;
  let hasDot = false;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (isAlnumCode(cc) || cc === 45) {
      if (isAsciiLetterCode(cc)) lastLabelHasLetter = true;
      labelLen++;
      j++;
    } else if (cc === 46) {
      if (labelLen === 0) return -1;
      if (src[labelStart] === '-' || src[j - 1] === '-') return -1;
      // A dot not followed by a label character ends the domain here
      // (a trailing dot is punctuation, not part of the domain).
      if (j + 1 >= n || !isAlnumCode(src.charCodeAt(j + 1))) break;
      labels++;
      hasDot = true;
      labelStart = j + 1;
      labelLen = 0;
      lastLabelHasLetter = false;
      j++;
    } else break;
  }
  if (labelLen === 0) return -1;
  if (src[labelStart] === '-' || src[j - 1] === '-') return -1;
  labels++;
  if (!hasDot || !lastLabelHasLetter) return -1;
  return j;
}

const TRAIL_PUNCT = new Set([63, 33, 46, 44, 58, 42, 95, 126]);

// Trim trailing punctuation off a bare autolink URL per GFM: balanced
// parens, then ? ! . , : * _ ~, then a trailing entity-like ;.
function trimGfmUrl(src, start, end) {
  let e = end;
  for (;;) {
    while (e > start && src.charCodeAt(e - 1) === 41) {
      let open = 0;
      let close = 0;
      for (let k = start; k < e; k++) {
        if (src.charCodeAt(k) === 40) open++;
        else if (src.charCodeAt(k) === 41) close++;
      }
      if (close > open) e--;
      else break;
    }
    if (e > start && TRAIL_PUNCT.has(src.charCodeAt(e - 1))) { e--; continue; }
    if (e > start && src.charCodeAt(e - 1) === 59) {
      let k = e - 2;
      while (k >= start && isAlnumCode(src.charCodeAt(k))) k--;
      if (k >= start && src.charCodeAt(k) === 38 && k + 1 < e - 1) { e = k; continue; }
      // A trailing ';' that is not part of an entity is punctuation.
      e--;
      continue;
    }
    break;
  }
  return e;
}

// Bare GFM autolink at src[i] (www., http://, https://, or an email).
// prevOk says the character before i allows an autolink. Returns
// {end, href, text} or null.
function tryGfmAutolink(src, i, prevOk, delims) {
  if (!prevOk) return null;
  const n = src.length;
  let domStart = -1;
  let prefix = '';
  if (src.startsWith('www.', i)) {
    domStart = i;
    prefix = 'http://';
  } else {
    // The scheme is case-insensitive (Https://, HTTP://, ...); the href
    // keeps the original case.
    const low = src.slice(i, i + 8).toLowerCase();
    if (low.startsWith('https://')) {
      domStart = i + 8;
      prefix = '';
    } else if (low.startsWith('http://')) {
      domStart = i + 7;
      prefix = '';
    }
  }
  if (domStart !== -1) {
    const domEnd = scanGfmDomain(src, domStart);
    if (domEnd === -1) return null;
    let end = domEnd;
    if (src[end] === '/' || src[end] === '?' || src[end] === '#' ||
      src[end] === '\\' || src[end] === '.') {
      end++;
      while (end < n) {
        const cc = src.charCodeAt(end);
        if (cc <= 32 || cc === 60 || cc === 62) break;
        end++;
      }
    }
    end = trimGfmUrl(src, i, end);
    if (end <= domStart) return null;
    const text = src.slice(i, end);
    return { end, href: prefix + cleanUrl(text), text };
  }
  // Scheme autolink: scheme (2-32 chars) ':' email, plus at most one
  // path segment (mailto:foo@bar.baz, xmpp:foo@bar.baz/txt; a second
  // segment like /bin in xmpp:foo@bar.baz/txt/bin stays outside).
  if (isAsciiLetterCode(src.charCodeAt(i))) {
    let j = i + 1;
    while (j < n && j < i + 32) {
      const cc = src.charCodeAt(j);
      if (isAlnumCode(cc) || cc === 43 || cc === 46 || cc === 45) j++;
      else break;
    }
    if (j - i >= 2 && j < n && src[j] === ':') {
      const em = tryEmailAt(src, j + 1, true);
      if (em && src[em.end] !== '_') {
        let end = em.end;
        // One path segment: '/' followed by chars up to the next '/'.
        if (src[end] === '/') {
          let k = end + 1;
          while (k < n) {
            const cc = src.charCodeAt(k);
            if (cc <= 32 || cc === 60 || cc === 62 || cc === 47) break;
            k++;
          }
          // Trim trailing punctuation off the segment.
          let segEnd = k;
          while (segEnd > end + 1) {
            const cc = src.charCodeAt(segEnd - 1);
            if (cc === 46 || cc === 44 || cc === 59 || cc === 58 || cc === 63 ||
              cc === 33 || cc === 42 || cc === 95 || cc === 126) segEnd--;
            else break;
          }
          if (segEnd > end + 1) end = segEnd;
        }
        // A trailing '.' or '/' after the email is trimmed.
        while (end > j + 1 && (src[end - 1] === '.' || src[end - 1] === '/')) end--;
        if (end > j + 1) {
          const text = src.slice(i, end);
          return { end, href: cleanUrl(text), text };
        }
      }
    }
  }
  // An email local part never starts with '__' here: that is an
  // emphasis delimiter, not part of the address
  // (__because@x.com__ is <strong> with a link inside, not one link
  // whose text starts with underscores).
  if (src[i] === '_' && src[i + 1] === '_') return null;
  const em = tryEmailAt(src, i, true);
  if (!em) return null;
  // A trailing '_' (a word character the domain scanner does not
  // consume) means the address is part of a larger token: not an
  // autolink at all (gfm-632: a.b-c_d@a.b_ is plain). But a '_' that
  // starts a '__' closing emphasis delimiter does not block the link,
  // and neither does a '_' that closes an open '_' emphasis run
  // (_warning when@x.com_ links the address inside the emphasis).
  if (src[em.end] === '_' && src[em.end + 1] !== '_') {
    let closesEm = false;
    if (delims) {
      for (let k = delims.length - 1; k >= 0; k--) {
        if (delims[k].c === '_' && delims[k].open) { closesEm = true; break; }
      }
    }
    if (!closesEm) return null;
  }
  const text = src.slice(i, em.end);
  return { end: em.end, href: 'mailto:' + cleanUrl(text), text };
}

// Skip spaces, tabs and newlines inside a link's parentheses.
function skipInlineWs(src, j) {
  const n = src.length;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (cc === 32 || cc === 9 || cc === 10) j++;
    else break;
  }
  return j;
}

// Parse an inline link tail starting at src[i] ('('). Returns
// {end, href, title} or null.
function parseInlineLinkTail(src, i) {
  const n = src.length;
  let j = skipInlineWs(src, i + 1);
  let dest = '';
  if (src[j] === '<') {
    let k = j + 1;
    let d = '';
    while (k < n && src[k] !== '>') {
      if (src[k] === '\n' || src[k] === '<') return null;
      if (src[k] === '\\' && k + 1 < n && isAsciiPunctCode(src.charCodeAt(k + 1))) {
        d += src[k + 1];
        k += 2;
      } else {
        d += src[k];
        k++;
      }
    }
    if (src[k] !== '>') return null;
    dest = d;
    j = k + 1;
  } else {
    let depth = 0;
    let k = j;
    let d = '';
    while (k < n) {
      const cc = src.charCodeAt(k);
      if (cc <= 32) break;
      if (cc === 40) { depth++; d += '('; k++; }
      else if (cc === 41) {
        if (depth === 0) break;
        depth--;
        d += ')';
        k++;
      } else if (cc === 92 && k + 1 < n && isAsciiPunctCode(src.charCodeAt(k + 1))) {
        d += src[k + 1];
        k += 2;
      } else {
        d += src[k];
        k++;
      }
    }
    dest = d;
    j = k;
  }
  j = skipInlineWs(src, j);
  if (src[j] === ')') return { end: j + 1, href: dest, title: null };
  let title = null;
  const q = src[j];
  if (q === '"' || q === "'") {
    let k = j + 1;
    let t = '';
    while (k < n && src[k] !== q) {
      if (src[k] === '\\' && k + 1 < n && isAsciiPunctCode(src.charCodeAt(k + 1))) {
        t += src[k + 1];
        k += 2;
      } else {
        t += src[k];
        k++;
      }
    }
    if (src[k] !== q) return null;
    title = t;
    j = k + 1;
  } else if (q === '(') {
    let k = j + 1;
    let t = '';
    while (k < n && src[k] !== ')') {
      if (src[k] === '(') return null;
      if (src[k] === '\\' && k + 1 < n && isAsciiPunctCode(src.charCodeAt(k + 1))) {
        t += src[k + 1];
        k += 2;
      } else {
        t += src[k];
        k++;
      }
    }
    if (src[k] !== ')') return null;
    title = t;
    j = k + 1;
  } else {
    return null;
  }
  j = skipInlineWs(src, j);
  if (src[j] !== ')') return null;
  return { end: j + 1, href: dest, title };
}

// Parse a link label starting at src[i] ('['). Single line, no unescaped
// brackets, 1-999 chars after unescaping. Returns {end, label} or null.
function parseLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  let label = '';
  while (j < n) {
    const cc = src.charCodeAt(j);
    // A label may span lines but may not contain an unescaped '['.
    if (cc === 91) return null;
    if (cc === 93) {
      if (label.length === 0 || label.length > 999) return null;
      return { end: j + 1, label };
    }
    if (cc === 92 && j + 1 < n && isAsciiPunctCode(src.charCodeAt(j + 1))) {
      // An escaped character stays raw in the label (it does not end the
      // label, and it is not unescaped for matching).
      label += src.slice(j, j + 2);
      j += 2;
    } else {
      label += src[j];
      j++;
    }
  }
  return null;
}

// Plain text of rendered inline HTML: tags are removed, but an <img>
// contributes its alt text (already the plain text of its own label).
function stripTags(html) {
  return html.replace(/<img[^>]*alt="([^"]*)"[^>]*>|<[^>]*>/g, (m, alt) => {
    if (alt === undefined) return '';
    return alt.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  });
}

function prevDelim(delims, d) {
  const i = delims.indexOf(d);
  return i > 0 ? delims[i - 1] : null;
}

// The CommonMark emphasis algorithm over the delimiter stack. bottom is a
// delimiter (from a link opener) below which we must not look, or null.
function processEmphasis(st, bottom) {
  const delims = st.delims;
  // Scan closers from the earliest to the latest: inner pairs match first,
  // so '**' inside '*' becomes <strong> and the outer '*' becomes <em>.
  // (No openers-bottom shortcut: an opener rejected for one closer by the
  // rule of 3 can still be valid for a later closer.)
  let ci = bottom ? delims.indexOf(bottom) + 1 : 0;
  if (ci < 0) ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.close) { ci++; continue; }
    const bottomIdx = bottom ? delims.indexOf(bottom) : -1;
    if (ci <= bottomIdx) { ci = bottomIdx + 1; continue; }
    let opener = null;
    for (let j = ci - 1; j > bottomIdx; j--) {
      const d = delims[j];
      if (d.c !== closer.c || !d.open) continue;
      // Rule of 3: rejected when the sum of the two runs is a multiple of
      // 3 and neither run's length is a multiple of 3 (a 3+3 or 6+9 pair
      // still forms emphasis).
      if ((d.close || closer.open) &&
        ((d.n % 3) + (closer.n % 3) === 3)) continue;
      // A lone closer must not steal the one delimiter a '**' opener
      // needs for <strong> when a later '**' closer can take the pair:
      // leave the lone closer literal and let the strong pair form.
      // (An opener of 3+ can spare one and still go strong, e.g.
      // `***foo* bar**`, so only a '**' opener is protected.)
      if (closer.n === 1 && d.n === 2) {
        let laterStrong = false;
        for (let k = ci + 1; k < delims.length; k++) {
          const ld = delims[k];
          if (ld.c === closer.c && ld.close && ld.n >= 2) {
            laterStrong = true;
            break;
          }
        }
        if (laterStrong) continue;
      }
      opener = d;
      break;
    }
    if (!opener) { ci++; continue; }
    const use = opener.n === 1 || closer.n === 1 ? 1 : 2;
    let openTag;
    let closeTag;
    if (closer.c === '~') { openTag = '<del>'; closeTag = '</del>'; }
    else if (use === 2) { openTag = '<strong>'; closeTag = '</strong>'; }
    else { openTag = '<em>'; closeTag = '</em>'; }
    opener.n -= use;
    closer.n -= use;
    // A delimiter used twice keeps both tags: a later match opens an outer
    // emphasis, so its tag goes before the earlier (inner) ones; a later
    // match closes an outer emphasis, so its tag goes after them.
    opener.ot = openTag + (opener.ot || '');
    opener.s = (opener.n > 0 ? opener.c.repeat(opener.n) : '') + opener.ot;
    closer.ct = (closer.ct || '') + closeTag;
    closer.s = closer.ct + (closer.n > 0 ? closer.c.repeat(closer.n) : '');
    // Delimiters strictly between the opener and the closer are now inside
    // the emphasis just formed: they cannot pair with anything outside it.
    const oi = delims.indexOf(opener);
    const cj = delims.indexOf(closer);
    if (cj - oi > 1) {
      delims.splice(oi + 1, cj - oi - 1);
    }
    if (opener.n === 0) {
      const oi2 = delims.indexOf(opener);
      delims.splice(oi2, 1);
      if (oi2 < ci) ci--;
    }
    if (closer.n === 0) {
      const idx = delims.indexOf(closer);
      delims.splice(idx, 1);
      ci = idx;
    } else {
      // The closer moved left when inner delimiters were removed.
      ci = delims.indexOf(closer);
    }
    // If the closer still has delimiters left, keep it as the current
    // closer and look for another opener.
  }
}

// Drop every output chunk and delimiter/bracket at or after position pos.
function truncateOut(st, pos) {
  st.out.length = pos;
  while (st.delims.length && st.delims[st.delims.length - 1].pos >= pos) {
    st.delims.pop();
  }
  while (st.brackets.length && st.brackets[st.brackets.length - 1].pos >= pos) {
    st.brackets.pop();
  }
}

// A ']' at src[i]. Tries to form a link or image with the nearest active
// '['. Returns the index just past the link, or -1 for a literal ']'.
function tryCloseBracket(st, i) {
  const src = st.src;
  if (st.brackets.length === 0) return -1;
  // Only the nearest open bracket is considered. If it is inactive (a link
  // already formed inside it, or a previous attempt failed), this ']' is
  // literal and the bracket is dropped.
  const b = st.brackets[st.brackets.length - 1];
  if (!b.active) {
    st.brackets.pop();
    return -1;
  }
  const labelText = src.slice(b.srcPos + 1, i);
  let href = null;
  let title = null;
  let end = -1;
  if (src[i + 1] === '(') {
    const tail = parseInlineLinkTail(src, i + 1);
    if (tail) { href = tail.href; title = tail.title; end = tail.end; }
  }
  // An inline tail that fails falls through to the reference forms.
  // A full/collapsed reference that was attempted (a valid second label
  // was found) but has no definition does NOT fall back to a shortcut:
  // [foo][bar] with no bar definition leaves [foo] literal, and
  // [bar][baz] may then resolve.
  let triedFullRef = false;
  if (href === null && src[i + 1] === '[') {
    if (src[i + 2] === ']') {
      triedFullRef = true;
      const ref = st.refs.get(normalizeLabel(labelText));
      if (ref) { href = ref.href; title = ref.title; end = i + 3; }
    } else {
      const lab = parseLabel(src, i + 1);
      if (lab) {
        triedFullRef = true;
        const ref = st.refs.get(normalizeLabel(lab.label));
        if (ref) { href = ref.href; title = ref.title; end = lab.end; }
      }
    }
  }
  if (href === null && !triedFullRef) {
    const ref = st.refs.get(normalizeLabel(labelText));
    if (ref) { href = ref.href; title = ref.title; end = i + 1; }
  }
  if (href === null) {
    st.brackets.pop();
    return -1;
  }
  st.brackets.pop();
  const url = cleanUrl(href);
  if (b.img) {
    const alt = stripTags(inline(labelText, st.refs));
    if (url === null) {
      truncateOut(st, b.bangPos);
      st.out.push(alt);
      processEmphasis(st, b.bottom);
      return end;
    }
    let tag = '<img src="' + esc(url) + '" alt="' + esc(alt) + '"';
    if (title !== null) tag += ' title="' + esc(title) + '"';
    tag += '>';
    truncateOut(st, b.bangPos);
    st.out.push(tag);
    processEmphasis(st, b.bottom);
    return end;
  }
  if (url === null) {
    b.active = false;
    return -1;
  }
  // A link that forms deactivates every other open link bracket: a link
  // cannot contain another link. Image brackets stay active (a link may
  // contain an image, an image's alt text may contain a link).
  for (const ob of st.brackets) {
    if (ob !== b && !ob.img) ob.active = false;
  }
  b.s = '<a href="' + esc(url) + '"' +
    (title !== null ? ' title="' + esc(title) + '"' : '') + '>';
  st.out.push('</a>');
  processEmphasis(st, b.bottom);
  // Delimiters inside the link text cannot pair with anything outside it.
  while (st.delims.length && st.delims[st.delims.length - 1].pos > b.pos) {
    st.delims.pop();
  }
  return end;
}

function flanking(src, i, len) {
  const prev = i > 0 ? src[i - 1] : undefined;
  const next = i + len < src.length ? src[i + len] : undefined;
  const prevWs = prev === undefined ? true : isUniSpaceCh(prev);
  const nextWs = next === undefined ? true : isUniSpaceCh(next);
  const prevPunct = prev !== undefined && isPunctCh(prev);
  const nextPunct = next !== undefined && isPunctCh(next);
  return {
    left: !nextWs && (!nextPunct || prevWs || prevPunct),
    right: !prevWs && (!prevPunct || nextWs || nextPunct),
    prevPunct,
    nextPunct,
  };
}

// A link's text cannot contain another link: while a link bracket is
// open (and active), no autolink of any kind is formed inside it.
function inLinkText(st) {
  for (const b of st.brackets) {
    if (!b.img && b.active) return true;
  }
  return false;
}

function isAutolinkPrev(src, i) {
  if (i === 0) return true;
  const cc = src.charCodeAt(i - 1);
  return isSpaceCode(cc) || cc === 42 || cc === 95 || cc === 126 || cc === 40 ||
    cc === 60;
}

const TEXT_ESC_RE = /["'>]/g;

// Render inline markdown to HTML. refs maps normalized labels to
// {href, title}.
function inline(src, refs) {
  const n = src.length;
  const st = { src, refs, out: [], delims: [], brackets: [] };
  const out = st.out;
  const delims = st.delims;
  const brackets = st.brackets;
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push(buf.replace(TEXT_ESC_RE, (m) => ESC_MAP[m]));
      buf = '';
    }
  };
  while (i < n) {
    const cc = src.charCodeAt(i);
    if ((cc === 119 || cc === 104 || isAlnumCode(cc) || cc === 95) &&
      isAutolinkPrev(src, i) && !inLinkText(st)) {
      const g = tryGfmAutolink(src, i, true, delims);
      if (g) {
        flush();
        out.push('<a href="' + esc(g.href) + '">' + esc(g.text) + '</a>');
        i = g.end;
        continue;
      }
    }
    if (cc === 92) {
      const nx = src[i + 1];
      if (nx === '\n') { flush(); out.push('<br>'); i += 2; continue; }
      if (nx !== undefined && isAsciiPunctCode(nx.charCodeAt(0))) {
        flush();
        out.push(ESC_MAP[nx] || nx);
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    if (cc === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j;
      let close = -1;
      while (k < n) {
        const idx = src.indexOf('`', k);
        if (idx === -1) break;
        // A multi-backtick code span inside link text must close before
        // the ']' that ends the link (a ']' followed by '(' or '[');
        // otherwise the backticks are literal and the link still forms.
        // (A single backtick MAY span the ']', e.g. cm-342/525/537.)
        if (run >= 2 && st.brackets.length > 0) {
          const rb = src.indexOf(']', k);
          if (rb !== -1 && rb < idx && (src[rb + 1] === '(' || src[rb + 1] === '[')) break;
        }
        // A single backtick inside link text may span the ']' only when
        // its closing backtick is on the SAME line (cm-342/525/537); a
        // closing backtick on a later line leaves the backtick literal
        // and the link forms (doc-09: [docs each ``url`](...)).
        if (run === 1 && st.brackets.length > 0) {
          const rb = src.indexOf(']', k);
          if (rb !== -1 && rb < idx && (src[rb + 1] === '(' || src[rb + 1] === '[') &&
            src.indexOf('\n', i) !== -1 && src.indexOf('\n', i) < idx) break;
        }
        let m = idx;
        while (m < n && src.charCodeAt(m) === 96) m++;
        if (m - idx === run) { close = idx; break; }
        k = m;
      }
      if (close === -1) { buf += src.slice(i, j); i = j; continue; }
      let content = src.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' &&
        content[content.length - 1] === ' ' && !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      out.push('<code>' + escPlain(content) + '</code>');
      i = close + run;
      continue;
    }
    if (cc === 60) {
      const auto = tryAngleAutolink(src, i);
      if (auto) {
        flush();
        out.push('<a href="' + esc(auto.href) + '">' + esc(auto.text) + '</a>');
        i = auto.end;
        continue;
      }
      const tagEnd = scanHtmlTag(src, i);
      if (tagEnd !== -1) {
        flush();
        out.push(src.slice(i, tagEnd));
        i = tagEnd;
        continue;
      }
      buf += '&lt;';
      i++;
      continue;
    }
    if (cc === 38) {
      const ent = tryEntity(src, i);
      if (ent) {
        flush();
        out.push(ent.out);
        i = ent.end;
        continue;
      }
      buf += '&amp;';
      i++;
      continue;
    }
    if (cc === 91) {
      flush();
      const b = {
        b: true, img: false, pos: out.length, srcPos: i,
        bottom: delims.length ? delims[delims.length - 1] : null,
        active: true, s: '[',
      };
      out.push(b);
      brackets.push(b);
      i++;
      continue;
    }
    if (cc === 33) {
      if (src[i + 1] === '[') {
        flush();
        const bangPos = out.length;
        out.push('!');
        const b = {
          b: true, img: true, pos: out.length, bangPos, srcPos: i + 1,
          bottom: delims.length ? delims[delims.length - 1] : null,
          active: true, s: '[',
        };
        out.push(b);
        brackets.push(b);
        i += 2;
        continue;
      }
      buf += '!';
      i++;
      continue;
    }
    if (cc === 93) {
      flush();
      const end = tryCloseBracket(st, i);
      if (end === -1) { buf += ']'; i++; continue; }
      i = end;
      continue;
    }
    if (cc === 42 || cc === 95) {
      const ch = cc === 42 ? '*' : '_';
      let j = i;
      while (j < n && src.charCodeAt(j) === cc) j++;
      const len = j - i;
      const fl = flanking(src, i, len);
      let open;
      let close;
      if (ch === '*') { open = fl.left; close = fl.right; }
      else {
        open = fl.left && (!fl.right || fl.prevPunct);
        close = fl.right && (!fl.left || fl.nextPunct);
      }
      flush();
      const d = {
        c: ch, n: len, open, close, pos: out.length,
        s: ch.repeat(len),
      };
      out.push(d);
      delims.push(d);
      i = j;
      continue;
    }
    if (cc === 126) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 126) j++;
      const len = j - i;
      // A run of 3+ tildes is literal text; a run of 1 or 2 is a
      // strikethrough delimiter (single ~ strikes through too).
      if (len >= 3) { buf += '~'.repeat(len); i = j; continue; }
      const fl = flanking(src, i, len);
      flush();
      const d = {
        c: '~', n: len, open: fl.left, close: fl.right, pos: out.length,
        s: '~'.repeat(len),
      };
      out.push(d);
      delims.push(d);
      i = j;
      continue;
    }
    if (cc === 10) {
      if (buf.length >= 2 && buf.endsWith('  ')) {
        let e = buf.length;
        while (e > 0 && buf[e - 1] === ' ') e--;
        buf = buf.slice(0, e);
        flush();
        out.push('<br>');
      } else {
        flush();
        out.push('\n');
      }
      i++;
      continue;
    }
    buf += src[i];
    i++;
  }
  flush();
  processEmphasis(st, null);
  let html = '';
  for (let k = 0; k < out.length; k++) {
    const o = out[k];
    html += typeof o === 'string' ? o : o.s;
  }
  return html;
}

// ---------- block parsing ----------

// Node types: doc, para, h, code, html, hr, bq, list, item, table.

function matchBqPrefix(line, base) {
  let k = 0;
  let col = base || 0;
  while (k < line.length && col - (base || 0) < 3) {
    const cc = line.charCodeAt(k);
    if (cc === 32) { col++; k++; }
    else if (cc === 9) {
      const w = 4 - (col % 4);
      if (col + w - (base || 0) > 3) return null;
      col += w;
      k++;
    } else break;
  }
  if (line[k] !== '>') return null;
  k++;
  col++;
  // After '>' one space is consumed; a tab gives up one column only, the
  // rest of it stays as spaces (so '>\\t\\tfoo' keeps two of them).
  if (line[k] === ' ') { k++; col++; }
  else if (line[k] === '\t') {
    const w = 4 - (col % 4);
    return { rest: ' '.repeat(w - 1) + line.slice(k + 1), base: col + 1 };
  }
  return { rest: line.slice(k), base: col };
}

// Match the line against the open containers. Returns {rest, base,
// failDepth} where failDepth is -1 when every container matched.
function matchContainers(S, line) {
  const stack = S.stack;
  let rest = line;
  let base = 0;
  for (let d = 1; d < stack.length; d++) {
    const c = stack[d];
    if (c.t === 'bq') {
      const r = matchBqPrefix(rest, base);
      if (r === null) return { rest, base, failDepth: d };
      rest = r.rest;
      base = r.base;
    } else if (c.t === 'item') {
      if (!isBlankLine(rest)) {
        const ind = indentCols(rest, base);
        if (ind >= c.contentIndent) {
          rest = stripCols(rest, c.contentIndent, base);
          base += c.contentIndent;
        } else return { rest, base, failDepth: d };
      }
    }
  }
  return { rest, base, failDepth: -1 };
}

function skipSpacesTabs(text, j) {
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  return j;
}

// Parse one link reference definition at text[pos]. Returns {end} or null.
function parseRefDef(text, pos, refs) {
  const n = text.length;
  let j = pos;
  let col = 0;
  while (j < n && (text[j] === ' ' || text[j] === '\t')) {
    if (text[j] === ' ') col++;
    else col += 4 - (col % 4);
    if (col > 3) return null;
    j++;
  }
  if (text[j] !== '[') return null;
  const lab = parseLabel(text, j);
  if (!lab) return null;
  j = lab.end;
  if (text[j] !== ':') return null;
  j++;
  let k = skipSpacesTabs(text, j);
  if (text[k] === '\n') { k++; k = skipSpacesTabs(text, k); }
  let dest = null;
  if (text[k] === '<') {
    let m = k + 1;
    let d = '';
    while (m < n && text[m] !== '>') {
      if (text[m] === '\n' || text[m] === '<') return null;
      if (text[m] === '\\' && m + 1 < n && isAsciiPunctCode(text.charCodeAt(m + 1))) {
        d += text[m + 1];
        m += 2;
      } else {
        d += text[m];
        m++;
      }
    }
    if (text[m] !== '>') return null;
    dest = d;
    k = m + 1;
  } else {
    let m = k;
    let d = '';
    let depth = 0;
    while (m < n) {
      const cc = text.charCodeAt(m);
      if (cc <= 32) break;
      if (cc === 40) { depth++; d += '('; m++; }
      else if (cc === 41) {
        if (depth === 0) break;
        depth--;
        d += ')';
        m++;
      } else if (cc === 92 && m + 1 < n && isAsciiPunctCode(text.charCodeAt(m + 1))) {
        d += text[m + 1];
        m += 2;
      } else {
        d += text[m];
        m++;
      }
    }
    if (d === '') return null;
    dest = d;
    k = m;
  }
  let title = null;
  let k2 = skipSpacesTabs(text, k);
  // A title on the same line needs whitespace between it and the
  // destination ([foo]: <bar>(baz) is not a definition).
  if (k2 === k && (text[k2] === '"' || text[k2] === "'" || text[k2] === '(')) return null;
  const parseTitleAt = (p) => {
    const q = text[p];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    let m = p + 1;
    let t = '';
    if (q === '(') {
      while (m < n && text[m] !== ')') {
        if (text[m] === '(') return null;
        if (text[m] === '\\' && m + 1 < n && isAsciiPunctCode(text.charCodeAt(m + 1))) {
          t += text[m + 1];
          m += 2;
        } else {
          t += text[m];
          m++;
        }
      }
      if (text[m] !== ')') return null;
      return { title: t, end: m + 1 };
    }
    while (m < n && text[m] !== q) {
      if (text[m] === '\\' && m + 1 < n && isAsciiPunctCode(text.charCodeAt(m + 1))) {
        t += text[m + 1];
        m += 2;
      } else {
        t += text[m];
        m++;
      }
    }
    if (text[m] !== q) return null;
    return { title: t, end: m + 1 };
  };
  const t1 = parseTitleAt(k2);
  if (t1) {
    title = t1.title;
    k2 = t1.end;
  } else if (text[k2] === '\n') {
    const m = skipSpacesTabs(text, k2 + 1);
    const t2 = parseTitleAt(m);
    if (t2) {
      // A next-line title is only part of the definition when nothing
      // but whitespace follows it on its line; otherwise the definition
      // keeps just the destination and the line stays as text.
      const afterTitle = skipSpacesTabs(text, t2.end);
      if (afterTitle >= n || text[afterTitle] === '\n') {
        title = t2.title;
        k2 = t2.end;
      }
    } else if (text[m] === '"' || text[m] === "'" || text[m] === '(') {
      return null;
    }
  } else if (text[k2] === '"' || text[k2] === "'" || text[k2] === '(') {
    return null;
  }
  let end = skipSpacesTabs(text, k2);
  if (end < n && text[end] !== '\n') return null;
  if (end < n) end++;
  const key = normalizeLabel(lab.label);
  // An empty (whitespace-only) label is not a definition.
  if (key === '') return null;
  if (!refs.has(key)) refs.set(key, { href: dest, title });
  return { end };
}

function finalizeParagraph(S, leaf) {
  const text = leaf.lines.join('\n');
  let pos = 0;
  while (pos < text.length) {
    const def = parseRefDef(text, pos, S.refs);
    if (!def) break;
    pos = def.end;
  }
  const rest = text.slice(pos);
  if (rest.replace(/[ \t\n]/g, '') === '') {
    leaf.parent.children.pop();
    return;
  }
  leaf.src = rest;
}

function closeLeaf(S) {
  const leaf = S.leaf;
  if (!leaf) return;
  S.leaf = null;
  if (leaf.t === 'para') {
    finalizeParagraph(S, leaf);
  } else if (leaf.t === 'code' && !leaf.fence) {
    if (leaf.pendingBlanks.length > 0) {
      // The code block ended with blank lines: those blanks separated
      // blocks, so the next block may loosen its list (unless the code
      // is inside a blockquote, where the blanks stay inside the quote).
      S.lastLineBlank = S.stack[S.stack.length - 1].t !== 'bq';
      leaf.pendingBlanks = [];
    }
  }
  if (leaf.t === 'code' || leaf.t === 'html') {
    if (leaf.t === 'code') {
      leaf.trailingNL = leaf.lastIdx < S.lines.length - 1 || S.lastTerminated;
    } else if (leaf.endKind === 'marker') {
      // Types 1-5 end at their end marker: the marker line's newline is
      // kept, unless the next line is truly empty (a whitespace-only
      // next line still keeps the newline).
      const next = S.lines[leaf.lastIdx + 1];
      leaf.trailingNL = (next === undefined ? S.lastTerminated :
        next !== '') &&
        (leaf.lastIdx < S.lines.length - 1 || S.lastTerminated);
    } else {
      // Types 6-7 end at a blank line (or at the end of a container): the
      // trailing newline is kept only when the block runs to the end of
      // the document, so the next block starts on the same line.
      leaf.trailingNL = leaf.lastIdx === S.lines.length - 1 && S.lastTerminated;
    }
  }
}

// Close containers from depth d inward (stack[0] is the document, never
// closed).
function closeTo(S, d) {
  closeLeaf(S);
  while (S.stack.length > d) S.stack.pop();
}

function closeAll(S) {
  closeTo(S, 1);
}

// ATX heading on an indent-stripped line. Returns {level, src} or null.
function atxHeading(content) {
  let k = 0;
  while (k < content.length && content.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  if (k < content.length && content[k] !== ' ' && content[k] !== '\t') return null;
  let text = content.slice(k).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // A closing sequence is '#'s preceded by a space, or the whole text
  // being '#'s (### ### is an empty heading).
  if (/^#+$/.test(text)) text = '';
  else {
    const m = /[ \t]+#+$/.exec(text);
    if (m) text = text.slice(0, m.index).replace(/[ \t]+$/, '');
  }
  return { level: k, src: text };
}

// Fenced code start on an indent-stripped line. Returns {char, len, info}.
function tryFence(content) {
  const ch = content[0];
  if (ch !== '`' && ch !== '~') return null;
  let k = 0;
  while (k < content.length && content[k] === ch) k++;
  if (k < 3) return null;
  const info = content.slice(k).trim();
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { char: ch, len: k, info };
}

const HR_RE = /^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/;
function isHr(content) {
  return HR_RE.test(content);
}

// Setext underline level on a line (indent already checked <= 3 by caller).
function setextLevel(rest, base) {
  const ind = indentCols(rest, base);
  if (ind > 3) return 0;
  const content = stripCols(rest, ind, base);
  if (/^=+[ \t]*$/.test(content)) return 1;
  if (/^-+[ \t]*$/.test(content)) return 2;
  return 0;
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// HTML block start on an indent-stripped line. Returns {kind, end} or null.
// kind 1-5 end at a marker string, 6-7 at a blank line. kind 7 cannot
// interrupt a paragraph.
function tryHtmlBlock(content) {
  if (content[0] !== '<') return null;
  const lower = content.toLowerCase();
  const afterTag = (name) => {
    const rest = lower.slice(1 + name.length);
    return rest === '' || rest[0] === ' ' || rest[0] === '\t' ||
      rest[0] === '\n' || rest[0] === '>' || rest.startsWith('/>');
  };
  if (lower.startsWith('<pre') && afterTag('pre')) return { kind: 1, end: '</pre>' };
  if (lower.startsWith('<script') && afterTag('script')) return { kind: 1, end: '</script>' };
  if (lower.startsWith('<style') && afterTag('style')) return { kind: 1, end: '</style>' };
  if (lower.startsWith('<textarea') && afterTag('textarea')) return { kind: 1, end: '</textarea>' };
  if (lower.startsWith('<!--')) return { kind: 2, end: '-->' };
  if (lower.startsWith('<?')) return { kind: 3, end: '?>' };
  if (lower.startsWith('<!') && lower.length > 2 &&
    isAsciiLetterCode(lower.charCodeAt(2))) return { kind: 4, end: '>' };
  if (lower.startsWith('<![cdata[')) return { kind: 5, end: ']]>' };
  // Type 6: block-level tag, open or close.
  let m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(content);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
    const after = content.slice(m[0].length);
    if (after === '' || after[0] === ' ' || after[0] === '\t' ||
      after[0] === '>' || after.startsWith('/>')) return { kind: 6, end: null };
  }
  // Type 7: any complete open or close tag, nothing after it but spaces.
  // A closing tag takes no attributes.
  if (content.startsWith('</')) {
    m = /^<\/[a-zA-Z][a-zA-Z0-9-]*[ \t]*>[ \t]*$/.exec(content);
  } else {
    m = /^(<[a-zA-Z][a-zA-Z0-9-]*(?:[ \t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\n"'=<>`]+|'[^'\n]*'|"[^"\n]*"))?)*[ \t]*\/?>)[ \t]*$/.exec(content);
  }
  if (m) {
    const tagName = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(content)[1].toLowerCase();
    if (tagName !== 'pre' && tagName !== 'script' && tagName !== 'style' &&
      tagName !== 'textarea') return { kind: 7, end: null };
  }
  return null;
}

// List marker on a line (indent <= 3). Returns marker info or null.
// contentIndent is relative to rest's start; contentLine is the remainder
// after the marker and its following whitespace, with a tab straddling the
// boundary materialised as spaces.
function listMarkerInfo(rest, base) {
  const b = base || 0;
  const ind = indentCols(rest, b);
  if (ind > 3) return null;
  const content = stripCols(rest, ind, b);
  const ch = content[0];
  let ordered = false;
  let start = 0;
  let delim = '';
  let bullet = '';
  let e = 0;
  if (ch === '-' || ch === '+' || ch === '*') {
    const nx = content[1];
    if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
    bullet = ch;
    e = 1;
  } else {
    let k = 0;
    while (k < content.length && content[k] >= '0' && content[k] <= '9') k++;
    if (k === 0 || k > 9) return null;
    const d = content[k];
    if (d !== '.' && d !== ')') return null;
    const nx = content[k + 1];
    if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
    ordered = true;
    start = parseInt(content.slice(0, k), 10);
    delim = d;
    e = k + 1;
  }
  // Absolute column just past the marker; tab widths are absolute.
  let col = b + ind + e;
  let k = e;
  while (k < content.length && (content[k] === ' ' || content[k] === '\t')) {
    if (content[k] === ' ') col++;
    else col += 4 - (col % 4);
    k++;
  }
  const blankAfter = k >= content.length;
  let contentIndent;
  if (blankAfter) contentIndent = ind + 2;
  else if (col - (b + ind + e) >= 1 && col - (b + ind + e) <= 4) {
    contentIndent = col - b;
  } else contentIndent = ind + e + 1;
  return {
    ordered, start, delim, bullet, contentIndent,
    contentLine: blankAfter ? null : sliceCols(rest, contentIndent, b),
    contentBase: b + contentIndent,
  };
}

function startsWithUnescapedPipe(row) {
  let k = 0;
  while (k < row.length && (row[k] === ' ' || row[k] === '\t')) k++;
  return row[k] === '|';
}

function endsWithUnescapedPipe(row) {
  let k = row.length - 1;
  while (k >= 0 && (row[k] === ' ' || row[k] === '\t')) k--;
  if (k < 0 || row[k] !== '|') return false;
  let bs = 0;
  let m = k - 1;
  while (m >= 0 && row[m] === '\\') { bs++; m--; }
  return bs % 2 === 0;
}

function trimPipeCells(cells, row) {
  if (startsWithUnescapedPipe(row)) cells.shift();
  if (cells.length && endsWithUnescapedPipe(row)) cells.pop();
  return cells;
}

const DELIM_CELL_RE = /^:?-+:?$/;

// Table header (already container-matched) at lines[i] with delimiter at
// lines[i+1] (after container matching). Returns {aligns, headerCells} or
// null.
function tryTableHeader(S, headerRest, headerBase) {
  if (headerRest.indexOf('|') === -1) return null;
  const dline = S.lines[S.i + 1];
  if (dline === undefined) return null;
  const dm = matchContainers(S, dline);
  if (dm.failDepth !== -1) return null;
  const dind = indentCols(dm.rest, dm.base);
  if (dind > 3) return null;
  const dcontent = stripCols(dm.rest, dind, dm.base);
  const dcells = trimPipeCells(splitCells(dcontent), dcontent);
  if (dcells.length === 0) return null;
  for (let c = 0; c < dcells.length; c++) {
    if (!DELIM_CELL_RE.test(dcells[c].trim())) return null;
  }
  const headerStartsPipe = startsWithUnescapedPipe(headerRest);
  if (!headerStartsPipe && dm.rest.indexOf('|') === -1) return null;
  const aligns = dcells.map((c) => {
    const t = c.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    return left && right ? 'center' : left ? 'left' : right ? 'right' : null;
  });
  const hind = indentCols(headerRest, headerBase);
  const hcells = trimPipeCells(splitCells(stripCols(headerRest, hind, headerBase)), headerRest);
  // The delimiter row must have exactly as many cells as the header;
  // otherwise this is not a table at all (gfm-203).
  if (dcells.length !== hcells.length) return null;
  return { aligns, headerCells: hcells };
}

function addNode(S, node) {
  node.parent = S.stack[S.stack.length - 1];
  // A blank line before a second block inside a list item makes that
  // item's list loose (a blank line inside a nested item does not loosen
  // the outer lists).
  if (node.parent.t === 'item' && node.parent.children.length > 0 &&
    S.lastLineBlank) {
    const grandparent = S.stack[S.stack.length - 2];
    if (grandparent && grandparent.t === 'list') grandparent.tight = false;
  }
  node.parent.children.push(node);
  return node;
}

function isSameList(list, lm) {
  if (list.ordered !== lm.ordered) return false;
  if (lm.ordered) return list.delim === lm.delim;
  return list.bullet === lm.bullet;
}

function openItemInto(S, list, lm) {
  // A blank line before a new item makes its list loose, but not before
  // the first item of a list (a blank line before a list starts it).
  if (S.lastLineBlank && list.children.length > 0) list.tight = false;
  const item = { t: 'item', children: [], contentIndent: lm.contentIndent };
  list.children.push(item);
  S.stack.push(item);
  if (lm.contentLine !== null) phase2(S, lm.contentLine, lm.contentBase);
  else S.i++;
}

// Does the line start a block that interrupts an open paragraph?
function startsInterruptBlock(S, rest, base) {
  const ind = indentCols(rest, base);
  if (ind > 3) return false;
  const content = stripCols(rest, ind, base);
  if (content === '') return false;
  if (atxHeading(content)) return true;
  if (tryFence(content)) return true;
  if (isHr(content)) return true;
  const hb = tryHtmlBlock(content);
  if (hb && hb.kind <= 6) return true;
  if (content[0] === '>') return true;
  const lm = listMarkerInfo(rest, base);
  if (lm) {
    // A list marker interrupts a paragraph only when its item is not
    // empty; an ordered list also has to start at 1, except inside a
    // list item, where any ordered start interrupts (marked behaviour).
    const inItem = S.stack.some((c) => c.t === 'item');
    if (!lm.ordered) { if (lm.contentLine !== null) return true; }
    else if ((lm.start === 1 || inItem) && lm.contentLine !== null) return true;
  }
  if (content.indexOf('|') !== -1 && tryTableHeader(S, rest, base)) return true;
  return false;
}

// Is the line a body row of the open table?
function isTableRowLine(S, rest, base) {
  if (isBlankLine(rest)) return false;
  const ind = indentCols(rest, base);
  if (ind > 3) return true;
  const content = stripCols(rest, ind, base);
  if (content === '') return false;
  if (atxHeading(content)) return false;
  if (tryFence(content)) return false;
  if (isHr(content)) return false;
  const hb = tryHtmlBlock(content);
  if (hb && hb.kind <= 6) return false;
  if (content[0] === '>') return false;
  if (listMarkerInfo(rest, base)) return false;
  return true;
}

function openBlock(S, rest, base) {
  const ind = indentCols(rest, base);
  if (ind <= 3) {
    const content = stripCols(rest, ind, base);
    const atx = atxHeading(content);
    if (atx) {
      addNode(S, { t: 'h', level: atx.level, src: atx.src });
      S.i++;
      return;
    }
    const fence = tryFence(content);
    if (fence) {
      const code = addNode(S, {
        t: 'code', fence: true, char: fence.char, len: fence.len,
        info: fence.info, indent: ind, lines: [], lastIdx: S.i,
      });
      S.leaf = code;
      S.i++;
      return;
    }
    const hb = tryHtmlBlock(content);
    if (hb) {
      const html = addNode(S, {
        t: 'html', lines: [rest], endKind: hb.kind <= 5 ? 'marker' : 'blank',
        end: hb.end, lowerEnd: hb.end ? hb.end.toLowerCase() : null,
        lastIdx: S.i, trailingNL: false,
      });
      if (hb.kind <= 5 && rest.toLowerCase().indexOf(html.lowerEnd) !== -1) {
        // A one-line marker-kind block: its newline is kept unless the
        // next line is blank.
        const next = S.lines[S.i + 1];
        html.trailingNL = (next === undefined ? S.lastTerminated :
          !isBlankLine(next)) &&
          (S.i < S.lines.length - 1 || S.lastTerminated);
        S.i++;
        return;
      }
      S.leaf = html;
      S.i++;
      return;
    }
    if (isHr(content)) {
      addNode(S, { t: 'hr' });
      S.i++;
      return;
    }
    if (content[0] === '>') {
      const bq = addNode(S, { t: 'bq', children: [] });
      S.stack.push(bq);
      const bp = matchBqPrefix(rest, base);
      phase2(S, bp.rest, bp.base);
      return;
    }
    const lm = listMarkerInfo(rest, base);
    if (lm) {
      const list = addNode(S, {
        t: 'list', ordered: lm.ordered, start: lm.start, delim: lm.delim,
        bullet: lm.bullet, tight: true, children: [],
      });
      S.stack.push(list);
      openItemInto(S, list, lm);
      return;
    }
    if (content.indexOf('|') !== -1) {
      const tbl = tryTableHeader(S, rest, base);
      if (tbl) {
        const table = addNode(S, {
          t: 'table', aligns: tbl.aligns, header: tbl.headerCells, rows: [],
          lastIdx: S.i,
        });
        S.leaf = table;
        S.i += 2;
        return;
      }
    }
    // A paragraph keeps its first line's leading spaces (up to 3): marked
    // does not strip the indent of a paragraph's opening line.
    const para = addNode(S, { t: 'para', lines: [rest] });
    S.leaf = para;
    S.i++;
    return;
  }
  const code = addNode(S, {
    t: 'code', fence: false, info: '', lines: [stripCols(rest, 4, base)],
    pendingBlanks: [], lastIdx: S.i,
  });
  S.leaf = code;
  S.i++;
}

function phase2(S, rest, base) {
  if (isBlankLine(rest)) {
    const leaf = S.leaf;
    if (leaf && leaf.t === 'code' && leaf.fence) {
      // Keep the line's spaces (after the fence indent): a blank line of
      // two spaces inside fenced code is content, not an empty line.
      leaf.lines.push(stripCols(rest, leaf.indent, base));
      leaf.lastIdx = S.i;
      S.i++;
      return;
    }
    if (leaf && leaf.t === 'html' && leaf.endKind === 'marker') {
      leaf.lines.push('');
      leaf.lastIdx = S.i;
      S.i++;
      return;
    }
    if (leaf && leaf.t === 'code' && !leaf.fence) {
      // A blank line inside indented code contributes what is left of it
      // after the 4-column strip (a 6-space blank line contributes 2
      // spaces); it is only flushed if the code continues.
      leaf.pendingBlanks.push(stripCols(rest, 4, base));
      S.i++;
      return;
    }
    if (leaf && leaf.t === 'table' && indentCols(rest, base) > 3) {
      // A whitespace-only line indented more than 3 columns (e.g. a
      // lone tab) is a table row of empty cells, not the end of the
      // table; a line indented 3 or fewer closes it.
      const t = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      leaf.rows.push(trimPipeCells(splitCells(t), t));
      leaf.lastIdx = S.i;
      S.i++;
      return;
    }
    if (leaf && leaf.t === 'para' && rest !== '' &&
      S.stack[S.stack.length - 1].t === 'bq') {
      // A line that is only spaces after its '>' prefix is a paragraph
      // continuation inside the quote (it contributes its spaces), not
      // a blank line that ends the paragraph (cm-241).
      leaf.lines.push(rest);
      S.i++;
      return;
    }
    closeLeaf(S);
    // A blank line that separates blocks: the next block may loosen its
    // list (a blank line inside fenced code or a marker-kind HTML block
    // above is content, not a separator, and does not reach here). A
    // blank line inside a blockquote is a separator only for the quote's
    // own content, not for a list outside it.
    const top = S.stack[S.stack.length - 1];
    S.lastLineBlank = top.t !== 'bq';
    // A blank line after an empty list item closes the item: indented
    // content after the blank line is not part of it.
    if (top.t === 'item' && top.children.length === 0) {
      closeTo(S, S.stack.length - 1);
    }
    S.i++;
    return;
  }
  const leaf = S.leaf;
  if (leaf) {
    if (leaf.t === 'para') {
      const st = setextLevel(rest, base);
      if (st) {
        const text = leaf.lines.join('\n');
        let pos = 0;
        while (pos < text.length) {
          const def = parseRefDef(text, pos, S.refs);
          if (!def) break;
          pos = def.end;
        }
        const src = text.slice(pos);
        if (src.replace(/[ \t\n]/g, '') === '') {
          leaf.parent.children.pop();
          S.leaf = null;
          openBlock(S, rest, base);
          return;
        }
        // A setext heading's text is trimmed on both ends.
        const hsrc = src.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
        const parent = leaf.parent;
        parent.children[parent.children.length - 1] = { t: 'h', level: st, src: hsrc };
        S.leaf = null;
        S.i++;
        return;
      }
      if (startsInterruptBlock(S, rest, base)) {
        closeLeaf(S);
        openBlock(S, rest, base);
        return;
      }
      // A continuation line keeps its leading spaces, except after a
      // hard break (the previous line ends with 2+ spaces or a
      // backslash), where the next line's indent is stripped.
      const prev = leaf.lines[leaf.lines.length - 1] || '';
      const hardBreak = /[ \t]{2}$/.test(prev) ||
        (prev.endsWith('\\') && !prev.endsWith('\\\\'));
      leaf.lines.push(hardBreak ? rest.replace(/^[ \t]+/, '') : rest);
      S.i++;
      return;
    }
    if (leaf.t === 'code' && leaf.fence) {
      const ind = indentCols(rest, base);
      if (ind <= 3) {
        const content = stripCols(rest, ind, base);
        let k = 0;
        while (k < content.length && content[k] === leaf.char) k++;
        if (k >= leaf.len && /^[ \t]*$/.test(content.slice(k))) {
          closeLeaf(S);
          S.i++;
          return;
        }
      }
      // Fenced-code content strips the fence indent. A tab sitting just
      // past the stripped indent is expanded to the spaces up to the next
      // tab stop when the content does not start at column 0 (a top-level
      // fence keeps a leading tab literally).
      const stripped = stripCols(rest, leaf.indent, base);
      const bqTop = S.stack.length > 2 && S.stack[S.stack.length - 1].t === 'bq';
      const tabCol = base + leaf.indent - (bqTop ? 2 : 0);
      leaf.lines.push(base > 0
        ? expandLeadingTabs(stripped, tabCol) : stripped);
      leaf.lastIdx = S.i;
      S.i++;
      return;
    }
    if (leaf.t === 'code') {
      const ind = indentCols(rest, base);
      if (ind >= 4) {
        for (let b = 0; b < leaf.pendingBlanks.length; b++) {
          leaf.lines.push(leaf.pendingBlanks[b]);
        }
        leaf.pendingBlanks = [];
        leaf.lines.push(stripCols(rest, 4, base));
        leaf.lastIdx = S.i;
        S.i++;
        return;
      }
      closeLeaf(S);
      phase2(S, rest, base);
      return;
    }
    if (leaf.t === 'html') {
      leaf.lines.push(rest);
      leaf.lastIdx = S.i;
      if (leaf.endKind === 'marker' &&
        rest.toLowerCase().indexOf(leaf.lowerEnd) !== -1) {
        closeLeaf(S);
      }
      S.i++;
      return;
    }
    if (leaf.t === 'table') {
      if (isTableRowLine(S, rest, base)) {
        const t = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        leaf.rows.push(trimPipeCells(splitCells(t), t));
        S.i++;
        return;
      }
      closeLeaf(S);
      phase2(S, rest, base);
      return;
    }
    return;
  }
  for (;;) {
    const top = S.stack[S.stack.length - 1];
    if (top.t !== 'list') break;
    // A thematic break takes precedence over a same-list marker
    // (* * * is an <hr>, not a new list item): do not treat it as a
    // marker, so the list closes and openBlock makes it an <hr>.
    const lind = indentCols(rest, base);
    const isHrLine = lind <= 3 && isHr(stripCols(rest, lind, base));
    const lm = isHrLine ? null : listMarkerInfo(rest, base);
    if (lm && isSameList(top, lm)) {
      openItemInto(S, top, lm);
      return;
    }
    closeTo(S, S.stack.length - 1);
  }
  openBlock(S, rest, base);
}

function processLine(S) {
  const line = S.lines[S.i];
  for (;;) {
    const m = matchContainers(S, line);
    if (m.failDepth === -1) {
      phase2(S, m.rest, m.base);
      // A non-blank line consumes the blank-line flag; a blank line (in
      // context) leaves it set for the next block.
      if (!isBlankLine(m.rest)) S.lastLineBlank = false;
      return;
    }
    const leaf = S.leaf;
    // A fenced code block absorbs its content lines even when they do
    // not match an enclosing LIST ITEM's indent (a line at column 0
    // stays code). A line that fails a BLOCKQUOTE marker is not absorbed:
    // it closes the quote (and the code block inside it). A line that
    // fails its containers can never be the closing fence.
    const failed = S.stack[m.failDepth];
    if (leaf && leaf.t === 'code' && leaf.fence && !isBlankLine(line) &&
      failed && failed.t === 'item' && leaf.lines.length > 0) {
      const stripped = stripCols(m.rest, leaf.indent, m.base);
      const bqTop = S.stack.length > 2 && S.stack[S.stack.length - 1].t === 'bq';
      const tabCol = m.base + leaf.indent - (bqTop ? 2 : 0);
      leaf.lines.push(m.base > 0
        ? expandLeadingTabs(stripped, tabCol) : stripped);
      leaf.lastIdx = S.i;
      S.i++;
      S.lastLineBlank = false;
      return;
    }
    if (leaf && leaf.t === 'para' && !isBlankLine(line) && !isBlankLine(m.rest)) {
      // A list marker at the level of an enclosing list is never a lazy
      // continuation: it closes the item and starts a new item or list
      // (this covers ordered markers not starting at 1 and empty items,
      // which do not interrupt a paragraph on their own).
      const lm = listMarkerInfo(m.rest, m.base);
      const enc = m.failDepth > 0 ? S.stack[m.failDepth - 1] : null;
      const listMarker = lm && enc && enc.t === 'list';
      if (!listMarker && !startsInterruptBlock(S, m.rest, m.base)) {
        // A lazy continuation inside a list item loses the item's indent.
        let cont = m.rest;
        const failed = S.stack[m.failDepth];
        if (failed && failed.t === 'item') {
          cont = stripCols(m.rest, failed.contentIndent, m.base);
        }
        // A lazy line that looks like a setext underline is kept literal
        // but indented by 4 spaces (it must not become a heading
        // underline); any other lazy line loses its leading whitespace,
        // except when an outer container prefix was already matched
        // (m.base > 0, e.g. a '> '): the rest's leading spaces are the
        // content after that prefix, not indentation to strip.
        const trimmed = cont.replace(/^[ \t]+/, '');
        if (/^=+[ \t]*$/.test(trimmed) || /^-+[ \t]*$/.test(trimmed)) {
          leaf.lines.push('    ' + trimmed);
        } else if (m.base > 0) {
          // After a hard break the next line's indent is stripped,
          // even on a lazy line; otherwise the rest's leading spaces
          // are content (e.g. after a '>' or a tab remainder).
          const prev = leaf.lines[leaf.lines.length - 1] || '';
          const hardBreak = /[ \t]{2}$/.test(prev) ||
            (prev.endsWith('\\') && !prev.endsWith('\\\\'));
          leaf.lines.push(hardBreak ? trimmed : m.rest);
        } else {
          leaf.lines.push(trimmed);
        }
        S.i++;
        S.lastLineBlank = false;
        return;
      }
    }
    closeTo(S, m.failDepth);
  }
}

function parseBlocks(lines, lastTerminated) {
  const S = {
    lines, lastTerminated, refs: new Map(), stack: null, leaf: null, i: 0,
    lastLineBlank: false,
  };
  const doc = { t: 'doc', children: [] };
  S.stack = [doc];
  while (S.i < lines.length) processLine(S);
  closeAll(S);
  return { doc, refs: S.refs };
}

// ---------- rendering ----------

function renderList(list, refs) {
  let out = list.ordered
    ? (list.start !== 1 ? '<ol start="' + list.start + '">\n' : '<ol>\n')
    : '<ul>\n';
  for (const item of list.children) {
    out += '<li>' + renderItem(item, list.tight, refs) + '</li>\n';
  }
  out += list.ordered ? '</ol>\n' : '</ul>\n';
  return out;
}

function renderItem(item, tight, refs) {
  let out = '';
  const children = item.children;
  const first = children[0];
  let checkbox = null;
  if (first && first.t === 'para' && first.src !== undefined) {
    const src = first.src;
    const nl = src.indexOf('\n');
    const firstLine = nl === -1 ? src : src.slice(0, nl);
    const m = /^\[([ xX])\](?:[ \t]|$)/.exec(firstLine);
    if (m) {
      checkbox = m[1] === ' '
        ? '<input disabled="" type="checkbox">'
        : '<input checked="" disabled="" type="checkbox">';
      const restFirst = firstLine.slice(3).replace(/^[ \t]+/, '');
      if (restFirst === '' && nl !== -1) first.src = src.slice(nl + 1);
      else first.src = restFirst + (nl === -1 ? '' : src.slice(nl));
    }
  }
  // The checkbox is followed by one space. In a loose item it sits inside
  // the first paragraph (<p><input ...> text</p>); in a tight item it
  // precedes the inline text directly.
  const after = checkbox !== null && first && first.src !== '' ? ' ' : '';
  for (let ci = 0; ci < children.length; ci++) {
    const child = children[ci];
    if (ci === 0 && checkbox !== null && child.t === 'para' && !tight) {
      out += '<p>' + checkbox + after + inline(child.src, refs) + '</p>\n';
    } else if (ci === 0 && checkbox !== null) {
      out += checkbox + after;
      if (child.t === 'para' && tight) out += inline(child.src, refs);
      else out += renderBlock(child, refs);
    } else if (child.t === 'para' && tight) out += inline(child.src, refs);
    else out += renderBlock(child, refs);
  }
  return out;
}

function renderTable(table, refs) {
  const aligns = table.aligns;
  const ncols = aligns.length;
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < ncols; c++) {
    const cell = c < table.header.length ? table.header[c].trim() : '';
    const a = aligns[c];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
      inline(cell, refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  // No body rows: no <tbody> at all (gfm-205).
  if (table.rows.length === 0) return out + '</table>\n';
  out += '<tbody>';
  for (const row of table.rows) {
    out += '<tr>\n';
    for (let c = 0; c < ncols; c++) {
      const cell = c < row.length ? row[c].trim() : '';
      const a = aligns[c];
      out += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
        inline(cell, refs) + '</td>\n';
    }
    out += '</tr>\n';
  }
  out += '</tbody></table>\n';
  return out;
}

function renderBlock(node, refs) {
  switch (node.t) {
    case 'para':
      return '<p>' + inline(node.src, refs) + '</p>\n';
    case 'h':
      return '<h' + node.level + '>' + inline(node.src, refs) +
        '</h' + node.level + '>\n';
    case 'code': {
      let lang = '';
      if (node.fence && node.info) {
        const sp = node.info.search(/[ \t]/);
        const w = sp === -1 ? node.info : node.info.slice(0, sp);
        lang = ' class="language-' + esc(unescape(w)) + '"';
      }
      // A trailing blank line before the closing fence is not content
      // (it would otherwise double the final newline); a leading blank
      // line is content. Strip at most ONE trailing empty line: the
      // closing fence absorbs one, further blanks are content.
      let end = node.lines.length;
      if (end > 1 && node.lines[end - 1] === '' &&
        node.lines.slice(0, end - 1).some((l) => l !== '')) end--;
      let content = node.lines.slice(0, end).join('\n');
      if (node.trailingNL && node.lines.length > 0 &&
        node.lines.some((l) => l !== '')) content += '\n';
      return '<pre><code' + lang + '>' + escPlain(content) + '</code></pre>\n';
    }
    case 'html': {
      let content = node.lines.join('\n');
      if (node.trailingNL) content += '\n';
      return content;
    }
    case 'hr':
      return '<hr>\n';
    case 'bq': {
      let out = '<blockquote>\n';
      for (const child of node.children) out += renderBlock(child, refs);
      return out + '</blockquote>\n';
    }
    case 'list':
      return renderList(node, refs);
    case 'table':
      return renderTable(node, refs);
    default:
      return '';
  }
}

function renderDoc(doc, refs) {
  let out = '';
  for (const child of doc.children) out += renderBlock(child, refs);
  return out;
}

export function parse(src) {
  if (typeof src !== 'string') src = String(src);
  if (src === '') return '';
  const text = src.replace(/\r\n?/g, '\n');
  const lastTerminated = text.endsWith('\n');
  const lines = text.split('\n');
  // A trailing newline leaves a phantom empty line after the split; it is
  // not a real line (it would otherwise be swallowed into fenced code and
  // marker-kind HTML blocks as a spurious blank line).
  if (lastTerminated) lines.pop();
  const { doc, refs } = parseBlocks(lines, lastTerminated);
  return renderDoc(doc, refs);
}
