import {
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Object3D,
} from "three";
import { DEG } from "../core/math";
import {
  AIRFIELD,
  airfieldHeightAt,
  forEachAirfieldInBounds,
  type AirfieldSpec,
} from "../sim/airfields";
import type { CloudShadows } from "./cloudShadows";
import { createGrassStripTexture } from "./props";

/** Strips are small and sparse; a 20 km window is generous and cheap. */
const VIEW_RADIUS = 20_000;
const REBUILD_DISTANCE = 2_000;
/** Grass laid just above the graded pad, clear of the terrain triangles. */
const STRIP_OFFSET = 0.3;
const MARKING_OFFSET = 0.38;

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
  private readonly stripMaterial: MeshStandardMaterial;
  private readonly markingMaterial: MeshStandardMaterial;
  private readonly poleMaterial: MeshStandardMaterial;
  private readonly sockMaterial: MeshStandardMaterial;
  private readonly sockStripeMaterial: MeshStandardMaterial;
  private readonly shedMaterial: MeshStandardMaterial;
  private readonly roofMaterial: MeshStandardMaterial;
  private lastX = Number.POSITIVE_INFINITY;
  private lastZ = Number.POSITIVE_INFINITY;

  constructor(scene: Object3D, cloudShadows: CloudShadows) {
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

  private buildField(field: AirfieldSpec): Group {
    const group = new Group();
    const along = field.length;
    const heading = field.heading * DEG;
    const fx = Math.sin(heading);
    const fz = -Math.cos(heading);
    const rx = Math.cos(heading);
    const rz = Math.sin(heading);

    // Mown ribbon, sampled along the graded profile. A short overrun at each
    // end keeps the edge off the threshold bars.
    const start = -along / 2 - 8;
    const end = along / 2 + 8;
    const steps = Math.max(8, Math.ceil((end - start) / 18));
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const halfWidth = field.width / 2;

    for (let k = 0; k <= steps; k++) {
      const s = start + ((end - start) * k) / steps;
      const x = field.x + fx * s;
      const z = field.z + fz * s;
      const y = airfieldHeightAt(field, s) + STRIP_OFFSET;
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
      const barY = airfieldHeightAt(field, s) + MARKING_OFFSET;
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
    const shedY = airfieldHeightAt(field, shedAlong);
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
    const poleY = airfieldHeightAt(field, poleAlong);
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
