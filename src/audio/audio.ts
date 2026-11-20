import { clamp } from "../core/math";
import type { Simulation } from "../sim/simulation";

interface MusicVoice {
  oscillator: OscillatorNode;
}

/** Slow four-note chords for the ambient bed. */
const MUSIC_CHORDS = [
  [146.83, 220.0, 293.66, 349.23], // D minor
  [130.81, 196.0, 261.63, 329.63], // C major
  [116.54, 174.61, 233.08, 293.66], // B-flat major
  [110.0, 164.81, 220.0, 329.63], // A minor
];
/** D-minor pentatonic notes for the sparse bells. */
const MUSIC_BELLS = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33];
const MUSIC_LEVEL = 0.7;
const MUSIC_CHORD_SECONDS = 9;

/** Small WebAudio soundscape: wind, vario beeps, a stall horn and a thud. */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private stallGain: GainNode | null = null;
  private sinkOscillator: OscillatorNode | null = null;
  private sinkGain: GainNode | null = null;
  private towOscillator: OscillatorNode | null = null;
  private towGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicDelay: DelayNode | null = null;
  private musicVoices: MusicVoice[] = [];
  private musicEnabled = false;
  private musicStep = 0;
  private musicChordClock = 0;
  private musicBellClock = 4;
  private noiseBuffer: AudioBuffer | null = null;
  private beepClock = 0;
  private muted = false;
  private active = false;

  start(): void {
    if (this.context) {
      void this.context.resume();
      this.active = true;
      return;
    }
    try {
      const AudioContextClass =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      this.context = context;

      const master = context.createGain();
      master.gain.value = this.muted ? 0 : 0.55;
      master.connect(context.destination);
      this.master = master;

      const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      this.noiseBuffer = buffer;
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        last = last * 0.92 + white * 0.08;
        data[i] = last * 3.4;
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 500;
      filter.Q.value = 0.4;

      const windGain = context.createGain();
      windGain.gain.value = 0;
      source.connect(filter);
      filter.connect(windGain);
      windGain.connect(master);
      source.start();

      this.windFilter = filter;
      this.windGain = windGain;

      const stallOscillator = context.createOscillator();
      stallOscillator.type = "square";
      stallOscillator.frequency.value = 620;
      const stallGain = context.createGain();
      stallGain.gain.value = 0;
      stallOscillator.connect(stallGain);
      stallGain.connect(master);
      stallOscillator.start();
      this.stallGain = stallGain;

      // Sink tone: a continuous low growl that deepens as the air goes down.
      const sinkOscillator = context.createOscillator();
      sinkOscillator.type = "sawtooth";
      sinkOscillator.frequency.value = 300;
      const sinkFilter = context.createBiquadFilter();
      sinkFilter.type = "lowpass";
      sinkFilter.frequency.value = 1200;
      sinkFilter.Q.value = 0.7;
      const sinkGain = context.createGain();
      sinkGain.gain.value = 0;
      sinkOscillator.connect(sinkFilter);
      sinkFilter.connect(sinkGain);
      sinkGain.connect(master);
      sinkOscillator.start();
      this.sinkOscillator = sinkOscillator;
      this.sinkGain = sinkGain;

      // Tow-plane engine: a filtered sawtooth drone that fades in with the tug.
      const towOscillator = context.createOscillator();
      towOscillator.type = "sawtooth";
      towOscillator.frequency.value = 78;
      const towFilter = context.createBiquadFilter();
      towFilter.type = "lowpass";
      towFilter.frequency.value = 430;
      towFilter.Q.value = 2.2;
      const towGain = context.createGain();
      towGain.gain.value = 0;
      towOscillator.connect(towFilter);
      towFilter.connect(towGain);
      towGain.connect(master);
      towOscillator.start();
      this.towOscillator = towOscillator;
      this.towGain = towGain;

      // Optional ambient music: a slow pad plus sparse bells. It is built up
      // front so toggling is just a gain change, and it stays off by default.
      const musicGain = context.createGain();
      musicGain.gain.value = this.musicEnabled ? MUSIC_LEVEL : 0;
      musicGain.connect(master);
      this.musicGain = musicGain;

      const musicFilter = context.createBiquadFilter();
      musicFilter.type = "lowpass";
      musicFilter.frequency.value = 1100;
      musicFilter.Q.value = 0.4;
      musicFilter.connect(musicGain);

      // A very slow filter drift keeps the pad from sounding static.
      const lfo = context.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.045;
      const lfoDepth = context.createGain();
      lfoDepth.gain.value = 320;
      lfo.connect(lfoDepth);
      lfoDepth.connect(musicFilter.frequency);
      lfo.start();

      const voiceGains = [0.34, 0.2, 0.16, 0.13];
      this.musicVoices = MUSIC_CHORDS[0].map((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.type = "triangle";
        oscillator.frequency.value = frequency;
        oscillator.detune.value = (index - 1.5) * 5;
        const gain = context.createGain();
        gain.gain.value = voiceGains[index] ?? 0.12;
        const panner = context.createStereoPanner();
        panner.pan.value = (index / (MUSIC_CHORDS[0].length - 1)) * 0.8 - 0.4;
        oscillator.connect(gain);
        gain.connect(panner);
        panner.connect(musicFilter);
        oscillator.start();
        return { oscillator };
      });

      // A short feedback delay gives the bells a little room without needing
      // an impulse response.
      const musicDelay = context.createDelay(1);
      musicDelay.delayTime.value = 0.42;
      const feedback = context.createGain();
      feedback.gain.value = 0.25;
      const wet = context.createGain();
      wet.gain.value = 0.5;
      musicDelay.connect(feedback);
      feedback.connect(musicDelay);
      musicDelay.connect(wet);
      wet.connect(musicGain);
      this.musicDelay = musicDelay;

      this.active = true;
    } catch {
      this.context = null;
    }
  }

  setActive(active: boolean): void {
    this.active = active;
    const now = this.context?.currentTime ?? 0;
    if (!active) {
      this.windGain?.gain.setTargetAtTime(0, now, 0.15);
      this.stallGain?.gain.setTargetAtTime(0, now, 0.08);
      this.sinkGain?.gain.setTargetAtTime(0, now, 0.08);
      this.towGain?.gain.setTargetAtTime(0, now, 0.2);
    }
    if (this.musicGain) {
      const target = active && this.musicEnabled ? MUSIC_LEVEL : 0;
      this.musicGain.gain.setTargetAtTime(target, now, active ? 1.4 : 0.4);
    }
  }

  /** Toggle the ambient score. Off by default and independent of the mix mute. */
  toggleMusic(): boolean {
    this.musicEnabled = !this.musicEnabled;
    if (this.context && this.musicGain) {
      const target = this.musicEnabled && this.active ? MUSIC_LEVEL : 0;
      this.musicGain.gain.setTargetAtTime(
        target,
        this.context.currentTime,
        this.musicEnabled ? 0.35 : 0.45,
      );
    }
    return this.musicEnabled;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.context && this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.context.currentTime, 0.05);
    }
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  update(sim: Simulation, dt: number): void {
    if (!this.context || !this.active || this.muted) return;
    const now = this.context.currentTime;
    if (this.musicEnabled) this.updateMusic(dt);

    if (this.windGain && this.windFilter) {
      const airspeed = sim.ias;
      const gain = 0.015 + clamp(airspeed / 55, 0, 1) * 0.11;
      this.windGain.gain.setTargetAtTime(gain, now, 0.08);
      this.windFilter.frequency.setTargetAtTime(280 + airspeed * 14, now, 0.1);
    }

    if (this.stallGain) {
      const target = sim.stall > 0.18 && !sim.onGround ? 0.035 : 0;
      this.stallGain.gain.setTargetAtTime(target, now, 0.04);
    }

    if (this.towGain && this.towOscillator) {
      const towing = sim.mode === "tow";
      const level = towing ? 0.03 + clamp(sim.ias / 40, 0, 1) * 0.025 : 0;
      this.towGain.gain.setTargetAtTime(level, now, towing ? 0.25 : 0.55);
      if (towing) {
        this.towOscillator.frequency.setTargetAtTime(
          72 + clamp(sim.ias, 0, 40) * 0.95,
          now,
          0.25,
        );
      }
    }

    const vario = sim.onGround ? 0 : sim.varioTE;
    if (vario > 0.12) {
      const interval = clamp(0.55 - vario * 0.09, 0.075, 0.52);
      this.beepClock += dt;
      if (this.beepClock >= interval) {
        this.beepClock = 0;
        // Lift gets a louder, higher beep as the climb strengthens.
        const level = 0.065 + clamp(vario, 0, 6) * 0.004;
        this.beep(380 + clamp(vario, 0, 6) * 110, 0.055, level);
      }
    } else {
      this.beepClock = 0;
    }

    if (this.sinkGain && this.sinkOscillator) {
      const sink = -vario;
      if (sink > 0.15) {
        // A continuous low tone, falling in pitch and rising in level with
        // stronger sink: the negative half of a classic variometer.
        const depth = clamp((sink - 0.15) / 4, 0, 1);
        this.sinkGain.gain.setTargetAtTime(0.045 + depth * 0.045, now, 0.09);
        this.sinkOscillator.frequency.setTargetAtTime(300 - depth * 100, now, 0.09);
      } else {
        this.sinkGain.gain.setTargetAtTime(0, now, 0.12);
      }
    }
  }

  landingThump(crashed: boolean): void {
    if (!this.context || !this.active || this.muted) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(crashed ? 90 : 130, now);
    oscillator.frequency.exponentialRampToValueAtTime(35, now + 0.25);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(crashed ? 0.35 : 0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    oscillator.connect(gain);
    gain.connect(this.master!);
    oscillator.start(now);
    oscillator.stop(now + 0.4);
  }

  /** A soft water arrival: damped noise over a low body thump. */
  splash(): void {
    if (!this.context || !this.master || !this.active || this.muted) return;
    const now = this.context.currentTime;

    if (this.noiseBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.noiseBuffer;
      const filter = this.context.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(1500, now);
      filter.frequency.exponentialRampToValueAtTime(240, now + 0.34);
      filter.Q.value = 0.7;
      const gain = this.context.createGain();
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      source.start(now);
      source.stop(now + 0.6);
    }

    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(110, now);
    oscillator.frequency.exponentialRampToValueAtTime(42, now + 0.22);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.36);
  }

  /** Advance the ambient score: slow chord changes and occasional bells. */
  private updateMusic(dt: number): void {
    if (!this.context || !this.musicGain) return;

    this.musicChordClock += dt;
    if (this.musicChordClock >= MUSIC_CHORD_SECONDS) {
      this.musicChordClock -= MUSIC_CHORD_SECONDS;
      this.musicStep = (this.musicStep + 1) % MUSIC_CHORDS.length;
      const now = this.context.currentTime;
      const chord = MUSIC_CHORDS[this.musicStep];
      for (let i = 0; i < this.musicVoices.length; i++) {
        const frequency = chord[i] ?? chord[0];
        // Glide into the next chord rather than stepping to it.
        this.musicVoices[i].oscillator.frequency.setTargetAtTime(frequency, now, 1.6);
      }
    }

    this.musicBellClock -= dt;
    if (this.musicBellClock <= 0) {
      this.musicBellClock = 6 + Math.random() * 7;
      const frequency = MUSIC_BELLS[Math.floor(Math.random() * MUSIC_BELLS.length)];
      this.musicBell(frequency);
    }
  }

  private musicBell(frequency: number): void {
    if (!this.context || !this.musicGain) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.13, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 4.2);
    const panner = this.context.createStereoPanner();
    panner.pan.value = Math.random() * 1.6 - 0.8;
    oscillator.connect(gain);
    gain.connect(panner);
    panner.connect(this.musicGain);
    if (this.musicDelay) panner.connect(this.musicDelay);
    oscillator.start(now);
    oscillator.stop(now + 4.4);
  }

  private beep(frequency: number, duration: number, volume: number): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }
}
