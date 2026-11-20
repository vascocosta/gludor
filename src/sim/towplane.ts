import { Quaternion, Vector3 } from "three";
import { GRAVITY, TOW } from "../config";
import { RAD, clamp, quatFromHeadingPitchRoll } from "../core/math";
import type { Terrain } from "./terrain";

export type TowPhase = "roll" | "climb" | "depart" | "gone";

/**
 * The aerotow tug. It is deliberately not a second flight model: it rolls,
 * rotates, and then climbs a gentle left-hand turn over the field on rails.
 * That keeps the departure deterministic, cheap, and easy to test, while the
 * glider remains a real 6DOF body on the other end of the rope.
 */
export class TowPlane {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly hook = new Vector3();
  readonly orientation = new Quaternion();

  heading = 0;
  pitch = 0;
  roll = 0;
  speed = 0;
  propAngle = 0;
  visible = false;
  phase: TowPhase = "gone";

  private agl = 0;
  private elapsed = 0;
  private verticalSpeed = 0;
  private turnAngle = 0;
  private turnStartZ = 0;
  private departElapsed = 0;
  private fieldElevation = 0;
  private readonly previous = new Vector3();
  private readonly localHook = new Vector3(0, TOW.hookY, TOW.hookZ);

  constructor(private readonly terrain: Terrain) {
    this.reset();
  }

  reset(): void {
    this.phase = "gone";
    this.visible = false;
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;
    this.speed = 0;
    this.propAngle = 0;
    this.agl = 0;
    this.elapsed = 0;
    this.verticalSpeed = 0;
    this.turnAngle = 0;
    this.turnStartZ = TOW.startZ;
    this.departElapsed = 0;
    this.fieldElevation = this.terrain.heightAt(0, 0);
    this.position.set(
      0,
      this.terrain.heightAt(0, TOW.startZ) + TOW.wheelHeight,
      TOW.startZ,
    );
    this.velocity.set(0, 0, 0);
    this.orientation.identity();
    this.updateHook();
  }

  /** Place the tug at the runway threshold and make it visible. */
  launch(): void {
    this.reset();
    this.phase = "roll";
    this.visible = true;
  }

  /** Remove the tug entirely, e.g. when the flight ends. */
  hide(): void {
    this.phase = "gone";
    this.visible = false;
    this.speed = 0;
  }

  /** Cut the rope: the tug keeps flying and then leaves the scene. */
  release(): void {
    if (this.phase === "depart" || this.phase === "gone") return;
    this.phase = "depart";
    this.departElapsed = 0;
  }

  update(dt: number, windX = 0, windZ = 0): void {
    if (!this.visible || this.phase === "gone" || dt <= 0) return;

    this.elapsed += dt;
    this.previous.copy(this.position);
    this.propAngle += dt * (12 + this.speed * 1.8);

    if (this.phase === "roll") {
      this.speed = Math.min(TOW.liftOffSpeed, this.speed + TOW.groundAccel * dt);
      // Roll at a constant airspeed, so a tailwind means a faster ground run
      // and a headwind a shorter one. The glider on the rope sees the same
      // airspeed, which is what lets it rotate at the right moment.
      const windAlong = -windZ;
      this.position.x = 0;
      this.position.z -= (this.speed + windAlong) * dt;
      this.position.y = this.terrain.heightAt(0, this.position.z) + TOW.wheelHeight;
      this.agl = 0;
      this.verticalSpeed = 0;
      this.heading = 0;
      this.pitch = 0;
      this.roll = 0;

      if (this.speed >= TOW.liftOffSpeed) {
        this.phase = "climb";
        this.agl = this.position.y - this.fieldElevation;
      }
    } else {
      if (this.phase === "depart") {
        this.departElapsed += dt;
        if (this.departElapsed >= TOW.departTime) {
          this.hide();
          return;
        }
      }

      const turning = this.turnAngle > 0 || this.agl >= TOW.turnEntryAgl;
      const targetVertical =
        this.phase === "depart"
          ? this.departElapsed < 8
            ? TOW.climbSpeed * 0.5
            : 0
          : this.agl < TOW.targetAgl
            ? TOW.climbSpeed
            : 0;
      // Ease the vertical speed so rotation and level-off stay smooth.
      this.verticalSpeed +=
        (targetVertical - this.verticalSpeed) * (1 - Math.exp(-dt / 1.6));
      this.agl = Math.min(
        TOW.targetAgl + (this.phase === "depart" ? 120 : 0),
        this.agl + this.verticalSpeed * dt,
      );

      const horizontal = this.phase === "depart" ? TOW.cruiseSpeed + 3 : TOW.cruiseSpeed;
      // Fly at a constant airspeed and let the ground track speed up or slow
      // down with the wind, like a real tug. This keeps the rope tension even
      // on windy days instead of stretching and snatching around the turn.
      let dirX = 0;
      let dirZ = -1;
      if (turning) {
        dirX = -Math.sin(this.turnAngle);
        dirZ = -Math.cos(this.turnAngle);
      }
      const windAlong = windX * dirX + windZ * dirZ;
      const groundSpeed = clamp(
        horizontal + windAlong,
        horizontal * 0.45,
        horizontal * 1.8,
      );
      this.speed = groundSpeed;

      if (!turning) {
        this.position.x = 0;
        this.position.z -= groundSpeed * dt;
        this.turnStartZ = this.position.z;
        if (this.agl >= TOW.turnEntryAgl) {
          // Enter the turn tangentially: the circle centre sits one radius to
          // the left of the runway heading.
          this.turnAngle = 1e-4;
          this.turnStartZ = this.position.z;
        }
      } else {
        if (this.turnAngle === 0) {
          this.turnAngle = 1e-4;
          this.turnStartZ = this.position.z;
        }
        const radius = TOW.turnRadius;
        this.turnAngle += (groundSpeed * dt) / radius;
        this.position.x = -radius + radius * Math.cos(this.turnAngle);
        this.position.z = this.turnStartZ - radius * Math.sin(this.turnAngle);
      }

      this.position.y = this.fieldElevation + this.agl;
      const bank = Math.atan((horizontal * horizontal) / (TOW.turnRadius * GRAVITY));
      this.roll = turning ? -bank : 0;
      this.heading = turning ? -this.turnAngle * RAD : 0;
      this.pitch = Math.atan2(this.verticalSpeed, Math.max(8, horizontal));
    }

    quatFromHeadingPitchRoll(this.heading, this.pitch, this.roll, this.orientation);
    this.updateHook();
    this.velocity.set(
      (this.position.x - this.previous.x) / dt,
      (this.position.y - this.previous.y) / dt,
      (this.position.z - this.previous.z) / dt,
    );
  }

  private updateHook(): void {
    this.hook
      .copy(this.localHook)
      .applyQuaternion(this.orientation)
      .add(this.position);
  }
}
