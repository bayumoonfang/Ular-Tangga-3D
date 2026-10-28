import type { EventBus } from '../core/EventBus';
import { CHARGE_PERFECT_FROM } from '../config';
import { settings } from '../utils/settings';

export type TrackId = 'menu' | 'game' | 'tension' | 'victory';

export type SfxId =
  | 'click'
  | 'hover'
  | 'dice_shake'
  | 'dice_roll'
  | 'dice_land'
  | 'step'
  | 'ladder_up'
  | 'cheer'
  | 'snake_hiss'
  | 'bite'
  | 'slide_down'
  | 'womp'
  | 'bonus'
  | 'fanfare'
  | 'fireworks'
  | 'crowd_cheer'
  | 'your_turn'
  | 'yay'
  | 'oh_no'
  | 'pop'
  | 'tick'
  | 'perfect'
  | 'fizzle'
  // ekspresi (arg = pengali volume, 0 = penuh)
  | 'x_clap'
  | 'x_laugh'
  | 'x_scream'
  | 'x_cheer'
  | 'x_wow'
  | 'x_boo'
  | 'x_cry'
  | 'x_love';

// ───────────────────────── Notasi musik ─────────────────────────

const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C5' -> 72, 'G#4' -> 68 */
function midi(name: string): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name);
  if (!m) throw new Error(`nama nada tidak valid: ${name}`);
  return 12 * (Number(m[3]) + 1) + SEMITONE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface Note {
  m: number;
  /** panjang dalam 1/16 */
  len: number;
}

/** Satu string per bar: "E5:2 G5:2 -:4" (nama:panjang, '-' = diam). Setiap bar harus berjumlah 16. */
function melody(bars: string[]): (Note | null)[] {
  const out: (Note | null)[] = [];
  bars.forEach((bar, bi) => {
    let total = 0;
    for (const tok of bar.trim().split(/\s+/)) {
      const [name, len] = tok.split(':');
      const l = Number(len);
      out.push(name === '-' ? null : { m: midi(name), len: l });
      for (let k = 1; k < l; k++) out.push(null);
      total += l;
    }
    if (total !== 16) throw new Error(`bar ${bi + 1} berjumlah ${total}, harus 16`);
  });
  return out;
}

interface Chord {
  /** nada bass */
  root: number;
  /** triad di oktaf tengah */
  tones: number[];
}

/** 'C' mayor / 'Am' minor, akar di oktaf 3. */
function chord(name: string): Chord {
  const minor = name.endsWith('m');
  const root = midi(name.replace('m', '') + '3');
  return { root: root - 12, tones: [root + 12, root + 12 + (minor ? 3 : 4), root + 19] };
}

type Style = 'oompah' | 'bounce' | 'drive' | 'fanfare';

interface TrackDef {
  bpm: number;
  loop: boolean;
  style: Style;
  chords: Chord[];
  melody: (Note | null)[];
  lead: OscillatorType;
  /** gandakan melodi dengan marimba satu oktaf di atas */
  sparkle: boolean;
}

const TRACKS: Record<TrackId, TrackDef> = {
  // karnaval / sirkus: oom-pah ceria
  menu: {
    bpm: 132,
    loop: true,
    style: 'oompah',
    lead: 'square',
    sparkle: true,
    chords: ['C', 'Am', 'F', 'G', 'C', 'Am', 'Dm', 'G'].map(chord),
    melody: melody([
      'E5:2 G5:2 C6:4 B5:2 G5:2 E5:4',
      'A5:2 C6:2 E6:4 D6:2 C6:2 A5:4',
      'A5:2 C6:2 F6:4 E6:2 C6:2 A5:4',
      'G5:2 B5:2 D6:4 C6:2 B5:2 G5:4',
      'C6:4 G5:2 E5:2 G5:4 C6:4',
      'E6:4 C6:2 A5:2 C6:4 E6:4',
      'F6:2 E6:2 D6:2 C6:2 D6:4 A5:4',
      'B5:2 C6:2 D6:2 E6:2 D6:4 -:2 G5:2',
    ]),
  },
  // riang, melompat-lompat, enak didengar lama
  game: {
    bpm: 112,
    loop: true,
    style: 'bounce',
    lead: 'triangle',
    sparkle: true,
    chords: ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'G'].map(chord),
    melody: melody([
      'G5:3 E5:1 G5:2 A5:2 G5:4 E5:4',
      'D5:3 G5:1 B5:2 A5:2 G5:4 -:4',
      'C6:3 A5:1 E5:2 A5:2 C6:4 B5:4',
      'A5:3 F5:1 A5:2 C6:2 A5:4 -:4',
      'E5:2 G5:2 C6:3 B5:1 C6:2 D6:2 E6:4',
      'D6:3 B5:1 G5:2 B5:2 D6:4 -:4',
      'C6:2 A5:2 F5:2 A5:2 C6:4 A5:4',
      'B5:3 G5:1 D5:2 G5:2 B5:2 D6:2 G5:4',
    ]),
  },
  // lebih cepat saat ada pemain di petak >= 90
  tension: {
    bpm: 152,
    loop: true,
    style: 'drive',
    lead: 'sawtooth',
    sparkle: false,
    chords: ['Am', 'F', 'G', 'E'].map(chord),
    melody: melody([
      'A5:2 C6:2 E6:2 C6:2 A5:2 C6:2 E6:2 A6:2',
      'F5:2 A5:2 C6:2 A5:2 F5:2 A5:2 C6:2 F6:2',
      'G5:2 B5:2 D6:2 B5:2 G5:2 B5:2 D6:2 G6:2',
      'E5:2 G#5:2 B5:2 G#5:2 E5:2 G#5:2 B5:2 E6:2',
    ]),
  },
  victory: {
    bpm: 140,
    loop: false,
    style: 'fanfare',
    lead: 'square',
    sparkle: true,
    chords: ['C', 'F', 'G', 'C'].map(chord),
    melody: melody([
      'G5:2 G5:2 G5:2 C6:6 E6:4',
      'F6:2 F6:2 F6:2 A6:6 C7:4',
      'G6:4 F6:2 E6:2 D6:4 B5:4',
      'C6:2 E6:2 G6:2 C7:10',
    ]),
  },
};

const PENTA = [0, 2, 4, 7, 9];
/** nada pentatonik mayor ke-i naik terus (dipakai langkah & tangga: selalu enak didengar) */
const penta = (i: number, base = 72) => base + PENTA[i % 5] + 12 * Math.floor(i / 5);

/** Tujuan keluaran sebuah suara: bus + kirim ke reverb (+ echo opsional). */
interface Out {
  dest: AudioNode;
  rev: AudioNode;
  echo?: AudioNode;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noiseBuf!: AudioBuffer;
  private sfxOut!: Out;
  private musicRev!: GainNode;
  private echoIn!: GainNode;
  private echoDelay!: DelayNode;

  private wantedTrack: TrackId | null = null;
  private activeTrack: TrackId | null = null;
  private trackGain: GainNode | null = null;
  private timer: number | null = null;
  private nextStepTime = 0;
  private stepCount = 0;
  private duck = 1;

  private charge: { osc: OscillatorNode; sub: OscillatorNode; gain: GainNode; perfect: boolean } | null = null;

  constructor() {
    settings.subscribe(() => this.applyVolumes());
    // kebijakan autoplay: buka audio pada interaksi pertama
    const unlock = () => {
      this.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  unlock(): void {
    if (!this.ctx) this.build();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.wantedTrack && this.activeTrack !== this.wantedTrack) this.startTrack(this.wantedTrack);
  }

  private build(): void {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // reverb sintetis (noise yang meluruh) — satu buffer, dua convolver (musik & SFX) agar volume terpisah
    const len = Math.floor(ctx.sampleRate * 1.7);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    const mkReverb = (bus: GainNode, wet: number) => {
      const input = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      const out = ctx.createGain();
      out.gain.value = wet;
      input.connect(conv).connect(out).connect(bus);
      return input;
    };
    this.musicRev = mkReverb(this.musicBus, 0.5);
    this.sfxOut = { dest: this.sfxBus, rev: mkReverb(this.sfxBus, 0.45) };

    // echo (dotted 1/8) untuk melodi
    this.echoIn = ctx.createGain();
    this.echoDelay = ctx.createDelay(1);
    this.echoDelay.delayTime.value = 0.34;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.echoIn.connect(this.echoDelay);
    this.echoDelay.connect(fb).connect(this.echoDelay);
    this.echoDelay.connect(wet).connect(this.musicBus);

    this.applyVolumes();
  }

  /** Tab di latar belakang: hentikan audio (hemat baterai, tidak ada musik tanpa permainan yang terlihat). */
  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  /** Turunkan volume musik sementara (mis. saat pause). */
  setDuck(v: number): void {
    this.duck = v;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const s = settings.all();
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.03);
    this.musicBus.gain.setTargetAtTime(s.music * 0.5 * this.duck, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.sfx, t, 0.03);
  }

  // ───────────────────────── Musik ─────────────────────────

  playMusic(track: TrackId | null): void {
    this.wantedTrack = track;
    if (!this.ctx) return; // dimulai saat unlock()
    if (track === this.activeTrack) return;
    if (track === null) this.stopTrack(0.6);
    else this.startTrack(track);
  }

  setTension(on: boolean): void {
    if (this.wantedTrack === 'game' && on) this.playMusic('tension');
    else if (this.wantedTrack === 'tension' && !on) this.playMusic('game');
  }

  private stopTrack(fade: number): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx && this.trackGain) {
      const g = this.trackGain;
      const t = this.ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + fade);
      setTimeout(() => g.disconnect(), (fade + 0.4) * 1000);
    }
    this.trackGain = null;
    this.activeTrack = null;
  }

  private startTrack(id: TrackId): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.stopTrack(0.8); // crossfade: track lama memudar, yang baru masuk
    const def = TRACKS[id];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(1, ctx.currentTime + (id === 'victory' ? 0.05 : 0.8));
    g.connect(this.musicBus);
    this.trackGain = g;
    this.activeTrack = id;
    this.stepCount = 0;
    this.nextStepTime = ctx.currentTime + 0.08;
    const sd = 60 / def.bpm / 4; // satu langkah = 1/16
    this.echoDelay.delayTime.setTargetAtTime(sd * 3, ctx.currentTime, 0.05);
    const out: Out = { dest: g, rev: this.musicRev, echo: this.echoIn };
    const total = def.melody.length;
    const schedule = () => {
      if (!this.ctx || this.trackGain !== g) return;
      while (this.nextStepTime < this.ctx.currentTime + 0.3) {
        // lagu non-loop berhenti setelah satu putaran + sedikit ekor
        if (!def.loop && this.stepCount >= total + 8) {
          this.stopTrack(1.8);
          return;
        }
        if (def.loop || this.stepCount < total) this.scheduleStep(def, this.stepCount, this.nextStepTime, out, sd);
        this.nextStepTime += sd;
        this.stepCount++;
      }
    };
    schedule();
    this.timer = window.setInterval(schedule, 60);
  }

  private scheduleStep(def: TrackDef, step: number, t: number, out: Out, sd: number): void {
    const s = step % def.melody.length;
    const bar = Math.floor(s / 16);
    const i = s % 16;
    const c = def.chords[bar];

    const note = def.melody[s];
    if (note) {
      const dur = note.len * sd;
      this.lead(hz(note.m), t, dur * 0.95, def.style === 'drive' ? 0.1 : 0.12, def.lead, out);
      if (def.sparkle) this.bell(hz(note.m + 12), t, Math.min(dur * 1.5, 0.9), 0.045, out);
    }

    switch (def.style) {
      case 'oompah': // bass di ketukan 1 & 3, akor di 2 & 4
        if (i === 0) this.bass(hz(c.root), t, sd * 6, 0.42, out);
        if (i === 8) this.bass(hz(c.root + 7), t, sd * 6, 0.38, out);
        if (i === 4 || i === 12) c.tones.forEach((m) => this.pluck(hz(m), t, sd * 3, 0.05, out, 'sawtooth', 2200));
        if (i === 0 || i === 8) this.kick(t, out, 0.5);
        if (i === 4 || i === 12) this.snare(t, out, 0.22);
        if (i % 2 === 0) this.hat(t, out, 0.05, false);
        if (i === 14 && bar % 2 === 1) this.pluck(hz(c.tones[2] + 12), t, sd * 2, 0.04, out, 'triangle', 3500);
        break;
      case 'bounce': {
        const bassAt: Record<number, number> = { 0: 0, 3: 0, 6: 7, 8: 0, 11: 12, 14: 7 };
        if (i in bassAt) this.bass(hz(c.root + bassAt[i]), t, sd * 2.6, 0.36, out);
        if (i === 0 || i === 8 || (i === 10 && bar % 2 === 1)) this.kick(t, out, 0.5);
        if (i === 4 || i === 12) this.snare(t, out, 0.2);
        if (i % 4 === 2) this.hat(t, out, 0.07, true);
        if (i % 4 === 2) c.tones.forEach((m) => this.pluck(hz(m), t, sd * 1.5, 0.035, out, 'square', 1800));
        if (i % 2 === 1) this.hat(t, out, 0.025, false);
        break;
      }
      case 'drive':
        if (i % 4 === 0) this.kick(t, out, 0.55);
        if (i === 14 && bar % 2 === 1) this.kick(t, out, 0.4);
        if (i === 4 || i === 12) this.snare(t, out, 0.3);
        if (i % 2 === 0) this.bass(hz(c.root + (i % 4 === 2 ? 12 : 0)), t, sd * 1.6, 0.3, out);
        if (i % 2 === 0) this.hat(t, out, 0.06, i === 6 || i === 14);
        if (i % 2 === 1) this.pluck(hz(c.tones[(i >> 1) % 3] + 12), t, sd * 1.5, 0.04, out, 'square', 2600);
        break;
      case 'fanfare':
        if (i === 0) {
          this.crash(t, out);
          c.tones.forEach((m) => this.pluck(hz(m - 12), t, sd * 14, 0.07, out, 'sawtooth', 1400));
          this.bass(hz(c.root), t, sd * 8, 0.4, out);
        }
        if (i === 0 || i === 8) this.kick(t, out, 0.5);
        if (i >= 12 && bar % 2 === 1) this.snare(t, out, 0.12 + (i - 12) * 0.05);
        break;
    }
  }

  // ───────────────────────── Suara dasar ─────────────────────────

  private connect(node: AudioNode, out: Out, send = 0.18, echo = 0): void {
    const ctx = this.ctx!;
    node.connect(out.dest);
    if (send > 0) {
      const g = ctx.createGain();
      g.gain.value = send;
      node.connect(g).connect(out.rev);
    }
    if (echo > 0 && out.echo) {
      const g = ctx.createGain();
      g.gain.value = echo;
      node.connect(g).connect(out.echo);
    }
  }

  /** Melodi: dua osilator sedikit detune + vibrato + filter, dengan echo. */
  private lead(freq: number, t: number, dur: number, gain: number, type: OscillatorType, out: Out): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(5200, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + Math.max(0.15, dur));
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 5.6;
    lfoGain.gain.setValueAtTime(0, t);
    lfoGain.gain.linearRampToValueAtTime(freq * 0.007, t + 0.18);
    lfo.connect(lfoGain);
    for (const detune of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.detune.value = detune;
      lfoGain.connect(o.frequency);
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.12);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.setValueAtTime(gain * 0.75, t + Math.max(0.03, dur - 0.04));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    f.connect(g);
    this.connect(g, out, 0.22, 0.45);
    lfo.start(t);
    lfo.stop(t + dur + 0.12);
  }

  /** Petikan (pluck): filter membuka lalu menutup cepat. */
  private pluck(freq: number, t: number, dur: number, gain: number, out: Out, type: OscillatorType = 'sawtooth', cutoff = 2400): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(cutoff * 3, t);
    f.frequency.exponentialRampToValueAtTime(cutoff * 0.5, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g);
    this.connect(g, out, 0.2);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Marimba / glockenspiel: sinus + partial tidak harmonis yang cepat meluruh. */
  private bell(freq: number, t: number, dur: number, gain: number, out: Out): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [mult, amp, decay] of [[1, 1, 1], [2.76, 0.35, 0.45], [5.4, 0.12, 0.25]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(amp, t);
      pg.gain.exponentialRampToValueAtTime(0.001, t + dur * decay);
      o.connect(pg).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    this.connect(g, out, 0.3);
  }

  private bass(freq: number, t: number, dur: number, gain: number, out: Out): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(380, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.setTargetAtTime(gain * 0.55, t + 0.04, 0.08);
    g.gain.setValueAtTime(gain * 0.5, t + dur * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f);
    sub.connect(f);
    f.connect(g);
    this.connect(g, out, 0);
    o.start(t);
    sub.start(t);
    o.stop(t + dur + 0.05);
    sub.stop(t + dur + 0.05);
  }

  private tone(freq: number, t: number, dur: number, type: OscillatorType, gain: number, out: Out, slideTo?: number, send = 0.12): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this.connect(g, out, send);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(t: number, dur: number, filter: BiquadFilterType, freq: number, gain: number, out: Out, freqEnd?: number, q = 1): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g);
    this.connect(g, out, 0.1);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  private kick(t: number, out: Out, gain = 0.5): void {
    this.tone(160, t, 0.16, 'sine', gain, out, 42, 0);
    this.noise(t, 0.015, 'lowpass', 3000, gain * 0.3, out);
  }

  private snare(t: number, out: Out, gain = 0.25): void {
    this.noise(t, 0.14, 'bandpass', 2400, gain, out, 1500);
    this.tone(210, t, 0.09, 'triangle', gain * 0.7, out, 140, 0);
  }

  private hat(t: number, out: Out, gain: number, open: boolean): void {
    this.noise(t, open ? 0.14 : 0.04, 'highpass', 8000, gain, out);
  }

  private crash(t: number, out: Out): void {
    this.noise(t, 1.2, 'highpass', 5000, 0.22, out, 9000);
  }

  // ───────────────────────── SFX ─────────────────────────

  /**
   * @param arg nilai tambahan (nomor langkah / durasi dtk)
   * @param delay tunda mulai (dtk) — dipakai untuk merangkai rangkaian suara tanpa setTimeout
   */
  playSfx(id: SfxId, arg = 0, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || settings.get('muted')) return;
    const t = ctx.currentTime + 0.005 + delay;
    const o = this.sfxOut;
    switch (id) {
      case 'click':
        this.tone(700, t, 0.07, 'triangle', 0.16, o, 1100, 0.05);
        break;
      case 'hover':
        this.tone(1500, t, 0.03, 'sine', 0.035, o, undefined, 0);
        break;
      case 'tick': // bar tenaga masuk zona hijau
        this.bell(hz(96), t, 0.25, 0.14, o);
        break;
      case 'dice_shake':
        for (let i = 0; i < 9; i++) {
          const ti = t + i * 0.055;
          this.noise(ti, 0.04, 'bandpass', 2600 + (i % 3) * 800, 0.22, o, undefined, 4);
          this.tone(900 + (i % 4) * 140, ti, 0.03, 'square', 0.04, o, undefined, 0);
        }
        break;
      case 'dice_roll': // berguling dan melambat
        for (let i = 0; i < 8; i++) {
          const ti = t + i * 0.07 * (1 + i * 0.12);
          this.tone(260 + Math.random() * 160, ti, 0.045, 'square', 0.07, o, undefined, 0);
          this.noise(ti, 0.03, 'bandpass', 1800, 0.1, o);
        }
        break;
      case 'dice_land':
        this.tone(240, t, 0.1, 'sine', 0.5, o, 110, 0.05);
        this.noise(t, 0.07, 'lowpass', 1600, 0.3, o);
        this.bell(hz(79), t + 0.02, 0.4, 0.07, o);
        break;
      case 'step': {
        // "bloop" melompat + marimba pentatonik yang naik tiap langkah
        const n = penta(arg);
        this.tone(330, t, 0.075, 'sine', 0.2, o, 560, 0.05);
        this.bell(hz(n), t + 0.01, 0.42, 0.26, o);
        this.noise(t, 0.02, 'bandpass', 4000, 0.06, o);
        break;
      }
      case 'ladder_up': {
        // arpeggio harpa naik 3 oktaf selama durasi memanjat, ditutup akor "ta-da" berkilau
        const dur = Math.max(0.8, arg || 1.4);
        const count = Math.min(26, Math.max(9, Math.round(dur / 0.075)));
        const gap = (dur * 0.9) / count;
        for (let i = 0; i < count; i++) {
          const ti = t + i * gap;
          const n = penta(i, 64);
          this.pluck(hz(n), ti, 0.35, 0.1, o, 'triangle', 3600);
          if (i % 2 === 0) this.bell(hz(n + 12), ti, 0.5, 0.07, o);
        }
        const end = t + dur * 0.95;
        [72, 76, 79, 84, 88].forEach((m, k) => this.bell(hz(m), end + k * 0.035, 1.2, 0.17, o));
        this.noise(end, 0.7, 'highpass', 6000, 0.1, o, 12000);
        break;
      }
      case 'cheer': {
        this.noise(t, 1.0, 'bandpass', 1000, 0.18, o, 2000, 0.8);
        this.noise(t + 0.05, 0.9, 'bandpass', 2400, 0.08, o, 1500, 0.8);
        [0, 0.12, 0.24].forEach((d, k) => this.formant(t + d, 0.32, 520 + k * 90, 0.07, o));
        break;
      }
      case 'yay':
        this.formant(t, 0.4, 560, 0.1, o);
        break;
      case 'snake_hiss':
        this.noise(t, 0.55, 'bandpass', 6500, 0.22, o, 9500, 2);
        this.noise(t, 0.5, 'highpass', 4500, 0.12, o);
        break;
      case 'bite':
        this.noise(t, 0.1, 'lowpass', 2400, 0.55, o, 500);
        this.tone(190, t, 0.14, 'sawtooth', 0.28, o, 70, 0.05);
        this.tone(1400, t, 0.05, 'square', 0.08, o, 600, 0);
        break;
      case 'slide_down': {
        // slide whistle turun + vibrato
        const dur = Math.max(0.7, arg || 1.2);
        const ctxo = ctx.createOscillator();
        const g = ctx.createGain();
        ctxo.type = 'sine';
        ctxo.frequency.setValueAtTime(1500, t);
        ctxo.frequency.exponentialRampToValueAtTime(190, t + dur);
        const lfo = ctx.createOscillator();
        const lg = ctx.createGain();
        lfo.frequency.value = 9;
        lg.gain.value = 40;
        lfo.connect(lg).connect(ctxo.frequency);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
        g.gain.setValueAtTime(0.2, t + dur * 0.85);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        ctxo.connect(g);
        this.connect(g, o, 0.2);
        ctxo.start(t);
        lfo.start(t);
        ctxo.stop(t + dur + 0.05);
        lfo.stop(t + dur + 0.05);
        this.tone(750, t, dur, 'triangle', 0.07, o, 95, 0.1);
        break;
      }
      case 'womp': {
        // trombon sedih "wah wah wah waaah" yang lucu
        const notes: [number, number, number][] = [
          [58, 0, 0.22],
          [57, 0.26, 0.22],
          [56, 0.52, 0.22],
          [55, 0.78, 0.9],
        ];
        notes.forEach(([m, d, len], k) => this.brass(hz(m), t + d, len, 0.16, o, k === 3));
        break;
      }
      case 'oh_no':
        this.brass(hz(55), t, 0.5, 0.12, o, true);
        break;
      case 'bonus':
        [79, 83, 86, 91].forEach((m, k) => this.bell(hz(m), t + k * 0.065, 0.6, 0.2, o));
        break;
      case 'perfect':
        [72, 76, 79, 84, 88, 91].forEach((m, k) => {
          this.bell(hz(m), t + k * 0.055, 0.9, 0.2, o);
          this.pluck(hz(m - 12), t + k * 0.055, 0.3, 0.08, o, 'triangle', 3000);
        });
        this.noise(t + 0.2, 0.6, 'highpass', 6000, 0.1, o, 12000);
        break;
      case 'fizzle':
        this.noise(t, 0.4, 'lowpass', 2500, 0.2, o, 200);
        this.tone(420, t, 0.4, 'sawtooth', 0.1, o, 90, 0);
        break;
      case 'fanfare':
        this.crash(t, o);
        [60, 64, 67, 72].forEach((m, k) => this.brass(hz(m), t + k * 0.1, 0.5, 0.09, o, false));
        [72, 76, 79, 84].forEach((m) => this.bell(hz(m), t + 0.45, 1.5, 0.12, o));
        break;
      case 'fireworks': {
        this.tone(700, t, 0.4, 'sine', 0.08, o, 2600, 0.15);
        this.noise(t + 0.4, 0.7, 'lowpass', 1800, 0.45, o, 120);
        this.tone(100, t + 0.4, 0.4, 'sine', 0.4, o, 38, 0);
        for (let i = 0; i < 12; i++) this.noise(t + 0.55 + Math.random() * 0.6, 0.025, 'highpass', 5000, 0.12, o);
        break;
      }
      case 'crowd_cheer':
        this.noise(t, 2.0, 'bandpass', 800, 0.26, o, 1500, 0.7);
        this.noise(t + 0.1, 1.8, 'bandpass', 1800, 0.14, o, 1000, 0.7);
        break;
      case 'your_turn':
        this.bell(hz(88), t, 0.7, 0.2, o);
        this.bell(hz(95), t + 0.12, 0.9, 0.18, o);
        break;
      case 'pop':
        this.tone(500, t, 0.08, 'sine', 0.25, o, 1200, 0.05);
        break;
      default:
        this.playExpressionSfx(id, t, arg || 1);
    }
  }

  // ───────────────────────── SFX ekspresi ─────────────────────────

  private playExpressionSfx(id: SfxId, t: number, v: number): void {
    const o = this.sfxOut;
    switch (id) {
      case 'x_clap': {
        // tepuk tangan beberapa orang: ledakan noise pendek dengan jeda acak, dua lapis "tangan"
        for (let i = 0; i < 16; i++) {
          const ti = t + i * 0.075 + Math.random() * 0.035;
          const fade = 1 - i / 22;
          this.noise(ti, 0.035, 'bandpass', 1300 + Math.random() * 1400, 0.42 * v * fade, o, undefined, 1.4);
          this.noise(ti + 0.004, 0.02, 'lowpass', 700, 0.18 * v * fade, o);
        }
        break;
      }
      case 'x_laugh': {
        // "ha-ha-ha-ha-ha": suku kata vokal 'a' dengan nada turun + desah 'h'
        for (let i = 0; i < 5; i++) {
          const ti = t + i * 0.16;
          const f0 = 330 - i * 18;
          this.noise(ti, 0.045, 'bandpass', 1600, 0.08 * v, o, undefined, 1);
          this.voice(ti + 0.02, 0.11, [f0, f0 * 0.9], [820], [1250], 0.32 * v, o);
        }
        break;
      }
      case 'x_scream':
        // "Aaaaa!" melengking: nada naik lalu bergetar, vokal 'a' terang
        this.voice(t, 1.0, [420, 760, 700, 620], [950, 1050, 1000], [1600, 1750, 1650], 0.34 * v, o, 0.03);
        this.noise(t, 0.9, 'bandpass', 2600, 0.06 * v, o, 3200, 1.2);
        break;
      case 'x_cheer':
        // "Horee!" + terompet pesta + letusan confetti
        this.noise(t, 0.06, 'lowpass', 2500, 0.4 * v, o, 400);
        this.tone(380, t + 0.04, 0.55, 'square', 0.07 * v, o, 540, 0.1);
        this.voice(t + 0.08, 0.22, [300, 330], [500], [900], 0.26 * v, o);
        this.voice(t + 0.3, 0.55, [380, 470, 440], [700, 850], [1150, 1500], 0.3 * v, o, 0.02);
        this.noise(t + 0.25, 0.8, 'bandpass', 1300, 0.12 * v, o, 2000, 0.8);
        break;
      case 'x_wow':
        // "Wooow": vokal 'u' → 'a' → 'u', nada naik-turun
        this.voice(t, 0.85, [210, 330, 230], [320, 760, 360], [800, 1200, 780], 0.36 * v, o, 0.015);
        break;
      case 'x_boo':
        // "Huuuu" penonton kecewa: beberapa suara rendah vokal 'u', sedikit tidak selaras
        [128, 136, 145].forEach((f0, k) => this.voice(t + k * 0.04, 1.15, [f0, f0 * 0.88], [320, 300], [720, 680], 0.24 * v, o, 0.01));
        this.noise(t, 1.0, 'lowpass', 500, 0.08 * v, o);
        break;
      case 'x_cry':
        // "Huhuhu… waaa": isakan pendek lalu ratapan bergetar yang turun
        for (let i = 0; i < 3; i++) this.voice(t + i * 0.14, 0.09, [460, 420], [400], [900], 0.24 * v, o);
        this.voice(t + 0.48, 0.8, [520, 470, 380], [420, 650, 430], [1000, 1150, 950], 0.3 * v, o, 0.045);
        this.noise(t + 1.32, 0.18, 'bandpass', 3800, 0.06 * v, o, 2400, 2); // sesenggukan
        break;
      case 'x_love':
        // "Mwah!" + kilau hati
        this.noise(t, 0.035, 'lowpass', 1800, 0.35 * v, o);
        this.voice(t + 0.02, 0.2, [260, 330], [300, 800], [900, 1250], 0.3 * v, o);
        this.tone(900, t + 0.05, 0.12, 'sine', 0.08 * v, o, 1600, 0.1);
        [84, 88, 91, 96].forEach((m, k) => this.bell(hz(m), t + 0.3 + k * 0.07, 0.8, 0.11 * v, o));
        break;
    }
  }

  /**
   * Suara vokal sintetis: sawtooth melewati dua filter formant (F1/F2). Larik nada & formant
   * dijalankan merata sepanjang `dur` sehingga vokal bisa berubah (mis. "wooow").
   */
  private voice(t: number, dur: number, pitch: number[], f1: number[], f2: number[], gain: number, out: Out, vibrato = 0): void {
    const ctx = this.ctx!;
    const ramp = (p: AudioParam, values: number[]) => {
      p.setValueAtTime(values[0], t);
      values.slice(1).forEach((val, i) => p.linearRampToValueAtTime(val, t + (dur * (i + 1)) / (values.length - 1)));
    };
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    ramp(o.frequency, pitch);
    let lfo: OscillatorNode | null = null;
    if (vibrato > 0) {
      lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 6.5;
      lg.gain.value = pitch[0] * vibrato;
      lfo.connect(lg).connect(o.frequency);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.03, dur / 4));
    g.gain.setValueAtTime(gain, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [freqs, q, level] of [[f1, 7, 1], [f2, 9, 0.55]] as const) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = q;
      ramp(f.frequency, [...freqs]);
      const fg = ctx.createGain();
      fg.gain.value = level * 2.2; // bandpass sempit memangkas banyak energi
      o.connect(f).connect(fg).connect(g);
    }
    this.connect(g, out, 0.18);
    o.start(t);
    o.stop(t + dur + 0.05);
    lfo?.start(t);
    lfo?.stop(t + dur + 0.05);
  }

  /** Vokal "yaaay" sederhana: sawtooth lewat filter formant yang bergeser. */
  private formant(t: number, dur: number, f0: number, gain: number, out: Out): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.35, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 5;
    f.frequency.setValueAtTime(700, t);
    f.frequency.exponentialRampToValueAtTime(1900, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g);
    this.connect(g, out, 0.2);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Brass / trombon: sawtooth + filter "wah". `bend` = nada melorot di akhir. */
  private brass(freq: number, t: number, dur: number, gain: number, out: Out, bend: boolean): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(freq, t);
    if (bend) o.frequency.exponentialRampToValueAtTime(freq * 0.8, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 3;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1500, t + dur * 0.3);
    f.frequency.exponentialRampToValueAtTime(450, t + dur);
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = bend ? 6 : 0.01;
    lg.gain.value = bend ? freq * 0.012 : 0;
    lfo.connect(lg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.03);
    g.gain.setValueAtTime(gain * 0.8, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g);
    this.connect(g, out, 0.15);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  // ───────────────────────── Bar tenaga lempar ─────────────────────────

  private chargeBegin(): void {
    const ctx = this.ctx;
    if (!ctx || this.charge) return;
    const osc = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    sub.type = 'sine';
    osc.frequency.value = 196;
    sub.frequency.value = 98;
    gain.gain.value = 0.0001;
    gain.gain.setTargetAtTime(0.12, ctx.currentTime, 0.03);
    osc.connect(gain);
    sub.connect(gain);
    gain.connect(this.sfxBus);
    osc.start();
    sub.start();
    this.charge = { osc, sub, gain, perfect: false };
  }

  private chargeSet(power: number): void {
    const ctx = this.ctx;
    const c = this.charge;
    if (!ctx || !c) return;
    const f = 196 * Math.pow(2, power * 2); // naik dua oktaf sampai penuh
    c.osc.frequency.setTargetAtTime(f, ctx.currentTime, 0.02);
    c.sub.frequency.setTargetAtTime(f / 2, ctx.currentTime, 0.02);
    if (!c.perfect && power >= CHARGE_PERFECT_FROM) {
      c.perfect = true;
      this.playSfx('tick');
    }
  }

  private chargeEnd(): void {
    const ctx = this.ctx;
    const c = this.charge;
    if (!ctx || !c) return;
    c.gain.gain.cancelScheduledValues(ctx.currentTime);
    c.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.02);
    c.osc.stop(ctx.currentTime + 0.15);
    c.sub.stop(ctx.currentTime + 0.15);
    this.charge = null;
  }

  /** Pasang semua reaksi audio pada event game (lapisan audio hanya mendengarkan). */
  bindEvents(bus: EventBus): void {
    bus.on('turn:start', ({ mine }) => {
      if (mine) this.playSfx('your_turn');
    });
    bus.on('charge:start', () => this.chargeBegin());
    bus.on('charge:update', ({ power }) => this.chargeSet(power));
    bus.on('charge:end', ({ perfect, overheated }) => {
      this.chargeEnd();
      if (perfect) this.playSfx('perfect');
      else if (overheated) this.playSfx('fizzle');
    });
    bus.on('dice:throw', () => {
      this.playSfx('dice_shake');
      this.playSfx('dice_roll', 0, 0.4);
    });
    bus.on('dice:land', () => this.playSfx('dice_land'));
    bus.on('move:step', ({ stepIndex, total }) => {
      if (stepIndex < total) this.playSfx('step', stepIndex);
    });
    bus.on('move:bounce', () => this.playSfx('pop'));
    bus.on('ladder:climb', ({ duration }) => {
      this.playSfx('ladder_up', duration);
      this.playSfx('cheer', 0, duration * 0.95);
    });
    bus.on('snake:bite', ({ duration }) => {
      // urutan: desis -> gigit (rahang menutup ~0,45 dtk) -> meluncur turun -> trombon sedih
      this.playSfx('snake_hiss');
      this.playSfx('bite', 0, 0.45);
      this.playSfx('slide_down', duration, 0.95);
      this.playSfx('womp', 0, 0.95 + duration * 0.92);
    });
    bus.on('turn:forfeit', () => this.playSfx('womp'));
    // ekspresi penonton lebih pelan dan dijarangkan agar tidak menenggelamkan suara permainan
    let lastCrowd = 0;
    bus.on('expression', ({ id, spectator }) => {
      if (spectator) {
        const now = performance.now();
        if (now - lastCrowd < 450) return;
        lastCrowd = now;
      }
      this.playSfx(`x_${id}`, spectator ? 0.55 : 1);
    });
    bus.on('bonus:six', () => this.playSfx('bonus'));
    bus.on('game:win', () => {
      this.playMusic('victory');
      this.playSfx('fanfare');
      this.playSfx('crowd_cheer', 0, 0.4);
      for (let i = 0; i < 6; i++) this.playSfx('fireworks', 0, 0.7 + i * 0.9);
    });
  }
}
