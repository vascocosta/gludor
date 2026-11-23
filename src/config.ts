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

/**
 * Landing rollout. A safe touchdown does not end the flight: the glider keeps
 * rolling on the ground until it stops, and only then does the summary open.
 * The numbers are deliberately forgiving; there is no ground-loop model.
 */
export const LANDING = {
  /** Rolling friction on grass, m/s². */
  friction: 1.0,
  /** Extra deceleration from the wheel brake (B), m/s². */
  brakeDecel: 3.0,
  /** Ground speed below which the glider is considered stopped, m/s. */
  stopSpeed: 0.8,
  /** Maximum yaw rate from the rudder while rolling, rad/s. */
  steerRate: 0.25,
  /** Speed below which the rudder has little steering authority, m/s. */
  steerSpeed: 8,
  /** How quickly sideways drift is scrubbed off, m/s². */
  lateralGrip: 2.0,
  /** How fast the attitude settles onto the ground, rad/s. */
  settleRate: 2.5,
  /** Tailwheel stance: a gentle nose-up pitch, radians. */
  pitch: 0.05,
  /** Wings level on the ground, radians. */
  bank: 0,
  /** Delay after stopping before the flight summary opens, seconds. */
  summaryDelay: 1.5,
};

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
    label: "Ridge day south",
    description: "Strong southerly onto the main chain. Little thermal activity.",
    weather: { windSpeed: 38, windFrom: 180, thermalStrength: 0.7, turbulence: 0.32, cloudBase: 2000, timeOfDay: 15 },
  },
  {
    id: "ridge-west",
    label: "Ridge day west",
    description: "Strong westerly across the valley onto the north-south bank.",
    weather: { windSpeed: 38, windFrom: 270, thermalStrength: 0.7, turbulence: 0.32, cloudBase: 2000, timeOfDay: 15 },
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
 * One hand-placed ridge in the home landscape. `yaw` rotates the crest about
 * Y (0 runs east-west, π/2 north-south), the cross-section is Gaussian, and
 * the ends taper so a chain reads as spurs and cols rather than a wall.
 */
export interface RidgeSpec {
  /** Centre of the crest in world XZ. */
  x: number;
  z: number;
  /** Length of the crest along its local X axis. */
  length: number;
  /** Gaussian half-width across the ridge. */
  halfWidth: number;
  /** Height added at the crest before the crest noise. */
  height: number;
  /** Rotation about Y, radians. */
  yaw: number;
  /** Length of each tapered end. */
  taper: number;
  /** Seed offset for the crest noise and the lateral meander. */
  seed: number;
  /** Crest variation as a fraction of `height`. */
  roughness: number;
}

/**
 * The training ridges. They sit north of the airfield in a broken chain with
 * real cols between the segments, so ridge soaring means working one bank,
 * crossing a saddle, and committing to the next. The central bank is the
 * long working line, almost 15 km end to end; the outer two are short spurs
 * a col beyond each end.
 */
export const RIDGES: RidgeSpec[] = [
  {
    x: -11_800,
    z: -2600,
    length: 6000,
    halfWidth: 760,
    height: 520,
    yaw: 0.06,
    taper: 1600,
    seed: 3.1,
    roughness: 0.17,
  },
  {
    x: 0,
    z: -2950,
    length: 15_000,
    halfWidth: 780,
    height: 640,
    yaw: -0.03,
    taper: 2600,
    seed: 9.4,
    roughness: 0.2,
  },
  {
    x: 11_800,
    z: -2650,
    length: 6000,
    halfWidth: 720,
    height: 540,
    yaw: 0.07,
    taper: 1600,
    seed: 17.2,
    roughness: 0.17,
  },
  // A north-south bank west of the field. It barely works in the usual
  // southerly, but gives westerly days a long slope of their own and meets the
  // west spur in a high junction.
  {
    x: -12_500,
    z: -1000,
    length: 10_000,
    halfWidth: 700,
    height: 500,
    yaw: Math.PI / 2,
    taper: 2200,
    seed: 23.7,
    roughness: 0.18,
  },
];

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

/** Deterministic lake grid. The hand-placed river network follows below. */
export const LAKES = {
  /**
   * Lake country. The 2.5 km grid still puts a handful of lakes inside a short
   * glide of the field, but a 0.2 chance halves the number of basins again
   * from the previous grid. The shore filters below decide where water fits.
   */
  cellSize: 2500,
  chance: 0.2,
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
 * Hand-placed streams near the home field. They are deliberately finite and
 * authored by hand, like the training ridges: a procedural world-wide river
 * network needs flow routing and chunk continuity that V1 does not.
 *
 * Each point is [x, z, full width in metres]. Widths vary along the course, so
 * the streams widen at their mouths and pinch at their sources.
 */
export const RIVERS = {
  depth: 2.4,
  bankWidth: 26,
  stationSpacing: 12,
  /** Reject town sites whose footprint reaches this close to a stream. */
  townMargin: 300,
  streams: [
    {
      // Western meltwater river: rises at the snow line of the snow-capped
      // mountain at (-9500, 4900), descends its flank, then runs across the
      // western shelf and follows the old valley into the lake at
      // (-2873, -433). It stays clear of the airfield and home town.
      points: [
        [-9100, 4400, 30],
        [-8950, 4250, 34],
        [-8800, 4100, 38],
        [-8650, 3950, 42],
        [-8500, 3800, 46],
        [-8350, 3650, 50],
        [-8200, 3500, 54],
        [-8100, 3300, 58],
        [-8000, 3100, 62],
        [-7900, 2900, 66],
        [-7850, 2700, 70],
        [-7800, 2500, 74],
        [-7750, 2300, 78],
        [-7600, 2150, 82],
        [-7500, 1950, 86],
        [-7350, 1800, 90],
        [-7200, 1650, 94],
        [-7050, 1500, 98],
        [-6900, 1350, 102],
        [-6750, 1200, 106],
        [-6550, 1050, 110],
        [-6400, 900, 112],
        [-6250, 750, 114],
        [-6100, 600, 116],
        [-5950, 450, 118],
        [-5750, 300, 120],
        [-5600, 150, 121],
        [-5400, 100, 122],
        [-5150, 60, 123],
        [-4900, 40, 124],
        [-4650, 50, 125],
        [-4400, 80, 125],
        [-4150, 120, 125],
        [-3900, 160, 125],
        [-3650, 230, 125],
        [-3600, 250, 124],
        [-3400, 270, 122],
        [-3200, 300, 120],
        [-3040, 308, 118],
        [-2880, 316, 116],
        [-2800, 320, 114],
        [-2717, 313, 112],
        [-2633, 307, 110],
        [-2550, 300, 108],
        [-2500, 225, 106],
        [-2450, 150, 104],
        [-2467, 83, 102],
        [-2483, 17, 100],
        [-2500, -50, 98],
        [-2550, -125, 96],
        [-2600, -200, 94],
        [-2675, -265, 90],
        [-2750, -330, 86],
        [-2812, -382, 82],
        [-2873, -433, 78],
      ],
    },
    {
      // Eastern stream: from the higher ground east of the valley, west across
      // the open ground south of the field and into a low meadow. This course
      // stays in sight from the airfield and clear of the home-town plots.
      points: [
        [3500, 2000, 20],
        [3000, 2000, 24],
        [2500, 2020, 28],
        [2000, 2000, 32],
        [1500, 2010, 36],
        [1000, 2000, 40],
        [600, 2000, 44],
        [150, 2000, 50],
      ],
    },
  ],
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
   * landscape a proper landmark without crowding the circuit: 2.4 km southwest,
   * on flat, dry ground clear of the approach, with a forced church tower.
   */
  home: {
    x: -1200,
    z: 2075,
    radius: 920,
    angle: 0.35,
  },
  /** Radii are doubled from the old settlements, giving 4x the footprint area. */
  minRadius: 480,
  radiusRange: 640,
  /** Hard cap on buildings in one town. */
  maxBuildings: 450,
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
  eyeHeight: 0.67,
  eyeForward: -0.65,
  /**
   * Uniform scale for the dash, instrument panel, centre console, switches and
   * stick, anchored at the console base. 1 is the modelled size; try 0.85-1.2.
   */
  consoleScale: 0.92,
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
