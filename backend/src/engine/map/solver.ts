import { entityRng } from './prng.js';
import {
  DIR_ANGLE,
  EXTENT_SCALE,
  activeFacts,
  inferExtent,
  relationEntityIds,
  type GeoEntity,
  type GeoFact,
  type GeoMap,
  type SolvedLayout,
} from './types.js';

/**
 * Facts → positions, deterministically, with stability as the prime directive.
 *
 * Three properties carry the whole design, in priority order:
 *
 *  1. DETERMINISM. Same facts, same seed → identical positions, always. All
 *     randomness comes from per-entity PRNG streams and iteration runs in
 *     sorted-id order, so insertion order cannot change the result.
 *  2. STABILITY. Previously solved positions persist as anchors. A new fact
 *     releases only the entities it names plus their close fact-graph
 *     neighbours; everything else is frozen. #129 says it plainly: a map that
 *     rearranges itself is worse than no map.
 *  3. HONESTY ABOUT CONFLICT. Qualitative facts under-determine a map, so an
 *     early arbitrary placement can make a later TRUE fact look wrong. The
 *     solver therefore distinguishes a hard contradiction (the facts oppose
 *     each other in any layout — reported to the agent) from an anchor
 *     conflict (satisfiable if a weakly-constrained old entity moves — solved
 *     silently by releasing that entity). Confusing the two would train the
 *     agent to supersede correct canon.
 */

export const MAP_SIZE = 1000;
const MARGIN = 40;

/** Distance bands in map units. */
const BAND = {
  adjacent: { min: 20, max: 60, target: 40 },
  near: { min: 60, max: 200, target: 130 },
  far: { min: 320, max: 700, target: 420 },
} as const;

/**
 * Distances are relative, not absolute.
 *
 * "Near" between two villages and "near" between two continents are the same
 * word describing wildly different spans, and a solver with fixed bands puts
 * them at the same 130 units — which is what tore the continent into islands
 * once `extent` made regions three times bigger than the bands that were
 * meant to space them. Every band is therefore scaled by the largest thing it
 * relates.
 */
function pairScale(map: GeoMap, ids: string[]): number {
  let scale = 0.8;
  for (const id of ids) {
    const e = map.entities[id];
    if (!e) continue;
    scale = Math.max(scale, EXTENT_SCALE[inferExtent(e)] * (e.kind === 'region' || e.kind === 'water' ? 1.35 : 0.85));
  }
  return scale;
}

function bandFor(map: GeoMap, ids: string[], degree: 'adjacent' | 'near' | 'far') {
  const k = pairScale(map, ids);
  const b = BAND[degree];
  return { min: b.min * k, max: b.max * k, target: b.target * k };
}

const DIRECTION_CONE_DEG = 30;
const SEPARATION = 24;
const ITERATIONS = 200;
const UNSATISFIED_THRESHOLD = 0.35;
/** Collateral cap: a released-but-not-targeted entity may drift at most this far. */
const COLLATERAL_CAP = 50;

interface Vec {
  x: number;
  y: number;
}

export interface SolveDiagnostics {
  /** Entities whose anchors were dropped to resolve an apparent conflict. */
  anchorReleases: string[];
  /** Facts that stayed unsatisfied after everything. */
  unsatisfied: string[];
}

export interface HardContradiction {
  newFactId: string;
  opposedFactId: string;
  message: string;
}

export type SolveResult =
  | { ok: true; layout: SolvedLayout; diagnostics: SolveDiagnostics }
  | { ok: false; contradiction: HardContradiction };

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

const wrapDeg = (d: number) => {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
};

/** Entities that get their own point in space. Roads are paths, not points. */
const isPlaced = (e: GeoEntity) => e.kind !== 'road';

function regionMembers(map: GeoMap, regionId: string): string[] {
  const members: string[] = [];
  for (const f of activeFacts(map)) {
    if (f.relation.type === 'within' && f.relation.container === regionId) {
      members.push(f.relation.subject);
    }
  }
  return members.sort();
}

export function regionRadius(map: GeoMap, regionId: string): number {
  const members = regionMembers(map, regionId);
  const entity = map.entities[regionId];
  const scale = entity ? EXTENT_SCALE[inferExtent(entity)] : 1;
  const base = Math.max(120, 60 + 45 * Math.sqrt(Math.max(members.length, 1))) * scale;
  // A region must be big enough for what canon says happens inside it: two
  // member cities "a month of roads" apart cannot both fit in a duchy-sized
  // circle, and forcing them to would leave true facts unsatisfiable.
  const inside = new Set(members);
  let needed = 0;
  for (const f of activeFacts(map)) {
    if (f.relation.type !== 'distance') continue;
    if (inside.has(f.relation.a) && inside.has(f.relation.b)) {
      needed = Math.max(needed, bandFor(map, [f.relation.a, f.relation.b], f.relation.degree).target * 0.7);
    }
  }
  return Math.max(base, needed);
}

/**
 * Seas are the biggest thing on a map. Sizing them by `importance` was the
 * bug that drew the Eastern Sea as a pond beside the empire it borders —
 * importance is narrative weight, not physical extent, and the two are
 * unrelated for water.
 */
export function waterRadius(entity: GeoEntity): number {
  return 150 * EXTENT_SCALE[inferExtent(entity)];
}

/**
 * Sorted iteration everywhere: determinism must not depend on object-key
 * insertion order, which the agent's call order would otherwise control.
 */
const sortedPlacedIds = (map: GeoMap) =>
  Object.keys(map.entities)
    .filter((id) => isPlaced(map.entities[id]))
    .sort();

// ── Initial placement ─────────────────────────────────────────────────────

/**
 * Containers before contents: a city "within the empire" needs the empire to
 * exist in space first. Cycles are a validation failure upstream; here they
 * would just fall back to unordered.
 */
function topoOrder(map: GeoMap, ids: string[]): string[] {
  const contains = new Map<string, string[]>();
  for (const f of activeFacts(map)) {
    if (f.relation.type === 'within') {
      const list = contains.get(f.relation.container) ?? [];
      list.push(f.relation.subject);
      contains.set(f.relation.container, list);
    }
  }
  const depth = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let d = 0;
    for (const f of activeFacts(map)) {
      if (f.relation.type === 'within' && f.relation.subject === id) {
        d = Math.max(d, 1 + depth(f.relation.container, seen));
      }
    }
    return d;
  };
  return [...ids].sort((a, b) => depth(a, new Set()) - depth(b, new Set()) || a.localeCompare(b));
}

function initialPosition(
  map: GeoMap,
  id: string,
  positions: Map<string, Vec>
): Vec {
  const rng = entityRng(map.seed, id);
  const candidates: Vec[] = [];

  for (const f of activeFacts(map)) {
    const r = f.relation;
    if (r.type === 'within' && r.subject === id) {
      const c = positions.get(r.container);
      if (c) {
        const radius = regionRadius(map, r.container) * 0.45;
        const angle = rng() * Math.PI * 2;
        const d = rng() * radius;
        candidates.push({ x: c.x + Math.cos(angle) * d, y: c.y + Math.sin(angle) * d });
      }
    } else if (r.type === 'direction' && r.subject === id) {
      const a = positions.get(r.anchor);
      if (a) {
        const angle = (DIR_ANGLE[r.dir] * Math.PI) / 180;
        const reach = bandFor(map, [r.subject, r.anchor], 'near').target;
        candidates.push({ x: a.x + Math.cos(angle) * reach, y: a.y + Math.sin(angle) * reach });
      }
    } else if (r.type === 'direction' && r.anchor === id) {
      const s = positions.get(r.subject);
      if (s) {
        const angle = ((DIR_ANGLE[r.dir] + 180) * Math.PI) / 180;
        const reach = bandFor(map, [r.subject, r.anchor], 'near').target;
        candidates.push({ x: s.x + Math.cos(angle) * reach, y: s.y + Math.sin(angle) * reach });
      }
    } else if (r.type === 'distance' && (r.a === id || r.b === id)) {
      const other = positions.get(r.a === id ? r.b : r.a);
      if (other) {
        const angle = rng() * Math.PI * 2;
        const d = bandFor(map, [r.a, r.b], r.degree).target;
        candidates.push({ x: other.x + Math.cos(angle) * d, y: other.y + Math.sin(angle) * d });
      }
    } else if (r.type === 'between' && r.subject === id) {
      const a = positions.get(r.a);
      const b = positions.get(r.b);
      if (a && b) candidates.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    } else if (r.type === 'on-coast' && r.subject === id && r.water) {
      const w = positions.get(r.water);
      const water = map.entities[r.water];
      if (w && water) {
        const angle = rng() * Math.PI * 2;
        const rad = waterRadius(water);
        candidates.push({ x: w.x + Math.cos(angle) * rad, y: w.y + Math.sin(angle) * rad });
      }
    } else if (r.type === 'on-coast' && r.water === id) {
      // The water is the NEW entity: put its centre one radius away from the
      // already-anchored coastal subject, so the settlement barely moves and
      // the sea comes to it — never the other way round. The direction is
      // outward from the world's centre of mass, so a sea opens away from the
      // continent rather than drowning it.
      const s = positions.get(r.subject);
      const self = map.entities[id];
      if (s && self) {
        let cx = 0;
        let cy = 0;
        let n = 0;
        for (const [otherId, p] of positions) {
          if (map.entities[otherId]?.kind === 'water') continue;
          cx += p.x;
          cy += p.y;
          n++;
        }
        const away =
          n > 0 && (s.x !== cx / n || s.y !== cy / n)
            ? Math.atan2(s.y - cy / n, s.x - cx / n)
            : rng() * Math.PI * 2;
        const rad = waterRadius(self);
        candidates.push({ x: s.x + Math.cos(away) * rad, y: s.y + Math.sin(away) * rad });
      }
    } else if (r.type === 'adjacent-region' && (r.a === id || r.b === id)) {
      const other = positions.get(r.a === id ? r.b : r.a);
      if (other) {
        const angle = rng() * Math.PI * 2;
        const d = (regionRadius(map, r.a) + regionRadius(map, r.b)) * 0.58;
        candidates.push({ x: other.x + Math.cos(angle) * d, y: other.y + Math.sin(angle) * d });
      }
    }
  }

  if (candidates.length === 0) {
    // Unconstrained: a seeded ring position around the centre — stable, and
    // far enough out that later facts have room to pull.
    const angle = rng() * Math.PI * 2;
    const d = 180 + rng() * 160;
    return clampToBounds({ x: 500 + Math.cos(angle) * d, y: 500 + Math.sin(angle) * d });
  }

  const mean = candidates.reduce((acc, c) => ({ x: acc.x + c.x, y: acc.y + c.y }), { x: 0, y: 0 });
  return clampToBounds({ x: mean.x / candidates.length, y: mean.y / candidates.length });
}

function clampToBounds(v: Vec): Vec {
  return {
    x: Math.min(MAP_SIZE - MARGIN, Math.max(MARGIN, v.x)),
    y: Math.min(MAP_SIZE - MARGIN, Math.max(MARGIN, v.y)),
  };
}

// ── Forces ────────────────────────────────────────────────────────────────

function factForces(
  map: GeoMap,
  fact: GeoFact,
  positions: Map<string, Vec>,
  add: (id: string, fx: number, fy: number) => void
): void {
  const r = fact.relation;

  if (r.type === 'direction') {
    const s = positions.get(r.subject);
    const a = positions.get(r.anchor);
    if (!s || !a) return;
    const d = dist(s, a);
    const want = (DIR_ANGLE[r.dir] * Math.PI) / 180;
    if (d < 25) {
      // Too close to have a direction at all — push apart along the axis.
      add(r.subject, Math.cos(want) * 3, Math.sin(want) * 3);
      return;
    }
    const current = Math.atan2(s.y - a.y, s.x - a.x);
    const delta = wrapDeg(((current - want) * 180) / Math.PI);
    if (Math.abs(delta) > DIRECTION_CONE_DEG) {
      // Rotate toward the cone: force perpendicular to the radial line.
      //
      // The magnitude has to scale with the lever arm. A fixed nudge that can
      // swing two neighbouring towns cannot swing two realms a thousand units
      // apart within the iteration budget — which is exactly how a kingdom
      // canon puts NORTH of an empire ended up drawn to its west while every
      // test still passed.
      const lever = Math.max(4, d * 0.16);
      const strength = Math.min((Math.abs(delta) - DIRECTION_CONE_DEG) / 60, 1.5) * lever;
      const sign = delta > 0 ? -1 : 1;
      const px = -Math.sin(current) * sign * strength;
      const py = Math.cos(current) * sign * strength;
      add(r.subject, px, py);
      add(r.anchor, -px * 0.5, -py * 0.5);
    }
  } else if (r.type === 'distance') {
    const a = positions.get(r.a);
    const b = positions.get(r.b);
    if (!a || !b) return;
    const band = bandFor(map, [r.a, r.b], r.degree);
    const d = Math.max(dist(a, b), 1);
    if (d < band.min || d > band.max) {
      const pull = ((band.target - d) / d) * 0.35;
      const fx = (a.x - b.x) * pull;
      const fy = (a.y - b.y) * pull;
      add(r.a, fx, fy);
      add(r.b, -fx, -fy);
    }
  } else if (r.type === 'within') {
    const s = positions.get(r.subject);
    const c = positions.get(r.container);
    if (!s || !c) return;
    const radius = regionRadius(map, r.container) * 0.75;
    const d = dist(s, c);
    if (d > radius) {
      const pull = ((d - radius) / d) * 0.5;
      add(r.subject, (c.x - s.x) * pull, (c.y - s.y) * pull);
      add(r.container, (s.x - c.x) * pull * 0.15, (s.y - c.y) * pull * 0.15);
    }
  } else if (r.type === 'on-coast') {
    if (!r.water) return;
    const s = positions.get(r.subject);
    const w = positions.get(r.water);
    const water = map.entities[r.water];
    if (!s || !w || !water) return;
    const rad = waterRadius(water);
    const d = Math.max(dist(s, w), 1);
    const ux = (s.x - w.x) / d;
    const uy = (s.y - w.y) / d;
    const gap = rad - d;
    // The SEA moves, not the city. A port belongs to the land it was built
    // on — dragging it out to the rim of a vast ocean strands it as an island,
    // which is exactly what happened to the Free City of Marlowe. So the water
    // body does almost all the travelling and the settlement barely stirs.
    add(r.water, -ux * gap * 0.45, -uy * gap * 0.45);
    add(r.subject, ux * gap * 0.06, uy * gap * 0.06);
  } else if (r.type === 'between') {
    const s = positions.get(r.subject);
    const a = positions.get(r.a);
    const b = positions.get(r.b);
    if (!s || !a || !b) return;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    add(r.subject, (mx - s.x) * 0.12, (my - s.y) * 0.12);
  } else if (r.type === 'adjacent-region') {
    const a = positions.get(r.a);
    const b = positions.get(r.b);
    if (!a || !b) return;
    const want = (regionRadius(map, r.a) + regionRadius(map, r.b)) * 0.58;
    const d = Math.max(dist(a, b), 1);
    if (Math.abs(d - want) > want * 0.2) {
      const pull = ((want - d) / d) * 0.25;
      const fx = (a.x - b.x) * pull;
      const fy = (a.y - b.y) * pull;
      add(r.a, fx, fy);
      add(r.b, -fx, -fy);
    }
  }
  // 'connects' constrains nothing spatially — a road is drawn, not solved.
}

// ── Residuals ─────────────────────────────────────────────────────────────

/** 0 = satisfied; grows with violation; >UNSATISFIED_THRESHOLD = unsatisfied. */
export function factResidual(map: GeoMap, fact: GeoFact, positions: Map<string, Vec>): number {
  const r = fact.relation;
  if (r.type === 'direction') {
    const s = positions.get(r.subject);
    const a = positions.get(r.anchor);
    if (!s || !a) return 0;
    const current = (Math.atan2(s.y - a.y, s.x - a.x) * 180) / Math.PI;
    const delta = Math.abs(wrapDeg(current - DIR_ANGLE[r.dir]));
    return Math.max(0, (delta - DIRECTION_CONE_DEG) / 120);
  }
  if (r.type === 'distance') {
    const a = positions.get(r.a);
    const b = positions.get(r.b);
    if (!a || !b) return 0;
    const band = bandFor(map, [r.a, r.b], r.degree);
    const d = dist(a, b);
    if (d >= band.min && d <= band.max) return 0;
    return Math.abs(d - band.target) / band.target / 1.5;
  }
  if (r.type === 'within') {
    const s = positions.get(r.subject);
    const c = positions.get(r.container);
    if (!s || !c) return 0;
    const radius = regionRadius(map, r.container) * 0.75;
    return Math.max(0, (dist(s, c) - radius) / radius);
  }
  if (r.type === 'on-coast') {
    if (!r.water) return 0;
    const s = positions.get(r.subject);
    const w = positions.get(r.water);
    const water = map.entities[r.water];
    if (!s || !w || !water) return 0;
    const rad = waterRadius(water);
    return Math.abs(dist(s, w) - rad) / rad;
  }
  if (r.type === 'between') {
    const s = positions.get(r.subject);
    const a = positions.get(r.a);
    const b = positions.get(r.b);
    if (!s || !a || !b) return 0;
    const span = Math.max(dist(a, b), 1);
    return Math.max(0, (dist(s, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) - span * 0.35) / span);
  }
  if (r.type === 'adjacent-region') {
    const a = positions.get(r.a);
    const b = positions.get(r.b);
    if (!a || !b) return 0;
    const want = (regionRadius(map, r.a) + regionRadius(map, r.b)) * 0.58;
    return Math.max(0, Math.abs(dist(a, b) - want) / want - 0.3);
  }
  return 0;
}

// ── Hard-opposition detection ─────────────────────────────────────────────

const oppositeDir = (deg: number) => (deg + 180) % 360;

/** Normalise direction facts to (subjectKey ordered) angular claims for comparison. */
function directionClaim(r: Extract<GeoFact['relation'], { type: 'direction' }>): {
  pair: string;
  angle: number;
} {
  const [a, b] = [r.subject, r.anchor];
  if (a <= b) return { pair: `${a}|${b}`, angle: DIR_ANGLE[r.dir] };
  return { pair: `${b}|${a}`, angle: oppositeDir(DIR_ANGLE[r.dir]) };
}

function withinChainConnected(map: GeoMap, a: string, b: string): boolean {
  const up = (start: string): Set<string> => {
    const seen = new Set<string>([start]);
    let frontier = [start];
    while (frontier.length) {
      const next: string[] = [];
      for (const f of activeFacts(map)) {
        if (f.relation.type === 'within' && frontier.includes(f.relation.subject)) {
          if (!seen.has(f.relation.container)) {
            seen.add(f.relation.container);
            next.push(f.relation.container);
          }
        }
      }
      frontier = next;
    }
    return seen;
  };
  return up(a).has(b) || up(b).has(a);
}

/** A fact pair that no layout can satisfy — the only case the agent must fix. */
export function findHardOpposition(map: GeoMap, next: GeoFact): GeoFact | null {
  for (const old of activeFacts(map)) {
    if (old.id === next.id) continue;
    const a = next.relation;
    const b = old.relation;

    if (a.type === 'direction' && b.type === 'direction') {
      const ca = directionClaim(a);
      const cb = directionClaim(b);
      if (ca.pair === cb.pair) {
        const delta = Math.abs(wrapDeg(ca.angle - cb.angle));
        if (delta >= 135) return old;
      }
    }
    if (a.type === 'distance' && b.type === 'distance') {
      const pa = [a.a, a.b].sort().join('|');
      const pb = [b.a, b.b].sort().join('|');
      if (pa === pb && ((a.degree === 'adjacent' && b.degree === 'far') || (a.degree === 'far' && b.degree === 'adjacent'))) {
        return old;
      }
    }
    if (a.type === 'within' && b.type === 'within' && a.subject === b.subject) {
      if (a.container !== b.container && !withinChainConnected(map, a.container, b.container)) {
        return old;
      }
    }
  }
  return null;
}

// ── The solve ─────────────────────────────────────────────────────────────

function relax(
  map: GeoMap,
  positions: Map<string, Vec>,
  released: Set<string>,
  anchors: Map<string, Vec>,
  targeted: Set<string>
): void {
  const facts = activeFacts(map);
  const placedIds = sortedPlacedIds(map).filter((id) => positions.has(id));

  for (let i = 0; i < ITERATIONS; i++) {
    const step = Math.pow(0.9, i / 10);
    const forces = new Map<string, Vec>();
    const add = (id: string, fx: number, fy: number) => {
      if (!released.has(id)) return;
      const f = forces.get(id) ?? { x: 0, y: 0 };
      f.x += fx;
      f.y += fy;
      forces.set(id, f);
    };

    for (const fact of facts) factForces(map, fact, positions, add);

    // Separation between point entities, so labels have air.
    for (let m = 0; m < placedIds.length; m++) {
      for (let n = m + 1; n < placedIds.length; n++) {
        const A = map.entities[placedIds[m]];
        const B = map.entities[placedIds[n]];
        if (A.kind === 'region' || A.kind === 'water' || B.kind === 'region' || B.kind === 'water') continue;
        const pa = positions.get(placedIds[m])!;
        const pb = positions.get(placedIds[n])!;
        const d = dist(pa, pb);
        if (d < SEPARATION && d > 0.01) {
          const push = ((SEPARATION - d) / d) * 1.5;
          add(placedIds[m], (pa.x - pb.x) * push, (pa.y - pb.y) * push);
          add(placedIds[n], (pb.x - pa.x) * push, (pb.y - pa.y) * push);
        }
      }
    }

    // Anchor springs. Strong for released bystanders, gentle for the entities
    // a new fact directly names — those are the ones the fact is allowed to
    // move, but even they should drift no further than the fact demands.
    for (const [id, anchor] of anchors) {
      if (!released.has(id)) continue;
      const p = positions.get(id);
      if (!p) continue;
      const k = targeted.has(id) ? 0.12 : 0.6;
      add(id, (anchor.x - p.x) * k, (anchor.y - p.y) * k);
    }

    for (const id of placedIds) {
      const f = forces.get(id);
      if (!f) continue;
      const p = positions.get(id)!;
      positions.set(id, clampToBounds({ x: p.x + f.x * step, y: p.y + f.y * step }));
    }
  }

  // Collateral cap: bystanders that were released only as graph neighbours may
  // not travel beyond the cap, whatever the forces said.
  for (const [id, anchor] of anchors) {
    if (!released.has(id) || targeted.has(id)) continue;
    const p = positions.get(id);
    if (!p) continue;
    const d = dist(p, anchor);
    if (d > COLLATERAL_CAP) {
      const s = COLLATERAL_CAP / d;
      positions.set(id, {
        x: anchor.x + (p.x - anchor.x) * s,
        y: anchor.y + (p.y - anchor.y) * s,
      });
    }
  }
}

function factGraphNeighbours(map: GeoMap, seeds: Set<string>, hops: number): Set<string> {
  const out = new Set(seeds);
  let frontier = new Set(seeds);
  for (let h = 0; h < hops; h++) {
    const next = new Set<string>();
    for (const f of activeFacts(map)) {
      const ids = relationEntityIds(f.relation);
      if (ids.some((id) => frontier.has(id))) {
        for (const id of ids) if (!out.has(id)) next.add(id);
      }
    }
    for (const id of next) out.add(id);
    frontier = next;
  }
  return out;
}

/**
 * How pinned an entity was BEFORE this update — the incoming facts are the
 * ones asking for the move, so counting them would make nothing releasable.
 */
function priorFactCount(map: GeoMap, entityId: string, excludeIds: Set<string>): number {
  let n = 0;
  for (const f of activeFacts(map)) {
    if (excludeIds.has(f.id)) continue;
    if (relationEntityIds(f.relation).includes(entityId)) n++;
  }
  return n;
}

/**
 * Incremental solve. `newFactIds` are the facts added by this update; they
 * decide what is released and whose anchors may bend.
 */
export function solveMap(map: GeoMap, newFactIds: string[]): SolveResult {
  const newFacts = map.facts.filter((f) => newFactIds.includes(f.id) && f.supersededBy === null);

  // Hard oppositions first — checked against geometry-free logic, so a
  // contradiction is reported even when both facts could never be laid out.
  for (const nf of newFacts) {
    const opposed = findHardOpposition(map, nf);
    if (opposed) {
      return {
        ok: false,
        contradiction: {
          newFactId: nf.id,
          opposedFactId: opposed.id,
          message:
            `fact ${nf.id} (${describeRelation(map, nf)}, ch${nf.chapter}) contradicts active fact ` +
            `${opposed.id} (${describeRelation(map, opposed)}, ch${opposed.chapter}). ` +
            `If chapter ${nf.chapter} is newer canon, resend with supersede:["${opposed.id}"].`,
        },
      };
    }
  }

  const positions = new Map<string, Vec>();
  const anchors = new Map<string, Vec>();
  const prior = map.layout?.positions ?? {};
  // Author pins are absolute: the entity sits exactly where the sketch put it,
  // whatever any prior layout or incoming fact says.
  const pinned = new Set<string>();
  for (const id of sortedPlacedIds(map)) {
    const pin = map.entities[id].pin;
    if (pin) {
      pinned.add(id);
      positions.set(id, { x: pin.x, y: pin.y });
      anchors.set(id, { x: pin.x, y: pin.y });
      continue;
    }
    const p = prior[id];
    if (p) {
      positions.set(id, { x: p.x, y: p.y });
      anchors.set(id, { x: p.x, y: p.y });
    }
  }

  // Place brand-new entities, containers first.
  const unplaced = topoOrder(
    map,
    sortedPlacedIds(map).filter((id) => !positions.has(id))
  );
  for (const id of unplaced) positions.set(id, initialPosition(map, id, positions));

  // Release set: targets of new facts + close neighbours + all new entities.
  // Pinned entities are never released — no force may move them.
  const targeted = new Set<string>();
  for (const nf of newFacts) for (const id of relationEntityIds(nf.relation)) targeted.add(id);
  for (const id of unplaced) targeted.add(id);
  const released = factGraphNeighbours(map, targeted, 2);
  for (const id of unplaced) released.add(id);
  // First solve of a map: everything is released.
  if (anchors.size === pinned.size) for (const id of positions.keys()) released.add(id);
  for (const id of pinned) {
    released.delete(id);
    targeted.delete(id);
  }

  // Supersession is the one sanctioned teleport. When this update REPLACES a
  // fact, the entity it repositions must shed its anchor entirely, however
  // many other facts it carries — canon changed, and a map that keeps drawing
  // the old canon because the city was "too established to move" is wrong in
  // the way that matters most. (The stability gates already exempt
  // supersession targets for exactly this reason.)
  const newIdSet = new Set(newFactIds);
  const removalStamp = `removed-ch${map.updatedChapter}`;
  for (const old of map.facts) {
    if (old.supersededBy === null) continue;
    if (!newIdSet.has(old.supersededBy) && old.supersededBy !== removalStamp) continue;
    for (const id of relationEntityIds(old.relation)) {
      if (pinned.has(id)) continue;
      if (targeted.has(id) && anchors.has(id)) {
        anchors.delete(id);
        released.add(id);
      }
    }
  }

  relax(map, positions, released, anchors, targeted);

  // Anchor-conflict pass: a new fact that still fails may be a true fact
  // fighting a frozen arbitrary placement. Release weakly-constrained old
  // entities it names and try again — silently, because nothing was wrong
  // with the fact.
  const diagnostics: SolveDiagnostics = { anchorReleases: [], unsatisfied: [] };
  const newIds = new Set(newFactIds);
  for (const nf of newFacts) {
    if (factResidual(map, nf, positions) <= UNSATISFIED_THRESHOLD) continue;
    const releasable = relationEntityIds(nf.relation).filter(
      (id) => !pinned.has(id) && anchors.has(id) && priorFactCount(map, id, newIds) <= 2
    );
    if (releasable.length === 0) continue;
    for (const id of releasable) {
      anchors.delete(id);
      released.add(id);
      targeted.add(id);
      diagnostics.anchorReleases.push(id);
    }
    relax(map, positions, released, anchors, targeted);
  }

  for (const f of activeFacts(map)) {
    if (factResidual(map, f, positions) > UNSATISFIED_THRESHOLD) {
      diagnostics.unsatisfied.push(f.id);
    }
  }

  const chapter = map.updatedChapter;
  const out: SolvedLayout = {
    positions: {},
    regionPolygons: {},
    waterPolygons: {},
    unsatisfied: diagnostics.unsatisfied,
  };
  for (const [id, p] of positions) {
    const priorPos = prior[id];
    const moved = !priorPos || dist(priorPos, p) > 0.01;
    out.positions[id] = {
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      solvedAtChapter: moved ? chapter : priorPos.solvedAtChapter,
    };
  }

  return { ok: true, layout: out, diagnostics };
}

export function describeRelation(map: GeoMap, fact: GeoFact): string {
  const name = (id: string) => map.entities[id]?.name ?? id;
  const r = fact.relation;
  switch (r.type) {
    case 'within':
      return `${name(r.subject)} within ${name(r.container)}`;
    case 'direction':
      return `${name(r.subject)} ${r.dir} of ${name(r.anchor)}`;
    case 'distance':
      return `${name(r.a)} ${r.degree} ${name(r.b)}`;
    case 'adjacent-region':
      return `${name(r.a)} borders ${name(r.b)}`;
    case 'on-coast':
      return `${name(r.subject)} on the coast${r.water ? ` of ${name(r.water)}` : ''}`;
    case 'between':
      return `${name(r.subject)} between ${name(r.a)} and ${name(r.b)}`;
    case 'connects':
      return `${name(r.road)} connects ${name(r.a)} and ${name(r.b)}`;
  }
}
