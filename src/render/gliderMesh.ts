import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import { mulberry32 } from "../core/rng";

/** Pearl-white gelcoat, cobalt trim, and navy detail on the blue parts. */
const PEARL = new Color(0xf4f5ef);
const WHITE = new Color(0xf7f8f3);
const COBALT = new Color(0x1d4ed8);
const NAVY = new Color(0x0b2a6b);

/** Main wing planform. The span matches the 15 m flight model exactly. */
const WING_ROOT_X = 0.3;
const WING_TIP_X = 7.25;
const WING_ROOT_Y = 0;
const WING_TIP_Y = 0.34;
const WING_SPAN = WING_TIP_X - WING_ROOT_X;
const WING_DIHEDRAL_SLOPE = (WING_TIP_Y - WING_ROOT_Y) / WING_SPAN;

/**
 * The flight model's origin rides 0.9 m above the surface, which is a long way
 * up for a glider. Dropping the visual airframe relative to that origin gives
 * the ship a natural stance and lets the main wheel sit half inside the belly
 * instead of dangling below it. Cameras that aim at the airframe subtract it.
 */
export const GLIDER_MODEL_DROP = 0.25;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Cockpit canopy glass. The camera sits inside the shell, so this is drawn as
 * a back face with almost no tint head-on and a soft Fresnel reflection at the
 * edges and over the top. A small sun glint gives it a surface without fogging
 * the view.
 */
const COCKPIT_GLASS_VERTEX = /* glsl */ `
  varying vec3 vViewPosition;
  varying vec3 vViewNormal;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = viewPosition.xyz;
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const COCKPIT_GLASS_FRAGMENT = /* glsl */ `
  uniform vec3 uSunDirection;
  uniform vec3 uTint;
  uniform vec3 uSunColor;

  varying vec3 vViewPosition;
  varying vec3 vViewNormal;

  void main() {
    vec3 viewDir = normalize(-vViewPosition);
    vec3 normal = normalize(vViewNormal);
    if (dot(normal, viewDir) < 0.0) normal = -normal;

    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 2.4);

    vec3 sunView = normalize((viewMatrix * vec4(uSunDirection, 0.0)).xyz);
    vec3 reflection = reflect(-viewDir, normal);
    float glint = pow(max(dot(reflection, sunView), 0.0), 64.0);

    vec3 color = uTint + uSunColor * glint * 0.9;
    float alpha = 0.025 + fresnel * 0.26 + glint * 0.3;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.55));
  }
`;

/** Height of the wing's reference surface at a spanwise station. */
function wingSurfaceY(x: number): number {
  return WING_ROOT_Y + (WING_TIP_Y - WING_ROOT_Y) * clamp01((Math.abs(x) - WING_ROOT_X) / WING_SPAN);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * NACA-style half-thickness distribution, scaled so the peak is half the
 * section's maximum thickness. Sampling this along the chord gives a rounded
 * leading edge and a fine trailing edge instead of a slab.
 */
function halfThickness(u: number, thickness: number): number {
  if (u <= 0 || u >= 1) return 0;
  const naca =
    0.2969 * Math.sqrt(u) -
    0.126 * u -
    0.3516 * u * u +
    0.2843 * u * u * u -
    0.1015 * u * u * u * u;
  return thickness * Math.max(0, 5 * naca);
}

interface LoftOptions {
  side: 1 | -1;
  rootX: number;
  tipX: number;
  rootChord: number;
  tipChord: number;
  rootY: number;
  tipY: number;
  sweep: number;
  rootThickness: number;
  tipThickness: number;
  /** Solid colour for the whole surface (fin, tailplane, winglet). */
  color?: Color;
  /** Span fraction where the blue tip band begins. */
  tipStart?: number;
  sections?: number;
  chordSamples?: number;
}

/**
 * A closed, lofted lifting surface: a family of airfoil sections joined
 * spanwise, with a crisp colour break at the tip. The result shades smoothly
 * from any angle and reads as a real composite wing rather than two quads.
 */
function createLoftedWing(options: LoftOptions): BufferGeometry {
  const {
    side,
    rootX,
    tipX,
    rootChord,
    tipChord,
    rootY,
    tipY,
    sweep,
    rootThickness,
    tipThickness,
    color,
    tipStart,
    sections = 16,
    chordSamples = 14,
  } = options;

  type Station = { t: number; paint: Color };
  const stations: Station[] = [];
  let inserted = false;
  for (let i = 0; i <= sections; i++) {
    const t = i / sections;
    if (tipStart !== undefined && !inserted && t > tipStart) {
      // Duplicate the station: the paint break stays sharp instead of
      // blending blue halfway down the wing.
      stations.push({ t: tipStart, paint: color ?? WHITE });
      stations.push({ t: tipStart, paint: COBALT });
      inserted = true;
    }
    const paint = color ?? (tipStart !== undefined && t > tipStart ? COBALT : WHITE);
    stations.push({ t, paint });
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const ringSize = 2 * (chordSamples + 1);
  const ringBase: number[] = [];

  for (const station of stations) {
    const { t, paint } = station;
    const x = side * lerp(rootX, tipX, t);
    const y = lerp(rootY, tipY, t);
    const chord = lerp(rootChord, tipChord, t);
    const thickness = lerp(rootThickness, tipThickness, t);
    const leadingEdge = -chord / 2 + sweep * t;
    ringBase.push(positions.length / 3);

    for (let j = 0; j <= chordSamples; j++) {
      const u = 0.5 - 0.5 * Math.cos((Math.PI * j) / chordSamples);
      positions.push(x, y + halfThickness(u, thickness), leadingEdge + chord * u);
      colors.push(paint.r, paint.g, paint.b);
    }
    for (let j = chordSamples; j >= 0; j--) {
      const u = 0.5 - 0.5 * Math.cos((Math.PI * j) / chordSamples);
      // Slight camber: the underside is flatter than the upper surface.
      positions.push(x, y - halfThickness(u, thickness) * 0.62, leadingEdge + chord * u);
      colors.push(paint.r, paint.g, paint.b);
    }
  }

  for (let i = 0; i < stations.length - 1; i++) {
    // The duplicated colour-break ring is coincident; skip its degenerate band.
    if (Math.abs(stations[i].t - stations[i + 1].t) < 1e-6) continue;
    const a = ringBase[i];
    const b = ringBase[i + 1];
    for (let k = 0; k < ringSize; k++) {
      const next = (k + 1) % ringSize;
      indices.push(a + k, a + next, b + next, a + k, b + next, b + k);
    }
  }

  const addCap = (base: number, paint: Color, reverse: boolean): void => {
    const centre = new Vector3();
    for (let k = 0; k < ringSize; k++) {
      centre.x += positions[(base + k) * 3];
      centre.y += positions[(base + k) * 3 + 1];
      centre.z += positions[(base + k) * 3 + 2];
    }
    centre.divideScalar(ringSize);
    const centreIndex = positions.length / 3;
    positions.push(centre.x, centre.y, centre.z);
    colors.push(paint.r, paint.g, paint.b);
    for (let k = 0; k < ringSize; k++) {
      const next = (k + 1) % ringSize;
      if (reverse) indices.push(base + k, centreIndex, base + next);
      else indices.push(base + k, base + next, centreIndex);
    }
  };

  addCap(ringBase[0], stations[0].paint, true);
  addCap(ringBase[ringBase.length - 1], stations[stations.length - 1].paint, false);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Thin tapered control surface with its hinge along the leading edge. */
function createTaperedPlate(
  span: number,
  rootChord: number,
  tipChord: number,
  thickness: number,
  sections = 6,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = thickness / 2;

  for (let i = 0; i <= sections; i++) {
    const t = i / sections;
    const x = -span / 2 + span * t;
    const chord = lerp(rootChord, tipChord, t);
    positions.push(x, half, 0, x, half, chord, x, -half, chord, x, -half, 0);
  }

  const quad = (a: number, b: number, c: number, d: number): void => {
    indices.push(a, b, c, a, c, d);
  };
  for (let i = 0; i < sections; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    quad(a, b, b + 1, a + 1); // top
    quad(a + 3, b + 3, b + 2, a + 2); // bottom
    quad(a, a + 3, b + 3, b); // leading edge
    quad(a + 1, b + 1, b + 2, a + 2); // trailing edge
  }

  const last = sections * 4;
  quad(0, 1, 2, 3);
  quad(last, last + 3, last + 2, last + 1);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A rudder: tapered vertically, hinged along the fin's trailing edge. */
function createVerticalPlate(
  height: number,
  rootChord: number,
  tipChord: number,
  thickness: number,
  sections = 6,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = thickness / 2;

  for (let i = 0; i <= sections; i++) {
    const t = i / sections;
    const y = height * t;
    const chord = lerp(rootChord, tipChord, t);
    positions.push(half, y, 0, half, y, chord, -half, y, chord, -half, y, 0);
  }

  const quad = (a: number, b: number, c: number, d: number): void => {
    indices.push(a, b, c, a, c, d);
  };
  for (let i = 0; i < sections; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    quad(a, b, b + 1, a + 1);
    quad(a + 3, b + 3, b + 2, a + 2);
    quad(a, a + 3, b + 3, b);
    quad(a + 1, b + 1, b + 2, a + 2);
  }

  const last = sections * 4;
  quad(0, 1, 2, 3);
  quad(last, last + 3, last + 2, last + 1);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Fuselage stations, nose to tail: [radius, z]. */
const FUSELAGE_PROFILE: Array<[number, number]> = [
  [0.0, -3.35],
  [0.1, -3.3],
  [0.2, -3.19],
  [0.27, -3.0],
  [0.31, -2.74],
  [0.33, -2.34],
  [0.345, -1.8],
  [0.35, -1.2],
  [0.345, -0.6],
  [0.33, 0.0],
  [0.3, 0.6],
  [0.255, 1.2],
  [0.205, 1.8],
  [0.16, 2.3],
  [0.115, 2.7],
  [0.07, 2.95],
  [0.02, 3.05],
  [0.0, 3.06],
];

/** Smooth lathed fuselage with a painted dorsal spine. */
function createFuselageGeometry(): BufferGeometry {
  const profile = FUSELAGE_PROFILE;
  const points = profile.map(([radius, z]) => new Vector2(radius, z));
  const geometry = new LatheGeometry(points, 40);
  geometry.rotateX(Math.PI / 2);

  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const radius = Math.hypot(x, y);
    const spine = radius > 0.02 && y / radius > 0.968 && z > -2.2 && z < 2.8;
    const color = spine ? COBALT : PEARL;
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Moulded instrument dash. The top is a straight rail under the canopy
 * coaming; the lower edge sweeps up in two deep arches for the pilot's knees,
 * leaving a centre stem between them. The stem disappears into the centre
 * console.
 */
function createDashShape(): Shape {
  const half = 0.25;
  const topEdge = 0.113;
  const topHalf = 0.215;
  const shoulderY = 0.088;
  const sideBottom = -0.103;
  const outerBottom = -0.115;
  const archPeak = -0.064;
  const archPeakX = 0.167;
  const stemHalf = 0.1;
  const stemTop = -0.108;
  const stemBottom = -0.232;
  const stemCorner = 0.012;

  const shape = new Shape();
  shape.moveTo(-topHalf, topEdge);
  // Keep the narrower top rail, but turn the upper sides into round
  // shoulders rather than hard chamfers.
  shape.lineTo(topHalf, topEdge);
  shape.quadraticCurveTo(half, topEdge, half, shoulderY);
  shape.lineTo(half, sideBottom);
  shape.quadraticCurveTo(half, outerBottom, half - 0.012, outerBottom);
  shape.quadraticCurveTo(0.205, archPeak, archPeakX, archPeak);
  shape.quadraticCurveTo(0.128, archPeak, stemHalf, stemTop);
  shape.lineTo(stemHalf, stemBottom + stemCorner);
  shape.quadraticCurveTo(stemHalf, stemBottom, stemHalf - stemCorner, stemBottom);
  shape.lineTo(-stemHalf + stemCorner, stemBottom);
  shape.quadraticCurveTo(-stemHalf, stemBottom, -stemHalf, stemBottom + stemCorner);
  shape.lineTo(-stemHalf, stemTop);
  shape.quadraticCurveTo(-0.128, archPeak, -archPeakX, archPeak);
  shape.quadraticCurveTo(-0.205, archPeak, -half + 0.012, outerBottom);
  shape.quadraticCurveTo(-half, outerBottom, -half, sideBottom);
  shape.lineTo(-half, shoulderY);
  shape.quadraticCurveTo(-half, topEdge, -topHalf, topEdge);
  shape.closePath();
  return shape;
}

/**
 * Centre console between the pilot's legs. Its side profile slopes up from
 * under the dash toward the pilot, and the extrusion is re-mapped to run along
 * Z so it reads as a tunnel on the cockpit floor.
 */
function createConsoleGeometry(): BufferGeometry {
  const zFront = -1.31;
  const zRear = -0.84;
  const width = 0.16;
  const rearRadius = 0.02;

  const shape = new Shape();
  shape.moveTo(zFront, 0);
  shape.lineTo(zFront, 0.012);
  shape.lineTo(zRear - rearRadius, 0.042);
  shape.quadraticCurveTo(zRear, 0.042, zRear, 0.042 - rearRadius);
  shape.lineTo(zRear, 0);
  shape.closePath();

  const geometry = new ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.008,
    bevelSegments: 2,
    curveSegments: 6,
  });

  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const sx = position.getX(i);
    const sy = position.getY(i);
    const sz = position.getZ(i);
    position.setXYZ(i, width / 2 - sz, sy + 0.35, sx);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Cockpit floor: dark textured flocking with baked ambient occlusion. The
 * texture's top edge is the front of the deck (under the dash), so the
 * contact shadows sit where the dash and console meet the floor.
 */
function createDeckTexture(): CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");

  context.fillStyle = "#242a30";
  context.fillRect(0, 0, size, size);

  const pool = context.createRadialGradient(
    size * 0.5,
    size * 0.58,
    size * 0.04,
    size * 0.5,
    size * 0.58,
    size * 0.7,
  );
  pool.addColorStop(0, "rgba(58,66,74,0.85)");
  pool.addColorStop(0.55, "rgba(38,44,50,0.45)");
  pool.addColorStop(1, "rgba(10,12,14,0.85)");
  context.fillStyle = pool;
  context.fillRect(0, 0, size, size);

  const underDash = context.createLinearGradient(0, 0, 0, size * 0.34);
  underDash.addColorStop(0, "rgba(4,6,8,0.82)");
  underDash.addColorStop(0.55, "rgba(4,6,8,0.35)");
  underDash.addColorStop(1, "rgba(4,6,8,0)");
  context.fillStyle = underDash;
  context.fillRect(0, 0, size, size * 0.34);

  for (const u of [0.335, 0.665]) {
    const x = u * size;
    const band = context.createLinearGradient(x - 36, 0, x + 36, 0);
    band.addColorStop(0, "rgba(5,7,9,0)");
    band.addColorStop(0.5, "rgba(5,7,9,0.5)");
    band.addColorStop(1, "rgba(5,7,9,0)");
    context.fillStyle = band;
    context.fillRect(x - 36, 0, 72, size);
  }

  for (const flip of [0, 1] as const) {
    const g = context.createLinearGradient(
      flip ? size : 0,
      0,
      flip ? size * 0.82 : size * 0.18,
      0,
    );
    g.addColorStop(0, "rgba(8,10,12,0.55)");
    g.addColorStop(1, "rgba(8,10,12,0)");
    context.fillStyle = g;
    context.fillRect(flip ? size * 0.82 : 0, 0, size * 0.18, size);
  }

  // Fine flocking grain so the floor never reads as flat black.
  const image = context.getImageData(0, 0, size, size);
  const random = mulberry32(0x2f6e2b1);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (random() - 0.5) * 14;
    image.data[i] = Math.max(0, Math.min(255, image.data[i] + n));
    image.data[i + 1] = Math.max(0, Math.min(255, image.data[i + 1] + n));
    image.data[i + 2] = Math.max(0, Math.min(255, image.data[i + 2] + n));
  }
  context.putImageData(image, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Dark footwell decal with a painted rim and a soft inner shadow. The wells
 * sit just above the deck so they read as recesses without cutting into the
 * fuselage skin.
 */
function createWellTexture(): CanvasTexture {
  const width = 256;
  const height = 720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  context.clearRect(0, 0, width, height);

  const pad = 10;
  const radius = 44;
  context.beginPath();
  context.roundRect(pad, pad, width - pad * 2, height - pad * 2, radius);
  context.save();
  context.clip();
  const base = context.createLinearGradient(0, height, 0, 0);
  base.addColorStop(0, "#090c10");
  base.addColorStop(0.5, "#141a20");
  base.addColorStop(1, "#06080b");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  const vignette = context.createRadialGradient(
    width * 0.5,
    height * 0.5,
    18,
    width * 0.5,
    height * 0.5,
    height * 0.55,
  );
  vignette.addColorStop(0, "rgba(34,41,48,0.32)");
  vignette.addColorStop(1, "rgba(0,0,0,0.6)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
  context.restore();

  context.beginPath();
  context.roundRect(pad, pad, width - pad * 2, height - pad * 2, radius);
  context.strokeStyle = "rgba(74,84,94,0.42)";
  context.lineWidth = 5;
  context.stroke();

  context.beginPath();
  context.roundRect(pad + 7, pad + 7, width - (pad + 7) * 2, height - (pad + 7) * 2, radius - 7);
  context.strokeStyle = "rgba(0,0,0,0.55)";
  context.lineWidth = 10;
  context.stroke();

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Small canvas decal: white GD-81 lettering for the blue fin. */
function createDecalTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f4f5ef";
  context.font = "700 104px ui-sans-serif, system-ui, -apple-system, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("GD-81", 256, 100);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Instrument panel. The bezels, ticks, and labels are painted once into a
 * cached background canvas; only the needles and digital readouts are redrawn
 * while flying. The texture aspect matches the 0.44 x 0.15 m panel face so the
 * dials stay round.
 */
const PANEL_WIDTH = 1024;
const PANEL_HEIGHT = 349;
const DIAL_CENTRES = [200, 512, 824];
const DIAL_CY = 168;
const DIAL_RADIUS = 104;
const DIAL_START = Math.PI * 0.75;
const DIAL_SWEEP = Math.PI * 1.5;

const IAS_SCALE = 200; // km/h at full deflection
const ALT_SCALE = 1000; // metres per needle revolution
const VARIO_SCALE = 5; // m/s at either end

/** Same face and marking palette as the HUD cluster. */
const DIAL_FACE_INNER = "#3b4045";
const DIAL_FACE_MID = "#2d3237";
const DIAL_FACE_OUTER = "#22262a";
const DIAL_BORDER = "rgba(205, 225, 232, 0.28)";
const DIAL_MARK = "#eef2f4";
const DIAL_MARK_DIM = "rgba(235, 242, 245, 0.55)";
const DIAL_NUMBER = "#d8e2e6";
const DIAL_LABEL = "#e9eef1";
const DIAL_UNIT = "rgba(205, 218, 223, 0.72)";
const NEEDLE = "#f7fbff";
/** The HUD cluster uses a 50 px gauge radius; scale its line weights to the panel. */
const HUD_GAUGE_RADIUS = 50;

function dialAngle(fraction: number): number {
  return DIAL_START + DIAL_SWEEP * clamp01(fraction);
}

/** One dial face, drawn with the HUD cluster's exact style and proportions. */
function paintGaugeFace(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  title: string,
  unit: string,
): void {
  const scale = radius / HUD_GAUGE_RADIUS;

  const face = context.createRadialGradient(
    cx,
    cy - radius * 0.25,
    radius * 0.08,
    cx,
    cy,
    radius,
  );
  face.addColorStop(0, DIAL_FACE_INNER);
  face.addColorStop(0.7, DIAL_FACE_MID);
  face.addColorStop(1, DIAL_FACE_OUTER);
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.fillStyle = face;
  context.fill();
  context.strokeStyle = DIAL_BORDER;
  context.lineWidth = 1.5 * scale;
  context.stroke();

  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = DIAL_LABEL;
  context.font = `600 ${9 * scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.fillText(title, cx, cy - radius + 14 * scale);
  context.fillStyle = DIAL_UNIT;
  context.fillText(unit, cx, cy + radius - 8 * scale);
}

function paintGaugeTick(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  angle: number,
  length: number,
  color: string,
): void {
  const scale = radius / HUD_GAUGE_RADIUS;
  const outer = radius - 4 * scale;
  const inner = outer - length * scale;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  context.strokeStyle = color;
  context.lineWidth = 1.5 * scale;
  context.lineCap = "butt";
  context.beginPath();
  context.moveTo(cx + cos * outer, cy + sin * outer);
  context.lineTo(cx + cos * inner, cy + sin * inner);
  context.stroke();
}

function paintGaugeLabel(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  angle: number,
  text: string,
  size: number,
  color: string,
): void {
  const scale = radius / HUD_GAUGE_RADIUS;
  const labelRadius = radius - 20 * scale;
  context.fillStyle = color;
  context.font = `${size * scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(
    text,
    cx + Math.cos(angle) * labelRadius,
    cy + Math.sin(angle) * labelRadius,
  );
}

function paintAirspeedDial(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  paintGaugeFace(context, cx, cy, radius, "IAS", "km/h");

  for (let i = 0; i <= 10; i++) {
    const angle = dialAngle(i / 10);
    const major = i % 2 === 0;
    paintGaugeTick(
      context,
      cx,
      cy,
      radius,
      angle,
      major ? 8 : 4,
      major ? DIAL_MARK : DIAL_MARK_DIM,
    );
    if (major) {
      paintGaugeLabel(context, cx, cy, radius, angle, `${i * 20}`, 9, DIAL_NUMBER);
    }
  }
}

function paintAltimeterDial(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  paintGaugeFace(context, cx, cy, radius, "ALT", "m");

  const start = -Math.PI / 2;
  for (let i = 0; i < 10; i++) {
    const angle = start + (i / 10) * Math.PI * 2;
    paintGaugeTick(context, cx, cy, radius, angle, 8, DIAL_MARK);
    paintGaugeLabel(context, cx, cy, radius, angle, `${i}`, 9, DIAL_NUMBER);
  }
}

function paintVarioDial(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  paintGaugeFace(context, cx, cy, radius, "VARIO", "m/s");

  const scale = radius / HUD_GAUGE_RADIUS;
  const start = DIAL_START;
  const sweep = DIAL_SWEEP;
  const bandRadius = radius - 6 * scale;

  context.save();
  context.lineWidth = 6 * scale;
  context.strokeStyle = "rgba(125, 223, 149, 0.28)";
  context.beginPath();
  context.arc(cx, cy, bandRadius, start + sweep * 0.5, start + sweep);
  context.stroke();
  context.strokeStyle = "rgba(240, 180, 90, 0.22)";
  context.beginPath();
  context.arc(cx, cy, bandRadius, start, start + sweep * 0.5);
  context.stroke();
  context.restore();

  for (let i = 0; i <= 10; i++) {
    const angle = dialAngle(i / 10);
    const major = i % 2 === 0;
    paintGaugeTick(
      context,
      cx,
      cy,
      radius,
      angle,
      major ? 8 : 4,
      major ? DIAL_MARK : DIAL_MARK_DIM,
    );
    if (major) {
      paintGaugeLabel(context, cx, cy, radius, angle, `${i - 5}`, 9, DIAL_NUMBER);
    }
  }
}

/** Ergonomic centre-stick grip: a waisted, closed lathe with finger swells. */
function createStickGripGeometry(): LatheGeometry {
  const points = [
    new Vector2(0, -0.04),
    new Vector2(0.01, -0.04),
    new Vector2(0.013, -0.035),
    new Vector2(0.015, -0.028),
    new Vector2(0.0155, -0.02),
    new Vector2(0.014, -0.012),
    new Vector2(0.0155, -0.004),
    new Vector2(0.014, 0.004),
    new Vector2(0.0155, 0.012),
    new Vector2(0.0145, 0.02),
    new Vector2(0.014, 0.028),
    new Vector2(0.012, 0.036),
    new Vector2(0.008, 0.042),
    new Vector2(0, 0.045),
  ];
  return new LatheGeometry(points, 24);
}

function paintPanelBackground(context: CanvasRenderingContext2D): void {
  const background = context.createLinearGradient(0, 0, 0, PANEL_HEIGHT);
  background.addColorStop(0, "#2b3239");
  background.addColorStop(0.55, "#232930");
  background.addColorStop(1, "#191e23");
  context.fillStyle = background;
  context.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
  context.strokeStyle = "#4b545d";
  context.lineWidth = 2;
  context.strokeRect(5, 5, PANEL_WIDTH - 10, PANEL_HEIGHT - 10);

  // Soft shading inside the frame: the coaming shadows the top of the panel
  // and the sides fall away from the light.
  const topShadow = context.createLinearGradient(0, 7, 0, 86);
  topShadow.addColorStop(0, "rgba(0,0,0,0.5)");
  topShadow.addColorStop(0.6, "rgba(0,0,0,0.16)");
  topShadow.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = topShadow;
  context.fillRect(7, 7, PANEL_WIDTH - 14, 79);

  for (const flip of [0, 1] as const) {
    const sideShadow = context.createLinearGradient(
      flip ? PANEL_WIDTH - 7 : 7,
      0,
      flip ? PANEL_WIDTH - 46 : 46,
      0,
    );
    sideShadow.addColorStop(0, "rgba(0,0,0,0.32)");
    sideShadow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = sideShadow;
    context.fillRect(flip ? PANEL_WIDTH - 46 : 7, 7, 39, PANEL_HEIGHT - 14);
  }

  paintAirspeedDial(context, DIAL_CENTRES[0], DIAL_CY, DIAL_RADIUS);
  paintAltimeterDial(context, DIAL_CENTRES[1], DIAL_CY, DIAL_RADIUS);
  paintVarioDial(context, DIAL_CENTRES[2], DIAL_CY, DIAL_RADIUS);

  // Recessed digital readouts under each dial.
  for (const cx of DIAL_CENTRES) {
    context.beginPath();
    context.roundRect(cx - 82, 288, 164, 46, 6);
    context.fillStyle = "#191e22";
    context.fill();
    context.strokeStyle = "#3a444d";
    context.lineWidth = 1.5;
    context.stroke();
  }

  // Toggle switches in the gaps between the readouts.
  const toggle = (x: number, tilt: number): void => {
    context.beginPath();
    context.arc(x, 311, 10, 0, Math.PI * 2);
    context.fillStyle = "#6d757c";
    context.fill();
    context.beginPath();
    context.arc(x, 311, 7, 0, Math.PI * 2);
    context.fillStyle = "#1d2228";
    context.fill();
    context.beginPath();
    context.moveTo(x, 311);
    context.lineTo(x + Math.cos(tilt) * 12, 311 + Math.sin(tilt) * 12);
    context.strokeStyle = "#a9b1b7";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.stroke();
  };
  toggle(356, -Math.PI / 2 + 0.42);
  toggle(668, -Math.PI / 2 - 0.42);

  // Bezel screws at the face corners.
  for (const [sx, sy] of [
    [26, 26],
    [PANEL_WIDTH - 26, 26],
    [26, PANEL_HEIGHT - 26],
    [PANEL_WIDTH - 26, PANEL_HEIGHT - 26],
  ]) {
    context.beginPath();
    context.arc(sx, sy, 5, 0, Math.PI * 2);
    context.fillStyle = "#20262c";
    context.fill();
    context.beginPath();
    context.arc(sx - 1.2, sy - 1.2, 2, 0, Math.PI * 2);
    context.fillStyle = "#98a0a6";
    context.fill();
  }

  // Indicator lamps and a type placard along the top rail.
  const lamp = (x: number, color: string): void => {
    context.beginPath();
    context.arc(x, 30, 9, 0, Math.PI * 2);
    context.fillStyle = "#20262c";
    context.fill();
    context.beginPath();
    context.arc(x, 30, 6, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  };
  lamp(40, "#c9483c");
  lamp(70, "#5fa25a");

  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#6f7a82";
  context.font = "600 15px ui-sans-serif, system-ui, sans-serif";
  context.fillText("GD-81", 512, 32);
}

function drawNeedle(
  context: CanvasRenderingContext2D,
  cx: number,
  fraction: number,
  color: string,
): void {
  const cy = DIAL_CY;
  const radius = DIAL_RADIUS;
  const scale = radius / HUD_GAUGE_RADIUS;

  context.save();
  context.translate(cx, cy);
  context.rotate(dialAngle(fraction));
  context.strokeStyle = color;
  context.lineWidth = 2.2 * scale;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(-8 * scale, 0);
  context.lineTo(radius - 13 * scale, 0);
  context.stroke();
  context.restore();

  // A plain round hub, matching the HUD needles.
  context.beginPath();
  context.arc(cx, cy, 3.2 * scale, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

const response = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);

/** Live cockpit instruments: a cached dial face plus redrawn needles. */
class PanelInstruments {
  readonly texture: CanvasTexture;
  readonly glowTexture: CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly glowCanvas: HTMLCanvasElement;
  private readonly glowContext: CanvasRenderingContext2D;
  private readonly background: HTMLCanvasElement;

  private ias = 0;
  private altitude = 0;
  private vario = 0;
  private iasFraction = 0;
  private altFraction = 0;
  private varioFraction = 0.5;
  private pending = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = PANEL_WIDTH;
    this.canvas.height = PANEL_HEIGHT;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("2D canvas unavailable");
    this.context = context;

    this.glowCanvas = document.createElement("canvas");
    this.glowCanvas.width = PANEL_WIDTH;
    this.glowCanvas.height = PANEL_HEIGHT;
    const glowContext = this.glowCanvas.getContext("2d");
    if (!glowContext) throw new Error("2D canvas unavailable");
    this.glowContext = glowContext;

    this.background = document.createElement("canvas");
    this.background.width = PANEL_WIDTH;
    this.background.height = PANEL_HEIGHT;
    const backgroundContext = this.background.getContext("2d");
    if (!backgroundContext) throw new Error("2D canvas unavailable");
    paintPanelBackground(backgroundContext);

    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 8;

    this.glowTexture = new CanvasTexture(this.glowCanvas);
    this.glowTexture.colorSpace = SRGBColorSpace;
    this.glowTexture.anisotropy = 8;

    this.redraw();
  }

  /** Called with the flight-model values; redraws at roughly 20 Hz. */
  update(dt: number, iasKmh: number, altitude: number, vario: number): void {
    this.ias = iasKmh;
    this.altitude = altitude;
    this.vario = vario;
    this.pending += dt;
    if (this.pending < 0.05) return;

    const step = this.pending;
    this.pending = 0;

    this.iasFraction +=
      (clamp01(iasKmh / IAS_SCALE) - this.iasFraction) * response(step, 0.12);

    // The altimeter needle wraps once per 1,000 m. Unwrap the target so the
    // needle sweeps through the gap at the bottom instead of spinning back.
    const target = ((((altitude % ALT_SCALE) + ALT_SCALE) % ALT_SCALE) / ALT_SCALE) % 1;
    let delta = target - this.altFraction;
    if (delta > 0.5) delta -= 1;
    else if (delta < -0.5) delta += 1;
    this.altFraction =
      ((this.altFraction + delta * response(step, 0.2)) % 1 + 1) % 1;

    const varioFraction =
      (Math.max(-VARIO_SCALE, Math.min(VARIO_SCALE, vario)) + VARIO_SCALE) /
      (VARIO_SCALE * 2);
    this.varioFraction +=
      (varioFraction - this.varioFraction) * response(step, 0.25);

    this.redraw();
  }

  private redraw(): void {
    const context = this.context;
    context.clearRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    context.drawImage(this.background, 0, 0);
    drawNeedle(context, DIAL_CENTRES[0], this.iasFraction, NEEDLE);
    drawNeedle(context, DIAL_CENTRES[1], this.altFraction, NEEDLE);
    drawNeedle(context, DIAL_CENTRES[2], this.varioFraction, NEEDLE);
    this.drawReadings(context);

    // The emissive map is a separate layer: only the round dials and their
    // readouts glow, so the surrounding dash panel stays matte.
    const glow = this.glowContext;
    glow.fillStyle = "#000";
    glow.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    glow.save();
    glow.beginPath();
    for (const cx of DIAL_CENTRES) {
      glow.moveTo(cx + DIAL_RADIUS + 8, DIAL_CY);
      glow.arc(cx, DIAL_CY, DIAL_RADIUS + 8, 0, Math.PI * 2);
    }
    glow.clip();
    glow.drawImage(this.background, 0, 0);
    drawNeedle(glow, DIAL_CENTRES[0], this.iasFraction, NEEDLE);
    drawNeedle(glow, DIAL_CENTRES[1], this.altFraction, NEEDLE);
    drawNeedle(glow, DIAL_CENTRES[2], this.varioFraction, NEEDLE);
    glow.restore();
    this.drawReadings(glow);

    this.texture.needsUpdate = true;
    this.glowTexture.needsUpdate = true;
  }

  private drawReadings(context: CanvasRenderingContext2D): void {
    const lift = this.vario >= 0;
    const readings: Array<[number, string, string, string]> = [
      [DIAL_CENTRES[0], `${Math.round(Math.max(0, this.ias))}`, "km/h", "#dfeef2"],
      [DIAL_CENTRES[1], `${Math.round(Math.max(0, this.altitude))}`, "m", "#dfeef2"],
      [
        DIAL_CENTRES[2],
        `${lift ? "+" : ""}${this.vario.toFixed(1)}`,
        "m/s",
        lift ? "#8fe0a8" : "#f0b46a",
      ],
    ];

    context.textBaseline = "middle";
    for (const [cx, value, unit, color] of readings) {
      context.textAlign = "right";
      context.font = "700 28px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.fillStyle = color;
      context.fillText(value, cx - 6, 312);
      context.textAlign = "left";
      context.font = "500 13px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.fillStyle = "#7f969e";
      context.fillText(unit, cx, 314);
    }
  }
}

export class GliderMesh {
  readonly group = new Group();
  readonly body = new Group();
  readonly wings = new Group();
  readonly tail = new Group();

  private readonly leftAileron = new Group();
  private readonly rightAileron = new Group();
  private readonly leftBrake = new Group();
  private readonly rightBrake = new Group();
  private readonly elevator = new Group();
  private readonly rudder = new Group();
  private readonly canopy = new Group();
  private readonly cockpitGlass = new Mesh();
  private cockpitGlassMaterial: ShaderMaterial | null = null;
  private readonly flexParts: Array<{
    object: Group;
    x: number;
    baseY: number;
    baseRotationZ: number;
  }> = [];
  private readonly decals: Mesh[] = [];

  private flex = 0;
  private flexUniform: { value: number } | null = null;
  private readonly instruments = new PanelInstruments();
  private cockpitView = false;

  constructor() {
    const airframeMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.36,
      metalness: 0.06,
      side: DoubleSide,
    });
    const wingMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.32,
      metalness: 0.07,
      side: DoubleSide,
    });
    const tailMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.34,
      metalness: 0.07,
      side: DoubleSide,
    });
    const blueMaterial = new MeshStandardMaterial({
      color: COBALT.getHex(),
      roughness: 0.38,
      metalness: 0.08,
      side: DoubleSide,
    });
    const whiteMaterial = new MeshStandardMaterial({
      color: PEARL.getHex(),
      roughness: 0.34,
      metalness: 0.06,
      side: DoubleSide,
    });
    const navyMaterial = new MeshStandardMaterial({
      color: NAVY.getHex(),
      roughness: 0.45,
      metalness: 0.05,
    });
    const darkMaterial = new MeshStandardMaterial({
      color: 0x24282e,
      roughness: 0.55,
      metalness: 0.25,
    });
    const metalMaterial = new MeshStandardMaterial({
      color: 0xcfd4d8,
      roughness: 0.3,
      metalness: 0.4,
    });
    const tireMaterial = new MeshStandardMaterial({
      color: 0x17181b,
      roughness: 0.88,
      metalness: 0.0,
    });
    const brakeMaterial = new MeshStandardMaterial({
      color: 0xdfe2dc,
      roughness: 0.55,
      metalness: 0.12,
    });
    const interiorMaterial = new MeshStandardMaterial({
      color: 0x262b31,
      roughness: 0.82,
      metalness: 0.05,
      side: DoubleSide,
    });
    const panelMaterial = new MeshStandardMaterial({
      color: 0x333a42,
      roughness: 0.6,
      metalness: 0.15,
    });
    const dashMaterial = new MeshStandardMaterial({
      color: 0x3a434c,
      roughness: 0.62,
      metalness: 0.12,
    });
    const consoleMaterial = new MeshStandardMaterial({
      color: 0x2c323a,
      roughness: 0.72,
      metalness: 0.08,
    });
    const deckMaterial = new MeshStandardMaterial({
      map: createDeckTexture(),
      roughness: 0.96,
      metalness: 0.0,
    });
    const wellMaterial = new MeshStandardMaterial({
      map: createWellTexture(),
      transparent: true,
      alphaTest: 0.35,
      roughness: 0.98,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const coamingMaterial = new MeshStandardMaterial({
      color: 0x141619,
      roughness: 0.9,
      metalness: 0.02,
    });
    const redMaterial = new MeshStandardMaterial({
      color: 0x9c3b32,
      roughness: 0.5,
      metalness: 0.1,
    });
    const gripMaterial = new MeshStandardMaterial({
      color: 0x252a31,
      roughness: 0.8,
      metalness: 0.04,
    });
    const radioMaterial = new MeshStandardMaterial({
      color: 0xb54136,
      roughness: 0.4,
      metalness: 0.05,
    });
    const glassMaterial = new MeshStandardMaterial({
      color: 0xa8d6e6,
      transparent: true,
      opacity: 0.38,
      roughness: 0.05,
      metalness: 0.3,
      side: DoubleSide,
    });

    // The wing bends smoothly with load: a vertex-shader offset keeps the
    // airfoil intact, while ailerons, spoilers, and winglets are moved with it.
    wingMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uFlex = { value: this.flex };
      this.flexUniform = shader.uniforms.uFlex;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uFlex;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          float bend = clamp((abs(position.x) - ${WING_ROOT_X.toFixed(3)}) / ${WING_SPAN.toFixed(3)}, 0.0, 1.0);
          transformed.y += uFlex * bend * bend;`,
        );
    };

    // Fuselage: one smooth lathe, white with a cobalt spine.
    const fuselage = new Mesh(createFuselageGeometry(), airframeMaterial);
    this.body.add(fuselage);

    // Cockpit: the dash carries the instruments and the canopy frame stays
    // visible when the glass is hidden. The shallow textured deck hides the
    // white fuselage top between the seat and the panel, so looking down reads
    // as a cockpit floor rather than the skin; deck, dash and console share
    // baked shading so the interior sits in shadow.
    const cockpitFloor = new Mesh(new BoxGeometry(0.56, 0.12, 1.45), deckMaterial);
    cockpitFloor.position.set(0, 0.29, -0.62);
    this.body.add(cockpitFloor);

    // Dark knee wells either side of the centre tunnel.
    for (const side of [1, -1] as const) {
      const well = new Mesh(new PlaneGeometry(0.15, 0.36), wellMaterial);
      well.rotation.x = -Math.PI / 2;
      well.position.set(side * 0.155, 0.352, -1.05);
      this.body.add(well);
    }

    // Short cheeks blend the dash into the canopy sill either side.
    for (const side of [1, -1] as const) {
      const cheek = new Mesh(new BoxGeometry(0.016, 0.11, 0.4), interiorMaterial);
      cheek.position.set(side * 0.272, 0.35, -1.02);
      this.body.add(cheek);
    }

    // The panel and its hood live in a tilted group so the face, dash, and
    // glare shield stay square to each other. The dash is a T-shaped moulding;
    // its rounded inner corners leave knee space either side of the centre
    // console.
    const dashboard = new Group();
    dashboard.position.set(0, 0.452, -1.3);
    dashboard.rotation.x = -0.3;
    this.body.add(dashboard);

    const dashGeometry = new ExtrudeGeometry(createDashShape(), {
      depth: 0.1,
      bevelEnabled: true,
      bevelThickness: 0.006,
      bevelSize: 0.006,
      bevelSegments: 2,
      curveSegments: 8,
    });
    dashGeometry.translate(0, 0, -0.05);
    const dashBody = new Mesh(dashGeometry, dashMaterial);
    dashboard.add(dashBody);

    const panelFace = new Mesh(
      new PlaneGeometry(0.46, 0.155),
      new MeshStandardMaterial({
        map: this.instruments.texture,
        roughness: 0.7,
        metalness: 0.05,
        emissive: 0xffffff,
        emissiveMap: this.instruments.glowTexture,
        emissiveIntensity: 0.7,
        toneMapped: false,
      }),
    );
    panelFace.position.set(0, 0.02, 0.06);
    dashboard.add(panelFace);

    // Dark padded brow over the dials, echoing the hooded panel of a glass
    // ship. It is narrow enough to stay inside the dash silhouette.
    const brow = new Mesh(new BoxGeometry(0.42, 0.022, 0.06), coamingMaterial);
    brow.position.set(0, 0.102, 0.025);
    dashboard.add(brow);

    // Centre console running back from the dash between the knees. Baked
    // contact shadows on the deck either side make it sit down into the floor.
    const centreConsole = new Mesh(createConsoleGeometry(), consoleMaterial);
    this.body.add(centreConsole);

    const trimSwitchBase = new Mesh(
      new CylinderGeometry(0.017, 0.018, 0.008, 12),
      coamingMaterial,
    );
    trimSwitchBase.position.set(-0.045, 0.389, -1.03);
    this.body.add(trimSwitchBase);

    const trimSwitch = new Mesh(new CylinderGeometry(0.011, 0.013, 0.012, 12), redMaterial);
    trimSwitch.position.set(-0.045, 0.398, -1.03);
    this.body.add(trimSwitch);

    // Airbrake lever alongside the guarded switch.
    const brakeLeverBase = new Mesh(
      new CylinderGeometry(0.012, 0.013, 0.008, 10),
      coamingMaterial,
    );
    brakeLeverBase.position.set(0.048, 0.384, -1.09);
    this.body.add(brakeLeverBase);

    const brakeLever = new Mesh(new CylinderGeometry(0.0035, 0.004, 0.055, 6), metalMaterial);
    brakeLever.position.set(0.048, 0.409, -1.086);
    brakeLever.rotation.x = 0.3;
    this.body.add(brakeLever);

    const brakeKnob = new Mesh(new SphereGeometry(0.009, 10, 8), navyMaterial);
    brakeKnob.position.set(0.048, 0.435, -1.078);
    this.body.add(brakeKnob);

    // Centre stick: mounted on the tunnel between the knees inside a rubber
    // boot, with the grip finishing below the instrument panel.
    const stickBoot = new Mesh(new CylinderGeometry(0.014, 0.03, 0.036, 12), coamingMaterial);
    stickBoot.position.set(0, 0.414, -0.9);
    this.body.add(stickBoot);

    const stick = new Mesh(new CylinderGeometry(0.007, 0.009, 0.06, 12), darkMaterial);
    stick.position.set(0, 0.445, -0.9);
    this.body.add(stick);

    // Shaped rubber grip with finger swells and a red radio/PTT button on top.
    const gripGroup = new Group();
    gripGroup.position.set(0, 0.49, -0.9);
    gripGroup.rotation.x = 0.14;
    this.body.add(gripGroup);

    const grip = new Mesh(createStickGripGeometry(), gripMaterial);
    grip.scale.set(0.95, 1, 1.15);
    gripGroup.add(grip);

    for (const y of [-0.028, -0.016, -0.004]) {
      const ridge = new Mesh(new TorusGeometry(0.0163, 0.001, 6, 20), darkMaterial);
      ridge.rotation.x = Math.PI / 2;
      ridge.position.set(0, y, 0);
      ridge.scale.set(0.95, 1.15, 1);
      gripGroup.add(ridge);
    }

    const gripCollar = new Mesh(
      new CylinderGeometry(0.0125, 0.0135, 0.006, 16),
      metalMaterial,
    );
    gripCollar.position.set(0, -0.038, 0);
    gripCollar.scale.set(0.95, 1, 1.15);
    gripGroup.add(gripCollar);

    const radioBezel = new Mesh(
      new CylinderGeometry(0.0055, 0.0055, 0.002, 16),
      metalMaterial,
    );
    radioBezel.position.set(0, 0.0445, 0);
    gripGroup.add(radioBezel);

    const radioButton = new Mesh(
      new CylinderGeometry(0.0038, 0.004, 0.003, 16),
      radioMaterial,
    );
    radioButton.position.set(0, 0.0465, 0);
    gripGroup.add(radioButton);

    const radioCap = new Mesh(new SphereGeometry(0.0038, 12, 8), radioMaterial);
    radioCap.scale.set(1, 0.45, 1);
    radioCap.position.set(0, 0.048, 0);
    gripGroup.add(radioCap);

    const seat = new Mesh(new BoxGeometry(0.3, 0.22, 0.07), interiorMaterial);
    seat.position.set(0, 0.2, 0.04);
    seat.rotation.x = -0.2;
    this.body.add(seat);

    const cushion = new Mesh(new BoxGeometry(0.26, 0.1, 0.05), navyMaterial);
    cushion.position.set(0, 0.27, 0.0);
    cushion.rotation.x = -0.2;
    this.body.add(cushion);

    // Headrest on a short post, the way glider seats carry one.
    const headrestPost = new Mesh(new BoxGeometry(0.05, 0.17, 0.04), panelMaterial);
    headrestPost.position.set(0, 0.32, 0.11);
    this.body.add(headrestPost);

    const headrest = new Mesh(new BoxGeometry(0.19, 0.13, 0.07), interiorMaterial);
    headrest.position.set(0, 0.44, 0.12);
    headrest.rotation.x = -0.22;
    this.body.add(headrest);

    // Trim lever on the left side of the floor.
    const trimBase = new Mesh(new CylinderGeometry(0.03, 0.036, 0.02, 10), coamingMaterial);
    trimBase.position.set(-0.16, 0.353, -0.7);
    this.body.add(trimBase);

    const trimLever = new Mesh(new CylinderGeometry(0.005, 0.007, 0.085, 6), metalMaterial);
    trimLever.position.set(-0.16, 0.393, -0.7);
    trimLever.rotation.z = 0.34;
    this.body.add(trimLever);

    const trimKnob = new Mesh(new SphereGeometry(0.013, 10, 8), navyMaterial);
    trimKnob.position.set(-0.175, 0.432, -0.7);
    this.body.add(trimKnob);

    // Canopy: tinted glass with a dark frame. The glass hides in the cockpit
    // camera so the pilot's eye is never inside it, but the frame is part of
    // the airframe and stays visible.
    this.canopy.position.set(0, 0.33, -0.92);
    const glass = new Mesh(
      new SphereGeometry(0.5, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      glassMaterial,
    );
    glass.scale.set(0.64, 0.78, 1.55);
    this.canopy.add(glass);

    const canopyFrame = new Group();
    canopyFrame.position.set(0, 0.33, -0.92);
    const sill = new Mesh(new TorusGeometry(0.5, 0.018, 8, 48), coamingMaterial);
    sill.rotation.x = Math.PI / 2;
    sill.scale.set(0.64, 1.55, 1);
    canopyFrame.add(sill);

    // Front canopy bow. It follows the dome cross-section at that station and
    // gives the pilot a visible frame over the glass in cockpit view.
    const bow = new Mesh(
      new TorusGeometry(0.5, 0.012, 6, 36, Math.PI),
      coamingMaterial,
    );
    bow.scale.set(0.63, 0.77, 1);
    bow.position.set(0, 0, -0.08);
    canopyFrame.add(bow);

    // Side rails run from behind the seat forward to meet the dash.
    for (const side of [1, -1]) {
      const rail = new Mesh(new BoxGeometry(0.016, 0.016, 1.66), coamingMaterial);
      rail.position.set(side * 0.284, 0.026, 0.46);
      canopyFrame.add(rail);
    }

    this.body.add(canopyFrame);
    this.body.add(this.canopy);

    // Inner glass for the cockpit camera. BackSide means we see the inside of
    // the dome; the shader keeps the centre clear and only adds reflections
    // where the surface turns away from the eye.
    const cockpitGlassMaterial = new ShaderMaterial({
      uniforms: {
        uSunDirection: { value: new Vector3(0, 0.8, 0.6) },
        uTint: { value: new Color(0x93b9cb) },
        uSunColor: { value: new Color(0xfff1d5) },
      },
      vertexShader: COCKPIT_GLASS_VERTEX,
      fragmentShader: COCKPIT_GLASS_FRAGMENT,
      transparent: true,
      side: BackSide,
      depthWrite: false,
      depthTest: true,
    });
    this.cockpitGlassMaterial = cockpitGlassMaterial;
    this.cockpitGlass.geometry = new SphereGeometry(
      0.5,
      28,
      16,
      0,
      Math.PI * 2,
      0,
      Math.PI / 2,
    );
    this.cockpitGlass.material = cockpitGlassMaterial;
    this.cockpitGlass.scale.set(0.64, 0.78, 1.55);
    this.cockpitGlass.position.set(0, 0.33, -0.92);
    this.cockpitGlass.renderOrder = 4;
    this.cockpitGlass.visible = false;
    this.body.add(this.cockpitGlass);

    // Wing roots: a soft fairing hides the wing/fuselage intersection.
    for (const side of [1, -1]) {
      const fairing = new Mesh(new SphereGeometry(0.5, 16, 10), whiteMaterial);
      fairing.scale.set(0.45, 0.16, 0.72);
      fairing.position.set(side * 0.3, 0, 0);
      this.body.add(fairing);
    }

    // Thin cobalt cheatline along each side of the fuselage.
    for (const side of [1, -1]) {
      const stripe = new Mesh(new BoxGeometry(0.012, 0.05, 2.2), blueMaterial);
      stripe.position.set(side * 0.315, 0.07, -0.35);
      this.body.add(stripe);
    }

    // Wings: identical planform to the old 15 m mesh, but lofted and painted
    // with a blue tip band.
    const rightWing = new Mesh(
      createLoftedWing({
        side: 1,
        rootX: WING_ROOT_X,
        tipX: WING_TIP_X,
        rootChord: 1.05,
        tipChord: 0.3,
        rootY: WING_ROOT_Y,
        tipY: WING_TIP_Y,
        sweep: 0.1,
        rootThickness: 0.14,
        tipThickness: 0.05,
        tipStart: 0.85,
      }),
      wingMaterial,
    );
    const leftWing = new Mesh(
      createLoftedWing({
        side: -1,
        rootX: WING_ROOT_X,
        tipX: WING_TIP_X,
        rootChord: 1.05,
        tipChord: 0.3,
        rootY: WING_ROOT_Y,
        tipY: WING_TIP_Y,
        sweep: 0.1,
        rootThickness: 0.14,
        tipThickness: 0.05,
        tipStart: 0.85,
      }),
      wingMaterial,
    );
    this.wings.add(rightWing, leftWing);

    // Winglets: small canted fins at the tips, matching the blue tip paint.
    for (const side of [1, -1] as const) {
      const pivot = new Group();
      pivot.position.set(side * WING_TIP_X, WING_TIP_Y, 0);
      const winglet = new Mesh(
        createLoftedWing({
          side,
          rootX: 0,
          tipX: 0.26,
          rootChord: 0.3,
          tipChord: 0.12,
          rootY: 0,
          tipY: 0.4,
          sweep: 0.06,
          rootThickness: 0.05,
          tipThickness: 0.018,
          color: COBALT,
          sections: 6,
          chordSamples: 8,
        }),
        tailMaterial,
      );
      pivot.add(winglet);
      this.wings.add(pivot);
      this.flexParts.push({
        object: pivot,
        x: WING_TIP_X,
        baseY: WING_TIP_Y,
        baseRotationZ: 0,
      });
    }

    // Ailerons: thin tapered plates along the outer trailing edge, following
    // the wing's dihedral so both ends sit on the wing.
    const aileronGeometry = createTaperedPlate(2.7, 0.28, 0.18, 0.035);
    const aileronY = wingSurfaceY(5.4) + 0.003;
    const rightAileronMesh = new Mesh(aileronGeometry, blueMaterial);
    this.rightAileron.position.set(5.4, aileronY, 0.3);
    this.rightAileron.add(rightAileronMesh);
    this.wings.add(this.rightAileron);
    this.flexParts.push({
      object: this.rightAileron,
      x: 5.4,
      baseY: aileronY,
      baseRotationZ: WING_DIHEDRAL_SLOPE,
    });

    const leftAileronMesh = new Mesh(aileronGeometry, blueMaterial);
    this.leftAileron.position.set(-5.4, aileronY, 0.3);
    this.leftAileron.add(leftAileronMesh);
    this.wings.add(this.leftAileron);
    this.flexParts.push({
      object: this.leftAileron,
      x: -5.4,
      baseY: aileronY,
      baseRotationZ: -WING_DIHEDRAL_SLOPE,
    });

    // Top-surface spoilers, flush when retracted.
    const spoilerGeometry = createTaperedPlate(1.0, 0.4, 0.34, 0.035, 4);
    const spoilerY = wingSurfaceY(2.05) + 0.054;
    for (const side of [1, -1] as const) {
      const spoiler = new Mesh(spoilerGeometry, brakeMaterial);
      const pivot = side > 0 ? this.rightBrake : this.leftBrake;
      pivot.position.set(side * 2.05, spoilerY, -0.05);
      pivot.add(spoiler);
      this.wings.add(pivot);
      this.flexParts.push({
        object: pivot,
        x: 2.05,
        baseY: spoilerY,
        baseRotationZ: side * WING_DIHEDRAL_SLOPE,
      });
    }

    // Tail: a swept cobalt fin carrying a T-tail, with blue tailplane.
    const fin = new Mesh(
      createLoftedWing({
        side: 1,
        rootX: 0,
        tipX: 1.0,
        rootChord: 0.78,
        tipChord: 0.36,
        rootY: 0,
        tipY: 0,
        sweep: 0.2,
        rootThickness: 0.075,
        tipThickness: 0.045,
        color: COBALT,
        sections: 8,
        chordSamples: 10,
      }),
      tailMaterial,
    );
    fin.rotation.z = Math.PI / 2;
    fin.position.set(0, 0.15, 3.02);
    this.tail.add(fin);

    for (const side of [1, -1] as const) {
      const stabilizer = new Mesh(
        createLoftedWing({
          side,
          rootX: 0,
          tipX: 1.35,
          rootChord: 0.62,
          tipChord: 0.36,
          rootY: 0,
          tipY: 0.02,
          sweep: 0.04,
          rootThickness: 0.065,
          tipThickness: 0.04,
          tipStart: 0.78,
          sections: 8,
          chordSamples: 10,
        }),
        tailMaterial,
      );
      stabilizer.position.set(0, 1.14, 3.12);
      this.tail.add(stabilizer);
    }

    const elevatorMesh = new Mesh(createTaperedPlate(2.5, 0.22, 0.16, 0.032), whiteMaterial);
    this.elevator.position.set(0, 1.14, 3.42);
    this.elevator.add(elevatorMesh);
    this.tail.add(this.elevator);

    const rudderMesh = new Mesh(createVerticalPlate(0.92, 0.2, 0.12, 0.032), blueMaterial);
    this.rudder.position.set(0, 0.22, 3.4);
    this.rudder.add(rudderMesh);
    this.tail.add(this.rudder);

    // GD-81 decals on both sides of the fin.
    const decalGeometry = new PlaneGeometry(0.44, 0.165);
    const decalMaterial = new MeshBasicMaterial({
      map: createDecalTexture(),
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    for (const side of [1, -1] as const) {
      const decal = new Mesh(decalGeometry, decalMaterial);
      decal.position.set(side * 0.042, 0.78, 3.16);
      decal.rotation.y = side * (Math.PI / 2);
      this.tail.add(decal);
      this.decals.push(decal);
    }

    // Main wheel: no strut and no blister. The axle sits on the belly line, so
    // the fuselage skin cuts the tire in half and only a semicircle shows.
    const wheelY = -0.339;
    const wheelZ = -0.35;

    const tire = new Mesh(new CylinderGeometry(0.311, 0.311, 0.12, 28), tireMaterial);
    tire.rotation.z = Math.PI / 2;
    tire.position.set(0, wheelY, wheelZ);
    this.body.add(tire);

    const hub = new Mesh(new CylinderGeometry(0.14, 0.14, 0.13, 20), metalMaterial);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(0, wheelY, wheelZ);
    this.body.add(hub);

    const hubCap = new Mesh(new CylinderGeometry(0.05, 0.05, 0.14, 14), blueMaterial);
    hubCap.rotation.z = Math.PI / 2;
    hubCap.position.set(0, wheelY, wheelZ);
    this.body.add(hubCap);

    // Tailwheel: a stubby caster tucked under the tail cone, like the little
    // swivelling wheel on a shopping cart. No strut, just a yoke and a wheel.
    const tailMount = new Mesh(new CylinderGeometry(0.032, 0.032, 0.028, 10), darkMaterial);
    tailMount.position.set(0, -0.085, 2.95);
    this.body.add(tailMount);

    for (const side of [1, -1] as const) {
      const yoke = new Mesh(new BoxGeometry(0.008, 0.1, 0.034), metalMaterial);
      yoke.position.set(side * 0.026, -0.16, 2.95);
      this.body.add(yoke);
    }

    const tailWheel = new Mesh(new CylinderGeometry(0.062, 0.062, 0.038, 18), tireMaterial);
    tailWheel.rotation.z = Math.PI / 2;
    tailWheel.position.set(0, -0.215, 2.95);
    this.body.add(tailWheel);

    const tailAxle = new Mesh(new CylinderGeometry(0.011, 0.011, 0.062, 10), metalMaterial);
    tailAxle.rotation.z = Math.PI / 2;
    tailAxle.position.set(0, -0.215, 2.95);
    this.body.add(tailAxle);

    // Tow hook and pitot: small details that sell the scale.
    const hook = new Mesh(new BoxGeometry(0.05, 0.05, 0.14), darkMaterial);
    hook.position.set(0, -0.3, -2.45);
    this.body.add(hook);

    const pitot = new Mesh(new CylinderGeometry(0.008, 0.008, 0.42, 6), metalMaterial);
    pitot.rotation.x = Math.PI / 2;
    pitot.position.set(-3.6, -0.02, -0.34);
    this.body.add(pitot);

    // A shifted frame keeps the physics origin at the wing centreline while
    // the airframe sits lower over its wheels.
    const frame = new Group();
    frame.position.y = -GLIDER_MODEL_DROP;
    frame.add(this.body, this.wings, this.tail);
    this.group.add(frame);
    this.group.traverse((object) => {
      if (object === this.cockpitGlass) return;
      if (object instanceof Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    for (const decal of this.decals) {
      decal.castShadow = false;
      decal.receiveShadow = false;
    }
  }

  setControls(elevator: number, aileron: number, rudder: number, brake: number): void {
    this.rightAileron.rotation.x = -0.34 * aileron;
    this.leftAileron.rotation.x = 0.34 * aileron;
    this.elevator.rotation.x = -0.32 * elevator;
    this.rudder.rotation.y = 0.34 * rudder;
    const brakeAngle = -1.25 * Math.max(0, Math.min(1, brake));
    this.leftBrake.rotation.x = brakeAngle;
    this.rightBrake.rotation.x = brakeAngle;
  }

  /** Bend the wing with load, easing toward the current g-load. */
  updateFlex(gLoad: number, dt: number): void {
    const target = Math.max(-0.06, Math.min(0.34, (gLoad - 1) * 0.16));
    const smoothing = dt > 0 ? 1 - Math.exp(-dt / 0.5) : 1;
    this.flex += (target - this.flex) * smoothing;

    if (this.flexUniform) this.flexUniform.value = this.flex;
    for (const part of this.flexParts) {
      const t = clamp01((Math.abs(part.x) - WING_ROOT_X) / WING_SPAN);
      part.object.position.y = part.baseY + this.flex * t * t;
      part.object.rotation.z =
        part.baseRotationZ + (Math.sign(part.x) * this.flex * 2 * t) / WING_SPAN;
    }
  }

  /** Feed the panel real flight data; only the cockpit view needs the redraw. */
  updateInstruments(dt: number, iasKmh: number, altitude: number, vario: number): void {
    if (!this.cockpitView) return;
    this.instruments.update(dt, iasKmh, altitude, vario);
  }

  setCockpitView(active: boolean): void {
    // Swap the outer glass for the interior shell so the pilot can see the
    // canopy without the camera clipping through a tinted surface.
    this.cockpitView = active;
    this.canopy.visible = !active;
    this.cockpitGlass.visible = active;
  }

  /** Keep the cockpit glass glint aligned with the scene sun. */
  setSunDirection(direction: Vector3): void {
    if (!this.cockpitGlassMaterial) return;
    const uniform = this.cockpitGlassMaterial.uniforms.uSunDirection;
    (uniform.value as Vector3).copy(direction);
  }
}
