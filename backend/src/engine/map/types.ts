/**
 * The geofact model — the spike's central bet.
 *
 * The LLM never emits coordinates. It states qualitative spatial relationships
 * with chapter provenance, exactly the discipline the story bible already uses
 * for narrative facts, and a deterministic solver turns them into positions.
 * That split is what makes "rough location" and "hypothetical border" concrete
 * ideas instead of vibes: roughness is the solver's freedom within the
 * constraints, and hypothetical is simply "not yet pinned by enough facts".
 */

export type Dir8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export const DIRS: readonly Dir8[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Angle of each direction in map space (SVG y grows downward, so N = -90°). */
export const DIR_ANGLE: Record<Dir8, number> = {
  E: 0,
  SE: 45,
  S: 90,
  SW: 135,
  W: 180,
  NW: 225,
  N: 270,
  NE: 315,
};

export type GeoEntityKind =
  | 'region'
  | 'settlement'
  | 'water'
  | 'mountain-range'
  | 'forest'
  | 'road'
  | 'landmark';

export const GEO_ENTITY_KINDS: readonly GeoEntityKind[] = [
  'region',
  'settlement',
  'water',
  'mountain-range',
  'forest',
  'road',
  'landmark',
];

/**
 * How much of the world a place occupies. The prose almost always says —
 * "a wide northern wilderness", "the Eastern Sea", "a mountain village" —
 * and without it every region renders the same size, which is its own kind of
 * lie: an empire and a province drawn identically tell the reader nothing.
 */
export type GeoExtent = 'vast' | 'large' | 'medium' | 'small';

export const EXTENT_SCALE: Record<GeoExtent, number> = {
  vast: 2.1,
  large: 1.45,
  medium: 1,
  small: 0.62,
};

export interface GeoEntity {
  /** Slug. MUST equal the bible entry id when the place has one. */
  id: string;
  kind: GeoEntityKind;
  name: string;
  aliases: string[];
  /** Absent falls back to a kind- and name-derived guess (see inferExtent). */
  extent?: GeoExtent;
  /** Evidence for #129's click-a-place→bible-entry requirement. */
  bibleEntryId: string | null;
  /** Marker sizing; 3 = capital/major. */
  importance: 1 | 2 | 3;
  firstChapter: number;
  /**
   * An exact position the author chose, in solver space (0–1000, y down).
   * A pinned entity never moves: the solver treats it as an unreleasable
   * anchor. Set only by the author's own hand — the sketch canvas, or
   * dragging a place on the Atlas.
   */
  pin?: { x: number; y: number };
  /**
   * The pin contract for a region's SHAPE: a boundary the author dragged into
   * place on the Atlas. deriveShapes uses it verbatim instead of the
   * Voronoi-derived polygon, so no later re-solve may redraw it. Stored as
   * {x,y} objects, not pairs — entities live raw in Firestore, which rejects
   * nested arrays (the layout escapes that by riding as a JSON string).
   */
  border?: Array<{ x: number; y: number }>;
}

export type GeoRelation =
  | { type: 'within'; subject: string; container: string }
  | { type: 'direction'; subject: string; anchor: string; dir: Dir8 }
  | { type: 'distance'; a: string; b: string; degree: 'adjacent' | 'near' | 'far' }
  | { type: 'adjacent-region'; a: string; b: string }
  | { type: 'on-coast'; subject: string; water: string | null }
  | { type: 'between'; subject: string; a: string; b: string }
  | { type: 'connects'; road: string; a: string; b: string };

export interface GeoFact {
  /** "f-<chapter>-<n>" */
  id: string;
  relation: GeoRelation;
  /**
   * 'implied' facts never confirm a position on their own. 'author' facts come
   * from the author directly (dictation or sketch) and outrank extraction:
   * the chapter agent can never supersede them.
   */
  confidence: 'stated' | 'implied' | 'author';
  /** Provenance, like BibleFact.chapter. */
  chapter: number;
  /**
   * ≤ 12-word phrase. STRIPPED from every artifact of the Kael's Rise run —
   * it is the one field that can carry prose.
   */
  evidence?: string;
  /** Append-mostly with supersession, like bible facts. */
  supersededBy: string | null;
}

export interface SolvedLayout {
  positions: Record<string, { x: number; y: number; solvedAtChapter: number }>;
  /** Pre-noise polygons; noise is applied at render time only. */
  regionPolygons: Record<string, Array<[number, number]>>;
  waterPolygons: Record<string, Array<[number, number]>>;
  /** Fact ids whose residual stayed above threshold — rendered as hypothetical. */
  unsatisfied: string[];
}

export interface GeoMap {
  id: string;
  scope: 'world' | 'region' | 'city';
  title: string;
  /** fnv1a(id) — the root of all layout randomness. */
  seed: number;
  entities: Record<string, GeoEntity>;
  facts: GeoFact[];
  /** Persisted anchors — the stability mechanism. */
  layout: SolvedLayout | null;
  createdChapter: number;
  updatedChapter: number;
}

export const activeFacts = (map: GeoMap): GeoFact[] =>
  map.facts.filter((f) => f.supersededBy === null);

/** Every entity id a relation names, for graph walks and validation. */
export function relationEntityIds(relation: GeoRelation): string[] {
  switch (relation.type) {
    case 'within':
      return [relation.subject, relation.container];
    case 'direction':
      return [relation.subject, relation.anchor];
    case 'distance':
      return [relation.a, relation.b];
    case 'adjacent-region':
      return [relation.a, relation.b];
    case 'on-coast':
      return relation.water ? [relation.subject, relation.water] : [relation.subject];
    case 'between':
      return [relation.subject, relation.a, relation.b];
    case 'connects':
      return [relation.road, relation.a, relation.b];
  }
}

/**
 * The hypothetical/confirmed derivation rule — a rule, not a mood:
 * a position is confirmed once ≥2 active non-implied facts constrain it.
 * A pin is the strongest confirmation there is — the author placed it.
 */
export function positionConfirmed(map: GeoMap, entityId: string): boolean {
  if (map.entities[entityId]?.pin) return true;
  let stated = 0;
  for (const fact of activeFacts(map)) {
    if (fact.confidence === 'implied') continue;
    if (relationEntityIds(fact.relation).includes(entityId)) stated++;
    if (stated >= 2) return true;
  }
  return false;
}

/**
 * A last-resort guess when the agent omits `extent`. Kind sets the baseline —
 * seas and oceans are the largest things on any map, a landmark the smallest —
 * and a few words that only ever describe scale nudge it further.
 */
export function inferExtent(entity: GeoEntity): GeoExtent {
  if (entity.extent) return entity.extent;
  const text = `${entity.name} ${entity.aliases.join(' ')}`.toLowerCase();

  if (/\b(ocean|great sea)\b/.test(text)) return 'vast';
  if (/\b(lake|pond|tarn|bay|cove|inlet)\b/.test(text)) return 'small';
  if (entity.kind === 'water') return /\bsea\b/.test(text) ? 'vast' : 'large';

  if (entity.kind === 'region') {
    if (/\b(empire|dominion|wilderness|expanse|wastes?|reaches|steppes?|continent|realm|kingdom)\b/.test(text)) {
      return 'large';
    }
    return 'medium';
  }
  if (entity.kind === 'mountain-range' || entity.kind === 'forest') return 'large';
  if (entity.kind === 'settlement') return entity.importance === 3 ? 'medium' : 'small';
  return 'small';
}
