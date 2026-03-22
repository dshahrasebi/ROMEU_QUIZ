/* ============================================================
   AudioManager — ROMEU Quiz display-screen audio engine
   All SFX synthesized via Web Audio API (no files, no CORS).
   BGM loaded from /audio/bgm/*.mp3 local assets.
   ============================================================ */

'use strict';

class AudioManager {
  constructor() {
    this._ctx = null;
    this._sfxGain = null;
    this._bgmGain = null;
    this._bgmSource = null;
    this._bgmBuffer = null;
    this._bgmCurrentTrack = null;
    this._bgmBufferCache = {};
    this._unlocked = false;
    this._pendingBgm = null; // track to start once unlocked

    // Config (updated every time init() is called)
    this.enabled = true;
    this.sfxVolume = 0.8;
    this.musicVolume = 0.5;
    this.sfxPack = 'classic';
    this.bgmLobby = 'lobby-chill';
    this.bgmQuestion = 'question-action';
  }

  // ── Initialise from settings object ──────────────────────────────────────

  init(settings) {
    this.enabled      = settings.sound_enabled !== 'false';
    this.sfxVolume    = Math.max(0, Math.min(1, parseInt(settings.sfx_volume  ?? 80,  10) / 100));
    this.musicVolume  = Math.max(0, Math.min(1, parseInt(settings.music_volume ?? 50, 10) / 100));
    this.sfxPack      = settings.sfx_pack      || 'classic';
    this.bgmLobby     = settings.bgm_lobby     || 'lobby-chill';
    this.bgmQuestion  = settings.bgm_question  || 'question-action';
  }

  // ── AudioContext (lazy, unlocked on first user gesture) ──────────────────

  _getCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._sfxGain = this._ctx.createGain();
      this._sfxGain.connect(this._ctx.destination);
      this._bgmGain = this._ctx.createGain();
      this._bgmGain.connect(this._ctx.destination);
      this._applyVolumes();
    }
    return this._ctx;
  }

  _applyVolumes() {
    if (this._sfxGain) this._sfxGain.gain.setTargetAtTime(this.sfxVolume, this._ctx.currentTime, 0.01);
    if (this._bgmGain) this._bgmGain.gain.setTargetAtTime(this.musicVolume, this._ctx.currentTime, 0.01);
  }

  /**
   * Must be called from a user-gesture handler to unlock AudioContext on iOS/
   * Chrome. Call this on the first click/keydown on the display page.
   */
  unlock() {
    if (this._unlocked) return;
    const ctx = this._getCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        this._unlocked = true;
        if (this._pendingBgm) {
          const t = this._pendingBgm;
          this._pendingBgm = null;
          this.startMusic(t);
        }
      });
    } else {
      this._unlocked = true;
      if (this._pendingBgm) {
        const t = this._pendingBgm;
        this._pendingBgm = null;
        this.startMusic(t);
      }
    }
  }

  /**
   * Attempt to unlock without a user gesture. Resolves true if audio is now
   * unlocked (works on Firefox and some desktop Chrome configurations where
   * the page navigation itself counts as an activation).
   */
  tryAutoUnlock() {
    if (this._unlocked) return Promise.resolve(true);
    const ctx = this._getCtx();
    return ctx.resume().then(() => {
      if (ctx.state === 'running') {
        this._unlocked = true;
        if (this._pendingBgm) {
          const t = this._pendingBgm;
          this._pendingBgm = null;
          this.startMusic(t);
        }
        return true;
      }
      return false;
    }).catch(() => false);
  }

  // ── SFX synthesis ────────────────────────────────────────────────────────

  play(sfxId) {
    if (!this.enabled || this.sfxPack === 'off') return;
    if (!this._unlocked) return; // don't try to play before gesture
    try {
      const ctx = this._getCtx();
      const fn = this._sfxFunctions[sfxId];
      if (fn) fn.call(this, ctx, this._sfxGain);
    } catch (e) { /* ignore audio errors gracefully */ }
  }

  // SFX oscillator pack parameters
  _packOsc() {
    const p = this.sfxPack;
    if (p === 'classic')  return 'square';
    if (p === 'punchy')   return 'sawtooth';
    return 'sine'; // modern + fallback
  }

  // Create a single oscillator + gain envelope
  _beep(ctx, dest, freq, startTime, duration, type, gainPeak = 0.6) {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(dest);
    osc.type      = type || this._packOsc();
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }

  _sfxFunctions = {
    // Rising 4-note arpeggio chime
    'question-start': function(ctx, dest) {
      const t = ctx.currentTime;
      const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
      notes.forEach((f, i) => this._beep(ctx, dest, f, t + i * 0.1, 0.25, null, 0.5));
    },
    // Sharp metronome tick
    'tick': function(ctx, dest) {
      const t = ctx.currentTime;
      this._beep(ctx, dest, 1200, t, 0.08, 'square', 0.4);
    },
    // Descending buzzer
    'time-up': function(ctx, dest) {
      const t = ctx.currentTime;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(dest);
      osc.type = this._packOsc();
      osc.frequency.setValueAtTime(600, t);
      osc.frequency.linearRampToValueAtTime(120, t + 0.7);
      gain.gain.setValueAtTime(0.6, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      osc.start(t); osc.stop(t + 0.75);
    },
    // Drum-roll stab
    'reveal': function(ctx, dest) {
      const t = ctx.currentTime;
      // Snare noise burst
      for (let i = 0; i < 8; i++) {
        const buf = ctx.createBuffer(1, ctx.sampleRate * 0.04, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < data.length; j++) data[j] = Math.random() * 2 - 1;
        const src  = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = buf;
        src.connect(gain); gain.connect(dest);
        const at = t + i * 0.04;
        gain.gain.setValueAtTime(0.35 + i * 0.03, at);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
        src.start(at);
      }
      // Stab chord
      [440, 554, 659].forEach((f, i) => this._beep(ctx, dest, f, t + 0.35, 0.4, null, 0.45));
    },
    // Sparkle ascending run
    'leaderboard': function(ctx, dest) {
      const t = ctx.currentTime;
      const freqs = [523, 587, 659, 740, 831, 932, 1047, 1175];
      freqs.forEach((f, i) => this._beep(ctx, dest, f, t + i * 0.07, 0.18, 'sine', 0.45));
    },
    // Victory fanfare
    'game-end': function(ctx, dest) {
      const t = ctx.currentTime;
      const melody = [
        [523, 0],    [523, 0.12], [523, 0.24],
        [415, 0.36], [622, 0.52],
        [523, 0.7],  [415, 0.82], [622, 1.0],
        [784, 1.2],
      ];
      melody.forEach(([f, when]) => this._beep(ctx, dest, f, t + when, 0.22, null, 0.55));
    },
    // Deep pulse before question
    'countdown': function(ctx, dest) {
      const t = ctx.currentTime;
      this._beep(ctx, dest, 150, t, 0.18, 'sine', 0.7);
    },
  };

  // ── BGM (background music) ────────────────────────────────────────────────

  async startMusic(trackId) {
    if (!this.enabled || trackId === 'off') return;
    if (!this._unlocked) { this._pendingBgm = trackId; return; }
    if (this._bgmCurrentTrack === trackId && this._bgmSource) return; // already playing

    await this._loadAndPlay(trackId);
  }

  stopMusic(fadeSecs = 0.8) {
    if (!this._bgmSource) return;
    const src = this._bgmSource;
    this._bgmSource = null;
    this._bgmCurrentTrack = null;
    if (this._bgmGain) {
      this._bgmGain.gain.setTargetAtTime(0, this._ctx.currentTime, fadeSecs / 3);
      setTimeout(() => { try { src.stop(); } catch {} }, fadeSecs * 1000 + 100);
    } else {
      try { src.stop(); } catch {}
    }
  }

  async crossfadeTo(trackId, fadeSecs = 0.8) {
    if (this._bgmCurrentTrack === trackId) return;
    this.stopMusic(fadeSecs);
    setTimeout(() => this.startMusic(trackId), fadeSecs * 1000);
  }

  async _loadAndPlay(trackId) {
    try {
      const ctx = this._getCtx();

      // Use cached buffer if available
      if (!this._bgmBufferCache[trackId]) {
        const url = trackId.startsWith('custom:')
          ? `/uploads/audio/${trackId.slice(7)}`
          : `/audio/bgm/${trackId}.wav`;
        const resp = await fetch(url);
        if (!resp.ok) return; // missing file — silent fail
        const arrayBuf = await resp.arrayBuffer();
        this._bgmBufferCache[trackId] = await ctx.decodeAudioData(arrayBuf);
      }

      // Stop any previous source
      if (this._bgmSource) { try { this._bgmSource.stop(); } catch {} }

      const src = ctx.createBufferSource();
      src.buffer = this._bgmBufferCache[trackId];
      src.loop   = true;
      src.connect(this._bgmGain);

      // Fade in
      this._bgmGain.gain.setValueAtTime(0, ctx.currentTime);
      this._bgmGain.gain.linearRampToValueAtTime(this.musicVolume, ctx.currentTime + 1.2);

      src.start();
      this._bgmSource      = src;
      this._bgmCurrentTrack = trackId;

      // On unexpected end (e.g. context closed) clean up
      src.onended = () => {
        if (this._bgmSource === src) {
          this._bgmSource      = null;
          this._bgmCurrentTrack = null;
        }
      };
    } catch (e) { console.warn('[AudioManager] BGM error for', trackId, ':', e); }
  }

  // ── Live volume update (called when host changes settings mid-game) ───────

  setVolumes(sfxVol, musicVol) {
    this.sfxVolume   = Math.max(0, Math.min(1, sfxVol   / 100));
    this.musicVolume = Math.max(0, Math.min(1, musicVol / 100));
    this._applyVolumes();
  }
}

// Export as global for use in plain-HTML pages
window.AudioManager = AudioManager;
