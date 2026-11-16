# FastMark — a faster drop-in for marked 18.1.3

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/piningit23/sawit-markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/piningit23/sawit-markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

`parse(markdown)` returns exactly the HTML that `marked.parse(markdown)`
returns with marked's default options (GFM on, breaks off, pedantic off,
async off) — only faster.

## How it works

FastMark does not re-implement Markdown. It runs marked's own `Lexer`
and `Parser` (vendored under `vendor/marked/`, MIT) with a `Tokenizer`
subclass, `FastTokenizer`, that refuses impossible matches before
marked's regular expressions ever run.

Every fast path is a *necessary* condition for the rule it guards: a
rule anchored at the start of the remaining source can only match when
the first character can begin it. When the check fails, the tokenizer
returns `undefined` exactly as marked would; when it passes, the rule
runs unchanged through `super`. So no output is ever guessed, nothing
is cached across cases, and any input the fast paths do not recognise
falls through to marked itself.

Concretely, at every inline position the checks skip the escape, tag,
link, reference-link, shortcut-link, emphasis, code-span, hard-break,
strikethrough and autolink expressions unless the character in front
can open one; at block level they skip blank-line, indented-code,
fence, heading, rule, quote, list, HTML-block and definition tries
the same way. Tables and setext headings are skipped when the rest of
the document has no newline left, since both need a second line. The
`url` and `text` inline rules are left to marked: a bare address can
start an extended autolink, and text matches anything.

## Files

- `parse.js` — the drop-in. Exports `parse(markdown)`.
- `main.ts` — the driver the harness runs: reads the case set from
  `MAKEFUN_INPUT_DIR` (fallback `/input`), renders each case alone,
  writes the HTML array to `MAKEFUN_OUTPUT_DIR` (fallback `/output`).
- `vendor/marked/` — marked 18.1.3, byte for byte from npm, with its
  LICENSE and NOTICE.

## Run it

```sh
node main.ts
```

With a staged set outside a container:

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

## Status

Practice set (680 CommonMark + GFM spec examples, 40 generated
documents): byte-identical on every case, and faster than stock marked
on the same machine.
