import type { MusicTrack } from "../audio/audio";
import { DEFAULT_WEATHER, WEATHER_PRESETS, type WeatherSettings } from "../config";
import {
  HOME_AIRFIELD,
  airfieldLabel,
  nearestAirfields,
  type AirfieldSpec,
} from "../sim/airfields";
import type { FlightStats, LaunchType } from "../sim/simulation";

type NullableElement<T> = T | null;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id) as NullableElement<T>;
  if (!element) throw new Error(`Missing UI element #${id}`);
  return element;
}

interface SavedSettings {
  weather: WeatherSettings;
  launch: LaunchType;
  field?: string;
  musicTrack: MusicTrack;
}

export class MenuUI {
  readonly menu = byId<HTMLElement>("menu");
  readonly pause = byId<HTMLElement>("pause");
  readonly summary = byId<HTMLElement>("summary");
  readonly help = byId<HTMLElement>("help");

  private readonly preset = byId<HTMLSelectElement>("preset");
  private readonly presetDescription = byId<HTMLElement>("preset-description");
  private readonly launch = byId<HTMLSelectElement>("launch");
  private readonly launchHint = byId<HTMLElement>("launch-hint");
  private readonly departure = byId<HTMLSelectElement>("departure");
  private readonly musicTrack = byId<HTMLSelectElement>("music-track");
  private readonly wind = byId<HTMLInputElement>("wind");
  private readonly windFrom = byId<HTMLInputElement>("windfrom");
  private readonly thermal = byId<HTMLInputElement>("thermal");
  private readonly turbulence = byId<HTMLInputElement>("turbulence");
  private readonly cloudbase = byId<HTMLInputElement>("cloudbase");
  private readonly timeOfDay = byId<HTMLInputElement>("timeofday");
  private readonly windValue = byId<HTMLElement>("wind-value");
  private readonly windFromValue = byId<HTMLElement>("windfrom-value");
  private readonly thermalValue = byId<HTMLElement>("thermal-value");
  private readonly turbulenceValue = byId<HTMLElement>("turbulence-value");
  private readonly cloudbaseValue = byId<HTMLElement>("cloudbase-value");
  private readonly timeValue = byId<HTMLElement>("time-value");
  private readonly summaryTitle = byId<HTMLElement>("summary-title");
  private readonly summaryEyebrow = byId<HTMLElement>("summary-eyebrow");
  private readonly summaryNote = byId<HTMLElement>("summary-note");
  private readonly summaryStats = byId<HTMLElement>("summary-stats");

  private weather: WeatherSettings;
  private selectedLaunch: LaunchType;
  private selectedFieldId = "home";
  private selectedMusicTrack: MusicTrack = "ambient";
  private fields: AirfieldSpec[] = [];
  private callbacks: {
    onFly: (
      weather: WeatherSettings,
      launch: LaunchType,
      field: AirfieldSpec,
      musicTrack: MusicTrack,
    ) => void;
    onResume: () => void;
    onRestart: () => void;
    onMenu: () => void;
    onInspect: () => void;
    onHelpClose: () => void;
  };

  constructor(callbacks: {
    onFly: (
      weather: WeatherSettings,
      launch: LaunchType,
      field: AirfieldSpec,
      musicTrack: MusicTrack,
    ) => void;
    onResume: () => void;
    onRestart: () => void;
    onMenu: () => void;
    onInspect: () => void;
    onHelpClose: () => void;
  }) {
    this.callbacks = callbacks;
    const saved = this.load();
    this.weather = { ...(saved?.weather ?? DEFAULT_WEATHER) };
    this.selectedLaunch = saved?.launch ?? "winch";
    this.selectedFieldId = saved?.field ?? "home";
    this.selectedMusicTrack = saved?.musicTrack === "synthwave" ? "synthwave" : "ambient";

    for (const preset of WEATHER_PRESETS) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      this.preset.append(option);
    }
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "Custom";
    this.preset.append(custom);

    this.wire();
    this.applyWeather(this.weather, saved ? "custom" : "standard");
    this.populateFields();
    this.launch.value = this.selectedLaunch;
    this.musicTrack.value = this.selectedMusicTrack;
    this.syncField();
    this.menu.classList.remove("hidden");
  }

  private wire(): void {
    this.preset.addEventListener("change", () => this.onPresetChanged());
    this.launch.addEventListener("change", () => {
      const value = this.launch.value;
      this.selectedLaunch = value === "air" ? "air" : value === "tow" ? "tow" : "winch";
    });
    this.departure.addEventListener("change", () => {
      this.selectedFieldId = this.departure.value;
      this.syncField();
    });
    this.musicTrack.addEventListener("change", () => {
      this.selectedMusicTrack =
        this.musicTrack.value === "synthwave" ? "synthwave" : "ambient";
    });

    const sliders: Array<[HTMLInputElement, keyof WeatherSettings]> = [
      [this.wind, "windSpeed"],
      [this.windFrom, "windFrom"],
      [this.thermal, "thermalStrength"],
      [this.turbulence, "turbulence"],
      [this.cloudbase, "cloudBase"],
      [this.timeOfDay, "timeOfDay"],
    ];

    for (const [input, key] of sliders) {
      input.addEventListener("input", () => {
        this.weather[key] = Number(input.value);
        this.preset.value = "custom";
        this.presetDescription.textContent = "Hand-tuned weather.";
        this.syncLabels();
      });
    }

    byId<HTMLButtonElement>("fly").addEventListener("click", () => this.start());
    byId<HTMLButtonElement>("resume").addEventListener("click", () => this.callbacks.onResume());
    byId<HTMLButtonElement>("restart").addEventListener("click", () => this.callbacks.onRestart());
    byId<HTMLButtonElement>("pause-menu").addEventListener("click", () => this.callbacks.onMenu());
    byId<HTMLButtonElement>("pause-inspect").addEventListener("click", () => this.callbacks.onInspect());
    byId<HTMLButtonElement>("pause-help").addEventListener("click", () => this.openHelp());
    byId<HTMLButtonElement>("help-open").addEventListener("click", () => this.openHelp());
    byId<HTMLButtonElement>("help-close").addEventListener("click", () => {
      this.help.classList.add("hidden");
      this.callbacks.onHelpClose();
    });
    byId<HTMLButtonElement>("summary-restart").addEventListener("click", () => this.callbacks.onRestart());
    byId<HTMLButtonElement>("summary-menu").addEventListener("click", () => this.callbacks.onMenu());
  }

  private onPresetChanged(): void {
    const id = this.preset.value;
    const preset = WEATHER_PRESETS.find((p) => p.id === id);
    if (!preset) {
      this.presetDescription.textContent = "Hand-tuned weather.";
      return;
    }
    this.applyWeather(preset.weather, id);
  }

  /** Home plus the nearest town strips, labelled by runway and distance. */
  private populateFields(): void {
    this.fields = nearestAirfields(0, 0, 12, 30_000);
    this.departure.replaceChildren(
      ...this.fields.map((field) => {
        const option = document.createElement("option");
        option.value = field.id;
        if (field.home) {
          option.textContent = airfieldLabel(field);
        } else {
          const distance = Math.hypot(field.x, field.z) / 1000;
          option.textContent = `${airfieldLabel(field)} · ${distance.toFixed(1)} km`;
        }
        return option;
      }),
    );

    const known = this.fields.some((field) => field.id === this.selectedFieldId);
    if (!known) this.selectedFieldId = HOME_AIRFIELD.id;
    this.departure.value = this.selectedFieldId;
  }

  private currentField(): AirfieldSpec {
    return this.fields.find((field) => field.id === this.selectedFieldId) ?? HOME_AIRFIELD;
  }

  /** Aerotow is only flown from the home field's long asphalt runway. */
  private syncField(): void {
    const field = this.currentField();
    const satellite = !field.home;
    const tow = this.launch.querySelector<HTMLOptionElement>('option[value="tow"]');
    if (tow) tow.disabled = satellite;

    if (satellite && this.selectedLaunch === "tow") {
      this.selectedLaunch = "winch";
      this.launch.value = "winch";
    }
    this.launchHint.textContent = satellite
      ? "Town strips launch by winch or air start. Aerotow stays at home."
      : "Winch or aerotow for a real launch. Air start skips the climb.";
  }

  private applyWeather(weather: WeatherSettings, presetId: string): void {
    this.weather = { ...weather };
    this.wind.value = String(weather.windSpeed);
    this.windFrom.value = String(weather.windFrom);
    this.thermal.value = String(weather.thermalStrength);
    this.turbulence.value = String(Math.round(weather.turbulence * 100));
    this.cloudbase.value = String(weather.cloudBase);
    this.timeOfDay.value = String(weather.timeOfDay);
    this.preset.value = presetId;
    const preset = WEATHER_PRESETS.find((p) => p.id === presetId);
    this.presetDescription.textContent = preset?.description ?? "Hand-tuned weather.";
    this.syncLabels();
  }

  private syncLabels(): void {
    this.windValue.textContent = `${this.weather.windSpeed.toFixed(0)} km/h`;
    this.windFromValue.textContent = `${this.weather.windFrom.toFixed(0)}°`;
    this.thermalValue.textContent = `${this.weather.thermalStrength.toFixed(1)} m/s`;
    this.turbulenceValue.textContent = `${Math.round(this.weather.turbulence * 100)}%`;
    this.cloudbaseValue.textContent = `${this.weather.cloudBase.toFixed(0)} m`;
    this.timeValue.textContent = this.formatHour(this.weather.timeOfDay);
  }

  private formatHour(hours: number): string {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  }

  private start(): void {
    this.save();
    this.menu.classList.add("hidden");
    this.pause.classList.add("hidden");
    this.summary.classList.add("hidden");
    this.help.classList.add("hidden");
    this.callbacks.onFly(
      { ...this.weather },
      this.selectedLaunch,
      this.currentField(),
      this.selectedMusicTrack,
    );
  }

  showMenu(): void {
    this.menu.classList.remove("hidden");
    this.pause.classList.add("hidden");
    this.summary.classList.add("hidden");
    this.help.classList.add("hidden");
  }

  hideMenu(): void {
    this.menu.classList.add("hidden");
  }

  showPause(): void {
    this.pause.classList.remove("hidden");
    this.help.classList.add("hidden");
  }

  hidePause(): void {
    this.pause.classList.add("hidden");
  }

  showSummary(stats: FlightStats & { mode: string }): void {
    this.pause.classList.add("hidden");
    this.summary.classList.remove("hidden");
    this.help.classList.add("hidden");

    const crashed = stats.mode === "crashed";
    const ditched = stats.mode === "ditched";
    this.summaryEyebrow.textContent = crashed ? "Flight ended" : "Flight complete";
    this.summaryTitle.textContent = crashed ? "Crashed" : ditched ? "Ditched" : "Landed";
    this.summaryNote.textContent = crashed
      ? "Too fast, too steep, or too far from level. Restart and try a gentler arrival."
      : ditched
        ? "A soft splash, a wet wing, and a long tow home. No one was hurt."
        : "All the way down, in one piece. The sky will still be there tomorrow.";

    const rows: Array<[string, string]> = [
      ["Airtime", this.formatDuration(stats.airTime)],
      ["Max altitude", `${stats.maxAltitude.toFixed(0)} m`],
      ["Best climb", `${stats.maxClimb >= 0 ? "+" : ""}${stats.maxClimb.toFixed(1)} m/s`],
      ["Distance", `${(stats.distance / 1000).toFixed(1)} km`],
      ["Launch", stats.launch === "winch" ? "Winch" : stats.launch === "tow" ? "Aerotow" : "Air start"],
      ["Outcome", crashed ? "Crashed" : ditched ? "Ditched" : "Landed"],
    ];
    this.summaryStats.innerHTML = rows
      .map(([label, value]) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`)
      .join("");
  }

  hideSummary(): void {
    this.summary.classList.add("hidden");
  }

  openHelp(): void {
    this.help.classList.remove("hidden");
  }

  closeHelp(): void {
    this.help.classList.add("hidden");
  }

  isHelpOpen(): boolean {
    return !this.help.classList.contains("hidden");
  }

  private formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }

  private save(): void {
    try {
      const payload: SavedSettings = {
        weather: this.weather,
        launch: this.selectedLaunch,
        field: this.selectedFieldId,
        musicTrack: this.selectedMusicTrack,
      };
      localStorage.setItem("gludor.settings", JSON.stringify(payload));
    } catch {
      // Settings are a convenience, not a requirement.
    }
  }

  private load(): SavedSettings | null {
    try {
      const raw = localStorage.getItem("gludor.settings");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SavedSettings>;
      if (!parsed.weather || typeof parsed.weather !== "object") return null;
      return {
        weather: { ...DEFAULT_WEATHER, ...parsed.weather },
        launch: parsed.launch === "air" ? "air" : parsed.launch === "tow" ? "tow" : "winch",
        field: typeof parsed.field === "string" ? parsed.field : undefined,
        musicTrack: parsed.musicTrack === "synthwave" ? "synthwave" : "ambient",
      };
    } catch {
      return null;
    }
  }
}
