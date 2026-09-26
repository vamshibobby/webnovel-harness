import type { GeoMap } from './types.js';

/**
 * The author's hand on the map, without collateral damage.
 *
 * Dragging one place used to re-solve and re-derive EVERY shape: the Voronoi
 * that carves region borders is seeded by every settlement, so moving a town
 * reshuffled borders the author never touched — the exact "map that rearranges
 * itself" #129 forbids. An author edit is not new geography; it is a statement
 * about one thing. So these functions move exactly that thing and leave every
 * other position and polygon byte-identical.
 */

const clamp = (v: number) => Math.min(1000, Math.max(0, Math.round(v * 100) / 100));

/**
 * Pin an entity where the author dropped it. Translates only its own artifacts:
 * its position, and — when it is a region or water — its own polygon, so the
 * shape travels with its label instead of being re-carved. Returns false when
 * there is no prior layout to edit; the caller should fall back to a full
 * solve, which is what a first placement genuinely is.
 */
export function applyPinEdit(map: GeoMap, entityId: string, pin: { x: number; y: number }): boolean {
  const entity = map.entities[entityId];
  const layout = map.layout;
  if (!entity || !layout) return false;
  const prior = layout.positions[entityId];
  if (!prior) return false;

  const next = { x: clamp(pin.x), y: clamp(pin.y) };
  const dx = next.x - prior.x;
  const dy = next.y - prior.y;
  entity.pin = next;
  layout.positions[entityId] = { x: next.x, y: next.y, solvedAtChapter: map.updatedChapter };

  const translate = (poly: Array<[number, number]> | undefined) =>
    poly?.map(([x, y]) => [Math.round((x + dx) * 100) / 100, Math.round((y + dy) * 100) / 100] as [number, number]);

  if (entity.kind === 'region') {
    const moved = translate(layout.regionPolygons[entityId]);
    if (moved) layout.regionPolygons[entityId] = moved;
    if (entity.border) {
      entity.border = entity.border.map((p) => ({ x: clamp(p.x + dx), y: clamp(p.y + dy) }));
    }
  } else if (entity.kind === 'water') {
    const moved = translate(layout.waterPolygons[entityId]);
    if (moved) layout.waterPolygons[entityId] = moved;
  }
  return true;
}

/**
 * Replace a region's boundary with one the author dragged into shape. The
 * border is stored on the entity — the pin contract — so deriveShapes uses it
 * verbatim from now on and no chapter extraction can redraw it. Returns an
 * error string for the route to surface, or null on success.
 */
export function applyBorderEdit(
  map: GeoMap,
  entityId: string,
  points: Array<{ x: number; y: number }>
): string | null {
  const entity = map.entities[entityId];
  if (!entity) return 'No such place on the map.';
  if (entity.kind !== 'region') return 'Only a region has a border to reshape.';
  if (!map.layout) return 'The map has no layout yet — add a place first.';
  if (points.length < 3) return 'A border needs at least three points.';

  entity.border = points.map((p) => ({ x: clamp(p.x), y: clamp(p.y) }));
  map.layout.regionPolygons[entityId] = entity.border.map((p) => [p.x, p.y]);
  return null;
}
