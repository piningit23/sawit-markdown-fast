// FastMark driver — the program the harness runs as `node /bot/main.ts`
// (Node 22, TypeScript types stripped natively; erasable syntax only).
//
// It reads the whole case set, renders every case on its own with parse()
// from parse.js, and writes the HTML strings back in the cases' order.
// The input and output directories come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR when they are set (the process driver stages the
// set through them); otherwise they fall back to /input and /output,
// the mounts the grading container provides.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8')
) as Case[];

// One HTML string per case, in the cases' order. Each case is rendered
// alone, from a fresh parse, so no state can leak from one case into
// the next; the two graded executions therefore always agree, and a
// case that throws would fail loudly here instead of silently shifting
// every case after it.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
