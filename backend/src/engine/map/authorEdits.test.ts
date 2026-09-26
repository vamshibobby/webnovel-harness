/**
 * Author edits leave the rest of the map alone.
 *   npx tsx src/engine/map/authorEdits.test.ts
 *
 * No LLM, no network. This exists because of a real report: dragging one
 * settlement re-derived every region border on the map — the Voronoi that
 * carves them is seeded by every settlement, so an edit to one place moved
 * borders the author never touched.
 */
import { applyBorderEdit, applyPinEdit } from './authorEdits.js';
import { deriveShapes } from './regions.js';
import { solveMap } from './solver.js';
import { handleUpsertGeofacts, type ToolContext } from './tools.js';
import { fnv1a } from './prng.js';
import type { GeoEntity, GeoFact, GeoMap, GeoRelation } from './types.js';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const entity = (id: string, kind: GeoEntity['kind']): GeoEntity => ({
  id,
  kind,
  name: id,
  aliases: [],
  bibleEntryId: null,
  importance: 2,
  firstChapter: 1,
});

let factSeq = 0;
const fact = (relation: GeoRelation): GeoFact => ({
  id: `f-1-${++factSeq}`,
  relation,
  confidence: 'stated',
  chapter: 1,
  supersededBy: null,
});

/** Two bordering regions with towns in each — enough for real shared borders. */
function fixture(): GeoMap {
  const map: GeoMap = {
    id: 'world',
    scope: 'world',
    title: 'Test World',
    seed: fnv1a('world'),
    entities: {},
    facts: [],
    layout: null,
    createdChapter: 1,
    updatedChapter: 1,
  };
  for (const e of [
    entity('east-realm', 'region'),
    entity('west-realm', 'region'),
    entity('ashford', 'settlement'),
    entity('brine', 'settlement'),
    entity('cairn', 'settlement'),
  ]) {
    map.entities[e.id] = e;
  }
  map.facts = [
    fact({ type: 'adjacent-region', a: 'east-realm', b: 'west-realm' }),
    fact({ type: 'within', subject: 'ashford', container: 'east-realm' }),
    fact({ type: 'within', subject: 'brine', container: 'east-realm' }),
    fact({ type: 'within', subject: 'cairn', container: 'west-realm' }),
    fact({ type: 'direction', subject: 'ashford', anchor: 'brine', dir: 'N' }),
  ];
  const result = solveMap(map, map.facts.map((f) => f.id));
  if (!result.ok) throw new Error('fixture failed to solve');
  deriveShapes(map, result.layout);
  map.layout = result.layout;
  return map;
}

const polySnapshot = (map: GeoMap) => JSON.stringify(map.layout!.regionPolygons);

console.log('\nDragging a settlement moves the settlement and nothing else:');
{
  const map = fixture();
  const before = polySnapshot(map);
  const othersBefore = JSON.stringify(
    Object.fromEntries(Object.entries(map.layout!.positions).filter(([id]) => id !== 'ashford'))
  );
  const ok = applyPinEdit(map, 'ashford', { x: 321, y: 654 });
  check('the edit applies', ok);
  check('the settlement sits exactly where it was dropped', map.layout!.positions['ashford'].x === 321 && map.layout!.positions['ashford'].y === 654);
  check('it is pinned against future extraction', map.entities['ashford'].pin?.x === 321);
  check('every region border is byte-identical', polySnapshot(map) === before);
  check(
    'no other place moved',
    JSON.stringify(
      Object.fromEntries(Object.entries(map.layout!.positions).filter(([id]) => id !== 'ashford'))
    ) === othersBefore
  );
}

console.log('\nDragging a region carries its own shape and leaves the neighbour:');
{
  const map = fixture();
  const eastBefore = map.layout!.regionPolygons['east-realm'].map((p) => [...p]);
  const westBefore = JSON.stringify(map.layout!.regionPolygons['west-realm']);
  const prior = { ...map.layout!.positions['east-realm'] };
  applyPinEdit(map, 'east-realm', { x: prior.x + 100, y: prior.y - 50 });
  const eastAfter = map.layout!.regionPolygons['east-realm'];
  const translated = eastBefore.every(
    ([x, y], i) => Math.abs(eastAfter[i][0] - (x + 100)) < 0.01 && Math.abs(eastAfter[i][1] - (y - 50)) < 0.01
  );
  check('its polygon translates exactly with it', translated);
  check("the neighbour's border does not stir", JSON.stringify(map.layout!.regionPolygons['west-realm']) === westBefore);
}

console.log('\nAn author-dragged border is canon:');
{
  const map = fixture();
  const shape = [
    { x: 200, y: 200 },
    { x: 400, y: 180 },
    { x: 450, y: 400 },
    { x: 220, y: 420 },
  ];
  const problem = applyBorderEdit(map, 'east-realm', shape);
  check('the edit is accepted', problem === null);
  check('the polygon becomes the drawn shape', map.layout!.regionPolygons['east-realm'].length === 4);
  check('it is stored on the entity like a pin', map.entities['east-realm'].border?.length === 4);

  // A later chapter adds geography — the exact path that used to redraw
  // everything. The author's border must come through untouched.
  const authored = JSON.stringify(map.layout!.regionPolygons['east-realm']);
  const ctx: ToolContext = { map, chapter: 2, createRationales: [] };
  const reply = handleUpsertGeofacts(ctx, {
    entities: [
      { id: 'east-realm', kind: 'region', name: 'east-realm' },
      { id: 'dunmere', kind: 'settlement', name: 'dunmere' },
    ],
    facts: [{ relation: { type: 'within', subject: 'dunmere', container: 'east-realm' }, confidence: 'stated' }],
  });
  check('the extraction succeeds', reply.startsWith('Updated'), reply.slice(0, 60));
  check('the border survives the entity upsert', ctx.map!.entities['east-realm'].border?.length === 4);
  check('re-derived shapes keep the authored border', JSON.stringify(ctx.map!.layout!.regionPolygons['east-realm']) === authored);
  check(
    "the neighbour still derives normally",
    (ctx.map!.layout!.regionPolygons['west-realm'] ?? []).length >= 3
  );

  // …and dragging the region afterwards carries the authored border along.
  const pos = { ...ctx.map!.layout!.positions['east-realm'] };
  applyPinEdit(ctx.map!, 'east-realm', { x: pos.x + 40, y: pos.y });
  const border = ctx.map!.entities['east-realm'].border!;
  check('a later drag translates the authored border too', Math.abs(border[0].x - (shape[0].x + 40)) < 0.01);
}

console.log('\nGuard rails:');
{
  const map = fixture();
  check('a settlement has no border to edit', applyBorderEdit(map, 'ashford', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]) === 'Only a region has a border to reshape.');
  check('a two-point border is refused', applyBorderEdit(map, 'east-realm', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]) === 'A border needs at least three points.');
  check('an unknown entity is refused', applyBorderEdit(map, 'nowhere', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]) === 'No such place on the map.');
  const unsolved = fixture();
  unsolved.layout = null;
  check('a pin edit with no layout reports itself for the solve fallback', applyPinEdit(unsolved, 'ashford', { x: 1, y: 2 }) === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
