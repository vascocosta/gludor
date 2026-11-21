import { describe, expect, it } from "vitest";
import { MOUNTAINS, WORLD } from "../src/config";
import { Terrain, mountainHeightAt, terrainHeightAt } from "../src/sim/terrain";

const HALF = 30_000;
const STEP = 250;

/** Walk a 60 km square, returning ground and mountain-only heights. */
function scan(): {
  ground: number[];
  mountain: number[];
} {
  const ground: number[] = [];
  const mountain: number[] = [];
  for (let z = -HALF; z <= HALF; z += STEP) {
    for (let x = -HALF; x <= HALF; x += STEP) {
      ground.push(terrainHeightAt(x, z, WORLD));
      mountain.push(mountainHeightAt(x, z, WORLD));
    }
  }
  return { ground, mountain };
}

describe("mountains", () => {
  it("is deterministic and driven by the world seed", () => {
    const points: [number, number][] = [
      [-11_000, 5750],
      [8500, -14_000],
      [24_000, 16_000],
      [-27_000, -22_000],
    ];
    const first = points.map(([x, z]) => terrainHeightAt(x, z, WORLD));

    // Querying elsewhere must not disturb the cached mountain grid.
    terrainHeightAt(500_000, -400_000, WORLD);
    expect(points.map(([x, z]) => terrainHeightAt(x, z, WORLD))).toEqual(first);

    const reseeded = { ...WORLD, seed: WORLD.seed + 1 };
    expect(
      points.some(([x, z]) => terrainHeightAt(x, z, reseeded) !== terrainHeightAt(x, z, WORLD)),
    ).toBe(true);
  });

  it("keeps random massifs out of the airfield bowl", () => {
    for (let radius = 0; radius <= 5900; radius += 100) {
      for (let k = 0; k < 48; k++) {
        const angle = (k / 48) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        expect(mountainHeightAt(x, z, WORLD)).toBe(0);
      }
    }

    let lowest = Infinity;
    let highest = -Infinity;
    for (let z = -1600; z <= 1600; z += 100) {
      for (let x = -1600; x <= 1600; x += 100) {
        if (Math.hypot(x, z) > 1600) continue;
        const height = terrainHeightAt(x, z, WORLD);
        lowest = Math.min(lowest, height);
        highest = Math.max(highest, height);
      }
    }
    expect(lowest).toBeGreaterThan(300);
    expect(highest).toBeLessThan(520);
  });

  it("grows new ranges beyond the six kilometre keep-out", () => {
    const { mountain } = scan();
    expect(mountain.filter((height) => height > 50).length).toBeGreaterThan(1000);
    expect(mountain.filter((height) => height > 700).length).toBeGreaterThan(100);
  });

  it("builds sharp alpine peaks as well as ordinary foothills", () => {
    const { ground, mountain } = scan();

    const alpine = mountain.filter((height) => height > 1000).length;
    const foothills = mountain.filter((height) => height > 100 && height < 500).length;
    expect(alpine).toBeGreaterThan(20);
    expect(foothills).toBeGreaterThan(1000);

    // Peaks reach the snow line and stay below the cap.
    expect(ground.filter((height) => height > 1400).length).toBeGreaterThan(10);
    expect(Math.max(...ground)).toBeGreaterThan(1600);
    expect(Math.max(...ground)).toBeLessThan(2200);
    expect(Math.min(...ground)).toBeGreaterThanOrEqual(240);
    expect(Math.max(...mountain)).toBeLessThanOrEqual(MOUNTAINS.maxHeight);
  });

  it("keeps the home ridges finite", () => {
    // The central training bank still stands north of the field.
    let crestLow = Infinity;
    for (let x = -2400; x <= 2400; x += 300) {
      crestLow = Math.min(crestLow, terrainHeightAt(x, -2950, WORLD));
    }
    expect(crestLow).toBeGreaterThan(650);

    // Real cols separate the banks, so the chain is not one unbroken wall.
    const crest = terrainHeightAt(0, -2950, WORLD);
    expect(terrainHeightAt(-3950, -2750, WORLD)).toBeLessThan(crest - 250);

    // Past the outer banks, only ordinary ground remains once the random
    // mountains are subtracted.
    let farHigh = -Infinity;
    for (let x = -30_000; x <= 30_000; x += 500) {
      if (Math.abs(x) < 11_000) continue;
      const ridge = terrainHeightAt(x, -2850, WORLD) - mountainHeightAt(x, -2850, WORLD);
      farHigh = Math.max(farHigh, ridge);
    }
    expect(farHigh).toBeLessThan(620);
  });

  it("streams the same mountains through the sampled terrain", () => {
    const terrain = new Terrain();
    for (const [x, z] of [
      [-11_000, 5750],
      [18_000, -9000],
      [-24_000, 20_000],
    ] as const) {
      expect(terrain.heightAt(x, z)).toBeCloseTo(terrainHeightAt(x, z, WORLD), 6);
    }
  });
});
