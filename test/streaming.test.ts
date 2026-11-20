import { beforeAll, describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { DEFAULT_WEATHER, STREAMING, WORLD, type WeatherSettings } from "../src/config";
import { lerp } from "../src/core/math";
import { Atmosphere } from "../src/sim/atmosphere";
import { LiftField, type Thermal } from "../src/sim/lift";
import { Terrain, terrainHeightAt } from "../src/sim/terrain";

const thermalWeather: WeatherSettings = {
  ...DEFAULT_WEATHER,
  windSpeed: 12,
  windFrom: 200,
  thermalStrength: 2.6,
  turbulence: 0,
  cloudBase: 2000,
};

let terrain: Terrain;

beforeAll(() => {
  terrain = new Terrain();
});

function thermalKey(thermal: Thermal): string {
  return `${thermal.x.toFixed(4)}:${thermal.z.toFixed(4)}`;
}

function sortedKeys(thermals: Thermal[]): string[] {
  return thermals.map(thermalKey).sort();
}

function collectBounds(field: LiftField, minX: number, minZ: number, maxX: number, maxZ: number): string[] {
  const found: string[] = [];
  field.forEachThermalInBounds(minX, minZ, maxX, maxZ, (thermal) => found.push(thermalKey(thermal)));
  return found.sort();
}

describe("streamed terrain", () => {
  it("samples the analytic surface exactly on grid nodes far from the field", () => {
    for (const x of [12_350, 250_000, -1_000_000]) {
      for (const z of [-98_750, 640_000, 1_750_500]) {
        expect(terrain.heightAt(x, z)).toBeCloseTo(terrainHeightAt(x, z, WORLD), 6);
      }
    }
  });

  it("bilinearly matches the four surrounding global grid nodes", () => {
    const spacing = terrain.gridSpacing;
    const x = 187_345.6;
    const z = -432_987.4;
    const i = Math.floor(x / spacing);
    const j = Math.floor(z / spacing);
    const tx = x / spacing - i;
    const tz = z / spacing - j;

    const h00 = terrainHeightAt(i * spacing, j * spacing, WORLD);
    const h10 = terrainHeightAt((i + 1) * spacing, j * spacing, WORLD);
    const h01 = terrainHeightAt(i * spacing, (j + 1) * spacing, WORLD);
    const h11 = terrainHeightAt((i + 1) * spacing, (j + 1) * spacing, WORLD);
    const expected = lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);

    expect(terrain.heightAt(x, z)).toBeCloseTo(expected, 6);
  });

  it("keeps producing plausible, finite ground far outside the old world", () => {
    const samples: number[] = [];
    for (let n = 1; n <= 40; n++) {
      const angle = n * 2.399963;
      const distance = n * 12_500;
      samples.push(terrain.heightAt(Math.cos(angle) * distance, Math.sin(angle) * distance));
    }
    expect(samples.every((height) => Number.isFinite(height))).toBe(true);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(240);
    expect(Math.max(...samples)).toBeLessThan(4000);
    // The ground should not collapse to one flat value once past the field.
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(50);
  });

  it("is stateless, so the same point always returns the same height", () => {
    const point = { x: 733_777.7, z: -48_121.2 };
    const first = terrain.heightAt(point.x, point.z);
    // Touch a different part of the world; a baked heightfield would have no
    // reason to change, but a stateful sampler could.
    terrain.heightAt(-2_000_000, 1_500_000);
    expect(terrain.heightAt(point.x, point.z)).toBe(first);
  });
});

describe("streamed thermals", () => {
  function makeField(seed = 17): LiftField {
    const atmosphere = new Atmosphere(thermalWeather, terrain, seed);
    return new LiftField(terrain, atmosphere, thermalWeather, seed);
  }

  it("generates the same thermals from the same seed and window order", () => {
    const a = makeField();
    const b = makeField();
    a.ensureAround(84_000, -51_000);
    b.ensureAround(84_000, -51_000);
    expect(sortedKeys(a.thermals)).toEqual(sortedKeys(b.thermals));
    expect(a.thermals.length).toBeGreaterThan(10);
  });

  it("keeps each thermal fixed to its world cell as the active window moves", () => {
    const field = makeField();
    field.ensureAround(30_000, 20_000);
    const first = new Map(field.thermals.map((thermal) => [thermalKey(thermal), thermal]));
    // Move far enough for several rebuilds, then return to the same window.
    field.ensureAround(260_000, 180_000);
    field.ensureAround(30_000, 20_000);

    for (const thermal of field.thermals) {
      const original = first.get(thermalKey(thermal));
      if (!original) continue;
      expect(thermal.strength).toBeCloseTo(original.strength, 6);
      expect(thermal.base).toBeCloseTo(original.base, 6);
    }
    expect(field.thermals.length).toBeGreaterThan(10);
  });

  it("increments its version on every rebuild", () => {
    const field = makeField();
    const before = field.version;
    field.ensureAround(100_000, 0);
    expect(field.version).toBeGreaterThan(before);
  });

  it("retains the dependable home thermal when near the field", () => {
    const field = makeField();
    field.ensureAround(620, -720);
    const home = field.thermals.find((thermal) => Math.hypot(thermal.x - 620, thermal.z + 720) < 20);
    expect(home).toBeTruthy();

    field.ensureAround(400_000, 400_000);
    expect(field.thermals.some((thermal) => Math.hypot(thermal.x - 620, thermal.z + 720) < 20)).toBe(false);

    field.ensureAround(0, 0);
    const again = field.thermals.find((thermal) => Math.hypot(thermal.x - 620, thermal.z + 720) < 20);
    expect(again).toBeTruthy();
  });

  it("reports the same thermals through the tile query as the active window", () => {
    const field = makeField();
    field.ensureAround(0, 0);
    const cell = STREAMING.thermalCellSize;
    const minX = -cell * 2;
    const maxX = cell * 2;
    const minZ = -cell * 2;
    const maxZ = cell * 2;

    const fromBounds = collectBounds(field, minX, minZ, maxX, maxZ);
    const fromWindow = sortedKeys(
      field.thermals.filter(
        (thermal) =>
          thermal.x >= minX && thermal.x <= maxX && thermal.z >= minZ && thermal.z <= maxZ,
      ),
    );
    expect(fromBounds).toEqual(fromWindow);
    expect(fromBounds.length).toBeGreaterThan(0);
  });

  it("still produces lift after flying far from the field", () => {
    const field = makeField();
    field.ensureAround(320_000, -280_000);
    const thermal = field.thermals[0];
    expect(thermal).toBeTruthy();
    if (!thermal) return;
    const sample = field.sample(
      new Vector3(thermal.x, (thermal.base + thermal.top) / 2, thermal.z),
      0,
    );
    expect(sample.thermal).toBeGreaterThan(0.4);
  });
});
