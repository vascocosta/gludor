import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
} from "three";
import { TOWNS } from "../config";
import { BUILDING_SCALE, forEachTownInBounds, type Building, type Town } from "../sim/towns";
import type { Terrain } from "../sim/terrain";

const WALL_CAPACITY = 3000;
const ROOF_CAPACITY = 3000;
const WINDOW_CAPACITY = 12000;
const SPIRE_CAPACITY = 96;

/** Plaster and stone for the walls. */
const WALL_COLORS = [0xe9e2d2, 0xded2bc, 0xf1ece1, 0xcdbfa6, 0xc2b39a, 0xdad4c6];
/** Terracotta, slate, and weathered tile for the roofs. */
const ROOF_COLORS = [0x8d4a31, 0x9c5a3d, 0x5d4a42, 0x6b7073, 0x7f4c36, 0x4f5356];

/** Gabled roof: one unit footprint, ridge along X, apex at y = 1. */
function gableGeometry(): BufferGeometry {
  const positions = new Float32Array([
    // +Z pitch
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0,
    -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    // -Z pitch
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0,
    0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    // gable ends
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
  ]);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Towns that follow the glider. Buildings are drawn with instanced meshes so
 * every wall, roof, window, and spire in the world costs four draw calls, and
 * the streets share one merged ribbon mesh. Rebuilds are spread over several
 * frames, and the previous town set stays visible until the new one is ready.
 */
export class TownField {
  readonly group = new Group();

  private readonly terrain: Terrain;
  private readonly walls: InstancedMesh;
  private readonly roofs: InstancedMesh;
  private readonly spires: InstancedMesh;
  private readonly windows: InstancedMesh;
  private readonly streetMesh: Mesh;
  private readonly dummy = new Object3D();
  private readonly color = new Color();

  private towns: Town[] = [];
  private buildIndex = 0;
  private wallCount = 0;
  private roofCount = 0;
  private windowCount = 0;
  private spireCount = 0;
  private streetPositions: number[] = [];
  private streetIndices: number[] = [];
  private buildX = 0;
  private buildZ = 0;

  private building = false;
  private lastBuildX = Number.POSITIVE_INFINITY;
  private lastBuildZ = Number.POSITIVE_INFINITY;

  constructor(terrain: Terrain, scene: Object3D) {
    this.terrain = terrain;

    const wallGeometry = new BoxGeometry(1, 1, 1);
    wallGeometry.translate(0, 0.5, 0);

    const spireGeometry = new ConeGeometry(0.68, 1, 4);
    spireGeometry.rotateY(Math.PI / 4);
    spireGeometry.translate(0, 0.5, 0);

    const wallMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0 });
    const roofMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0 });
    const spireMaterial = new MeshStandardMaterial({ color: 0x5f6d64, roughness: 0.55, metalness: 0.28 });
    const windowMaterial = new MeshStandardMaterial({ color: 0x27323b, roughness: 0.32, metalness: 0.12 });

    this.walls = new InstancedMesh(wallGeometry, wallMaterial, WALL_CAPACITY);
    this.roofs = new InstancedMesh(gableGeometry(), roofMaterial, ROOF_CAPACITY);
    this.spires = new InstancedMesh(spireGeometry, spireMaterial, SPIRE_CAPACITY);
    this.windows = new InstancedMesh(new PlaneGeometry(1, 1), windowMaterial, WINDOW_CAPACITY);

    for (const mesh of [this.walls, this.roofs, this.spires, this.windows]) {
      mesh.frustumCulled = false;
      mesh.count = 0;
    }
    for (const mesh of [this.walls, this.roofs, this.spires]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }

    this.streetMesh = new Mesh(
      new BufferGeometry(),
      new MeshStandardMaterial({
        color: 0x63665f,
        roughness: 0.97,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.streetMesh.receiveShadow = true;
    this.streetMesh.frustumCulled = false;

    this.group.add(this.walls, this.roofs, this.spires, this.windows, this.streetMesh);
    scene.add(this.group);
  }

  /** Rebuild the towns when the glider has moved, within a frame budget. */
  update(position: Vector3, budgetMs: number = 3): void {
    if (!this.building) {
      if (Math.hypot(position.x - this.lastBuildX, position.z - this.lastBuildZ) < TOWNS.rebuildDistance) {
        return;
      }
      this.startBuild(position.x, position.z);
    }

    const start = performance.now();
    while (this.buildIndex < this.towns.length) {
      this.addTown(this.towns[this.buildIndex++]);
      if (performance.now() - start >= budgetMs) break;
    }

    if (this.buildIndex >= this.towns.length) this.finishBuild();
  }

  private startBuild(cx: number, cz: number): void {
    this.building = true;
    this.lastBuildX = cx;
    this.lastBuildZ = cz;
    this.buildX = cx;
    this.buildZ = cz;
    this.buildIndex = 0;
    this.towns = [];
    this.wallCount = 0;
    this.roofCount = 0;
    this.windowCount = 0;
    this.spireCount = 0;
    this.streetPositions = [];
    this.streetIndices = [];

    const radius = TOWNS.renderRadius;
    forEachTownInBounds(cx - radius, cz - radius, cx + radius, cz + radius, (town) => {
      this.towns.push(town);
    });
  }

  private addTown(town: Town): void {
    for (const building of town.buildings) {
      this.addBuilding(building);
    }
    this.addStreets(town);
  }

  private addBuilding(building: Building): void {
    const dummy = this.dummy;

    // Walls extend two metres below the lowest corner so a sloped plot never
    // shows a gap under the building.
    if (this.wallCount < WALL_CAPACITY) {
      const depth = 2;
      dummy.position.set(building.x, building.ground - depth, building.z);
      dummy.rotation.set(0, building.yaw, 0);
      dummy.scale.set(building.width, building.wallHeight + depth, building.depth);
      dummy.updateMatrix();
      this.walls.setMatrixAt(this.wallCount, dummy.matrix);
      this.color.setHex(WALL_COLORS[Math.floor(building.tint * WALL_COLORS.length) % WALL_COLORS.length]);
      this.color.offsetHSL(0, 0, (building.tint - 0.5) * 0.05);
      this.walls.setColorAt(this.wallCount, this.color);
      this.wallCount++;
    }

    if (this.roofCount < ROOF_CAPACITY) {
      dummy.position.set(building.x, building.ground + building.wallHeight, building.z);
      dummy.rotation.set(0, building.yaw, 0);
      dummy.scale.set(building.width + 0.5, building.roofHeight, building.depth + 0.6);
      dummy.updateMatrix();
      this.roofs.setMatrixAt(this.roofCount, dummy.matrix);
      const roof = Math.floor((building.tint * 6.7 + 0.4) * 10) % ROOF_COLORS.length;
      this.color.setHex(ROOF_COLORS[roof]);
      this.color.offsetHSL(0, 0, (building.tint - 0.5) * 0.06);
      this.roofs.setColorAt(this.roofCount, this.color);
      this.roofCount++;
    }

    if (building.kind === "tower" && this.spireCount < SPIRE_CAPACITY) {
      dummy.position.set(building.x, building.ground + building.wallHeight + building.roofHeight, building.z);
      dummy.rotation.set(0, building.yaw, 0);
      dummy.scale.set(building.width, building.wallHeight * 0.34, building.depth);
      dummy.updateMatrix();
      this.spires.setMatrixAt(this.spireCount, dummy.matrix);
      this.spireCount++;
    }

    // Windows only earn their triangles when the town is close by.
    if (Math.hypot(building.x - this.buildX, building.z - this.buildZ) > TOWNS.windowRadius) return;
    if (building.kind === "tower") return;

    const cos = Math.cos(building.yaw);
    const sin = Math.sin(building.yaw);

    const addWindow = (lx: number, lz: number, yaw: number): boolean => {
      if (this.windowCount >= WINDOW_CAPACITY) return false;
      const x = building.x + lx * cos + lz * sin;
      const z = building.z - lx * sin + lz * cos;
      dummy.position.set(x, building.ground + building.wallHeight * 0.58, z);
      dummy.rotation.set(0, building.yaw + yaw, 0);
      dummy.scale.set(0.62 * BUILDING_SCALE, 0.86 * BUILDING_SCALE, 1);
      dummy.updateMatrix();
      this.windows.setMatrixAt(this.windowCount, dummy.matrix);
      this.windowCount++;
      return true;
    };

    for (const side of [1, -1]) {
      for (const along of [-0.24, 0.24]) {
        const lx = along * building.width;
        const lz = side * (building.depth / 2 + 0.04);
        if (!addWindow(lx, lz, side > 0 ? 0 : Math.PI)) return;
      }
      // One window in each gable end, so the ends are not blank walls.
      const end = side * (building.width / 2 + 0.04);
      if (!addWindow(end, 0, side > 0 ? Math.PI / 2 : -Math.PI / 2)) return;
    }
  }

  /** One quad ribbon per street, sampled along the ground. */
  private addStreets(town: Town): void {
    const cos = Math.cos(town.angle);
    const sin = Math.sin(town.angle);
    // [direction X, direction Z, length, lateral offset]
    const lanes: [number, number, number, number][] = [[cos, sin, town.streetLength, 0]];
    if (town.crossLength > 0) lanes.push([-sin, cos, town.crossLength, 0]);
    // Big towns get a parallel lane between the front and back rows.
    if (town.radius > 320) {
      const parallel = 20 * BUILDING_SCALE;
      lanes.push([cos, sin, town.streetLength, parallel], [cos, sin, town.streetLength, -parallel]);
    }

    for (const [dx, dz, length, offset] of lanes) {
      const px = -dz;
      const pz = dx;
      const steps = Math.max(2, Math.ceil(length / 8));
      const half = town.streetWidth / 2;
      let previous: { x: number; z: number; left: number; right: number } | null = null;

      for (let k = 0; k <= steps; k++) {
        const t = -length / 2 + (k / steps) * length;
        const x = town.x + dx * t + px * offset;
        const z = town.z + dz * t + pz * offset;
        const leftX = x - px * half;
        const leftZ = z - pz * half;
        const rightX = x + px * half;
        const rightZ = z + pz * half;
        const left = this.terrain.heightAt(leftX, leftZ);
        const right = this.terrain.heightAt(rightX, rightZ);
        const middle = this.terrain.heightAt(x, z);
        const water = this.terrain.waterLevelAt(x, z);
        if (water !== null && water > middle - 0.2) {
          previous = null;
          continue;
        }

        const current = { x, z, left, right };
        if (previous) this.addStreetQuad(previous, current, px, pz, half);
        previous = current;
      }
    }
  }

  private addStreetQuad(
    from: { x: number; z: number; left: number; right: number },
    to: { x: number; z: number; left: number; right: number },
    px: number,
    pz: number,
    half: number,
  ): void {
    const base = this.streetPositions.length / 3;
    const lift = 0.06;
    const corners = [
      [from.x - px * half, from.left + lift, from.z - pz * half],
      [from.x + px * half, from.right + lift, from.z + pz * half],
      [to.x + px * half, to.right + lift, to.z + pz * half],
      [to.x - px * half, to.left + lift, to.z - pz * half],
    ];
    for (const corner of corners) {
      this.streetPositions.push(corner[0], corner[1], corner[2]);
    }
    this.streetIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  private finishBuild(): void {
    this.walls.count = this.wallCount;
    this.roofs.count = this.roofCount;
    this.spires.count = this.spireCount;
    this.windows.count = this.windowCount;

    for (const mesh of [this.walls, this.roofs, this.spires, this.windows]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.streetPositions, 3));
    const normals = new Float32Array((this.streetPositions.length / 3) * 3);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
    geometry.setIndex(this.streetIndices);
    geometry.computeBoundingSphere();

    this.streetMesh.geometry.dispose();
    this.streetMesh.geometry = geometry;
    this.streetMesh.visible = this.streetIndices.length > 0;

    this.building = false;
    this.towns = [];
  }
}
