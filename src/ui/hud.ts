import { clamp, wrapDegrees } from "../core/math";
import type { Simulation } from "../sim/simulation";

export type HudState = "menu" | "flying" | "paused" | "ended" | "free";

const CYAN = "#8fe3f2";
const AMBER = "#f0b45a";
const GREEN = "#7ddf95";
const RED = "#ef6b6b";
const PANEL = "rgba(8, 13, 17, 0.74)";
const BORDER = "rgba(190, 225, 235, 0.16)";

export class Hud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private readonly historyVario: number[] = [];
  private readonly historyIas: number[] = [];
  private readonly historyLimit = 420;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("HUD canvas unavailable");
    this.ctx = context;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(
    sim: Simulation,
    state: HudState,
    debug: boolean,
    thermalHelpers: boolean,
    fps: number,
    freePose?: { x: number; y: number; z: number },
    cockpitView = false,
  ): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    // Reset the text state each frame: the gauges centre their numbers, and a
    // leaked alignment would offset the status block on the following frame.
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = 1;

    if (state === "free") {
      this.drawFreeCamera(freePose);
      this.drawMessage(sim);
      return;
    }
    if (state === "menu") return;

    this.historyVario.push(sim.varioTE);
    this.historyIas.push(sim.ias);
    if (this.historyVario.length > this.historyLimit) this.historyVario.shift();
    if (this.historyIas.length > this.historyLimit) this.historyIas.shift();

    this.drawStatus(sim, state);
    // In the cockpit the 3D panel carries the three primary instruments, so
    // the duplicate bottom cluster would only sit on top of it.
    if (!cockpitView || state === "ended") this.drawPanel(sim);
    this.drawMessage(sim);
    if (thermalHelpers && !sim.onGround) this.drawThermalHelper(sim);
    if (sim.stall > 0.22) this.drawStall(sim);
    if (debug) this.drawDebug(sim, fps);
  }

  private drawFreeCamera(pose?: { x: number; y: number; z: number }): void {
    const ctx = this.ctx;
    const x = 20;
    const y = 20;
    const w = 286;
    const h = 84;
    this.roundRect(x, y, w, h, 12, PANEL, BORDER);

    ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = CYAN;
    ctx.fillText("FREE CAMERA", x + 16, y + 22);

    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#9fb4bb";
    if (pose) {
      ctx.fillText(`ALT ${pose.y.toFixed(0)} m`, x + 16, y + 44);
      ctx.fillText(`X ${pose.x.toFixed(0)}   Z ${pose.z.toFixed(0)}`, x + 16, y + 64);
    } else {
      ctx.fillText("Detached view", x + 16, y + 44);
    }

    ctx.fillStyle = "rgba(210, 230, 235, 0.55)";
    ctx.fillText(
      "WASD move   Q/E down/up   SHIFT fast   drag look   V/ESC return",
      22,
      this.height - 16,
    );
  }

  private drawStatus(sim: Simulation, state: HudState): void {
    const ctx = this.ctx;
    const x = 20;
    const y = 20;
    const w = 254;
    const h = 104;
    this.roundRect(x, y, w, h, 12, PANEL, BORDER);

    ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e8f4f7";
    ctx.fillText(`ALT  ${sim.msl.toFixed(0).padStart(5)} m`, x + 16, y + 22);
    ctx.fillStyle = "#9fb4bb";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`${sim.agl.toFixed(0)} m AGL`, x + 168, y + 22);

    ctx.fillStyle = "#e8f4f7";
    ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`IAS  ${(sim.ias * 3.6).toFixed(0).padStart(4)} km/h`, x + 16, y + 45);
    ctx.fillStyle = "#9fb4bb";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`${sim.tas.toFixed(0)} m/s TAS`, x + 176, y + 45);

    ctx.fillStyle = "#e8f4f7";
    ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`HDG  ${sim.heading.toFixed(0).padStart(3)}°`, x + 16, y + 68);
    const windSpeed = Math.hypot(sim.wind.x, sim.wind.z) * 3.6;
    ctx.fillStyle = "#9fb4bb";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`WIND ${windSpeed.toFixed(0)} km/h ${sim.weather.windFrom.toFixed(0)}°`, x + 120, y + 68);

    const status =
      state === "paused"
        ? "PAUSED"
        : sim.mode === "winch"
          ? "WINCH LAUNCH"
          : sim.mode === "tow"
            ? "AEROTOW"
            : sim.mode === "rollout"
              ? "ROLLOUT"
              : sim.mode === "landed"
                ? "LANDED"
                : sim.mode === "ditched"
                  ? "DITCHED"
                  : sim.mode === "crashed"
                    ? "CRASHED"
                    : "FREE FLIGHT";
    ctx.fillStyle = state === "paused" ? AMBER : sim.mode === "crashed" ? RED : CYAN;
    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(status, x + 16, y + 89);
    ctx.fillStyle = "#9fb4bb";
    ctx.fillText(`TIME ${this.formatTime(sim.stats.airTime)}`, x + 168, y + 89);

    // Bottom controls hint.
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(210, 230, 235, 0.55)";
    const hint =
      sim.mode === "rollout"
        ? "Q/E steer   B wheel brake   R restart   C camera   V inspect   F1 help   ESC menu"
        : sim.mode === "landed"
          ? "Landed - R restart   C camera   V inspect   F1 help   ESC menu"
          : "SPACE release   B airbrakes   T/G trim   C camera   Z/X look   V inspect   F1 help   ESC menu";
    ctx.fillText(hint, 22, this.height - 16);
  }

  private drawPanel(sim: Simulation): void {
    const panelWidth = Math.min(610, this.width - 40);
    const panelHeight = 158;
    const x = (this.width - panelWidth) / 2;
    const y = this.height - panelHeight - 34;
    this.roundRect(x, y, panelWidth, panelHeight, 18, PANEL, BORDER);

    const gaugeY = y + 76;
    const r = 50;
    this.drawAirspeed(x + 86, gaugeY, r, sim.ias * 3.6);
    this.drawAltimeter(x + 214, gaugeY, r, sim.msl);
    this.drawVario(x + 342, gaugeY, r, sim.varioTE);
    this.drawInfo(x + 420, y + 18, panelHeight - 36, sim);
  }

  private drawInfo(x: number, y: number, h: number, sim: Simulation): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(190,225,235,0.12)";
    ctx.beginPath();
    ctx.moveTo(x - 12, y);
    ctx.lineTo(x - 12, y + h);
    ctx.stroke();

    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#9fb4bb";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("LIFT", x, y + 8);
    const liftColor = sim.varioTE >= 0 ? GREEN : AMBER;
    ctx.fillStyle = liftColor;
    ctx.font = "700 20px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`${sim.varioTE >= 0 ? "+" : ""}${sim.varioTE.toFixed(1)}`, x + 44, y + 9);
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#9fb4bb";
    ctx.fillText("m/s", x + 96, y + 10);

    ctx.fillStyle = "#9fb4bb";
    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText("G", x, y + 38);
    ctx.fillStyle = "#e8f4f7";
    ctx.font = "700 15px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(sim.gLoad.toFixed(2), x + 44, y + 38);

    ctx.fillStyle = "#9fb4bb";
    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText("BAL", x, y + 66);
    this.drawSlipBall(x + 38, y + 66, sim.slip);

    ctx.fillStyle = "#9fb4bb";
    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText("TRIM", x, y + 94);
    ctx.fillStyle = "#e8f4f7";
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(sim.trim >= 0 ? "UP" : "DN", x + 44, y + 94);

    if (sim.lift) {
      ctx.fillStyle = "rgba(143, 227, 242, 0.75)";
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(`TH ${sim.lift.thermal.toFixed(1)}  RG ${sim.lift.ridge.toFixed(1)}`, x, y + 116);
    }
    ctx.restore();
  }

  private drawAirspeed(x: number, y: number, r: number, value: number): void {
    this.gaugeFace(x, y, r, "IAS", "km/h");
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    for (let i = 0; i <= 10; i++) {
      const angle = start + (i / 10) * sweep;
      const major = i % 2 === 0;
      this.tick(x, y, r, angle, major ? 8 : 4, major ? "#eef2f4" : "rgba(235,242,245,0.55)");
      if (major) {
        this.label(x, y, r - 20, angle, `${i * 20}`, 9, "#d8e2e6");
      }
    }
    const needle = start + clamp(value / 200, 0, 1) * sweep;
    this.needle(x, y, r - 13, needle, "#f7fbff");
  }

  private drawAltimeter(x: number, y: number, r: number, altitude: number): void {
    const ctx = this.ctx;
    this.gaugeFace(x, y, r, "ALT", "m");
    const start = -Math.PI / 2;
    for (let i = 0; i < 10; i++) {
      const angle = start + (i / 10) * Math.PI * 2;
      this.tick(x, y, r, angle, 8, "#eef2f4");
      this.label(x, y, r - 20, angle, `${i}`, 9, "#d8e2e6");
    }
    const remainder = ((altitude % 1000) + 1000) % 1000;
    this.needle(x, y, r - 13, start + (remainder / 1000) * Math.PI * 2, "#f7fbff");

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e8f4f7";
    ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(altitude.toFixed(0), x, y + r - 18);
    ctx.restore();
  }

  private drawVario(x: number, y: number, r: number, value: number): void {
    const ctx = this.ctx;
    this.gaugeFace(x, y, r, "VARIO", "m/s");
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;

    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(125, 223, 149, 0.28)";
    ctx.beginPath();
    ctx.arc(x, y, r - 6, start + sweep * 0.5, start + sweep);
    ctx.stroke();
    ctx.strokeStyle = "rgba(240, 180, 90, 0.22)";
    ctx.beginPath();
    ctx.arc(x, y, r - 6, start, start + sweep * 0.5);
    ctx.stroke();
    ctx.restore();

    for (let i = 0; i <= 10; i++) {
      const angle = start + (i / 10) * sweep;
      const major = i % 2 === 0;
      this.tick(x, y, r, angle, major ? 8 : 4, major ? "#eef2f4" : "rgba(235,242,245,0.55)");
      if (major) {
        const label = i * 1 - 5;
        this.label(x, y, r - 20, angle, `${label}`, 9, "#d8e2e6");
      }
    }
    const needle = start + clamp((value + 5) / 10, 0, 1) * sweep;
    this.needle(x, y, r - 13, needle, "#f5f7f8");

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = value >= 0 ? GREEN : AMBER;
    ctx.font = "700 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`${value >= 0 ? "+" : ""}${value.toFixed(1)}`, x, y + r - 18);
    ctx.restore();
  }

  private gaugeFace(x: number, y: number, r: number, title: string, unit: string): void {
    const ctx = this.ctx;
    ctx.save();
    const face = ctx.createRadialGradient(x, y - r * 0.25, r * 0.08, x, y, r);
    face.addColorStop(0, "#3b4045");
    face.addColorStop(0.7, "#2d3237");
    face.addColorStop(1, "#22262a");
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = face;
    ctx.fill();
    ctx.strokeStyle = "rgba(205, 225, 232, 0.28)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e9eef1";
    ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(title, x, y - r + 14);
    ctx.fillStyle = "rgba(205, 218, 223, 0.72)";
    ctx.fillText(unit, x, y + r - 8);
    ctx.restore();
  }

  private tick(x: number, y: number, r: number, angle: number, length: number, color: string): void {
    const ctx = this.ctx;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + cos * (r - 4), y + sin * (r - 4));
    ctx.lineTo(x + cos * (r - 4 - length), y + sin * (r - 4 - length));
    ctx.stroke();
  }

  private label(
    x: number,
    y: number,
    radius: number,
    angle: number,
    text: string,
    size: number,
    color: string,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    ctx.restore();
  }

  private needle(x: number, y: number, length: number, angle: number, color: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(angle) * 8, y - Math.sin(angle) * 8);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  private drawSlipBall(x: number, y: number, slip: number): void {
    const ctx = this.ctx;
    const width = 62;
    ctx.strokeStyle = "rgba(190,225,235,0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + width / 2 + clamp(slip, -1, 1) * (width / 2 - 5), y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = "#dfeef2";
    ctx.fill();
  }

  private drawThermalHelper(sim: Simulation): void {
    const info = sim.getNearestThermalInfo();
    if (!info || info.distance > 5000) return;
    const ctx = this.ctx;
    const x = this.width - 108;
    const y = 46;
    const inside = info.active && info.distance <= info.radius * 1.25;
    const centered = inside && info.distance <= info.radius * 0.35;
    this.roundRect(x - 16, y - 24, 104, 64, 10, "rgba(8,13,17,0.66)", BORDER);

    const accent = centered ? GREEN : CYAN;
    ctx.save();
    ctx.translate(x + 20, y + 8);
    if (centered) {
      // A steady green ring reads better than an arrow with nowhere to point.
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, -3, 4.5, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const relative = wrapDegrees(info.bearing - sim.heading) * (Math.PI / 180);
      ctx.rotate(relative);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(5, 2);
      ctx.lineTo(0, -1);
      ctx.lineTo(-5, 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = centered ? GREEN : "#cfe2e7";
    ctx.fillText(
      inside ? `${Math.round(info.distance)} m` : `${(info.distance / 1000).toFixed(1)} km`,
      x + 34,
      y + 2,
    );
    ctx.fillStyle = centered ? "rgba(125,223,149,0.9)" : "rgba(160,190,198,0.8)";
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(centered ? "CORE" : inside ? "thermal core" : "nearest thermal", x - 6, y + 24);
  }

  private drawMessage(sim: Simulation): void {
    const message = sim.getMessage();
    if (!message) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    const width = ctx.measureText(message).width + 32;
    const x = (this.width - width) / 2;
    const y = 26;
    this.roundRect(x, y, width, 34, 17, "rgba(8,13,17,0.78)", "rgba(143,227,242,0.35)");
    ctx.fillStyle = "#dff7fb";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message, this.width / 2, y + 18);
    ctx.restore();
  }

  private drawStall(sim: Simulation): void {
    const ctx = this.ctx;
    const pulse = 0.55 + 0.45 * Math.sin(sim.time * 18);
    ctx.save();
    ctx.globalAlpha = 0.4 + pulse * 0.6;
    ctx.fillStyle = RED;
    ctx.font = "700 26px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("STALL", this.width / 2, 104);
    ctx.restore();
  }

  private drawDebug(sim: Simulation, fps: number): void {
    const ctx = this.ctx;
    const lines = [
      `FPS ${fps.toFixed(0)}`,
      `alpha ${((sim.alpha * 180) / Math.PI).toFixed(1)}°  beta ${((sim.beta * 180) / Math.PI).toFixed(1)}°`,
      `CL ${sim.cl.toFixed(2)}  CD ${sim.cd.toFixed(3)}  L/D ${(sim.cl / Math.max(0.001, sim.cd)).toFixed(1)}`,
      `thermal ${sim.lift.thermal.toFixed(2)}  ridge ${sim.lift.ridge.toFixed(2)}  sink ${sim.lift.sink.toFixed(2)}`,
      `surfaces E ${sim.controls.elevator.toFixed(2)} A ${sim.controls.aileron.toFixed(2)} R ${sim.controls.rudder.toFixed(2)} B ${sim.controls.brake.toFixed(2)}`,
      `mode ${sim.mode}  cable ${sim.cableAttached}  assist ${sim.assist}`,
    ];
    const x = 20;
    const y = this.height - 300;
    ctx.save();
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(8,13,17,0.7)";
    ctx.fillRect(x - 8, y - 8, 360, lines.length * 17 + 16);
    ctx.fillStyle = "#cfe2e7";
    lines.forEach((line, index) => ctx.fillText(line, x, y + index * 17));
    ctx.restore();

    this.drawHistory();
  }

  private drawHistory(): void {
    const ctx = this.ctx;
    const x = 20;
    const y = this.height - 196;
    const w = 300;
    const h = 82;
    this.roundRect(x - 8, y - 8, w + 16, h + 16, 8, "rgba(8,13,17,0.7)", BORDER);

    const drawSeries = (values: number[], min: number, max: number, color: string) => {
      ctx.beginPath();
      for (let i = 0; i < values.length; i++) {
        const px = x + (i / Math.max(1, this.historyLimit - 1)) * w;
        const py = y + h - clamp((values[i] - min) / (max - min), 0, 1) * h;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    };

    ctx.save();
    ctx.strokeStyle = "rgba(190,225,235,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
    drawSeries(this.historyIas, 0, 60, "rgba(143,227,242,0.8)");
    drawSeries(this.historyVario, -5, 5, "rgba(125,223,149,0.9)");
    ctx.fillStyle = "rgba(190,225,235,0.7)";
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("10 s  IAS cyan / vario green", x, y - 4);
    ctx.restore();
  }

  private roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    fill: string,
    stroke?: string,
  ): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private formatTime(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
}
