// Driver for the FastMark entry: reads every case from
// $MAKEFUN_INPUT_DIR/cases.json (or /input/cases.json), renders each one
// alone with parse() from parse.js, and writes the HTML strings in order
// to $MAKEFUN_OUTPUT_DIR/html.json (or /output/html.json).
// Run under node 22, which strips TypeScript types natively.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const html = [];
for (const c of cases) html.push(parse(c.markdown));
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
