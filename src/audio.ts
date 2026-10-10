// Sound effects: original sound files from the user's map/MPQs when available, otherwise
// procedurally synthesised stand-ins.
import { assets } from './assets/store';

export type Sfx =
  | 'fireball' | 'explode' | 'lightning' | 'teleport' | 'swap' | 'meteorFall' | 'meteorImpact' | 'hit'
  | 'death' | 'shield' | 'windwalk' | 'thrust' | 'boomerang' | 'homing' | 'gravity' | 'link' | 'error'
  | 'click' | 'buy' | 'horn' | 'victory' | 'tick' | 'reflect' | 'bounty';

export class SoundSystem {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private listenerX = 0;
  private listenerY = 0;
  volume = 0.6;
  private ambient: GainNode | null = null;

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  setListener(x: number, y: number) {
    this.listenerX = x;
    this.listenerY = y;
  }

  startAmbient() {
    this.ensure();
    const ctx = this.ctx!;
    if (this.ambient) return;
    // Brown-ish noise rumble for the lava sea
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.15;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.05;
    lfo.connect(lfoG).connect(g.gain);
    src.connect(lp).connect(g).connect(this.master);
    src.start();
    lfo.start();
    this.ambient = g;
  }

  playAt(name: Sfx, x: number, y: number, vol = 1) {
    const [att, pan] = this.spatial(x, y);
    this.play(name, vol * att, pan);
  }

  private spatial(x: number, y: number): [number, number] {
    const dx = x - this.listenerX;
    const d = Math.hypot(dx, y - this.listenerY);
    return [Math.max(0.12, 1 - d / 2200), Math.max(-0.8, Math.min(0.8, dx / 1200))];
  }

  /**
   * Plays an original sound file (e.g. `war3mapImported\\CFirstBlood.mp3`). If it isn't available
   * the procedural `fallback` plays instead. Positional when `at` is given.
   */
  playFile(path: string, fallback: Sfx | null, vol = 1, at?: { x: number; y: number }) {
    if (!this.ctx) return;
    const [att, pan] = at ? this.spatial(at.x, at.y) : [1, 0];
    if (!assets.has(path)) {
      if (fallback) this.play(fallback, vol * att, pan);
      return;
    }
    const ctx = this.ctx;
    void assets.sound(path, ctx).then((buf) => {
      if (!buf) {
        if (fallback) this.play(fallback, vol * att, pan);
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = vol * att;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(g).connect(p).connect(this.master);
      src.start();
    });
  }

  play(name: Sfx, vol = 1, pan = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = vol;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(this.master);

    const env = (g: GainNode, a: number, peak: number, decay: number) => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + decay);
    };
    const noise = (type: BiquadFilterType, f0: number, f1: number, a: number, peak: number, decay: number, q = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.playbackRate.value = 0.8 + Math.random() * 0.4;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(f1, t + a + decay);
      const g = ctx.createGain();
      env(g, a, peak, decay);
      s.connect(f).connect(g).connect(out);
      s.start(t, Math.random());
      s.stop(t + a + decay + 0.05);
    };
    const tone = (type: OscillatorType, f0: number, f1: number, a: number, peak: number, decay: number, delay = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t + delay);
      o.frequency.exponentialRampToValueAtTime(f1, t + delay + a + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(peak, t + delay + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + a + decay);
      o.connect(g).connect(out);
      o.start(t + delay);
      o.stop(t + delay + a + decay + 0.05);
    };

    switch (name) {
      case 'fireball':
        noise('bandpass', 300, 1800, 0.03, 0.9, 0.35, 1.2);
        tone('sine', 160, 60, 0.01, 0.4, 0.2);
        break;
      case 'homing':
        noise('bandpass', 600, 2400, 0.05, 0.5, 0.4, 3);
        tone('triangle', 300, 900, 0.05, 0.15, 0.35);
        break;
      case 'boomerang':
        noise('bandpass', 1200, 500, 0.02, 0.6, 0.3, 4);
        break;
      case 'gravity':
        tone('sawtooth', 90, 40, 0.1, 0.25, 0.8);
        noise('lowpass', 800, 150, 0.1, 0.5, 0.8);
        break;
      case 'link':
        tone('square', 700, 300, 0.01, 0.12, 0.25);
        noise('highpass', 3000, 2000, 0.01, 0.3, 0.2);
        break;
      case 'explode':
        noise('lowpass', 1600, 180, 0.01, 1.2, 0.55);
        tone('sine', 110, 40, 0.01, 0.8, 0.35);
        break;
      case 'lightning':
        noise('highpass', 2500, 900, 0.005, 1.0, 0.35);
        tone('sawtooth', 120, 60, 0.005, 0.25, 0.3);
        for (let i = 0; i < 4; i++) tone('square', 1800 + Math.random() * 2000, 400, 0.002, 0.08, 0.05, i * 0.05);
        break;
      case 'teleport':
        tone('sine', 300, 1800, 0.02, 0.35, 0.4);
        tone('triangle', 600, 2400, 0.05, 0.12, 0.35);
        noise('highpass', 4000, 6000, 0.05, 0.2, 0.3);
        break;
      case 'swap':
        tone('sine', 1400, 400, 0.02, 0.3, 0.25);
        tone('sine', 400, 1400, 0.02, 0.3, 0.25, 0.12);
        break;
      case 'meteorFall':
        noise('lowpass', 4000, 300, 0.4, 0.7, 0.9, 2);
        break;
      case 'meteorImpact':
        noise('lowpass', 900, 80, 0.01, 1.6, 1.4);
        tone('sine', 70, 28, 0.01, 1.2, 0.9);
        break;
      case 'hit':
        tone('sine', 220, 80, 0.005, 0.35, 0.12);
        noise('bandpass', 900, 300, 0.005, 0.4, 0.1);
        break;
      case 'death':
        tone('sawtooth', 220, 55, 0.02, 0.3, 1.1);
        tone('sawtooth', 165, 41, 0.02, 0.2, 1.1);
        break;
      case 'shield':
        for (const f of [880, 1320, 1760]) tone('sine', f, f * 1.02, 0.05, 0.12, 0.7);
        break;
      case 'reflect':
        tone('triangle', 1500, 900, 0.005, 0.3, 0.2);
        break;
      case 'windwalk':
        noise('bandpass', 500, 2500, 0.15, 0.5, 0.6, 0.8);
        break;
      case 'thrust':
        noise('bandpass', 400, 1500, 0.02, 0.8, 0.3, 1.5);
        break;
      case 'error':
        tone('square', 180, 180, 0.005, 0.15, 0.09);
        tone('square', 140, 140, 0.005, 0.15, 0.12, 0.11);
        break;
      case 'click':
        tone('square', 1200, 800, 0.002, 0.06, 0.03);
        break;
      case 'tick':
        tone('sine', 880, 880, 0.005, 0.25, 0.15);
        break;
      case 'buy':
      case 'bounty':
        tone('sine', 1760, 1700, 0.005, 0.25, 0.4);
        tone('sine', 2637, 2600, 0.005, 0.18, 0.35, 0.07);
        break;
      case 'horn':
        for (const f of [110, 165, 220]) tone('sawtooth', f, f * 0.98, 0.15, 0.12, 1.3);
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.01, 0.25, 0.5, i * 0.13));
        break;
    }
  }
}
