import { fbm, makeNoise2D } from './noise.js';
import { regionRadius, waterRadius } from './solver.js';
import { EXTENT_SCALE, activeFacts, inferExtent, type GeoMap, type SolvedLayout } from './types.js';

/**
 * The continent.
 *
 * Drawing each region as its own polygon left the world as islands adrift in
 * blank paper — a city and the sea it trades with separated by nothing at all,
 * which reads as missing data rather than as geography. Real maps have ground
 * everywhere: water is the default state of the page and land is the thing
 * carved out of it.
 *
 * So: build one scalar field over the map where land sources push up and seas
 * push down, then trace a single contour through it with marching squares.
 * Regions keep their tints but are clipped to the coastline, and a sea that
 * reaches inland becomes a bay rather than a floating disc. Fully
 * deterministic — the field is a pure function of positions and radii, and the
 * only randomness is the seeded noise that keeps the coast from looking
 * compass-drawn.
 */

type Pt = [number, number];

const GRID = 96;
/** Contour level. Lower = more generous coastlines. */
const SHORE = 0.34;

export interface LandField {
  /** Closed rings in map coordinates, largest first. */
  rings: Pt[][];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Land influence at a point: strongest at a region's centre, fading to zero at
 * its radius. Settlements carry their own small halo so a town outside any
 * named region still stands on ground.
 */
export function buildLandField(map: GeoMap, layout: SolvedLayout): LandField {
  const noise = makeNoise2D(map.seed ^ 0x5bf03635);

  const landSources: Array<{ x: number; y: number; r: number }> = [];
  const waterSources: Array<{ x: number; y: number; r: number }> = [];
  /**
   * Ground that a sea cannot take back. Every named settlement stands on
   * something — a coastal city becomes a headland reaching into the water
   * rather than a dot adrift in it, which is what happens if a vast sea is
   * allowed to subtract from a small town's halo.
   */
  const footholds: Array<{ x: number; y: number; r: number }> = [];

  for (const id of Object.keys(map.entities).sort()) {
    const e = map.entities[id];
    const p = layout.positions[id];
    if (!p) continue;
    if (e.kind === 'water') {
      waterSources.push({ x: p.x, y: p.y, r: waterRadius(e) });
    } else if (e.kind === 'region') {
      landSources.push({ x: p.x, y: p.y, r: regionRadius(map, id) * 1.3 });
    } else if (e.kind !== 'road') {
      // A settlement or landmark needs enough ground to stand on; scale it so
      // a capital sits on more land than a waystation.
      let reach = 90 * EXTENT_SCALE[inferExtent(e)];
      // …and a town the story places INSIDE a region must share that region's
      // ground. Without this a city near its border renders as an island just
      // off its own coast, which contradicts the very fact that placed it.
      for (const f of activeFacts(map)) {
        if (f.relation.type !== 'within' || f.relation.subject !== id) continue;
        const parent = layout.positions[f.relation.container];
        if (parent) reach = Math.max(reach, Math.hypot(p.x - parent.x, p.y - parent.y) * 0.75);
      }
      landSources.push({ x: p.x, y: p.y, r: reach });
      footholds.push({ x: p.x, y: p.y, r: 62 * EXTENT_SCALE[inferExtent(e)] });
    }
  }

  // A stated border is a promise that there IS land between two realms. Lay a
  // bridge of unsubtractable ground along it, or a wide sea reaching in from
  // the side can cut a channel exactly where canon says the two countries
  // meet — which is how the Valorian Empire ended up severed from Andraveth.
  for (const f of activeFacts(map)) {
    if (f.relation.type !== 'adjacent-region') continue;
    const a = layout.positions[f.relation.a];
    const b = layout.positions[f.relation.b];
    if (!a || !b) continue;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.round(span / 40));
    const width = Math.min(
      regionRadius(map, f.relation.a),
      regionRadius(map, f.relation.b)
    ) * 0.5;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      footholds.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r: width });
    }
  }

  if (landSources.length === 0) {
    return { rings: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  }

  // Field extent: everything, plus room for the coast to fall away.
  const pad = 150;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of [...landSources, ...waterSources]) {
    minX = Math.min(minX, s.x - s.r - pad);
    minY = Math.min(minY, s.y - s.r - pad);
    maxX = Math.max(maxX, s.x + s.r + pad);
    maxY = Math.max(maxY, s.y + s.r + pad);
  }

  const stepX = (maxX - minX) / GRID;
  const stepY = (maxY - minY) / GRID;

  const at = (gx: number, gy: number) => {
    const x = minX + gx * stepX;
    const y = minY + gy * stepY;
    let land = 0;
    for (const s of landSources) {
      const d = Math.hypot(x - s.x, y - s.y);
      // Smooth falloff, and a max (not a sum) so overlapping regions do not
      // pile up into an artificially bulging coast.
      land = Math.max(land, Math.max(0, 1 - d / s.r));
    }
    let water = 0;
    for (const s of waterSources) {
      const d = Math.hypot(x - s.x, y - s.y);
      water = Math.max(water, Math.max(0, 1 - d / s.r));
    }
    // Seas erode the MARGINS of land, not its interior. Subtracting at full
    // strength everywhere let a vast sea cut a strait straight through a
    // region and strand one of its own cities on an island — which contradicts
    // the fact that put the city inside that region. So the deeper the land,
    // the less the water takes.
    const wobble = fbm(noise, x / 130, y / 130) * 0.11;
    const carved = land - water * 1.35 * (1 - land * 0.8) + wobble;

    // …except directly under a settlement, which keeps its ground whatever
    // the sea says.
    let foothold = 0;
    for (const f of footholds) {
      const d = Math.hypot(x - f.x, y - f.y);
      foothold = Math.max(foothold, Math.max(0, 1 - d / f.r) * (SHORE + 0.3));
    }
    return Math.max(carved, foothold + wobble * 0.4);
  };

  // Sample once; marching squares reads the grid.
  const field: number[][] = [];
  for (let gy = 0; gy <= GRID; gy++) {
    const row: number[] = [];
    for (let gx = 0; gx <= GRID; gx++) row.push(at(gx, gy));
    field.push(row);
  }

  const rings = marchingSquares(field, SHORE).map((ring) =>
    ring.map(([gx, gy]) => [minX + gx * stepX, minY + gy * stepY] as Pt)
  );

  return { rings, bounds: { minX, minY, maxX, maxY } };
}

/**
 * Marching squares, contour-following variant: walk each cell's crossing
 * segments and chain them into closed rings. Enough for a coastline; no
 * attempt at topological perfection beyond joining segments that share an
 * endpoint.
 */
function marchingSquares(field: number[][], level: number): Pt[][] {
  const h = field.length - 1;
  const w = field[0].length - 1;
  const segments: Array<[Pt, Pt]> = [];

  const lerp = (x1: number, y1: number, v1: number, x2: number, y2: number, v2: number): Pt => {
    const t = Math.abs(v2 - v1) < 1e-9 ? 0.5 : (level - v1) / (v2 - v1);
    return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  };

  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const tl = field[gy][gx];
      const tr = field[gy][gx + 1];
      const br = field[gy + 1][gx + 1];
      const bl = field[gy + 1][gx];
      const code =
        (tl > level ? 8 : 0) | (tr > level ? 4 : 0) | (br > level ? 2 : 0) | (bl > level ? 1 : 0);
      if (code === 0 || code === 15) continue;

      const top = () => lerp(gx, gy, tl, gx + 1, gy, tr);
      const right = () => lerp(gx + 1, gy, tr, gx + 1, gy + 1, br);
      const bottom = () => lerp(gx, gy + 1, bl, gx + 1, gy + 1, br);
      const left = () => lerp(gx, gy, tl, gx, gy + 1, bl);

      switch (code) {
        case 1:
        case 14:
          segments.push([left(), bottom()]);
          break;
        case 2:
        case 13:
          segments.push([bottom(), right()]);
          break;
        case 3:
        case 12:
          segments.push([left(), right()]);
          break;
        case 4:
        case 11:
          segments.push([top(), right()]);
          break;
        case 5:
          segments.push([left(), top()], [bottom(), right()]);
          break;
        case 6:
        case 9:
          segments.push([top(), bottom()]);
          break;
        case 7:
        case 8:
          segments.push([left(), top()]);
          break;
        case 10:
          segments.push([left(), bottom()], [top(), right()]);
          break;
      }
    }
  }

  // Chain segments into rings by matching endpoints on a rounded grid.
  const key = (p: Pt) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const byStart = new Map<string, Array<[Pt, Pt]>>();
  for (const seg of segments) {
    for (const [a, b] of [seg, [seg[1], seg[0]] as [Pt, Pt]]) {
      const list = byStart.get(key(a)) ?? [];
      list.push([a, b]);
      byStart.set(key(a), list);
    }
  }

  const used = new Set<string>();
  const segKey = (a: Pt, b: Pt) => [key(a), key(b)].sort().join('|');
  const rings: Pt[][] = [];

  for (const seg of segments) {
    if (used.has(segKey(seg[0], seg[1]))) continue;
    used.add(segKey(seg[0], seg[1]));
    const ring: Pt[] = [seg[0], seg[1]];
    let current = seg[1];
    for (let guard = 0; guard < segments.length + 4; guard++) {
      const next = (byStart.get(key(current)) ?? []).find((s) => !used.has(segKey(s[0], s[1])));
      if (!next) break;
      used.add(segKey(next[0], next[1]));
      current = next[1];
      if (key(current) === key(ring[0])) break;
      ring.push(current);
    }
    if (ring.length >= 6) rings.push(ring);
  }

  // Largest first: the mainland leads, islets follow.
  return rings.sort((a, b) => area(b) - area(a));
}

function area(ring: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Is a point on land? Used to decide where a sea label can sit. */
export function insideRings(rings: Pt[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
