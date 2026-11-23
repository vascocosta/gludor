import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { LAKES } from "../config";
import {
  forEachLakeInBounds,
  forEachRiverInBounds,
  type Lake,
  type River,
  type RiverStation,
} from "../sim/terrain";
import type { CloudShadows } from "./cloudShadows";

const SEGMENTS = 72;
/** Stations a river ribbon carries past the lake shore to close the mouth. */
const MOUTH_STATIONS = 8;
/** Slightly beyond the nominal shoreline so the edge tucks under the bank. */
const SHORE_SCALE = 1.02;
/** Opaque stylized water: dark in the middle, lighter over the shelving shore. */
const DEEP = new Color(0x0a2c4d);
const SHALLOW = new Color(0x1b557f);

/**
 * Flat water surfaces for every lake and stream in rendering range. The lake
 * grid is infinite, so this is a moving window just like the terrain. Lakes and
 * rivers share one merged geometry and one material, keeping the draw cost to
 * a single call no matter how much water is visible.
 *
 * The water is deliberately opaque and stylized: a deep-blue body, a fresnel
 * sky tint, and animated wave normals that catch the sun. Terrain geometry hides
 * the edges of each lake disk, and the high-resolution river bank mesh keeps
 * stream ribbons from being buried by the coarse terrain.
 */
export class WaterField {
  readonly mesh: Mesh;

  private readonly timeUniform = { value: 0 };
  private readonly shallowUniform = { value: SHALLOW.clone() };
  private readonly deepUniform = { value: DEEP.clone() };
  private readonly skyUniform: { value: Color };
  private lastX = Number.POSITIVE_INFINITY;
  private lastZ = Number.POSITIVE_INFINITY;
  private surfaceCount = 0;

  constructor(scene: Object3D, cloudShadows: CloudShadows, skyColor: Color) {
    this.skyUniform = { value: skyColor };

    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.42,
      metalness: 0,
      flatShading: false,
    });
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uWaterTime = this.timeUniform;
      shader.uniforms.uWaterDeep = this.deepUniform;
      shader.uniforms.uWaterShallow = this.shallowUniform;
      shader.uniforms.uWaterSky = this.skyUniform;

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          attribute float aShore;
          attribute vec2 aFlow;
          varying vec3 vWaterWorld;
          varying float vWaterShore;
          varying vec2 vWaterFlow;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWaterShore = aShore;
          vWaterFlow = aFlow;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uWaterTime;
          uniform vec3 uWaterDeep;
          uniform vec3 uWaterShallow;
          uniform vec3 uWaterSky;
          varying vec3 vWaterWorld;
          varying float vWaterShore;
          varying vec2 vWaterFlow;

          float waterHash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }

          float waterNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = waterHash(i);
            float b = waterHash(i + vec2(1.0, 0.0));
            float c = waterHash(i + vec2(0.0, 1.0));
            float d = waterHash(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }`,
        )
        .replace(
          "#include <normal_fragment_begin>",
          `#include <normal_fragment_begin>
          {
            vec2 p = vWaterWorld.xz;
            float t = uWaterTime;

            // Ripple trains with drifting phase, so the surface never settles
            // into a visible plaid. The wind patch gently masks them too.
            float gust = 0.55 + 0.7 * waterNoise(p * 0.0055);
            float warp = waterNoise(p * 0.021) * 6.0;
            vec2 d1 = normalize(vec2(0.92, 0.38));
            vec2 d2 = normalize(vec2(-0.46, 0.88));
            vec2 d3 = normalize(vec2(0.21, -0.97));
            vec2 d4 = normalize(vec2(-0.86, -0.51));
            vec2 slope = vec2(0.0);
            slope += d1 * 0.030 * cos(dot(p, d1) * 0.140 + t * 1.25 + warp);
            slope += d2 * 0.020 * cos(dot(p, d2) * 0.310 - t * 1.60 + warp * 1.7);
            slope += d3 * 0.012 * cos(dot(p, d3) * 0.670 + t * 2.20 + warp * 0.6);
            slope += d4 * 0.008 * cos(dot(p, d4) * 1.450 - t * 2.90 + warp * 2.3);
            slope *= gust;

            // Rivers carry a flow direction. A travelling wave along it makes
            // the stream read as moving water rather than a static blue strip.
            if (length(vWaterFlow) > 0.001) {
              vec2 flow = normalize(vWaterFlow);
              float flowPhase = dot(p, flow) * 0.16 - t * 2.8;
              slope += flow * cos(flowPhase) * 0.026;
            }

            // Noise-derived slopes break up the directional trains into
            // irregular, wind-stretched ripples.
            vec2 drift = vec2(t * 0.10, t * 0.45);
            float h0 = waterNoise(vec2(p.x * 0.020, p.y * 0.075) + drift);
            float hx = waterNoise(vec2((p.x + 6.0) * 0.020, p.y * 0.075) + drift);
            float hz = waterNoise(vec2(p.x * 0.020, (p.y + 6.0) * 0.075) + drift);
            slope += vec2(hx - h0, hz - h0) * 0.55;

            vec3 waveNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
            normal = normalize((viewMatrix * vec4(waveNormal, 0.0)).xyz);
            nonPerturbedNormal = normal;

            float facing = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
            float fresnel = pow(1.0 - facing, 4.0);
            float depthTint = smoothstep(0.55, 1.0, vWaterShore + (gust - 0.85) * 0.10);
            vec3 body = mix(uWaterDeep, uWaterShallow, depthTint);

            // Drifting, non-repeating shimmer: two scales of wind-stretched
            // moving noise are cheaper than a ripple texture and never form a
            // visible grid.
            float shimmer =
              waterNoise(vec2(p.x * 0.012, p.y * 0.055) + vec2(t * 0.018, t * 0.200)) * 0.62 +
              waterNoise(vec2(p.x * 0.032, p.y * 0.130) - vec2(t * 0.030, t * 0.340)) * 0.38;
            body *= 0.90 + shimmer * 0.20;

            diffuseColor.rgb = mix(body, uWaterSky, clamp(fresnel * 0.55, 0.0, 0.7));
          }`,
        );

      cloudShadows.inject(shader);
    };
    material.customProgramCacheKey = () => "lake-water";

    this.mesh = new Mesh(new BufferGeometry(), material);
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = true;
    scene.add(this.mesh);
  }

  /** Stream the visible lakes and advance the ripple animation. */
  update(position: Vector3, time: number): void {
    this.timeUniform.value = time;

    if (Math.hypot(position.x - this.lastX, position.z - this.lastZ) < LAKES.rebuildDistance) return;
    this.lastX = position.x;
    this.lastZ = position.z;
    this.rebuild(position.x, position.z);
  }

  private rebuild(cx: number, cz: number): void {
    const positions: number[] = [];
    const normals: number[] = [];
    const shores: number[] = [];
    const flows: number[] = [];
    const indices: number[] = [];
    const radius = LAKES.renderRadius;

    forEachLakeInBounds(
      cx - radius,
      cz - radius,
      cx + radius,
      cz + radius,
      (lake) => this.addLake(lake, positions, normals, shores, flows, indices),
    );
    forEachRiverInBounds(
      cx - radius,
      cz - radius,
      cx + radius,
      cz + radius,
      (river) => this.addRiver(river, positions, normals, shores, flows, indices),
    );

    this.surfaceCount = indices.length;

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    geometry.setAttribute("aShore", new BufferAttribute(new Float32Array(shores), 1));
    geometry.setAttribute("aFlow", new BufferAttribute(new Float32Array(flows), 2));
    geometry.setIndex(
      new BufferAttribute(new Uint32Array(indices), 1),
    );
    geometry.computeBoundingSphere();

    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.mesh.visible = this.surfaceCount > 0;
  }

  private addLake(
    lake: Lake,
    positions: number[],
    normals: number[],
    shores: number[],
    flows: number[],
    indices: number[],
  ): void {
    const base = positions.length / 3;
    const cosAngle = Math.cos(lake.angle);
    const sinAngle = Math.sin(lake.angle);

    // Centre of the triangle fan, coloured as the deep part of the lake.
    positions.push(lake.x, lake.level, lake.z);
    normals.push(0, 1, 0);
    shores.push(0);
    flows.push(0, 0);

    for (let k = 0; k < SEGMENTS; k++) {
      const theta = (k / SEGMENTS) * Math.PI * 2;
      const wobble =
        1 +
        lake.amp1 * Math.sin(3 * theta + lake.phase1) +
        lake.amp2 * Math.sin(5 * theta + lake.phase2);
      const r = lake.radius * wobble * SHORE_SCALE;
      const ex = r * Math.cos(theta);
      const ez = r * Math.sin(theta);

      // Inverse of the normalised lake-space transform, so this polygon follows
      // the carved shoreline rather than a plain ellipse.
      const x = lake.x + ex * lake.aspect * cosAngle - ez * sinAngle;
      const z = lake.z + ex * lake.aspect * sinAngle + ez * cosAngle;

      positions.push(x, lake.level, z);
      normals.push(0, 1, 0);
      shores.push(1);
      flows.push(0, 0);

      const current = base + 1 + k;
      const next = base + 1 + ((k + 1) % SEGMENTS);
      // Counter-clockwise seen from above, so the plane faces the sky.
      indices.push(base, next, current);
    }
  }

  /** Overlap the lake surface by a short distance so the mouth has no gap. */
  private addRiver(
    river: River,
    positions: number[],
    normals: number[],
    shores: number[],
    flows: number[],
    indices: number[],
  ): void {
    const mouth = river.stations.findIndex((station) => station.inLake);
    // Carry the ribbon a little way into the lake. The rendered lake polygon is
    // slightly narrower than the carved basin, so a one-station overlap can
    // leave a strip of shore between the stream and the open water.
    const end =
      mouth > 0 ? Math.min(river.stations.length, mouth + MOUTH_STATIONS) : river.stations.length;
    const stations = river.stations.slice(0, end);
    if (stations.length >= 2) {
      this.addRiverStrip(stations, positions, normals, shores, flows, indices);
    }
  }

  private addRiverStrip(
    stations: RiverStation[],
    positions: number[],
    normals: number[],
    shores: number[],
    flows: number[],
    indices: number[],
  ): void {
    const base = positions.length / 3;
    // Widen the ribbon briefly past the shore so the mouth meets the lake as a
    // small estuary instead of squeezing through a notch in the bank.
    const firstWet = stations.findIndex((station) => station.inLake);

    for (let i = 0; i < stations.length; i++) {
      const station = stations[i];
      const prev = stations[Math.max(0, i - 1)];
      const next = stations[Math.min(stations.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const length = Math.hypot(dx, dz) || 1;
      const flowX = dx / length;
      const flowZ = dz / length;
      let half = station.width / 2;
      if (firstWet >= 0 && i >= firstWet) {
        const k = i - firstWet;
        const fan =
          k <= 4 ? 1 + 0.9 * (k / 4) : 1 + 0.9 * Math.max(0, 1 - (k - 4) / 4);
        half *= fan;
      }
      const leftX = station.x - flowZ * half;
      const leftZ = station.z + flowX * half;
      const rightX = station.x + flowZ * half;
      const rightZ = station.z - flowX * half;
      // The final station overlaps the lake slightly; keeping it just above the
      // lake plane prevents z-fighting while closing the shoreline gap.
      const y = station.level + (station.inLake ? 0.02 : 0);

      // Left edge, centre, right edge: the centre keeps the deep colour while
      // the edges get the shallow shore tint.
      positions.push(leftX, y, leftZ);
      positions.push(station.x, y, station.z);
      positions.push(rightX, y, rightZ);
      for (let k = 0; k < 3; k++) normals.push(0, 1, 0);
      shores.push(1, 0, 1);
      flows.push(flowX, flowZ, flowX, flowZ, flowX, flowZ);
    }

    for (let i = 0; i < stations.length - 1; i++) {
      const a = base + i * 3;
      const b = a + 3;
      // Counter-clockwise seen from above.
      indices.push(a, b, b + 1, a, b + 1, a + 1);
      indices.push(a + 1, b + 1, b + 2, a + 1, b + 2, a + 2);
    }
  }
}
