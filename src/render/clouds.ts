import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { STREAMING, WORLD } from "../config";
import { hash2, mulberry32 } from "../core/rng";
import type { LiftField, Thermal } from "../sim/lift";

const vertexShader = /* glsl */ `
  #include <fog_pars_vertex>

  attribute float aHeight;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vHeight;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vHeight = aHeight;

    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <fog_pars_fragment>

  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform float uSunStrength;
  uniform vec3 uSkyColor;
  uniform vec3 uShadowColor;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vHeight;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPosition);
    vec3 L = normalize(uSunDirection);

    // Wrap the diffuse term around the cloud. Real clouds scatter light far
    // into their own shadow, so a hard day/night line looks wrong.
    float wrap = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
    float diffuse = pow(wrap, 1.35);

    // Pale sky fill instead of the terrain's olive hemisphere bounce.
    float sky = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambient = mix(uShadowColor, uSkyColor, sky);

    // Cool, slightly grey bases fading to white cauliflower tops.
    float top = smoothstep(0.02, 0.92, vHeight);
    vec3 albedo = mix(vec3(0.82, 0.88, 0.97), vec3(1.0), top);

    vec3 color = albedo * ambient + uSunColor * uSunStrength * diffuse;

    // A soft silver lining when the sun is behind the cloud.
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6);
    float backlit = max(dot(-V, L), 0.0);
    color += uSunColor * rim * (0.1 + backlit * 0.38);

    // Keep the deepest bases a little cooler than the sunlit mass, and add a
    // hint of large-scale grain so the surface does not look like plastic.
    color = mix(color * vec3(0.9, 0.94, 1.02), color, top);
    float grain =
      sin(vWorldPosition.x * 0.045 + vWorldPosition.z * 0.06) *
      sin(vWorldPosition.y * 0.08 + vWorldPosition.x * 0.03);
    color *= 1.0 + grain * 0.025;

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const UP = new Vector3(0, 1, 0);

/** A cloud footprint used to bake soft shadows onto the ground. */
export interface CloudShadowSource {
  x: number;
  z: number;
  radius: number;
  baseY: number;
  height: number;
}

interface Bump {
  direction: Vector3;
  strength: number;
  sharpness: number;
}

interface CloudTile {
  mesh: Mesh;
  sources: CloudShadowSource[];
}

interface TileSpec {
  ix: number;
  iz: number;
}

const TILE_SIZE = STREAMING.cloudTileSize;
const TILES_EACH_SIDE = STREAMING.cloudTilesEachSide;
const BACKGROUND_MIN = 2;
const BACKGROUND_RANGE = 2;

/**
 * One soft, lumpy cloud lobe. The base is flattened and the geometry is
 * normalised to a height of 1 with its base at y = 0, so clusters can be
 * assembled with plain transforms.
 */
function makeLobeVariant(rng: () => number, flattenBase: boolean): BufferGeometry {
  const sphere = new SphereGeometry(1, 24, 16);
  sphere.deleteAttribute("uv");
  sphere.deleteAttribute("normal");

  // Weld the UV seam before displacing so the smooth normals have no seam.
  const geometry = mergeVertices(sphere);
  sphere.dispose();

  const position = geometry.getAttribute("position");
  const vertex = new Vector3();

  const bumps: Bump[] = [];
  const bumpCount = 6 + Math.floor(rng() * 3);
  for (let i = 0; i < bumpCount; i++) {
    const angle = rng() * Math.PI * 2;
    const y = -0.05 + rng() * 1.05;
    const radial = Math.sqrt(Math.max(0, 1 - y * y));
    bumps.push({
      direction: new Vector3(Math.cos(angle) * radial, y, Math.sin(angle) * radial).normalize(),
      strength: 0.2 + rng() * 0.27,
      sharpness: 2.5 + rng() * 4,
    });
  }

  const phaseA = rng() * Math.PI * 2;
  const phaseB = rng() * Math.PI * 2;
  const phaseC = rng() * Math.PI * 2;

  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).normalize();

    let radius = 1;
    for (const bump of bumps) {
      const facing = Math.max(0, vertex.dot(bump.direction));
      radius += bump.strength * Math.pow(facing, bump.sharpness);
    }

    const ripple =
      1 +
      0.04 *
        Math.sin(vertex.x * 8.1 + phaseA) *
        Math.sin(vertex.y * 6.3 + phaseB) *
        Math.sin(vertex.z * 9.7 + phaseC);
    vertex.multiplyScalar(radius * ripple);
    vertex.y *= 0.9;

    // Flatten the very bottom into the classic cumulus shelf without turning
    // the whole lobe into a flying saucer. Top lobes keep a rounded underside
    // so their flat shelf does not poke out of the cloud above the base.
    if (flattenBase) {
      const base = -0.42;
      if (vertex.y < base) vertex.y = base + (vertex.y - base) * 0.35;
    }

    position.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }

  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const height = Math.max(0.7, box.max.y - box.min.y);
  const heights = new Float32Array(position.count);

  for (let i = 0; i < position.count; i++) {
    const normalizedY = (position.getY(i) - box.min.y) / height;
    position.setY(i, normalizedY);
    heights[i] = normalizedY;
  }

  geometry.setAttribute("aHeight", new Float32BufferAttribute(heights, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Add one cumulus cluster to the merge list. `radius` is roughly half the
 * finished cloud width; `height` is roughly the finished cloud height.
 */
function addCloud(
  parts: BufferGeometry[],
  flatVariants: BufferGeometry[],
  roundVariants: BufferGeometry[],
  rng: () => number,
  x: number,
  z: number,
  baseY: number,
  radius: number,
  height: number,
  roundedBase = false,
): CloudShadowSource {
  const lobeCount = 4 + Math.floor(rng() * 3);

  for (let i = 0; i < lobeCount; i++) {
    const angle = rng() * Math.PI * 2;
    const isMain = i === 0;
    const isTop = i >= 3;
    const variants = roundedBase || isTop ? roundVariants : flatVariants;
    const variant = variants[Math.floor(rng() * variants.length)];
    const lobe = variant.clone();

    // Main mass in the middle, two lower shoulders, then one to three lobes
    // stacked on top to build the cauliflower silhouette. Top lobes sit close
    // to the centre and low enough that their undersides stay buried.
    const offset = isMain ? 0 : radius * (isTop ? 0.05 + rng() * 0.15 : 0.28 + rng() * 0.22);
    const lobeRadius = radius * (isMain ? 0.56 : isTop ? 0.32 + rng() * 0.16 : 0.36 + rng() * 0.14);
    const lobeHeight = height * (isMain ? 0.92 : isTop ? 0.45 + rng() * 0.2 : 0.45 + rng() * 0.2);
    const lobeBase = baseY + height * (isMain ? 0 : isTop ? 0.3 + rng() * 0.18 : rng() * 0.06);

    const matrix = new Matrix4().compose(
      new Vector3(x + Math.cos(angle) * offset, lobeBase, z + Math.sin(angle) * offset),
      new Quaternion().setFromAxisAngle(UP, rng() * Math.PI * 2),
      new Vector3(lobeRadius * (0.88 + rng() * 0.24), lobeHeight, lobeRadius * (0.82 + rng() * 0.32)),
    );

    lobe.applyMatrix4(matrix);
    parts.push(lobe);
  }

  return { x, z, radius: radius * 1.18, baseY, height };
}

/**
 * Soft cumulus built from smooth, seeded lobes and lit by a cloud-specific
 * shader. The field is split into 16 km tiles, so a moving glider can stream
 * clouds forever while each tile still costs a single draw call.
 */
export class CloudField {
  readonly group = new Group();
  /** Footprints of every loaded cloud, for the rolling ground-shadow bake. */
  readonly shadowSources: CloudShadowSource[] = [];
  /** Increments whenever loaded geometry or shadow sources change. */
  version = 0;

  private readonly material = new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uSunDirection: { value: new Vector3(0.35, 0.8, 0.45).normalize() },
        uSunColor: { value: new Color(0xfff2d8) },
        uSunStrength: { value: 2.1 },
        uSkyColor: { value: new Color(0xa6c7e9) },
        uShadowColor: { value: new Color(0x8299b8) },
      },
    ]),
    vertexShader,
    fragmentShader,
    fog: true,
  });

  private readonly flatVariants: BufferGeometry[];
  private readonly roundVariants: BufferGeometry[];
  private readonly tiles = new Map<string, CloudTile>();
  private readonly empty = new Set<string>();
  private readonly pending: TileSpec[] = [];
  private readonly pendingKeys = new Set<string>();
  private readonly desired = new Set<string>();
  private cloudBase = 1900;
  private configured = false;

  constructor() {
    const rng = mulberry32(WORLD.seed + 991);
    this.flatVariants = Array.from({ length: 7 }, () => makeLobeVariant(rng, true));
    this.roundVariants = Array.from({ length: 7 }, () => makeLobeVariant(rng, false));
  }

  /** True while tiles are still being generated, so callers can defer bakes. */
  get busy(): boolean {
    return this.pending.length > 0 || this.pendingKeys.size > 0;
  }

  /** Keep the cloud light in step with the sun used by the rest of the scene. */
  setSun(direction: Vector3, color: Color, intensity: number): void {
    (this.material.uniforms.uSunDirection.value as Vector3).copy(direction).normalize();
    (this.material.uniforms.uSunColor.value as Color).copy(color);
    this.material.uniforms.uSunStrength.value = Math.min(2.6, Math.max(0.7, intensity * 0.8));
  }

  /** Start a fresh cloud field for newly selected weather. */
  configure(cloudBase: number): void {
    this.cloudBase = cloudBase;
    this.configured = true;
    this.clear();
  }

  /** Stream cloud tiles around the camera with a small per-frame budget. */
  update(position: Vector3, liftField: LiftField, budgetMs: number = 2): void {
    if (!this.configured) return;

    this.desired.clear();
    const cx = Math.floor(position.x / TILE_SIZE);
    const cz = Math.floor(position.z / TILE_SIZE);

    for (let dz = -TILES_EACH_SIDE; dz <= TILES_EACH_SIDE; dz++) {
      for (let dx = -TILES_EACH_SIDE; dx <= TILES_EACH_SIDE; dx++) {
        this.desired.add(`${cx + dx}:${cz + dz}`);
      }
    }

    let sourcesChanged = false;
    for (const [key, tile] of this.tiles) {
      if (this.desired.has(key)) continue;
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      this.tiles.delete(key);
      sourcesChanged = true;
    }
    for (const key of this.empty) {
      if (!this.desired.has(key)) this.empty.delete(key);
    }

    for (const key of this.desired) {
      if (this.tiles.has(key) || this.empty.has(key) || this.pendingKeys.has(key)) continue;
      const [ix, iz] = key.split(":").map(Number);
      this.pending.push({ ix, iz });
      this.pendingKeys.add(key);
    }

    if (this.pending.length === 0) {
      if (sourcesChanged) this.refreshSources();
      return;
    }

    // Build near tiles first so the horizon fills from the centre outwards.
    this.pending.sort((a, b) => {
      const da = Math.hypot((a.ix + 0.5) * TILE_SIZE - position.x, (a.iz + 0.5) * TILE_SIZE - position.z);
      const db = Math.hypot((b.ix + 0.5) * TILE_SIZE - position.x, (b.iz + 0.5) * TILE_SIZE - position.z);
      return da - db;
    });

    const start = performance.now();
    while (this.pending.length > 0) {
      const spec = this.pending.shift()!;
      const key = `${spec.ix}:${spec.iz}`;
      this.pendingKeys.delete(key);
      if (!this.desired.has(key) || this.tiles.has(key)) continue;

      const tile = this.buildTile(spec, liftField);
      if (tile) {
        this.tiles.set(key, tile);
        this.group.add(tile.mesh);
        sourcesChanged = true;
      } else {
        this.empty.add(key);
      }

      if (performance.now() - start >= budgetMs) break;
    }

    if (sourcesChanged) this.refreshSources();
  }

  private refreshSources(): void {
    this.shadowSources.length = 0;
    for (const tile of this.tiles.values()) {
      for (const source of tile.sources) this.shadowSources.push(source);
    }
    this.version++;
  }

  private clear(): void {
    for (const tile of this.tiles.values()) {
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
    }
    this.tiles.clear();
    this.empty.clear();
    this.pending.length = 0;
    this.pendingKeys.clear();
    this.shadowSources.length = 0;
    this.version++;
  }

  private buildTile(spec: TileSpec, liftField: LiftField): CloudTile | null {
    const x0 = spec.ix * TILE_SIZE;
    const z0 = spec.iz * TILE_SIZE;
    const x1 = x0 + TILE_SIZE;
    const z1 = z0 + TILE_SIZE;
    const rng = mulberry32(Math.floor(hash2(spec.ix, spec.iz, WORLD.seed + 991) * 4294967296));
    const parts: BufferGeometry[] = [];
    const sources: CloudShadowSource[] = [];
    const thermalPositions: { x: number; z: number }[] = [];

    liftField.forEachThermalInBounds(x0, z0, x1, z1, (thermal: Thermal) => {
      thermalPositions.push({ x: thermal.x, z: thermal.z });
      sources.push(
        addCloud(
          parts,
          this.flatVariants,
          this.roundVariants,
          rng,
          thermal.x,
          thermal.z,
          this.cloudBase,
          360 + rng() * 110,
          250 + rng() * 80,
        ),
      );
    });

    let background = 0;
    let attempts = 0;
    const wanted = BACKGROUND_MIN + Math.floor(rng() * BACKGROUND_RANGE);
    while (background < wanted && attempts < 10) {
      attempts++;
      const x = x0 + rng() * TILE_SIZE;
      const z = z0 + rng() * TILE_SIZE;
      if (Math.hypot(x, z) < 1200) continue;
      if (thermalPositions.some((thermal) => Math.hypot(thermal.x - x, thermal.z - z) < 800)) continue;

      sources.push(
        addCloud(
          parts,
          this.flatVariants,
          this.roundVariants,
          rng,
          x,
          z,
          this.cloudBase,
          90 + rng() * 80,
          165 + rng() * 115,
          true,
        ),
      );
      background++;
    }

    if (parts.length === 0) return null;

    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!geometry) return null;

    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, this.material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return { mesh, sources };
  }
}
