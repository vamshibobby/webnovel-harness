import { mulberry32 } from './prng.js';

/**
 * Seeded 2D value noise — enough for organic borders and coastlines, ~40
 * lines, no dependency. Not simplex: value noise's mild axis bias is invisible
 * at the amplitudes maps use (a few units of border wobble).
 */

export interface Noise2D {
  (x: number, y: number): number; // -1..1
}

const GRID = 256;

export function makeNoise2D(seed: number): Noise2D {
  const rng = mulberry32(seed);
  // Lattice of random values, tiled. Permutation-free: direct lattice lookup
  // keeps it obviously deterministic and cheap.
  const lattice = new Float64Array(GRID * GRID);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng() * 2 - 1;

  const at = (ix: number, iy: number) =>
    lattice[((iy % GRID) + GRID) % GRID * GRID + (((ix % GRID) + GRID) % GRID)];

  const fade = (t: number) => t * t * (3 - 2 * t); // smoothstep

  return (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = fade(x - x0);
    const ty = fade(y - y0);
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

/**
 * Fractal sum — two octaves is plenty for border wobble; more just costs.
 */
export function fbm(noise: Noise2D, x: number, y: number): number {
  return noise(x, y) * 0.65 + noise(x * 2.1 + 31.7, y * 2.1 + 17.3) * 0.35;
}
