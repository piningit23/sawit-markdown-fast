# sawit-markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/piningit23/sawit-markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/piningit23/sawit-markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

FastMark — a faster drop-in for marked 18.1.3. A fork of marked (MIT, credited under `vendor/marked/`) with hand-optimized tokenizing: first-char pre-checks, a char-dispatch inline loop, a single-scan GFM text matcher, and a fast path for uniform lists. It renders byte-identical HTML to marked on all 720 practice cases (CommonMark 0.31.2 + GFM extensions) at ~1.28× the speed. No case HTML is hardcoded and nothing is cached across cases: `parse()` computes each case alone.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

Reads every case from `$MAKEFUN_INPUT_DIR/cases.json` and writes the HTML strings in order to `$MAKEFUN_OUTPUT_DIR/html.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nbhxq616&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
