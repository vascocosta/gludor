import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from "three";

const vertexShader = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 zenithColor;
  uniform vec3 horizonColor;
  uniform vec3 sunColor;
  uniform vec3 sunDirection;
  varying vec3 vWorldPosition;

  void main() {
    vec3 direction = normalize(vWorldPosition);
    float height = clamp(direction.y, 0.0, 1.0);
    vec3 color = mix(horizonColor, zenithColor, pow(height, 0.55));

    float sun = max(dot(direction, normalize(sunDirection)), 0.0);
    color += sunColor * pow(sun, 1600.0) * 7.0;
    color += sunColor * pow(sun, 16.0) * 0.16;

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class SkyDome {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly zenith = new Color(0x2d6eae);
  private readonly horizon = new Color(0xcfe8f7);
  private readonly sun = new Color(0xfff2d2);

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        zenithColor: { value: this.zenith.clone() },
        horizonColor: { value: this.horizon.clone() },
        sunColor: { value: this.sun.clone() },
        sunDirection: { value: new Vector3(0, 1, 0) },
      },
      side: BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new Mesh(new SphereGeometry(70000, 32, 18), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  setSun(direction: Vector3, intensity: number): void {
    (this.material.uniforms.sunDirection.value as Vector3).copy(direction);
    const warm = 1 - Math.min(1, Math.max(0, direction.y) / 0.6);
    const zenith = new Color(0x2d6eae).lerp(new Color(0x1d3e69), Math.min(1, warm * 0.7));
    const horizon = new Color(0xd7ecfa).lerp(new Color(0xf3b477), warm * 0.7);
    (this.material.uniforms.zenithColor.value as Color).copy(zenith);
    (this.material.uniforms.horizonColor.value as Color).copy(horizon);
    (this.material.uniforms.sunColor.value as Color)
      .copy(new Color(0xfff4dc))
      .lerp(new Color(0xff9a4d), warm * 0.4)
      .multiplyScalar(intensity);
  }

  get horizonColor(): Color {
    return this.material.uniforms.horizonColor.value as Color;
  }
}
