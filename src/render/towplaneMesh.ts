import {
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "three";

const WHITE = 0xf2f0e7;
const RED = 0xc0392b;
const DARK = 0x23262b;
const METAL = 0xc6ccd1;
const GLASS = 0x9fc7d8;
const TIRE = 0x16171a;

function addStrut(
  group: Group,
  from: Vector3,
  to: Vector3,
  radius: number,
  material: MeshStandardMaterial,
): void {
  const direction = new Vector3().subVectors(to, from);
  const length = direction.length();
  if (length < 0.001) return;
  const strut = new Mesh(new CylinderGeometry(radius, radius, length, 6), material);
  strut.position.copy(from).addScaledVector(direction, 0.5);
  strut.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize());
  group.add(strut);
}

/**
 * A small high-wing tug in the same procedural, low-poly style as the glider.
 * The model faces -Z, matching the flight model, and its origin sits at the
 * aircraft's centre so the renderer can copy position and orientation directly.
 */
export class TowPlaneMesh {
  readonly group = new Group();
  readonly prop = new Group();

  constructor() {
    const white = new MeshStandardMaterial({ color: WHITE, roughness: 0.42, metalness: 0.06 });
    const red = new MeshStandardMaterial({ color: RED, roughness: 0.46, metalness: 0.05 });
    const dark = new MeshStandardMaterial({ color: DARK, roughness: 0.6, metalness: 0.2 });
    const metal = new MeshStandardMaterial({ color: METAL, roughness: 0.34, metalness: 0.45 });
    const tire = new MeshStandardMaterial({ color: TIRE, roughness: 0.9, metalness: 0 });
    const glass = new MeshStandardMaterial({
      color: GLASS,
      transparent: true,
      opacity: 0.42,
      roughness: 0.08,
      metalness: 0.25,
      side: DoubleSide,
    });

    // Fuselage tapers from a broad cowling to a slim tail.
    const fuselage = new Mesh(new CylinderGeometry(0.34, 0.58, 6.4, 14), white);
    fuselage.rotation.x = Math.PI / 2;
    fuselage.position.z = 0.1;
    this.group.add(fuselage);

    const cowling = new Mesh(new SphereGeometry(0.58, 16, 12), red);
    cowling.scale.set(0.98, 0.92, 1.05);
    cowling.position.z = -3.02;
    this.group.add(cowling);

    const spinner = new Mesh(new ConeGeometry(0.2, 0.5, 12), red);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -3.42;
    this.group.add(spinner);

    const canopy = new Mesh(new SphereGeometry(0.5, 16, 10), glass);
    canopy.scale.set(0.74, 0.64, 1.5);
    canopy.position.set(0, 0.54, -1.15);
    this.group.add(canopy);

    // High wing with red tips and a pair of struts.
    const wing = new Mesh(new BoxGeometry(12, 0.14, 1.62), white);
    wing.position.set(0, 0.72, -0.55);
    this.group.add(wing);
    for (const side of [1, -1]) {
      const tip = new Mesh(new BoxGeometry(1.25, 0.15, 1.64), red);
      tip.position.set(side * 5.4, 0.72, -0.55);
      this.group.add(tip);
      addStrut(
        this.group,
        new Vector3(side * 0.36, -0.2, -0.5),
        new Vector3(side * 1.75, 0.68, -0.55),
        0.045,
        metal,
      );
    }

    // Tailplane and fin.
    const tailplane = new Mesh(new BoxGeometry(4.2, 0.1, 0.92), white);
    tailplane.position.set(0, 0.34, 2.98);
    this.group.add(tailplane);
    const fin = new Mesh(new BoxGeometry(0.09, 1.32, 0.86), white);
    fin.position.set(0, 0.88, 3.02);
    this.group.add(fin);
    const finCap = new Mesh(new BoxGeometry(0.1, 0.46, 0.88), red);
    finCap.position.set(0, 1.36, 3.02);
    this.group.add(finCap);

    // Fixed main gear and a tailwheel.
    for (const side of [1, -1]) {
      addStrut(
        this.group,
        new Vector3(side * 0.33, -0.28, -0.35),
        new Vector3(side * 0.94, -0.99, -0.28),
        0.05,
        metal,
      );
      const wheel = new Mesh(new CylinderGeometry(0.32, 0.32, 0.18, 14), tire);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 0.96, -1.0, -0.28);
      this.group.add(wheel);
    }
    addStrut(
      this.group,
      new Vector3(0, -0.34, 2.9),
      new Vector3(0, -0.94, 3.1),
      0.04,
      metal,
    );
    const tailwheel = new Mesh(new CylinderGeometry(0.16, 0.16, 0.12, 12), tire);
    tailwheel.rotation.z = Math.PI / 2;
    tailwheel.position.set(0, -0.98, 3.12);
    this.group.add(tailwheel);

    // A red cheatline and a pair of exhausts finish the silhouette.
    for (const side of [1, -1]) {
      const stripe = new Mesh(new BoxGeometry(0.012, 0.07, 2.5), red);
      stripe.position.set(side * 0.385, 0.16, 0.3);
      this.group.add(stripe);
      const exhaust = new Mesh(new CylinderGeometry(0.045, 0.045, 0.5, 8), dark);
      exhaust.rotation.x = Math.PI / 2;
      exhaust.position.set(side * 0.48, -0.16, -2.55);
      this.group.add(exhaust);
    }

    // Spinning propeller: a blade pair plus a faint disc.
    this.prop.position.z = -3.55;
    const blade = new Mesh(new BoxGeometry(0.09, 2.3, 0.05), dark);
    blade.rotation.z = 0.12;
    this.prop.add(blade);
    const disc = new Mesh(
      new CircleGeometry(1.12, 28),
      new MeshBasicMaterial({
        color: 0xaab2b7,
        transparent: true,
        opacity: 0.13,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    disc.position.z = 0.01;
    this.prop.add(disc);
    this.group.add(this.prop);

    this.group.traverse((object) => {
      if (object instanceof Mesh && object !== disc) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
  }

  setProp(angle: number): void {
    this.prop.rotation.z = angle;
  }
}
