import { LAKES, MOUNTAINS, RIDGES, RIVERS, WORLD, type RidgeSpec, type WorldConfig } from "../config";
import { lerp, smoothstep } from "../core/math";
import { fbm2D, hash2, mulberry32, ridged2D, valueNoise2D } from "../core/rng";

/**
 * The analytic ground surface, before lakes and rivers are carved. It has no extent, so
 * streamed terrain tiles can be generated anywhere and the result is always the
 * same for a given seed.
 */
export function baseHeightAt(x: number, z: number, config: WorldConfig): number {
  const seed = config.seed;

  let h = 315;
  h += 115 * (fbm2D(x * 0.00032, z * 0.00032, 4, seed) - 0.5) * 2;
  h += 44 * (fbm2D(x * 0.0011, z * 0.0011, 4, seed + 7) - 0.5) * 2;

  // Hand-placed training ridges north of the airfield. A chain rather than a
  // single wall: each bank is finite, with tapered ends and cols between them.
  // Inside the flattened field the ridge would be discarded anyway, so skip
  // its noise entirely.
  const distance = Math.sqrt(x * x + z * z);
  const flat = 1 - smoothstep(config.fieldFlattenInner, config.fieldFlattenOuter, distance);
  if (flat < 1) h += ridgeHeightAt(x, z, config);

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
  h = lerp(h, config.fieldElevation, flat);

  return Math.max(240, h);
}

/**
 * Height added by the hand-placed ridge chain. Each bank has a tapered plateau
 * along its local X axis, a Gaussian cross-section, a meandering crest and ends
 * that fall smoothly into the col, so the chain reads as separate spurs rather
 * than one infinite wall.
 */
export function ridgeHeightAt(x: number, z: number, config: WorldConfig): number {
  let total = 0;
  for (const ridge of RIDGE_FRAMES) {
    const height = ridgeContribution(ridge, x, z, config);
    if (height > 0) total += height;
  }
  return total;
}

interface RidgeFrame extends RidgeSpec {
  cos: number;
  sin: number;
  half: number;
}

/** Trigonometry and half-lengths are fixed, so work them out once. */
const RIDGE_FRAMES: RidgeFrame[] = RIDGES.map((ridge) => ({
  ...ridge,
  cos: Math.cos(ridge.yaw),
  sin: Math.sin(ridge.yaw),
  half: ridge.length / 2,
}));

function ridgeContribution(
  ridge: RidgeFrame,
  x: number,
  z: number,
  config: WorldConfig,
): number {
  const dx = x - ridge.x;
  const dz = z - ridge.z;
  // Local frame: lx runs along the crest, lz across it.
  const lx = dx * ridge.cos - dz * ridge.sin;
  const lz = dx * ridge.sin + dz * ridge.cos;

  const along = 1 - smoothstep(ridge.half - ridge.taper, ridge.half, Math.abs(lx));
  if (along <= 0) return 0;

  // Beyond three widths the Gaussian is below 1%, and the crest meander can
  // never bring the bank that far back. Reject before the noise calls.
  if (Math.abs(lz) > ridge.halfWidth * 3 + 300) return 0;

  // One noise sample drives both the sideways meander of the crest and its
  // height variation, so high points lean in the same direction as the spurs.
  const variation = valueNoise2D(
    lx * 0.0006 + ridge.seed,
    ridge.seed,
    config.seed + 23,
  );
  const bend = 260 * (variation - 0.5) * 2;
  const offset = lz - bend;
  const cross = Math.exp(-(offset * offset) / (2 * ridge.halfWidth * ridge.halfWidth));
  if (cross < 0.01) return 0;

  const crest = 1 + ridge.roughness * (variation - 0.5) * 2;
  return ridge.height * cross * along * crest;
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
// Lakes come from a deterministic 2.5 km hash grid. Each cell either owns one
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

/** The analytic ground with lake basins and stream beds carved into it. */
export function rawTerrainHeightAt(x: number, z: number, config: WorldConfig): number {
  // Carve the lakes first, then the streams. A lake's shore blend reaches well
  // beyond its water polygon and would otherwise fill a nearby river channel
  // back in, burying the ribbon for hundreds of metres.
  return applyRivers(x, z, applyLakes(x, z, baseHeightAt(x, z, config), config), config);
}

/**
 * Town airstrips grade a small apron into the ground. The surface is supplied
 * by the airfield module through this hook, which keeps this file free of the
 * town and terrain dependency cycle. A null result means "raw ground".
 */
export type AirfieldSurfaceSource = (x: number, z: number, config: WorldConfig) => number | null;
let airfieldSurface: AirfieldSurfaceSource | null = null;

export function setAirfieldSurfaceSource(source: AirfieldSurfaceSource | null): void {
  airfieldSurface = source;
}

export function airfieldSurfaceHeightAt(
  x: number,
  z: number,
  config: WorldConfig = WORLD,
): number | null {
  return airfieldSurface ? airfieldSurface(x, z, config) : null;
}

/** The analytic ground, including graded town airstrips. */
export function terrainHeightAt(x: number, z: number, config: WorldConfig): number {
  const airfield = airfieldSurfaceHeightAt(x, z, config);
  if (airfield !== null) return airfield;
  return rawTerrainHeightAt(x, z, config);
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
 * Nearest lake hit from the lake grid alone. Rivers call this when they build
 * their profiles, before the combined water query is available.
 */
function lakeHitAt(
  x: number,
  z: number,
  config: WorldConfig,
  maxDistance: number,
): { level: number; distance: number } | null {
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
      if (d > maxDistance || d >= bestDistance) continue;
      bestDistance = d;
      best = lake;
    }
  }

  return best ? { level: best.level, distance: bestDistance } : null;
}

/**
 * Water level at a point from the lake grid alone. Rivers call this when they
 * build their profiles, before the combined water query is available.
 */
function lakeWaterLevelAt(
  x: number,
  z: number,
  config: WorldConfig,
  maxDistance = 1.08,
): number | null {
  return lakeHitAt(x, z, config, maxDistance)?.level ?? null;
}

/**
 * Lake level using the extent of the rendered water polygon. River bank meshes
 * use this to tuck their apron under the lake surface at a stream mouth.
 */
export function lakeSurfaceLevelAt(
  x: number,
  z: number,
  config: WorldConfig = WORLD,
): number | null {
  return lakeHitAt(x, z, config, 1.02)?.level ?? null;
}

// ---------------------------------------------------------------------------
// Rivers
//
// A small hand-authored network near the field. Each stream is a Catmull-Rom
// centreline sampled into short segments. The same station list drives terrain
// carving, water queries, and the rendered ribbon, so the three cannot drift
// apart. A coarse spatial hash keeps river sampling cheap during terrain builds.
// ---------------------------------------------------------------------------

const RIVER_BANK = RIVERS.bankWidth;
const RIVER_DEPTH = RIVERS.depth;
const RIVER_GRID = 128;
/**
 * Estuary basin around a lake mouth. The lake's shore lip normally stands a
 * couple of metres above the water plane; inside this radius the lip is pulled
 * below the lake surface so the river enters through open water rather than a
 * narrow notch between two grass spits.
 */
const MOUTH_BASIN_RADIUS = 300;
const MOUTH_BASIN_DEPTH = 3;

export interface RiverStation {
  x: number;
  z: number;
  /** Full width of the water ribbon. */
  width: number;
  /** Water surface height at the station. */
  level: number;
  /** True inside an existing lake, where the lake water owns the surface. */
  inLake: boolean;
}

export interface River {
  stations: RiverStation[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** First station over a rendered lake polygon, if the stream ends in one. */
  mouth: { x: number; z: number; level: number } | null;
}

interface RiverHit {
  distance: number;
  halfWidth: number;
  level: number;
  flowX: number;
  flowZ: number;
}

interface RiverSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfA: number;
  halfB: number;
  levelA: number;
  levelB: number;
  flowX: number;
  flowZ: number;
  influence: number;
}

const riverCache = {
  seed: Number.NaN,
  rivers: [] as River[],
  segments: [] as RiverSegment[],
  grid: new Map<number, number[]>(),
};

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function sampleRiver(
  spec: { points: ReadonlyArray<readonly [number, number, number]> },
  config: WorldConfig,
): River {
  const points = spec.points;
  const stations: RiverStation[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / RIVERS.stationSpacing),
    );

    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      stations.push({
        x: catmullRom(p0[0], p1[0], p2[0], p3[0], t),
        z: catmullRom(p0[1], p1[1], p2[1], p3[1], t),
        width: lerp(p1[2], p2[2], t),
        level: 0,
        inLake: false,
      });
    }
  }

  const last = points[points.length - 1];
  stations.push({ x: last[0], z: last[1], width: last[2], level: 0, inLake: false });
  if (stations.length < 2) {
    return {
      stations,
      minX: last[0],
      minZ: last[1],
      maxX: last[0],
      maxZ: last[1],
      mouth: null,
    };
  }

  const rawHeights = stations.map((station) => baseHeightAt(station.x, station.z, config));
  const distances: number[] = [0];
  let total = 0;
  for (let i = 1; i < stations.length; i++) {
    total += Math.hypot(stations[i].x - stations[i - 1].x, stations[i].z - stations[i - 1].z);
    distances.push(total);
  }

  const startLake = lakeWaterLevelAt(stations[0].x, stations[0].z, config);
  const endLake = lakeWaterLevelAt(last[0], last[1], config);

  for (let i = 0; i < stations.length; i++) {
    const progress = total > 0 ? distances[i] / total : 1;
    // Follow the local ground closely. The western river crosses a broad
    // saddle on its way down from the mountain, so a strictly monotonic
    // profile would cut a deep, invisible gorge; a shallow river bed that
    // follows the land reads far better from the air.
    let target = rawHeights[i] - 0.9;
    if (startLake !== null && progress < 0.15) {
      target = lerp(startLake, target, smoothstep(0, 0.15, progress));
    }
    if (endLake !== null && progress > 0.75) {
      target = lerp(target, endLake, smoothstep(0.75, 0.95, progress));
    }
    const level = Math.min(target, rawHeights[i] - 0.6);
    // Use the rendered lake polygon's extent, not the slightly wider water
    // query radius, so the river ribbon does not stop short of the lake.
    const lakeAtStation = lakeWaterLevelAt(stations[i].x, stations[i].z, config, 1.02);
    stations[i].level = lakeAtStation !== null ? Math.min(level, lakeAtStation) : level;
    stations[i].inLake = lakeAtStation !== null;
  }

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let mouth: River["mouth"] = null;
  for (const station of stations) {
    if (!mouth && station.inLake) {
      mouth = { x: station.x, z: station.z, level: station.level };
    }
    minX = Math.min(minX, station.x);
    minZ = Math.min(minZ, station.z);
    maxX = Math.max(maxX, station.x);
    maxZ = Math.max(maxZ, station.z);
  }

  return { stations, minX, minZ, maxX, maxZ, mouth };
}

function riverGridKey(cx: number, cz: number): number {
  return cx * 1_000_003 + cz;
}

function ensureRiverCaches(config: WorldConfig): void {
  if (riverCache.seed === config.seed) return;
  riverCache.seed = config.seed;
  riverCache.rivers = RIVERS.streams.map((spec) => sampleRiver(spec, config));
  riverCache.segments = [];
  riverCache.grid.clear();

  for (const river of riverCache.rivers) {
    for (let i = 0; i < river.stations.length - 1; i++) {
      const a = river.stations[i];
      const b = river.stations[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const segment: RiverSegment = {
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
        halfA: a.width / 2,
        halfB: b.width / 2,
        levelA: a.level,
        levelB: b.level,
        flowX: (b.x - a.x) / length,
        flowZ: (b.z - a.z) / length,
        influence: Math.max(a.width, b.width) / 2 + RIVER_BANK + 4,
      };
      const index = riverCache.segments.push(segment) - 1;
      const minCX = Math.floor((Math.min(a.x, b.x) - segment.influence) / RIVER_GRID);
      const maxCX = Math.floor((Math.max(a.x, b.x) + segment.influence) / RIVER_GRID);
      const minCZ = Math.floor((Math.min(a.z, b.z) - segment.influence) / RIVER_GRID);
      const maxCZ = Math.floor((Math.max(a.z, b.z) + segment.influence) / RIVER_GRID);
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        for (let cx = minCX; cx <= maxCX; cx++) {
          const key = riverGridKey(cx, cz);
          const list = riverCache.grid.get(key);
          if (list) list.push(index);
          else riverCache.grid.set(key, [index]);
        }
      }
    }
  }
}

function riverSampleAt(x: number, z: number, config: WorldConfig): RiverHit | null {
  ensureRiverCaches(config);
  const list = riverCache.grid.get(
    riverGridKey(Math.floor(x / RIVER_GRID), Math.floor(z / RIVER_GRID)),
  );
  if (!list) return null;

  let best: RiverHit | null = null;
  for (const index of list) {
    const segment = riverCache.segments[index];
    const dx = segment.bx - segment.ax;
    const dz = segment.bz - segment.az;
    const lengthSq = dx * dx + dz * dz;
    const t =
      lengthSq > 0
        ? Math.max(0, Math.min(1, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq))
        : 0;
    const distance = Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t));
    const halfWidth = lerp(segment.halfA, segment.halfB, t);
    if (distance > halfWidth + RIVER_BANK) continue;

    if (!best || distance < best.distance) {
      best = {
        distance,
        halfWidth,
        level: lerp(segment.levelA, segment.levelB, t),
        flowX: segment.flowX,
        flowZ: segment.flowZ,
      };
    }
  }

  return best;
}

function applyRivers(x: number, z: number, height: number, config: WorldConfig): number {
  const hit = riverSampleAt(x, z, config);
  let carved = height;
  if (hit && hit.distance < hit.halfWidth + RIVER_BANK) {
    if (hit.distance <= hit.halfWidth) {
      const t = hit.halfWidth > 0 ? hit.distance / hit.halfWidth : 0;
      const bed = hit.level - RIVER_DEPTH * (1 - 0.58 * t * t);
      carved = Math.min(height, bed);
    } else {
      const t = smoothstep(hit.halfWidth, hit.halfWidth + RIVER_BANK, hit.distance);
      const bank = lerp(hit.level + 0.16, height, t);
      carved = Math.min(height, bank);
    }
  }

  // Estuary basin: inside the rendered lake polygon, pull the shore lip down
  // around the mouth. The lake surface then covers the whole junction.
  ensureRiverCaches(config);
  for (const river of riverCache.rivers) {
    const mouth = river.mouth;
    if (!mouth) continue;
    const dx = x - mouth.x;
    const dz = z - mouth.z;
    if (dx * dx + dz * dz > MOUTH_BASIN_RADIUS * MOUTH_BASIN_RADIUS) continue;
    const lake = lakeHitAt(x, z, config, 1.02);
    if (lake !== null) {
      // Taper to zero at the polygon edge so the water plane still sits inside
      // its own shore; the centre of the mouth gets the full basin depth.
      const shore = smoothstep(1.02, 0.94, lake.distance);
      if (shore > 0) {
        carved = Math.min(carved, lake.level - MOUTH_BASIN_DEPTH * shore);
      }
    }
  }

  return carved;
}

/**
 * Water level at a point, or null when it is not over a lake or stream. Shared
 * by the terrain sampler and by anything that needs to keep clear of water.
 */
export function waterLevelAt(x: number, z: number, config: WorldConfig = WORLD): number | null {
  const lake = lakeWaterLevelAt(x, z, config);
  if (lake !== null) return lake;
  const river = riverSampleAt(x, z, config);
  return river && river.distance <= river.halfWidth ? river.level : null;
}

/** Visit every hand-placed stream whose bounds overlap the rectangle. */
export function forEachRiverInBounds(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  visit: (river: River) => void,
  config: WorldConfig = WORLD,
): void {
  ensureRiverCaches(config);
  for (const river of riverCache.rivers) {
    if (river.maxX < minX || river.minX > maxX) continue;
    if (river.maxZ < minZ || river.minZ > maxZ) continue;
    visit(river);
  }
}

/** True when a circle reaches a river water or bank corridor. */
export function riverIntersectsCircle(
  cx: number,
  cz: number,
  radius: number,
  config: WorldConfig = WORLD,
): boolean {
  ensureRiverCaches(config);
  for (const segment of riverCache.segments) {
    const dx = segment.bx - segment.ax;
    const dz = segment.bz - segment.az;
    const lengthSq = dx * dx + dz * dz;
    const t =
      lengthSq > 0
        ? Math.max(0, Math.min(1, ((cx - segment.ax) * dx + (cz - segment.az) * dz) / lengthSq))
        : 0;
    const distance = Math.hypot(cx - (segment.ax + dx * t), cz - (segment.az + dz * t));
    if (distance <= radius + segment.influence) return true;
  }
  return false;
}

/**
 * Distance beyond the river bank, or Infinity away from every stream. The
 * terrain streamer uses this to cut a matching hole for the high-resolution
 * river channel mesh.
 */
export function riverBankClearanceAt(x: number, z: number, config: WorldConfig = WORLD): number {
  const hit = riverSampleAt(x, z, config);
  return hit ? hit.distance - (hit.halfWidth + RIVER_BANK) : Infinity;
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
    // A graded airstrip is a precise local surface; the 50 m collision grid is
    // too coarse to represent a 26 m runway, so use the analytic pad directly.
    const airfield = airfieldSurfaceHeightAt(x, z, this.config);
    if (airfield !== null) return airfield;

    // The 50 m collision grid cannot resolve a 20-40 m stream. Near a river
    // use the analytic carved bed, so the water surface is never below an
    // invisible collision wall and a landing actually ditches.
    if (riverBankClearanceAt(x, z, this.config) < 4) {
      return rawTerrainHeightAt(x, z, this.config);
    }

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

  /**
   * Height of the rendered terrain surface, using the same diagonal split as
   * `TerrainStreamer`. Roads and other ground-hugging meshes must sample this
   * rather than the bilinear `heightAt`, or the triangle surface can rise
   * above them on convex ground and bury parts of the ribbon.
   */
  renderHeightAt(x: number, z: number): number {
    const airfield = airfieldSurfaceHeightAt(x, z, this.config);
    if (airfield !== null) return airfield;

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

    // The mesh splits each cell from (0,0) to (1,1).
    return tz >= tx
      ? h00 + (h01 - h00) * tz + (h11 - h01) * tx
      : h00 + (h10 - h00) * tx + (h11 - h10) * tz;
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
