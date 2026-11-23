import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from "three";
import { RIVERS, WORLD } from "../config";
import { forEachRiverInBounds, lakeSurfaceLevelAt, terrainHeightAt, type River, type RiverStation } from "../sim/terrain";
import type { Terrain } from "../sim/terrain";
import { terrainColorAt } from "./terrainMesh";

type MeshStation = RiverStation & { cap?: boolean };

/** Extra high-resolution apron beyond the bank, covering the cut in every LOD tile. */
const CHANNEL_OVERLAP = 340;
/** Lateral apron used by the source cap, where only the terrain cut must close. */
const CAP_APRON = 250;
/** Length of the terrain cap upstream of a river source, covering the LOD hole. */
const SOURCE_CAP = 340;
/** Small lift over the analytic surface so the apron never z-fights. */
const CHANNEL_LIFT = 0.05;

/**
 * Lateral sample offsets from the centreline. Most samples sit on the water
 * itself and its banks, where a coarse spacing would let a sloping bank bridge
 * straight over the water surface; a few coarse samples then reach out across
 * the apron that fills the hole in the terrain tiles.
 */
function lateralOffsets(halfWidth: number): number[] {
  const bank = RIVERS.bankWidth;
  const bankEdge = halfWidth + bank;
  return [
    -(bankEdge + CHANNEL_OVERLAP),
    -(bankEdge + CHANNEL_OVERLAP * 0.6),
    -(bankEdge + CHANNEL_OVERLAP * 0.25),
    -bankEdge,
    -(halfWidth + bank * 0.5),
    -halfWidth,
    -halfWidth * 0.6,
    -halfWidth * 0.3,
    0,
    halfWidth * 0.3,
    halfWidth * 0.6,
    halfWidth,
    halfWidth + bank * 0.5,
    bankEdge,
    bankEdge + CHANNEL_OVERLAP * 0.25,
    bankEdge + CHANNEL_OVERLAP * 0.6,
    bankEdge + CHANNEL_OVERLAP,
  ];
}

const LATERAL_SAMPLES = lateralOffsets(1).length;

/**
 * High-resolution terrain strip along each stream. The 50 m terrain tiles
 * cannot resolve a river channel, so every LOD tier is cut over the stream
 * corridor and this mesh fills the holes with lateral samples clustered on the
 * water and banks.
 * It uses the terrain material, so colours, cloud shadows, and lighting match
 * the surrounding ground.
 */
export class RiverChannelField {
  readonly mesh: Mesh;

  private readonly terrain: Terrain;

  constructor(terrain: Terrain, material: MeshStandardMaterial, scene: Object3D) {
    this.terrain = terrain;
    const geometry = this.buildGeometry();
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = "river-channel";
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  private buildGeometry(): BufferGeometry {
    const positions: number[] = [];
    const colors: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const color = new Color();

    const rivers: River[] = [];
    forEachRiverInBounds(-100_000, -100_000, 100_000, 100_000, (river) => rivers.push(river));

    for (const river of rivers) {
      // Stop the solid banks at the lake shore. Letting the channel mesh run
      // into the lake lifts a green wedge above the water at the mouth.
      const stations = river.stations.filter((station) => !station.inLake);
      if (stations.length < 2) continue;

      // The terrain streamer cuts a hole around the first station too, but the
      // ribbon has no geometry upstream of it, so the source end would show the
      // backdrop. Extend a terrain-only cap up the slope to close that cut.
      const first = stations[0];
      const second = stations[1];
      const capDx = first.x - second.x;
      const capDz = first.z - second.z;
      const capLength = Math.hypot(capDx, capDz) || 1;
      const capRows: MeshStation[] = [];
      for (let row = 4; row >= 1; row--) {
        const distance = (SOURCE_CAP * row) / 4;
        capRows.push({
          x: first.x + (capDx / capLength) * distance,
          z: first.z + (capDz / capLength) * distance,
          width: first.width,
          level: first.level,
          inLake: false,
          cap: true,
        });
      }
      const meshStations: MeshStation[] = [...capRows, ...stations];
      // A stream that fades out on land needs the same treatment at its lower
      // end; one that reaches a lake is already covered by the water surface.
      if (river.mouth === null) {
        const last = stations[stations.length - 1];
        const before = stations[stations.length - 2];
        const tailDx = last.x - before.x;
        const tailDz = last.z - before.z;
        const tailLength = Math.hypot(tailDx, tailDz) || 1;
        for (let row = 1; row <= 4; row++) {
          const distance = (SOURCE_CAP * row) / 4;
          meshStations.push({
            x: last.x + (tailDx / tailLength) * distance,
            z: last.z + (tailDz / tailLength) * distance,
            width: last.width,
            level: last.level,
            inLake: false,
            cap: true,
          });
        }
      }
      const base = positions.length / 3;

      for (let i = 0; i < meshStations.length; i++) {
        const station = meshStations[i];
        const prev = meshStations[Math.max(0, i - 1)];
        const next = meshStations[Math.min(meshStations.length - 1, i + 1)];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const length = Math.hypot(dx, dz) || 1;
        const normalX = -dz / length;
        const normalZ = dx / length;
        const halfWidth = station.width / 2;
        const bankEdge = halfWidth + RIVERS.bankWidth;
        const offsets = lateralOffsets(halfWidth);
        const scale = station.cap
          ? (bankEdge + CAP_APRON) / (bankEdge + CHANNEL_OVERLAP)
          : 1;
        // Stop the apron where it would run out over a lake. Otherwise its
        // coarse triangles bridge the shoreline and paint a grass wedge across
        // the water at a stream mouth.
        const apronLimit = (sign: number): number => {
          let last = bankEdge;
          const limit = bankEdge + CHANNEL_OVERLAP;
          for (let d = bankEdge + 8; d <= limit; d += 12) {
            const px = station.x + normalX * sign * d;
            const pz = station.z + normalZ * sign * d;
            if (lakeSurfaceLevelAt(px, pz, WORLD) !== null) return last;
            last = d;
          }
          return limit;
        };
        const limitLeft = apronLimit(-1);
        const limitRight = apronLimit(1);

        for (let sample = 0; sample < LATERAL_SAMPLES; sample++) {
          let lateral = offsets[sample];
          if (lateral < -bankEdge) lateral = -Math.min(-lateral, limitLeft);
          else if (lateral > bankEdge) lateral = Math.min(lateral, limitRight);
          lateral *= scale;
          const x = station.x + normalX * lateral;
          const z = station.z + normalZ * lateral;
          // Inside a lake polygon the apron must duck under the water plane.
          // Otherwise the wide strip past the mouth paints a green wedge over
          // the lake surface.
          const lakeLevel = lakeSurfaceLevelAt(x, z, WORLD);
          const ground = terrainHeightAt(x, z, WORLD) + CHANNEL_LIFT;
          const y = lakeLevel !== null ? Math.min(ground, lakeLevel - 1.5) : ground;
          const normal = this.terrain.normalAt(x, z, 20);
          const slope = 1 - normal.y;
          color.copy(terrainColorAt(x, z, y, slope, WORLD.seed));

          positions.push(x, y, z);
          colors.push(color.r, color.g, color.b);
          normals.push(normal.x, normal.y, normal.z);
        }
      }

      const addTriangle = (a: number, b: number, c: number): void => {
        const ax = positions[a * 3];
        const az = positions[a * 3 + 2];
        const bx = positions[b * 3];
        const bz = positions[b * 3 + 2];
        const cx = positions[c * 3];
        const cz = positions[c * 3 + 2];
        // A folded apron can reverse a triangle. Force it to face the sky so
        // it neither disappears nor picks up a downward normal.
        const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        if (ny >= 0) indices.push(a, b, c);
        else indices.push(a, c, b);
      };

      for (let i = 0; i < meshStations.length - 1; i++) {
        for (let sample = 0; sample < LATERAL_SAMPLES - 1; sample++) {
          const a = base + i * LATERAL_SAMPLES + sample;
          const b = a + 1;
          const c = a + LATERAL_SAMPLES;
          const d = c + 1;
          addTriangle(a, d, c);
          addTriangle(a, b, d);
        }
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}
