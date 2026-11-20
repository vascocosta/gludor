import { Euler, Quaternion, Vector3 } from "three";

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

export function wrapDegrees(degrees: number): number {
  let d = degrees % 360;
  if (d < 0) d += 360;
  return d;
}

export function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const LOCAL_FORWARD = new Vector3(0, 0, -1);
const LOCAL_RIGHT = new Vector3(1, 0, 0);
const LOCAL_DOWN = new Vector3(0, -1, 0);

/** Aerospace body axes: forward (X), right (Y), down (Z). */
export class BodyAxes {
  forward = new Vector3(0, 0, -1);
  right = new Vector3(1, 0, 0);
  down = new Vector3(0, -1, 0);

  fromQuaternion(q: Quaternion): this {
    this.forward.copy(LOCAL_FORWARD).applyQuaternion(q);
    this.right.copy(LOCAL_RIGHT).applyQuaternion(q);
    this.down.copy(LOCAL_DOWN).applyQuaternion(q);
    return this;
  }
}

/**
 * Build a mesh orientation from heading/pitch/roll.
 * Heading is degrees clockwise from north (-Z), pitch is positive nose-up,
 * roll is positive right-wing-down.
 */
export function quatFromHeadingPitchRoll(
  headingDeg: number,
  pitchRad: number,
  rollRad: number,
  target = new Quaternion(),
): Quaternion {
  const headingRad = headingDeg * DEG;
  return target.setFromEuler(new Euler(pitchRad, -headingRad, -rollRad, "YXZ"));
}

export function headingFromForward(forward: Vector3): number {
  return wrapDegrees(Math.atan2(forward.x, -forward.z) * RAD);
}

export function pitchFromForward(forward: Vector3): number {
  return Math.asin(clamp(forward.y, -1, 1));
}

export function rollFromRight(right: Vector3): number {
  return Math.asin(clamp(-right.y, -1, 1));
}

/** Camera look offset; positive yaw looks left, positive pitch looks up. */
export function lookQuaternion(yaw: number, pitch: number, target = new Quaternion()): Quaternion {
  return target.setFromEuler(new Euler(pitch, yaw, 0, "YXZ"));
}

export function safeNormalize(v: Vector3, fallback = new Vector3(0, 0, -1)): Vector3 {
  const length = v.length();
  if (length < 1e-9) return fallback.clone();
  return v.multiplyScalar(1 / length);
}
