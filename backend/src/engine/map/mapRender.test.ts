/**
 * Phase 3 — the renderer.
 *   npx tsx render.test.ts            # verify against goldens
 *   npx tsx render.test.ts --update   # rewrite goldens after an intended change
 *
 * Gates: identical map → byte-identical SVG across runs (and vs the checked-in
 * golden); both-theme previews written for the human pass; labels never
 * dropped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveShapes } from './regions.js';
import { renderMap } from './render.js';
import { solveMap } from './solver.js';
import { fnv1a } from './prng.js';
import type { GeoEntity, GeoFact, GeoMap, GeoRelation } from './types.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const UPDATE = process.argv.includes('--update');

// ── A representative world: two realms, a sea, mountains, roads ──────────

const entity = (
  id: string,
  kind: GeoEntity['kind'],
  name: string,
  importance: 1 | 2 | 3 = 2
): GeoEntity => ({ id, kind, name, aliases: [], bibleEntryId: null, importance, firstChapter: 1 });

function buildFixtureMap(): GeoMap {
  const map: GeoMap = {
    id: 'render-fixture',
    scope: 'world',
    title: 'The Salt Road',
    seed: fnv1a('render-fixture'),
    entities: {},
    facts: [],
    layout: null,
    createdChapter: 2,
    updatedChapter: 8,
  };
  const entities = [
    entity('ashen-dominion', 'region', 'Ashen Dominion'),
    entity('veldt-marches', 'region', 'Veldt Marches'),
    entity('velmora', 'settlement', 'Velmora', 2),
    entity('cindral', 'settlement', 'Cindral', 3),
    entity('kessa', 'settlement', 'Kessa', 1),
    entity('sea-of-glass', 'water', 'Sea of Glass', 3),
    entity('worldteeth', 'mountain-range', 'The Worldteeth'),
    entity('old-kings-road', 'road', "Old Kings' Road"),
    entity('pale-kingdoms', 'landmark', 'Pale Kingdoms', 1),
  ];
  for (const e of entities) map.entities[e.id] = e;

  const relations: Array<[GeoRelation, number, GeoFact['confidence']]> = [
    [{ type: 'within', subject: 'velmora', container: 'ashen-dominion' }, 2, 'stated'],
    [{ type: 'within', subject: 'cindral', container: 'ashen-dominion' }, 2, 'stated'],
    [{ type: 'direction', subject: 'cindral', anchor: 'velmora', dir: 'S' }, 2, 'stated'],
    [{ type: 'distance', a: 'cindral', b: 'velmora', degree: 'far' }, 2, 'stated'],
    [{ type: 'on-coast', subject: 'cindral', water: 'sea-of-glass' }, 3, 'stated'],
    [{ type: 'direction', subject: 'velmora', anchor: 'ashen-dominion', dir: 'E' }, 5, 'stated'],
    [{ type: 'adjacent-region', a: 'veldt-marches', b: 'ashen-dominion' }, 6, 'stated'],
    [{ type: 'within', subject: 'kessa', container: 'veldt-marches' }, 6, 'stated'],
    [{ type: 'connects', road: 'old-kings-road', a: 'cindral', b: 'kessa' }, 6, 'stated'],
    [{ type: 'between', subject: 'worldteeth', a: 'ashen-dominion', b: 'veldt-marches' }, 7, 'stated'],
    [{ type: 'direction', subject: 'pale-kingdoms', anchor: 'veldt-marches', dir: 'W' }, 8, 'implied'],
    [{ type: 'distance', a: 'pale-kingdoms', b: 'veldt-marches', degree: 'far' }, 8, 'implied'],
  ];
  relations.forEach(([relation, chapter, confidence], i) => {
    map.facts.push({ id: `f-${chapter}-${i}`, relation, confidence, chapter, supersededBy: null });
  });

  const result = solveMap(map, map.facts.map((f) => f.id));
  if (!result.ok) throw new Error(`fixture failed to solve: ${result.contradiction.message}`);
  deriveShapes(map, result.layout);
  map.layout = result.layout;
  return map;
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'out'), { recursive: true });
mkdirSync(join(here, 'golden'), { recursive: true });

const map = buildFixtureMap();

// ── 1. Determinism / golden ───────────────────────────────────────────────

const svg1 = renderMap(map);
const svg2 = renderMap(buildFixtureMap());
check('identical map renders byte-identical SVG', svg1 === svg2);

const goldenPath = join(here, 'golden/salt-road.svg');
if (UPDATE || !existsSync(goldenPath)) {
  writeFileSync(goldenPath, svg1);
  console.log(`  (golden ${UPDATE ? 'updated' : 'created'}: ${goldenPath})`);
}
check('matches the checked-in golden', svg1 === readFileSync(goldenPath, 'utf8'));

// ── 2. Content sanity ─────────────────────────────────────────────────────

check('every named entity is labelled', ['Velmora', 'Cindral', 'Kessa', 'SEA OF GLASS', 'ASHEN DOMINION', 'VELDT MARCHES', 'The Worldteeth', 'Pale Kingdoms'].every((n) => svg1.includes(n)));
check('the sea is the ground, land is carved from it', svg1.includes('clipPath') && svg1.includes('var(--wn-surface)'));
check('the legend explains the dash convention', svg1.includes('hypothetical') && svg1.includes('confirmed'));
check('rough locations are called out', svg1.includes('rough locations'));
check('no external references (CSP-safe)', !/https?:\/\//.test(svg1.replace('http://www.w3.org/2000/svg', '')));
check('tokens, not hex, in the app-facing render', svg1.includes('var(--wn-ink)'));

// Both regions border-pinned? The Dominion has adjacent-region + a coast via
// its member; the Marches has adjacent-region — both should carry SOME solid
// border, and the fixture has hypothetical elements too (implied-only Pale
// Kingdoms is a rough location, and dashes exist for unpinned stretches).
check('dashed strokes present (hypothetical geometry exists)', svg1.includes('stroke-dasharray="6 4"'));

// ── 3. Theme previews for the human pass ──────────────────────────────────

const light = renderMap(map, { resolveTokens: 'light' });
const dark = renderMap(map, { resolveTokens: 'dark' });
writeFileSync(join(here, 'out/salt-road.light.svg'), light);
writeFileSync(join(here, 'out/salt-road.dark.svg'), dark);
check('resolved-token renders contain no CSS variables (EPUB-safe)', !light.includes('var(--') && !dark.includes('var(--'));

writeFileSync(
  join(here, 'out/preview.html'),
  `<!doctype html><meta charset="utf-8"><title>mapgen preview</title>
<style>body{margin:0;display:grid;grid-template-columns:1fr 1fr;min-height:100vh}
section{padding:24px}section.light{background:#faf6ef}section.dark{background:#12141a}
svg{width:100%;height:auto;display:block}</style>
<section class="light">${light}</section><section class="dark">${dark}</section>`
);
console.log('  preview → out/preview.html (light | dark, for the visual verdict)');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n  ' + failures.join('\n  '));
process.exit(failures.length ? 1 : 0);
