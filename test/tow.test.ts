import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WEATHER, TOW, type WeatherSettings } from "../src/config";
import { Simulation } from "../src/sim/simulation";
import { Terrain } from "../src/sim/terrain";

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

function run(sim: Simulation, seconds: number): void {
  const dt = 1 / 240;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) sim.step(dt);
}

function towToRelease(sim: Simulation, maxSeconds = 400): {
  seconds: number;
  maxRope: number;
  maxRoll: number;
  maxPitch: number;
  maxTas: number;
} {
  const dt = 1 / 240;
  let seconds = 0;
  let maxRope = 0;
  let maxRoll = 0;
  let maxPitch = 0;
  let maxTas = 0;

  for (let i = 0; i < maxSeconds / dt; i++) {
    sim.step(dt);
    // Ignore the first second while the initial slack is taken up.
    if (i > 240) maxRope = Math.max(maxRope, sim.position.distanceTo(sim.towPlane.hook));
    maxRoll = Math.max(maxRoll, Math.abs(sim.roll));
    maxPitch = Math.max(maxPitch, Math.abs(sim.pitch));
    maxTas = Math.max(maxTas, sim.tas);
    if (sim.mode !== "tow") {
      seconds = i * dt;
      break;
    }
  }

  return { seconds, maxRope, maxRoll, maxPitch, maxTas };
}

describe("aerotow", () => {
  it("puts a visible tug on the runway with a workable rope", () => {
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "tow");

    expect(sim.mode).toBe("tow");
    expect(sim.launch).toBe("tow");
    expect(sim.cableAttached).toBe(true);
    expect(sim.towPlane.visible).toBe(true);
    expect(sim.towPlane.phase).toBe("roll");

    const distance = sim.position.distanceTo(sim.towPlane.hook);
    expect(distance).toBeGreaterThan(TOW.ropeLength * 0.7);
    expect(distance).toBeLessThan(TOW.ropeLength);
  });

  it("climbs hands-off to 1,200 m and releases in a controlled turn", () => {
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "tow");
    const result = towToRelease(sim);

    expect(sim.mode).toBe("free");
    expect(sim.cableAttached).toBe(false);
    expect(sim.towPlane.phase).toBe("depart");
    expect(sim.agl).toBeGreaterThanOrEqual(TOW.targetAgl - 5);
    expect(sim.agl).toBeGreaterThan(1000);

    // A scenic tow, not an instant elevator ride or an endless climb.
    expect(result.seconds).toBeGreaterThan(180);
    expect(result.seconds).toBeLessThan(320);

    // The assist keeps the glider in the tug's wake all the way up.
    expect(result.maxRope).toBeLessThan(TOW.ropeLength + TOW.maxStretch + 0.2);
    expect(result.maxRoll).toBeLessThan((20 * Math.PI) / 180);
    expect(result.maxPitch).toBeLessThan((30 * Math.PI) / 180);
    expect(result.maxTas).toBeLessThan(45);
  });

  it("stays controllable in the standard breeze", () => {
    const sim = new Simulation(terrain, DEFAULT_WEATHER);
    sim.startFlight(DEFAULT_WEATHER, "tow");
    const result = towToRelease(sim);

    expect(sim.mode).toBe("free");
    expect(sim.agl).toBeGreaterThanOrEqual(TOW.targetAgl - 5);
    expect(result.maxRope).toBeLessThan(TOW.ropeLength + TOW.maxStretch + 0.2);
    expect(result.maxRoll).toBeLessThan((30 * Math.PI) / 180);
    expect(result.maxPitch).toBeLessThan((30 * Math.PI) / 180);
    expect(result.maxTas).toBeLessThan(45);
  });

  it("releases on demand and lets the tug leave the scene", () => {
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "tow");
    run(sim, 60);

    expect(sim.mode).toBe("tow");
    expect(sim.agl).toBeGreaterThan(100);
    expect(sim.cableAttached).toBe(true);

    sim.releaseCable();
    expect(sim.mode).toBe("free");
    expect(sim.cableAttached).toBe(false);
    expect(sim.towPlane.phase).toBe("depart");

    run(sim, TOW.departTime + 2);
    expect(sim.towPlane.phase).toBe("gone");
    expect(sim.towPlane.visible).toBe(false);
    expect(sim.mode).toBe("free");
  });

  it("is deterministic for the same weather and seed", () => {
    const first = new Simulation(terrain, stillAir);
    const second = new Simulation(terrain, stillAir);
    first.startFlight(stillAir, "tow");
    second.startFlight(stillAir, "tow");
    run(first, 90);
    run(second, 90);

    expect(first.position.toArray()).toEqual(second.position.toArray());
    expect(first.orientation.toArray()).toEqual(second.orientation.toArray());
    expect(first.towPlane.position.toArray()).toEqual(second.towPlane.position.toArray());
    expect(first.towPlane.orientation.toArray()).toEqual(second.towPlane.orientation.toArray());
    expect(first.mode).toBe("tow");
    expect(second.mode).toBe("tow");
  });
});
