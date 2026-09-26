/**
 * Phase 1 — the cheapest disconfirming test in the project.
 *   npx tsx solver.test.ts
 *
 * No LLM, no network. If facts cannot be turned into positions that are
 * deterministic and STABLE across incremental updates, the whole architecture
 * dies here, before a cent is spent on extraction or a line on rendering.
 *
 * Gates (from the plan): determinism exact across runs; per-step mean
 * displacement of pre-existing entities ≤ 2% of extent, max ≤ 5% except the
 * direct targets of a superseding fact; hard contradictions reported; anchor
 * conflicts resolved WITHOUT a report; 50 entities < 200ms.
 */
import { deriveShapes } from './regions.js';
import { solveMap, MAP_SIZE } from './solver.js';
import { fnv1a } from './prng.js';
import {
  DIR_ANGLE,
  activeFacts,
  relationEntityIds,
  type GeoEntity,
  type GeoFact,
  type GeoMap,
  type GeoRelation,
} from './types.js';

/**
 * Every direction fact must actually point that way. This assertion is the one
 * the suite was missing: a whole map can satisfy determinism, stability and
 * contradiction handling while drawing north as west.
 */
function directionsHonoured(map: GeoMap, toleranceDeg = 55): { ok: boolean; worst: string } {
  const P = map.layout!.positions;
  const wrap = (d: number) => {
    let x = d % 360;
    if (x > 180) x -= 360;
    if (x < -180) x += 360;
    return x;
  };
  let worstOff = 0;
  let worst = 'none';
  for (const f of activeFacts(map)) {
    if (f.relation.type !== 'direction') continue;
    const s = P[f.relation.subject];
    const a = P[f.relation.anchor];
    if (!s || !a) continue;
    const actual = (Math.atan2(s.y - a.y, s.x - a.x) * 180) / Math.PI;
    const off = Math.abs(wrap(actual - DIR_ANGLE[f.relation.dir]));
    if (off > worstOff) {
      worstOff = off;
      worst = `${f.relation.subject} ${f.relation.dir} of ${f.relation.anchor}: off by ${off.toFixed(0)}°`;
    }
  }
  return { ok: worstOff <= toleranceDeg, worst };
}

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

// ── Fixture helpers ───────────────────────────────────────────────────────

const entity = (id: string, kind: GeoEntity['kind'], chapter = 1): GeoEntity => ({
  id,
  kind,
  name: id
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' '),
  aliases: [],
  bibleEntryId: null,
  importance: 2,
  firstChapter: chapter,
});

function makeMap(id: string): GeoMap {
  return {
    id,
    scope: 'world',
    title: 'Test World',
    seed: fnv1a(id),
    entities: {},
    facts: [],
    layout: null,
    createdChapter: 1,
    updatedChapter: 1,
  };
}

let factSeq = 0;
function addFacts(
  map: GeoMap,
  chapter: number,
  additions: Array<{ e?: GeoEntity[]; r: GeoRelation[] }>
): string[] {
  const ids: string[] = [];
  for (const a of additions) {
    for (const e of a.e ?? []) map.entities[e.id] = e;
    for (const r of a.r) {
      const fact: GeoFact = {
        id: `f-${chapter}-${++factSeq}`,
        relation: r,
        confidence: 'stated',
        chapter,
        supersededBy: null,
      };
      map.facts.push(fact);
      ids.push(fact.id);
    }
  }
  map.updatedChapter = chapter;
  return ids;
}

function applySolve(map: GeoMap, newFactIds: string[]) {
  const result = solveMap(map, newFactIds);
  if (result.ok) {
    deriveShapes(map, result.layout);
    map.layout = result.layout;
  }
  return result;
}

const displacement = (
  before: Record<string, { x: number; y: number }>,
  after: Record<string, { x: number; y: number }>,
  exclude: Set<string>
) => {
  const moved: Array<{ id: string; d: number }> = [];
  for (const id of Object.keys(before)) {
    if (exclude.has(id) || !after[id]) continue;
    moved.push({ id, d: Math.hypot(after[id].x - before[id].x, after[id].y - before[id].y) });
  }
  const mean = moved.length ? moved.reduce((s, m) => s + m.d, 0) / moved.length : 0;
  const max = moved.reduce((best, m) => (m.d > best.d ? m : best), { id: '-', d: 0 });
  return { mean, max };
};

// ── The 6-step incremental script ─────────────────────────────────────────

function runScript(mapId: string): GeoMap {
  factSeq = 0;
  const map = makeMap(mapId);

  // ch1: an empire with a city in its north — the canonical create case.
  applySolve(
    map,
    addFacts(map, 1, [
      {
        e: [entity('veyron-empire', 'region'), entity('northgate', 'settlement')],
        r: [
          { type: 'within', subject: 'northgate', container: 'veyron-empire' },
          { type: 'direction', subject: 'northgate', anchor: 'veyron-empire', dir: 'N' },
        ],
      },
    ])
  );

  // ch2: a second city, south, near the first.
  applySolve(
    map,
    addFacts(map, 2, [
      {
        e: [entity('harrow', 'settlement', 2)],
        r: [
          { type: 'within', subject: 'harrow', container: 'veyron-empire' },
          { type: 'direction', subject: 'harrow', anchor: 'northgate', dir: 'S' },
          { type: 'distance', a: 'harrow', b: 'northgate', degree: 'near' },
        ],
      },
    ])
  );

  // ch3: the sea arrives; Harrow turns out to be a port.
  applySolve(
    map,
    addFacts(map, 3, [
      {
        e: [entity('sea-of-glass', 'water', 3)],
        r: [{ type: 'on-coast', subject: 'harrow', water: 'sea-of-glass' }],
      },
    ])
  );

  // ch4: a neighbouring realm with its own city.
  applySolve(
    map,
    addFacts(map, 4, [
      {
        e: [entity('veldt-reaches', 'region', 4), entity('kessa', 'settlement', 4)],
        r: [
          { type: 'adjacent-region', a: 'veldt-reaches', b: 'veyron-empire' },
          { type: 'within', subject: 'kessa', container: 'veldt-reaches' },
        ],
      },
    ])
  );

  // ch5: a road ties the realms together.
  applySolve(
    map,
    addFacts(map, 5, [
      {
        e: [entity('old-kings-road', 'road', 5)],
        r: [
          { type: 'connects', road: 'old-kings-road', a: 'kessa', b: 'harrow' },
          { type: 'distance', a: 'kessa', b: 'harrow', degree: 'near' },
        ],
      },
    ])
  );

  // ch6: canon moves Northgate to the north-EAST — supersession.
  const old = map.facts.find(
    (f) => f.relation.type === 'direction' && f.relation.subject === 'northgate'
  )!;
  const ids = addFacts(map, 6, [
    { r: [{ type: 'direction', subject: 'northgate', anchor: 'veyron-empire', dir: 'NE' }] },
  ]);
  old.supersededBy = ids[0];
  applySolve(map, ids);

  return map;
}

// ── 1. Determinism ────────────────────────────────────────────────────────

console.log('\nDeterminism:');
{
  const a = runScript('det-test');
  const b = runScript('det-test');
  const c = runScript('det-test');
  const ja = JSON.stringify(a.layout);
  check('same script → byte-identical layout, 3 runs', ja === JSON.stringify(b.layout) && ja === JSON.stringify(c.layout));
  const d = runScript('det-test-other-seed');
  check('a different map id draws a different map', JSON.stringify(d.layout) !== ja);
}

// ── 2. Stability across the incremental script ────────────────────────────

console.log('\nStability (gate: mean ≤2%, max ≤5% of extent per step):');
{
  factSeq = 0;
  const map = makeMap('stability-test');
  // The gate protects BYSTANDERS. An entity a new fact directly names is
  // being refined — moving it is the point ("kessa is near harrow" pulls
  // kessa). What must never happen is an untouched entity teleporting.
  const steps: Array<{ label: string; run: () => string[]; supersedeTargets: string[] }> = [
    {
      label: 'ch2 second city',
      run: () =>
        addFacts(map, 2, [
          {
            e: [entity('harrow', 'settlement', 2)],
            r: [
              { type: 'within', subject: 'harrow', container: 'veyron-empire' },
              { type: 'direction', subject: 'harrow', anchor: 'northgate', dir: 'S' },
              { type: 'distance', a: 'harrow', b: 'northgate', degree: 'near' },
            ],
          },
        ]),
      supersedeTargets: [],
    },
    {
      label: 'ch3 coast',
      run: () =>
        addFacts(map, 3, [
          {
            e: [entity('sea-of-glass', 'water', 3)],
            r: [{ type: 'on-coast', subject: 'harrow', water: 'sea-of-glass' }],
          },
        ]),
      supersedeTargets: [],
    },
    {
      label: 'ch4 neighbour realm',
      run: () =>
        addFacts(map, 4, [
          {
            e: [entity('veldt-reaches', 'region', 4), entity('kessa', 'settlement', 4)],
            r: [
              { type: 'adjacent-region', a: 'veldt-reaches', b: 'veyron-empire' },
              { type: 'within', subject: 'kessa', container: 'veldt-reaches' },
            ],
          },
        ]),
      supersedeTargets: [],
    },
    {
      label: 'ch5 road',
      run: () =>
        addFacts(map, 5, [
          {
            e: [entity('old-kings-road', 'road', 5)],
            r: [
              { type: 'connects', road: 'old-kings-road', a: 'kessa', b: 'harrow' },
              { type: 'distance', a: 'kessa', b: 'harrow', degree: 'near' },
            ],
          },
        ]),
      supersedeTargets: [],
    },
    {
      label: 'ch6 supersede Northgate N→NE',
      run: () => {
        const old = map.facts.find(
          (f) => f.relation.type === 'direction' && f.relation.subject === 'northgate'
        )!;
        const ids = addFacts(map, 6, [
          { r: [{ type: 'direction', subject: 'northgate', anchor: 'veyron-empire', dir: 'NE' }] },
        ]);
        old.supersededBy = ids[0];
        return ids;
      },
      supersedeTargets: ['northgate'],
    },
  ];

  applySolve(
    map,
    addFacts(map, 1, [
      {
        e: [entity('veyron-empire', 'region'), entity('northgate', 'settlement')],
        r: [
          { type: 'within', subject: 'northgate', container: 'veyron-empire' },
          { type: 'direction', subject: 'northgate', anchor: 'veyron-empire', dir: 'N' },
        ],
      },
    ])
  );

  let allMeanOk = true;
  let allMaxOk = true;
  for (const step of steps) {
    const before = JSON.parse(JSON.stringify(map.layout!.positions));
    const ids = step.run();
    const result = applySolve(map, ids);
    if (!result.ok) {
      check(`${step.label}: solve succeeded`, false, result.contradiction.message);
      continue;
    }
    const idSet = new Set(ids);
    const targets = new Set(step.supersedeTargets);
    for (const f of map.facts) {
      if (idSet.has(f.id)) for (const id of relationEntityIds(f.relation)) targets.add(id);
    }
    const { mean, max } = displacement(before, map.layout!.positions, targets);
    const meanPct = (100 * mean) / MAP_SIZE;
    const maxPct = (100 * max.d) / MAP_SIZE;
    console.log(
      `    ${step.label}: mean ${meanPct.toFixed(2)}%, max ${maxPct.toFixed(2)}% (${max.id})`
    );
    if (meanPct > 2) allMeanOk = false;
    if (maxPct > 5) allMaxOk = false;
  }
  check('mean bystander displacement ≤ 2% every step', allMeanOk);
  check('max bystander displacement ≤ 5% every step (fact targets excluded)', allMaxOk);

  const finalPositions = map.layout!.positions;
  const empire = finalPositions['veyron-empire'];
  const northgate = finalPositions['northgate'];
  check(
    'the superseded direction actually took effect (Northgate now NE of the empire)',
    northgate.x > empire.x && northgate.y < empire.y,
    `northgate (${northgate.x.toFixed(0)},${northgate.y.toFixed(0)}) vs empire (${empire.x.toFixed(0)},${empire.y.toFixed(0)})`
  );
  const dirs = directionsHonoured(map);
  check('every direction fact is drawn the way canon states it', dirs.ok, dirs.worst);
  check('regions got polygons', Object.keys(map.layout!.regionPolygons).length === 2);
  check('the sea got a polygon', Object.keys(map.layout!.waterPolygons).length === 1);
}

// ── 3. Hard contradictions are reported ───────────────────────────────────

console.log('\nHard contradictions:');
{
  factSeq = 0;
  const map = makeMap('contradiction-test');
  applySolve(
    map,
    addFacts(map, 1, [
      {
        e: [entity('port-azrun', 'settlement'), entity('kel-tower', 'landmark')],
        r: [{ type: 'direction', subject: 'kel-tower', anchor: 'port-azrun', dir: 'N' }],
      },
    ])
  );
  const ids = addFacts(map, 2, [
    { r: [{ type: 'direction', subject: 'kel-tower', anchor: 'port-azrun', dir: 'S' }] },
  ]);
  const result = solveMap(map, ids);
  check('N vs S on the same pair is a contradiction', !result.ok);
  if (!result.ok) {
    check(
      'the error names both facts, both chapters, and the supersede fix',
      /f-2-2/.test(result.contradiction.message) &&
        /f-1-1/.test(result.contradiction.message) &&
        /ch2/.test(result.contradiction.message) &&
        /supersede/.test(result.contradiction.message),
      result.contradiction.message
    );
    // The agent's fix path: supersede the old fact and resolve.
    map.facts.find((f) => f.id === result.contradiction.opposedFactId)!.supersededBy = ids[0];
    const retry = applySolve(map, ids);
    check('superseding the old fact resolves it', retry.ok);
  }

  // Same-entity two-container case.
  factSeq = 0;
  const map2 = makeMap('container-test');
  applySolve(
    map2,
    addFacts(map2, 1, [
      {
        e: [entity('empire-a', 'region'), entity('empire-b', 'region'), entity('borrowed-city', 'settlement')],
        r: [{ type: 'within', subject: 'borrowed-city', container: 'empire-a' }],
      },
    ])
  );
  const ids2 = addFacts(map2, 2, [
    { r: [{ type: 'within', subject: 'borrowed-city', container: 'empire-b' }] },
  ]);
  check('a city in two disjoint regions is a contradiction', !solveMap(map2, ids2).ok);

  // Nested containers are NOT a contradiction: city within province within empire.
  factSeq = 0;
  const map3 = makeMap('nesting-test');
  applySolve(
    map3,
    addFacts(map3, 1, [
      {
        e: [entity('empire', 'region'), entity('province', 'region'), entity('city', 'settlement')],
        r: [
          { type: 'within', subject: 'province', container: 'empire' },
          { type: 'within', subject: 'city', container: 'province' },
        ],
      },
    ])
  );
  const ids3 = addFacts(map3, 2, [{ r: [{ type: 'within', subject: 'city', container: 'empire' }] }]);
  check('nested containment is not flagged', solveMap(map3, ids3).ok);
}

// ── 4. Anchor conflict resolved WITHOUT a report ──────────────────────────

console.log('\nAnchor conflict (a true fact vs a frozen arbitrary placement):');
{
  factSeq = 0;
  const map = makeMap('anchor-test');
  // ch1: a lone city, weakly constrained — its position is the solver's
  // arbitrary choice, 130 units north of a hub.
  applySolve(
    map,
    addFacts(map, 1, [
      {
        e: [entity('hub', 'settlement'), entity('waystation', 'settlement')],
        r: [{ type: 'direction', subject: 'waystation', anchor: 'hub', dir: 'N' }],
      },
    ])
  );
  // ch2: canon now demands something FAR north of the waystation. If the
  // waystation's arbitrary spot has no room, the correct behaviour is to
  // slide the weakly-pinned waystation — silently — not to cry contradiction.
  const before = { ...map.layout!.positions['hub'] };
  const ids = addFacts(map, 2, [
    {
      e: [entity('frost-gate', 'landmark', 2)],
      r: [
        { type: 'direction', subject: 'frost-gate', anchor: 'waystation', dir: 'N' },
        { type: 'distance', a: 'frost-gate', b: 'waystation', degree: 'far' },
        { type: 'direction', subject: 'waystation', anchor: 'hub', dir: 'N' },
        { type: 'distance', a: 'waystation', b: 'hub', degree: 'far' },
      ],
    },
  ]);
  const result = applySolve(map, ids);
  check('no false contradiction', result.ok);
  if (result.ok) {
    const unsat = result.layout.unsatisfied.length;
    check('all facts satisfied after anchor handling', unsat === 0, unsat ? `${unsat} unsatisfied` : '');
    const hubAfter = map.layout!.positions['hub'];
    const hubMoved = Math.hypot(hubAfter.x - before.x, hubAfter.y - before.y);
    check('the strongly-anchored hub stayed near its spot', hubMoved <= 120, `moved ${hubMoved.toFixed(0)}`);
    const fg = map.layout!.positions['frost-gate'];
    const ws = map.layout!.positions['waystation'];
    const hb = map.layout!.positions['hub'];
    check('final geometry honours the chain (frost-gate N of waystation N of hub)', fg.y < ws.y && ws.y < hb.y);
  }
}

// ── 5. Directions hold at continental scale ───────────────────────────────

console.log('\nDirections at scale (large regions, long distances):');
{
  factSeq = 0;
  const map = makeMap('scale-direction-test');
  const region = (id: string, extent: 'vast' | 'large'): GeoEntity => ({
    ...entity(id, 'region'),
    extent,
  });
  applySolve(
    map,
    addFacts(map, 1, [
      {
        e: [region('south-empire', 'large'), region('north-kingdom', 'large'), region('far-north-waste', 'vast')],
        r: [
          { type: 'direction', subject: 'north-kingdom', anchor: 'south-empire', dir: 'N' },
          { type: 'direction', subject: 'far-north-waste', anchor: 'north-kingdom', dir: 'N' },
        ],
      },
    ])
  );
  const P = map.layout!.positions;
  check('a kingdom north of an empire is drawn north of it', P['north-kingdom'].y < P['south-empire'].y,
    `${P['north-kingdom'].y.toFixed(0)} vs ${P['south-empire'].y.toFixed(0)}`);
  check('a vast waste north of the kingdom is drawn north of it', P['far-north-waste'].y < P['north-kingdom'].y);
  const scaled = directionsHonoured(map);
  check('both direction facts inside tolerance at this scale', scaled.ok, scaled.worst);
}

// ── 6. Performance ────────────────────────────────────────────────────────

console.log('\nPerformance:');
{
  factSeq = 0;
  const map = makeMap('perf-test');
  const regions = ['r-one', 'r-two', 'r-three', 'r-four'];
  const additions: Array<{ e?: GeoEntity[]; r: GeoRelation[] }> = [
    { e: regions.map((r) => entity(r, 'region')), r: [] },
  ];
  for (let i = 0; i < 46; i++) {
    const id = `town-${String(i).padStart(2, '0')}`;
    additions.push({
      e: [entity(id, 'settlement')],
      r: [
        { type: 'within', subject: id, container: regions[i % regions.length] },
        ...(i > 0
          ? [{ type: 'distance', a: id, b: `town-${String(i - 1).padStart(2, '0')}`, degree: 'near' } as GeoRelation]
          : []),
      ],
    });
  }
  const ids = addFacts(map, 1, additions);
  const t0 = performance.now();
  const result = applySolve(map, ids);
  const ms = performance.now() - t0;
  check('50 entities solve under 200ms', result.ok && ms < 200, `${ms.toFixed(0)}ms`);
}

// ── 7. Pins are absolute (the sketch contract) ────────────────────────────

console.log('\nPins (author-drawn positions never move):');
{
  factSeq = 0;
  const map = makeMap('pin-test');
  const pinnedCity: GeoEntity = { ...entity('drawn-city', 'settlement'), pin: { x: 250, y: 700 } };
  applySolve(
    map,
    addFacts(map, 1, [
      {
        e: [entity('realm', 'region'), pinnedCity],
        r: [{ type: 'within', subject: 'drawn-city', container: 'realm' }],
      },
    ])
  );
  const p1 = map.layout!.positions['drawn-city'];
  check('a pinned entity solves at exactly its pin', p1.x === 250 && p1.y === 700, `(${p1.x},${p1.y})`);

  // Later facts that would drag it away must move everything else instead.
  const ids = addFacts(map, 2, [
    {
      e: [entity('far-fort', 'landmark', 2)],
      r: [
        { type: 'direction', subject: 'far-fort', anchor: 'drawn-city', dir: 'E' },
        { type: 'distance', a: 'far-fort', b: 'drawn-city', degree: 'far' },
      ],
    },
  ]);
  applySolve(map, ids);
  const p2 = map.layout!.positions['drawn-city'];
  check('the pin survives later fact updates unmoved', p2.x === 250 && p2.y === 700, `(${p2.x},${p2.y})`);
}

// ── 8. Author canon outranks extraction (the tool contract) ───────────────

console.log('\nAuthor canon (dictation/sketch facts beat chapter extraction):');
{
  const { handleCreateMap, handleUpsertGeofacts } = await import('./tools.js');
  type Ctx = import('./tools.js').ToolContext;

  const authorCtx: Ctx = { map: null, chapter: 3, createRationales: [], authorMode: true };
  handleCreateMap(authorCtx, { scope: 'world', title: 'Author World', rationale: 'dictated' });
  const created = handleUpsertGeofacts(authorCtx, {
    entities: [
      { id: 'empire', kind: 'region', name: 'Empire', extent: 'vast' },
      { id: 'border-town', kind: 'settlement', name: 'Border Town' },
    ],
    facts: [
      { relation: { type: 'within', subject: 'border-town', container: 'empire' }, confidence: 'stated' },
      { relation: { type: 'direction', subject: 'border-town', anchor: 'empire', dir: 'N' }, confidence: 'stated' },
    ],
  });
  check('author-mode upsert succeeds', !created.startsWith('Error'), created.split('\n')[0]);
  const authorFact = authorCtx.map!.facts.find((f) => f.relation.type === 'direction')!;
  check('author-mode facts land as confidence "author"', authorFact.confidence === 'author');

  // Chapter extraction now tries to supersede the author's direction — refused.
  const chapterCtx: Ctx = { map: authorCtx.map, chapter: 4, createRationales: [] };
  const superseded = handleUpsertGeofacts(chapterCtx, {
    facts: [
      { relation: { type: 'direction', subject: 'border-town', anchor: 'empire', dir: 'S' }, confidence: 'stated' },
    ],
    supersede: [authorFact.id],
  });
  check(
    'extraction cannot supersede an author fact',
    superseded.startsWith('Error') && superseded.includes('author-stated canon'),
    superseded.split('\n')[0]
  );

  // …and a contradicting fact WITHOUT supersede gets the skip instruction,
  // not the usual supersede-and-retry advice.
  const contradicted = handleUpsertGeofacts(chapterCtx, {
    facts: [
      { relation: { type: 'direction', subject: 'border-town', anchor: 'empire', dir: 'S' }, confidence: 'stated' },
    ],
  });
  check(
    'a contradicting extraction is told to skip, not supersede',
    contradicted.startsWith('Error') &&
      contradicted.includes("author's statement wins") &&
      !contradicted.includes('resend with supersede'),
    contradicted.split('\n')[0]
  );

  // The author, though, may change their own mind.
  const authorCtx2: Ctx = { map: chapterCtx.map, chapter: 5, createRationales: [], authorMode: true };
  const revised = handleUpsertGeofacts(authorCtx2, {
    facts: [
      { relation: { type: 'direction', subject: 'border-town', anchor: 'empire', dir: 'NE' }, confidence: 'stated' },
    ],
    supersede: [authorFact.id],
  });
  check('the author can supersede their own canon', !revised.startsWith('Error'), revised.split('\n')[0]);
}

// ── 9. Firestore headroom ─────────────────────────────────────────────────

console.log('\nDocument size at the entity cap:');
{
  factSeq = 0;
  const map = makeMap('size-test');
  const regions = ['sz-a', 'sz-b', 'sz-c', 'sz-d'];
  const additions: Array<{ e?: GeoEntity[]; r: GeoRelation[] }> = [
    { e: regions.map((r) => entity(r, 'region')), r: [] },
  ];
  for (let i = 0; i < 116; i++) {
    const id = `place-${String(i).padStart(3, '0')}`;
    additions.push({
      e: [entity(id, i % 5 === 0 ? 'landmark' : 'settlement')],
      r: [
        { type: 'within', subject: id, container: regions[i % regions.length] },
        ...(i > 0
          ? [{ type: 'distance', a: id, b: `place-${String(i - 1).padStart(3, '0')}`, degree: 'near' } as GeoRelation]
          : []),
      ],
    });
  }
  const ids = addFacts(map, 1, additions);
  const result = applySolve(map, ids);
  const bytes = Buffer.byteLength(JSON.stringify(map));
  check('120 entities + layout serialize under 800 kB', result.ok && bytes < 800_000, `${(bytes / 1024).toFixed(0)} kB`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n  ' + failures.join('\n  '));
process.exit(failures.length ? 1 : 0);
