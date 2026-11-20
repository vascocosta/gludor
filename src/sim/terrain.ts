import { LAKES, MOUNTAINS, WORLD, type WorldConfig } from "../config";
import { lerp, smoothstep } from "../core/math";
import { fbm2D, hash2, mulberry32, ridged2D, valueNoise2D } from "../core/rng";

/**
 * The analytic ground surface, before lakes are carved. It has no extent, so
 * streamed terrain tiles can be generated anywhere and the result is always the
 * same for a given seed.
 */
export function baseHeightAt(x: number, z: number, config: WorldConfig): number {
  const seed = config.seed;

  let h = 315;
  h += 115 * (fbm2D(x * 0.00032, z * 0.00032, 4, seed) - 0.5) * 2;
  h += 44 * (fbm2D(x * 0.0011, z * 0.0011, 4, seed + 7) - 0.5) * 2;

  // The main east-west ridge, just north of the airfield. The crest
  // wanders a little so the slope has bays and spurs to work with. It is
  // finite: a training ridge that fades out about 7 km either side of the
  // field instead of running to every horizon.
  const along = 1 - smoothstep(4200, 7200, Math.abs(x));
  const wobble = 340 * (valueNoise2D(x * 0.00038, 3.7, seed + 11) - 0.5) * 2;
  const dz = z + 2850 + wobble;
  const ridgeProfile = Math.exp(-(dz * dz) / (2 * 760 * 760));
  const crest = 0.8 + 0.42 * ridged2D(x * 0.00075, 2.2, 3, seed + 23);
  h += 610 * ridgeProfile * crest * along;

  // Two broad hills away from the field, for cross-country options.
  h += 330 * Math.exp(-((x - 4300) ** 2 + (z - 700) ** 2) / (2 * 1900 * 1900));
  h += 280 * Math.exp(-((x + 4700) ** 2 + (z - 1500) ** 2) / (2 * 1700 * 1700));

  // A raised shoulder in the far north.
  h += 230 * smoothstep(-4700, -7400, z);

  // Random massifs outside the home bowl: rounded foothills and sharper
  // alpine peaks, some with satellites, all from a deterministic grid.
  h += mountainHeightAt(x, z, config);

  // Fine texture, kept below the ridge scale so gradients stay sane.
  h += 16 * (fbm2D(x * 0.0035, z * 0.0035, 4, seed + 31) - 0.5) * 2;

  // Flat, usable airfield.
  const distance = Math.sqrt(x * x + z * z);
  const flat = 1 - smoothstep(config.fieldFlattenInner, config.fieldFlattenOuter, distance);
  h = lerp(h, config.fieldElevation, flat);

  return Math.max(240, h);
}

// ---------------------------------------------------------------------------
// Mountains
//
// A deterministic grid of massifs, independent of the lake and town grids.
// Each cell owns at most one mountain, with a rounded hill or a sharp alpine
// peak and a few satellites. Contributions fade to zero inside the airfield
// bowl, so the home ridge remains the only mountain near the field.
// ---------------------------------------------------------------------------

const MOUNTAIN_CELL = MOUNTAINS.cellSize;
const MOUNTAIN_CHANCE = MOUNTAINS.chance;
const MOUNTAIN_KEEPOUT = MOUNTAINS.keepOut;
const MOUNTAIN_FADE = MOUNTAINS.fadeOuter;
const MOUNTAIN_MIN_RADIUS = MOUNTAINS.minRadius;
const MOUNTAIN_RADIUS_RANGE = MOUNTAINS.radiusRange;
const MOUNTAIN_ALPINE_RADIUS = MOUNTAINS.alpineRadius;
const MOUNTAIN_ALPINE_RADIUS_RANGE = MOUNTAINS.alpineRadiusRange;
const MOUNTAIN_HILL_HEIGHT = MOUNTAINS.hillHeight;
const MOUNTAIN_HILL_RANGE = MOUNTAINS.hillHeightRange;
const MOUNTAIN_ALPINE_CHANCE = MOUNTAINS.alpineChance;
const MOUNTAIN_ALPINE_HEIGHT = MOUNTAINS.alpineHeight;
const MOUNTAIN_ALPINE_RANGE = MOUNTAINS.alpineHeightRange;
const MOUNTAIN_MAX_HEIGHT = MOUNTAINS.maxHeight;

interface MountainPeak {
  x: number;
  z: number;
  radius: number;
  /** Long axis divided by short axis. */
  aspect: number;
  angle: number;
  height: number;
  alpine: boolean;
  seed: number;
  /** World-space offset into the noise field, so peaks do not share a grain. */
  offset: number;
  /** Cached from `angle`; terrain sampling is too hot to call trig per peak. */
  cos: number;
  sin: number;
  invAspect: number;
  invRadiusSq: number;
}

interface Mountain {
  x: number;
  z: number;
  /** Conservative radius containing the main peak and every satellite. */
  extentSq: number;
  peaks: MountainPeak[];
}

/** Satellite positions along an alpine massif's long axis, in radii. */
const ALPINE_CHAIN = [
  [-0.6, 0.6],
  [-0.7, 0.05, 0.75],
] as const;

function mountainSeed(i: number, j: number, seed: number): number {
  return Math.floor(hash2(i, j, seed + 27011) * 4294967296);
}

function makePeak(
  x: number,
  z: number,
  radius: number,
  aspect: number,
  angle: number,
  height: number,
  alpine: boolean,
  seed: number,
  offset: number,
): MountainPeak {
  return {
    x,
    z,
    radius,
    aspect,
    angle,
    height,
    alpine,
    seed,
    offset,
    cos: Math.cos(angle),
    sin: Math.sin(angle),
    invAspect: 1 / aspect,
    invRadiusSq: 1 / (radius * radius),
  };
}

function makeMountain(i: number, j: number, config: WorldConfig): Mountain | null {
  const rng = mulberry32(mountainSeed(i, j, config.seed));
  if (rng() > MOUNTAIN_CHANCE) return null;

  const x = (i + rng()) * MOUNTAIN_CELL;
  const z = (j + rng()) * MOUNTAIN_CELL;
  // One roll drives both radius ranges, so an alpine massif is simply a
  // narrower version of the same footprint.
  const radiusRoll = rng();

  const aspect = 1 + rng() * 0.8;
  const angle = rng() * Math.PI * 2;
  const alpine = rng() < MOUNTAIN_ALPINE_CHANCE;
  const radius = alpine
    ? MOUNTAIN_ALPINE_RADIUS + radiusRoll * MOUNTAIN_ALPINE_RADIUS_RANGE
    : MOUNTAIN_MIN_RADIUS + radiusRoll * MOUNTAIN_RADIUS_RANGE;
  const height = alpine
    ? MOUNTAIN_ALPINE_HEIGHT + rng() * MOUNTAIN_ALPINE_RANGE
    : MOUNTAIN_HILL_HEIGHT + rng() * MOUNTAIN_HILL_RANGE;

  // Keep the summit itself outside the home bowl. The global fade below then
  // removes any foothill that would still reach inside 6 km.
  if (Math.hypot(x, z) < MOUNTAIN_KEEPOUT + radius * 0.4) return null;

  const seed = Math.floor(rng() * 4294967296);
  const peaks: MountainPeak[] = [
    makePeak(x, z, radius, aspect, angle, height, alpine, seed, rng() * 2000),
  ];

  // Alpine massifs grow a short arete of subsidiary summits along the long
  // axis; ordinary hills occasionally get one shoulder. That keeps ranges from
  // looking like a row of identical cones.
  const satellites = alpine
    ? 2 + Math.floor(rng() * 2)
    : rng() < 0.35
      ? 1
      : 0;
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  for (let n = 0; n < satellites; n++) {
    let px: number;
    let pz: number;
    if (alpine) {
      const along = ALPINE_CHAIN[satellites - 2][n] * radius;
      const across = (rng() - 0.5) * radius * 0.6;
      px = x + cosAngle * along - sinAngle * across;
      pz = z + sinAngle * along + cosAngle * across;
    } else {
      const theta = rng() * Math.PI * 2;
      const distance = radius * (0.35 + rng() * 0.45);
      px = x + Math.cos(theta) * distance;
      pz = z + Math.sin(theta) * distance;
    }

    const satelliteRadius = radius * (alpine ? 0.4 + rng() * 0.22 : 0.4 + rng() * 0.3);
    peaks.push(
      makePeak(
        px,
        pz,
        satelliteRadius,
        aspect * (0.8 + rng() * 0.4),
        angle + (rng() - 0.5) * (alpine ? 0.5 : 1.2),
        height * (alpine ? 0.42 + rng() * 0.33 : 0.3 + rng() * 0.35),
        alpine,
        Math.floor(rng() * 4294967296),
        rng() * 2000,
      ),
    );
  }

  let extent = 0;
  for (const peak of peaks) {
    const dx = peak.x - x;
    const dz = peak.z - z;
    const reach = Math.sqrt(dx * dx + dz * dz) + peak.radius * peak.aspect * 1.05;
    if (reach > extent) extent = reach;
  }

  return { x, z, extentSq: extent * extent, peaks };
}

const mountainCache = new Map<number, Mountain | null>();
let mountainCacheSeed = Number.NaN;

function ensureMountainCache(config: WorldConfig): void {
  if (mountainCacheSeed === config.seed) return;
  mountainCache.clear();
  mountainCacheSeed = config.seed;
}

function mountainAtCell(i: number, j: number, config: WorldConfig): Mountain | null {
  ensureMountainCache(config);
  // Numeric keys avoid allocating a string for every cell on every sample.
  const key = i * 1_000_003 + j;
  const cached = mountainCache.get(key);
  if (cached !== undefined) return cached;

  const mountain = makeMountain(i, j, config);
  if (mountainCache.size > 4096) mountainCache.clear();
  mountainCache.set(key, mountain);
  return mountain;
}

function peakHeightAt(peak: MountainPeak, x: number, z: number): number {
  const dx = x - peak.x;
  const dz = z - peak.z;
  const lx = (dx * peak.cos + dz * peak.sin) * peak.invAspect;
  const lz = -dx * peak.sin + dz * peak.cos;
  const d2 = (lx * lx + lz * lz) * peak.invRadiusSq;
  if (d2 >= 1) return 0;

  const d = Math.sqrt(d2);
  let envelope: number;
  if (peak.alpine) {
    // A broad shoulder with a steep spire on top: a sharp summit that still
    // has workable foothills for ridge lift. The narrow footprint and the
    // conical spire keep the silhouette alpine rather than volcanic.
    const shoulder = smoothstep(1, 0.05, d);
    const spire = Math.pow(1 - d, 1.45);
    envelope = shoulder * 0.3 + spire * 0.7;
  } else {
    envelope = smoothstep(1, 0, d);
  }

  const shape = peak.height * envelope;
  // The noisy fringe adds centimetres; skip the octaves there.
  if (shape < 1) return shape;

  const rough = peak.alpine
    ? 0.72 + 0.52 * ridged2D(x * 0.00085 + peak.offset, z * 0.00085 - peak.offset, 3, peak.seed)
    : 0.84 + 0.28 * fbm2D(x * 0.0016 + peak.offset, z * 0.0016 - peak.offset, 2, peak.seed);

  return shape * rough;
}

export function mountainHeightAt(x: number, z: number, config: WorldConfig): number {
  const distance = Math.sqrt(x * x + z * z);
  if (distance <= MOUNTAIN_KEEPOUT) return 0;
  const clear = smoothstep(MOUNTAIN_KEEPOUT, MOUNTAIN_FADE, distance);

  const cellI = Math.floor(x / MOUNTAIN_CELL);
  const cellJ = Math.floor(z / MOUNTAIN_CELL);
  let height = 0;

  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const mountain = mountainAtCell(cellI + di, cellJ + dj, config);
      if (!mountain) continue;

      const dx = x - mountain.x;
      const dz = z - mountain.z;
      if (dx * dx + dz * dz > mountain.extentSq) continue;

      for (const peak of mountain.peaks) height += peakHeightAt(peak, x, z);
    }
  }

  // Soft knee instead of a hard clamp: overlapping summits ease into the cap
  // rather than ending on a flat mesa.
  const knee = MOUNTAIN_MAX_HEIGHT * 0.8;
  if (height > knee) {
    const room = MOUNTAIN_MAX_HEIGHT - knee;
    const excess = height - knee;
    height = knee + (excess * room) / (excess + room);
  }

  return height * clear;
}

// ---------------------------------------------------------------------------
// Lakes
//
// Lakes come from a deterministic 5 km hash grid. Each cell either owns one
// lake or none, so the same lake always appears at the same place no matter
// how the world is streamed. The carve is applied inside terrainHeightAt, which
// keeps physics, terrain tiles, trees, and the water mesh in agreement.
// ---------------------------------------------------------------------------

const LAKE_CELL = LAKES.cellSize;
const LAKE_CHANCE = LAKES.chance;
const LAKE_MIN_RADIUS = LAKES.minRadius;
const LAKE_RADIUS_RANGE = LAKES.radiusRange;
/** No lake centres inside this radius, keeping the airfield and home thermal clear. */
const LAKE_KEEPOUT = LAKES.keepOut;
const LAKE_MAX_HEIGHT = LAKES.maxCenterHeight;
const LAKE_MAX_RELIEF = LAKES.maxShoreRelief;
const LAKE_MAX_CENTER_DROP = LAKES.maxCenterDrop;
/** Normalised distance at which the shore carve blends back into the terrain. */
const LAKE_OUTER = LAKES.outer;
const LAKE_MARGIN = LAKES.margin;

export interface LakeBounds {
  x: number;
  z: number;
  radius: number;
  aspect: number;
  angle: number;
  amp1: number;
  amp2: number;
  phase1: number;
  phase2: number;
  /** Conservative circular radius that contains the wobbled ellipse. */
  extent: number;
  /** Cached from `angle`; lake sampling is hot enough to avoid trig per call. */
  cos: number;
  sin: number;
}

export interface Lake extends LakeBounds {
  level: number;
  depth: number;
  rim: number;
  waterRadiusX: number;
  waterRadiusZ: number;
}

function lakeSeed(i: number, j: number, seed: number): number {
  return Math.floor(hash2(i, j, seed + 9001) * 4294967296);
}

/**
 * The cheap part of a lake descriptor. This is safe to call for the 3 x 3
 * cells around a terrain sample; the expensive shore sampling only happens
 * when the sample is actually inside a lake's bounding circle.
 */
function makeLakeBase(
  i: number,
  j: number,
  config: WorldConfig,
): { bounds: LakeBounds; rng: () => number } | null {
  const rng = mulberry32(lakeSeed(i, j, config.seed));
  if (rng() > LAKE_CHANCE) return null;

  const x = (i + rng()) * LAKE_CELL;
  const z = (j + rng()) * LAKE_CELL;
  const radius = LAKE_MIN_RADIUS + rng() * LAKE_RADIUS_RANGE;
  const aspect = 1 + rng() * 0.8;
  const angle = rng() * Math.PI * 2;
  const amp1 = 0.06 + rng() * 0.09;
  const amp2 = 0.03 + rng() * 0.06;
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;
  const extent = radius * aspect * (1 + amp1 + amp2);

  return {
    bounds: {
      x,
      z,
      radius,
      aspect,
      angle,
      amp1,
      amp2,
      phase1,
      phase2,
      extent,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
    },
    rng,
  };
}

function makeLake(i: number, j: number, config: WorldConfig): Lake | null {
  const base = makeLakeBase(i, j, config);
  if (!base) return null;

  const { bounds, rng } = base;
  if (Math.hypot(bounds.x, bounds.z) < LAKE_KEEPOUT) return null;

  // Two basins that overlap cannot share one shore at two different water
  // levels. Keep the lake in the lower-indexed cell and drop the later one, so
  // the outcome never depends on which cell happens to be queried first.
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (di === 0 && dj === 0) continue;
      const otherI = i + di;
      const otherJ = j + dj;
      if (otherI > i || (otherI === i && otherJ > j)) continue;

      const other = makeLakeBase(otherI, otherJ, config);
      if (!other) continue;

      const dx = other.bounds.x - bounds.x;
      const dz = other.bounds.z - bounds.z;
      const reach = (bounds.extent + other.bounds.extent) * LAKE_OUTER;
      if (dx * dx + dz * dz < reach * reach) return null;
    }
  }

  const centerHeight = baseHeightAt(bounds.x, bounds.z, config);
  if (centerHeight > LAKE_MAX_HEIGHT) return null;

  // Sample the actual shoreline (and a little outside it) rather than a
  // distant circle. The lowest point sets the water level, so the flat plane
  // can never spill out through a gully in the bank.
  const cosAngle = bounds.cos;
  const sinAngle = bounds.sin;
  let shoreMin = Infinity;
  let shoreMax = -Infinity;
  for (const d of [0.94, 1.0, 1.06, 1.14]) {
    for (let k = 0; k < 24; k++) {
      const theta = (k / 24) * Math.PI * 2;
      const wobble =
        1 +
        bounds.amp1 * Math.sin(3 * theta + bounds.phase1) +
        bounds.amp2 * Math.sin(5 * theta + bounds.phase2);
      const r = bounds.radius * wobble * d;
      const ex = r * Math.cos(theta);
      const ez = r * Math.sin(theta);
      const h = baseHeightAt(
        bounds.x + ex * bounds.aspect * cosAngle - ez * sinAngle,
        bounds.z + ex * bounds.aspect * sinAngle + ez * cosAngle,
        config,
      );
      if (h < shoreMin) shoreMin = h;
      if (h > shoreMax) shoreMax = h;
    }
  }

  if (shoreMax - shoreMin > LAKE_MAX_RELIEF) return null;
  if (centerHeight - shoreMin > LAKE_MAX_CENTER_DROP) return null;

  const level = shoreMin - 2.4;
  if (level < 260) return null;
  const depth = 4 + rng() * 7;
  const rim = 2 + rng() * 5;
  const wobble = 1 + bounds.amp1 + bounds.amp2;

  return {
    ...bounds,
    level,
    depth,
    rim,
    waterRadiusX: bounds.radius * bounds.aspect * wobble * 1.04,
    waterRadiusZ: bounds.radius * wobble * 1.04,
  };
}

const lakeCache = new Map<number, Lake | null>();
const boundsCache = new Map<number, LakeBounds | null>();
let lakeCacheSeed = Number.NaN;

function ensureLakeCaches(config: WorldConfig): void {
  if (lakeCacheSeed === config.seed) return;
  lakeCache.clear();
  boundsCache.clear();
  lakeCacheSeed = config.seed;
}

function lakeAtCell(i: number, j: number, config: WorldConfig): Lake | null {
  ensureLakeCaches(config);
  const key = i * 1_000_003 + j;
  const cached = lakeCache.get(key);
  if (cached !== undefined) return cached;

  const lake = makeLake(i, j, config);
  if (lakeCache.size > 8192) lakeCache.clear();
  lakeCache.set(key, lake);
  return lake;
}

function lakeBoundsAtCell(i: number, j: number, config: WorldConfig): LakeBounds | null {
  ensureLakeCaches(config);
  const key = i * 1_000_003 + j;
  const cached = boundsCache.get(key);
  if (cached !== undefined) return cached;

  const bounds = makeLakeBase(i, j, config)?.bounds ?? null;
  if (boundsCache.size > 16384) boundsCache.clear();
  boundsCache.set(key, bounds);
  return bounds;
}

/** Normalised distance from the lake centre: 1 at the nominal shoreline. */
function lakeDistance(bounds: LakeBounds, dx: number, dz: number): number {
  const ex = (dx * bounds.cos + dz * bounds.sin) / bounds.aspect;
  const ez = -dx * bounds.sin + dz * bounds.cos;
  const theta = Math.atan2(ez, ex);
  const wobble =
    1 +
    bounds.amp1 * Math.sin(3 * theta + bounds.phase1) +
    bounds.amp2 * Math.sin(5 * theta + bounds.phase2);
  return Math.sqrt(ex * ex + ez * ez) / (bounds.radius * wobble);
}

/** Freeboard between the water plane and the top of the shore lip. */
const LAKE_LIP = 2.5;

function carveLake(height: number, lake: Lake, d: number): number {
  const level = lake.level;

  if (d <= 1) {
    // Bowl: deepest at the centre, rising to a small lip just above water.
    const bowl =
      level -
      lake.depth * (1 - smoothstep(0, 0.88, d)) +
      LAKE_LIP * smoothstep(0.8, 1, d);
    return Math.min(height, bowl);
  }

  if (d >= LAKE_OUTER) return height;

  // Low bank that blends back into the natural ground. It is deliberately
  // capped so a lake next to a hillside does not cut a trench into the slope.
  const bankBase = level + LAKE_LIP;
  const bankRise =
    smoothstep(1, 1.16, d) * Math.max(0, Math.min(lake.rim, height - bankBase));
  const bank = bankBase + bankRise;
  const t = smoothstep(1, LAKE_OUTER, d);
  return lerp(bank, height, t);
}

function applyLakes(x: number, z: number, height: number, config: WorldConfig): number {
  const cellI = Math.floor(x / LAKE_CELL);
  const cellJ = Math.floor(z / LAKE_CELL);
  let h = height;

  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = cellI + di;
      const j = cellJ + dj;
      const bounds = lakeBoundsAtCell(i, j, config);
      if (!bounds) continue;

      const dx = x - bounds.x;
      const dz = z - bounds.z;
      const reach = bounds.extent * LAKE_OUTER;
      if (dx * dx + dz * dz > reach * reach) continue;

      const lake = lakeAtCell(i, j, config);
      if (!lake) continue;

      const d = lakeDistance(bounds, dx, dz);
      if (d >= LAKE_OUTER) continue;
      h = carveLake(h, lake, d);

      // Just outside the water polygon the ground must stay above the surface.
      // Neighbouring basins overlap, and their bank blends can otherwise drag
      // one lake's shoreline under its own water plane.
      const floor = lake.level + 0.3;
      if (d > 1 && d < 1.1 && h < floor) h = floor;
    }
  }

  return h;
}

/** The analytic ground with lake basins carved into it. */
export function terrainHeightAt(x: number, z: number, config: WorldConfig): number {
  return applyLakes(x, z, baseHeightAt(x, z, config), config);
}

/**
 * Visit every lake whose flat water plane intersects the given rectangle. The
 * lake grid is infinite, so this is the renderer's window into it.
 */
export function forEachLakeInBounds(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  visit: (lake: Lake) => void,
  config: WorldConfig = WORLD,
): void {
  const minI = Math.floor((minX - LAKE_MARGIN) / LAKE_CELL);
  const maxI = Math.floor((maxX + LAKE_MARGIN) / LAKE_CELL);
  const minJ = Math.floor((minZ - LAKE_MARGIN) / LAKE_CELL);
  const maxJ = Math.floor((maxZ + LAKE_MARGIN) / LAKE_CELL);

  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const lake = lakeAtCell(i, j, config);
      if (!lake) continue;

      const radius = Math.max(lake.waterRadiusX, lake.waterRadiusZ) + 2;
      if (lake.x + radius < minX || lake.x - radius > maxX) continue;
      if (lake.z + radius < minZ || lake.z - radius > maxZ) continue;
      visit(lake);
    }
  }
}

/**
 * Water level at a point, or null when the point is not over a lake. Shared by
 * the terrain sampler and by anything that needs to keep clear of water.
 */
export function waterLevelAt(x: number, z: number, config: WorldConfig = WORLD): number | null {
  const cellI = Math.floor(x / LAKE_CELL);
  const cellJ = Math.floor(z / LAKE_CELL);
  let best: Lake | null = null;
  let bestDistance = Infinity;

  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = cellI + di;
      const j = cellJ + dj;
      const bounds = lakeBoundsAtCell(i, j, config);
      if (!bounds) continue;

      const dx = x - bounds.x;
      const dz = z - bounds.z;
      const reach = bounds.extent * 1.08;
      if (dx * dx + dz * dz > reach * reach) continue;

      const lake = lakeAtCell(i, j, config);
      if (!lake) continue;

      const d = lakeDistance(bounds, dx, dz);
      if (d > 1.08 || d >= bestDistance) continue;
      bestDistance = d;
      best = lake;
    }
  }

  return best ? best.level : null;
}

/**
 * A stateless ground sampler. The same analytic surface is sampled on a
 * world-aligned grid, so physics, terrain tiles, trees, and clouds always
 * agree no matter how far the glider has flown from the airfield.
 */
export class Terrain {
  readonly gridSpacing: number;
  private readonly config: WorldConfig;

  constructor(config: WorldConfig = WORLD) {
    this.config = config;
    this.gridSpacing = config.gridSpacing;
  }

  private nodeHeight(i: number, j: number): number {
    return terrainHeightAt(i * this.gridSpacing, j * this.gridSpacing, this.config);
  }

  heightAt(x: number, z: number): number {
    const spacing = this.gridSpacing;
    const gx = x / spacing;
    const gz = z / spacing;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const tx = gx - i;
    const tz = gz - j;

    const h00 = this.nodeHeight(i, j);
    const h10 = this.nodeHeight(i + 1, j);
    const h01 = this.nodeHeight(i, j + 1);
    const h11 = this.nodeHeight(i + 1, j + 1);

    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /** Water level at a point, or null when the point is not over a lake. */
  waterLevelAt(x: number, z: number): number | null {
    return waterLevelAt(x, z, this.config);
  }

  /** Solid ground or water surface, whichever is higher. */
  surfaceHeightAt(x: number, z: number): number {
    const ground = this.heightAt(x, z);
    const water = this.waterLevelAt(x, z);
    return water !== null && water > ground ? water : ground;
  }

  /** Central-difference gradient in metres per metre. */
  gradientAt(x: number, z: number, delta = 70): { x: number; z: number } {
    const hx = this.heightAt(x + delta, z) - this.heightAt(x - delta, z);
    const hz = this.heightAt(x, z + delta) - this.heightAt(x, z - delta);
    return { x: hx / (2 * delta), z: hz / (2 * delta) };
  }

  normalAt(x: number, z: number, delta = 30): { x: number; y: number; z: number } {
    const g = this.gradientAt(x, z, delta);
    const inv = 1 / Math.hypot(g.x, 1, g.z);
    return { x: -g.x * inv, y: inv, z: -g.z * inv };
  }
}
