import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { BodyAxes, quatFromHeadingPitchRoll } from "../src/core/math";
import { GLIDER } from "../src/config";
import { liftCoefficient } from "../src/sim/aero";

describe("core geometry", () => {
  it("maps heading to the expected world direction", () => {
    const q = quatFromHeadingPitchRoll(90, 0, 0);
    const axes = new BodyAxes().fromQuaternion(q);
    expect(axes.forward.x).toBeCloseTo(1, 3);
    expect(Math.abs(axes.forward.z)).toBeLessThan(1e-3);
  });

  it("keeps body axes right-handed", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0.2, 0.9, 0.3).normalize(), 0.9);
    const axes = new BodyAxes().fromQuaternion(q);
    const cross = new Vector3().copy(axes.forward).cross(axes.right);
    expect(cross.x).toBeCloseTo(axes.down.x, 6);
    expect(cross.y).toBeCloseTo(axes.down.y, 6);
    expect(cross.z).toBeCloseTo(axes.down.z, 6);
  });

  it("positive pitch raises the nose and positive roll drops the right wing", () => {
    const pitch = new BodyAxes().fromQuaternion(quatFromHeadingPitchRoll(0, 0.3, 0));
    expect(pitch.forward.y).toBeGreaterThan(0.2);

    const roll = new BodyAxes().fromQuaternion(quatFromHeadingPitchRoll(0, 0, 0.4));
    expect(roll.right.y).toBeLessThan(-0.3);
  });
});

describe("lift curve", () => {
  it("peaks at the stall and drops afterwards", () => {
    const peak = liftCoefficient(GLIDER.alphaStall, GLIDER);
    const post = liftCoefficient(GLIDER.alphaStall + 0.25, GLIDER);
    expect(peak).toBeCloseTo(GLIDER.clMax, 2);
    expect(post).toBeLessThan(peak);
    expect(post).toBeGreaterThan(0.5 * peak);
  });

  it("is linear through the normal flying range", () => {
    const a = liftCoefficient(0.05, GLIDER);
    const b = liftCoefficient(0.15, GLIDER);
    expect(b - a).toBeCloseTo(GLIDER.clAlpha * 0.1, 4);
  });
});
