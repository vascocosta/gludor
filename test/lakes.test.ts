import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WEATHER, LAKES, WORLD, type WeatherSettings } from "../src/config";
import { Atmosphere } from "../src/sim/atmosphere";
import { LiftField } from "../src/sim/lift";
import { Simulation } from "../src/sim/simulation";
import { Terrain, forEachLakeInBounds, forEachRiverInBounds, type Lake } from "../src/sim/terrain";

const stillAir: WeatherSettings = {
  ...DEFAULT_WEATHER,
  windSpeed: 0,
  windFrom: 180,
  thermalStrength: 0,
  turbulence: 0,
  cloudBase: 2400,
};

let terrain: Terrain;

beforeAll(() => {
  terrain = new Terrain();
});

function collectLakes(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): Lake[] {
  const lakes: Lake[] = [];
  forEachLakeInBounds(minX, minZ, maxX, maxZ, (lake) => lakes.push(lake));
  return lakes;
}

function lakeKey(lake: Lake): string {
  return `${lake.x.toFixed(3)}:${lake.z.toFixed(3)}`;
}

/** Boundary point of a lake at normalised distance d, matching the water mesh. */
function lakeBoundary(lake: Lake, d: number, k: number, segments: number): { x: number; z: number } {
  const theta = (k / segments) * Math.PI * 2;
  const wobble =
    1 +
    lake.amp1 * Math.sin(3 * theta + lake.phase1) +
    lake.amp2 * Math.sin(5 * theta + lake.phase2);
  const r = lake.radius * wobble * d;
  const ex = r * Math.cos(theta);
  const ez = r * Math.sin(theta);
  const cosAngle = Math.cos(lake.angle);
  const sinAngle = Math.sin(lake.angle);
  return {
    x: lake.x + ex * lake.aspect * cosAngle - ez * sinAngle,
    z: lake.z + ex * lake.aspect * sinAngle + ez * cosAngle,
  };
}

describe("lakes", () => {
  it("are deterministic wherever the world is queried", () => {
    const first = collectLakes(-40_000, -40_000, 40_000, 40_000);
    const second = collectLakes(-40_000, -40_000, 40_000, 40_000);
    // Query a shifted window and merge, as streamed tiles would.
    const shifted = collectLakes(0, 0, 80_000, 80_000);

    expect(first.length).toBeGreaterThan(0);
    expect(second.map(lakeKey)).toEqual(first.map(lakeKey));
    for (const lake of shifted) {
      const match = first.find((other) => lakeKey(other) === lakeKey(lake));
      if (match) expect(lake).toEqual(match);
    }
  });

  it("stay away from the airfield and the home thermal", () => {
    const nearField = collectLakes(-25_000, -25_000, 25_000, 25_000);
    for (const lake of nearField) {
      expect(Math.hypot(lake.x, lake.z)).toBeGreaterThanOrEqual(LAKES.keepOut);
    }
    expect(terrain.waterLevelAt(0, 0)).toBeNull();
    expect(terrain.waterLevelAt(620, -720)).toBeNull();
  });

  it("leave a believable number of landmarks within a typical flight area", () => {
    const lakes = collectLakes(-20_000, -30_000, 20_000, 30_000);
    expect(lakes.length).toBeGreaterThanOrEqual(2);
    // Lake country, not an archipelago.
    expect(lakes.length).toBeLessThan(200);
    for (const lake of lakes) {
      expect(lake.radius).toBeGreaterThanOrEqual(LAKES.minRadius);
      expect(lake.radius).toBeLessThanOrEqual(LAKES.minRadius + LAKES.radiusRange);
      expect(lake.depth).toBeGreaterThan(0);
      expect(lake.level).toBeGreaterThanOrEqual(260);
    }
  });

  it("keep the water plane inside the carved basin", () => {
    const lakes = collectLakes(-60_000, -60_000, 60_000, 60_000);
    expect(lakes.length).toBeGreaterThan(0);

    // Stream mouths intentionally breach the shore lip to form a small estuary,
    // so the coarse collision grid can dip below the plane near them.
    const mouths: { x: number; z: number }[] = [];
    forEachRiverInBounds(-60_000, -60_000, 60_000, 60_000, (river) => {
      if (river.mouth) mouths.push(river.mouth);
    });

    for (const lake of lakes) {
      expect(terrain.waterLevelAt(lake.x, lake.z)).toBeCloseTo(lake.level, 6);
      // The lake bed is below the surface at its centre.
      expect(terrain.heightAt(lake.x, lake.z)).toBeLessThan(lake.level);

      // The rendered shoreline sits just above the water all the way round.
      for (let k = 0; k < 72; k++) {
        const point = lakeBoundary(lake, 1.02, k, 72);
        if (mouths.some((mouth) => Math.hypot(point.x - mouth.x, point.z - mouth.z) < 360)) {
          continue;
        }
        const ground = terrain.heightAt(point.x, point.z);
        expect(ground).toBeGreaterThan(lake.level + 0.15);
      }
    }
  });

  it("treats a water arrival as a gentle ditching, not a crash", () => {
    const lakes = collectLakes(-30_000, -30_000, 30_000, 30_000);
    const lake = lakes[0];
    expect(lake).toBeDefined();

    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "air");
    sim.position.set(lake.x, lake.level + 1.6, lake.z);
    sim.velocity.set(0, -4.5, 0);

    const dt = 1 / 240;
    for (let i = 0; i < 120; i++) sim.step(dt);

    expect(sim.mode).toBe("ditched");
    expect(sim.overWater).toBe(true);
    expect(sim.agl).toBeLessThan(2);
    expect(sim.getSummary().mode).toBe("ditched");
  });

  it("suppress thermals over open water", () => {
    const lift = new LiftField(
      terrain,
      new Atmosphere(DEFAULT_WEATHER, terrain, WORLD.seed),
      DEFAULT_WEATHER,
      WORLD.seed,
    );

    let thermals = 0;
    lift.forEachThermalInBounds(-60_000, -60_000, 60_000, 60_000, (thermal) => {
      thermals++;
      const water = terrain.waterLevelAt(thermal.x, thermal.z);
      if (water !== null) {
        expect(terrain.heightAt(thermal.x, thermal.z)).toBeGreaterThan(water + 0.6);
      }
    });
    expect(thermals).toBeGreaterThan(0);
  });
});
