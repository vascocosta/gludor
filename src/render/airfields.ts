import {
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Object3D,
} from "three";
import { WORLD } from "../config";
import { DEG, lerp, smoothstep } from "../core/math";
import {
  AIRFIELD,
  forEachAirfieldInBounds,
  type AirfieldSpec,
} from "../sim/airfields";
import { terrainHeightAt } from "../sim/terrain";
import type { CloudShadows } from "./cloudShadows";
import { createGrassStripTexture } from "./props";
import { terrainColorAt } from "./terrainMesh";

/** Strips are small and sparse; a 20 km window is generous and cheap. */
const VIEW_RADIUS = 20_000;
const REBUILD_DISTANCE = 2_000;
/**
 * The near terrain tier is cut out under each pad. Its quads are 50 m, so the
 * hole can reach roughly 146 m past the pad; this patch overlaps it by another
 * ~44 m and follows the analytic surface, matching the surrounding ground.
 */
const PAD_MARGIN = 190;
/** Patch sampling. Even across-steps keep a grid line on the runway centre. */
const PAD_SAMPLE = 24;
const PAD_LIFT = 0.04;
/** Mown ribbon and markings laid just above the exact pad patch. */
const STRIP_OFFSET = 0.08;
const MARKING_OFFSET = 0.12;
/** A faint mown tint on the graded shoulders, blended out into the meadow. */
const MOWN = new Color(0x68854a);

interface PadSurface {
  mesh: Mesh;
  /** Along-runway coordinates of the patch grid. */
  alongs: number[];
  /** Patch height, including its lift, at an along-runway coordinate. */
  heightAt(along: number): number;
}

/**
 * Streamed grass strips beside towns. Each field is a small group: a mown
 * ribbon that follows the long profile, threshold bars, a windsock and a
 * shed. Fields are deterministic and cached by cell, so they pop in without
 * seams as the glider travels.
 */
export class AirfieldField {
  readonly group = new Group();

  private readonly fields = new Map<string, Group>();
  private readonly socks = new Map<string, Group>();
  private readonly terrainMaterial: MeshStandardMaterial;
  private readonly stripMaterial: MeshStandardMaterial;
  private readonly markingMaterial: MeshStandardMaterial;
  private readonly poleMaterial: MeshStandardMaterial;
  private readonly sockMaterial: MeshStandardMaterial;
  private readonly sockStripeMaterial: MeshStandardMaterial;
  private readonly shedMaterial: MeshStandardMaterial;
  private readonly roofMaterial: MeshStandardMaterial;
  private lastX = Number.POSITIVE_INFINITY;
  private lastZ = Number.POSITIVE_INFINITY;

  constructor(
    scene: Object3D,
    cloudShadows: CloudShadows,
    terrainMaterial: MeshStandardMaterial,
  ) {
    this.terrainMaterial = terrainMaterial;
    this.stripMaterial = new MeshStandardMaterial({
      map: createGrassStripTexture(),
      roughness: 1,
      metalness: 0,
      side: DoubleSide,
    });
    this.markingMaterial = new MeshStandardMaterial({
      color: 0xe8e6dc,
      roughness: 0.85,
      side: DoubleSide,
    });
    this.poleMaterial = new MeshStandardMaterial({ color: 0xe8e6dc, roughness: 0.8 });
    this.sockMaterial = new MeshStandardMaterial({
      color: 0xd8792f,
      roughness: 0.8,
      side: DoubleSide,
    });
    this.sockStripeMaterial = new MeshStandardMaterial({
      color: 0xe8e6dc,
      roughness: 0.8,
      side: DoubleSide,
    });
    this.shedMaterial = new MeshStandardMaterial({ color: 0x9a9b93, roughness: 0.85 });
    this.roofMaterial = new MeshStandardMaterial({ color: 0x5b5f62, roughness: 0.9 });

    for (const material of [
      this.stripMaterial,
      this.markingMaterial,
      this.poleMaterial,
      this.sockMaterial,
      this.sockStripeMaterial,
      this.shedMaterial,
      this.roofMaterial,
    ]) {
      cloudShadows.apply(material);
    }

    scene.add(this.group);
  }

  /** Stream the strips around the camera and keep the windsocks honest. */
  update(position: Vector3, wind: Vector3): void {
    const speed = Math.hypot(wind.x, wind.z);
    for (const sock of this.socks.values()) {
      sock.rotation.y = Math.atan2(wind.x, wind.z);
      sock.rotation.x = 0.05 + Math.max(0, Math.min(1, 1 - speed / 9)) * 0.65;
    }

    if (
      Math.hypot(position.x - this.lastX, position.z - this.lastZ) < REBUILD_DISTANCE
    ) {
      return;
    }
    this.lastX = position.x;
    this.lastZ = position.z;

    const wanted = new Set<string>();
    forEachAirfieldInBounds(
      position.x - VIEW_RADIUS,
      position.z - VIEW_RADIUS,
      position.x + VIEW_RADIUS,
      position.z + VIEW_RADIUS,
      (field) => {
        wanted.add(field.id);
        if (this.fields.has(field.id)) return;
        const group = this.buildField(field);
        this.fields.set(field.id, group);
        this.group.add(group);
      },
    );

    for (const [id, group] of this.fields) {
      if (wanted.has(id)) continue;
      this.group.remove(group);
      this.disposeGroup(group);
      this.fields.delete(id);
      this.socks.delete(id);
    }
  }

  /**
   * The ground under the strip. The near terrain tier is cut away around every
   * pad and this mesh fills the hole. Its along-runway grid includes every
   * profile kink, so the runway is reproduced exactly; the coarse terrain can
   * no longer bridge the pad and poke through the mown ribbon.
   */
  private buildPad(field: AirfieldSpec): PadSurface {
    const heading = field.heading * DEG;
    const fx = Math.sin(heading);
    const fz = -Math.cos(heading);
    const rx = Math.cos(heading);
    const rz = Math.sin(heading);
    const halfWidth = AIRFIELD.padWidth / 2 + PAD_MARGIN;
    const halfLength = field.length / 2 + AIRFIELD.padExtension + PAD_MARGIN;

    let acrossCells = Math.ceil((halfWidth * 2) / PAD_SAMPLE);
    if (acrossCells % 2 !== 0) acrossCells++;
    const acrossStep = (halfWidth * 2) / acrossCells;
    const row = acrossCells + 1;

    // Coarse samples fill the apron; the profile's own knots are added so the
    // runway (which lies inside the profile) is reproduced exactly.
    const alongSet = new Set<number>();
    const coarseAlong = Math.max(1, Math.ceil((halfLength * 2) / PAD_SAMPLE));
    for (let j = 0; j <= coarseAlong; j++) {
      alongSet.add(-halfLength + (j / coarseAlong) * halfLength * 2);
    }
    for (let k = 0; k < field.profile.length; k++) {
      const along = field.profileStart + k * field.profileStep;
      if (along > -halfLength + 0.5 && along < halfLength - 0.5) alongSet.add(along);
    }
    const alongs = [...alongSet].sort((a, b) => a - b);
    const alongCells = alongs.length - 1;

    // A tiny per-field lift keeps overlapping pads from sharing a depth plane.
    const lift =
      PAD_LIFT + (Math.sin(field.x * 0.00043 + field.z * 0.00071) * 0.5 + 0.5) * 0.03;

    const positions = new Float32Array(alongs.length * row * 3);
    let p = 0;
    for (let j = 0; j < alongs.length; j++) {
      const along = alongs[j];
      for (let i = 0; i <= acrossCells; i++) {
        const across = -halfWidth + i * acrossStep;
        const x = field.x + fx * along + rx * across;
        const z = field.z + fz * along + rz * across;
        positions[p++] = x;
        positions[p++] = terrainHeightAt(x, z, WORLD) + lift;
        positions[p++] = z;
      }
    }

    const indices: number[] = [];
    for (let j = 0; j < alongCells; j++) {
      for (let i = 0; i < acrossCells; i++) {
        const a = j * row + i;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const normals = geometry.getAttribute("normal");
    const colors = new Float32Array(positions.length);
    for (let v = 0; v < positions.length / 3; v++) {
      const i = v % row;
      const j = (v - i) / row;
      const along = alongs[j];
      const across = -halfWidth + i * acrossStep;
      const x = positions[v * 3];
      const y = positions[v * 3 + 1];
      const z = positions[v * 3 + 2];
      const color = terrainColorAt(x, z, y, 1 - normals.getY(v), WORLD.seed);
      const outside = Math.max(
        Math.abs(along) - (field.length / 2 + AIRFIELD.padExtension),
        Math.abs(across) - AIRFIELD.padWidth / 2,
      );
      color.lerp(MOWN, (1 - smoothstep(0, 18, outside)) * 0.22);
      colors[v * 3] = color.r;
      colors[v * 3 + 1] = color.g;
      colors[v * 3 + 2] = color.b;
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));

    const pad = new Mesh(geometry, this.terrainMaterial);
    pad.name = "airfield-pad";
    pad.receiveShadow = true;
    pad.castShadow = false;

    // The centre column is the runway surface; both the ribbon and the props
    // ride on this, so the pad can never cross them.
    const centre = new Float32Array(alongs.length);
    const middle = acrossCells / 2;
    for (let j = 0; j < alongs.length; j++) {
      centre[j] = positions[(j * row + middle) * 3 + 1];
    }
    const heightAt = (along: number): number => {
      if (along <= alongs[0]) return centre[0];
      if (along >= alongs[alongs.length - 1]) return centre[centre.length - 1];
      let lo = 0;
      let hi = alongs.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (alongs[mid] <= along) lo = mid;
        else hi = mid;
      }
      return lerp(centre[lo], centre[hi], (along - alongs[lo]) / (alongs[hi] - alongs[lo]));
    };

    return { mesh: pad, alongs, heightAt };
  }

  private buildField(field: AirfieldSpec): Group {
    const group = new Group();
    const along = field.length;
    const heading = field.heading * DEG;
    const fx = Math.sin(heading);
    const fz = -Math.cos(heading);
    const rx = Math.cos(heading);
    const rz = Math.sin(heading);

    // The high-resolution pad fills the hole cut in the near terrain tier.
    const pad = this.buildPad(field);
    group.add(pad.mesh);

    // Mown ribbon, sampled on the pad's own along grid so the two surfaces are
    // separated by a constant small lift. A short overrun at each end keeps the
    // edge off the threshold bars.
    const start = -along / 2 - 8;
    const end = along / 2 + 8;
    const samples = [
      start,
      ...pad.alongs.filter((a) => a > start + 0.01 && a < end - 0.01),
      end,
    ];
    const steps = samples.length - 1;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const halfWidth = field.width / 2;

    for (let k = 0; k < samples.length; k++) {
      const s = samples[k];
      const x = field.x + fx * s;
      const z = field.z + fz * s;
      const y = pad.heightAt(s) + STRIP_OFFSET;
      positions.push(x - rx * halfWidth, y, z - rz * halfWidth);
      positions.push(x + rx * halfWidth, y, z + rz * halfWidth);
      const v = k / steps;
      uvs.push(0, v, 1, v);

      if (k < steps) {
        const a = k * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const ribbon = new Mesh(geometry, this.stripMaterial);
    ribbon.receiveShadow = true;
    group.add(ribbon);

    // Threshold bars: five white stripes at each end, kept clear of the
    // numbers a licensed strip would carry. One merged mesh keeps the strips
    // cheap to draw however many are in view.
    const barPositions: number[] = [];
    const barIndices: number[] = [];
    for (const endSign of [-1, 1]) {
      const s = endSign * (along / 2 - 12);
      for (let i = 0; i < 5; i++) {
        const across = -8 + i * 4;
        const cx = field.x + fx * s + rx * across;
        const cz = field.z + fz * s + rz * across;
        const base = barPositions.length / 3;
        for (const [du, dv] of [
          [-1.05, 5],
          [1.05, 5],
          [1.05, -5],
          [-1.05, -5],
        ]) {
          const barY = pad.heightAt(s + dv) + MARKING_OFFSET;
          barPositions.push(cx + rx * du + fx * dv, barY, cz + rz * du + fz * dv);
        }
        barIndices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
    const barGeometry = new BufferGeometry();
    barGeometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(barPositions), 3),
    );
    barGeometry.setIndex(barIndices);
    barGeometry.computeVertexNormals();
    const bars = new Mesh(barGeometry, this.markingMaterial);
    bars.receiveShadow = true;
    group.add(bars);

    // A small equipment shed on the shoulder.
    const shedAlong = 0;
    const shedAcross = AIRFIELD.padWidth / 2 - 9;
    const shedX = field.x + fx * shedAlong + rx * shedAcross;
    const shedZ = field.z + fz * shedAlong + rz * shedAcross;
    const shedY = pad.heightAt(shedAlong);
    const shed = new Mesh(new BoxGeometry(8, 3.2, 5.5), this.shedMaterial);
    shed.rotation.y = heading;
    shed.position.set(shedX, shedY + 1.6, shedZ);
    shed.castShadow = true;
    shed.receiveShadow = true;
    group.add(shed);
    const roof = new Mesh(new BoxGeometry(8.6, 0.35, 6.1), this.roofMaterial);
    roof.rotation.y = heading;
    roof.position.set(shedX, shedY + 3.4, shedZ);
    group.add(roof);

    // Windsock beside the upwind threshold. Its yaw is updated every frame.
    const sockGroup = new Group();
    const poleAlong = along / 2 - 26;
    const poleAcross = -AIRFIELD.padWidth / 2 + 9;
    const poleX = field.x + fx * poleAlong + rx * poleAcross;
    const poleZ = field.z + fz * poleAlong + rz * poleAcross;
    const poleY = pad.heightAt(poleAlong);
    const pole = new Mesh(new CylinderGeometry(0.11, 0.14, 6, 8), this.poleMaterial);
    pole.position.set(poleX, poleY + 3, poleZ);
    group.add(pole);

    sockGroup.rotation.order = "YXZ";
    sockGroup.position.set(poleX, poleY + 6.1, poleZ);
    const cone = new Mesh(new ConeGeometry(0.48, 3, 10, 1, true), this.sockMaterial);
    cone.rotation.x = Math.PI / 2;
    cone.position.z = 1.5;
    sockGroup.add(cone);
    const stripe = new Mesh(new ConeGeometry(0.36, 0.7, 10, 1, true), this.sockStripeMaterial);
    stripe.rotation.x = Math.PI / 2;
    stripe.position.z = 2.1;
    sockGroup.add(stripe);
    group.add(sockGroup);
    this.socks.set(field.id, sockGroup);

    return group;
  }

  private disposeGroup(group: Group): void {
    group.traverse((child) => {
      if (child instanceof Mesh) {
        child.geometry.dispose();
      }
    });
  }
}
