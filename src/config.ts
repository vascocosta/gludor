export interface GliderConfig {
  name: string;
  mass: number;
  wingArea: number;
  span: number;
  chord: number;
  aspectRatio: number;
  oswald: number;
  cd0: number;
  cl0: number;
  clAlpha: number;
  clMax: number;
  clMin: number;
  alphaStall: number;
  alphaStallNeg: number;
  cdBrake: number;
  cYbeta: number;
  cm0: number;
  cmAlpha: number;
  cmDe: number;
  cmQ: number;
  clDa: number;
  clBeta: number;
  clP: number;
  clR: number;
  cnBeta: number;
  cnDr: number;
  cnR: number;
  cnP: number;
  inertia: { roll: number; pitch: number; yaw: number };
  controlRate: number;
  brakeRate: number;
  trimRate: number;
  trimLimit: number;
}

/**
 * The fictional GD-81: a 15 m single-seater with a Discus-like polar.
 * All coefficients are starting points; the flight tests in test/ tune the feel.
 */
export const GLIDER: GliderConfig = {
  name: "GD-81",
  mass: 450,
  wingArea: 11,
  span: 15,
  chord: 0.733,
  aspectRatio: 20.45,
  oswald: 0.9,
  cd0: 0.01,
  cl0: 0.15,
  clAlpha: 5.0,
  clMax: 1.6,
  clMin: 1.1,
  alphaStall: 0.29,
  alphaStallNeg: 0.25,
  cdBrake: 0.12,
  cYbeta: 0.55,
  cm0: 0.08,
  cmAlpha: -0.6,
  cmDe: 0.4,
  // The tail is not modelled as a separate lifting surface, so the pitch
  // damping here is much larger than a textbook Cm_q to stand in for the
  // missing tail volume. Without it the phugoid grows instead of settling.
  cmQ: -140,
  clDa: 0.032,
  clBeta: -0.03,
  clP: -0.12,
  clR: 0.02,
  cnBeta: 0.07,
  cnDr: 0.035,
  cnR: -0.08,
  cnP: 0.01,
  inertia: { roll: 2000, pitch: 1800, yaw: 2600 },
  controlRate: 3.0,
  brakeRate: 1.2,
  trimRate: 0.12,
  trimLimit: 0.25,
};

export const GRAVITY = 9.80665;
export const RHO0 = 1.225;
export const SEA_LEVEL_TEMP = 288.15;
export const TEMP_LAPSE = 0.0065;

export const PHYSICS_STEP = 1 / 240;

export interface WeatherSettings {
  windSpeed: number; // km/h at 10 m above ground
  windFrom: number; // degrees, meteorological: direction the wind comes from
  thermalStrength: number; // m/s in a strong core
  turbulence: number; // 0..1
  cloudBase: number; // metres MSL
  timeOfDay: number; // hours
}

export const DEFAULT_WEATHER: WeatherSettings = {
  windSpeed: 15,
  windFrom: 180,
  thermalStrength: 2.6,
  turbulence: 0.3,
  cloudBase: 1900,
  timeOfDay: 13,
};

export interface WeatherPreset {
  id: string;
  label: string;
  description: string;
  weather: WeatherSettings;
}

export const WEATHER_PRESETS: WeatherPreset[] = [
  {
    id: "calm",
    label: "Gentle afternoon",
    description: "Light wind, soft thermals. The easiest place to start.",
    weather: { windSpeed: 5, windFrom: 180, thermalStrength: 1.1, turbulence: 0.08, cloudBase: 1700, timeOfDay: 14 },
  },
  {
    id: "standard",
    label: "Standard soaring day",
    description: "Cumulus, reliable thermals and a workable breeze.",
    weather: { windSpeed: 15, windFrom: 180, thermalStrength: 2.6, turbulence: 0.3, cloudBase: 1900, timeOfDay: 13 },
  },
  {
    id: "strong",
    label: "Strong thermals",
    description: "Big climbs, strong sink and a turbulent boundary layer.",
    weather: { windSpeed: 22, windFrom: 195, thermalStrength: 4.2, turbulence: 0.62, cloudBase: 2400, timeOfDay: 14 },
  },
  {
    id: "ridge",
    label: "Ridge day",
    description: "Strong southerly onto the ridge. Little thermal activity.",
    weather: { windSpeed: 38, windFrom: 180, thermalStrength: 0.7, turbulence: 0.32, cloudBase: 2000, timeOfDay: 15 },
  },
  {
    id: "evening",
    label: "Evening glass",
    description: "Smooth air, weak lift and long shadows.",
    weather: { windSpeed: 8, windFrom: 220, thermalStrength: 0.5, turbulence: 0.12, cloudBase: 1600, timeOfDay: 17.5 },
  },
];

export interface WorldConfig {
  /** Physics sampling grid. Rendering LODs are integer multiples of this. */
  gridSpacing: number;
  seed: number;
  baseElevation: number;
  fieldElevation: number;
  fieldFlattenInner: number;
  fieldFlattenOuter: number;
  runwayLength: number;
  runwayWidth: number;
  startZ: number;
  winchZ: number;
}

export const WORLD: WorldConfig = {
  gridSpacing: 50,
  seed: 20261116,
  baseElevation: 380,
  fieldElevation: 400,
  fieldFlattenInner: 1000,
  fieldFlattenOuter: 1700,
  runwayLength: 2000,
  runwayWidth: 32,
  startZ: 1000,
  winchZ: -1200,
};

/**
 * Aerotow. The tug is a deterministic scripted departure, not a second
 * simulated body: it rolls, turns, and climbs on rails, while the glider is
 * pulled by a spring-damper rope and flown by the player.
 */
export const TOW = {
  /** Rope length from the glider's hook to the tug's tail. */
  ropeLength: 60,
  /** The tug's origin on the runway, ahead of the glider at WORLD.startZ. */
  startZ: 940,
  /** The tug's origin sits this high above the surface on its gear. */
  wheelHeight: 1.25,
  /** Tail hook position in the tug's local frame (behind its CG). */
  hookZ: 3.4,
  hookY: 0.1,
  liftOffSpeed: 27,
  groundAccel: 1.1,
  cruiseSpeed: 30,
  climbSpeed: 5.5,
  /** Altitude above the field where the gentle departure turn begins. */
  turnEntryAgl: 150,
  /** Radius of the climbing turn over the field. */
  turnRadius: 620,
  /** The tug takes the glider here; SPACE releases earlier. */
  targetAgl: 1200,
  /** Rope spring, damping, and a firm cap on tension. */
  spring: 3000,
  damping: 2000,
  maxTension: 12_000,
  /** Safety clamp: the rope can never stretch beyond this. */
  maxStretch: 2,
  /** A nose hook gives the glider a gentle pitch-up while on tow. */
  hookArm: 1.4,
  /** Seconds the tug keeps flying after release before it vanishes. */
  departTime: 24,
} as const;

/** Deterministic lake grid. Rivers are out of scope for V1; lakes are landmarks. */
export const LAKES = {
  /**
   * Lake country. The 2.5 km grid still puts a handful of lakes inside a short
   * glide of the field, but a 0.4 chance leaves roughly half as many as the
   * old fully saturated grid. The shore filters below decide where water fits.
   */
  cellSize: 2500,
  chance: 0.4,
  minRadius: 170,
  radiusRange: 270,
  /** No lake centres inside this radius of the field. */
  keepOut: 1300,
  maxCenterHeight: 2000,
  maxShoreRelief: 140,
  maxCenterDrop: 70,
  /** Normalised distance at which the bank blends back into natural ground. */
  outer: 1.42,
  /** Extra grid search margin when collecting the visible lakes. */
  margin: 2200,
  /** How far from the camera water is drawn. */
  renderRadius: 36000,
  rebuildDistance: 1500,
} as const;

/**
 * Deterministic town grid. Same idea as the lakes: a cell either owns a
 * town or none, and the layout inside it is seeded from the cell, so a town
 * is identical however the world is streamed or revisited.
 */
export const TOWNS = {
  cellSize: 6000,
  chance: 0.65,
  /** No generated town centre inside this radius: keeps the approach and circuit clear. */
  keepOut: 3000,
  /**
   * A fixed town near the field, exempt from the keep-out. It gives the home
   * landscape a proper landmark without crowding the circuit: 2.2 km southwest,
   * on flat, dry ground clear of the approach, with a forced church tower.
   */
  home: {
    x: -1100,
    z: 1900,
    radius: 460,
    angle: 0.35,
  },
  minRadius: 240,
  radiusRange: 320,
  /** Hard cap on buildings in one town. */
  maxBuildings: 96,
  /** Towns are farmland settlements, not hill stations. */
  maxCenterHeight: 700,
  /** Reject sites steeper than this (rise over run) at the centre and rim. */
  maxSlope: 0.18,
  /** How far from the camera buildings are drawn. */
  renderRadius: 18000,
  rebuildDistance: 2000,
  /** Windows are only generated this close, where they are actually visible. */
  windowRadius: 5000,
} as const;

/**
 * Deterministic mountain grid. Each cell either owns a massif or none. Peaks
 * are kept out of the airfield bowl, but the grid itself is infinite, so
 * cross-country flights always find new ranges.
 */
export const MOUNTAINS = {
  cellSize: 9000,
  chance: 0.6,
  /** No mountain contribution inside this radius of the airfield. */
  keepOut: 6000,
  /** Foothills fade in between the keep-out and this radius. */
  fadeOuter: 7500,
  minRadius: 1400,
  radiusRange: 2000,
  /** Alpine summits are narrower than foothills, so they read as sharp peaks. */
  alpineRadius: 800,
  alpineRadiusRange: 900,
  /** Ordinary rounded hills. */
  hillHeight: 180,
  hillHeightRange: 340,
  /** Sharper, snow-catching peaks. */
  alpineChance: 0.42,
  alpineHeight: 850,
  alpineHeightRange: 500,
  /** Upper bound on the combined height of overlapping peaks. */
  maxHeight: 1700,
} as const;

/** Free inspection camera used to look around the world without flying. */
export const FREE_CAMERA = {
  /** Metres per second at normal speed. */
  speed: 80,
  /** Multiplier while Shift is held. */
  boost: 8,
  /** Never get closer than this to ground, water, or a roof. */
  clearance: 2,
} as const;

/**
 * Pilot eye in cockpit view, in airframe body coordinates. Raise `eyeHeight`
 * to sit taller in the seat; `eyeForward` moves the eye fore/aft.
 */
export const COCKPIT_VIEW = {
  eyeHeight: 0.75,
  eyeForward: -0.52,
} as const;

/** Streaming and procedural-content constants shared by the simulation and renderer. */
export const STREAMING = {
  nearTileSize: 4000,
  nearSpacing: 50,
  midTileSize: 8000,
  midSpacing: 100,
  farTileSize: 16000,
  farSpacing: 400,
  terrainBuildBudgetMs: 4,
  treeRadius: 10000,
  thermalCellSize: 2500,
  thermalRadius: 32000,
  cloudTileSize: 16000,
  cloudTilesEachSide: 2,
} as const;

export const CAMERA_MODES = ["chase", "cockpit", "orbit"] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];
