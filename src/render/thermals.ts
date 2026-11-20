import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Points,
  PointsMaterial,
} from "three";
import { mulberry32 } from "../core/rng";
import type { Thermal } from "../sim/lift";

const PARTICLES_PER_THERMAL = 26;

function makeSpriteTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.65)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new CanvasTexture(canvas);
}

interface Particle {
  thermal: number;
  phase: number;
  radius: number;
  speed: number;
  heightPhase: number;
}

export class ThermalParticles {
  readonly group = new Group();
  private points: Points | null = null;
  private readonly particles: Particle[] = [];
  private readonly texture = makeSpriteTexture();
  private visible = true;

  build(thermals: Thermal[], seed = 1, center?: { x: number; z: number }, radius = 14000): void {
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      this.points = null;
    }
    this.particles.length = 0;

    const rng = mulberry32(seed + 313);
    const included: number[] = [];
    for (let t = 0; t < thermals.length; t++) {
      const thermal = thermals[t];
      if (center && Math.hypot(thermal.x - center.x, thermal.z - center.z) > radius) continue;
      included.push(t);
    }

    const count = included.length * PARTICLES_PER_THERMAL;
    const positions = new Float32Array(count * 3);

    for (const t of included) {
      for (let i = 0; i < PARTICLES_PER_THERMAL; i++) {
        this.particles.push({
          thermal: t,
          phase: rng() * Math.PI * 2,
          radius: 0.1 + rng() * 0.85,
          speed: 0.25 + rng() * 0.5,
          heightPhase: rng(),
        });
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    const material = new PointsMaterial({
      size: 5,
      sizeAttenuation: true,
      map: this.texture,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: AdditiveBlending,
      color: 0xdff4ff,
    });
    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = this.visible;
    this.group.add(this.points);

    this.update(thermals, 0);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.points) this.points.visible = visible;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(thermals: Thermal[], time: number): void {
    if (!this.points) return;
    const attribute = this.points.geometry.getAttribute("position") as BufferAttribute;
    const positions = attribute.array as Float32Array;

    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];
      const thermal = thermals[particle.thermal];
      if (!thermal) continue;

      const life = (time * 0.035 * particle.speed + particle.heightPhase) % 1;
      const height = thermal.base + 30 + life * (thermal.top - thermal.base - 80);
      const radius = thermal.radius * (0.35 + life * 0.55) * particle.radius;
      const angle = particle.phase + time * particle.speed * 0.35 + life * 2.4;

      positions[i * 3] = thermal.x + Math.cos(angle) * radius;
      positions[i * 3 + 1] = height;
      positions[i * 3 + 2] = thermal.z + Math.sin(angle) * radius;
    }

    attribute.needsUpdate = true;
  }
}
