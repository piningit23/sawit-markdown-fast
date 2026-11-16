import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

// The process driver stages the mounts under MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR; in the grading container they are /input and
// /output (the env vars are unset there, so the fallback applies).
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'));
const html = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + '/html.json', JSON.stringify(html));
