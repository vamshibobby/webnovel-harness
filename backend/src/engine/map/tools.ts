import type { ToolDefinition } from '../openrouter.js';
import { deriveShapes } from './regions.js';
import { describeRelation, solveMap } from './solver.js';
import {
  DIRS,
  GEO_ENTITY_KINDS,
  activeFacts,
  positionConfirmed,
  relationEntityIds,
  type GeoEntity,
  type GeoFact,
  type GeoMap,
  type GeoRelation,
} from './types.js';
import { fnv1a } from './prng.js';

/**
 * The map agent's tool contract. Same discipline as the bible tools: the
 * parameter schema is the structured-output enforcement, and every validation
 * failure goes back to the model as tool-output text it can correct — a
 * malformed fact never reaches the map.
 */

/** Hard caps, in the DESIGN_LIMITS tradition: a runaway agent hits a wall, not Firestore. */
export const MAP_LIMITS = {
  entitiesPerMap: 120,
  factsPerMap: 500,
  title: 120,
  evidence: 120,
  aliasesPerEntity: 8,
  dictationChars: 4000,
  sketchShapes: 60,
  sketchImageBytes: 900_000,
  borderPoints: 160,
} as const;

export const getMapToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_map',
    description:
      "Read the novel's current map: its entities, the active spatial facts grouped by entity, " +
      'and any constraints the layout could not satisfy. Call this FIRST, before deciding ' +
      'whether the chapter adds any geography. Returns "(no map exists)" when none has been created.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

export const createMapToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_map',
    description:
      'Create the map. Only when the chapter establishes spatial relationships between two or ' +
      'more places at geographic scale — a single city described from inside does not warrant a ' +
      'map. State in `rationale` which places and which relationships justify it.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['world', 'region', 'city'] },
        title: { type: 'string', description: 'e.g. "The Ashen Dominion and its neighbours"' },
        rationale: {
          type: 'string',
          description: 'The places and relationships in this chapter that make a map warranted.',
        },
      },
      required: ['scope', 'title', 'rationale'],
    },
  },
};

export const upsertGeofactsToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'upsert_geofacts',
    description:
      'Add places and spatial facts to the map. Entities are created or updated by id; facts are ' +
      'appended with this chapter as provenance. When a new fact CHANGES established geography, ' +
      'list the fact ids it replaces in `supersede`. Send only what this chapter states or ' +
      'unmistakably implies — never invent precision.',
    parameters: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'kebab-case slug, e.g. "sea-of-glass"' },
              kind: { type: 'string', enum: [...GEO_ENTITY_KINDS] },
              name: { type: 'string' },
              aliases: { type: 'array', items: { type: 'string' } },
              importance: { type: 'number', enum: [1, 2, 3], description: '3 = capital/major' },
              extent: {
                type: 'string',
                enum: ['vast', 'large', 'medium', 'small'],
                description:
                  'How much of the WORLD this occupies — physical size, not story importance. ' +
                  'A continent-spanning empire or an open sea is "vast"; a kingdom, a wilderness ' +
                  'or a named sea is "large"; a province or a great city is "medium"; a town, a ' +
                  'lake or a fort is "small". The prose almost always says: "a wide northern ' +
                  'wilderness", "the vast Empire", "a mountain village".',
              },
              pin: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                description:
                  'EXACT position in map space (0–1000, y grows downward). ONLY when you were ' +
                  'given sketch shapes with positions — never invent one. Ignored otherwise.',
              },
            },
            required: ['id', 'kind', 'name'],
          },
        },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              relation: {
                type: 'object',
                description:
                  'One of: {type:"within", subject, container} · {type:"direction", subject, anchor, ' +
                  'dir: N|NE|E|SE|S|SW|W|NW} · {type:"distance", a, b, degree: adjacent|near|far} · ' +
                  '{type:"adjacent-region", a, b} · {type:"on-coast", subject, water} · ' +
                  '{type:"between", subject, a, b} · {type:"connects", road, a, b}. ' +
                  'All values are entity ids.',
              },
              confidence: {
                type: 'string',
                enum: ['stated', 'implied'],
                description: '"implied" for anything you inferred rather than read.',
              },
              evidence: { type: 'string', description: 'The phrase that states it, ≤12 words.' },
            },
            required: ['relation', 'confidence'],
          },
        },
        supersede: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fact ids this update replaces, when the chapter changes established geography.',
        },
      },
      required: [],
    },
  },
};

// ── Formatting ────────────────────────────────────────────────────────────

export function formatMap(map: GeoMap | null): string {
  if (!map) return '(no map exists)';
  const lines = [
    `MAP: ${map.title} [${map.scope}] — created ch${map.createdChapter}, updated ch${map.updatedChapter}`,
    '',
    'ENTITIES:',
  ];
  for (const id of Object.keys(map.entities).sort()) {
    const e = map.entities[id];
    const conf = positionConfirmed(map, id) ? 'confirmed' : 'hypothetical';
    lines.push(
      `  ${e.id} · ${e.kind} · ${e.name} · ${e.extent ?? 'extent unset'} · importance ${e.importance} · ${conf}`
    );
  }
  lines.push('', 'ACTIVE FACTS:');
  for (const f of activeFacts(map)) {
    const tag = f.confidence === 'author' ? 'AUTHOR-STATED' : `ch${f.chapter}, ${f.confidence}`;
    lines.push(`  ${f.id} [${tag}] ${describeRelation(map, f)}`);
  }
  const unsat = map.layout?.unsatisfied ?? [];
  if (unsat.length) {
    lines.push('', `UNSATISFIED (drawn as best-effort): ${unsat.join(', ')}`);
  }
  return lines.join('\n');
}

// ── Handlers ──────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ToolContext {
  map: GeoMap | null;
  chapter: number;
  /** Rationale strings from create_map, for the discipline eval. */
  createRationales: string[];
  /**
   * Author mode (dictation/sketch): every fact lands as confidence 'author'
   * regardless of what the model claims, and author facts may be superseded.
   * Off (chapter extraction): 'author' facts are untouchable canon.
   */
  authorMode?: boolean;
  /** Sketch only: entities may carry exact pinned positions. */
  allowPins?: boolean;
}

export function handleCreateMap(ctx: ToolContext, raw: Record<string, unknown>): string {
  if (ctx.map) {
    return 'Error: a map already exists. Add to it with upsert_geofacts instead.';
  }
  const scope = raw.scope === 'world' || raw.scope === 'region' || raw.scope === 'city' ? raw.scope : null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, MAP_LIMITS.title) : '';
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : '';
  if (!scope || !title) return 'Error: scope and title are required.';
  // The app stores one world map per novel; the Firestore doc id and the map
  // id must agree.
  const id = 'world';
  ctx.map = {
    id,
    scope,
    title,
    seed: fnv1a(`${title}-${id}`),
    entities: {},
    facts: [],
    layout: null,
    createdChapter: ctx.chapter,
    updatedChapter: ctx.chapter,
  };
  ctx.createRationales.push(rationale);
  return `Created the map "${title}" [${scope}]. Now add its places and facts with upsert_geofacts.`;
}

function parseRelation(raw: unknown, kinds: Map<string, string>): GeoRelation | string {
  const knownIds = new Set(kinds.keys());
  if (typeof raw !== 'object' || raw === null) return 'relation must be an object';
  const r = raw as Record<string, unknown>;
  const need = (key: string): string | null => {
    const v = r[key];
    if (typeof v !== 'string' || !v.trim()) return null;
    return v.trim();
  };
  const requireIds = (ids: Array<string | null>, relation: GeoRelation): GeoRelation | string => {
    for (const id of ids) {
      if (!id) return 'relation is missing a required entity id';
      if (!knownIds.has(id)) {
        return `unknown entity id "${id}" — declare it in this call's entities array or use an existing id`;
      }
    }
    return relation;
  };

  const kindOf = (id: string | null) => (id ? kinds.get(id) : undefined);

  switch (r.type) {
    case 'within': {
      const subject = need('subject');
      const container = need('container');
      const checked = requireIds([subject, container], { type: 'within', subject: subject!, container: container! });
      if (typeof checked === 'string') return checked;
      const ck = kindOf(container);
      if (ck !== 'region' && ck !== 'water') {
        return `within needs a region or water as container — "${container}" is a ${ck}`;
      }
      return checked;
    }
    case 'direction': {
      const subject = need('subject');
      const anchor = need('anchor');
      const dir = need('dir');
      if (!dir || !DIRS.includes(dir as never)) return `dir must be one of ${DIRS.join(', ')}`;
      return requireIds([subject, anchor], {
        type: 'direction',
        subject: subject!,
        anchor: anchor!,
        dir: dir as never,
      });
    }
    case 'distance': {
      const a = need('a');
      const b = need('b');
      const degree = need('degree');
      if (!degree || !['adjacent', 'near', 'far'].includes(degree)) {
        return 'degree must be adjacent, near or far';
      }
      return requireIds([a, b], { type: 'distance', a: a!, b: b!, degree: degree as never });
    }
    case 'adjacent-region': {
      const a = need('a');
      const b = need('b');
      const checked = requireIds([a, b], { type: 'adjacent-region', a: a!, b: b! });
      if (typeof checked === 'string') return checked;
      for (const id of [a!, b!]) {
        if (kindOf(id) !== 'region') {
          return (
            `adjacent-region is only for two REGIONS — "${id}" is a ${kindOf(id)}. ` +
            'For anything else use direction, distance, between or on-coast.'
          );
        }
      }
      return checked;
    }
    case 'on-coast': {
      const subject = need('subject');
      const water = need('water');
      const checked = requireIds([subject, water], { type: 'on-coast', subject: subject!, water });
      if (typeof checked === 'string') return checked;
      if (water && kindOf(water) !== 'water') {
        return `on-coast needs a water entity — "${water}" is a ${kindOf(water)}`;
      }
      return checked;
    }
    case 'between': {
      const subject = need('subject');
      const a = need('a');
      const b = need('b');
      return requireIds([subject, a, b], { type: 'between', subject: subject!, a: a!, b: b! });
    }
    case 'connects': {
      const road = need('road');
      const a = need('a');
      const b = need('b');
      const checked = requireIds([road, a, b], { type: 'connects', road: road!, a: a!, b: b! });
      if (typeof checked === 'string') return checked;
      if (kindOf(road) !== 'road') return `connects needs a road entity — "${road}" is a ${kindOf(road)}`;
      return checked;
    }
    default:
      return `unknown relation type "${String(r.type)}"`;
  }
}

export function handleUpsertGeofacts(ctx: ToolContext, raw: Record<string, unknown>): string {
  if (!ctx.map) {
    return 'Error: no map exists yet. If this chapter warrants one, call create_map first.';
  }
  const map = ctx.map;

  // Work on a copy: a failed batch must leave the map untouched.
  const draft: GeoMap = JSON.parse(JSON.stringify(map));
  draft.updatedChapter = ctx.chapter;

  const newEntities: string[] = [];
  if (raw.entities !== undefined) {
    if (!Array.isArray(raw.entities)) return 'Error: entities must be an array.';
    for (const item of raw.entities as unknown[]) {
      if (typeof item !== 'object' || item === null) return 'Error: each entity must be an object.';
      const e = item as Record<string, unknown>;
      const id = typeof e.id === 'string' ? e.id.trim() : '';
      const name = typeof e.name === 'string' ? e.name.trim() : '';
      if (!SLUG.test(id)) return `Error: entity id "${id}" must be a kebab-case slug.`;
      if (!name) return 'Error: every entity needs a name.';
      if (!GEO_ENTITY_KINDS.includes(e.kind as never)) {
        return `Error: entity kind must be one of ${GEO_ENTITY_KINDS.join(', ')}.`;
      }
      const existing = draft.entities[id];
      const extent =
        e.extent === 'vast' || e.extent === 'large' || e.extent === 'medium' || e.extent === 'small'
          ? e.extent
          : existing?.extent;
      const entity: GeoEntity = {
        id,
        kind: e.kind as GeoEntity['kind'],
        name,
        aliases: Array.isArray(e.aliases)
          ? [...new Set((e.aliases as unknown[]).map(String).map((a) => a.trim()).filter(Boolean))].slice(
              0,
              MAP_LIMITS.aliasesPerEntity
            )
          : (existing?.aliases ?? []),
        bibleEntryId: existing?.bibleEntryId ?? null,
        importance: e.importance === 1 || e.importance === 2 || e.importance === 3 ? e.importance : (existing?.importance ?? 2),
        firstChapter: existing?.firstChapter ?? ctx.chapter,
      };
      if (extent) entity.extent = extent;
      // A pin survives every later update; only the author (sketch canvas or
      // an Atlas drag) may set one — extraction can merely inherit it. An
      // author-dragged border is the same contract for a region's shape.
      if (existing?.pin) entity.pin = existing.pin;
      if (existing?.border) entity.border = existing.border;
      if (ctx.allowPins && typeof e.pin === 'object' && e.pin !== null) {
        const pin = e.pin as Record<string, unknown>;
        if (typeof pin.x === 'number' && typeof pin.y === 'number' && Number.isFinite(pin.x) && Number.isFinite(pin.y)) {
          entity.pin = {
            x: Math.min(1000, Math.max(0, Math.round(pin.x * 100) / 100)),
            y: Math.min(1000, Math.max(0, Math.round(pin.y * 100) / 100)),
          };
        }
      }
      if (existing && existing.kind !== entity.kind) {
        return `Error: "${id}" already exists as a ${existing.kind} — an entity cannot change kind.`;
      }
      draft.entities[id] = entity;
      if (!existing) newEntities.push(id);
    }
    if (Object.keys(draft.entities).length > MAP_LIMITS.entitiesPerMap) {
      return `Error: the map is at its limit of ${MAP_LIMITS.entitiesPerMap} places. Add facts about existing places instead.`;
    }
  }

  if (raw.supersede !== undefined) {
    if (!Array.isArray(raw.supersede)) return 'Error: supersede must be an array of fact ids.';
    for (const idRaw of raw.supersede as unknown[]) {
      const id = String(idRaw);
      const fact = draft.facts.find((f) => f.id === id);
      if (!fact) return `Error: no fact with id "${id}" to supersede. Check get_map.`;
      if (fact.supersededBy) return `Error: fact "${id}" is already superseded.`;
      if (fact.confidence === 'author' && !ctx.authorMode) {
        return (
          `Error: fact "${id}" is author-stated canon (${describeRelation(draft, fact)}) — the author's ` +
          'statement wins over anything read from a chapter. Do not supersede it; skip the conflicting fact.'
        );
      }
      fact.supersededBy = 'pending';
    }
  }

  const entityKinds = new Map(Object.entries(draft.entities).map(([id, e]) => [id, e.kind as string]));
  const newFactIds: string[] = [];
  if (raw.facts !== undefined) {
    if (!Array.isArray(raw.facts)) return 'Error: facts must be an array.';
    let seq = draft.facts.filter((f) => f.chapter === ctx.chapter).length;
    for (const item of raw.facts as unknown[]) {
      if (typeof item !== 'object' || item === null) return 'Error: each fact must be an object.';
      const f = item as Record<string, unknown>;
      const relation = parseRelation(f.relation, entityKinds);
      if (typeof relation === 'string') return `Error: ${relation}`;
      // In author mode every fact IS the author speaking, whatever the model
      // labels it — and outside author mode the model cannot claim authorship.
      const confidence = ctx.authorMode ? 'author' : f.confidence === 'implied' ? 'implied' : 'stated';
      // Duplicate suppression: an identical active relation is not re-added,
      // so agent retries stay idempotent.
      const signature = JSON.stringify(relation);
      const dupe = draft.facts.find(
        (existing) => existing.supersededBy === null && JSON.stringify(existing.relation) === signature
      );
      if (dupe) continue;
      const fact: GeoFact = {
        id: `f-${ctx.chapter}-${++seq}`,
        relation,
        confidence,
        chapter: ctx.chapter,
        supersededBy: null,
      };
      const evidence = typeof f.evidence === 'string' ? f.evidence.trim().slice(0, MAP_LIMITS.evidence) : '';
      if (evidence) fact.evidence = evidence;
      draft.facts.push(fact);
      newFactIds.push(fact.id);
    }
    if (draft.facts.length > MAP_LIMITS.factsPerMap) {
      return `Error: the map is at its limit of ${MAP_LIMITS.factsPerMap} facts.`;
    }
  }

  if (newFactIds.length === 0 && newEntities.length === 0) {
    return 'Nothing to do: every fact in this call is already on the map.';
  }

  // Stamp pending supersessions with the first new fact (or a synthetic
  // marker when the update only removes).
  const stamp = newFactIds[0] ?? `removed-ch${ctx.chapter}`;
  for (const fact of draft.facts) {
    if (fact.supersededBy === 'pending') fact.supersededBy = stamp;
  }

  // Orphan check: every entity should participate in ≥1 active fact, or the
  // solver has nothing to place it with.
  for (const id of newEntities) {
    const involved = draft.facts.some(
      (f) => f.supersededBy === null && relationEntityIds(f.relation).includes(id)
    );
    // A pinned entity already has a position — the author drew it there.
    if (!involved && draft.entities[id].kind !== 'region' && !draft.entities[id].pin) {
      return (
        `Error: entity "${id}" has no facts — add at least one relation placing it ` +
        '(within a region, a direction from a known place, on a coast…), or drop it.'
      );
    }
  }

  const result = solveMap(draft, newFactIds);
  if (!result.ok) {
    // A contradiction against author canon is not a supersede-and-retry case:
    // the extraction is wrong by definition, and the fix is to drop it.
    const opposed = draft.facts.find((f) => f.id === result.contradiction.opposedFactId);
    if (opposed?.confidence === 'author' && !ctx.authorMode) {
      return (
        `Error: fact ${result.contradiction.newFactId} conflicts with author-stated canon ` +
        `(${opposed.id}: ${describeRelation(draft, opposed)}) — the author's statement wins. ` +
        'Do not supersede it; skip this fact and continue.'
      );
    }
    return `Error: ${result.contradiction.message}`;
  }

  deriveShapes(draft, result.layout);
  draft.layout = result.layout;
  ctx.map = draft;

  const summary = [
    newEntities.length ? `added ${newEntities.join(', ')}` : '',
    newFactIds.length ? `${newFactIds.length} fact${newFactIds.length === 1 ? '' : 's'}` : '',
    result.diagnostics.unsatisfied.length
      ? `${result.diagnostics.unsatisfied.length} constraint(s) drawn best-effort`
      : '',
  ]
    .filter(Boolean)
    .join('; ');
  return `Updated (${summary}).\n\n${formatMap(draft)}`;
}
