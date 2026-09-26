import { buildLandField, insideRings } from './landmass.js';
import { fbm, makeNoise2D } from './noise.js';
import { entityRng } from './prng.js';
import { MAP_SIZE, regionRadius, waterRadius } from './solver.js';
import { activeFacts, positionConfirmed, type GeoMap } from './types.js';

/**
 * The renderer: a pure function from a solved map to an SVG string.
 *
 * App-themed organic — colours and fonts come exclusively from the app's
 * `--wn-*` design tokens so one SVG is legible in both themes, with the
 * organic parts (noise-distorted borders, glyph clusters) seeded from the map
 * id so identical input is byte-identical output. Dashed strokes mean
 * hypothetical; solid means canon has pinned it. That distinction is the
 * product: an author reads at a glance which parts of the world the story has
 * actually committed to.
 */

type Pt = [number, number];

export interface RenderOptions {
  /** Emit literal hex instead of var(--wn-*) — evidence for EPUB export. */
  resolveTokens?: 'light' | 'dark';
}

/** The app's tokens, with resolved fallbacks lifted from frontend/src/index.css. */
const TOKENS = {
  canvas: { v: 'var(--wn-canvas)', light: '#faf6ef', dark: '#12141a' },
  // The sea. A touch cooler and darker than the page so land reads as raised.
  water: { v: 'var(--wn-sunken)', light: '#e7e3d6', dark: '#0d1016' },
  land: { v: 'var(--wn-surface)', light: '#f7f2e6', dark: '#1a1d25' },
  surface: { v: 'var(--wn-surface)', light: '#fffdf8', dark: '#191c24' },
  sunken: { v: 'var(--wn-sunken)', light: '#f1ead9', dark: '#0e1015' },
  ink: { v: 'var(--wn-ink)', light: '#2b2620', dark: '#e8e4da' },
  muted: { v: 'var(--wn-muted)', light: '#6b6154', dark: '#a8a396' },
  faint: { v: 'var(--wn-faint)', light: '#6f665a', dark: '#8791a0' },
  line: { v: 'var(--wn-line)', light: '#e5dcc8', dark: '#262b36' },
  lineStrong: { v: 'var(--wn-line-strong)', light: '#d3c7ac', dark: '#333a48' },
  accent: { v: 'var(--wn-accent)', light: '#b5893c', dark: '#d9a441' },
} as const;

/** Region tint palette — token-adjacent hues at low opacity, 4 distinct. */
const REGION_TINTS = ['#b5893c', '#5a7a5e', '#7a5a72', '#5a6b7a'];

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderMap(map: GeoMap, opts: RenderOptions = {}): string {
  const t = (key: keyof typeof TOKENS) =>
    opts.resolveTokens ? TOKENS[key][opts.resolveTokens] : TOKENS[key].v;
  const layout = map.layout;
  if (!layout) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_SIZE} ${MAP_SIZE}"></svg>`;

  const noise = makeNoise2D(map.seed);
  const pos = (id: string) => layout.positions[id];
  const parts: string[] = [];

  // The frame follows the content, not a fixed square. Coastlines bulge past
  // the solver's bounds and labels sit outside the shapes they name, so a
  // hard 0–1000 viewBox quietly crops the map — a sea drawn as "Sea of G".
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  // Organic displacement of a polygon: subdivide to ~12-unit segments, then
  // displace along normals by seeded noise. Render-time only, by design — the
  // solver never sees these shapes.
  const organic = (poly: Pt[], amplitude: number): Pt[] => {
    if (poly.length < 3) return poly;
    const out: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.round(len / 12));
      for (let s = 0; s < steps; s++) {
        const u = s / steps;
        const x = a[0] + (b[0] - a[0]) * u;
        const y = a[1] + (b[1] - a[1]) * u;
        const nx = -(b[1] - a[1]) / (len || 1);
        const ny = (b[0] - a[0]) / (len || 1);
        const d = fbm(noise, x / 55, y / 55) * amplitude;
        out.push([x + nx * d, y + ny * d]);
      }
    }
    return out;
  };

  const path = (poly: Pt[], close = true) => {
    for (const [x, y] of poly) extend(x, y);
    return (
      poly.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('') +
      (close ? 'Z' : '')
    );
  };

  // ── 1. The sea is the ground ────────────────────────────────────────────
  // Everything not carved out as land is water, so there is no such thing as
  // empty space between a city and the coast it trades with.
  const land = buildLandField(map, layout);
  const coast = land.rings.map((ring) => organic(ring, 3.5));

  const clipId = `land-${(map.seed >>> 0).toString(36)}`;
  if (coast.length > 0) {
    parts.push(
      `<defs><clipPath id="${clipId}">${coast.map((r) => `<path d="${path(r)}"/>`).join('')}</clipPath></defs>`
    );
    for (const ring of coast) {
      parts.push(`<path d="${path(ring)}" fill="${t('land')}"/>`);
    }
  }

  // ── 2. Regions, clipped to the coastline ────────────────────────────────
  const regionIds = Object.keys(layout.regionPolygons).sort();
  const clipAttr = coast.length > 0 ? ` clip-path="url(#${clipId})"` : '';
  regionIds.forEach((id, index) => {
    const poly = organic(layout.regionPolygons[id], 5);
    const tint = REGION_TINTS[index % REGION_TINTS.length];
    parts.push(`<path d="${path(poly)}" fill="${tint}" fill-opacity="0.13"${clipAttr}/>`);
  });
  regionIds.forEach((id) => {
    const poly = organic(layout.regionPolygons[id], 5);
    // Border confidence is derived, not decorative: solid only where canon
    // pinned this region against a neighbour or a coast.
    const pinned = activeFacts(map).some(
      (f) =>
        f.relation.type === 'adjacent-region' &&
        (f.relation.a === id || f.relation.b === id) &&
        f.confidence === 'stated'
    );
    const dash = pinned ? '' : ` stroke-dasharray="6 4" opacity="0.8"`;
    parts.push(
      `<path d="${path(poly)}" fill="none" stroke="${t('lineStrong')}" stroke-width="1.5"${dash}${clipAttr}/>`
    );
  });

  // ── 3. Coastline, drawn over the region fills that meet it ──────────────
  for (const ring of coast) {
    parts.push(`<path d="${path(ring)}" fill="none" stroke="${t('ink')}" stroke-width="1.5"/>`);
    // Two slack offsets inside the water read as the classic engraved shore.
    for (const inset of [7, 15]) {
      const shore = ring.map(([x, y]) => {
        const n = fbm(noise, x / 60, y / 60);
        return [x + n * inset * 0.4, y + n * inset * 0.4] as Pt;
      });
      parts.push(
        `<path d="${path(shore)}" fill="none" stroke="${t('lineStrong')}" stroke-width="0.6" opacity="0.5"/>`
      );
    }
  }

  // ── 4. Roads ────────────────────────────────────────────────────────────
  for (const f of activeFacts(map)) {
    if (f.relation.type !== 'connects') continue;
    const a = pos(f.relation.a);
    const b = pos(f.relation.b);
    if (!a || !b) continue;
    // A gentle seeded bow, because straight roads read as rulers.
    const mx = (a.x + b.x) / 2 + fbm(noise, a.x / 90, b.y / 90) * 24;
    const my = (a.y + b.y) / 2 + fbm(noise, b.x / 90, a.y / 90) * 24;
    parts.push(
      `<path d="M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}" fill="none" stroke="${t('muted')}" stroke-width="1.1" stroke-dasharray="2 3"/>`
    );
  }

  // ── 5. Terrain glyphs ───────────────────────────────────────────────────
  for (const id of Object.keys(map.entities).sort()) {
    const e = map.entities[id];
    const p = pos(id);
    if (!p) continue;
    const rng = entityRng(map.seed, `glyph-${id}`);
    if (e.kind === 'mountain-range') {
      // A spine of chevrons along a seeded axis.
      const angle = rng() * Math.PI;
      const count = 5 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i++) {
        const u = (i / (count - 1) - 0.5) * 90;
        const cx = p.x + Math.cos(angle) * u + (rng() - 0.5) * 10;
        const cy = p.y + Math.sin(angle) * u * 0.4 + (rng() - 0.5) * 10;
        const s = 7 + rng() * 5;
        extend(cx - s, cy - s);
        extend(cx + s, cy + s);
        parts.push(
          `<path d="M${(cx - s).toFixed(1)},${(cy + s * 0.7).toFixed(1)} L${cx.toFixed(1)},${(cy - s * 0.8).toFixed(1)} L${(cx + s).toFixed(1)},${(cy + s * 0.7).toFixed(1)}" fill="none" stroke="${t('ink')}" stroke-width="1.2" stroke-linejoin="round"/>`,
          `<path d="M${cx.toFixed(1)},${(cy - s * 0.8).toFixed(1)} L${(cx + s * 0.35).toFixed(1)},${(cy - s * 0.15).toFixed(1)}" fill="none" stroke="${t('lineStrong')}" stroke-width="0.8"/>`
        );
      }
    } else if (e.kind === 'forest') {
      for (let i = 0; i < 7; i++) {
        const cx = p.x + (rng() - 0.5) * 60;
        const cy = p.y + (rng() - 0.5) * 44;
        const r = 4 + rng() * 3;
        extend(cx - r, cy - r);
        extend(cx + r, cy + r * 2);
        parts.push(
          `<circle cx="${cx.toFixed(1)}" cy="${(cy - r * 0.4).toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${t('muted')}" stroke-width="1"/>`,
          `<path d="M${cx.toFixed(1)},${(cy + r * 0.6).toFixed(1)} v${(r * 1.1).toFixed(1)}" stroke="${t('muted')}" stroke-width="1"/>`
        );
      }
    }
  }

  // ── 6. Settlements + landmarks ──────────────────────────────────────────
  interface Label {
    x: number;
    y: number;
    text: string;
    size: number;
    anchorR: number;
    letterspace?: boolean;
    water?: boolean;
    /** Entity id, emitted as data-entity so the app can wire click-through. */
    id?: string;
  }
  const labels: Label[] = [];

  for (const id of Object.keys(map.entities).sort()) {
    const e = map.entities[id];
    const p = pos(id);
    if (!p) continue;
    if (e.kind === 'settlement' || e.kind === 'landmark') {
      const r = e.importance === 3 ? 6 : e.importance === 2 ? 4.5 : 3;
      extend(p.x - r - 4, p.y - r - 4);
      extend(p.x + r + 4, p.y + r + 4);
      if (e.kind === 'settlement') {
        parts.push(
          `<g data-entity="${esc(id)}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${t('ink')}"/>` +
            (e.importance === 3
              ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r + 3.5}" fill="none" stroke="${t('ink')}" stroke-width="1.1"/>`
              : '') +
            '</g>'
        );
      } else {
        parts.push(
          `<g data-entity="${esc(id)}"><path d="M${p.x.toFixed(1)},${(p.y - r - 1).toFixed(1)} L${(p.x + r).toFixed(1)},${(p.y + r * 0.8).toFixed(1)} L${(p.x - r).toFixed(1)},${(p.y + r * 0.8).toFixed(1)}Z" fill="none" stroke="${t('ink')}" stroke-width="1.3"/></g>`
        );
      }
      labels.push({ x: p.x, y: p.y, text: e.name, size: 11, anchorR: r + 4, id });
    } else if (e.kind === 'water') {
      // Nudge the label off the coast until it sits in open water — a sea
      // name printed over the shore it borders reads as a place on land.
      let lx = p.x;
      let ly = p.y;
      const r = waterRadius(e);
      for (const [dx, dy] of [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45], [0.7, 0], [-0.7, 0]]) {
        const cx = p.x + dx * r;
        const cy = p.y + dy * r;
        if (!insideRings(coast, cx, cy)) {
          lx = cx;
          ly = cy;
          break;
        }
      }
      labels.push({ x: lx, y: ly, text: e.name.toUpperCase(), size: 12, anchorR: 0, letterspace: true, water: true, id });
    } else if (e.kind === 'region' || e.kind === 'mountain-range') {
      labels.push({
        x: p.x,
        y: e.kind === 'region' ? p.y - regionRadius(map, id) * 0.35 : p.y,
        text: e.kind === 'region' ? e.name.toUpperCase() : e.name,
        size: e.kind === 'region' ? 14 : 11.5,
        anchorR: 0,
        letterspace: e.kind === 'region',
        id,
      });
    }
  }

  // ── 7. Labels with greedy collision avoidance ───────────────────────────
  const placedBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  const overlaps = (x: number, y: number, w: number, h: number) =>
    placedBoxes.some((b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y);

  for (const label of labels) {
    const w = label.text.length * label.size * (label.letterspace ? 0.78 : 0.58);
    const h = label.size * 1.3;
    const candidates: Array<[number, number, string]> = [
      [label.x + label.anchorR + 3, label.y + label.size * 0.35, 'start'],
      [label.x - label.anchorR - 3 - w, label.y + label.size * 0.35, 'start'],
      [label.x - w / 2, label.y - label.anchorR - 5, 'start'],
      [label.x - w / 2, label.y + label.anchorR + h, 'start'],
      [label.x + label.anchorR + 3, label.y - label.anchorR - 3, 'start'],
      [label.x - w / 2, label.y + label.anchorR + h + 12, 'start'],
      [label.x + label.anchorR + 14, label.y + label.size * 0.35, 'start'],
      [label.x - w / 2, label.y - label.anchorR - 17, 'start'],
    ];
    let placed = false;
    const entityAttr = label.id ? ` data-entity="${esc(label.id)}"` : '';
    for (const [cx, cy] of candidates) {
      if (!overlaps(cx, cy - h, w, h)) {
        parts.push(
          `<text${entityAttr} x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-family="Georgia, 'Times New Roman', serif" font-size="${label.size}" ${label.letterspace ? 'letter-spacing="3" opacity="0.75"' : ''} fill="${t(label.water ? 'muted' : label.letterspace ? 'faint' : 'ink')}">${esc(label.text)}</text>`
        );
        placedBoxes.push({ x: cx, y: cy - h, w, h });
        extend(cx, cy - h);
        extend(cx + w, cy + h * 0.25);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Leader line as last resort — a label is never dropped.
      const lx = label.x + 26;
      const ly = label.y - 26;
      parts.push(
        `<path d="M${label.x + 4},${label.y - 4} L${lx - 2},${ly + 3}" stroke="${t('faint')}" stroke-width="0.7"/>`,
        `<text${entityAttr} x="${lx}" y="${ly}" font-family="Georgia, 'Times New Roman', serif" font-size="${label.size}" fill="${t('ink')}">${esc(label.text)}</text>`
      );
      placedBoxes.push({ x: lx, y: ly - h, w, h });
      extend(lx, ly - h);
      extend(lx + w, ly + h * 0.25);
    }
  }

  // ── 8. The frame, sized to what was actually drawn ─────────────────────
  // Computed last because labels — the things most likely to overhang — are
  // only placed above. The frame is then unshifted to the back of the stack.
  const PAD = 30;
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = MAP_SIZE;
    maxY = MAP_SIZE;
  }
  const vbX = minX - PAD;
  const vbY = minY - PAD - 46; // headroom for the title cartouche
  const vbW = maxX - minX + PAD * 2;
  const vbH = maxY - minY + PAD * 2 + 46 + 26; // + legend rail
  const right = vbX + vbW;
  const bottom = vbY + vbH;

  parts.unshift(
    `<rect x="${vbX.toFixed(1)}" y="${vbY.toFixed(1)}" width="${vbW.toFixed(1)}" height="${vbH.toFixed(1)}" fill="${t('water')}"/>`,
    `<rect x="${(vbX + 7).toFixed(1)}" y="${(vbY + 7).toFixed(1)}" width="${(vbW - 14).toFixed(1)}" height="${(vbH - 14).toFixed(1)}" fill="none" stroke="${t('lineStrong')}" stroke-width="1.6"/>`,
    `<rect x="${(vbX + 12).toFixed(1)}" y="${(vbY + 12).toFixed(1)}" width="${(vbW - 24).toFixed(1)}" height="${(vbH - 24).toFixed(1)}" fill="none" stroke="${t('line')}" stroke-width="0.8"/>`
  );

  parts.push(
    `<text x="${(vbX + 26).toFixed(1)}" y="${(vbY + 44).toFixed(1)}" font-family="Georgia, 'Times New Roman', serif" font-size="21" font-weight="bold" fill="${t('ink')}">${esc(map.title)}</text>`,
    `<text x="${(vbX + 26).toFixed(1)}" y="${(vbY + 62).toFixed(1)}" font-family="Georgia, 'Times New Roman', serif" font-size="10.5" fill="${t('muted')}">as of chapter ${map.updatedChapter}</text>`,
    `<g transform="translate(${(vbX + 26).toFixed(1)}, ${(bottom - 22).toFixed(1)})">` +
      `<line x1="0" y1="0" x2="26" y2="0" stroke="${t('lineStrong')}" stroke-width="1.6"/>` +
      `<text x="32" y="3.5" font-family="Georgia, serif" font-size="10" fill="${t('muted')}">confirmed</text>` +
      `<line x1="104" y1="0" x2="130" y2="0" stroke="${t('lineStrong')}" stroke-width="1.6" stroke-dasharray="6 4"/>` +
      `<text x="136" y="3.5" font-family="Georgia, serif" font-size="10" fill="${t('muted')}">hypothetical</text>` +
      `</g>`
  );

  const unconfirmed = Object.keys(map.entities).filter(
    (id) =>
      (map.entities[id].kind === 'settlement' || map.entities[id].kind === 'landmark') &&
      !positionConfirmed(map, id)
  );
  if (unconfirmed.length > 0) {
    parts.push(
      `<text x="${(right - 26).toFixed(1)}" y="${(bottom - 19).toFixed(1)}" text-anchor="end" font-family="Georgia, serif" font-size="9.5" fill="${t('faint')}">rough locations: ${esc(
        unconfirmed
          .map((id) => map.entities[id].name)
          .slice(0, 4)
          .join(', ')
      )}${unconfirmed.length > 4 ? '\u2026' : ''}</text>`
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" role="img" aria-label="${esc(map.title)}">` +
    parts.join('') +
    '</svg>'
  );
}
