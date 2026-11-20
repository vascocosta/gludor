import { Vector3 } from "three";
import { clamp, smoothstep, type BodyAxes } from "../core/math";
import type { GliderConfig } from "../config";

export class ControlSurfaces {
  elevator = 0;
  aileron = 0;
  rudder = 0;
  brake = 0;
}

export class AeroResult {
  forceWorld = new Vector3();
  momentWorld = new Vector3();
  alpha = 0;
  beta = 0;
  airspeed = 0;
  cl = 0;
  cd = 0;
  stall = 0;
  qbar = 0;
  lift = 0;
  drag = 0;
  side = 0;
}

const liftDir = new Vector3();
const dragDir = new Vector3();
const momentBody = new Vector3();
const scratch = new Vector3();

export function liftCoefficient(alpha: number, cfg: GliderConfig): number {
  if (alpha > cfg.alphaStall) {
    return cfg.clMax * (0.55 + 0.45 * Math.exp(-4 * (alpha - cfg.alphaStall)));
  }
  if (alpha < -cfg.alphaStallNeg) {
    return -cfg.clMin * (0.55 + 0.45 * Math.exp(-4 * (-alpha - cfg.alphaStallNeg)));
  }
  return cfg.cl0 + cfg.clAlpha * alpha;
}

export function dragCoefficient(cl: number, alpha: number, beta: number, brake: number, cfg: GliderConfig): number {
  const k = 1 / (Math.PI * cfg.oswald * cfg.aspectRatio);
  const excess = Math.max(0, alpha - cfg.alphaStall) + Math.max(0, -alpha - cfg.alphaStallNeg);
  return (
    cfg.cd0 +
    k * cl * cl +
    cfg.cdBrake * brake * brake +
    2.4 * excess * excess +
    0.15 * beta * beta
  );
}

/**
 * Compute aerodynamic force and moment for the current air-relative velocity.
 * Forces are in world space; moments are about body axes then rotated to world.
 */
export function computeAero(
  vAir: Vector3,
  axes: BodyAxes,
  density: number,
  surfaces: ControlSurfaces,
  rates: { p: number; q: number; r: number },
  cfg: GliderConfig,
  out: AeroResult,
): AeroResult {
  out.forceWorld.set(0, 0, 0);
  out.momentWorld.set(0, 0, 0);
  out.alpha = 0;
  out.beta = 0;
  out.airspeed = 0;
  out.cl = 0;
  out.cd = 0;
  out.stall = 0;
  out.qbar = 0;
  out.lift = 0;
  out.drag = 0;
  out.side = 0;

  const V = vAir.length();
  if (V < 0.6) return out;

  const u = vAir.dot(axes.forward);
  const v = vAir.dot(axes.right);
  const w = vAir.dot(axes.down);

  const alpha = Math.atan2(w, u);
  const beta = Math.asin(clamp(v / V, -1, 1));
  const brake = clamp(surfaces.brake, 0, 1);

  let cl = liftCoefficient(alpha, cfg);
  cl *= 1 - 0.18 * brake;
  const cd = dragCoefficient(cl, alpha, beta, brake, cfg);

  const qbar = 0.5 * density * V * V;
  const lift = qbar * cfg.wingArea * cl;
  const drag = qbar * cfg.wingArea * cd;
  const side = -qbar * cfg.wingArea * cfg.cYbeta * beta;

  // Lift is perpendicular to the relative wind in the aircraft's symmetry plane.
  liftDir.copy(axes.right).cross(vAir);
  if (liftDir.lengthSq() < 1e-9) liftDir.copy(axes.down).negate();
  else liftDir.normalize();
  dragDir.copy(vAir).multiplyScalar(-1 / V);

  out.forceWorld
    .copy(liftDir)
    .multiplyScalar(lift)
    .addScaledVector(dragDir, drag)
    .addScaledVector(axes.right, side);

  const stallPos = smoothstep(cfg.alphaStall, cfg.alphaStall + 0.11, alpha);
  const stallNeg = smoothstep(cfg.alphaStallNeg, cfg.alphaStallNeg + 0.11, -alpha);
  const stall = Math.max(stallPos, stallNeg);

  // Nondimensional moment coefficients.
  const halfSpan = (cfg.span * 0.5) / V;
  const halfChord = (cfg.chord * 0.5) / V;

  const clCoef =
    cfg.clDa * surfaces.aileron +
    cfg.clBeta * beta +
    cfg.clP * rates.p * halfSpan +
    cfg.clR * rates.r * halfSpan;

  const cmCoef =
    cfg.cm0 +
    cfg.cmAlpha * alpha +
    cfg.cmDe * surfaces.elevator +
    cfg.cmQ * rates.q * halfChord -
    0.22 * stall;

  const cnCoef =
    cfg.cnBeta * beta +
    cfg.cnDr * surfaces.rudder +
    cfg.cnR * rates.r * halfSpan +
    cfg.cnP * rates.p * halfSpan -
    0.012 * surfaces.aileron;

  const momentScale = qbar * cfg.wingArea;
  momentBody.set(
    momentScale * cfg.span * clCoef,
    momentScale * cfg.chord * cmCoef,
    momentScale * cfg.span * cnCoef,
  );

  out.momentWorld
    .copy(axes.forward)
    .multiplyScalar(momentBody.x)
    .addScaledVector(axes.right, momentBody.y)
    .addScaledVector(axes.down, momentBody.z);

  out.alpha = alpha;
  out.beta = beta;
  out.airspeed = V;
  out.cl = cl;
  out.cd = cd;
  out.stall = stall;
  out.qbar = qbar;
  out.lift = lift;
  out.drag = drag;
  out.side = side;

  // Keep the scratch vector referenced so the module has no dead imports.
  scratch.set(0, 0, 0);
  return out;
}
