// @ts-expect-error — vendored ESM bundle, typed by vendor/delaunay/index.d.ts
import { Delaunay } from './vendor/delaunay/d3-delaunay.bundle.js';
import { entityRng } from './prng.js';
import { regionRadius, waterRadius, MAP_SIZE, type SolveResult } from './solver.js';
import { activeFacts, type GeoMap, type SolvedLayout } from './types.js';

/**
 * Turning point positions into area shapes.
 *
 * A region needs a footprint even when the story has named one town in it —
 * which is the common early state. So each region contributes its member
 * points PLUS its centroid PLUS four seeded interior auxiliaries; a Voronoi
 * over everyone's seeds carves the plane; a region's polygon is the union of
 * its cells. A lone region (nothing to trade borders with) falls back to a
 * seeded blob. All of it deterministic; all noise is render-time.
 */

type Pt = [number, number];

function regionMemberIds(map: GeoMap, regionId: string): string[] {
  const out: string[] = [];
  for (const f of activeFacts(map)) {
    if (f.relation.type === 'within' && f.relation.container === regionId) out.push(f.relation.subject);
  }
  return out.sort();
}

/** Union of same-region Voronoi cells by cancelling shared internal edges. */
function unionCells(cells: Pt[][]): Pt[] {
  const key = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const edges = new Map<string, { a: Pt; b: Pt; count: number }>();

  for (const cell of cells) {
    for (let i = 0; i < cell.length; i++) {
      const a = cell[i];
      const b = cell[(i + 1) % cell.length];
      if (key(a) === key(b)) continue;
      const k = [key(a), key(b)].sort().join('|');
      const existing = edges.get(k);
      if (existing) existing.count++;
      else edges.set(k, { a, b, count: 1 });
    }
  }

  // Edges seen twice are internal; the boundary is what remains, chained into
  // a loop. Multiple loops can appear when cells are disjoint — keep the
  // longest, which is the main body.
  const boundary = [...edges.values()].filter((e) => e.count === 1);
  if (boundary.length === 0) return [];

  const byStart = new Map<string, Array<{ a: Pt; b: Pt }>>();
  for (const e of boundary) {
    for (const [start, end] of [
      [e.a, e.b],
      [e.b, e.a],
    ] as Array<[Pt, Pt]>) {
      const list = byStart.get(key(start)) ?? [];
      list.push({ a: start, b: end });
      byStart.set(key(start), list);
    }
  }

  const used = new Set<string>();
  const edgeKey = (a: Pt, b: Pt) => [key(a), key(b)].sort().join('|');
  let best: Pt[] = [];

  for (const e of boundary) {
    if (used.has(edgeKey(e.a, e.b))) continue;
    const loop: Pt[] = [e.a];
    let current = e.b;
    used.add(edgeKey(e.a, e.b));
    let guard = 0;
    while (key(current) !== key(loop[0]) && guard++ < boundary.length * 2 + 4) {
      loop.push(current);
      const options = (byStart.get(key(current)) ?? []).filter((o) => !used.has(edgeKey(o.a, o.b)));
      if (options.length === 0) break;
      used.add(edgeKey(options[0].a, options[0].b));
      current = options[0].b;
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

/** Seeded organic blob for lone regions and for water bodies. */
function blob(cx: number, cy: number, radius: number, seed: number, points = 24): Pt[] {
  const rng = entityRng(seed, `blob-${cx.toFixed(0)}-${cy.toFixed(0)}`);
  const wobble = Array.from({ length: points }, () => 0.82 + rng() * 0.36);
  return Array.from({ length: points }, (_, i) => {
    const angle = (i / points) * Math.PI * 2;
    const r = radius * wobble[i];
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] as Pt;
  });
}

/** Fills regionPolygons/waterPolygons on a solved layout, in place. */
export function deriveShapes(map: GeoMap, layout: SolvedLayout): void {
  const regions = Object.values(map.entities)
    .filter((e) => e.kind === 'region')
    .sort((a, b) => a.id.localeCompare(b.id));
  const waters = Object.values(map.entities)
    .filter((e) => e.kind === 'water')
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const w of waters) {
    const p = layout.positions[w.id];
    if (p) layout.waterPolygons[w.id] = blob(p.x, p.y, waterRadius(w), map.seed);
  }

  if (regions.length === 0) return;

  // An author-dragged border is the shape equivalent of a pin: it is used
  // verbatim, whatever the Voronoi would have drawn. The region still
  // contributes its seeds below so neighbours keep shaping around it.
  const authorBorder = (id: string): Pt[] | null => {
    const border = map.entities[id]?.border;
    return border && border.length >= 3 ? border.map((p) => [p.x, p.y] as Pt) : null;
  };

  if (regions.length === 1) {
    const r = regions[0];
    const p = layout.positions[r.id];
    const own = authorBorder(r.id);
    if (own) layout.regionPolygons[r.id] = own;
    else if (p) layout.regionPolygons[r.id] = blob(p.x, p.y, regionRadius(map, r.id), map.seed);
    return;
  }

  // Seeds for every region together, then Voronoi carves shared borders.
  // Void seeds matter as much as region seeds: a Voronoi partitions the whole
  // plane, so without neutral territory two regions would swallow the entire
  // map between them. A coarse grid of unowned seeds (kept clear of the
  // regions themselves) bounds every region at roughly its radius, and water
  // centres are void too so no region annexes a sea.
  const VOID = '__void';
  const seeds: Pt[] = [];
  const owner: string[] = [];
  for (const region of regions) {
    const centre = layout.positions[region.id];
    if (!centre) continue;
    const radius = regionRadius(map, region.id);
    const push = (pt: Pt) => {
      seeds.push(pt);
      owner.push(region.id);
    };
    push([centre.x, centre.y]);
    const rng = entityRng(map.seed, `aux-${region.id}`);
    for (let i = 0; i < 4; i++) {
      const angle = rng() * Math.PI * 2;
      const d = radius * (0.3 + rng() * 0.35);
      push([centre.x + Math.cos(angle) * d, centre.y + Math.sin(angle) * d]);
    }
    for (const memberId of regionMemberIds(map, region.id)) {
      const mp = layout.positions[memberId];
      if (mp) push([mp.x, mp.y]);
    }
  }

  const regionCentres = regions
    .map((r) => ({ id: r.id, p: layout.positions[r.id], radius: regionRadius(map, r.id) }))
    .filter((r) => r.p);
  const GRID_STEP = 140;
  for (let gx = 70; gx < MAP_SIZE; gx += GRID_STEP) {
    for (let gy = 70; gy < MAP_SIZE; gy += GRID_STEP) {
      const insideAnyRegion = regionCentres.some(
        (r) => Math.hypot(gx - r.p!.x, gy - r.p!.y) < r.radius * 1.15
      );
      if (!insideAnyRegion) {
        seeds.push([gx, gy]);
        owner.push(VOID);
      }
    }
  }
  for (const w of waters) {
    const p = layout.positions[w.id];
    if (!p) continue;
    seeds.push([p.x, p.y]);
    owner.push(VOID);
    const rad = waterRadius(w);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      seeds.push([p.x + Math.cos(angle) * rad * 0.7, p.y + Math.sin(angle) * rad * 0.7]);
      owner.push(VOID);
    }
  }

  const voronoi = Delaunay.from(seeds).voronoi([0, 0, MAP_SIZE, MAP_SIZE]);
  const cellsByRegion = new Map<string, Pt[][]>();
  for (let i = 0; i < seeds.length; i++) {
    const cell = voronoi.cellPolygon(i);
    if (!cell) continue;
    const list = cellsByRegion.get(owner[i]) ?? [];
    list.push(cell as Pt[]);
    cellsByRegion.set(owner[i], list);
  }

  for (const region of regions) {
    const own = authorBorder(region.id);
    if (own) {
      layout.regionPolygons[region.id] = own;
      continue;
    }
    const cells = cellsByRegion.get(region.id);
    if (!cells || cells.length === 0) continue;
    const merged = unionCells(cells);
    if (merged.length >= 3) layout.regionPolygons[region.id] = merged.map(([x, y]) => [
      Math.round(x * 100) / 100,
      Math.round(y * 100) / 100,
    ]);
  }
}

/** Convenience: solve + shapes in one call, since callers always want both. */
export function finishLayout(map: GeoMap, result: SolveResult): SolveResult {
  if (result.ok) deriveShapes(map, result.layout);
  return result;
}
