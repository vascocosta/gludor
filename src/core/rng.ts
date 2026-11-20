/** Deterministic seeded random helpers. */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashInt(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth 2D value noise in [0, 1]. */
export function valueNoise2D(x: number, y: number, seed = 1): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = fade(x - xi);
  const ty = fade(y - yi);

  const a = hashInt(xi, yi, seed);
  const b = hashInt(xi + 1, yi, seed);
  const c = hashInt(xi, yi + 1, seed);
  const d = hashInt(xi + 1, yi + 1, seed);

  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/** Fractal Brownian motion, returned in roughly [0, 1]. */
export function fbm2D(x: number, y: number, octaves: number, seed = 1, lacunarity = 2.03, gain = 0.5): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise2D(x * frequency, y * frequency, seed + i * 101);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal, returned in [0, 1] with sharp crests. */
export function ridged2D(x: number, y: number, octaves: number, seed = 1): number {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * frequency, y * frequency, seed + i * 137);
    const ridge = 1 - Math.abs(n * 2 - 1);
    sum += ridge * ridge * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.01;
  }
  return sum / norm;
}

export function hash2(x: number, z: number, seed = 1): number {
  return hashInt(Math.floor(x), Math.floor(z), seed);
}

function wrapInt(value: number, period: number): number {
  return ((value % period) + period) % period;
}

/** Smooth 2D value noise that tiles over `period` lattice cells. */
export function periodicValueNoise2D(x: number, y: number, period: number, seed = 1): number {
  const p = Math.max(1, Math.round(period));
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = fade(x - xi);
  const ty = fade(y - yi);

  const x0 = wrapInt(xi, p);
  const x1 = wrapInt(xi + 1, p);
  const y0 = wrapInt(yi, p);
  const y1 = wrapInt(yi + 1, p);

  const a = hashInt(x0, y0, seed);
  const b = hashInt(x1, y0, seed);
  const c = hashInt(x0, y1, seed);
  const d = hashInt(x1, y1, seed);

  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/** Tileable fractal noise. `period` is the number of lattice cells per tile. */
export function periodicFbm2D(
  x: number,
  y: number,
  period: number,
  octaves: number,
  seed = 1,
  gain = 0.5,
): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let lattice = Math.max(1, Math.round(period));
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * periodicValueNoise2D(x * frequency, y * frequency, lattice, seed + i * 101);
    norm += amplitude;
    amplitude *= gain;
    frequency *= 2;
    lattice *= 2;
  }
  return sum / norm;
}
