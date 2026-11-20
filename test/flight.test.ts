import { beforeAll, describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { DEFAULT_WEATHER, type WeatherSettings } from "../src/config";
import { Atmosphere } from "../src/sim/atmosphere";
import { LiftField } from "../src/sim/lift";
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

describe("headless flight", () => {
  it("trims to a plausible glide in still air", () => {
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "air");
    run(sim, 30);

    const startAlt = sim.msl;
    const startX = sim.position.x;
    const startZ = sim.position.z;
    run(sim, 30);
    const lost = startAlt - sim.msl;
    const distance = Math.hypot(sim.position.x - startX, sim.position.z - startZ);
    const ratio = distance / lost;

    console.log("glide", {
      iasKmh: sim.ias * 3.6,
      tas: sim.tas,
      vario: sim.vario,
      ratio,
      alphaDeg: (sim.alpha * 180) / Math.PI,
      cl: sim.cl,
      cd: sim.cd,
      pitchDeg: (sim.pitch * 180) / Math.PI,
      mode: sim.mode,
      agl: sim.agl,
    });

    expect(sim.mode).toBe("free");
    expect(sim.ias * 3.6).toBeGreaterThan(80);
    expect(sim.ias * 3.6).toBeLessThan(130);
    expect(ratio).toBeGreaterThan(30);
    expect(ratio).toBeLessThan(48);
  });

  it("rolls at a believable rate with full aileron", () => {
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "air");
    run(sim, 15);
    sim.input.roll = 1;
    run(sim, 2);
    console.log("roll", {
      rateDeg: (sim.angular.p * 180) / Math.PI,
      rollDeg: (sim.roll * 180) / Math.PI,
    });
    expect(Math.abs((sim.angular.p * 180) / Math.PI)).toBeGreaterThan(25);
    expect(Math.abs((sim.angular.p * 180) / Math.PI)).toBeLessThan(120);
  });

  it("stalls when the nose is held up, then recovers", () => {
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "air");
    run(sim, 10);
    sim.input.pitch = 1;
    run(sim, 6);
    const stalled = sim.stall;
    const lowSpeed = sim.ias * 3.6;
    sim.input.pitch = 0;
    run(sim, 6);
    console.log("stall", { stalled, lowSpeed, recovered: sim.ias * 3.6, mode: sim.mode });
    expect(stalled).toBeGreaterThan(0.3);
    expect(lowSpeed).toBeLessThan(95);
  });

  it("climbs away from a winch launch and releases at height", () => {
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "winch");

    let releaseTime = -1;
    let peakClimb = 0;
    let minSpeed = Infinity;
    let maxSpeed = 0;
    let stallSeen = 0;

    const dt = 1 / 240;
    for (let i = 0; i < 240 * 90; i++) {
      sim.step(dt);
      stallSeen = Math.max(stallSeen, sim.stall);
      if (sim.cableAttached) {
        // Ignore the initial ground run, which starts from a standstill.
        if (i * dt > 3) {
          minSpeed = Math.min(minSpeed, sim.ias * 3.6);
          maxSpeed = Math.max(maxSpeed, sim.ias * 3.6);
          peakClimb = Math.max(peakClimb, sim.vario);
        }
      } else if (releaseTime < 0) {
        releaseTime = i * dt;
      }
      if (sim.mode === "crashed") break;
    }

    console.log("winch", {
      releaseTime: releaseTime.toFixed(1),
      agl: sim.agl.toFixed(0),
      peakClimb: peakClimb.toFixed(1),
      minSpeed: minSpeed.toFixed(0),
      maxSpeed: maxSpeed.toFixed(0),
      stallSeen: stallSeen.toFixed(2),
    });

    expect(releaseTime).toBeGreaterThan(20);
    expect(releaseTime).toBeLessThan(60);
    expect(peakClimb).toBeGreaterThan(7);
    expect(peakClimb).toBeLessThan(25);
    expect(minSpeed).toBeGreaterThan(70);
    expect(maxSpeed).toBeLessThan(190);
    expect(sim.mode).not.toBe("crashed");
  });
});

describe("lift field", () => {
  const weather: WeatherSettings = {
    ...DEFAULT_WEATHER,
    windSpeed: 25,
    windFrom: 180,
    thermalStrength: 3,
    turbulence: 0,
    cloudBase: 2000,
  };

  it("has a strong thermal core and nothing above cloudbase", () => {
    const atmosphere = new Atmosphere(weather, terrain, 7);
    const field = new LiftField(terrain, atmosphere, weather, 7);
    const home = field.thermals.find((t) => Math.hypot(t.x - 620, t.z + 720) < 20);
    expect(home).toBeTruthy();
    if (!home) return;
    const mid = (home.base + home.top) / 2;
    const core = field.sample(new Vector3(620, mid, -720), 0);
    expect(core.thermal).toBeGreaterThan(1);

    const above = field.sample(new Vector3(620, home.top + 80, -720), 0);
    expect(Math.abs(above.thermal)).toBeLessThan(0.01);
  });

  it("produces ridge lift on the windward slope", () => {
    const atmosphere = new Atmosphere(weather, terrain, 7);
    const field = new LiftField(terrain, atmosphere, weather, 7);
    let best = 0;
    for (let z = -1400; z >= -2600; z -= 50) {
      const ground = terrain.heightAt(0, z);
      const result = field.sample(new Vector3(0, ground + 120, z), 0);
      if (result.ridge > best) best = result.ridge;
    }
    console.log("ridge best", best);
    expect(best).toBeGreaterThan(0.8);
    expect(best).toBeLessThan(7);
  });
});
