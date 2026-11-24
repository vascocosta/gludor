import { Quaternion, Vector3 } from "three";
import {
  BodyAxes,
  DEG,
  clamp,
  headingFromForward,
  moveTowards,
  pitchFromForward,
  quatFromHeadingPitchRoll,
  RAD,
  rollFromRight,
  shortestAngle,
  wrapDegrees,
} from "../core/math";
import {
  DEFAULT_WEATHER,
  GLIDER,
  GRAVITY,
  LANDING,
  TOW,
  WORLD,
  type WeatherSettings,
} from "../config";
import { AeroResult, ControlSurfaces, computeAero } from "./aero";
import {
  HOME_AIRFIELD,
  forEachAirfieldInBounds,
  takeoffHeading,
  type AirfieldSpec,
} from "./airfields";
import { Atmosphere } from "./atmosphere";
import { LiftField, LiftSample } from "./lift";
import type { Terrain } from "./terrain";
import { buildingHeightAt } from "./towns";
import { TowPlane } from "./towplane";

export type FlightMode =
  | "menu"
  | "winch"
  | "tow"
  | "free"
  | "rollout"
  | "landed"
  | "ditched"
  | "crashed";
export type LaunchType = "winch" | "tow" | "air";

export interface SimInput {
  pitch: number;
  roll: number;
  rudder: number;
  brake: number;
  trimUp: boolean;
  trimDown: boolean;
  release: boolean;
}

export interface FlightStats {
  airTime: number;
  maxAltitude: number;
  maxClimb: number;
  distance: number;
  launch: LaunchType;
}

export interface NearestAirfieldInfo {
  field: AirfieldSpec;
  distance: number;
  /** Bearing from the glider to the field, in degrees. */
  bearing: number;
}

const CLEARANCE = 0.9;
/** How far the landing helper looks for a strip; matches the rendered window. */
const AIRFIELD_HELPER_RADIUS = 20_000;
/** Winch power at the cable, in watts. */
const WINCH_POWER = 85_000;
/** Height above the field where the winch stops pulling. */
const WINCH_RELEASE_AGL = 440;
/** Height where the launch attitude starts easing towards a normal glide. */
const WINCH_EASE_AGL = 370;
const scratchUp = new Vector3();
const scratchDelta = new Vector3();
const scratchTowForce = new Vector3();
const scratchTowArm = new Vector3();
const scratchTowWind = new Vector3();

export class Simulation {
  readonly terrain: Terrain;
  readonly towPlane: TowPlane;
  mode: FlightMode = "menu";
  weather: WeatherSettings = { ...DEFAULT_WEATHER };
  atmosphere: Atmosphere;
  liftField: LiftField;
  /** The field this flight departs from. Aerotow still requires the home field. */
  field: AirfieldSpec = HOME_AIRFIELD;
  assist = true;

  position = new Vector3();
  velocity = new Vector3();
  orientation = new Quaternion();
  angular = { p: 0, q: 0, r: 0 };

  controls = new ControlSurfaces();
  trim = 0;
  input: SimInput = { pitch: 0, roll: 0, rudder: 0, brake: 0, trimUp: false, trimDown: false, release: false };

  time = 0;
  flightTime = 0;
  cableAttached = false;
  winchPosition = new Vector3();
  launch: LaunchType = "air";
  private releasePushUntil = 0;

  // Telemetry
  ias = 0;
  tas = 0;
  agl = 0;
  msl = 0;
  heading = 0;
  pitch = 0;
  roll = 0;
  slip = 0;
  gLoad = 1;
  stall = 0;
  alpha = 0;
  beta = 0;
  cl = 0;
  cd = 0;
  vario = 0;
  varioTE = 0;
  varioRaw = 0;
  varioTERaw = 0;
  wind = new Vector3();
  lift = new LiftSample();
  onGround = false;
  overWater = false;
  private lastTas = 0;
  private airTimeFrozen = false;
  private lastPosition = new Vector3();
  private messageText = "";
  private messageUntil = 0;
  private seed: number;
  private nearestAirfieldCache: {
    second: number;
    x: number;
    z: number;
    count: number;
    infos: NearestAirfieldInfo[];
  } | null = null;

  stats: FlightStats = {
    airTime: 0,
    maxAltitude: 0,
    maxClimb: 0,
    distance: 0,
    launch: "air",
  };

  private readonly axes = new BodyAxes();
  private readonly windScratch = new Vector3();
  private readonly vAir = new Vector3();
  private readonly force = new Vector3();
  private readonly moment = new Vector3();
  private readonly aero = new AeroResult();

  constructor(terrain: Terrain, weather: WeatherSettings = DEFAULT_WEATHER, seed = 20261116) {
    this.terrain = terrain;
    this.towPlane = new TowPlane(terrain);
    this.seed = seed;
    this.atmosphere = new Atmosphere(weather, terrain, seed);
    this.liftField = new LiftField(terrain, this.atmosphere, weather, seed);
    this.prepareMenu();
  }

  setSeed(seed: number): void {
    this.seed = seed;
  }

  private rebuildWeather(weather: WeatherSettings): void {
    this.weather = { ...weather };
    this.atmosphere = new Atmosphere(this.weather, this.terrain, this.seed);
    this.liftField = new LiftField(this.terrain, this.atmosphere, this.weather, this.seed);
  }

  prepareMenu(): void {
    this.rebuildWeather(this.weather);
    this.mode = "menu";
    this.field = HOME_AIRFIELD;
    this.launch = "winch";
    this.towPlane.hide();
    this.time = 0;
    this.flightTime = 0;
    this.cableAttached = false;
    this.position.set(0, this.terrain.heightAt(0, WORLD.startZ) + CLEARANCE, WORLD.startZ);
    this.velocity.set(0, 0, 0);
    this.orientation.copy(quatFromHeadingPitchRoll(0, 0, 0));
    this.angular.p = 0;
    this.angular.q = 0;
    this.angular.r = 0;
    this.controls = new ControlSurfaces();
    this.trim = 0;
    this.lastTas = 0;
    this.airTimeFrozen = false;
    this.releasePushUntil = 0;
    this.lastPosition.copy(this.position);
    this.resetStats("winch");
    this.updateTelemetry(0);
    this.winchPosition.set(0, this.terrain.heightAt(0, WORLD.winchZ) + 2.5, WORLD.winchZ);
    this.showMessage("Press FLY to launch", 6);
  }

  startFlight(
    weather: WeatherSettings,
    launch: LaunchType,
    field: AirfieldSpec = HOME_AIRFIELD,
  ): void {
    this.rebuildWeather(weather);
    this.field = field;
    this.nearestAirfieldCache = null;
    // Aerotow needs the home runway: the tug runs an axis-aligned profile and
    // the terrain around the origin is the only place it is guaranteed clear.
    const coercedTow = launch === "tow" && !field.home;
    const effectiveLaunch: LaunchType = coercedTow ? "winch" : launch;
    this.launch = effectiveLaunch;
    this.time = 0;
    this.flightTime = 0;
    this.cableAttached = false;
    this.controls = new ControlSurfaces();
    this.trim = 0;
    this.airTimeFrozen = false;
    this.releasePushUntil = 0;
    this.angular.p = 0;
    this.angular.q = 0;
    this.angular.r = 0;

    // Town strips are short grass fields: line up into the wind with the
    // winch well down the launch direction. A cable anchored at the far
    // threshold is too short for a small strip to reach release height, so the
    // anchor sits out in the meadow beyond it.
    const takeoff = field.home ? 0 : takeoffHeading(field, weather.windFrom);
    const heading = takeoff * DEG;
    const forwardX = Math.sin(heading);
    const forwardZ = -Math.cos(heading);
    const startAlong = field.home ? WORLD.startZ : field.length / 2 - 25;
    const startX = field.x - forwardX * startAlong;
    const startZ = field.z - forwardZ * startAlong;
    const winchRun = field.home ? WORLD.startZ - WORLD.winchZ : 1_600;
    const winchX = startX + forwardX * winchRun;
    const winchZ = startZ + forwardZ * winchRun;

    this.winchPosition.set(winchX, this.terrain.heightAt(winchX, winchZ) + 2.5, winchZ);
    this.towPlane.hide();

    let startTas = 0;

    if (effectiveLaunch === "winch") {
      this.mode = "winch";
      this.position.set(startX, this.terrain.heightAt(startX, startZ) + CLEARANCE, startZ);
      this.velocity.set(0, 0, 0);
      this.orientation.copy(quatFromHeadingPitchRoll(takeoff, 0, 0));
      this.cableAttached = true;
      this.showMessage("Winch launch: hold on, release with SPACE", 5);
    } else if (effectiveLaunch === "tow") {
      this.mode = "tow";
      this.position.set(startX, this.terrain.heightAt(startX, startZ) + CLEARANCE, startZ);
      this.velocity.set(0, 0, 0);
      this.orientation.copy(quatFromHeadingPitchRoll(takeoff, 0, 0));
      this.cableAttached = true;
      this.towPlane.launch();
      this.showMessage("Aerotow: follow the tug, SPACE to release", 6);
    } else {
      this.mode = "free";
      const speed = 29;
      startTas = speed;
      const airX = field.home ? 0 : field.x;
      const airZ = field.home ? 2200 : field.z;
      this.position.set(airX, this.terrain.heightAt(airX, airZ) + 650, airZ);

      // Start in a steady glide rather than pointed at the horizon: work out
      // the angle of attack and flight-path angle that balance lift and drag.
      const rho = this.atmosphere.densityAt(this.position.y);
      const cl = (2 * GLIDER.mass * GRAVITY) / (rho * speed * speed * GLIDER.wingArea);
      const alpha = (cl - GLIDER.cl0) / GLIDER.clAlpha;
      const k = 1 / (Math.PI * GLIDER.oswald * GLIDER.aspectRatio);
      const cd = GLIDER.cd0 + k * cl * cl;
      const flightPath = -Math.atan(cd / cl);
      const pitch = alpha + flightPath;

      this.orientation.copy(quatFromHeadingPitchRoll(takeoff, pitch, 0));
      this.axes.fromQuaternion(this.orientation);
      // The trim above is in air-relative terms. Add the local wind so the
      // glider starts at the intended airspeed, not groundspeed.
      const horizontal = speed * Math.cos(flightPath);
      this.velocity.set(
        forwardX * horizontal,
        speed * Math.sin(flightPath),
        forwardZ * horizontal,
      );
      this.velocity.add(this.atmosphere.windAt(this.position, this.time));
      this.showMessage("Air start - 650 m above the field", 4);
    }

    this.lastTas = startTas;
    this.lastPosition.copy(this.position);
    this.resetStats(effectiveLaunch);
    this.modeMessageForLaunch();
    if (coercedTow) {
      this.showMessage("Aerotow is home-field only - winch launch", 4.5);
    }
    this.updateTelemetry(0);
  }

  private modeMessageForLaunch(): void {
    if (this.launch === "winch" && this.mode === "winch") {
      this.showMessage("Winch launch: SPACE to release", 4);
    } else if (this.launch === "tow" && this.mode === "tow") {
      this.showMessage("Aerotow: follow the tug, SPACE to release", 5);
    }
  }

  private resetStats(launch: LaunchType): void {
    this.stats = {
      airTime: 0,
      maxAltitude: this.position.y,
      maxClimb: 0,
      distance: 0,
      launch,
    };
  }

  showMessage(text: string, seconds = 3): void {
    this.messageText = text;
    this.messageUntil = this.time + seconds;
  }

  /** Hide any transient message, e.g. when the free camera takes over. */
  clearMessage(): void {
    this.messageText = "";
    this.messageUntil = 0;
  }

  getMessage(): string | null {
    return this.time < this.messageUntil ? this.messageText : null;
  }

  releaseCable(): void {
    if (!this.cableAttached) return;
    const wasTow = this.mode === "tow";
    this.cableAttached = false;
    if (this.mode === "winch") {
      this.mode = "free";
      this.releasePushUntil = this.time + 2.2;
    } else if (wasTow) {
      this.mode = "free";
      this.towPlane.release();
    }
    this.showMessage(wasTow ? "Aerotow release - the tug is clear" : "Cable released", 2.5);
  }

  toggleAssist(): void {
    this.assist = !this.assist;
    this.showMessage(this.assist ? "Flight assist on" : "Flight assist off", 2);
  }

  step(dt: number): void {
    if (
      this.mode === "menu" ||
      this.mode === "landed" ||
      this.mode === "ditched" ||
      this.mode === "crashed"
    )
      return;

    // On the ground the wheel and friction own the motion. Running the full
    // aero model here is both unnecessary and wrong: with a tailwind the
    // airflow can run backwards over the wing, where the flight model would
    // keep pushing the glider instead of letting it stop.
    if (this.mode === "rollout") {
      this.stepRollout(dt);
      return;
    }

    if (this.towPlane.visible) {
      this.atmosphere.steadyWindAt(this.towPlane.position.y, scratchTowWind);
      this.towPlane.update(dt, scratchTowWind.x, scratchTowWind.z);
    }

    this.axes.fromQuaternion(this.orientation);
    this.updateControls(dt);
    if (this.input.release) this.releaseCable();

    // Air mass at the aircraft.
    this.atmosphere.windAt(this.position, this.time, this.windScratch);
    this.wind.copy(this.windScratch);

    this.liftField.sample(this.position, this.time, this.lift);
    this.windScratch.y += this.lift.total;
    this.vAir.copy(this.velocity).sub(this.windScratch);

    const density = this.atmosphere.densityAt(this.position.y);
    computeAero(this.vAir, this.axes, density, this.controls, this.angular, GLIDER, this.aero);

    this.force.copy(this.aero.forceWorld);
    this.force.y -= GLIDER.mass * GRAVITY;
    this.moment.copy(this.aero.momentWorld);

    if (this.cableAttached) {
      if (this.mode === "tow") this.applyTowForce();
      else this.applyWinchForce();
    }

    this.integrate(dt);
    if (this.cableAttached && this.mode === "tow") this.enforceTowRope();
    this.handleGround(dt);
    this.updateTelemetry(dt);
    this.updateMode();
    this.advanceClock(dt);
  }

  /** Time and distance bookkeeping shared by the airborne and ground loops. */
  private advanceClock(dt: number): void {
    this.time += dt;
    this.flightTime += dt;
    if (!this.airTimeFrozen) this.stats.airTime = this.flightTime;
    scratchDelta.subVectors(this.position, this.lastPosition);
    this.stats.distance += Math.hypot(scratchDelta.x, scratchDelta.z);
    this.lastPosition.copy(this.position);
    if (this.position.y > this.stats.maxAltitude) this.stats.maxAltitude = this.position.y;
    if (this.vario > this.stats.maxClimb) this.stats.maxClimb = this.vario;
  }

  private updateControls(dt: number): void {
    const rate = GLIDER.controlRate * dt;

    if (this.input.trimUp) this.trim += GLIDER.trimRate * dt;
    if (this.input.trimDown) this.trim -= GLIDER.trimRate * dt;
    this.trim = clamp(this.trim, -GLIDER.trimLimit, GLIDER.trimLimit);

    let elevatorTarget = clamp(this.input.pitch + this.trim, -1, 1);
    let aileronTarget = this.input.roll;
    let rudderTarget = this.input.rudder;

    if (this.mode === "winch") {
      // Hold a shallow climb attitude once there is enough airflow over the
      // tail, and stay neutral during the ground run. The pilot can still add
      // or reduce back pressure.
      const authority = clamp((this.tas - 18) / 8, 0, 1);
      const pitch = pitchFromForward(this.axes.forward);
      // Steeper as the launch speeds up, the way a pilot follows the cable up.
      const basePitch = clamp(0.3 + (this.tas - 28) * 0.011, 0.16, 0.42);
      // Lower the nose over the last stretch so the glider leaves the cable
      // in a normal glide attitude instead of zooming.
      const ground = this.terrain.heightAt(this.position.x, this.position.z);
      const ease = clamp((this.position.y - ground - WINCH_EASE_AGL) / 70, 0, 1);
      const pitchTarget = basePitch * (1 - 0.42 * ease);
      const winschElevator = clamp(
        (pitchTarget - pitch) * 1.6 - this.angular.q * 0.4,
        -0.35,
        0.5,
      );
      elevatorTarget = clamp(
        winschElevator * authority + this.input.pitch * 0.25 + this.trim,
        -1,
        1,
      );
    }

    if (this.mode === "tow" && this.cableAttached) {
      // Keep the glider level on the runway, then let it rotate gently once
      // there is enough airflow over the tail to follow the tug.
      const ground = this.terrain.heightAt(this.position.x, this.position.z);
      const agl = this.position.y - ground;
      if (agl < 14) {
        const authority = clamp((this.tas - 12) / 12, 0, 1);
        const targetPitch = this.tas > 24 ? 0.12 : 0;
        const pitch = pitchFromForward(this.axes.forward);
        const towElevator = clamp(
          (targetPitch - pitch) * 1.7 - this.angular.q * 0.5,
          -0.4,
          0.6,
        );
        elevatorTarget = clamp(
          towElevator * authority + this.input.pitch * 0.35 + this.trim,
          -1,
          1,
        );
      }
    }

    if (this.time < this.releasePushUntil) {
      // Just off the cable the glider is still pointing up the cable. A real
      // pilot eases forward to stop it zooming; do that for them.
      const blend = clamp((this.releasePushUntil - this.time) / 2.2, 0, 1);
      elevatorTarget = clamp(elevatorTarget - 0.26 * blend, -1, 1);
    }

    if (this.assist) {
      const autoRudder = clamp(this.controls.aileron * 0.32 + this.aero.beta * 1.6, -0.55, 0.55);
      rudderTarget = clamp(rudderTarget + autoRudder, -1, 1);
    }

    // Aerotow assist: hold the glider in the tug's wake and keep the rope
    // line steady. The player can always override with the stick; switching
    // assist off (F2) hands the whole tow back to them.
    if (
      this.mode === "tow" &&
      this.cableAttached &&
      this.assist &&
      !this.onGround &&
      this.towPlane.visible
    ) {
      const dx = this.towPlane.hook.x - this.position.x;
      const dz = this.towPlane.hook.z - this.position.z;
      const desiredHeading = Math.atan2(dx, -dz);
      const headingError = shortestAngle(this.heading * DEG, desiredHeading);
      const desiredBank = clamp(headingError * 1.6, -0.55, 0.55);
      const bankAssist = clamp(
        (desiredBank - this.roll) * 2.0 - this.angular.p * 0.3,
        -0.75,
        0.75,
      );
      aileronTarget = clamp(aileronTarget + bankAssist, -1, 1);

      const targetPitch = this.towPlane.pitch + clamp(this.alpha, 0.03, 0.18);
      const pitchAssist = clamp(
        (targetPitch - this.pitch) * 1.6 - this.angular.q * 0.3,
        -0.5,
        0.5,
      );
      elevatorTarget = clamp(elevatorTarget + pitchAssist, -1, 1);
    }

    // Nudge the glider back onto the runway centreline during the towed roll.
    if (this.mode === "tow" && this.onGround && this.assist) {
      const error = shortestAngle(this.heading * DEG, 0);
      aileronTarget = clamp(aileronTarget - this.roll * 2.5 - this.angular.p * 0.25, -0.8, 0.8);
      rudderTarget = clamp(rudderTarget + error * 1.4, -0.8, 0.8);
    }

    this.controls.elevator = moveTowards(this.controls.elevator, elevatorTarget, rate);
    this.controls.aileron = moveTowards(this.controls.aileron, aileronTarget, rate);
    this.controls.rudder = moveTowards(this.controls.rudder, rudderTarget, rate * 0.85);
    this.controls.brake = moveTowards(this.controls.brake, clamp(this.input.brake, 0, 1), GLIDER.brakeRate * dt);
  }

  private applyWinchForce(): void {
    const toWinch = scratchDelta.copy(this.winchPosition).sub(this.position);
    const distance = toWinch.length();
    if (distance < 60) return;

    // Constant-power winch: hard pull at low speed, tapering as the glider
    // accelerates into its climb. The tension cap keeps the ground run to
    // about 1.3 g.
    const speed = Math.max(8, this.velocity.length());
    const tension = Math.min(GLIDER.mass * GRAVITY * 1.3, WINCH_POWER / speed);

    this.force.addScaledVector(toWinch, tension / distance);
  }

  /**
   * Rope force for the aerotow. A rope only pulls: when it is slack there is
   * no force, and the spring-damper keeps the snatch at the start of the roll
   * firm but bounded. The force acts through a nose hook, so it also gives the
   * glider the gentle pitch-up a real aerotow produces.
   */
  private applyTowForce(): void {
    const hook = this.towPlane.hook;
    const dx = this.position.x - hook.x;
    const dy = this.position.y - hook.y;
    const dz = this.position.z - hook.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 1 || distance <= TOW.ropeLength) return;

    const nx = dx / distance;
    const ny = dy / distance;
    const nz = dz / distance;
    const stretch = distance - TOW.ropeLength;
    const opening =
      (this.velocity.x - this.towPlane.velocity.x) * nx +
      (this.velocity.y - this.towPlane.velocity.y) * ny +
      (this.velocity.z - this.towPlane.velocity.z) * nz;
    const tension = Math.min(
      TOW.maxTension,
      Math.max(0, TOW.spring * stretch + TOW.damping * opening),
    );
    if (tension <= 0) return;

    scratchTowForce.set(-nx * tension, -ny * tension, -nz * tension);
    this.force.add(scratchTowForce);

    // On the ground the wheel and the elevator assist handle rotation; adding
    // a nose-hook moment there would simply lift the nose off the runway.
    if (!this.onGround) {
      scratchTowArm.copy(this.axes.forward).multiplyScalar(TOW.hookArm);
      this.moment.add(scratchTowArm.cross(scratchTowForce));
    }
  }

  /**
   * Last line of defence for the rope: a real cable has almost no stretch, so
   * never let the distance constraint be violated by more than a metre or two.
   * Solving it after integration is stable at any frame rate.
   */
  private enforceTowRope(): void {
    const hook = this.towPlane.hook;
    const dx = this.position.x - hook.x;
    const dy = this.position.y - hook.y;
    const dz = this.position.z - hook.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const limit = TOW.ropeLength + TOW.maxStretch;
    if (distance <= limit) return;

    const nx = dx / distance;
    const ny = dy / distance;
    const nz = dz / distance;
    this.position.set(hook.x + nx * limit, hook.y + ny * limit, hook.z + nz * limit);

    const opening =
      (this.velocity.x - this.towPlane.velocity.x) * nx +
      (this.velocity.y - this.towPlane.velocity.y) * ny +
      (this.velocity.z - this.towPlane.velocity.z) * nz;
    if (opening > 0) {
      this.velocity.x -= nx * opening;
      this.velocity.y -= ny * opening;
      this.velocity.z -= nz * opening;
    }
  }

  private integrate(dt: number): void {
    // Weight is already part of this.force (see step), so gravity must not be
    // applied a second time here.
    this.velocity.addScaledVector(this.force, dt / GLIDER.mass);
    this.position.addScaledVector(this.velocity, dt);

    const { roll: ix, pitch: iy, yaw: iz } = GLIDER.inertia;
    const p = this.angular.p;
    const q = this.angular.q;
    const r = this.angular.r;

    const L = this.moment.dot(this.axes.forward);
    const M = this.moment.dot(this.axes.right);
    const N = this.moment.dot(this.axes.down);

    const pDot = (L - (iz - iy) * q * r) / ix;
    const qDot = (M - (ix - iz) * r * p) / iy;
    const rDot = (N - (iy - ix) * p * q) / iz;

    this.angular.p = clamp(p + pDot * dt, -8, 8);
    this.angular.q = clamp(q + qDot * dt, -8, 8);
    this.angular.r = clamp(r + rDot * dt, -8, 8);

    const omegaX =
      this.axes.forward.x * this.angular.p +
      this.axes.right.x * this.angular.q +
      this.axes.down.x * this.angular.r;
    const omegaY =
      this.axes.forward.y * this.angular.p +
      this.axes.right.y * this.angular.q +
      this.axes.down.y * this.angular.r;
    const omegaZ =
      this.axes.forward.z * this.angular.p +
      this.axes.right.z * this.angular.q +
      this.axes.down.z * this.angular.r;

    const qx = this.orientation.x;
    const qy = this.orientation.y;
    const qz = this.orientation.z;
    const qw = this.orientation.w;

    const half = 0.5 * dt;
    const dqx = half * (omegaX * qw + omegaY * qz - omegaZ * qy);
    const dqy = half * (omegaY * qw + omegaZ * qx - omegaX * qz);
    const dqz = half * (omegaZ * qw + omegaX * qy - omegaY * qx);
    const dqw = half * (-omegaX * qx - omegaY * qy - omegaZ * qz);

    this.orientation.set(qx + dqx, qy + dqy, qz + dqz, qw + dqw).normalize();
  }

  private handleGround(dt: number): void {
    const ground = this.terrain.heightAt(this.position.x, this.position.z);
    const water = this.terrain.waterLevelAt(this.position.x, this.position.z);
    const overWater = water !== null && water > ground;
    const floorHeight = overWater ? (water as number) : ground;

    // A roof is solid. Flying into a town at low level ends the flight.
    const roof = buildingHeightAt(this.position.x, this.position.z);
    const onBuilding = roof !== null && roof > floorHeight;
    const surface = onBuilding ? (roof as number) : floorHeight;
    this.overWater = overWater;

    const floor = surface + CLEARANCE;
    if (this.position.y > floor) {
      this.onGround = false;
      return;
    }

    this.position.y = floor;
    this.onGround = true;

    if (onBuilding) {
      this.mode = "crashed";
      this.cableAttached = false;
      this.towPlane.hide();
      this.velocity.multiplyScalar(0.15);
      this.velocity.y = 0;
      this.showMessage("Struck a building - press R to restart", 6);
      return;
    }

    const impact = Math.max(0, -this.velocity.y);
    if (overWater) {
      // Water is forgiving. A heavy arrival is still a ditching, not a
      // crash: the glider stops quickly and the pilot gets a long tow home.
      this.mode = "ditched";
      this.cableAttached = false;
      this.towPlane.hide();
      this.velocity.multiplyScalar(0.35);
      this.velocity.y = 0;
      this.showMessage("Ditched - a soft splash. Press R to fly again", 7);
      return;
    }
    if (this.mode === "free") {
      if (impact > 3.4 || Math.abs(this.roll) > 0.52 || this.pitch < -0.3) {
        this.mode = "crashed";
        this.cableAttached = false;
        this.towPlane.hide();
        this.velocity.multiplyScalar(0.15);
        this.showMessage("Crashed - press R to restart", 6);
        return;
      }
      // A safe touchdown starts a real landing roll. Keep simulating until
      // the glider stops; the summary opens afterwards.
      this.mode = "rollout";
      this.cableAttached = false;
      this.airTimeFrozen = true;
      this.stats.airTime = this.flightTime;
      this.showMessage("Touchdown - Q/E steer, B brakes", 5);
      this.velocity.y = 0;
    } else if (this.velocity.y < 0) {
      this.velocity.y = 0;
    }

    if (this.mode === "rollout") {
      // The rollout loop takes over on the next step.
      return;
    }

    const friction = overWater ? 3.4 : this.mode === "winch" || this.mode === "tow" ? 0.25 : 1.8;
    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontal > 1e-4) {
      const decel = Math.min(horizontal, friction * dt);
      this.velocity.x -= (this.velocity.x / horizontal) * decel;
      this.velocity.z -= (this.velocity.z / horizontal) * decel;
    }
  }

  /**
   * Ground-only integration for the landing roll. It deliberately bypasses the
   * aerodynamic force model: at low ground speed a tailwind can run backwards
   * over the wing, where the flight model is not valid and would otherwise keep
   * pushing the glider along instead of letting friction stop it.
   */
  private stepRollout(dt: number): void {
    this.position.addScaledVector(this.velocity, dt);

    const ground = this.terrain.heightAt(this.position.x, this.position.z);
    const water = this.terrain.waterLevelAt(this.position.x, this.position.z);
    const overWater = water !== null && water > ground;
    const floorHeight = overWater ? (water as number) : ground;
    const roof = buildingHeightAt(this.position.x, this.position.z);
    const onBuilding = roof !== null && roof > floorHeight;
    const surface = onBuilding ? (roof as number) : floorHeight;
    this.overWater = overWater;

    // The wheel stays planted however the terrain moves underneath it.
    this.position.y = surface + CLEARANCE;
    this.onGround = true;
    this.velocity.y = 0;

    if (onBuilding) {
      this.mode = "crashed";
      this.velocity.multiplyScalar(0.15);
      this.showMessage("Struck a building - press R to restart", 6);
    } else if (overWater) {
      this.mode = "ditched";
      this.velocity.multiplyScalar(0.35);
      this.showMessage("Ditched - a soft splash. Press R to fly again", 7);
    } else {
      this.updateRollout(dt);
    }

    // Airspeed still drives the IAS readout and the wind audio, but no
    // aerodynamic force is applied while the wheel carries the glider.
    this.atmosphere.windAt(this.position, this.time, this.windScratch);
    this.wind.copy(this.windScratch);
    this.axes.fromQuaternion(this.orientation);
    this.vAir.copy(this.velocity).sub(this.windScratch);
    const density = this.atmosphere.densityAt(this.position.y);
    computeAero(this.vAir, this.axes, density, this.controls, this.angular, GLIDER, this.aero);
    this.aero.forceWorld.set(0, 0, 0);
    this.aero.momentWorld.set(0, 0, 0);

    this.updateTelemetry(dt);
    // Ground contact, not flight, carries the weight.
    this.alpha = 0;
    this.beta = 0;
    this.stall = 0;
    this.gLoad = 1;

    this.advanceClock(dt);
  }

  /** Ground roll after a safe landing: friction, brakes, steering and attitude. */
  private updateRollout(dt: number): void {
    const totalSpeed = Math.hypot(this.velocity.x, this.velocity.z);

    // A little rudder authority at speed, fading out as the glider slows, so
    // it cannot pirouette on the spot.
    const authority = clamp(totalSpeed / LANDING.steerSpeed, 0, 1);
    const steer = clamp(this.input.rudder, -1, 1) * LANDING.steerRate * authority;
    const heading = wrapDegrees(this.heading + steer * RAD * dt);

    const forwardX = Math.sin(heading * DEG);
    const forwardZ = -Math.cos(heading * DEG);
    const rightX = Math.cos(heading * DEG);
    const rightZ = Math.sin(heading * DEG);

    // Keep the longitudinal and sideways components separate. Treating the
    // total speed as the forward component adds the sideways drift back on top
    // of the reduced speed, so a crabbed touchdown would accelerate without
    // bound instead of settling onto the wheel.
    const forward = this.velocity.x * forwardX + this.velocity.z * forwardZ;
    let lateral = this.velocity.x * rightX + this.velocity.z * rightZ;

    const brake = clamp(this.input.brake, 0, 1);
    const decel = (LANDING.friction + brake * LANDING.brakeDecel) * dt;
    const nextForward =
      Math.abs(forward) <= decel ? 0 : forward - Math.sign(forward) * decel;

    // Scrub off sideways drift so the glider follows the wheel instead of
    // sliding like a shopping trolley. Deliberately gentle: no ground loop.
    const grip = LANDING.lateralGrip * dt;
    if (Math.abs(lateral) <= grip) lateral = 0;
    else lateral -= Math.sign(lateral) * grip;

    this.velocity.set(
      forwardX * nextForward + rightX * lateral,
      0,
      forwardZ * nextForward + rightZ * lateral,
    );

    // Settle onto the ground: wings level with a slight nose-up tailwheel
    // stance. Rebuilding the orientation keeps the model stable and forgiving.
    const pitch = moveTowards(this.pitch, LANDING.pitch, LANDING.settleRate * dt);
    const roll = moveTowards(this.roll, LANDING.bank, LANDING.settleRate * dt);
    this.orientation.copy(quatFromHeadingPitchRoll(heading, pitch, roll));
    this.axes.fromQuaternion(this.orientation);
    this.heading = heading;
    this.pitch = pitch;
    this.roll = roll;
    this.angular.p = 0;
    this.angular.q = 0;
    this.angular.r = 0;

    if (Math.hypot(nextForward, lateral) < LANDING.stopSpeed) {
      this.velocity.set(0, 0, 0);
      this.mode = "landed";
      this.showMessage("Landed", 4);
    }
  }

  private updateTelemetry(dt: number): void {
    this.axes.fromQuaternion(this.orientation);
    this.msl = this.position.y;
    const ground = this.terrain.heightAt(this.position.x, this.position.z);
    const water = this.terrain.waterLevelAt(this.position.x, this.position.z);
    this.overWater = water !== null && water > ground;
    // Over a lake, height above the water is what matters for landing.
    this.agl = this.msl - (this.overWater ? water! : ground);
    this.tas = this.aero.airspeed;
    this.ias = this.atmosphere.indicatedAirspeed(this.tas, this.msl);
    this.heading = headingFromForward(this.axes.forward);
    this.pitch = pitchFromForward(this.axes.forward);
    this.roll = rollFromRight(this.axes.right);
    this.alpha = this.aero.alpha;
    this.beta = this.aero.beta;
    this.cl = this.aero.cl;
    this.cd = this.aero.cd;
    this.stall = this.aero.stall;
    this.slip = clamp(this.aero.beta / 0.15, -1, 1);
    scratchUp.copy(this.axes.down).negate();
    this.gLoad = this.aero.forceWorld.dot(scratchUp) / (GLIDER.mass * GRAVITY);

    this.varioRaw = this.velocity.y;
    // Clamp the acceleration so a restart or a sudden wind change cannot throw
    // the total-energy vario off the dial.
    const accel =
      dt > 0 && this.lastTas > 0 ? clamp((this.tas - this.lastTas) / dt, -6, 6) : 0;
    this.varioTERaw = clamp(this.velocity.y + (this.tas / GRAVITY) * accel, -12, 12);
    this.lastTas = this.tas;

    const smoothing = dt > 0 ? 1 - Math.exp(-dt / 1.1) : 0;
    this.vario += (this.varioRaw - this.vario) * smoothing;
    this.varioTE += (this.varioTERaw - this.varioTE) * smoothing;
  }

  private updateMode(): void {
    if (this.mode === "winch") {
      const agl = this.position.y - this.terrain.heightAt(this.position.x, this.position.z);
      if (agl > WINCH_RELEASE_AGL) {
        this.releaseCable();
        this.showMessage("Winch release - find the first thermal", 4);
      }
    } else if (this.mode === "tow") {
      const agl = this.position.y - this.terrain.heightAt(this.position.x, this.position.z);
      if (agl >= TOW.targetAgl) {
        this.releaseCable();
        this.showMessage(`Aerotow release at ${Math.round(agl)} m - find the first thermal`, 5);
      }
    }
  }

  /**
   * The closest strips within the helper's search radius, nearest first. The
   * result is cached for a second of flight time so the HUD can call this every
   * frame without walking the airfield grid each time.
   */
  getNearestAirfieldInfos(count = 2): NearestAirfieldInfo[] {
    const limit = Math.max(1, Math.floor(count));
    const x = this.position.x;
    const z = this.position.z;
    const second = Math.floor(this.time);
    const cached = this.nearestAirfieldCache;
    if (
      cached &&
      cached.second === second &&
      cached.count === limit &&
      Math.hypot(x - cached.x, z - cached.z) < 200
    ) {
      return cached.infos;
    }

    const picks: Array<{ field: AirfieldSpec; distance: number }> = [];
    const consider = (field: AirfieldSpec): void => {
      const distance = Math.hypot(field.x - x, field.z - z);
      if (distance > AIRFIELD_HELPER_RADIUS) return;
      if (picks.length === limit && distance >= picks[picks.length - 1].distance) return;

      let index = picks.length;
      while (index > 0 && distance < picks[index - 1].distance) index--;
      picks.splice(index, 0, { field, distance });
      if (picks.length > limit) picks.length = limit;
    };

    consider(HOME_AIRFIELD);
    forEachAirfieldInBounds(
      x - AIRFIELD_HELPER_RADIUS,
      z - AIRFIELD_HELPER_RADIUS,
      x + AIRFIELD_HELPER_RADIUS,
      z + AIRFIELD_HELPER_RADIUS,
      consider,
    );

    const infos = picks.map(({ field, distance }) => ({
      field,
      distance,
      bearing: (Math.atan2(field.x - x, -(field.z - z)) * 180) / Math.PI,
    }));
    this.nearestAirfieldCache = { second, x, z, count: limit, infos };
    return infos;
  }

  getNearestThermalInfo(): {
    distance: number;
    bearing: number;
    strength: number;
    radius: number;
    active: boolean;
  } | null {
    const thermal = this.lift.nearest;
    if (!thermal) return null;
    const span = thermal.top - thermal.base;
    const u = span > 1 ? (this.position.y - thermal.base) / span : 0;
    return {
      distance: this.lift.nearestDistance,
      bearing: this.lift.nearestBearing,
      strength: thermal.strength,
      radius: thermal.radius * (0.9 + 0.6 * clamp(u, 0, 1)),
      active: u > 0.08 && u < 0.92,
    };
  }

  getSummary(): FlightStats & { mode: FlightMode; altitude: number; maxClimb: number } {
    return {
      ...this.stats,
      mode: this.mode,
      altitude: this.msl,
      maxClimb: this.stats.maxClimb,
    };
  }
}
