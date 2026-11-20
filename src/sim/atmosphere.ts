import { Vector3 } from "three";
import { DEG, clamp } from "../core/math";
import { GRAVITY, RHO0, SEA_LEVEL_TEMP, TEMP_LAPSE, type WeatherSettings } from "../config";
import type { Terrain } from "./terrain";

const Z0 = 0.1;

/**
 * ISA atmosphere plus a usable boundary-layer wind model:
 * logarithmic shear, a little veer with height and seeded gusty turbulence.
 */
export class Atmosphere {
  readonly settings: WeatherSettings;
  private readonly terrain: Terrain;
  private readonly phases: number[];

  constructor(settings: WeatherSettings, terrain: Terrain, seed = 1) {
    this.settings = settings;
    this.terrain = terrain;
    const s = seed * 0.6180339887;
    this.phases = [s * 6.1, s * 12.7 + 1.3, s * 23.9 + 2.7, s * 37.3 + 0.4];
  }

  densityAt(altitude: number): number {
    const h = Math.max(0, altitude);
    if (h > 11000) return 0.3639 * Math.exp(-(h - 11000) / 6341.6);
    const temp = SEA_LEVEL_TEMP - TEMP_LAPSE * h;
    const pressure = 101325 * Math.pow(1 - (TEMP_LAPSE * h) / SEA_LEVEL_TEMP, 5.25588);
    return pressure / (287.05 * temp);
  }

  temperatureAt(altitude: number): number {
    return SEA_LEVEL_TEMP - TEMP_LAPSE * Math.max(0, altitude);
  }

  /** Wind factor from the logarithmic profile. */
  private shearFactor(agl: number): number {
    const h = Math.max(2, agl);
    return clamp(Math.log((h + Z0) / Z0) / Math.log((10 + Z0) / Z0), 0.35, 2.2);
  }

  private baseVector(altitude: number, out: Vector3): Vector3 {
    const speed = Math.max(0, this.settings.windSpeed) / 3.6;
    const agl = Math.max(0, altitude - 300);
    const factor = this.shearFactor(agl);
    const rad = this.settings.windFrom * DEG;

    // Meteorological "from" direction: 0 = from north, 90 = from east.
    // World axes: +X east, +Z south.
    let wx = -Math.sin(rad) * speed * factor;
    let wz = Math.cos(rad) * speed * factor;

    // Slight veer with height (a few degrees per kilometre).
    const veer = (altitude / 1000) * 0.055;
    const cos = Math.cos(veer);
    const sin = Math.sin(veer);
    const rx = wx * cos - wz * sin;
    const rz = wx * sin + wz * cos;

    return out.set(rx, 0, rz);
  }

  /** Smooth mean wind, used for thermal drift. */
  steadyWindAt(altitude: number, out = new Vector3()): Vector3 {
    return this.baseVector(altitude, out);
  }

  /**
   * Wind vector at a point, including seeded gusts. The caller adds vertical
   * lift from thermals and ridges separately.
   */
  windAt(position: Vector3, time: number, out = new Vector3()): Vector3 {
    const ground = this.terrain.heightAt(position.x, position.z);
    const agl = Math.max(0, position.y - ground);
    this.baseVector(position.y, out);

    const turbulence = clamp(this.settings.turbulence, 0, 1);
    if (turbulence <= 0.001) return out;

    const speed = Math.hypot(out.x, out.z);
    const amplitude = turbulence * (0.8 + speed * 0.16);
    const [p0, p1, p2, p3] = this.phases;

    const gustX =
      Math.sin(time * 0.83 + p0) + 0.55 * Math.sin(time * 2.17 + p1) + 0.25 * Math.sin(time * 5.03 + p2);
    const gustZ =
      Math.sin(time * 0.71 + p2) + 0.5 * Math.sin(time * 1.93 + p3) + 0.22 * Math.sin(time * 4.61 + p1);
    const gustY =
      Math.sin(time * 1.07 + p3) + 0.45 * Math.sin(time * 2.71 + p0) + 0.2 * Math.sin(time * 6.13 + p2);

    out.x += (gustX / 1.8) * amplitude;
    out.z += (gustZ / 1.8) * amplitude;
    out.y += (gustY / 1.65) * amplitude * (0.4 + 0.6 * Math.min(1, agl / 300));
    return out;
  }

  /** Equivalent airspeed from true airspeed. */
  indicatedAirspeed(tas: number, altitude: number): number {
    return tas * Math.sqrt(this.densityAt(altitude) / RHO0);
  }

  /** Standard gravity, exposed for convenience in tests. */
  get gravity(): number {
    return GRAVITY;
  }
}
