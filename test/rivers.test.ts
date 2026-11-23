import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WEATHER, RIVERS, TOWNS, WORLD, type WeatherSettings } from "../src/config";
import { Simulation } from "../src/sim/simulation";
import {
  Terrain,
  forEachRiverInBounds,
  riverIntersectsCircle,
  type River,
} from "../src/sim/terrain";

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

function collectRivers(): River[] {
  const rivers: River[] = [];
  forEachRiverInBounds(-20_000, -20_000, 20_000, 20_000, (river) => rivers.push(river));
  return rivers;
}

describe("rivers", () => {
  it("are deterministic and stay within the authored width range", () => {
    const first = collectRivers();
    const second = collectRivers();
    const maxAuthored = Math.max(
      ...RIVERS.streams.flatMap((stream) => stream.points.map((point) => point[2])),
    );

    expect(first.length).toBe(RIVERS.streams.length);
    expect(second).toEqual(first);
    for (const river of first) {
      expect(river.stations.length).toBeGreaterThan(20);
      for (const station of river.stations) {
        expect(station.width).toBeGreaterThan(0);
        expect(station.width).toBeLessThanOrEqual(maxAuthored);
      }
    }
  });

  it("carve a channel below the water surface", () => {
    for (const river of collectRivers()) {
      const source = river.stations[0];
      const mouth = river.stations[river.stations.length - 1];
      expect(source.level).toBeGreaterThan(mouth.level);

      for (const station of river.stations) {
        if (station.inLake) continue;
        const water = terrain.waterLevelAt(station.x, station.z);
        expect(water).not.toBeNull();
        // The last station outside the rendered lake polygon can already be
        // inside the slightly wider water query; the lake owns the surface there.
        if (Math.abs(water! - station.level) > 0.01) continue;
        expect(water!).toBeCloseTo(station.level, 2);
        expect(terrain.heightAt(station.x, station.z)).toBeLessThan(station.level);
      }
    }
  });

  it("stay clear of the airfield and town footprints", () => {
    const rivers = collectRivers();
    for (const river of rivers) {
      for (const station of river.stations) {
        expect(Math.hypot(station.x, station.z)).toBeGreaterThan(WORLD.fieldFlattenOuter);
      }
    }

    expect(
      riverIntersectsCircle(
        TOWNS.home.x,
        TOWNS.home.z,
        TOWNS.home.radius + RIVERS.townMargin,
      ),
    ).toBe(false);
  });

  it("treats a river arrival as a ditching", () => {
    const river = collectRivers()[0];
    const station = river.stations.find((point) => !point.inLake);
    expect(station).toBeDefined();

    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "air");
    sim.position.set(station!.x, station!.level + 1.4, station!.z);
    sim.velocity.set(0, -4.5, 0);

    for (let i = 0; i < 120; i++) sim.step(1 / 240);

    expect(sim.mode).toBe("ditched");
    expect(sim.overWater).toBe(true);
    expect(sim.getSummary().mode).toBe("ditched");
  });
});
