import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  Object3D,
  Vector3,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { WORLD } from "../config";
import { smoothstep } from "../core/math";
import { mulberry32 } from "../core/rng";
import type { Terrain } from "../sim/terrain";
import type { CloudShadowSource } from "./clouds";

const MAP_SIZE = 2048;
// The shadow map follows the glider. A 32 km window is wide enough that all
// ground in useful view is covered, while still being soft and cheap to bake.
const WINDOW_SIZE = 32000;
const HALF = WINDOW_SIZE / 2;
const BLOB_ALPHA = 0.34;
const BLOB_COUNT = 5;

/**
 * Soft, baked cloud shadows.
 *
 * A real shadow map wide enough to cover the whole flying area would be far
 * too coarse for the glider and much too expensive. Instead the cloud
 * footprints are projected onto a small coverage texture along the sun
 * direction once per weather change, then sampled by the ground materials.
 * The texture is deliberately soft: cumulus shadows are wide and diffuse at
 * soaring altitudes, not crisp silhouettes.
 */
export class CloudShadows {
  readonly texture: CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mapUniform: { value: CanvasTexture };
  private readonly rectUniform = { value: new Vector4(-HALF, -HALF, 1 / WINDOW_SIZE, 0) };
  private readonly strengthUniform = { value: 0 };

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = MAP_SIZE;
    this.canvas.height = MAP_SIZE;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable for cloud shadows");
    this.ctx = ctx;

    this.texture = new CanvasTexture(this.canvas);
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.colorSpace = NoColorSpace;
    this.mapUniform = { value: this.texture };
  }

  /** Re-project the current cloud field for the current sun position. */
  build(
    sources: CloudShadowSource[],
    sunDirection: Vector3,
    terrain: Terrain,
    centerX: number,
    centerZ: number,
  ): void {
    const rectX = centerX - HALF;
    const rectZ = centerZ - HALF;
    this.rectUniform.value.set(rectX, rectZ, 1 / WINDOW_SIZE, 0);

    const ctx = this.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    const sunY = Math.max(0.001, sunDirection.y);
    // Low sun makes shadows extremely long and weak. Fade them out rather
    // than stretching them across the whole map.
    this.strengthUniform.value = smoothstep(0.07, 0.24, sunY) * 0.62;

    if (sunY > 0.06 && sources.length > 0) {
      const elongation = Math.min(2.2, 1 / Math.max(0.42, sunY));
      // Direction the shadows fall, in canvas space (x right, y = +z).
      const angle = Math.atan2(-sunDirection.z, -sunDirection.x);
      const rng = mulberry32(WORLD.seed + 8081);

      ctx.globalCompositeOperation = "lighter";

      for (const source of sources) {
        const ground = terrain.heightAt(source.x, source.z);
        const drop = Math.max(140, source.baseY + source.height * 0.2 - ground);
        const reach = drop / sunY;
        const sx = source.x - sunDirection.x * reach;
        const sz = source.z - sunDirection.z * reach;

        const px = ((sx - rectX) / WINDOW_SIZE) * MAP_SIZE;
        const py = ((sz - rectZ) / WINDOW_SIZE) * MAP_SIZE;
        const radius = (source.radius / WINDOW_SIZE) * MAP_SIZE;

        // The soft shadow can still overlap the window even when its centre
        // is a little outside, so use a generous rejection margin.
        if (px < -radius * 2.5 || px > MAP_SIZE + radius * 2.5 || py < -radius * 2.5 || py > MAP_SIZE + radius * 2.5) {
          continue;
        }

        // A handful of overlapping soft blobs gives the shadow an irregular,
        // slightly ragged edge instead of a perfect ellipse.
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(angle);
        ctx.scale(elongation, 1);

        for (let i = 0; i < BLOB_COUNT; i++) {
          const ox = (rng() * 2 - 1) * radius * 0.42;
          const oy = (rng() * 2 - 1) * radius * 0.34;
          const r = radius * (0.58 + rng() * 0.42);
          const gradient = ctx.createRadialGradient(ox, oy, r * 0.15, ox, oy, r);
          gradient.addColorStop(0, `rgba(255,255,255,${BLOB_ALPHA})`);
          gradient.addColorStop(0.55, `rgba(255,255,255,${BLOB_ALPHA * 0.62})`);
          gradient.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(ox, oy, r, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }
    }

    this.texture.needsUpdate = true;
  }

  /**
   * Inject the shadow lookup into a standard material. Only direct sunlight
   * is reduced, so shadowed ground still receives the blue sky fill that
   * keeps cumulus shadows from looking black.
   */
  inject(shader: WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uCloudShadowMap = this.mapUniform;
    shader.uniforms.uCloudShadowRect = this.rectUniform;
    shader.uniforms.uCloudShadowStrength = this.strengthUniform;

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCloudWorld;")
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        {
          vec4 cloudWorld = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            cloudWorld = instanceMatrix * cloudWorld;
          #endif
          vCloudWorld = (modelMatrix * cloudWorld).xyz;
        }`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uCloudShadowMap;
        uniform vec4 uCloudShadowRect;
        uniform float uCloudShadowStrength;
        varying vec3 vCloudWorld;`,
      )
      .replace(
        "#include <lights_fragment_begin>",
        `#include <lights_fragment_begin>
        {
          vec2 cloudUv = (vCloudWorld.xz - uCloudShadowRect.xy) * uCloudShadowRect.z;
          float inside =
            step(0.0, cloudUv.x) * step(cloudUv.x, 1.0) *
            step(0.0, cloudUv.y) * step(cloudUv.y, 1.0);
          float cloud = texture2D(uCloudShadowMap, clamp(cloudUv, 0.0, 1.0)).r * inside;
          float shade = 1.0 - uCloudShadowStrength * cloud;
          reflectedLight.directDiffuse *= shade;
          reflectedLight.directSpecular *= shade;
        }`,
      );
  }

  apply(material: MeshStandardMaterial): void {
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      this.inject(shader);
    };
    material.customProgramCacheKey = () => "cloud-shadow";
    material.needsUpdate = true;
  }

  applyToObject(root: Object3D): void {
    const seen = new Set<MeshStandardMaterial>();
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof MeshStandardMaterial) || seen.has(material)) continue;
        seen.add(material);
        this.apply(material);
      }
    });
  }
}
