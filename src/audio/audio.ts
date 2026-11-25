import { clamp } from "../core/math";
import type { Simulation } from "../sim/simulation";

interface MusicVoice {
  oscillator: OscillatorNode;
  gain: GainNode;
  baseGain: number;
}

/** Slow chords for the ambient bed, from the bass up, rooted on D. */
const MUSIC_CHORDS = [
  [73.42, 146.83, 220.0, 293.66, 349.23], // Dm(add9)
  [116.54, 174.61, 233.08, 293.66, 349.23], // B-flat major
  [87.31, 174.61, 261.63, 349.23, 392.0], // F add9
  [130.81, 196.0, 261.63, 329.63, 392.0], // C add9
  [98.0, 146.83, 196.0, 233.08, 293.66], // G minor 7
  [110.0, 164.81, 220.0, 261.63, 329.63], // A minor 9
  [73.42, 146.83, 220.0, 329.63, 349.23], // D minor 9
  [116.54, 174.61, 233.08, 261.63, 349.23], // B-flat major 9
  [87.31, 174.61, 261.63, 329.63, 349.23], // F major 7
  [130.81, 196.0, 261.63, 293.66, 392.0], // C sus2
  [98.0, 146.83, 220.0, 233.08, 293.66], // G minor 9
  [110.0, 164.81, 220.0, 293.66, 329.63], // A sus4
];
/** D-minor pentatonic notes for the melody. */
const MUSIC_PENTATONIC = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33];
/**
 * Chord progressions as indexes into MUSIC_CHORDS: i-VI-III-VII, a coloured
 * variant of it, and i-iv-VI-V. The score plays them as an A A' B A' form.
 */
const MUSIC_PROGRESSIONS = [
  [0, 1, 2, 3],
  [6, 7, 8, 9],
  [6, 10, 7, 11],
] as const;
const MUSIC_FORM = [0, 1, 2, 1] as const;
/** One chord per two bars, four chords per phrase. */
const MUSIC_STEPS_PER_CHORD = 16;
const MUSIC_PHRASE_CHORDS = 4;
const MUSIC_FORM_CHORDS = MUSIC_PHRASE_CHORDS * MUSIC_FORM.length;
const MUSIC_FORM_BARS = (MUSIC_FORM_CHORDS * MUSIC_STEPS_PER_CHORD) / 16;
/** Each flight gets a fresh key: D, A, E or G minor. */
const MUSIC_KEYS = [0, -5, 2, 5];
const MUSIC_BPM_MIN = 68;
const MUSIC_BPM_MAX = 76;
/** Share of the beat given to the onbeat eighth, for a gentle swing. */
const MUSIC_SWING = 0.58;
const MUSIC_LEVEL = 1.1;
/** Fallback eighth-note length before the first flight picks a tempo. */
const MUSIC_STEP_SECONDS = 30 / 72;

export type MusicTrack = "ambient" | "synthwave";

/**
 * Synthwave: an eight-bar night-drive loop in A minor, transposed per flight.
 * The pad, bass, arpeggio, drums and lead all share the same bar grid.
 */
const SYNTH_BPM_MIN = 94;
const SYNTH_BPM_MAX = 110;
const SYNTH_STEPS_PER_BAR = 16;
const SYNTH_BARS = 8;
const SYNTH_CHORDS = [
  { root: 45, intervals: [0, 3, 7, 10, 14] }, // Am9
  { root: 41, intervals: [0, 4, 7, 11, 14] }, // Fmaj9
  { root: 48, intervals: [0, 4, 7, 11, 14] }, // Cmaj9
  { root: 43, intervals: [0, 4, 7, 10, 14] }, // G9
  { root: 45, intervals: [0, 3, 7, 10, 14] }, // Am9
  { root: 41, intervals: [0, 4, 7, 11, 14] }, // Fmaj9
  { root: 50, intervals: [0, 3, 7, 10, 14] }, // Dm9
  { root: 40, intervals: [0, 4, 7, 10, 14] }, // E7
] as const;
const SYNTH_KEYS = [-5, -2, 0, 2, 5, 7] as const;
const SYNTH_ARP = [0, 1, 2, 3, 4, 3, 2, 1] as const;
/** Sparse lead motif, indexed by sixth-note step; null rests. */
const SYNTH_LEAD_MOTIF = [
  null,
  null,
  4,
  null,
  null,
  null,
  3,
  null,
  2,
  null,
  null,
  4,
  null,
  2,
  null,
  null,
] as const;
const SYNTH_PAD_GAINS = [0.13, 0.095, 0.07, 0.055, 0.04] as const;

function midiToHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/** Small WebAudio soundscape: wind, vario beeps, a stall horn and a thud. */
export class AudioEngine {
  private context: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private stallGain: GainNode | null = null;
  private sinkOscillator: OscillatorNode | null = null;
  private sinkGain: GainNode | null = null;
  private towOscillator: OscillatorNode | null = null;
  private towGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicPadGain: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private musicDelay: DelayNode | null = null;
  private musicVoices: MusicVoice[] = [];
  private musicTrack: MusicTrack = "ambient";
  private synthTranspose = 0;
  private synthRoot = 45;
  private synthChord: readonly number[] = [];
  private musicEnabled = false;
  private musicStepClock = 0;
  private musicStepSeconds = MUSIC_STEP_SECONDS;
  private musicPitchRatio = 1;
  private musicChord: readonly number[] = MUSIC_CHORDS[0];
  private musicMelodyIndex = 2;
  private musicBeatStep = 0;
  private noiseBuffer: AudioBuffer | null = null;
  private beepClock = 0;
  private sfxMuted = false;
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
      master.gain.value = 0.55;
      master.connect(context.destination);

      // Effects share a bus of their own so they can be silenced without
      // touching the ambient score, which connects straight to the master.
      const sfxGain = context.createGain();
      sfxGain.gain.value = this.sfxMuted ? 0 : 1;
      sfxGain.connect(master);
      this.sfxGain = sfxGain;

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
      windGain.connect(sfxGain);
      source.start();

      this.windFilter = filter;
      this.windGain = windGain;

      const stallOscillator = context.createOscillator();
      stallOscillator.type = "square";
      stallOscillator.frequency.value = 620;
      const stallGain = context.createGain();
      stallGain.gain.value = 0;
      stallOscillator.connect(stallGain);
      stallGain.connect(sfxGain);
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
      sinkGain.connect(sfxGain);
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
      towGain.connect(sfxGain);
      towOscillator.start();
      this.towOscillator = towOscillator;
      this.towGain = towGain;

      // Optional ambient music: a breathing pad, a melody, bells and a soft
      // pulse. It is built up front so toggling is just a gain change, and it
      // stays off by default.
      const musicGain = context.createGain();
      musicGain.gain.value = this.musicEnabled ? MUSIC_LEVEL : 0;
      const musicCompressor = context.createDynamicsCompressor();
      musicCompressor.threshold.value = -18;
      musicCompressor.knee.value = 20;
      musicCompressor.ratio.value = 4;
      musicCompressor.attack.value = 0.004;
      musicCompressor.release.value = 0.2;
      musicGain.connect(musicCompressor);
      musicCompressor.connect(master);
      this.musicGain = musicGain;

      const musicFilter = context.createBiquadFilter();
      musicFilter.type = "lowpass";
      musicFilter.frequency.value = 1100;
      musicFilter.Q.value = 0.4;
      this.musicFilter = musicFilter;

      // A separate pad gain lets each new chord swell in instead of sitting
      // flat for its whole duration.
      const musicPadGain = context.createGain();
      musicPadGain.gain.value = 1;
      musicFilter.connect(musicPadGain);
      musicPadGain.connect(musicGain);
      this.musicPadGain = musicPadGain;

      // A very slow filter drift keeps the pad from sounding static.
      const lfo = context.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.045;
      const lfoDepth = context.createGain();
      lfoDepth.gain.value = 320;
      lfo.connect(lfoDepth);
      lfoDepth.connect(musicFilter.frequency);
      lfo.start();

      const voiceGains = [0.3, 0.2, 0.16, 0.12, 0.1];
      this.musicVoices = MUSIC_CHORDS[0].map((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.type = index <= 2 ? "triangle" : "sine";
        oscillator.frequency.value = frequency;
        oscillator.detune.value = (index - 2) * 4;
        const gain = context.createGain();
        const baseGain = voiceGains[index] ?? 0.12;
        gain.gain.value = baseGain;
        // Each voice breathes at its own slow rate, so the chord never sits
        // completely still.
        const tremolo = context.createOscillator();
        tremolo.type = "sine";
        tremolo.frequency.value = 0.05 + index * 0.017;
        const tremoloDepth = context.createGain();
        tremoloDepth.gain.value = baseGain * 0.42;
        tremolo.connect(tremoloDepth);
        tremoloDepth.connect(gain.gain);
        tremolo.start();
        const panner = context.createStereoPanner();
        panner.pan.value = (index / (MUSIC_CHORDS[0].length - 1)) * 0.8 - 0.4;
        oscillator.connect(gain);
        gain.connect(panner);
        panner.connect(musicFilter);
        oscillator.start();
        return { oscillator, gain, baseGain };
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

      this.configureMusic(this.musicTrack);
      if (this.musicTrack === "synthwave") this.applySynthBar(0, true);
      else this.applyChord(0);

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

  /** Toggle the score. Off by default and independent of the mix mute. */
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

  /**
   * Fresh key and tempo for a new flight, with the score back at the top of
   * the form. Safe before the audio context exists; the settings apply once
   * it does.
   */
  startScore(track: MusicTrack = this.musicTrack): void {
    this.musicTrack = track;
    this.musicStepClock = 0;
    this.musicBeatStep = 0;

    if (track === "synthwave") {
      this.synthTranspose = SYNTH_KEYS[Math.floor(Math.random() * SYNTH_KEYS.length)];
      this.synthChord = [];
      this.musicStepSeconds =
        15 / (SYNTH_BPM_MIN + Math.random() * (SYNTH_BPM_MAX - SYNTH_BPM_MIN));
      this.configureMusic(track);
      this.applySynthBar(0, true);
      return;
    }

    const key = MUSIC_KEYS[Math.floor(Math.random() * MUSIC_KEYS.length)];
    this.musicPitchRatio = 2 ** (key / 12);
    this.musicStepSeconds =
      30 / (MUSIC_BPM_MIN + Math.random() * (MUSIC_BPM_MAX - MUSIC_BPM_MIN));
    this.musicMelodyIndex = 2;
    this.configureMusic(track);
    this.applyChord(0);
  }

  /** Shape the shared pad for the selected score. */
  private configureMusic(track: MusicTrack): void {
    if (!this.context) return;
    const now = this.context.currentTime;

    this.musicFilter?.frequency.setTargetAtTime(
      track === "synthwave" ? 1900 : 1100,
      now,
      0.3,
    );
    this.musicDelay?.delayTime.setTargetAtTime(
      track === "synthwave" ? 0.34 : 0.42,
      now,
      0.2,
    );

    for (let i = 0; i < this.musicVoices.length; i++) {
      const voice = this.musicVoices[i];
      voice.oscillator.type =
        track === "synthwave"
          ? i <= 3
            ? "sawtooth"
            : "triangle"
          : i <= 2
            ? "triangle"
            : "sine";
      voice.oscillator.detune.setTargetAtTime(
        (i - 2) * (track === "synthwave" ? 9 : 4),
        now,
        0.2,
      );
    }
  }

  /**
   * Toggle the effects mix (wind, vario, stall, tug, touchdown) without
   * touching the score, which has its own toggle.
   */
  toggleSound(): boolean {
    this.sfxMuted = !this.sfxMuted;
    if (this.context && this.sfxGain) {
      this.sfxGain.gain.setTargetAtTime(
        this.sfxMuted ? 0 : 1,
        this.context.currentTime,
        0.05,
      );
    }
    return this.sfxMuted;
  }

  get isSoundMuted(): boolean {
    return this.sfxMuted;
  }

  update(sim: Simulation, dt: number): void {
    if (!this.context || !this.active) return;
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
    if (!this.context || !this.sfxGain || !this.active) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(crashed ? 90 : 130, now);
    oscillator.frequency.exponentialRampToValueAtTime(35, now + 0.25);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(crashed ? 0.35 : 0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    oscillator.connect(gain);
    gain.connect(this.sfxGain);
    oscillator.start(now);
    oscillator.stop(now + 0.4);
  }

  /** A soft water arrival: damped noise over a low body thump. */
  splash(): void {
    if (!this.context || !this.sfxGain || !this.active) return;
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
      gain.connect(this.sfxGain);
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
    gain.connect(this.sfxGain);
    oscillator.start(now);
    oscillator.stop(now + 0.36);
  }

  /** Advance the selected score on its step grid. */
  private updateMusic(dt: number): void {
    if (!this.context || !this.musicGain) return;

    this.musicStepClock += dt;
    // Cap the catch-up after a long frame so a stall never dumps a burst of
    // notes into one instant.
    let steps = 0;
    while (this.musicStepClock >= this.stepSeconds(this.musicBeatStep) && steps < 4) {
      this.musicStepClock -= this.stepSeconds(this.musicBeatStep);
      this.musicStep();
      steps++;
    }
    if (steps === 4) this.musicStepClock = 0;
  }

  /** Length of one step: swung eighths for ambient, straight 16ths for synth. */
  private stepSeconds(step: number): number {
    if (this.musicTrack === "synthwave") return this.musicStepSeconds;
    const pair = this.musicStepSeconds * 2;
    return pair * (step % 2 === 0 ? MUSIC_SWING : 1 - MUSIC_SWING);
  }

  /** One step of the score: harmony, bells, melody and pulse all share it. */
  private musicStep(): void {
    const step = this.musicBeatStep++;
    if (this.musicTrack === "synthwave") {
      this.synthStep(step);
      return;
    }

    if (step % MUSIC_STEPS_PER_CHORD === 0) {
      this.applyChord(Math.floor(step / MUSIC_STEPS_PER_CHORD) % MUSIC_FORM_CHORDS);
    }

    // Bells land on bar lines and borrow a tone from the current chord.
    if (step % 16 === 0 && Math.random() < 0.22) {
      const chord = this.musicChord;
      const tone = chord[2 + Math.floor(Math.random() * 3)] ?? chord[chord.length - 1];
      this.musicBell(tone * 2 * this.musicPitchRatio);
    }

    // A pentatonic melody on the eighth grid: denser on the beat, and the last
    // bar of each phrase is left open so the line breathes.
    const phraseSteps = MUSIC_PHRASE_CHORDS * MUSIC_STEPS_PER_CHORD;
    const inPhrase = step % phraseSteps;
    const phraseEnd = inPhrase >= phraseSteps - MUSIC_STEPS_PER_CHORD;
    if (!phraseEnd) {
      const density = step % 2 === 0 ? 0.38 : 0.13;
      if (Math.random() < density) this.musicMelody();
    }

    this.musicBeat(step);
  }

  /** Move the pad to a chord slot in the A A' B A' form. */
  private applyChord(slot: number): void {
    const phrase = MUSIC_FORM[Math.floor(slot / MUSIC_PHRASE_CHORDS) % MUSIC_FORM.length];
    const chord = MUSIC_CHORDS[MUSIC_PROGRESSIONS[phrase][slot % MUSIC_PHRASE_CHORDS]];
    this.musicChord = chord;
    if (!this.context) return;
    const now = this.context.currentTime;

    for (let i = 0; i < this.musicVoices.length; i++) {
      const voice = this.musicVoices[i];
      const frequency = (chord[i] ?? chord[0]) * this.musicPitchRatio;
      voice.oscillator.frequency.setTargetAtTime(frequency, now + i * 0.015, 0.4);
      // Re-attack each voice, staggered from the bass up, so the change
      // articulates instead of smearing from one chord into the next.
      voice.gain.gain.setTargetAtTime(voice.baseGain * 0.7, now + i * 0.02, 0.06);
      voice.gain.gain.setTargetAtTime(voice.baseGain, now + 0.14 + i * 0.02, 0.45);
    }

    if (this.musicPadGain) {
      // Dip and swell around each change so the pad has a pulse of its own.
      this.musicPadGain.gain.setTargetAtTime(0.75, now, 0.12);
      this.musicPadGain.gain.setTargetAtTime(1, now + 0.4, 0.8);
    }
  }

  /** Move the shared pad to a synthwave bar and store its chord. */
  private applySynthBar(bar: number, instant = false): void {
    const chord = SYNTH_CHORDS[bar % SYNTH_BARS];
    const root = chord.root + this.synthTranspose;
    this.synthRoot = root;
    this.synthChord = chord.intervals.map((interval) => root + interval);
    if (!this.context) return;

    const now = this.context.currentTime;
    for (let i = 0; i < this.musicVoices.length; i++) {
      const voice = this.musicVoices[i];
      const midi = this.synthChord[i] ?? this.synthChord[0] + 12;
      const gain = SYNTH_PAD_GAINS[i] ?? 0.08;
      voice.oscillator.frequency.setTargetAtTime(
        midiToHz(midi),
        now + i * 0.012,
        instant ? 0.08 : 0.25,
      );
      voice.gain.gain.setTargetAtTime(gain * (instant ? 1 : 0.55), now, 0.04);
      voice.gain.gain.setTargetAtTime(gain, now + 0.1 + i * 0.02, instant ? 0.18 : 0.4);
    }

    if (this.musicPadGain) {
      this.musicPadGain.gain.setTargetAtTime(instant ? 1 : 0.75, now, 0.08);
      this.musicPadGain.gain.setTargetAtTime(1, now + 0.25, 0.5);
    }
  }

  /** One 16th-note step of the synthwave loop. */
  private synthStep(step: number): void {
    const bar = Math.floor(step / SYNTH_STEPS_PER_BAR) % SYNTH_BARS;
    const beat = step % SYNTH_STEPS_PER_BAR;
    if (beat === 0) this.applySynthBar(bar);

    const notes = this.synthChord;
    if (notes.length === 0) return;

    // Bass: root on every beat, with an octave lift on the and of three.
    if (beat % 4 === 0) {
      this.synthBass(midiToHz(this.synthRoot - 12), 0.1, 0.42);
    } else if (beat % 4 === 2) {
      const lift = beat === 6 ? 12 : 0;
      this.synthBass(midiToHz(this.synthRoot - 12 + lift), 0.05, 0.26);
    }

    // Arpeggio: eighths in the first half, sixteenths once the B section opens.
    const arpEvery = bar >= 4 ? 1 : 2;
    if (beat % arpEvery === 0) {
      const index = Math.floor(step / arpEvery) % SYNTH_ARP.length;
      // Alternate the whole arpeggio an octave up every bar, so the line
      // climbs and falls with the progression instead of sitting in one
      // register for the entire loop.
      const octave = bar % 2 === 0 ? 12 : 24;
      const tone = notes[SYNTH_ARP[index] % notes.length] + octave;
      const pan = index % 2 === 0 ? -0.4 : 0.4;
      this.synthArp(midiToHz(tone), 0.008, pan);
    }

    // Four-on-the-floor drums, with a small fill at the end of the loop.
    if (beat % 4 === 0) this.synthKick(0.9);
    if (beat === 4 || beat === 12) this.synthSnare(0.38);
    if (bar === SYNTH_BARS - 1 && (beat === 14 || beat === 15)) this.synthSnare(0.26);
    if (beat % 2 === 0) {
      this.synthHat(
        beat % 4 === 0 ? 0.065 : 0.036,
        beat === 14,
        beat % 4 === 0 ? -0.35 : 0.35,
      );
    }

    // A sparse lead phrase arrives after the intro and follows the chord.
    if (bar >= 2) {
      const tone = SYNTH_LEAD_MOTIF[beat];
      if (tone !== null) {
        const note = notes[tone % notes.length] + 12;
        this.synthLead(midiToHz(note), 0.021, 0.55);
      }
    }
  }

  /** One pentatonic note, preferring stepwise motion with the odd octave leap. */
  private musicMelody(): void {
    const steps = [-2, -1, -1, 0, 1, 1, 2];
    const move = steps[Math.floor(Math.random() * steps.length)];
    this.musicMelodyIndex = clamp(
      this.musicMelodyIndex + move,
      0,
      MUSIC_PENTATONIC.length - 1,
    );
    let frequency = MUSIC_PENTATONIC[this.musicMelodyIndex] * this.musicPitchRatio;
    if (Math.random() < 0.12 && this.musicMelodyIndex <= 3) frequency *= 2;
    this.musicNote(frequency, 0.13 + Math.random() * 0.05, 0.8 + Math.random() * 0.8);
  }

  /** One bar of the soft downtempo pulse. */
  private musicBeat(step: number): void {
    const bar = step % 16;
    const formBar = Math.floor(step / 16) % MUSIC_FORM_BARS;
    const lastBar = formBar === MUSIC_FORM_BARS - 1;

    if (!lastBar) {
      switch (bar) {
        case 0:
        case 8:
          this.musicKick(0.5);
          break;
        case 4:
        case 12:
          this.musicKick(0.32);
          break;
        case 11:
          // A ghost kick on the second bar keeps the pulse from feeling square.
          this.musicKick(0.2);
          break;
      }
    }

    if (bar === 2 || bar === 10) this.musicBrush(0.11);
    if (bar === 6 || bar === 14) this.musicBrush(0.09);

    // The closing bar of the form opens up: no kick, brushes pulling into the
    // next A section.
    if (lastBar && (bar === 12 || bar === 14)) this.musicBrush(0.14);

    // A short gap in the shaker now and then keeps the groove from locking.
    if (bar % 2 === 1 && Math.random() > 0.12) {
      this.musicShaker(0.024, bar % 4 === 1 ? -0.5 : 0.5);
    }
  }

  /** A punchy synthwave kick with a quiet noise click. */
  private synthKick(level: number): void {
    if (!this.context || !this.musicGain) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(175, now);
    oscillator.frequency.exponentialRampToValueAtTime(55, now + 0.18);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    oscillator.connect(gain);
    gain.connect(this.musicGain);
    oscillator.start(now);
    oscillator.stop(now + 0.32);

    if (this.noiseBuffer) {
      const click = this.context.createBufferSource();
      click.buffer = this.noiseBuffer;
      const filter = this.context.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = 2400;
      const clickGain = this.context.createGain();
      clickGain.gain.setValueAtTime(0.16, now);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
      click.connect(filter);
      filter.connect(clickGain);
      clickGain.connect(this.musicGain);
      click.start(now, Math.random() * 1.2, 0.035);
    }
  }

  /** A bright synthwave snare with a short body and a little delay. */
  private synthSnare(level: number): void {
    if (!this.context || !this.musicGain || !this.noiseBuffer) return;
    const now = this.context.currentTime;

    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1900;
    filter.Q.value = 0.8;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(level * (0.9 + Math.random() * 0.2), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.musicGain);
    if (this.musicDelay) {
      const send = this.context.createGain();
      send.gain.value = 0.12;
      gain.connect(send);
      send.connect(this.musicDelay);
    }
    source.start(now, Math.random() * 1.2, 0.24);

    const body = this.context.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(180, now);
    body.frequency.exponentialRampToValueAtTime(120, now + 0.1);
    const bodyGain = this.context.createGain();
    bodyGain.gain.setValueAtTime(level * 0.45, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    body.connect(bodyGain);
    bodyGain.connect(this.musicGain);
    body.start(now);
    body.stop(now + 0.14);
  }

  /** A short closed or open hi-hat. */
  private synthHat(level: number, open: boolean, pan: number): void {
    if (!this.context || !this.musicGain || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 6500;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(level * (0.85 + Math.random() * 0.3), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (open ? 0.17 : 0.05));
    const panner = this.context.createStereoPanner();
    panner.pan.value = pan;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.musicGain);
    source.start(now, Math.random() * 1.5, open ? 0.18 : 0.06);
  }

  /** A filtered saw bass with a sine sub. */
  private synthBass(frequency: number, level: number, duration: number): void {
    if (!this.context || !this.musicGain) return;
    const now = this.context.currentTime;

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(700, Math.max(240, frequency * 7)), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(110, frequency * 2.5), now + duration);
    filter.Q.value = 4;

    const saw = this.context.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = frequency;
    const sawGain = this.context.createGain();
    sawGain.gain.value = 0.65;
    saw.connect(filter);
    filter.connect(sawGain);
    sawGain.connect(gain);

    const sub = this.context.createOscillator();
    sub.type = "sine";
    sub.frequency.value = frequency;
    const subGain = this.context.createGain();
    subGain.gain.value = 0.5;
    sub.connect(subGain);
    subGain.connect(gain);

    gain.connect(this.musicGain);
    saw.start(now);
    sub.start(now);
    saw.stop(now + duration + 0.05);
    sub.stop(now + duration + 0.05);
  }

  /** A short detuned saw arpeggio note with a stereo delay send. */
  private synthArp(frequency: number, level: number, pan: number): void {
    if (!this.context || !this.musicGain) return;
    const now = this.context.currentTime;

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.min(4200, Math.max(900, frequency * 5));
    filter.Q.value = 1.4;

    const panner = this.context.createStereoPanner();
    panner.pan.value = pan;

    const first = this.context.createOscillator();
    first.type = "sawtooth";
    first.frequency.value = frequency;
    first.detune.value = -7;
    const second = this.context.createOscillator();
    second.type = "sawtooth";
    second.frequency.value = frequency;
    second.detune.value = 7;

    first.connect(filter);
    second.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.musicGain);
    if (this.musicDelay) panner.connect(this.musicDelay);

    first.start(now);
    second.start(now);
    first.stop(now + 0.2);
    second.stop(now + 0.2);
  }

  /** A longer detuned lead note with a touch of vibrato and delay. */
  private synthLead(frequency: number, level: number, duration: number): void {
    if (!this.context || !this.musicGain) return;
    const now = this.context.currentTime;

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2600;
    filter.Q.value = 0.7;

    const panner = this.context.createStereoPanner();
    panner.pan.value = -0.12;

    const first = this.context.createOscillator();
    first.type = "sawtooth";
    first.frequency.value = frequency;
    first.detune.value = -5;
    const second = this.context.createOscillator();
    second.type = "sawtooth";
    second.frequency.value = frequency;
    second.detune.value = 5;

    const vibrato = this.context.createOscillator();
    vibrato.type = "sine";
    vibrato.frequency.value = 5.2;
    const vibratoDepth = this.context.createGain();
    vibratoDepth.gain.value = 5;
    vibrato.connect(vibratoDepth);
    vibratoDepth.connect(first.detune);
    vibratoDepth.connect(second.detune);

    first.connect(filter);
    second.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.musicGain);
    if (this.musicDelay) panner.connect(this.musicDelay);

    first.start(now);
    second.start(now);
    vibrato.start(now);
    first.stop(now + duration + 0.1);
    second.stop(now + duration + 0.1);
    vibrato.stop(now + duration + 0.1);
  }

  /** A soft rounded kick. */
  private musicKick(level: number): void {
    if (!this.context || !this.musicGain) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(115, now);
    oscillator.frequency.exponentialRampToValueAtTime(42, now + 0.22);
    const gain = this.context.createGain();
    // Humanise the level slightly so the bar never sounds machine-tight.
    gain.gain.setValueAtTime(level * (0.9 + Math.random() * 0.2), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
    oscillator.connect(gain);
    gain.connect(this.musicGain);
    oscillator.start(now);
    oscillator.stop(now + 0.42);
  }

  /** A brushed-noise backbeat, short and dark. */
  private musicBrush(level: number): void {
    if (!this.context || !this.musicGain || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1700;
    filter.Q.value = 0.7;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(level * (0.85 + Math.random() * 0.3), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.musicGain);
    source.start(now);
    source.stop(now + 0.24);
  }

  /** A quiet offbeat shaker, panned slightly left or right. */
  private musicShaker(level: number, pan: number): void {
    if (!this.context || !this.musicGain || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 5200;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(level * (0.8 + Math.random() * 0.4), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    const panner = this.context.createStereoPanner();
    panner.pan.value = pan;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.musicGain);
    source.start(now);
    source.stop(now + 0.11);
  }

  /** A soft lead note: a triangle fundamental with a quiet octave shimmer. */
  private musicNote(frequency: number, level: number, duration: number): void {
    if (!this.context || !this.musicGain) return;
    const now = this.context.currentTime;

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.max(1200, frequency * 4);
    filter.Q.value = 0.4;

    const panner = this.context.createStereoPanner();
    panner.pan.value = Math.random() * 0.7 - 0.35;

    const oscillator = this.context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = frequency;
    oscillator.detune.value = Math.random() * 6 - 3;

    const shimmer = this.context.createOscillator();
    shimmer.type = "sine";
    shimmer.frequency.value = frequency * 2;
    const shimmerGain = this.context.createGain();
    shimmerGain.gain.value = 0.18;

    oscillator.connect(gain);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(gain);
    gain.connect(filter);
    filter.connect(panner);
    panner.connect(this.musicGain);
    if (this.musicDelay) panner.connect(this.musicDelay);

    oscillator.start(now);
    shimmer.start(now);
    oscillator.stop(now + duration + 0.1);
    shimmer.stop(now + duration + 0.1);
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
    if (!this.context || !this.sfxGain) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(this.sfxGain);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }
}
