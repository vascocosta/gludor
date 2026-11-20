import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from "three";
import { STREAMING, WORLD } from "../config";
import { clamp } from "../core/math";
import { fbm2D, hash2, mulberry32 } from "../core/rng";
import type { Terrain } from "../sim/terrain";
import { insideTown } from "../sim/towns";

export function createBackdrop(scene: Object3D): Mesh {
  const mesh = new Mesh(
    new CircleGeometry(85000, 96),
    new MeshStandardMaterial({ color: 0x4b6540, roughness: 1, metalness: 0 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 260;
  scene.add(mesh);
  return mesh;
}

const TREE_CELL = 1000;
const TREE_RADIUS = STREAMING.treeRadius;
const TREE_CAPACITY = 42000;

interface TreePlacement {
  x: number;
  z: number;
  ground: number;
  height: number;
  width: number;
  yaw: number;
  tiltX: number;
  tiltZ: number;
  hue: number;
  saturation: number;
  lightness: number;
}

/**
 * Clustered woodland that follows the glider. Placement is derived from a
 * deterministic world-cell hash, so the same wood always contains the same
 * trees, whatever order tiles are visited in. Rebuilds are spread across
 * several frames and the old field stays visible until the new one is ready.
 */
export class TreeField {
  readonly group = new Group();

  private readonly terrain: Terrain;
  private readonly seed: number;
  private readonly lower: InstancedMesh;
  private readonly canopy: InstancedMesh;
  private readonly upper: InstancedMesh;
  private readonly trunks: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly placements: TreePlacement[] = [];
  private readonly cells: { i: number; j: number }[] = [];

  private buildIndex = 0;
  private building = false;
  private lastBuildX = Number.POSITIVE_INFINITY;
  private lastBuildZ = Number.POSITIVE_INFINITY;

  constructor(terrain: Terrain, scene: Object3D, seed = 1) {
    this.terrain = terrain;
    this.seed = seed;

    const canopyGeometry = new ConeGeometry(1, 1, 6);
    const upperGeometry = new ConeGeometry(1, 1, 6);
    const trunkGeometry = new CylinderGeometry(0.12, 0.18, 1, 5);
    const canopyMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
    const trunkMaterial = new MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 });

    this.lower = new InstancedMesh(canopyGeometry, canopyMaterial, TREE_CAPACITY);
    this.canopy = new InstancedMesh(canopyGeometry, canopyMaterial, TREE_CAPACITY);
    this.upper = new InstancedMesh(upperGeometry, canopyMaterial, TREE_CAPACITY);
    this.trunks = new InstancedMesh(trunkGeometry, trunkMaterial, TREE_CAPACITY);
    for (const mesh of [this.lower, this.canopy, this.upper, this.trunks]) {
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.count = 0;
    }

    this.group.add(this.lower, this.canopy, this.upper, this.trunks);
    scene.add(this.group);
  }

  /** Rebuild the wood when the glider has moved, within a frame budget. */
  update(position: Vector3, budgetMs: number = 3): void {
    if (!this.building) {
      if (Math.hypot(position.x - this.lastBuildX, position.z - this.lastBuildZ) < 750) return;
      this.startBuild(position.x, position.z);
    }

    const start = performance.now();
    while (this.buildIndex < this.cells.length) {
      const cell = this.cells[this.buildIndex++];
      this.buildCell(cell.i, cell.j);
      if (performance.now() - start >= budgetMs) break;
    }

    if (this.buildIndex >= this.cells.length) this.finishBuild();
  }

  private startBuild(cx: number, cz: number): void {
    this.building = true;
    this.lastBuildX = cx;
    this.lastBuildZ = cz;
    this.buildIndex = 0;
    this.placements.length = 0;
    this.cells.length = 0;

    const cell = TREE_CELL;
    const minI = Math.floor((cx - TREE_RADIUS) / cell) - 1;
    const maxI = Math.floor((cx + TREE_RADIUS) / cell) + 1;
    const minJ = Math.floor((cz - TREE_RADIUS) / cell) - 1;
    const maxJ = Math.floor((cz + TREE_RADIUS) / cell) + 1;

    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const centerX = (i + 0.5) * cell;
        const centerZ = (j + 0.5) * cell;
        if (Math.hypot(centerX - cx, centerZ - cz) > TREE_RADIUS + cell * 0.75) continue;
        this.cells.push({ i, j });
      }
    }
  }

  private buildCell(i: number, j: number): void {
    const rng = mulberry32(Math.floor(hash2(i, j, this.seed + 4242) * 4294967296));
    const cell = TREE_CELL;
    const originX = i * cell;
    const originZ = j * cell;

    // Each cell rolls for a main stand and, often, a smaller copse beside it.
    // Keeping the radius tight while raising the tree count makes the woods
    // read as dense canopy instead of scattered dots.
    const patch = (chance: number, radius: number, trees: number): void => {
      if (rng() >= chance) return;
      const cx = originX + rng() * cell;
      const cz = originZ + rng() * cell;
      if (Math.hypot(cx, cz) < 750) return;
      if (fbm2D(cx * 0.00072, cz * 0.00072, 3, this.seed + 61) < 0.4) return;
      const count = trees + Math.floor(rng() * trees * 0.66);
      for (let n = 0; n < count; n++) {
        const angle = rng() * Math.PI * 2;
        const distance = Math.sqrt(rng()) * radius;
        this.addTree(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance, rng);
      }
    };

    patch(0.55, 70 + rng() * 110, 120);
    patch(0.3, 40 + rng() * 50, 50);

    // A few scattered singles and hedgerow trees soften the woodland edges.
    const singles = 5 + Math.floor(rng() * 5);
    for (let n = 0; n < singles; n++) {
      const x = originX + rng() * cell;
      const z = originZ + rng() * cell;
      this.addTree(x, z, rng);
    }
  }

  private addTree(x: number, z: number, rng: () => number): void {
    if (this.placements.length >= TREE_CAPACITY) return;
    if (Math.hypot(x, z) < 500) return;
    // Towns are cleared ground: no trees through the roofs or the street.
    if (insideTown(x, z, 18)) return;

    const ground = this.terrain.heightAt(x, z);
    if (ground > 1000) return;
    // Lakes are bare water: no trunks standing in the shallows.
    const water = this.terrain.waterLevelAt(x, z);
    if (water !== null && ground < water + 0.6) return;
    const gradient = this.terrain.gradientAt(x, z, 35);
    if (Math.hypot(gradient.x, gradient.z) > 0.42) return;

    const height = 22 + rng() * 22;
    const width = 4.6 + rng() * 2.0;
    const yaw = rng() * Math.PI * 2;
    const tiltX = (rng() - 0.5) * 0.05;
    const tiltZ = (rng() - 0.5) * 0.05;
    const hue = 0.26 + rng() * 0.045;
    const saturation = 0.36 + rng() * 0.12;
    const lightness = 0.19 + rng() * 0.1;

    this.placements.push({
      x,
      z,
      ground,
      height,
      width,
      yaw,
      tiltX,
      tiltZ,
      hue,
      saturation,
      lightness,
    });
  }

  private finishBuild(): void {
    const count = this.placements.length;
    for (let n = 0; n < count; n++) {
      const tree = this.placements[n];
      const dummy = this.dummy;

      // Three overlapping canopy tiers, each rotated a little differently, so
      // the silhouette reads as a layered conifer rather than one clean cone.
      dummy.position.set(tree.x, tree.ground + tree.height * 0.44, tree.z);
      dummy.rotation.set(tree.tiltX, tree.yaw + 0.35, tree.tiltZ);
      dummy.scale.set(tree.width, tree.height * 0.52, tree.width);
      dummy.updateMatrix();
      this.lower.setMatrixAt(n, dummy.matrix);

      dummy.position.set(
        tree.x + tree.width * 0.045,
        tree.ground + tree.height * 0.64,
        tree.z - tree.width * 0.03,
      );
      dummy.rotation.set(tree.tiltX, tree.yaw, tree.tiltZ);
      dummy.scale.set(tree.width * 0.78, tree.height * 0.56, tree.width * 0.78);
      dummy.updateMatrix();
      this.canopy.setMatrixAt(n, dummy.matrix);

      dummy.position.set(
        tree.x - tree.width * 0.03,
        tree.ground + tree.height * 0.88,
        tree.z + tree.width * 0.04,
      );
      dummy.rotation.set(tree.tiltX, tree.yaw - 0.35, tree.tiltZ);
      dummy.scale.set(tree.width * 0.5, tree.height * 0.52, tree.width * 0.5);
      dummy.updateMatrix();
      this.upper.setMatrixAt(n, dummy.matrix);

      dummy.position.set(tree.x, tree.ground + tree.height * 0.2, tree.z);
      dummy.rotation.set(tree.tiltX, tree.yaw, tree.tiltZ);
      dummy.scale.set(1.6, tree.height * 0.4, 1.6);
      dummy.updateMatrix();
      this.trunks.setMatrixAt(n, dummy.matrix);

      this.color.setHSL(tree.hue, tree.saturation, tree.lightness);
      this.lower.setColorAt(n, this.color);
      this.color.offsetHSL(0, 0, 0.025);
      this.canopy.setColorAt(n, this.color);
      this.color.offsetHSL(0, 0, 0.03);
      this.upper.setColorAt(n, this.color);
    }

    this.lower.count = count;
    this.canopy.count = count;
    this.upper.count = count;
    this.trunks.count = count;
    this.lower.instanceMatrix.needsUpdate = true;
    this.canopy.instanceMatrix.needsUpdate = true;
    this.upper.instanceMatrix.needsUpdate = true;
    this.trunks.instanceMatrix.needsUpdate = true;
    if (this.lower.instanceColor) this.lower.instanceColor.needsUpdate = true;
    if (this.canopy.instanceColor) this.canopy.instanceColor.needsUpdate = true;
    if (this.upper.instanceColor) this.upper.instanceColor.needsUpdate = true;

    this.building = false;
    this.placements.length = 0;
    this.cells.length = 0;
  }
}

/** A muted, mown grass surface with lengthwise stripes. */
function createGrassStripTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");

  const bands = 8;
  for (let i = 0; i < bands; i++) {
    context.fillStyle = i % 2 === 0 ? "#5d7d45" : "#55743e";
    context.fillRect((i / bands) * canvas.width, 0, canvas.width / bands + 1, canvas.height);
  }

  const random = mulberry32(0x5eed1234);
  for (let i = 0; i < 600; i++) {
    context.fillStyle =
      random() < 0.5 ? "rgba(20, 35, 15, 0.10)" : "rgba(150, 180, 120, 0.08)";
    context.fillRect(random() * canvas.width, random() * canvas.height, 3, 2);
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.repeat.set(1, 5);
  texture.anisotropy = 4;
  return texture;
}

/** A white dash on a transparent tile, repeated along a grass runway edge. */
function createDashTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#e8e6dc";
  context.fillRect(2, 0, 12, 32);

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Painted runway designator, transparent outside the glyphs. */
function createRunwayNumberTexture(label: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#e8e6dc";
  context.font = "700 150px ui-sans-serif, system-ui, -apple-system, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 192, 136);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

const GRASS_RUNWAY = {
  x: -70,
  length: 1200,
  width: 30,
} as const;

export class Airfield {
  readonly group = new Group();
  readonly winch = new Group();
  private readonly sock = new Group();
  private readonly fieldY: number;

  constructor(terrain: Terrain) {
    this.fieldY = terrain.heightAt(0, 0);

    const asphalt = new MeshStandardMaterial({ color: 0x3d4248, roughness: 0.92, metalness: 0 });
    const white = new MeshStandardMaterial({ color: 0xe8e6dc, roughness: 0.8 });
    const orange = new MeshStandardMaterial({ color: 0xd8792f, roughness: 0.8 });

    const runway = new Mesh(new PlaneGeometry(WORLD.runwayWidth, WORLD.runwayLength), asphalt);
    runway.rotation.x = -Math.PI / 2;
    runway.position.set(0, this.fieldY + 0.06, 0);
    runway.receiveShadow = true;
    this.group.add(runway);

    const edgeGeometry = new PlaneGeometry(0.65, WORLD.runwayLength);
    for (const side of [-1, 1]) {
      const edge = new Mesh(edgeGeometry, white);
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(side * (WORLD.runwayWidth / 2 - 1.1), this.fieldY + 0.075, 0);
      edge.receiveShadow = true;
      this.group.add(edge);
    }

    const dashGeometry = new PlaneGeometry(0.7, 13);
    for (let z = -WORLD.runwayLength / 2 + 60; z < WORLD.runwayLength / 2 - 60; z += 85) {
      const dash = new Mesh(dashGeometry, white);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(0, this.fieldY + 0.08, z);
      this.group.add(dash);
    }

    const thresholdGeometry = new PlaneGeometry(2.2, 24);
    for (const end of [-1, 1]) {
      for (let i = -3; i <= 3; i++) {
        const bar = new Mesh(thresholdGeometry, white);
        bar.rotation.x = -Math.PI / 2;
        bar.position.set(i * 3.6, this.fieldY + 0.085, end * (WORLD.runwayLength / 2 - 30));
        this.group.add(bar);
      }
    }

    // Grass runway, shorter and to the left of the asphalt strip.
    const grassMaterial = new MeshStandardMaterial({
      map: createGrassStripTexture(),
      roughness: 1,
      metalness: 0,
    });
    const grassStrip = new Mesh(
      new PlaneGeometry(GRASS_RUNWAY.width, GRASS_RUNWAY.length),
      grassMaterial,
    );
    grassStrip.rotation.x = -Math.PI / 2;
    grassStrip.position.set(GRASS_RUNWAY.x, this.fieldY + 0.05, 0);
    grassStrip.receiveShadow = true;
    this.group.add(grassStrip);

    const dashTexture = createDashTexture();
    dashTexture.repeat.set(1, GRASS_RUNWAY.length / 20);
    const dashMaterial = new MeshStandardMaterial({
      map: dashTexture,
      transparent: true,
      alphaTest: 0.4,
      roughness: 0.8,
    });
    const edgeDashGeometry = new PlaneGeometry(0.6, GRASS_RUNWAY.length);
    for (const side of [-1, 1]) {
      const edge = new Mesh(edgeDashGeometry, dashMaterial);
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(
        GRASS_RUNWAY.x + side * (GRASS_RUNWAY.width / 2),
        this.fieldY + 0.065,
        0,
      );
      this.group.add(edge);
    }

    // Short dashes close the outline across the grass thresholds.
    const endDashGeometry = new PlaneGeometry(2, 0.6);
    for (const end of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const dash = new Mesh(endDashGeometry, white);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(
          GRASS_RUNWAY.x - GRASS_RUNWAY.width / 2 + 2.5 + i * 5,
          this.fieldY + 0.065,
          end * (GRASS_RUNWAY.length / 2 - 0.5),
        );
        this.group.add(dash);
      }
    }

    const addRunwayNumber = (
      label: string,
      x: number,
      z: number,
      width: number,
      height: number,
      reverse: boolean,
      y: number,
    ): void => {
      const material = new MeshStandardMaterial({
        map: createRunwayNumberTexture(label),
        transparent: true,
        alphaTest: 0.4,
        roughness: 0.8,
      });
      const number = new Mesh(new PlaneGeometry(width, height), material);
      number.rotation.x = -Math.PI / 2;
      if (reverse) number.rotation.z = Math.PI;
      number.position.set(x, y, z);
      number.receiveShadow = true;
      this.group.add(number);
    };

    // Parallel strips: the asphalt is right of the grass when heading north.
    addRunwayNumber("36R", 0, 925, 36, 24, false, this.fieldY + 0.095);
    addRunwayNumber("18L", 0, -925, 36, 24, true, this.fieldY + 0.095);
    addRunwayNumber("36L", GRASS_RUNWAY.x, 520, 32, 21.33, false, this.fieldY + 0.075);
    addRunwayNumber("18R", GRASS_RUNWAY.x, -520, 32, 21.33, true, this.fieldY + 0.075);

    const hangarMaterial = new MeshStandardMaterial({ color: 0x9a9b93, roughness: 0.85 });
    const roofMaterial = new MeshStandardMaterial({ color: 0x5b5f62, roughness: 0.9 });
    for (let i = 0; i < 2; i++) {
      const hangar = new Mesh(new BoxGeometry(26, 8, 19), hangarMaterial);
      hangar.position.set(140 + i * 32, this.fieldY + 4, 610);
      hangar.castShadow = true;
      hangar.receiveShadow = true;
      this.group.add(hangar);

      const roof = new Mesh(new BoxGeometry(27.5, 0.8, 20.5), roofMaterial);
      roof.position.set(140 + i * 32, this.fieldY + 8.4, 610);
      this.group.add(roof);

      const door = new Mesh(new PlaneGeometry(18, 6), roofMaterial);
      door.position.set(140 + i * 32, this.fieldY + 3.2, 610 - 9.55);
      this.group.add(door);
    }

    const pole = new Mesh(new CylinderGeometry(0.11, 0.14, 7, 8), white);
    pole.position.set(82, this.fieldY + 3.5, 870);
    this.group.add(pole);

    this.sock.position.set(82, this.fieldY + 7.1, 870);
    const sockCone = new Mesh(new ConeGeometry(0.48, 3, 10, 1, true), orange);
    sockCone.rotation.x = Math.PI / 2;
    sockCone.position.z = 1.5;
    sockCone.material.side = DoubleSide;
    this.sock.add(sockCone);
    const stripe = new Mesh(new ConeGeometry(0.36, 0.7, 10, 1, true), white);
    stripe.rotation.x = Math.PI / 2;
    stripe.position.z = 2.1;
    stripe.material.side = DoubleSide;
    this.sock.add(stripe);
    this.group.add(this.sock);

    this.winch.position.set(0, terrain.heightAt(0, WORLD.winchZ) + 1.2, WORLD.winchZ);
    const trailer = new Mesh(new BoxGeometry(3.1, 1.2, 1.9), orange);
    trailer.position.y = 0.4;
    trailer.castShadow = true;
    this.winch.add(trailer);
    const drum = new Mesh(new CylinderGeometry(0.8, 0.8, 2.2, 12), roofMaterial);
    drum.rotation.z = Math.PI / 2;
    drum.position.y = 0.95;
    this.winch.add(drum);
    this.group.add(this.winch);
  }

  update(wind: Vector3): void {
    const speed = Math.hypot(wind.x, wind.z);
    this.sock.rotation.y = Math.atan2(wind.x, wind.z);
    this.sock.rotation.x = 0.05 + clamp(1 - speed / 9, 0, 1) * 0.65;
  }
}
