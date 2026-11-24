import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  Object3D,
  RepeatWrapping,
  Vector3,
} from "three";
import { RIVERS, STREAMING, WORLD } from "../config";
import { smoothstep } from "../core/math";
import { fbm2D, hash2, periodicFbm2D, valueNoise2D } from "../core/rng";
import {
  AIRFIELD,
  forEachAirfieldInBounds,
  insideAirfieldPad,
  type AirfieldSpec,
} from "../sim/airfields";
import { terrainHeightAt, forEachRiverInBounds } from "../sim/terrain";
import type { CloudShadows } from "./cloudShadows";

// Three overlapping LOD tiers. Each tier is a stable global tile grid, so
// flying only adds and removes tiles at the edge of the window. Coarser tiers
// are built slightly below the finer ones and extend underneath them, which
// hides both LOD cracks and the brief moments while new edge tiles generate.
const TIERS = [
  { size: STREAMING.nearTileSize, spacing: STREAMING.nearSpacing, drop: 0 },
  { size: STREAMING.midTileSize, spacing: STREAMING.midSpacing, drop: 2.5 },
  { size: STREAMING.farTileSize, spacing: STREAMING.farSpacing, drop: 7 },
] as const;

// Five tiles each side is enough that the finest tier reaches at least 8 km
// from the camera, the mid tier at least 16 km, and the far tier at least
// 32 km, wherever the camera sits inside its current tile.
const TILES_EACH_SIDE = 2;

/** Cut terrain cells that touch the stream bank corridor. */
const RIVER_HOLE_MARGIN = 8;

// Field and pasture colours stay muted; the sky and cloud shadows supply most
// of the scene's contrast.
const grassLow = new Color(0x4c6b3f);
const grass = new Color(0x63814a);
const dryGrass = new Color(0x858b58);
const high = new Color(0x878574);
const rock = new Color(0x706b61);
const airfield = new Color(0x5f8549);

const fields = [
  new Color(0x6b874d),
  new Color(0x768f52),
  new Color(0x829758),
  new Color(0x8f9a60),
  new Color(0x7c8d4e),
  new Color(0x939362),
  new Color(0x71874b),
  new Color(0x89875a),
  new Color(0x8a7749),
  new Color(0xa09a68),
];
const fieldScratch = new Color();

const colorScratch = new Color();
const normalScratch = new Vector3();

interface TileSpec {
  tier: number;
  ix: number;
  iz: number;
  size: number;
  spacing: number;
  drop: number;
}

function tileKey(spec: TileSpec): string {
  return `${spec.tier}:${spec.ix}:${spec.iz}`;
}

/** Seamless multi-scale ground texture, sampled in world space. */
function createDetailTexture(seed: number): DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const index = (y * size + x) * 4;
      data[index] = Math.round(periodicFbm2D(u * 4, v * 4, 4, 4, seed) * 255);
      data[index + 1] = Math.round(periodicFbm2D(u * 11, v * 11, 11, 3, seed + 17) * 255);
      data[index + 2] = Math.round(periodicFbm2D(u * 27, v * 27, 27, 2, seed + 31) * 255);
      data[index + 3] = 255;
    }
  }

  const texture = new DataTexture(data, size, size);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = NoColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/** Colour one terrain vertex from its position, height, and slope. */
export function terrainColorAt(
  x: number,
  z: number,
  height: number,
  slope: number,
  seed: number,
): Color {
  colorScratch.copy(grassLow);
  colorScratch.lerp(grass, smoothstep(360, 540, height));
  colorScratch.lerp(dryGrass, smoothstep(600, 780, height));
  colorScratch.lerp(high, smoothstep(820, 1020, height));
  colorScratch.lerp(rock, smoothstep(0.2, 0.6, slope));

  // Farmland patchwork on the gentler low ground. Warping the grid keeps the
  // field boundaries from looking like a printed pattern.
  const warpX = (valueNoise2D(x * 0.0016, z * 0.0016, seed + 111) - 0.5) * 260;
  const warpZ = (valueNoise2D(x * 0.0016 + 13.7, z * 0.0016 - 7.1, seed + 113) - 0.5) * 260;
  const fieldX = (x + warpX) * 0.906 - (z + warpZ) * 0.423;
  const fieldZ = (x + warpX) * 0.423 + (z + warpZ) * 0.906;

  const cellX = Math.floor(fieldX / 340);
  const cellZ = Math.floor(fieldZ / 250);
  const fx = fieldX / 340 - cellX;
  const fz = fieldZ / 250 - cellZ;
  const edge = Math.min(fx, 1 - fx, fz, 1 - fz);
  const border = 1 - smoothstep(0, 0.03, edge);
  const fieldIndex = Math.floor(hash2(cellX, cellZ, seed + 121) * fields.length);
  fieldScratch.copy(fields[fieldIndex]);

  const fieldWeight = (1 - smoothstep(0.13, 0.36, slope)) * (1 - smoothstep(680, 880, height));
  if (fieldWeight > 0) {
    colorScratch.lerp(fieldScratch, fieldWeight * 0.58);
    colorScratch.multiplyScalar(1 - border * fieldWeight * 0.1);
  }

  const distanceToField = Math.hypot(x, z);
  const fieldBlend = 1 - smoothstep(850, 1900, distanceToField);
  if (fieldBlend > 0) colorScratch.lerp(airfield, fieldBlend * 0.82);

  // Bare alpine rock; the snow cap is drawn per fragment by the material.
  colorScratch.lerp(rock, smoothstep(950, 1280, height) * 0.62);

  // Broad, low-frequency variation breaks up large areas of one colour.
  const mottle = fbm2D(x * 0.0009, z * 0.0009, 3, seed + 131) - 0.5;
  colorScratch.offsetHSL(mottle * 0.012, mottle * 0.02, mottle * 0.05);

  return colorScratch;
}

/**
 * Cut the near terrain away under every town strip, so no coarse triangle can
 * cross the graded pad and poke through the runway. One quad is cut when any
 * of its vertices falls inside the apron dilated by `spacing * 1.5`; the
 * covering radius of a `spacing`-sized quad is `spacing * √2`, so every quad
 * that could touch the pad is guaranteed to be removed. The high-resolution
 * pad mesh streamed by `AirfieldField` fills the hole.
 *
 * Only the near tier should call this: its tiles always lie inside the
 * airfield streaming radius, and the finer pad mesh is guaranteed to exist.
 * Coarser tiers sit below the strip or are too distant to matter.
 */
export function buildAirfieldHoleMask(
  x0: number,
  z0: number,
  cells: number,
  spacing: number,
): Uint8Array | null {
  const size = cells * spacing;
  const fields: AirfieldSpec[] = [];
  forEachAirfieldInBounds(x0, z0, x0 + size, z0 + size, (field) => fields.push(field));
  if (fields.length === 0) return null;

  const margin = spacing * 1.5;
  const centerX = x0 + size / 2;
  const centerZ = z0 + size / 2;
  const tileReach = Math.hypot(size, size) / 2;
  const nearby = fields.filter(
    (field) =>
      Math.hypot(field.x - centerX, field.z - centerZ) <=
      field.length / 2 + AIRFIELD.padExtension + margin + tileReach,
  );
  if (nearby.length === 0) return null;

  const holes = new Uint8Array((cells + 1) * (cells + 1));
  const row = cells + 1;
  let any = false;
  for (let j = 0; j <= cells; j++) {
    const z = z0 + j * spacing;
    for (let i = 0; i <= cells; i++) {
      const x = x0 + i * spacing;
      for (const field of nearby) {
        if (!insideAirfieldPad(field, x, z, margin)) continue;
        holes[j * row + i] = 1;
        any = true;
        break;
      }
    }
  }
  return any ? holes : null;
}

/**
 * A moving window of terrain. Tiles are generated from the analytic surface,
 * so any tile can be rebuilt in any order without seams or a prebuilt world
 * extent. Physics samples the same surface through `Terrain` and never waits
 * for a tile.
 */
export class TerrainStreamer {
  private readonly scene: Object3D;
  readonly material: MeshStandardMaterial;
  private readonly tiles = new Map<string, Mesh>();
  private readonly pending: TileSpec[] = [];
  private readonly pendingKeys = new Set<string>();
  private readonly desired = new Map<string, TileSpec>();

  constructor(scene: Object3D, cloudShadows: CloudShadows) {
    this.scene = scene;

    const detailTexture = createDetailTexture(WORLD.seed);
    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    });
    material.onBeforeCompile = (shader) => {
      cloudShadows.inject(shader);
      shader.uniforms.uTerrainDetail = { value: detailTexture };
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform sampler2D uTerrainDetail;")
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          {
            vec3 broad = texture2D(uTerrainDetail, vCloudWorld.xz * 0.0032).rgb;
            vec3 fine = texture2D(uTerrainDetail, vCloudWorld.xz * 0.011).rgb;
            float light =
              1.0 +
              (broad.r - 0.5) * 0.16 +
              (fine.g - 0.5) * 0.06 +
              (broad.b - 0.5) * 0.04;
            vec3 tint = mix(vec3(0.97, 1.0, 0.95), vec3(1.03, 1.0, 0.92), broad.b);
            diffuseColor.rgb *= light * tint;

            // Snow is a fragment-level altitude mask, so the cap follows the
            // surface smoothly instead of zigzagging along the vertex grid.
            float snowLine = 1240.0 + (broad.r - 0.5) * 120.0;
            float snow = smoothstep(snowLine, snowLine + 220.0, vCloudWorld.y);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.91, 0.94, 0.96), snow * 0.95);
          }`,
        );
    };
    material.customProgramCacheKey = () => "terrain-cloud-detail";
    this.material = material;
  }

  /** Build missing tiles around the camera, keeping each frame under budget. */
  update(position: Vector3, budgetMs: number = STREAMING.terrainBuildBudgetMs): void {
    this.collectDesired(position);

    // Remove tiles that have left the window. Coarser tiers underneath cover
    // the trailing edge, so this never opens a hole.
    for (const [key, mesh] of this.tiles) {
      if (this.desired.has(key)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.tiles.delete(key);
    }

    for (const [key, spec] of this.desired) {
      if (this.tiles.has(key) || this.pendingKeys.has(key)) continue;
      this.pending.push(spec);
      this.pendingKeys.add(key);
    }

    if (this.pending.length === 0) return;

    const start = performance.now();
    while (this.pending.length > 0) {
      const spec = this.pending.shift()!;
      const key = tileKey(spec);
      this.pendingKeys.delete(key);

      // The camera may have moved while this tile waited in the queue.
      if (!this.desired.has(key) || this.tiles.has(key)) continue;

      const geometry = this.buildGeometry(spec);
      const mesh = new Mesh(geometry, this.material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.tiles.set(key, mesh);

      if (performance.now() - start >= budgetMs) break;
    }
  }

  private collectDesired(position: Vector3): void {
    this.desired.clear();

    for (let tier = 0; tier < TIERS.length; tier++) {
      const { size, spacing, drop } = TIERS[tier];
      const cx = Math.floor(position.x / size);
      const cz = Math.floor(position.z / size);

      for (let dz = -TILES_EACH_SIDE; dz <= TILES_EACH_SIDE; dz++) {
        for (let dx = -TILES_EACH_SIDE; dx <= TILES_EACH_SIDE; dx++) {
          const ix = cx + dx;
          const iz = cz + dz;
          const spec: TileSpec = { tier, ix, iz, size, spacing, drop };
          this.desired.set(tileKey(spec), spec);
        }
      }
    }
  }

  private buildGeometry(spec: TileSpec): BufferGeometry {
    const { size, spacing, drop } = spec;
    const cells = Math.round(size / spacing);
    const margin = 1;
    const stride = cells + margin * 2 + 1;
    const heights = new Float32Array(stride * stride);

    const x0 = spec.ix * size;
    const z0 = spec.iz * size;

    for (let j = 0; j < stride; j++) {
      const z = z0 + (j - margin) * spacing;
      for (let i = 0; i < stride; i++) {
        const x = x0 + (i - margin) * spacing;
        heights[j * stride + i] = terrainHeightAt(x, z, WORLD);
      }
    }

    const vertexCount = (cells + 1) * (cells + 1);
    const quadCount = cells * cells;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const indices = new Uint16Array(quadCount * 6);

    // The coarse cells cannot resolve a river channel. Cut a hole through
    // every LOD tier and let RiverChannelField fill it with terrain-resolution
    // geometry that actually contains the carved channel. Without the mid/far
    // cuts, those lower tiers would still cover the stream through the near hole.
    //
    // The cut is computed from the station centreline rather than the carve
    // query, which reports nothing beyond the bank. A wider tier can otherwise
    // slip a 100-400 m grid between two bank vertices and keep a solid sheet of
    // terrain over the water.
    const riverHoles: Uint8Array | null = (() => {
      const holeMargin = RIVER_HOLE_MARGIN + spacing * 0.7071;
      const stations: { x: number; z: number; reach: number }[] = [];
      forEachRiverInBounds(x0, z0, x0 + size, z0 + size, (river) => {
        for (const station of river.stations) {
          const reach = station.width / 2 + RIVERS.bankWidth + holeMargin;
          if (
            station.x + reach < x0 ||
            station.x - reach > x0 + size ||
            station.z + reach < z0 ||
            station.z - reach > z0 + size
          ) {
            continue;
          }
          stations.push({ x: station.x, z: station.z, reach: reach * reach });
        }
      });
      if (stations.length === 0) return null;

      const holes = new Uint8Array((cells + 1) * (cells + 1));
      for (let j = 0; j <= cells; j++) {
        const z = z0 + j * spacing;
        for (let i = 0; i <= cells; i++) {
          const x = x0 + i * spacing;
          for (const station of stations) {
            const dx = x - station.x;
            const dz = z - station.z;
            if (dx * dx + dz * dz < station.reach) {
              holes[j * (cells + 1) + i] = 1;
              break;
            }
          }
        }
      }
      return holes;
    })();

    // The finest tier is cut away under each town strip and filled by the
    // high-resolution pad mesh. Coarser tiers sit below the strip, so they can
    // stay solid; leaving them intact also hides the cut edges.
    const airfieldHoles =
      spec.tier === 0 ? buildAirfieldHoleMask(x0, z0, cells, spacing) : null;

    let offset = 0;
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        const x = x0 + i * spacing;
        const z = z0 + j * spacing;
        const mi = i + margin;
        const mj = j + margin;
        const height = heights[mj * stride + mi];

        const hL = heights[mj * stride + mi - 1];
        const hR = heights[mj * stride + mi + 1];
        const hB = heights[(mj - 1) * stride + mi];
        const hF = heights[(mj + 1) * stride + mi];
        normalScratch.set(-(hR - hL) / (2 * spacing), 1, -(hF - hB) / (2 * spacing));
        normalScratch.normalize();

        const slope = 1 - normalScratch.y;
        const color = terrainColorAt(x, z, height, slope, WORLD.seed);

        positions[offset] = x;
        positions[offset + 1] = height - drop;
        positions[offset + 2] = z;

        normals[offset] = normalScratch.x;
        normals[offset + 1] = normalScratch.y;
        normals[offset + 2] = normalScratch.z;

        colors[offset] = color.r;
        colors[offset + 1] = color.g;
        colors[offset + 2] = color.b;

        offset += 3;
      }
    }

    const width = cells + 1;
    let indexOffset = 0;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const i0 = j * width + i;
        const i1 = i0 + 1;
        const i2 = i0 + width;
        const i3 = i2 + 1;

        if (
          riverHoles &&
          (riverHoles[i0] || riverHoles[i1] || riverHoles[i2] || riverHoles[i3])
        ) {
          continue;
        }

        if (
          airfieldHoles &&
          (airfieldHoles[i0] || airfieldHoles[i1] || airfieldHoles[i2] || airfieldHoles[i3])
        ) {
          continue;
        }

        indices[indexOffset] = i0;
        indices[indexOffset + 1] = i2;
        indices[indexOffset + 2] = i3;
        indices[indexOffset + 3] = i0;
        indices[indexOffset + 4] = i3;
        indices[indexOffset + 5] = i1;
        indexOffset += 6;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new BufferAttribute(normals, 3));
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    geometry.setIndex(new BufferAttribute(indices.subarray(0, indexOffset), 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}
