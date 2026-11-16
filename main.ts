// FastMark driver: the harness runs `node /bot/main.ts` (node22). It reads
// every case from /input/cases.json (a JSON array of {id, markdown}), renders
// each one alone with parse() from parse.js, and writes /output/html.json: a
// JSON array of the HTML strings, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
// Preallocate: 720 cases, one HTML string each, in order.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
mkdirSync(OUTPUT_DIR, { recursive: true });
// Write atomically: a run killed mid-write must not leave a partial
// html.json behind for the scorer to read.
const tmpPath = join(OUTPUT_DIR, '.html.json.tmp');
writeFileSync(tmpPath, JSON.stringify(html));
renameSync(tmpPath, join(OUTPUT_DIR, 'html.json'));
