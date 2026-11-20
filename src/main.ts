import "./style.css";
import { LANDING, PHYSICS_STEP, type WeatherSettings } from "./config";
import { AudioEngine } from "./audio/audio";
import { KeyboardInput } from "./input/keyboard";
import { Hud, type HudState } from "./ui/hud";
import { MenuUI } from "./ui/menu";
import { WorldRenderer } from "./render/renderer";
import { Simulation, type LaunchType } from "./sim/simulation";
import { Terrain } from "./sim/terrain";

type AppState = "menu" | "flying" | "paused" | "ended";

const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
const hudCanvas = document.getElementById("hud") as HTMLCanvasElement;
if (!sceneCanvas || !hudCanvas) throw new Error("Canvas elements missing");

const terrain = new Terrain();
const simulation = new Simulation(terrain);
const renderer = new WorldRenderer(sceneCanvas, terrain);
const hud = new Hud(hudCanvas);
const keyboard = new KeyboardInput();
const audio = new AudioEngine();

let appState: AppState = "menu";
let debug = false;
let thermalHelpers = true;
let freeCamera = false;
let lastWeather: WeatherSettings | null = null;
let lastLaunch: LaunchType = "winch";
let helpResumesFlight = false;
let accumulator = 0;
let landedTimer = 0;
let landingAudioPlayed = false;
let dragging = false;
let lastPointerX = 0;
let lastPointerY = 0;
let fps = 60;

const ui = new MenuUI({
  onFly: (weather, launch) => startFlight(weather, launch),
  onResume: () => resumeFlight(),
  onRestart: () => restartFlight(),
  onMenu: () => showMenu(),
  onInspect: () => toggleFreeCamera(),
  onHelpClose: () => {
    if (helpResumesFlight) {
      helpResumesFlight = false;
      resumeFlight();
    }
  },
});

renderer.syncWeather(simulation);
renderer.setThermalHelpers(thermalHelpers);
simulation.prepareMenu();
renderer.setCameraMode("chase");
ui.showMenu();

function startFlight(weather: WeatherSettings, launch: LaunchType): void {
  lastWeather = { ...weather };
  lastLaunch = launch;
  simulation.startFlight(weather, launch);
  renderer.syncWeather(simulation);
  renderer.setCameraMode("chase");
  renderer.resetLook();
  ui.hideMenu();
  ui.hidePause();
  ui.hideSummary();
  ui.closeHelp();
  helpResumesFlight = false;
  accumulator = 0;
  landedTimer = 0;
  landingAudioPlayed = false;
  appState = "flying";
  audio.start();
  audio.setActive(true);
}

function pauseFlight(): void {
  if (appState !== "flying") return;
  appState = "paused";
  accumulator = 0;
  ui.showPause();
  audio.setActive(false);
}

function resumeFlight(): void {
  if (appState !== "paused") return;
  appState = "flying";
  accumulator = 0;
  ui.hidePause();
  ui.closeHelp();
  audio.start();
  audio.setActive(true);
}

function enterFreeCamera(): void {
  if (freeCamera) return;
  if (ui.isHelpOpen()) closeHelp();

  freeCamera = true;
  ui.hideMenu();
  ui.hidePause();
  ui.hideSummary();
  renderer.enterFreeCamera();
  simulation.clearMessage();
  accumulator = 0;
  audio.setActive(false);
}

function exitFreeCamera(): void {
  if (!freeCamera) return;

  freeCamera = false;
  renderer.exitFreeCamera();
  accumulator = 0;

  if (appState === "menu") {
    ui.showMenu();
  } else if (appState === "paused") {
    ui.showPause();
  } else if (appState === "ended") {
    ui.showSummary(simulation.getSummary());
  }

  if (appState === "flying") {
    audio.start();
    audio.setActive(true);
  }
}

function toggleFreeCamera(): void {
  if (freeCamera) exitFreeCamera();
  else enterFreeCamera();
}

function restartFlight(): void {
  if (!lastWeather) return;
  startFlight(lastWeather, lastLaunch);
}

function showMenu(): void {
  appState = "menu";
  accumulator = 0;
  simulation.prepareMenu();
  renderer.syncWeather(simulation);
  renderer.resetLook();
  renderer.setCameraMode("chase");
  ui.showMenu();
  audio.setActive(false);
}

function endFlight(): void {
  appState = "ended";
  const summary = simulation.getSummary();
  ui.showSummary(summary);
  // The landing thump already played at touchdown; only the destructive
  // outcomes still need a sound here.
  if (simulation.mode === "ditched") audio.splash();
  else if (simulation.mode === "crashed") audio.landingThump(true);
  audio.setActive(false);
}

function openHelp(): void {
  if (appState === "flying") {
    pauseFlight();
    helpResumesFlight = true;
  }
  ui.openHelp();
}

function closeHelp(): void {
  if (!ui.isHelpOpen()) return;
  ui.closeHelp();
  if (helpResumesFlight) {
    helpResumesFlight = false;
    resumeFlight();
  }
}

function toggleHelp(): void {
  if (ui.isHelpOpen()) closeHelp();
  else openHelp();
}

function handleHotkeys(): void {
  if (keyboard.consume("KeyV")) {
    toggleFreeCamera();
    return;
  }

  if (freeCamera) {
    if (keyboard.consume("Escape")) exitFreeCamera();
    if (keyboard.consume("KeyM")) {
      const muted = audio.toggleMute();
      simulation.showMessage(muted ? "Audio muted" : "Audio on", 1.6);
    }
    return;
  }

  if (keyboard.consume("F1") || keyboard.consume("KeyH")) toggleHelp();

  if (keyboard.consume("Escape")) {
    if (ui.isHelpOpen()) {
      closeHelp();
    } else if (appState === "flying") {
      pauseFlight();
    } else if (appState === "paused") {
      resumeFlight();
    }
  }

  if (keyboard.consume("KeyC") && appState !== "menu") {
    const mode = renderer.cycleCamera();
    simulation.showMessage(`Camera: ${mode}`, 1.6);
  }

  if (appState === "flying" || appState === "paused") {
    if (keyboard.consume("KeyZ")) {
      const look = renderer.toggleLook(-1);
      if (look) simulation.showMessage(`Looking ${look}`, 1.2);
    }
    if (keyboard.consume("KeyX")) {
      const look = renderer.toggleLook(1);
      if (look) simulation.showMessage(`Looking ${look}`, 1.2);
    }
  }

  if (keyboard.consume("KeyR") && appState !== "menu") {
    restartFlight();
  }

  if (keyboard.consume("KeyM")) {
    const muted = audio.toggleMute();
    simulation.showMessage(muted ? "Audio muted" : "Audio on", 1.6);
  }

  if (
    keyboard.consume("KeyN") &&
    (appState === "flying" || appState === "paused")
  ) {
    const music = audio.toggleMusic();
    simulation.showMessage(music ? "Ambient music on" : "Ambient music off", 1.8);
  }

  if (keyboard.consume("F2") && appState !== "menu") {
    simulation.toggleAssist();
  }

  if (keyboard.consume("F3")) {
    debug = !debug;
  }

  if (keyboard.consume("F4")) {
    thermalHelpers = renderer.toggleThermalHelpers();
    simulation.showMessage(thermalHelpers ? "Thermal helpers on" : "Thermal helpers off", 1.6);
  }

  if (keyboard.consume("Enter") && appState === "menu") {
    document.getElementById("fly")?.click();
  }
}

function applyInput(): void {
  if (freeCamera || appState !== "flying") {
    simulation.input.pitch = 0;
    simulation.input.roll = 0;
    simulation.input.rudder = 0;
    simulation.input.brake = 0;
    simulation.input.trimUp = false;
    simulation.input.trimDown = false;
    simulation.input.release = false;
    return;
  }
  simulation.input.pitch = keyboard.pitch;
  simulation.input.roll = keyboard.roll;
  simulation.input.rudder = keyboard.rudder;
  simulation.input.brake = keyboard.brake;
  simulation.input.trimUp = keyboard.trimUp;
  simulation.input.trimDown = keyboard.trimDown;
  simulation.input.release = keyboard.release;
}

sceneCanvas.addEventListener("pointerdown", (event) => {
  if (!freeCamera && appState !== "flying") return;
  dragging = true;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  sceneCanvas.setPointerCapture(event.pointerId);
});

sceneCanvas.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const dx = event.clientX - lastPointerX;
  const dy = event.clientY - lastPointerY;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  renderer.dragLook(dx, dy);
});

const endDrag = (event: PointerEvent): void => {
  dragging = false;
  if (sceneCanvas.hasPointerCapture(event.pointerId)) {
    sceneCanvas.releasePointerCapture(event.pointerId);
  }
};
sceneCanvas.addEventListener("pointerup", endDrag);
sceneCanvas.addEventListener("pointercancel", endDrag);
sceneCanvas.addEventListener("dblclick", () => renderer.resetLook());
sceneCanvas.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("resize", () => {
  renderer.resize();
  hud.resize();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && appState === "flying" && !freeCamera) pauseFlight();
});

let lastFrame = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (dt > 0) fps = fps * 0.92 + (1 / dt) * 0.08;

  handleHotkeys();
  applyInput();

  if (freeCamera) {
    const forward = (keyboard.isDown("KeyW") ? 1 : 0) - (keyboard.isDown("KeyS") ? 1 : 0);
    const strafe = (keyboard.isDown("KeyD") ? 1 : 0) - (keyboard.isDown("KeyA") ? 1 : 0);
    const rise = (keyboard.isDown("KeyE") ? 1 : 0) - (keyboard.isDown("KeyQ") ? 1 : 0);
    const boost = keyboard.isDown("ShiftLeft") || keyboard.isDown("ShiftRight");
    renderer.moveFreeCamera(dt, forward, strafe, rise, boost);
  }

  if (!freeCamera && appState === "flying") {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= PHYSICS_STEP && steps < 16) {
      simulation.step(PHYSICS_STEP);
      accumulator -= PHYSICS_STEP;
      steps++;
    }
    if (steps >= 16) accumulator = 0;

    if (simulation.mode === "rollout" && !landingAudioPlayed) {
      landingAudioPlayed = true;
      audio.landingThump(false);
    }

    if (simulation.mode === "landed") {
      landedTimer += dt;
      if (landedTimer >= LANDING.summaryDelay) endFlight();
    } else if (simulation.mode === "ditched" || simulation.mode === "crashed") {
      endFlight();
    } else {
      landedTimer = 0;
    }
  } else {
    accumulator = 0;
  }

  renderer.render(simulation, dt, appState === "menu");

  const hudState: HudState = freeCamera
    ? "free"
    : appState === "menu"
      ? "menu"
      : appState === "paused"
        ? "paused"
        : appState === "ended"
          ? "ended"
          : "flying";
  hud.update(
    simulation,
    hudState,
    debug,
    thermalHelpers,
    fps,
    freeCamera ? renderer.camera.position : undefined,
    renderer.cameraMode === "cockpit" && !freeCamera,
  );
  audio.update(simulation, dt);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
