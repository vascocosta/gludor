import { expect, it } from "vitest";
import { Vector3 } from "three";
import { DEFAULT_WEATHER, type WeatherSettings } from "../src/config";
import { Atmosphere } from "../src/sim/atmosphere";
import { LiftField } from "../src/sim/lift";
import { Simulation } from "../src/sim/simulation";
import { Terrain } from "../src/sim/terrain";

const stillAir: WeatherSettings = {
  ...DEFAULT_WEATHER,
  windSpeed: 0,
  turbulence: 0,
};

function dropInThermal(weather: WeatherSettings): { lost: number; thermal: number } {
  const terrain = new Terrain();
  const sim = new Simulation(terrain, weather);
  sim.startFlight(weather, "air");
  // The home thermal sits at (620, -720); both runs start from the same spot.
  sim.position.set(620, 1200, -720);
  sim.velocity.set(0, 0, -29);
  const start = sim.position.y;
  let peak = 0;
  for (let i = 0; i < 240 * 15; i++) {
    sim.step(1 / 240);
    peak = Math.max(peak, sim.lift.thermal);
  }
  return { lost: start - sim.msl, thermal: peak };
}

it("thermal lift shows up in the flight model", () => {
  const base = { ...DEFAULT_WEATHER, windSpeed: 0, turbulence: 0 };
  const withThermal = dropInThermal({ ...base, thermalStrength: 2.6 });
  const noThermal = dropInThermal({ ...base, thermalStrength: 0 });
  console.log("thermal", {
    withLost: withThermal.lost.toFixed(1),
    noLost: noThermal.lost.toFixed(1),
    gain: (noThermal.lost - withThermal.lost).toFixed(1),
  });
  // Crossing the core should cost clearly less height than still air, and the
  // sampled lift should match the field strength.
  expect(withThermal.thermal).toBeGreaterThan(1.5);
  expect(noThermal.lost).toBeGreaterThan(withThermal.lost + 8);
});

it("holds a broad core instead of a narrow Gaussian peak", () => {
  const terrain = new Terrain();
  const field = new LiftField(terrain, new Atmosphere(stillAir, terrain, 1), stillAir, 1);
  const home = field.thermals.find(
    (thermal) => Math.abs(thermal.x - 620) < 1e-6 && Math.abs(thermal.z + 720) < 1e-6,
  );
  expect(home).toBeDefined();

  const thermal = home!;
  const y = (thermal.base + thermal.top) / 2;
  const radius = thermal.radius * 1.2;
  const sample = field.sample(new Vector3(thermal.x + radius * 0.7, y, thermal.z), 0);

  // At 70% of the radius the flat-top profile still carries roughly 79% of
  // the core strength; the old Gaussian was down to 61%.
  expect(sample.thermal).toBeGreaterThan(thermal.strength * 0.7);
});

it("keeps a wide core at a banked-climb offset", () => {
  const terrain = new Terrain();
  const field = new LiftField(terrain, new Atmosphere(stillAir, terrain, 1), stillAir, 1);
  const home = field.thermals.find(
    (thermal) => Math.abs(thermal.x - 620) < 1e-6 && Math.abs(thermal.z + 720) < 1e-6,
  );
  expect(home).toBeDefined();

  const thermal = home!;
  const y = (thermal.base + thermal.top) / 2;
  // 900 m from the centre used to be outside the working core; with the wider
  // column it should still carry most of the lift for a banked climb.
  const sample = field.sample(new Vector3(thermal.x + 900, y, thermal.z), 0);
  expect(sample.thermal).toBeGreaterThan(thermal.strength * 0.8);
});

it("keeps the lift column fixed under its cloud marker", () => {
  const terrain = new Terrain();
  const weather = { ...DEFAULT_WEATHER, thermalStrength: 2.6 };
  const field = new LiftField(terrain, new Atmosphere(weather, terrain, 1), weather, 1);
  const point = new Vector3(620, 1200, -720);

  const first = field.sample(point, 0);
  const later = field.sample(point, 600);
  expect(first.nearest).not.toBeNull();
  expect(later.nearestDistance).toBeCloseTo(first.nearestDistance, 6);
  expect(later.nearestBearing).toBeCloseTo(first.nearestBearing, 6);
});

it("reports a workable radius and whether the glider is inside the column", () => {
  const terrain = new Terrain();
  const sim = new Simulation(terrain, stillAir);
  sim.startFlight(stillAir, "air");
  sim.position.set(620, 1200, -720);
  sim.velocity.set(0, 0, -29);
  sim.step(1 / 240);

  const info = sim.getNearestThermalInfo();
  expect(info).not.toBeNull();
  expect(info!.active).toBe(true);
  expect(info!.distance).toBeLessThan(20);
  // The doubled home column is well over 1.3 km in radius near the middle.
  expect(info!.radius).toBeGreaterThan(1300);

  sim.position.set(620, 2100, -720);
  sim.step(1 / 240);
  const above = sim.getNearestThermalInfo();
  expect(above).not.toBeNull();
  expect(above!.active).toBe(false);
});
