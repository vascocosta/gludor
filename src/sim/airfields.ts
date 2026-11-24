import { TOWNS, WORLD, type WorldConfig } from "../config";
import { lerp, smoothstep } from "../core/math";
import { hash2, mulberry32 } from "../core/rng";
import {
  rawTerrainHeightAt,
  riverIntersectsCircle,
  setAirfieldSurfaceSource,
  waterLevelAt,
} from "./terrain";
import { HOME_TOWN_NAME, insideTownFootprint, townAnchorForCell } from "./towns";

/**
 * Town airfields. Real soaring country has a grass strip beside most
 * settlements; these give the world relaunch and outlanding options without
 * pretending every village has a 2 km asphalt runway.
 *
 * Placement is a pure function of the town cell, so a strip is identical
 * however the world is streamed or revisited. Roughly half the towns get one,
 * and a site is only used when the ground is dry, off the rivers, clear of the
 * town, and gentle enough to grade into a runway.
 *
 * A strip follows the natural long profile of its hillside but is levelled
 * across its width. Real hill strips do exactly this: the runway rolls gently
 * down the valley, while a glider standing on it is not tipped sideways. The
 * pad is a short ribbon (plus shoulders) blended back into the meadow, so the
 * earthworks stay small and the terrain around it is untouched.
 */
export type AirfieldSurface = "asphalt" | "grass";

export interface AirfieldSpec {
  /** Stable key: "home" for the origin field, otherwise "i:j" of the town cell. */
  id: string;
  /** Name of the town this strip belongs to (or the home town). */
  name: string;
  x: number;
  z: number;
  /** Ground elevation at the middle of the graded pad. */
  elevation: number;
  /** Runway axis in degrees, 0 = north. Always 0..180 (a strip has two ends). */
  heading: number;
  /** Usable runway length and width in metres. */
  length: number;
  width: number;
  surface: AirfieldSurface;
  /** Aerotow needs the home field's long runway and clear departure. */
  tow: boolean;
  home?: boolean;
  /** Surface heights along the pad, sampled every `profileStep` metres. */
  profile: number[];
  profileStep: number;
  /** Along-runway coordinate of the first profile sample. */
  profileStart: number;
}

/** Graded apron dimensions, shared with the renderer and physics. */
export const AIRFIELD = {
  /** Width of the levelled pad, including the shoulders either side of the runway. */
  padWidth: 56,
  /** The pad runs this far beyond each threshold. */
  padExtension: 25,
  /** Distance over which the pad blends back to natural ground. */
  skirt: 40,
  /** Spacing of the long-profile samples. */
  profileStep: 25,
} as const;

function constantProfile(length: number, height: number): number[] {
  const total = length + AIRFIELD.padExtension * 2;
  const count = Math.ceil(total / AIRFIELD.profileStep);
  return Array.from({ length: count + 1 }, () => height);
}

/** The origin field, matching the hand-built runway in the renderer. */
export const HOME_AIRFIELD: AirfieldSpec = {
  id: "home",
  name: HOME_TOWN_NAME,
  x: 0,
  z: 0,
  elevation: WORLD.fieldElevation,
  heading: 0,
  length: WORLD.runwayLength,
  width: WORLD.runwayWidth,
  surface: "asphalt",
  tow: true,
  home: true,
  profile: constantProfile(WORLD.runwayLength, WORLD.fieldElevation),
  profileStep:
    (WORLD.runwayLength + AIRFIELD.padExtension * 2) /
    Math.ceil((WORLD.runwayLength + AIRFIELD.padExtension * 2) / AIRFIELD.profileStep),
  profileStart: -WORLD.runwayLength / 2 - AIRFIELD.padExtension,
};

/** Share of town cells that should own a strip. */
const FIELD_PROBABILITY = 0.5;
/** Grass strips are shorter than the home runway, but still workable. */
const MIN_LENGTH = 520;
const MAX_LENGTH = 1080;
const RUNWAY_WIDTH = 26;
/** Long grades are fine on a hillside strip; steeper than this is not. */
const MAX_GRADE = 0.07;
/** Limit the earthworks needed to level the pad across its width. */
const MAX_CUT_FILL = 3.2;
const MAX_ELEVATION = 760;
/** Keep generated strips clear of the home field and its circuit. */
const HOME_CLEARANCE = 2600;
/** Breathing room from the nearest town building. */
const TOWN_MARGIN = 40;
/** A strip can reach beyond its own 6 km town cell. */
const QUERY_PADDING = 2400;
/** Six axes, 30 degrees apart. */
const HEADING_STEP = 30;
const HEADING_COUNT = 180 / HEADING_STEP;
/** Farthest a sample can be from a town centre and still touch its strip. */
const FIELD_PAD_REACH = 160 + MAX_LENGTH + AIRFIELD.padExtension + AIRFIELD.skirt;

interface FieldPlan {
  spec: AirfieldSpec;
  score: number;
}

interface Site {
  elevation: number;
  profile: number[];
  profileStep: number;
  profileStart: number;
  score: number;
}

const planCache = new Map<string, FieldPlan | null>();
const fieldCache = new Map<string, AirfieldSpec | null>();
let cacheSeed = Number.NaN;

function ensureCaches(config: WorldConfig): void {
  if (cacheSeed === config.seed) return;
  planCache.clear();
  fieldCache.clear();
  cacheSeed = config.seed;
}

function angleDelta(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

/** A heading number, e.g. 7 for 070 degrees. A strip's two ends share an axis. */
export function runwayNumbers(field: AirfieldSpec): string {
  const end = (heading: number): string => {
    const value = Math.round(heading / 10) % 36;
    return String(value === 0 ? 36 : value).padStart(2, "0");
  };
  return `${end(field.heading)}/${end(field.heading + 180)}`;
}

/** The runway end to use, chosen to point into the wind. */
export function takeoffHeading(field: AirfieldSpec, windFrom: number): number {
  const a = field.heading % 360;
  const b = (a + 180) % 360;
  return angleDelta(a, windFrom) <= angleDelta(b, windFrom) ? a : b;
}

/** A rough label for menus and messages. */
export function airfieldLabel(field: AirfieldSpec): string {
  if (field.home) return `${field.name} · Home field`;
  return `${field.name} · ${runwayNumbers(field)} · ${Math.round(field.length)} m`;
}

/** Height of the graded surface at a point along the runway axis. */
export function airfieldHeightAt(field: AirfieldSpec, along: number): number {
  const { profile, profileStart, profileStep } = field;
  if (profile.length < 2) return field.elevation;

  const t = (along - profileStart) / profileStep;
  if (t <= 0) return profile[0];
  const last = profile.length - 1;
  if (t >= last) return profile[last];
  const i = Math.floor(t);
  return lerp(profile[i], profile[i + 1], t - i);
}

/** The runway end nearest a direction, as a world unit vector. */
export function takeoffDirection(field: AirfieldSpec, windFrom: number): [number, number] {
  const heading = (takeoffHeading(field, windFrom) * Math.PI) / 180;
  return [Math.sin(heading), -Math.cos(heading)];
}

/**
 * Score one runway candidate. Samples the long profile, levels it across the
 * pad, and measures how much cut and fill the shoulders need. Returns null if
 * the site is wet, climbs too high, crowds a town, or is too steep to grade.
 */
function scoreSite(
  centerX: number,
  centerZ: number,
  heading: number,
  length: number,
  config: WorldConfig,
): Site | null {
  const h = (heading * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const halfWidth = AIRFIELD.padWidth / 2;
  const start = -length / 2 - AIRFIELD.padExtension;
  const total = length + AIRFIELD.padExtension * 2;
  const samples = Math.ceil(total / AIRFIELD.profileStep);
  const step = total / samples;

  const centers: number[] = [];
  const lefts: number[] = [];
  const rights: number[] = [];

  for (let k = 0; k <= samples; k++) {
    const s = start + k * step;
    const cx = centerX + fx * s;
    const cz = centerZ + fz * s;
    const lx = cx - rx * halfWidth;
    const lz = cz - rz * halfWidth;
    const tx = cx + rx * halfWidth;
    const tz = cz + rz * halfWidth;

    const height = rawTerrainHeightAt(cx, cz, config);
    const leftHeight = rawTerrainHeightAt(lx, lz, config);
    const rightHeight = rawTerrainHeightAt(tx, tz, config);
    if (height > MAX_ELEVATION) return null;

    const water = waterLevelAt(cx, cz, config);
    if (water !== null && height <= water + 0.6) return null;
    const leftWater = waterLevelAt(lx, lz, config);
    if (leftWater !== null && leftHeight <= leftWater + 0.6) return null;
    const rightWater = waterLevelAt(tx, tz, config);
    if (rightWater !== null && rightHeight <= rightWater + 0.6) return null;

    // Only the ends, the middle, and the near corners can reach a town.
    const townCheck = k === 0 || k === samples || k === Math.floor(samples / 2);
    if (townCheck && insideTownFootprint(cx, cz, TOWN_MARGIN, config)) return null;
    if ((k === 0 || k === samples) && insideTownFootprint(lx, lz, TOWN_MARGIN, config)) return null;
    if ((k === 0 || k === samples) && insideTownFootprint(tx, tz, TOWN_MARGIN, config)) return null;

    centers.push(height);
    lefts.push(leftHeight);
    rights.push(rightHeight);
  }

  // Follow the hill along the runway, damped just enough that plough ruts and
  // fine noise do not become speed bumps.
  const profile = centers.map((height, k) =>
    k === 0 || k === centers.length - 1
      ? height
      : (centers[k - 1] + height * 2 + centers[k + 1]) / 4,
  );

  const threshold = Math.round(AIRFIELD.padExtension / step);
  const startElevation = profile[threshold];
  const endElevation = profile[profile.length - 1 - threshold];
  const grade = (endElevation - startElevation) / length;
  if (Math.abs(grade) > MAX_GRADE) return null;

  let maxCutFill = 0;
  for (let k = 0; k < profile.length; k++) {
    maxCutFill = Math.max(
      maxCutFill,
      Math.abs(centers[k] - profile[k]),
      Math.abs(lefts[k] - profile[k]),
      Math.abs(rights[k] - profile[k]),
    );
  }
  if (maxCutFill > MAX_CUT_FILL) return null;

  return {
    elevation: profile[Math.floor(profile.length / 2)],
    profile,
    profileStep: step,
    profileStart: start,
    // Earthworks plus a nudge toward the gentler end-to-end grade.
    score: maxCutFill + Math.abs(grade) * 120,
  };
}

/** Choose the most economical axis around a town, with a seeded preference. */
function planAtCell(i: number, j: number, config: WorldConfig): FieldPlan | null {
  ensureCaches(config);
  const key = `${i}:${j}`;
  const cached = planCache.get(key);
  if (cached !== undefined) return cached;

  const town = townAnchorForCell(i, j, config);
  if (!town || town.home) {
    planCache.set(key, null);
    return null;
  }
  if (hash2(i, j, config.seed + 9173) >= FIELD_PROBABILITY) {
    planCache.set(key, null);
    return null;
  }
  if (Math.hypot(town.x, town.z) < HOME_CLEARANCE + 900) {
    planCache.set(key, null);
    return null;
  }

  const rng = mulberry32(Math.floor(hash2(i, j, config.seed + 9181) * 4294967296));
  const length = MIN_LENGTH + rng() * (MAX_LENGTH - MIN_LENGTH);
  const baseBearing = rng() * Math.PI * 2;
  const preferred = Math.floor(rng() * HEADING_COUNT);
  const distance = town.radius + 160 + length / 2;

  let best: FieldPlan | null = null;
  for (let b = 0; b < 4; b++) {
    const bearing = baseBearing + (b * Math.PI) / 2;
    const cx = town.x + Math.sin(bearing) * distance;
    const cz = town.z + Math.cos(bearing) * distance;
    if (Math.hypot(cx, cz) < HOME_CLEARANCE) continue;
    if (riverIntersectsCircle(cx, cz, length / 2 + AIRFIELD.padExtension + 80, config)) continue;

    for (let k = 0; k < HEADING_COUNT; k++) {
      const heading = k * HEADING_STEP;
      const site = scoreSite(cx, cz, heading, length, config);
      if (!site) continue;

      // On comparable sites follow the seeded heading; a measurably cheaper
      // axis still wins, so terrain shapes the runway where it matters.
      const score = site.score + (k === preferred ? 0 : 0.2);
      if (!best || score < best.score - 1e-9) {
        best = {
          score,
          spec: {
            id: key,
            name: town.name,
            x: cx,
            z: cz,
            elevation: site.elevation,
            heading,
            length,
            width: RUNWAY_WIDTH,
            surface: "grass",
            tow: false,
            profile: site.profile,
            profileStep: site.profileStep,
            profileStart: site.profileStart,
          },
        };
      }
    }
  }

  planCache.set(key, best);
  return best;
}

/** Whether two graded aprons overlap, using a separating-axis test. */
function footprintsOverlap(a: AirfieldSpec, b: AirfieldSpec, margin: number): boolean {
  const axes: Array<[number, number]> = [];
  for (const field of [a, b]) {
    const h = (field.heading * Math.PI) / 180;
    axes.push([Math.sin(h), -Math.cos(h)]);
    axes.push([Math.cos(h), Math.sin(h)]);
  }

  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [ux, uz] of axes) {
    const distance = Math.abs(dx * ux + dz * uz);
    let reach = margin;
    for (const field of [a, b]) {
      const h = (field.heading * Math.PI) / 180;
      reach +=
        Math.abs(Math.sin(h) * ux - Math.cos(h) * uz) * (field.length / 2 + AIRFIELD.padExtension) +
        Math.abs(Math.cos(h) * ux + Math.sin(h) * uz) * (AIRFIELD.padWidth / 2);
    }
    if (distance > reach) return false;
  }
  return true;
}

/** The finished strip owned by a town cell, after neighbour conflicts. */
function airfieldAtCell(i: number, j: number, config: WorldConfig): AirfieldSpec | null {
  ensureCaches(config);
  const key = `${i}:${j}`;
  const cached = fieldCache.get(key);
  if (cached !== undefined) return cached;

  const plan = planAtCell(i, j, config);
  if (!plan) {
    fieldCache.set(key, null);
    return null;
  }

  // Two neighbouring towns can point their strips at each other. Keep the
  // lexicographically lower cell so the result never depends on query order.
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (di === 0 && dj === 0) continue;
      const ni = i + di;
      const nj = j + dj;
      if (ni > i || (ni === i && nj > j)) continue;
      const other = planAtCell(ni, nj, config);
      if (!other) continue;
      if (footprintsOverlap(plan.spec, other.spec, 40)) {
        fieldCache.set(key, null);
        return null;
      }
    }
  }

  fieldCache.set(key, plan.spec);
  return plan.spec;
}

/**
 * The graded apron under a town strip, or null away from every field. This is
 * the hook installed into `terrainHeightAt`, so the physics grid, the terrain
 * mesh and the strip ribbon all agree on the runway surface.
 *
 * Physics calls this dozens of times per step, so the candidate fields for a
 * one-kilometre ground tile are cached. Away from a town the list is empty and
 * the common case costs a couple of number comparisons.
 */
const GROUND_TILE = 1000;
let groundTileI = Number.NaN;
let groundTileJ = Number.NaN;
let groundTileSeed = Number.NaN;
let groundFields: AirfieldSpec[] = [];

function fieldsNearGround(x: number, z: number, config: WorldConfig): AirfieldSpec[] {
  const i = Math.floor(x / GROUND_TILE);
  const j = Math.floor(z / GROUND_TILE);
  if (i === groundTileI && j === groundTileJ && groundTileSeed === config.seed) {
    return groundFields;
  }
  groundTileI = i;
  groundTileJ = j;
  groundTileSeed = config.seed;

  const cx = (i + 0.5) * GROUND_TILE;
  const cz = (j + 0.5) * GROUND_TILE;
  const cell = TOWNS.cellSize;
  const cellI = Math.floor(cx / cell);
  const cellJ = Math.floor(cz / cell);
  const reach = GROUND_TILE * 0.71 + 120;

  const fields: AirfieldSpec[] = [];
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const pi = cellI + di;
      const pj = cellJ + dj;
      const anchor = townAnchorForCell(pi, pj, config);
      if (!anchor) continue;
      if (Math.hypot(cx - anchor.x, cz - anchor.z) > anchor.radius + FIELD_PAD_REACH + reach) {
        continue;
      }
      const field = airfieldAtCell(pi, pj, config);
      if (field) fields.push(field);
    }
  }
  groundFields = fields;
  return fields;
}

function airfieldGroundAt(x: number, z: number, config: WorldConfig): number | null {
  let bestBlend = 0;
  let bestHeight = 0;
  let raw = 0;
  let hasRaw = false;

  for (const field of fieldsNearGround(x, z, config)) {
    const h = (field.heading * Math.PI) / 180;
    const dx = x - field.x;
    const dz = z - field.z;
    const along = dx * Math.sin(h) - dz * Math.cos(h);
    const across = dx * Math.cos(h) + dz * Math.sin(h);
    const outside = Math.max(
      Math.abs(along) - (field.length / 2 + AIRFIELD.padExtension),
      Math.abs(across) - AIRFIELD.padWidth / 2,
    );
    if (outside > AIRFIELD.skirt) continue;

    const blend = outside <= 0 ? 1 : 1 - smoothstep(0, AIRFIELD.skirt, outside);
    if (blend <= bestBlend) continue;
    if (waterLevelAt(x, z, config) !== null) continue;

    if (!hasRaw) {
      raw = rawTerrainHeightAt(x, z, config);
      hasRaw = true;
    }

    bestBlend = blend;
    bestHeight = lerp(raw, airfieldHeightAt(field, along), blend);
  }

  return bestBlend > 0 ? bestHeight : null;
}

setAirfieldSurfaceSource(airfieldGroundAt);

/** Visit every town strip whose footprint can reach the given rectangle. */
export function forEachAirfieldInBounds(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  visit: (field: AirfieldSpec) => void,
  config: WorldConfig = WORLD,
): void {
  ensureCaches(config);
  const cell = TOWNS.cellSize;
  const minI = Math.floor((minX - QUERY_PADDING) / cell);
  const maxI = Math.floor((maxX + QUERY_PADDING) / cell);
  const minJ = Math.floor((minZ - QUERY_PADDING) / cell);
  const maxJ = Math.floor((maxZ + QUERY_PADDING) / cell);

  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const field = airfieldAtCell(i, j, config);
      if (!field) continue;
      visit(field);
    }
  }
}

/** Home plus the nearest strips, for the departure picker. */
export function nearestAirfields(
  x: number,
  z: number,
  count: number,
  radius = 30_000,
  config: WorldConfig = WORLD,
): AirfieldSpec[] {
  const fields: AirfieldSpec[] = [HOME_AIRFIELD];
  forEachAirfieldInBounds(x - radius, z - radius, x + radius, z + radius, (field) => {
    fields.push(field);
  }, config);

  fields.sort((a, b) => {
    const da = Math.hypot(a.x - x, a.z - z);
    const db = Math.hypot(b.x - x, b.z - z);
    if (da !== db) return da - db;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return fields.slice(0, Math.max(1, count));
}

/** True on a field's graded apron, optionally dilated by a margin in metres. */
export function insideAirfieldPad(
  field: AirfieldSpec,
  x: number,
  z: number,
  margin = 0,
): boolean {
  const h = (field.heading * Math.PI) / 180;
  const dx = x - field.x;
  const dz = z - field.z;
  const along = dx * Math.sin(h) - dz * Math.cos(h);
  const across = dx * Math.cos(h) + dz * Math.sin(h);
  return (
    Math.abs(along) <= field.length / 2 + AIRFIELD.padExtension + margin &&
    Math.abs(across) <= AIRFIELD.padWidth / 2 + margin
  );
}

/** True on any graded apron, used to keep trees off the runway and its skirt. */
export function insideAirfield(
  x: number,
  z: number,
  margin = 0,
  config: WorldConfig = WORLD,
): boolean {
  if (insideAirfieldPad(HOME_AIRFIELD, x, z, margin)) return true;

  for (const field of fieldsNearGround(x, z, config)) {
    if (insideAirfieldPad(field, x, z, margin)) return true;
  }
  return false;
}
