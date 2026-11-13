const MUTE_KEY = 'd2f.muted.v1';

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.muted = false;
    this.lastStepAt = 0;
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  unlock() {
    try {
      if (!this.ctx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.3;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      // Sound is optional; never let audio break the game.
      this.ctx = null;
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      // Ignore privacy-mode storage failures.
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.3, this.ctx.currentTime, 0.02);
    }
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    if (!this.muted) this.click();
    return this.muted;
  }

  get enabled() {
    return Boolean(this.ctx && this.master) && !this.muted;
  }

  tone({
    freq = 440,
    endFreq = null,
    duration = 0.15,
    type = 'sine',
    volume = 0.12,
    delay = 0,
    attack = 0.006,
  } = {}) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), start);
    if (endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), start + duration);
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + Math.min(attack, duration * 0.4));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  noise({
    duration = 0.2,
    volume = 0.12,
    filterType = 'bandpass',
    frequency = 900,
    q = 1,
    delay = 0,
    endFrequency = null,
  } = {}) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (!this.noiseBuffer) {
      const length = Math.max(1, Math.floor(ctx.sampleRate * 1.2));
      this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, ctx.currentTime + delay);
    if (endFrequency) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(40, endFrequency),
        ctx.currentTime + delay + duration,
      );
    }
    filter.Q.value = q;
    const gain = ctx.createGain();
    const start = ctx.currentTime + delay;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(start);
    source.stop(start + duration + 0.03);
  }

  click() {
    this.unlock();
    this.tone({ freq: 620, endFreq: 480, duration: 0.06, type: 'square', volume: 0.035 });
  }

  digStart(own = true) {
    if (!this.enabled) return;
    this.tone({
      freq: own ? 190 : 150,
      endFreq: 105,
      duration: 0.07,
      type: 'triangle',
      volume: own ? 0.09 : 0.04,
    });
    this.noise({
      duration: 0.045,
      volume: own ? 0.035 : 0.015,
      filterType: 'highpass',
      frequency: 1500,
    });
  }

  blockBreak(own = true) {
    if (!this.enabled) return;
    const volume = own ? 0.16 : 0.07;
    this.noise({
      duration: 0.18,
      volume,
      filterType: 'lowpass',
      frequency: 1200,
      endFrequency: 220,
      q: 0.8,
    });
    this.tone({
      freq: 110,
      endFreq: 60,
      duration: 0.16,
      type: 'sine',
      volume: volume * 0.7,
    });
  }

  step(own = true) {
    if (!this.enabled) return;
    const now = performance.now();
    if (now - this.lastStepAt < 160) return;
    this.lastStepAt = now;
    this.noise({
      duration: 0.035,
      volume: own ? 0.018 : 0.008,
      filterType: 'lowpass',
      frequency: 420,
    });
  }

  blocked(own = true) {
    if (!this.enabled) return;
    this.tone({
      freq: 140,
      endFreq: 82,
      duration: 0.09,
      type: 'square',
      volume: own ? 0.055 : 0.02,
    });
    this.noise({ duration: 0.06, volume: 0.03, filterType: 'bandpass', frequency: 600, q: 2 });
  }

  skill(skill, own = true) {
    if (!this.enabled) return;
    const volume = own ? 1 : 0.55;
    if (skill === 'build' || skill === 'barricade') {
      this.tone({ freq: 150, endFreq: 62, duration: 0.22, type: 'triangle', volume: 0.16 * volume });
      this.noise({
        duration: 0.25,
        volume: 0.1 * volume,
        filterType: 'bandpass',
        frequency: 380,
        q: 2,
      });
      this.tone({
        freq: 280,
        endFreq: 220,
        duration: 0.12,
        type: 'square',
        volume: 0.035 * volume,
        delay: 0.08,
      });
    } else if (skill === 'blast') {
      this.noise({
        duration: 0.42,
        volume: 0.23 * volume,
        filterType: 'lowpass',
        frequency: 1600,
        endFrequency: 130,
        q: 0.7,
      });
      this.tone({ freq: 94, endFreq: 34, duration: 0.38, type: 'sine', volume: 0.3 * volume });
    } else if (skill === 'overdrive') {
      this.tone({ freq: 170, endFreq: 680, duration: 0.28, type: 'sawtooth', volume: 0.07 * volume });
      this.tone({ freq: 340, endFreq: 1360, duration: 0.26, type: 'sine', volume: 0.05 * volume, delay: 0.02 });
      this.noise({ duration: 0.18, volume: 0.04 * volume, filterType: 'highpass', frequency: 1200 });
    } else if (skill === 'cryo') {
      this.tone({ freq: 1360, endFreq: 520, duration: 0.34, type: 'triangle', volume: 0.07 * volume });
      this.tone({ freq: 2050, endFreq: 980, duration: 0.24, type: 'sine', volume: 0.04 * volume, delay: 0.02 });
      this.noise({ duration: 0.22, volume: 0.035 * volume, filterType: 'highpass', frequency: 2000 });
    }
  }

  cryoBurst(own = true, hit = false) {
    if (!this.enabled) return;
    const volume = own ? 1 : 0.6;
    this.noise({
      duration: 0.32,
      volume: (hit ? 0.11 : 0.045) * volume,
      filterType: 'bandpass',
      frequency: hit ? 2400 : 1500,
      endFrequency: 280,
      q: 1.4,
    });
    this.tone({
      freq: hit ? 980 : 720,
      endFreq: 160,
      duration: 0.28,
      type: 'triangle',
      volume: 0.055 * volume,
    });
  }

  countdown(value) {
    if (!this.enabled) return;
    const freq = value === 3 ? 440 : value === 2 ? 520 : 620;
    this.tone({ freq, duration: 0.1, type: 'square', volume: 0.045 });
    this.tone({ freq: freq * 2, duration: 0.06, type: 'sine', volume: 0.02, delay: 0.01 });
  }

  matchStart() {
    if (!this.enabled) return;
    [440, 554, 659, 880].forEach((freq, index) => {
      this.tone({
        freq,
        duration: 0.22,
        type: index === 3 ? 'sine' : 'triangle',
        volume: index === 3 ? 0.09 : 0.055,
        delay: index * 0.075,
      });
    });
    this.noise({ duration: 0.22, volume: 0.03, filterType: 'highpass', frequency: 1800 });
  }

  win() {
    if (!this.enabled) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
      this.tone({
        freq,
        duration: index === 3 ? 0.55 : 0.22,
        type: 'triangle',
        volume: 0.07,
        delay: index * 0.11,
      });
    });
    this.noise({ duration: 0.3, volume: 0.02, filterType: 'highpass', frequency: 2400, delay: 0.18 });
  }

  lose() {
    if (!this.enabled) return;
    [392, 329.63, 261.63, 196].forEach((freq, index) => {
      this.tone({
        freq,
        duration: index === 3 ? 0.5 : 0.24,
        type: 'triangle',
        volume: 0.055,
        delay: index * 0.12,
      });
    });
  }

  draw() {
    if (!this.enabled) return;
    this.tone({ freq: 440, duration: 0.24, type: 'triangle', volume: 0.05 });
    this.tone({ freq: 554, duration: 0.36, type: 'triangle', volume: 0.045, delay: 0.12 });
  }

  error() {
    if (!this.enabled) return;
    this.tone({ freq: 180, endFreq: 120, duration: 0.14, type: 'square', volume: 0.04 });
  }

  toggleReady() {
    if (!this.enabled) return;
    this.tone({ freq: 620, endFreq: 780, duration: 0.09, type: 'sine', volume: 0.035 });
  }
}
