import { describe, expect, it } from "vitest";
import { DEFAULT_WEATHER, WORLD } from "../src/config";
import { wrapDegrees } from "../src/core/math";
import {
  AIRFIELD,
  HOME_AIRFIELD,
  airfieldHeightAt,
  airfieldLabel,
  forEachAirfieldInBounds,
  insideAirfield,
  nearestAirfields,
  runwayNumbers,
  takeoffHeading,
  type AirfieldSpec,
} from "../src/sim/airfields";
import { Simulation } from "../src/sim/simulation";
import { Terrain, rawTerrainHeightAt, terrainHeightAt } from "../src/sim/terrain";
import { insideTownFootprint } from "../src/sim/towns";
import { buildAirfieldHoleMask } from "../src/render/terrainMesh";

const terrain = new Terrain();

function collect(min: number, max: number): AirfieldSpec[] {
  const fields: AirfieldSpec[] = [];
  forEachAirfieldInBounds(min, min, max, max, (field) => fields.push(field));
  return fields;
}

const nearby = collect(-30_000, 30_000);
const stillAir = { ...DEFAULT_WEATHER, windSpeed: 0, turbulence: 0 };

describe("town airfields", () => {
  it("are deterministic and independent of the query window", () => {
    const again = collect(-30_000, 30_000);
    expect(again.map((f) => f.id)).toEqual(nearby.map((f) => f.id));
    expect(again.map((f) => [f.x, f.z, f.heading, f.length])).toEqual(
      nearby.map((f) => [f.x, f.z, f.heading, f.length]),
    );

    const shifted = collect(0, 60_000);
    let overlaps = 0;
    for (const field of shifted) {
      const match = nearby.find((other) => other.id === field.id);
      if (!match) continue;
      overlaps++;
      expect(field).toEqual(match);
    }
    expect(overlaps).toBeGreaterThan(0);
  });

  it("offers a workable number of strips near the home field", () => {
    const distances = nearby.map((f) => Math.hypot(f.x, f.z));
    expect(distances.filter((d) => d <= 20_000).length).toBeGreaterThanOrEqual(4);
    expect(distances.filter((d) => d <= 30_000).length).toBeGreaterThanOrEqual(8);
    for (const field of nearby) {
      expect(field.length).toBeGreaterThanOrEqual(500);
      expect(field.length).toBeLessThanOrEqual(1_100);
      expect(field.width).toBeGreaterThan(20);
      expect(field.width).toBeLessThan(AIRFIELD.padWidth);
      expect(field.surface).toBe("grass");
      expect(field.tow).toBe(false);
    }
  });

  it("keeps the runway dry, off the town, and gentle enough to grade", () => {
    for (const field of nearby) {
      expect(insideTownFootprint(field.x, field.z, 0)).toBe(false);

      const h = (field.heading * Math.PI) / 180;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const rx = Math.cos(h);
      const rz = Math.sin(h);
      const start = -field.length / 2 - AIRFIELD.padExtension;
      const end = field.length / 2 + AIRFIELD.padExtension;

      for (let s = start; s <= end; s += 20) {
        const plane = airfieldHeightAt(field, s);
        for (const across of [-AIRFIELD.padWidth / 2, 0, AIRFIELD.padWidth / 2]) {
          const x = field.x + fx * s + rx * across;
          const z = field.z + fz * s + rz * across;
          const ground = rawTerrainHeightAt(x, z, WORLD);
          expect(Math.abs(ground - plane)).toBeLessThan(3.4);
        }
      }

      // The long grade may follow the hill, but the pad is level across.
      const grade = Math.abs(
        (airfieldHeightAt(field, field.length / 2) -
          airfieldHeightAt(field, -field.length / 2)) /
          field.length,
      );
      expect(grade).toBeLessThan(0.07);
    }
  });

  it("grades the surface the collision mesh and renderer both sample", () => {
    for (const field of nearby) {
      const h = (field.heading * Math.PI) / 180;
      for (let s = -field.length / 2; s <= field.length / 2; s += 25) {
        const x = field.x + Math.sin(h) * s;
        const z = field.z - Math.cos(h) * s;
        expect(terrainHeightAt(x, z, WORLD)).toBeCloseTo(
          airfieldHeightAt(field, s),
          6,
        );
      }
    }
  });

  it("lists home and the closest strips in order", () => {
    const list = nearestAirfields(0, 0, 8, 30_000);
    expect(list[0]).toEqual(HOME_AIRFIELD);
    expect(list.length).toBe(8);
    const distances = list.map((f) => Math.hypot(f.x, f.z));
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
    }
    expect(new Set(list.map((f) => f.id)).size).toBe(list.length);
  });

  it("points at the nearest field from the air", () => {
    const field = nearestAirfields(0, 0, 4, 30_000)[1];
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "air", field);

    // Overfly a point one kilometre east of the strip; it is due west.
    sim.position.set(field.x + 1_000, field.elevation + 500, field.z);
    sim.time = 2;
    const infos = sim.getNearestAirfieldInfos();
    expect(infos.length).toBe(2);
    expect(infos[0].field.id).toBe(field.id);
    expect(infos[0].distance).toBeCloseTo(1_000, 6);
    expect(wrapDegrees(infos[0].bearing)).toBeCloseTo(270, 6);
    expect(infos[1].distance).toBeGreaterThanOrEqual(infos[0].distance);
  });

  it("recognises the graded footprint and nothing beside it", () => {
    const field = nearby[0];
    expect(insideAirfield(field.x, field.z)).toBe(true);
    expect(insideAirfield(0, 0)).toBe(true);

    const h = (field.heading * Math.PI) / 180;
    const across = AIRFIELD.padWidth / 2 + AIRFIELD.skirt + 60;
    expect(
      insideAirfield(
        field.x + Math.cos(h) * across,
        field.z + Math.sin(h) * across,
      ),
    ).toBe(false);
  });

  it("cuts every near-terrain quad that crosses a strip", () => {
    const spacing = 50;
    const cells = 80;
    const row = cells + 1;

    // The finest terrain tier must have no triangle left under any runway.
    for (const field of nearby.slice(0, 8)) {
      const x0 = field.x - 2_000;
      const z0 = field.z - 2_000;
      const mask = buildAirfieldHoleMask(x0, z0, cells, spacing);
      expect(mask).not.toBeNull();

      const h = (field.heading * Math.PI) / 180;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const rx = Math.cos(h);
      const rz = Math.sin(h);

      for (let along = -field.length / 2; along <= field.length / 2; along += 11) {
        for (let across = -field.width / 2; across <= field.width / 2; across += 5) {
          const x = field.x + fx * along + rx * across;
          const z = field.z + fz * along + rz * across;
          const i = Math.floor((x - x0) / spacing);
          const j = Math.floor((z - z0) / spacing);
          const cut =
            mask![j * row + i] ||
            mask![j * row + i + 1] ||
            mask![(j + 1) * row + i] ||
            mask![(j + 1) * row + i + 1];
          expect(cut, `${field.id} at ${along}, ${across}`).toBe(1);
        }
      }
    }
  });

  it("picks the runway end into the wind and labels it", () => {
    const field: AirfieldSpec = { ...nearby[0], heading: 90 };
    expect(takeoffHeading(field, 80)).toBe(90);
    expect(takeoffHeading(field, 260)).toBe(270);
    expect(takeoffHeading(field, 350)).toBe(270);
    expect(runwayNumbers(field)).toBe("09/27");
    expect(airfieldLabel(field)).toContain("09/27");
    expect(airfieldLabel(HOME_AIRFIELD)).toBe("Home field");
  });

  it("launches a winch from a town strip into the wind", () => {
    const field = nearestAirfields(0, 0, 4, 30_000)[1];
    const weather = { ...stillAir, windFrom: 80 };
    const sim = new Simulation(terrain, weather);
    sim.startFlight(weather, "winch", field);

    const takeoff = takeoffHeading(field, weather.windFrom);
    expect(sim.mode).toBe("winch");
    expect(sim.field).toBe(field);
    expect(sim.cableAttached).toBe(true);
    expect(Math.hypot(sim.position.x - field.x, sim.position.z - field.z)).toBeLessThan(
      field.length,
    );
    expect(Math.hypot(sim.winchPosition.x - field.x, sim.winchPosition.z - field.z)).toBeGreaterThan(
      field.length / 2,
    );

    // The glider faces down the runway, and the winch lies ahead of it.
    const heading = (takeoff * Math.PI) / 180;
    const fx = Math.sin(heading);
    const fz = -Math.cos(heading);
    expect(sim.towPlane.visible).toBe(false);
    expect(
      (sim.winchPosition.x - sim.position.x) * fx + (sim.winchPosition.z - sim.position.z) * fz,
    ).toBeGreaterThan(0);

    // A short pull moves the glider down the strip and starts the climb.
    for (let i = 0; i < 240; i++) sim.step(1 / 120);
    expect(Math.hypot(sim.position.x - field.x, sim.position.z - field.z)).toBeGreaterThan(5);
    expect(sim.mode).toBe("winch");
  });

  it("reaches winch release height from the shortest strip", () => {
    const field = [...nearby].sort((a, b) => a.length - b.length)[0];
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "winch", field);

    for (let i = 0; i < 240 * 120 && sim.mode === "winch"; i++) sim.step(1 / 120);

    // A short strip still needs a full launch, not a low hop at the boundary.
    expect(sim.mode).toBe("free");
    expect(sim.agl).toBeGreaterThan(420);
    expect(sim.agl).toBeLessThan(480);
  });

  it("starts in the air above a town strip heading into the wind", () => {
    const field = nearestAirfields(0, 0, 4, 30_000)[2];
    const weather = { ...stillAir, windFrom: 170 };
    const sim = new Simulation(terrain, weather);
    sim.startFlight(weather, "air", field);

    expect(sim.mode).toBe("free");
    expect(sim.position.y).toBeGreaterThan(field.elevation + 500);
    expect(Math.hypot(sim.position.x - field.x, sim.position.z - field.z)).toBeLessThan(50);
    expect(Math.hypot(sim.velocity.x, sim.velocity.z)).toBeGreaterThan(20);
  });

  it("keeps aerotow at the home field", () => {
    const field = nearestAirfields(0, 0, 4, 30_000)[1];
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "tow", field);
    expect(sim.mode).toBe("winch");
    expect(sim.launch).toBe("winch");
  });

  it("guarantees a thermal within reach of every strip", () => {
    const field = nearestAirfields(0, 0, 4, 30_000)[1];
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "winch", field);
    sim.step(1 / 120);

    const near = sim.liftField.thermals.filter(
      (thermal) => Math.hypot(thermal.x - field.x, thermal.z - field.z) < 1_500,
    );
    expect(near.length).toBeGreaterThan(0);
    expect(near[0].strength).toBeGreaterThan(0);

    const tiles: Array<{ x: number; z: number }> = [];
    sim.liftField.forEachThermalInBounds(
      field.x - 2_000,
      field.z - 2_000,
      field.x + 2_000,
      field.z + 2_000,
      (thermal) => tiles.push({ x: thermal.x, z: thermal.z }),
    );
    expect(tiles).toContainEqual({ x: near[0].x, z: near[0].z });
  });
});
