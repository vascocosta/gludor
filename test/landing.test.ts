import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WEATHER, type WeatherSettings } from "../src/config";
import { quatFromHeadingPitchRoll } from "../src/core/math";
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

const dt = 1 / 240;

let terrain: Terrain;

beforeAll(() => {
  terrain = new Terrain();
});

/** Put a free-flying glider on a shallow final approach over the flat field. */
function startRollout(weather: WeatherSettings = stillAir, heading = 0): Simulation {
  const sim = new Simulation(terrain, weather);
  sim.startFlight(weather, "air");
  const ground = terrain.heightAt(0, 0);
  const radians = (heading * Math.PI) / 180;
  sim.position.set(0, ground + 1.2, 0);
  sim.orientation.copy(quatFromHeadingPitchRoll(heading, 0.08, 0));
  sim.velocity.set(
    Math.sin(radians) * 22,
    -1.5,
    -Math.cos(radians) * 22,
  );
  return sim;
}

/** Step until the predicate holds, returning the elapsed simulated seconds. */
function stepUntil(
  sim: Simulation,
  predicate: (sim: Simulation) => boolean,
  maxSeconds = 60,
): number {
  const steps = Math.round(maxSeconds / dt);
  for (let i = 0; i < steps; i++) {
    sim.step(dt);
    if (predicate(sim)) return (i + 1) * dt;
  }
  return Number.NaN;
}

function flyIntoRollout(): Simulation {
  const sim = startRollout();
  const touchdown = stepUntil(sim, (s) => s.mode === "rollout", 5);
  expect(Number.isFinite(touchdown)).toBe(true);
  return sim;
}

describe("landing rollout", () => {
  it("keeps rolling after touchdown instead of ending the flight", () => {
    const sim = flyIntoRollout();

    expect(sim.mode).toBe("rollout");
    expect(sim.onGround).toBe(true);
    expect(Math.hypot(sim.velocity.x, sim.velocity.z)).toBeGreaterThan(5);
  });

  it("freezes air time at touchdown while the rollout continues", () => {
    const sim = flyIntoRollout();
    const airTime = sim.stats.airTime;
    const flightTime = sim.flightTime;

    for (let i = 0; i < 240; i++) sim.step(dt);

    expect(sim.mode).toBe("rollout");
    expect(sim.stats.airTime).toBeCloseTo(airTime, 5);
    expect(sim.flightTime).toBeGreaterThan(flightTime + 0.5);
  });

  it("comes to rest and enters the landed state", () => {
    const sim = flyIntoRollout();
    const elapsed = stepUntil(sim, (s) => s.mode === "landed", 60);

    expect(Number.isFinite(elapsed)).toBe(true);
    expect(sim.velocity.length()).toBe(0);
    expect(sim.getSummary().mode).toBe("landed");
  });

  it("stops even when a tailwind runs backwards over the wing", () => {
    // A strong tailwind makes the relative airflow reverse as the glider
    // slows. The ground loop must not let the aero model keep it creeping.
    const windy: WeatherSettings = {
      ...stillAir,
      windSpeed: 35,
      windFrom: 270,
      turbulence: 0,
    };
    const sim = startRollout(windy, 90);
    const elapsed = stepUntil(sim, (s) => s.mode === "landed", 60);

    expect(Number.isFinite(elapsed)).toBe(true);
    expect(sim.velocity.length()).toBe(0);
    expect(sim.ias).toBeLessThan(20);
  });

  it("never accelerates from sideways drift during rollout", () => {
    const sim = new Simulation(terrain, stillAir);
    sim.startFlight(stillAir, "air");
    const ground = terrain.heightAt(0, 0);
    sim.position.set(0, ground + 1.2, 0);
    sim.orientation.copy(quatFromHeadingPitchRoll(0, 0.08, 0));
    // 20 m/s down the runway with 10 m/s of crab.
    sim.velocity.set(10, -1.5, -20);

    const touchdown = stepUntil(sim, (s) => s.mode === "rollout", 5);
    expect(Number.isFinite(touchdown)).toBe(true);
    const initialSpeed = Math.hypot(sim.velocity.x, sim.velocity.z);
    expect(initialSpeed).toBeGreaterThan(20);

    sim.input.brake = 1;
    let maxSpeed = initialSpeed;
    for (let i = 0; i < 240 * 30; i++) {
      sim.step(dt);
      maxSpeed = Math.max(maxSpeed, Math.hypot(sim.velocity.x, sim.velocity.z));
      if (sim.mode === "landed") break;
    }

    // Feeding the total speed back in as the forward component used to let a
    // crabbed touchdown run away to hundreds of metres per second.
    expect(maxSpeed).toBeLessThan(initialSpeed + 1e-6);
    expect(sim.mode).toBe("landed");
    expect(sim.velocity.length()).toBe(0);
  });

  it("uses the wheel brake to shorten the rollout", () => {
    const measure = (brake: number): number => {
      const sim = flyIntoRollout();
      let distance = 0;
      let rolling = false;
      for (let i = 0; i < 240 * 60; i++) {
        sim.input.brake = brake;
        const x = sim.position.x;
        const z = sim.position.z;
        sim.step(dt);
        if (sim.mode === "rollout") rolling = true;
        if (rolling) distance += Math.hypot(sim.position.x - x, sim.position.z - z);
        if (sim.mode === "landed") return distance;
      }
      return Number.NaN;
    };

    const free = measure(0);
    const braked = measure(1);

    expect(Number.isFinite(free)).toBe(true);
    expect(Number.isFinite(braked)).toBe(true);
    expect(free).toBeGreaterThan(100);
    expect(braked).toBeLessThan(free * 0.75);
  });

  it("steers with the rudder while rolling", () => {
    const sim = flyIntoRollout();
    const heading = sim.heading;

    sim.input.rudder = 1;
    for (let i = 0; i < 480; i++) sim.step(dt);

    expect(sim.heading).toBeGreaterThan(heading + 5);
    expect(sim.mode).toBe("rollout");
  });

  it("cannot bounce back into the air during the rollout", () => {
    const sim = flyIntoRollout();
    sim.velocity.y = 6;

    for (let i = 0; i < 240; i++) sim.step(dt);

    const ground = terrain.heightAt(sim.position.x, sim.position.z);
    expect(sim.onGround).toBe(true);
    expect(sim.position.y - ground).toBeLessThan(1);
    expect(sim.mode === "rollout" || sim.mode === "landed").toBe(true);
  });
});
