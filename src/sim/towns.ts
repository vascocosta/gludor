import { TOWNS, WORLD, type WorldConfig } from "../config";
import { hash2, mulberry32, type Rng } from "../core/rng";
import { terrainHeightAt, waterLevelAt } from "./terrain";

/** Buildings are simple boxes with a gabled or pyramidal roof. */
export type BuildingKind = "cottage" | "barn" | "tower";

export interface Building {
  /** Centre of the footprint. */
  x: number;
  z: number;
  /** Rotation about Y. The ridge (or spire base) runs along local X. */
  yaw: number;
  width: number;
  depth: number;
  wallHeight: number;
  roofHeight: number;
  /** Lowest ground under the footprint; walls extend below it to hide slopes. */
  ground: number;
  kind: BuildingKind;
  /** Per-instance colour variation in [0, 1]. */
  tint: number;
}

export interface Town {
  x: number;
  z: number;
  radius: number;
  angle: number;
  /** Main street runs along `angle`, centred on the town. */
  streetLength: number;
  streetWidth: number;
  /** Length of the short cross lane, or 0 for a hamlet. */
  crossLength: number;
  buildings: Building[];
  /** True for the fixed town that anchors the home landscape. */
  home?: boolean;
}

interface TownBase {
  x: number;
  z: number;
  radius: number;
  angle: number;
  rng: Rng;
  home?: boolean;
  /** Guarantee a church tower even when the radius would not usually allow one. */
  forceTower?: boolean;
}

const TOWN_CELL = TOWNS.cellSize;
const TOWN_CHANCE = TOWNS.chance;
const TOWN_KEEPOUT = TOWNS.keepOut;
const TOWN_MIN_RADIUS = TOWNS.minRadius;
const TOWN_RADIUS_RANGE = TOWNS.radiusRange;
const TOWN_MAX_HEIGHT = TOWNS.maxCenterHeight;
const TOWN_MAX_SLOPE = TOWNS.maxSlope;
const TOWN_MAX_BUILDINGS = TOWNS.maxBuildings;

/**
 * Single multiplier for every building dimension. Bump this to make the whole
 * settlement larger; footprints, walls, roofs and the collision roof height all
 * follow, because they are derived from the scaled fields.
 */
export const BUILDING_SCALE = 2;

/** Slope in rise over run, sampled on a 40 m baseline. */
function slopeAt(x: number, z: number, config: WorldConfig): number {
  const d = 40;
  const gx = (terrainHeightAt(x + d, z, config) - terrainHeightAt(x - d, z, config)) / (2 * d);
  const gz = (terrainHeightAt(x, z + d, config) - terrainHeightAt(x, z - d, config)) / (2 * d);
  return Math.hypot(gx, gz);
}

function townSeed(i: number, j: number, seed: number): number {
  return Math.floor(hash2(i, j, seed + 13001) * 4294967296);
}

/** The cheap part of a town descriptor: dice, position, size, street angle. */
function townBase(i: number, j: number, config: WorldConfig): TownBase | null {
  const rng = mulberry32(townSeed(i, j, config.seed));
  if (rng() > TOWN_CHANCE) return null;

  return {
    x: (i + rng()) * TOWN_CELL,
    z: (j + rng()) * TOWN_CELL,
    radius: TOWN_MIN_RADIUS + rng() * TOWN_RADIUS_RANGE,
    angle: rng() * Math.PI * 2,
    rng,
  };
}

function makeTown(i: number, j: number, config: WorldConfig): Town | null {
  const base = townBase(i, j, config);
  if (!base) return null;

  if (Math.hypot(base.x, base.z) < TOWN_KEEPOUT) return null;

  // The home town owns its corner of the valley.
  const homeReach = (base.radius + TOWNS.home.radius) * 1.2;
  if (Math.hypot(base.x - TOWNS.home.x, base.z - TOWNS.home.z) < homeReach) return null;

  // Two towns cannot share a valley bottom. Keep the lower-indexed cell and
  // drop the later one, so the result never depends on query order.
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (di === 0 && dj === 0) continue;
      const otherI = i + di;
      const otherJ = j + dj;
      if (otherI > i || (otherI === i && otherJ > j)) continue;

      const other = townBase(otherI, otherJ, config);
      if (!other) continue;

      const dx = other.x - base.x;
      const dz = other.z - base.z;
      const reach = (base.radius + other.radius) * 1.2;
      if (dx * dx + dz * dz < reach * reach) return null;
    }
  }

  if (terrainHeightAt(base.x, base.z, config) > TOWN_MAX_HEIGHT) return null;
  if (slopeAt(base.x, base.z, config) > TOWN_MAX_SLOPE) return null;

  // Check the rim too: a town square needs a workable plot, and the whole
  // footprint has to stay out of the water.
  for (let k = 0; k < 8; k++) {
    const theta = (k / 8) * Math.PI * 2;
    const px = base.x + Math.cos(theta) * base.radius * 0.8;
    const pz = base.z + Math.sin(theta) * base.radius * 0.8;
    if (slopeAt(px, pz, config) > TOWN_MAX_SLOPE) return null;
    const ground = terrainHeightAt(px, pz, config);
    const water = waterLevelAt(px, pz, config);
    if (water !== null && water > ground - 2) return null;
  }

  return layoutTown(base, config);
}

/** Local (x, z) to world, for a rotation of `yaw` about Y. */
function toWorld(x: number, z: number, yaw: number, lx: number, lz: number): { x: number; z: number } {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return { x: x + lx * cos + lz * sin, z: z - lx * sin + lz * cos };
}

function tryAddBuilding(
  list: Building[],
  x: number,
  z: number,
  yaw: number,
  kind: BuildingKind,
  rng: Rng,
  config: WorldConfig,
): void {
  if (list.length >= TOWN_MAX_BUILDINGS) return;

  let width: number;
  let depth: number;
  let wallHeight: number;
  let roofHeight: number;

  if (kind === "barn") {
    width = 10 + rng() * 3.5;
    depth = 5.5 + rng() * 2;
    wallHeight = 3.2 + rng() * 1.2;
    roofHeight = 1.8 + rng() * 0.9;
  } else if (kind === "tower") {
    width = 4.6;
    depth = 4.6;
    wallHeight = 12 + rng() * 5;
    roofHeight = 3.5 + rng() * 1.5;
  } else {
    width = 5.5 + rng() * 3;
    depth = 4 + rng() * 2;
    wallHeight = 3 + rng() * 1.2;
    roofHeight = 1.6 + rng() * 0.8;
  }

  width *= BUILDING_SCALE;
  depth *= BUILDING_SCALE;
  wallHeight *= BUILDING_SCALE;
  roofHeight *= BUILDING_SCALE;

  let ground = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const [ox, oz] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
    [0, 0],
  ]) {
    const p = toWorld(x, z, yaw, ox * width, oz * depth);
    const height = terrainHeightAt(p.x, p.z, config);
    if (height < ground) ground = height;
    if (height > highest) highest = height;

    const water = waterLevelAt(p.x, p.z, config);
    if (water !== null && water > height - 0.4) return;
  }

  // Steep plots would leave a building floating on one corner.
  if (highest - ground > 3) return;

  list.push({
    x,
    z,
    yaw,
    width,
    depth,
    wallHeight,
    roofHeight,
    ground,
    kind,
    tint: rng(),
  });
}

function layoutTown(base: TownBase, config: WorldConfig): Town {
  const { x, z, radius, angle, rng } = base;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const buildings: Building[] = [];

  const streetLength = radius * 1.3;
  const streetWidth = (radius > 320 ? 5.6 : 4.6) * BUILDING_SCALE;
  const crossLength = radius > 210 ? radius * 0.8 : 0;

  // Rows follow the renderer's street direction (cos, sin); negating the yaw
  // keeps each ridge parallel to the lane it faces.
  const houseYaw = -angle;

  // Two rows of houses facing the street, with a little wobble so the row is
  // not a ruler-straight line. Frontage scales with the house size.
  const perRow = Math.min(
    20,
    Math.max(3, Math.round(streetLength / (34 * BUILDING_SCALE)) + Math.floor(rng() * 3) - 1),
  );
  const spacing = streetLength / (perRow + 1);
  for (const side of [-1, 1]) {
    const offset = (9 + rng() * 3) * BUILDING_SCALE;
    for (let n = 1; n <= perRow; n++) {
      const u = -streetLength / 2 + n * spacing + (rng() - 0.5) * 5;
      const v = side * (offset + rng() * 2.5);
      const bx = x + u * cos - v * sin;
      const bz = z + u * sin + v * cos;
      const yaw = houseYaw + (rng() - 0.5) * 0.1;
      const kind: BuildingKind = rng() < 0.18 ? "barn" : "cottage";
      tryAddBuilding(buildings, bx, bz, yaw, kind, rng, config);
    }
  }

  // Roomier towns get a back row on each side, so the settlement has depth
  // instead of being a single ribbon along the road.
  if (radius > 320) {
    for (const side of [-1, 1]) {
      const backPerRow = Math.max(2, Math.round(perRow * 0.65));
      const backSpacing = streetLength / (backPerRow + 1);
      for (let n = 1; n <= backPerRow; n++) {
        const u = -streetLength / 2 + n * backSpacing + (rng() - 0.5) * 8;
        const v = side * (31 + rng() * 7) * BUILDING_SCALE;
        const bx = x + u * cos - v * sin;
        const bz = z + u * sin + v * cos;
        const yaw = houseYaw + (rng() - 0.5) * 0.1;
        const kind: BuildingKind = rng() < 0.24 ? "barn" : "cottage";
        tryAddBuilding(buildings, bx, bz, yaw, kind, rng, config);
      }
    }
  }

  // The cross lane needs its own frontage, or the side street runs through an
  // empty field.
  if (crossLength > 0) {
    const crossHouses = Math.max(1, Math.round(crossLength / (65 * BUILDING_SCALE)));
    for (let n = 1; n <= crossHouses; n++) {
      const along = -crossLength / 2 + (n / (crossHouses + 1)) * crossLength + (rng() - 0.5) * 5;
      for (const side of [-1, 1]) {
        const across = side * (9 + rng() * 3) * BUILDING_SCALE;
        const bx = x - sin * along + cos * across;
        const bz = z + cos * along + sin * across;
        const yaw = houseYaw - Math.PI / 2 + (rng() - 0.5) * 0.1;
        tryAddBuilding(buildings, bx, bz, yaw, "cottage", rng, config);
      }
    }
  }

  // A few outlying farmsteads, so the town thins out instead of stopping.
  const outliers = 2 + Math.floor(rng() * 4);
  for (let n = 0; n < outliers; n++) {
    const theta = rng() * Math.PI * 2;
    const distance = radius * (0.55 + rng() * 0.33);
    const bx = x + Math.cos(theta) * distance;
    const bz = z + Math.sin(theta) * distance;
    const kind: BuildingKind = rng() < 0.5 ? "barn" : "cottage";
    tryAddBuilding(buildings, bx, bz, rng() * Math.PI, kind, rng, config);
  }

  // A church tower anchors the larger towns. The home town always gets one,
  // so it reads as a landmark from the field.
  if (base.forceTower || (radius > 280 && rng() < 0.55)) {
    const u = (rng() - 0.5) * streetLength * 0.35;
    tryAddBuilding(buildings, x + u * cos, z + u * sin, houseYaw, "tower", rng, config);
  }

  return {
    x,
    z,
    radius,
    angle,
    streetLength,
    streetWidth,
    crossLength,
    buildings,
    home: base.home,
  };
}

const townCache = new Map<string, Town | null>();
let townCacheSeed = Number.NaN;
let homeTownCache: Town | null = null;
let homeTownSeed = Number.NaN;

function ensureTownCaches(config: WorldConfig): void {
  if (townCacheSeed === config.seed) return;
  townCache.clear();
  townCacheSeed = config.seed;
  homeTownCache = null;
  homeTownSeed = Number.NaN;
}

/** The fixed home town, laid out once per seed. */
function homeTownFor(config: WorldConfig): Town {
  if (homeTownCache && homeTownSeed === config.seed) return homeTownCache;

  const home = TOWNS.home;
  const seed = Math.floor(
    hash2(Math.round(home.x), Math.round(home.z), config.seed + 7703) * 4294967296,
  );
  homeTownCache = layoutTown(
    {
      x: home.x,
      z: home.z,
      radius: home.radius,
      angle: home.angle,
      rng: mulberry32(seed),
      home: true,
      forceTower: true,
    },
    config,
  );
  homeTownSeed = config.seed;
  return homeTownCache;
}


function townAtCell(i: number, j: number, config: WorldConfig): Town | null {
  ensureTownCaches(config);
  const key = `${i}:${j}`;
  const cached = townCache.get(key);
  if (cached !== undefined) return cached;

  const town = makeTown(i, j, config);
  if (townCache.size > 4096) townCache.clear();
  townCache.set(key, town);
  return town;
}

/** Visit every town whose footprint overlaps the given rectangle. */
export function forEachTownInBounds(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  visit: (town: Town) => void,
  config: WorldConfig = WORLD,
): void {
  ensureTownCaches(config);

  const home = homeTownFor(config);
  if (
    home.x + home.radius >= minX &&
    home.x - home.radius <= maxX &&
    home.z + home.radius >= minZ &&
    home.z - home.radius <= maxZ
  ) {
    visit(home);
  }

  const minI = Math.floor(minX / TOWN_CELL);
  const maxI = Math.floor(maxX / TOWN_CELL);
  const minJ = Math.floor(minZ / TOWN_CELL);
  const maxJ = Math.floor(maxZ / TOWN_CELL);

  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const town = townAtCell(i, j, config);
      if (!town) continue;
      if (town.x + town.radius < minX || town.x - town.radius > maxX) continue;
      if (town.z + town.radius < minZ || town.z - town.radius > maxZ) continue;
      visit(town);
    }
  }
}

/** The town whose footprint contains (x, z), if any. */
export function townContaining(x: number, z: number, margin = 0, config: WorldConfig = WORLD): Town | null {
  ensureTownCaches(config);

  const home = homeTownFor(config);
  if (Math.hypot(x - home.x, z - home.z) <= home.radius + margin) return home;

  const cellI = Math.floor(x / TOWN_CELL);
  const cellJ = Math.floor(z / TOWN_CELL);

  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const town = townAtCell(cellI + di, cellJ + dj, config);
      if (!town) continue;
      if (Math.hypot(x - town.x, z - town.z) <= town.radius + margin) return town;
    }
  }

  return null;
}

/** True when a point falls inside a town (used to keep trees out). */
export function insideTown(x: number, z: number, margin = 0, config: WorldConfig = WORLD): boolean {
  return townContaining(x, z, margin, config) !== null;
}

/** Roof height at a point, or null when it is not over a building. */
export function buildingHeightAt(x: number, z: number, config: WorldConfig = WORLD): number | null {
  ensureTownCaches(config);

  const home = homeTownFor(config);
  const homeRoof = buildingHeightInTown(home, x, z);
  if (homeRoof !== null) return homeRoof;

  const cellI = Math.floor(x / TOWN_CELL);
  const cellJ = Math.floor(z / TOWN_CELL);

  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const town = townAtCell(cellI + di, cellJ + dj, config);
      if (!town) continue;
      const roof = buildingHeightInTown(town, x, z);
      if (roof !== null) return roof;
    }
  }

  return null;
}

function buildingHeightInTown(town: Town, x: number, z: number): number | null {
  if (Math.hypot(x - town.x, z - town.z) > town.radius + 16) return null;

  for (const building of town.buildings) {
    const dx = x - building.x;
    const dz = z - building.z;
    const c = Math.cos(building.yaw);
    const s = Math.sin(building.yaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (Math.abs(lx) > building.width / 2 || Math.abs(lz) > building.depth / 2) continue;
    return building.ground + building.wallHeight + building.roofHeight;
  }

  return null;
}
