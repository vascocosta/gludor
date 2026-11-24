import {
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  HemisphereLight,
  MeshBasicMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Mesh,
  Vector3,
  WebGLRenderer,
  ACESFilmicToneMapping,
  Euler,
  Quaternion,
} from "three";
import { CAMERA_MODES, COCKPIT_VIEW, FREE_CAMERA, WORLD, type CameraMode } from "../config";
import { clamp, DEG, lookQuaternion } from "../core/math";
import type { Simulation } from "../sim/simulation";
import type { Terrain } from "../sim/terrain";
import { buildingHeightAt } from "../sim/towns";
import { Airfield, createBackdrop, TreeField } from "./props";
import { AirfieldField } from "./airfields";
import { CloudField } from "./clouds";
import { CloudShadows } from "./cloudShadows";
import { GliderMesh, GLIDER_MODEL_DROP } from "./gliderMesh";
import { RiverChannelField } from "./riverBanks";
import { SkyDome } from "./sky";
import { TerrainStreamer } from "./terrainMesh";
import { ThermalParticles } from "./thermals";
import { TownField } from "./towns";
import { TowPlaneMesh } from "./towplaneMesh";
import { WaterField } from "./water";

/**
 * Mirrors three's ACESFilmicToneMapping on the CPU. Fog is applied after the
 * tone-mapping and colour-space chunks, so the fog colour has to be the
 * tone-mapped version of the horizon colour to match the sky.
 */
function toneMapped(color: Color, exposure: number, out: Color): Color {  const s = exposure / 0.6;
  const r = color.r * s;
  const g = color.g * s;
  const b = color.b * s;

  const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;

  const fit = (v: number): number => {
    const a = v * (v + 0.0245786) - 0.000090537;
    const d = v * (0.983729 * v + 0.432951) + 0.238081;
    return a / d;
  };
  const fr = fit(ir);
  const fg = fit(ig);
  const fb = fit(ib);

  return out.setRGB(
    clamp(1.60475 * fr - 0.53108 * fg - 0.07367 * fb, 0, 1),
    clamp(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb, 0, 1),
    clamp(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb, 0, 1),
  );
}

/** Shoulder-check angle used by the cockpit look toggles. */
const LOOK_SIDE_YAW = 80 * DEG;

export class WorldRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly glider = new GliderMesh();
  readonly towPlane = new TowPlaneMesh();
  readonly sky = new SkyDome();
  readonly clouds = new CloudField();
  readonly cloudShadows = new CloudShadows();
  readonly thermalParticles = new ThermalParticles();
  readonly water: WaterField;
  readonly airfield: Airfield;
  readonly towns: TownField;
  readonly townAirfields: AirfieldField;

  cameraMode: CameraMode = "chase";
  orbitYaw = 0;
  orbitPitch = 0.2;
  orbitDistance = 18;
  lookYaw = 0;
  lookPitch = 0;
  private lookTargetYaw = 0;
  private lookSide: -1 | 0 | 1 = 0;
  /** True while the detached inspection camera is driving the view. */
  freeCamera = false;

  private freeYaw = 0;
  private freePitch = 0;
  private readonly freeView = new Vector3();
  private readonly freeRight = new Vector3();
  private readonly freeMove = new Vector3();

  private readonly terrain: Terrain;
  private readonly terrainStream: TerrainStreamer;
  private readonly trees: TreeField;
  private readonly sun: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private readonly backdrop: Mesh;
  private readonly cable: Mesh;
  private readonly cableStart = new Vector3();
  private readonly cableEnd = new Vector3();
  private readonly cableDelta = new Vector3();
  private readonly cableUp = new Vector3(0, 1, 0);
  private readonly cableNose = new Vector3(0, 0, -2.4);
  private readonly sunDirection = new Vector3(0, 0.8, 0.6);
  private readonly fieldTarget = new Vector3();
  private readonly chaseTarget = new Vector3();
  private readonly desired = new Vector3();
  private readonly lookTarget = new Vector3();
  private readonly offset = new Vector3();
  private readonly lookOffset = new Quaternion();
  private readonly shakeEuler = new Euler();
  private menuTime = 0;
  private cameraInitialized = false;
  private lastMode: CameraMode = "chase";
  private lastCloudVersion = -1;
  private lastLiftVersion = -1;
  private readonly shadowCenter = new Vector3(Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY);

  constructor(canvas: HTMLCanvasElement, terrain: Terrain) {
    this.terrain = terrain;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera = new PerspectiveCamera(64, window.innerWidth / window.innerHeight, 0.08, 90000);
    this.camera.position.set(0, 450, 500);

    this.scene.fog = new Fog(0xd7ecfa, 7500, 30000);
    this.scene.add(this.sky.mesh);
    this.sky.mesh.position.copy(this.camera.position);

    this.backdrop = createBackdrop(this.scene);
    this.terrainStream = new TerrainStreamer(this.scene, this.cloudShadows);
    this.terrainStream.update(this.camera.position, 600);
    new RiverChannelField(terrain, this.terrainStream.material, this.scene);
    this.trees = new TreeField(terrain, this.scene, WORLD.seed);
    this.cloudShadows.applyToObject(this.trees.group);
    this.trees.update(this.camera.position, 500);
    this.water = new WaterField(this.scene, this.cloudShadows, this.sky.horizonColor);
    this.water.update(this.camera.position, 0);
    this.towns = new TownField(terrain, this.scene);
    this.cloudShadows.applyToObject(this.towns.group);
    this.towns.update(this.camera.position, 500);
    this.townAirfields = new AirfieldField(
      this.scene,
      this.cloudShadows,
      this.terrainStream.material,
    );
    this.airfield = new Airfield(terrain);
    this.cloudShadows.applyToObject(this.airfield.group);
    this.scene.add(this.airfield.group);
    this.scene.add(this.glider.group);
    this.towPlane.group.visible = false;
    this.scene.add(this.towPlane.group);
    this.scene.add(this.clouds.group);
    this.scene.add(this.thermalParticles.group);

    this.hemi = new HemisphereLight(0xc4dcff, 0x4f5a3b, 1.1);
    this.scene.add(this.hemi);

    this.sun = new DirectionalLight(0xfff1d5, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 400;
    this.sun.shadow.camera.far = 6000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    const shadowCamera = this.sun.shadow.camera as OrthographicCamera;
    shadowCamera.left = -260;
    shadowCamera.right = 260;
    shadowCamera.top = 260;
    shadowCamera.bottom = -260;
    shadowCamera.updateProjectionMatrix();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // A thin cylinder rather than a Line: line width is capped at one pixel
    // on most drivers, which makes a 60 m tow rope all but invisible.
    this.cable = new Mesh(
      new CylinderGeometry(0.035, 0.035, 1, 5, 1, true),
      new MeshBasicMaterial({ color: 0xf5c518 }),
    );
    this.cable.frustumCulled = false;
    this.cable.visible = false;
    this.scene.add(this.cable);

    this.fieldTarget.set(0, terrain.heightAt(0, 0) + 18, 0);
    this.glider.setCockpitView(false);
  }

  syncWeather(sim: Simulation): void {
    this.clouds.configure(sim.weather.cloudBase);

    const hour = sim.weather.timeOfDay;
    const elevation = Math.max(6, 68 - Math.abs(hour - 13) * 13) * DEG;
    const azimuth = (180 + (hour - 13) * 12) * DEG;
    this.sunDirection.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      -Math.cos(azimuth) * Math.cos(elevation),
    );
    this.glider.setSunDirection(this.sunDirection);

    const daylight = clamp(Math.sin(elevation), 0, 1);
    this.sun.color.copy(new Color(0xfff1d5)).lerp(new Color(0xff9d59), 1 - daylight);
    this.sun.intensity = 1.2 + daylight * 1.8;
    this.clouds.setSun(this.sunDirection, this.sun.color, this.sun.intensity);
    this.hemi.intensity = 0.65 + daylight * 0.55;
    this.sky.setSun(this.sunDirection, 0.65 + daylight * 0.5);
    // Three converts the fog colour to display space when uploading the
    // uniform, so tone-map the horizon colour here to match the rendered sky.
    toneMapped(this.sky.horizonColor, this.renderer.toneMappingExposure, this.scene.fog!.color);
    this.airfield.update(new Vector3(0, 0, 0));

    // The cloud field was cleared above and the lift field may have been
    // rebuilt; refresh the derived helpers on the next rendered frame.
    this.lastCloudVersion = -1;
    this.lastLiftVersion = -1;
    this.shadowCenter.set(Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY);
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    if (mode === "orbit") {
      // Start behind the current heading.
      this.orbitYaw = 0;
    }
    this.cameraInitialized = false;
  }

  cycleCamera(): CameraMode {
    const index = CAMERA_MODES.indexOf(this.cameraMode);
    this.setCameraMode(CAMERA_MODES[(index + 1) % CAMERA_MODES.length]);
    return this.cameraMode;
  }

  /** Detach the view from the glider, starting from wherever it is now. */
  enterFreeCamera(): void {
    this.freeCamera = true;
    const euler = new Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    this.freeYaw = euler.y;
    this.freePitch = clamp(euler.x, -1.45, 1.45);
    this.camera.quaternion.copy(lookQuaternion(this.freeYaw, this.freePitch));
  }

  /** Return to the selected flight view. */
  exitFreeCamera(): void {
    this.freeCamera = false;
    this.cameraInitialized = false;
  }

  /**
   * Move the detached camera. `forward`, `strafe`, and `rise` are in [-1, 1];
   * the camera moves along its view direction, strafes horizontally, and rises
   * in world space.
   */
  moveFreeCamera(dt: number, forward: number, strafe: number, rise: number, boost: boolean): void {
    if (!this.freeCamera) return;

    const quaternion = lookQuaternion(this.freeYaw, this.freePitch);
    this.camera.quaternion.copy(quaternion);

    const speed = FREE_CAMERA.speed * (boost ? FREE_CAMERA.boost : 1);
    const cos = Math.cos(this.freeYaw);
    const sin = Math.sin(this.freeYaw);

    this.freeView.set(0, 0, -1).applyQuaternion(quaternion).multiplyScalar(forward);
    this.freeRight.set(cos, 0, -sin).multiplyScalar(strafe);
    this.freeMove.copy(this.freeView).add(this.freeRight);
    this.freeMove.y += rise;

    if (this.freeMove.lengthSq() > 1e-9) {
      this.freeMove.normalize().multiplyScalar(speed * dt);
      this.camera.position.add(this.freeMove);
    }

    const floor =
      this.solidHeightAt(this.camera.position.x, this.camera.position.z) + FREE_CAMERA.clearance;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
  }

  resetLook(): void {
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookTargetYaw = 0;
    this.lookSide = 0;
    if (this.freeCamera) this.freePitch = 0;
  }

  /**
   * Toggle a shoulder check in the cockpit. Pressing the same side again
   * returns to forward; pressing the other side switches across.
   */
  toggleLook(side: -1 | 1): "left" | "right" | "forward" | null {
    if (this.freeCamera || this.cameraMode !== "cockpit") return null;

    if (this.lookSide === side) {
      this.lookSide = 0;
      this.lookTargetYaw = 0;
    } else {
      this.lookSide = side;
      this.lookTargetYaw = side < 0 ? LOOK_SIDE_YAW : -LOOK_SIDE_YAW;
    }

    return this.lookSide === 0 ? "forward" : this.lookSide < 0 ? "left" : "right";
  }

  dragLook(dx: number, dy: number): void {
    if (this.freeCamera) {
      this.freeYaw -= dx * 0.004;
      this.freePitch = clamp(this.freePitch - dy * 0.003, -1.45, 1.45);
    } else if (this.cameraMode === "cockpit") {
      this.lookYaw -= dx * 0.004;
      this.lookPitch = clamp(this.lookPitch - dy * 0.003, -0.9, 0.9);
      this.lookTargetYaw = this.lookYaw;
      this.lookSide = 0;
    } else if (this.cameraMode === "orbit") {
      this.orbitYaw -= dx * 0.006;
      this.orbitPitch = clamp(this.orbitPitch + dy * 0.004, -0.15, 1.25);
    }
  }

  toggleThermalHelpers(): boolean {
    this.thermalParticles.setVisible(!this.thermalParticles.isVisible);
    return this.thermalParticles.isVisible;
  }

  setThermalHelpers(visible: boolean): void {
    this.thermalParticles.setVisible(visible);
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(width, height);
  }

  render(sim: Simulation, dt: number, menu: boolean): void {
    if (menu) this.menuTime += dt;

    this.glider.group.position.copy(sim.position);
    this.glider.group.quaternion.copy(sim.orientation);
    this.glider.setControls(
      sim.controls.elevator,
      sim.controls.aileron,
      sim.controls.rudder,
      sim.controls.brake,
    );
    this.glider.updateFlex(sim.gLoad, dt);
    this.glider.updateInstruments(dt, sim.ias * 3.6, sim.msl, sim.varioTE);

    this.towPlane.group.visible = sim.towPlane.visible;
    if (sim.towPlane.visible) {
      this.towPlane.group.position.copy(sim.towPlane.position);
      this.towPlane.group.quaternion.copy(sim.towPlane.orientation);
      this.towPlane.setProp(sim.towPlane.propAngle);
    }

    if (sim.cableAttached) {
      this.cableStart.copy(this.cableNose).applyQuaternion(sim.orientation).add(sim.position);
      this.cableEnd.copy(sim.launch === "tow" ? sim.towPlane.hook : sim.winchPosition);
      this.cableDelta.subVectors(this.cableEnd, this.cableStart);
      const length = this.cableDelta.length();
      if (length > 0.05) {
        this.cable.position.copy(this.cableStart).addScaledVector(this.cableDelta, 0.5);
        this.cable.quaternion.setFromUnitVectors(
          this.cableUp,
          this.cableDelta.multiplyScalar(1 / length),
        );
        this.cable.scale.set(1, length, 1);
        this.cable.visible = true;
      } else {
        this.cable.visible = false;
      }
    } else {
      this.cable.visible = false;
    }

    this.airfield.update(sim.wind);
    this.updateSunShadow(sim);
    this.updateCamera(sim, dt, menu);

    // Everything procedural follows the viewer: terrain tiles, woodland,
    // clouds, thermal markers, and the shadow bake all use the same window.
    this.terrainStream.update(this.camera.position);
    // Rebuilding both streamed fields in the same frame doubles the spike, so
    // let one rebuild finish before starting the other.
    if (this.towns.isBuilding) {
      this.towns.update(this.camera.position, 2);
    } else if (this.trees.isBuilding) {
      this.trees.update(this.camera.position, 2);
    } else {
      this.towns.update(this.camera.position, 2);
      if (!this.towns.isBuilding) this.trees.update(this.camera.position, 2);
    }
    this.townAirfields.update(this.camera.position, sim.wind);
    this.water.update(this.camera.position, menu ? this.menuTime : sim.time);
    this.clouds.update(this.camera.position, sim.liftField, 2);

    if (sim.liftField.version !== this.lastLiftVersion) {
      this.lastLiftVersion = sim.liftField.version;
      this.thermalParticles.build(sim.liftField.thermals, WORLD.seed, sim.position, 14000);
    }
    this.thermalParticles.update(sim.liftField.thermals, sim.time);

    const shadowMoved =
      Math.hypot(
        this.camera.position.x - this.shadowCenter.x,
        this.camera.position.z - this.shadowCenter.z,
      ) > 3500;
    if (
      (this.clouds.version !== this.lastCloudVersion || shadowMoved) &&
      !this.clouds.busy
    ) {
      this.lastCloudVersion = this.clouds.version;
      this.shadowCenter.copy(this.camera.position);
      this.cloudShadows.build(
        this.clouds.shadowSources,
        this.sunDirection,
        this.terrain,
        this.camera.position.x,
        this.camera.position.z,
      );
    }

    this.glider.setCockpitView(this.cameraMode === "cockpit" && !menu && !this.freeCamera);
    this.sky.mesh.position.copy(this.camera.position);
    // Keep the far ground plane centred on the camera so the horizon is always
    // filled, however far the glider has flown from the field.
    this.backdrop.position.x = this.camera.position.x;
    this.backdrop.position.z = this.camera.position.z;

    this.renderer.render(this.scene, this.camera);
  }

  private updateSunShadow(sim: Simulation): void {
    const centre = this.freeCamera ? this.camera.position : sim.position;
    this.sun.position.copy(centre).addScaledVector(this.sunDirection, 3000);
    this.sun.target.position.copy(centre);
    this.sun.target.updateMatrixWorld();
  }

  /** Ground, water, or a roof - whatever the camera must not sink into. */
  private solidHeightAt(x: number, z: number): number {
    const ground = this.terrain.surfaceHeightAt(x, z);
    const roof = buildingHeightAt(x, z);
    return roof !== null && roof > ground ? roof : ground;
  }

  private updateLook(dt: number): void {
    if (Math.abs(this.lookYaw - this.lookTargetYaw) < 0.0005) {
      this.lookYaw = this.lookTargetYaw;
      return;
    }
    this.lookYaw +=
      (this.lookTargetYaw - this.lookYaw) * (1 - Math.exp(-dt / 0.13));
  }

  private updateCamera(sim: Simulation, dt: number, menu: boolean): void {
    if (this.freeCamera) {
      this.camera.quaternion.copy(lookQuaternion(this.freeYaw, this.freePitch));
      this.setFov(65);
      this.setNear(0.08);
      this.glider.setCockpitView(false);
      return;
    }

    if (menu) {
      const yaw = this.menuTime * 0.045;
      const distance = 230;
      const pitch = 0.22;
      const target = this.fieldTarget;
      this.camera.position.set(
        target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
        target.y + Math.sin(pitch) * distance,
        target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
      );
      this.camera.lookAt(target);
      this.setFov(52);
      this.setNear(0.08);
      this.glider.setCockpitView(false);
      return;
    }

    if (this.cameraMode !== this.lastMode) {
      this.cameraInitialized = false;
      this.lastMode = this.cameraMode;
    }

    if (this.cameraMode === "cockpit") {
      const eye = new Vector3(
        0,
        COCKPIT_VIEW.eyeHeight - GLIDER_MODEL_DROP,
        COCKPIT_VIEW.eyeForward,
      ).applyQuaternion(sim.orientation);
      this.camera.position.copy(sim.position).add(eye);

      this.updateLook(dt);
      lookQuaternion(this.lookYaw, this.lookPitch, this.lookOffset);
      this.camera.quaternion.copy(sim.orientation).multiply(this.lookOffset);

      const shake = sim.weather.turbulence * 0.004 + sim.stall * 0.012;
      if (shake > 0.0001) {
        const t = sim.time;
        this.shakeEuler.set(
          Math.sin(t * 13.1) * shake + Math.sin(t * 31.7) * shake * 0.4,
          Math.sin(t * 9.7) * shake,
          Math.sin(t * 17.3) * shake * 0.5,
        );
        this.camera.quaternion.multiply(new Quaternion().setFromEuler(this.shakeEuler));
      }
      this.setFov(72);
      // The cockpit glass sits just a few centimetres overhead: a nearer clip
      // plane keeps it from being cut away when the pilot looks straight up.
      this.setNear(0.03);
      return;
    }

    if (this.cameraMode === "orbit") {
      const target = this.lookTarget.copy(sim.position);
      target.y += 1.8 - GLIDER_MODEL_DROP;
      if (!this.cameraInitialized) {
        this.orbitYaw = -sim.heading * DEG;
        this.cameraInitialized = true;
      }
      const cosPitch = Math.cos(this.orbitPitch);
      this.camera.position.set(
        target.x + Math.sin(this.orbitYaw) * cosPitch * this.orbitDistance,
        target.y + Math.sin(this.orbitPitch) * this.orbitDistance,
        target.z + Math.cos(this.orbitYaw) * cosPitch * this.orbitDistance,
      );
      const ground = this.solidHeightAt(this.camera.position.x, this.camera.position.z) + 1.5;
      if (this.camera.position.y < ground) this.camera.position.y = ground;
      this.camera.lookAt(target);
      this.setFov(60);
      this.setNear(0.08);
      return;
    }

    // Chase camera: position behind the aircraft but keep the horizon level.
    this.offset.set(0, 3.0, 13.5).applyQuaternion(sim.orientation);
    this.desired.copy(sim.position).add(this.offset);
    const ground = this.solidHeightAt(this.desired.x, this.desired.z) + 2.5;
    if (this.desired.y < ground) this.desired.y = ground;

    if (!this.cameraInitialized) {
      this.camera.position.copy(this.desired);
      this.cameraInitialized = true;
    } else {
      this.camera.position.lerp(this.desired, 1 - Math.exp(-dt * 3.5));
    }

    this.offset.set(0, 0, -1).applyQuaternion(sim.orientation);
    this.chaseTarget.copy(sim.position).addScaledVector(this.offset, 8);
    this.chaseTarget.y += 1.2;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.chaseTarget);
    this.setFov(62);
    this.setNear(0.08);
  }

  private setFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private setNear(near: number): void {
    if (Math.abs(this.camera.near - near) > 1e-6) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }
}
