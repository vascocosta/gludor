import { Vector3 } from "three";
import { STREAMING, type WeatherSettings } from "../config";
import { clamp, smoothstep } from "../core/math";
import { hash2, mulberry32 } from "../core/rng";
import type { Atmosphere } from "./atmosphere";
import type { Terrain } from "./terrain";

const HOME_X = 620;
const HOME_Z = -720;
const REBUILD_DISTANCE = 2000;
const THERMAL_CHANCE = 0.14;
/**
 * Baseline radius scale for a thermal's cloud marker. The lift column adds
 * `THERMAL_LIFT_WIDTH` on top, so the core can be widened without turning
 * every marker into an enormous cloud.
 */
const THERMAL_RADIUS_SCALE = 2;
/** Extra width of the lift column beyond its marker cloud. */
const THERMAL_LIFT_WIDTH = 2;

export interface Thermal {
  x: number;
  z: number;
  base: number;
  top: number;
  /** Working lift radius. */
  radius: number;
  /** Footprint used for the marker cloud, kept smaller than the lift. */
  cloudRadius: number;
  strength: number;
}

export class LiftSample {
  thermal = 0;
  ridge = 0;
  sink = 0;
  total = 0;
  nearest: Thermal | null = null;
  nearestDistance = Infinity;
  nearestBearing = 0;
}

/**
 * The invisible air: drifting thermal columns, ridge lift and background sink.
 * Thermals come from a deterministic world-cell hash, so the same cell always
 * produces the same thermal no matter which direction or order it is loaded.
 */
export class LiftField {
  readonly thermals: Thermal[] = [];
  /** Increments whenever the active thermal window is rebuilt. */
  version = 0;

  private readonly terrain: Terrain;
  private readonly atmosphere: Atmosphere;
  private readonly settings: WeatherSettings;
  private readonly seed: number;
  private readonly backgroundSink: number;
  private readonly scratchWind = new Vector3();
  private readonly homeCellI = Math.floor(HOME_X / STREAMING.thermalCellSize);
  private readonly homeCellJ = Math.floor(HOME_Z / STREAMING.thermalCellSize);
  private centerX = Number.POSITIVE_INFINITY;
  private centerZ = Number.POSITIVE_INFINITY;

  constructor(terrain: Terrain, atmosphere: Atmosphere, settings: WeatherSettings, seed = 1) {
    this.terrain = terrain;
    this.atmosphere = atmosphere;
    this.settings = settings;
    this.seed = seed;
    this.backgroundSink =
      settings.thermalStrength <= 0.05 ? 0 : -0.22 - Math.max(0, settings.thermalStrength) * 0.09;

    this.refresh(0, 0);
  }

  /** Rebuild the active window when the glider has moved far enough. */
  ensureAround(x: number, z: number): void {
    if (Math.hypot(x - this.centerX, z - this.centerZ) <= REBUILD_DISTANCE) return;
    this.refresh(x, z);
  }

  private refresh(cx: number, cz: number): void {
    this.centerX = cx;
    this.centerZ = cz;
    this.thermals.length = 0;
    this.version++;

    if (this.settings.thermalStrength <= 0.05) return;

    const cell = STREAMING.thermalCellSize;
    const radius = STREAMING.thermalRadius;
    const minI = Math.floor((cx - radius) / cell) - 1;
    const maxI = Math.ceil((cx + radius) / cell) + 1;
    const minJ = Math.floor((cz - radius) / cell) - 1;
    const maxJ = Math.ceil((cz + radius) / cell) + 1;

    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const thermal = this.thermalAtCell(i, j);
        if (!thermal) continue;
        if (Math.hypot(thermal.x - cx, thermal.z - cz) > radius) continue;
        this.thermals.push(thermal);
      }
    }

    // A dependable home thermal so the first climb is never a lottery.
    if (Math.hypot(HOME_X - cx, HOME_Z - cz) <= radius) {
      this.thermals.push(this.makeHomeThermal());
    }
  }

  /**
   * Generate the thermal owned by one world cell, or null. This is the single
   * source of truth used by both the lift sampler and the cloud renderer.
   */
  private thermalAtCell(i: number, j: number): Thermal | null {
    if (this.settings.thermalStrength <= 0.05) return null;
    if (i === this.homeCellI && j === this.homeCellJ) return null;

    const cell = STREAMING.thermalCellSize;
    const rng = mulberry32(Math.floor(hash2(i, j, this.seed + 7717) * 4294967296));
    if (rng() > THERMAL_CHANCE) return null;

    const x = i * cell + rng() * cell;
    const z = j * cell + rng() * cell;
    const ground = this.terrain.heightAt(x, z);
    if (ground >= this.settings.cloudBase - 420) return null;

    // Water surfaces cool the boundary layer, so thermals do not start over
    // lakes. Keeping this check here makes the lift field and its cloud
    // markers agree with the water mesh without extra state.
    const water = this.terrain.waterLevelAt(x, z);
    if (water !== null && ground <= water + 0.6) return null;

    const strength = this.settings.thermalStrength * (0.55 + rng() * 0.75);
    // A workable core: wide enough that a 40-45 degree circle stays inside it,
    // with a little extra width on strong days. The marker cloud keeps the
    // smaller baseline footprint.
    const cloudRadius =
      THERMAL_RADIUS_SCALE * (200 + rng() * 120 + this.settings.thermalStrength * 12);
    const radius = cloudRadius * THERMAL_LIFT_WIDTH;
    const base = ground + 60 + rng() * 90;
    return this.makeThermal(x, z, base, this.settings.cloudBase, radius, cloudRadius, strength);
  }

  private makeHomeThermal(): Thermal {
    const base = this.terrain.heightAt(HOME_X, HOME_Z);
    const cloudRadius = 340 * THERMAL_RADIUS_SCALE;
    return this.makeThermal(
      HOME_X,
      HOME_Z,
      base + 70,
      this.settings.cloudBase,
      cloudRadius * THERMAL_LIFT_WIDTH,
      cloudRadius,
      this.settings.thermalStrength * 1.12,
    );
  }

  private makeThermal(
    x: number,
    z: number,
    base: number,
    top: number,
    radius: number,
    cloudRadius: number,
    strength: number,
  ): Thermal {
    return {
      x,
      z,
      base,
      top: Math.max(base + 250, top),
      radius,
      cloudRadius,
      strength,
    };
  }

  /**
   * Visit every thermal whose generated position lies in the bounds. Used by
   * cloud tiles so markers and lift always describe the same air.
   */
  forEachThermalInBounds(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    visit: (thermal: Thermal) => void,
  ): void {
    if (this.settings.thermalStrength <= 0.05) return;

    const cell = STREAMING.thermalCellSize;
    const minI = Math.floor(minX / cell);
    const maxI = Math.floor(maxX / cell);
    const minJ = Math.floor(minZ / cell);
    const maxJ = Math.floor(maxZ / cell);

    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const thermal = this.thermalAtCell(i, j);
        if (!thermal) continue;
        if (thermal.x < minX || thermal.x > maxX || thermal.z < minZ || thermal.z > maxZ) continue;
        visit(thermal);
      }
    }

    if (HOME_X >= minX && HOME_X <= maxX && HOME_Z >= minZ && HOME_Z <= maxZ) {
      visit(this.makeHomeThermal());
    }
  }

  sample(position: Vector3, _time: number, out = new LiftSample()): LiftSample {
    this.ensureAround(position.x, position.z);

    out.thermal = 0;
    out.ridge = 0;
    out.sink = this.backgroundSink;
    out.total = 0;
    out.nearest = null;
    out.nearestDistance = Infinity;
    out.nearestBearing = 0;

    let ring = 0;
    let bestScore = Infinity;

    for (const thermal of this.thermals) {
      const dx = position.x - thermal.x;
      const dz = position.z - thermal.z;
      const distance = Math.hypot(dx, dz);

      const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      const score = distance - thermal.strength * 40;
      if (score < bestScore) {
        bestScore = score;
        out.nearest = thermal;
        out.nearestDistance = distance;
        out.nearestBearing = bearing;
      }

      const u = (position.y - thermal.base) / (thermal.top - thermal.base);
      if (u <= 0 || u >= 1) continue;

      const radius = thermal.radius * (0.9 + 0.6 * u);
      const shape = smoothstep(0, 0.1, u) * (1 - smoothstep(0.82, 1, u));
      // A flatter top than a Gaussian: the middle of the core stays strong,
      // then the edge fades over roughly the last third of the radius.
      const core =
        thermal.strength *
        Math.exp(-Math.pow(distance / radius, 4)) *
        shape;
      out.thermal += core;

      const ringDistance = distance - 1.95 * radius;
      ring +=
        -0.2 *
        thermal.strength *
        Math.exp(-((ringDistance * ringDistance) / (0.7 * radius) ** 2)) *
        shape;
    }

    // Thermals are sparse, so only apply compensating sink near air that is
    // actually inside the active window. Far outside it the sink is unbiased.
    out.sink += ring;

    // Ridge lift: sample the gradient a little upwind of the aircraft.
    const wind = this.atmosphere.steadyWindAt(position.y, this.scratchWind);
    const horizontalSpeed = Math.hypot(wind.x, wind.z);
    if (horizontalSpeed > 0.6) {
      const ux = wind.x / horizontalSpeed;
      const uz = wind.z / horizontalSpeed;
      const gradient = this.terrain.gradientAt(position.x - ux * 110, position.z - uz * 110, 90);
      let lift = wind.x * gradient.x + wind.z * gradient.z;
      if (lift > 0) {
        const ground = this.terrain.heightAt(position.x, position.z);
        const agl = Math.max(0, position.y - ground);
        const decay = Math.exp(-agl / 280) * (1 - smoothstep(500, 900, agl));
        lift = clamp(lift, 0, 6) * decay;
        out.ridge = lift;
      }
    }

    out.total = out.thermal + out.ridge + out.sink;
    return out;
  }
}
