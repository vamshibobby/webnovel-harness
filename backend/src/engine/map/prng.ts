/**
 * Seeded determinism. Everything random in the spike flows from these two
 * functions, because the whole architecture rests on one promise: the same
 * facts always draw the same map. FNV-1a is the same hash NovelCover.tsx uses
 * for its deterministic covers.
 */

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small fast PRNG with a full 32-bit state. Deterministic per seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One stable stream per (map, entity) pair, independent of insertion order. */
export function entityRng(mapSeed: number, entityId: string): () => number {
  return mulberry32(mapSeed ^ fnv1a(entityId));
}
