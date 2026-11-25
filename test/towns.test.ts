import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WEATHER, TOWNS, type WeatherSettings } from "../src/config";
import { Simulation } from "../src/sim/simulation";
import { Terrain, waterLevelAt } from "../src/sim/terrain";
import {
  HOME_TOWN_NAME,
  buildingHeightAt,
  forEachTownInBounds,
  insideTown,
  type Town,
} from "../src/sim/towns";

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

function collect(minX: number, minZ: number, maxX: number, maxZ: number): Town[] {
  const towns: Town[] = [];
  forEachTownInBounds(minX, minZ, maxX, maxZ, (town) => towns.push(town));
  return towns;
}

function townKey(town: Town): string {
  return `${town.x.toFixed(3)}:${town.z.toFixed(3)}`;
}

describe("towns", () => {
  it("are deterministic wherever the world is queried", () => {
    const first = collect(-40_000, -40_000, 40_000, 40_000);
    const second = collect(-40_000, -40_000, 40_000, 40_000);
    const shifted = collect(0, 0, 80_000, 80_000);

    expect(first.length).toBeGreaterThan(0);
    expect(second.map(townKey)).toEqual(first.map(townKey));
    expect(second.map((town) => town.name)).toEqual(first.map((town) => town.name));
    for (const town of shifted) {
      const match = first.find((other) => townKey(other) === townKey(town));
      if (match) expect(town).toEqual(match);
    }
  });

  it("stay away from the airfield and its runway", () => {
    for (const town of collect(-20_000, -20_000, 20_000, 20_000)) {
      if (town.home) continue;
      expect(Math.hypot(town.x, town.z)).toBeGreaterThanOrEqual(TOWNS.keepOut);
    }
    expect(insideTown(0, 0)).toBe(false);
    expect(insideTown(0, -1000)).toBe(false);
    expect(insideTown(0, 1000)).toBe(false);
    expect(buildingHeightAt(0, 0)).toBeNull();
  });

  it("gives every town a stable fictional name", () => {
    const towns = collect(-40_000, -40_000, 40_000, 40_000);
    expect(towns.length).toBeGreaterThan(0);
    for (const town of towns) {
      expect(town.name.length).toBeGreaterThan(2);
      expect(town.name.trim()).toBe(town.name);
    }
    expect(new Set(towns.map((town) => town.name)).size).toBeGreaterThan(
      towns.length * 0.9,
    );
  });

  it("spreads its buildings across a coherent town footprint", () => {
    const towns = collect(-20_000, -30_000, 20_000, 30_000);
    expect(towns.length).toBeGreaterThan(0);

    for (const town of towns) {
      // Street grids vary from loose village lanes to a full market grid; the
      // outline can trim a few edge lanes, so the count is not fixed.
      expect(town.streets.length).toBeGreaterThanOrEqual(8);
      expect(town.streets.length).toBeLessThanOrEqual(18);
      const xs = town.buildings.map((building) => building.x);
      const zs = town.buildings.map((building) => building.z);
      const width = Math.max(...xs) - Math.min(...xs);
      const depth = Math.max(...zs) - Math.min(...zs);
      expect(Math.min(width, depth)).toBeGreaterThan(Math.max(width, depth) * 0.35);
    }
  });

  it("anchors the home landscape with a fixed town", () => {
    const home = TOWNS.home;
    const towns = collect(home.x - 1000, home.z - 1000, home.x + 1000, home.z + 1000);
    const village = towns.find((town) => town.home);

    expect(village).toBeDefined();
    expect(village!.name).toBe(HOME_TOWN_NAME);
    expect(village!.x).toBeCloseTo(home.x, 6);
    expect(village!.z).toBeCloseTo(home.z, 6);
    expect(village!.radius).toBe(home.radius);
    expect(Math.hypot(village!.x, village!.z)).toBeLessThan(TOWNS.keepOut);
    // Buildings are drawn at 2x scale with matching frontage, so the fixed
    // village has fewer, larger plots than before.
    expect(village!.buildings.length).toBeGreaterThan(30);
    expect(village!.buildings.some((building) => building.kind === "tower")).toBe(true);
    const nearestBuilding = Math.min(
      ...village!.buildings.map((building) => Math.hypot(building.x, building.z)),
    );
    expect(nearestBuilding).toBeGreaterThan(1700);
    expect(insideTown(village!.x, village!.z)).toBe(true);

    const building = village!.buildings[0];
    expect(buildingHeightAt(building.x, building.z)).toBeCloseTo(
      building.ground + building.wallHeight + building.roofHeight,
      5,
    );
  });

  it("keeps buildings on dry, workable ground inside the town", () => {
    const towns = collect(-40_000, -30_000, 40_000, 30_000);
    expect(towns.length).toBeGreaterThan(0);

    for (const town of towns) {
      expect(town.buildings.length).toBeGreaterThan(0);
      expect(town.buildings.length).toBeLessThanOrEqual(TOWNS.maxBuildings);
      expect(town.streetLength).toBeGreaterThan(0);

      for (const building of town.buildings) {
        expect(Math.hypot(building.x - town.x, building.z - town.z)).toBeLessThanOrEqual(town.radius + 1);
        expect(building.wallHeight).toBeGreaterThan(0);
        expect(building.roofHeight).toBeGreaterThan(0);
        expect(building.width).toBeGreaterThan(building.depth * 0.5);

        // Never in the shallows: the water plane must sit below the footing.
        const water = waterLevelAt(building.x, building.z);
        expect(water === null || water < building.ground - 0.3).toBe(true);
      }
    }
  });

  it("adds taller tenements to the larger towns", () => {
    const towns = collect(-40_000, -30_000, 40_000, 30_000);
    const buildings = towns.flatMap((town) => town.buildings);
    const tenements = buildings.filter((building) => building.kind === "tenement");
    const cottages = buildings.filter((building) => building.kind === "cottage");

    expect(tenements.length).toBeGreaterThan(10);
    expect(tenements.every((building) => building.wallHeight > 10)).toBe(true);
    expect(Math.max(...tenements.map((building) => building.wallHeight))).toBeGreaterThan(
      Math.max(...cottages.map((building) => building.wallHeight)),
    );
  });

  it("reports a solid roof only where a building stands", () => {
    const towns = collect(-40_000, -30_000, 40_000, 30_000);
    let checked = 0;

    for (const town of towns) {
      for (const building of town.buildings) {
        const roof = buildingHeightAt(building.x, building.z);
        expect(roof).not.toBeNull();
        expect(roof as number).toBeCloseTo(building.ground + building.wallHeight + building.roofHeight, 5);
        checked++;
      }
    }

    expect(checked).toBeGreaterThan(20);
    // Open farmland 40 km out is not a roof.
    expect(buildingHeightAt(40_000, 40_000)).toBeNull();
  });

  it("leaves a believable and varied number of towns in a flight area", () => {
    const towns = collect(-20_000, -30_000, 20_000, 30_000);
    expect(towns.length).toBeGreaterThan(3);
    expect(towns.length).toBeLessThan(120);

    const counts = towns.map((town) => town.buildings.length);
    const averageBuildings = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    expect(averageBuildings).toBeGreaterThan(80);
    expect(averageBuildings).toBeLessThan(260);
    expect(Math.max(...counts) - Math.min(...counts)).toBeGreaterThan(40);
    expect(new Set(towns.map((town) => town.streets.length)).size).toBeGreaterThan(1);
  });

  it("ends the flight when the glider hits a roof", () => {
    const towns = collect(-40_000, -30_000, 40_000, 30_000);
    const building = towns.flatMap((town) => town.buildings)[12];
    expect(building).toBeDefined();

    const roof = building.ground + building.wallHeight + building.roofHeight;
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "air");
    sim.position.set(building.x, roof + 1.2, building.z);
    sim.velocity.set(0, -6, 0);

    for (let i = 0; i < 240; i++) sim.step(1 / 240);

    expect(sim.mode).toBe("crashed");
    expect(sim.getSummary().mode).toBe("crashed");
  });
});
