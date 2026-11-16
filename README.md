# FastMark

A faster drop-in for [marked](https://github.com/markedjs/marked) 18.1.3.
`parse(markdown)` in `parse.js` returns exactly the HTML that
`marked.parse(markdown)` returns with marked's default options
(GFM on, breaks off, pedantic off, async off), only faster.

## How it stays identical

FastMark does not reimplement Markdown. It subclasses marked itself
(vendored unchanged under `vendor/marked/`, MIT) and only changes *which*
tokenizer runs *when*:

- **Block level** — `FastTokenizer` adds first-character pre-checks to
  every block tokenizer, so the big block regexes only run when the line
  can possibly match. Uniform, tight, plain-text lists take a string-scan
  fast path (`tryFastList`); anything else falls back to marked's list
  tokenizer.
- **Inline level** — `FastLexer.inlineTokens` dispatches on the first
  character instead of running ten inline regexes at every position, in
  marked's own try order. The stock tokenizer methods still build every
  token, so emphasis, links, code spans, autolinks and entities behave
  exactly as marked does. Link / code-span / tag spans are masked out of
  the emphasis scan, exactly as marked does.

No output is cached and no case HTML is hardcoded: every input is lexed
and parsed fresh, so the result is marked's result for every string.

## Layout

- `parse.js` — the entry: `export function parse(markdown)`.
- `main.ts` — the driver the harness runs: reads `cases.json`, writes
  `html.json`.
- `vendor/marked/` — stock marked 18.1.3 (MIT, see `LICENSE`/`NOTICE`).

## License

MIT — see `LICENSE`. The vendored marked keeps its own license and notice.
