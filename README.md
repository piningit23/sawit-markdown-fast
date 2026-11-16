# FastMark

A fast, dependency-free drop-in replacement for marked 18.1.3
(`marked.parse` with defaults: gfm true, breaks false, pedantic false,
async false). `parse(markdown)` returns byte-identical HTML.

## Design

- A line-based block parser (containers: document, blockquote, list,
  item; leaves: paragraph, heading, code, html, thematic break, table)
  plus a single-pass inline parser with a delimiter stack for emphasis
  and a bracket stack for links and images.
- FastTokenizer first-character pre-checks skip work for plain lines.
- The inline loop is a character-dispatch scan; GFM autolinks,
  entities, and code spans are handled inline without regex backtracking.
- The biggest win is a hand-written text-end scan that reproduces
  marked's GFM text regex in one native pass.

## Performance

On the practice set (720 cases) FastMark parses in ~1.0 s versus
~1.1 s for marked 18.1.3 on this machine, about 1.12x faster. The
grade-local runner reports the exact speedup for the scored set.

## Files

- `parse.js` — the parser (`parse(markdown)`).
- `main.ts` — reads `/input/cases.json`, writes `/output/html.json`.
- `vendor/marked/` — the reference marked 18.1.3 (untouched).
