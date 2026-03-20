/**
 * gen-bgm.js — Generate 4 background music WAV loops for ROMEU_QUIZ.
 * Pure Node.js, no dependencies. Outputs to public/audio/bgm/.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const SR   = 44100;  // sample rate
const BITS = 16;

// ── WAV serialiser ────────────────────────────────────────────────────────────
function writeWav(filePath, samples) {
  const n   = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1,  20);          // PCM
  buf.writeUInt16LE(1,  22);          // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2,  32);
  buf.writeUInt16LE(BITS, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
  const kb = (buf.length / 1024).toFixed(1);
  console.log(`  ✓ ${path.basename(filePath)}  (${kb} KB, ${(n / SR).toFixed(2)}s)`);
}

// ── Primitives ────────────────────────────────────────────────────────────────
function midiFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

// note name → MIDI number (e.g. "A4"=69, "C4"=60, "Bb3"=46)
function noteToMidi(note) {
  const map = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  const m   = note.match(/^([A-G])(b|#)?(\d)$/);
  if (!m) throw new Error('bad note: ' + note);
  let semi = map[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 12 * (parseInt(m[3]) + 1) + semi;
}
const f = (note) => midiFreq(noteToMidi(note));

// oscillators (phase = fractional position 0-1)
function oscSine (freq, t) { return Math.sin(2 * Math.PI * freq * t); }
function oscSaw  (freq, t) { const p = (freq * t) % 1; return 2 * p - 1; }
function oscSq   (freq, t) { return Math.sin(2 * Math.PI * freq * t) >= 0 ? 1 : -1; }
function oscTri  (freq, t) { const p = (freq * t) % 1; return p < 0.5 ? 4*p-1 : 3-4*p; }

// ADSR envelope (returns amplitude 0-1 at time t within a note of length `dur`)
function env(t, dur, a, d, s, rel) {
  if (t < 0 || t > dur) return 0;
  if (t < a)           return t / a;
  if (t < a + d)       return 1 - (1 - s) * (t - a) / d;
  if (t < dur - rel)   return s;
  return s * (1 - (t - (dur - rel)) / rel);
}

// add a note into a Float32Array of samples
function addNote(buf, startSec, durSec, frequency, oscFn, gainAmp, a, d, s, r) {
  const s0 = Math.floor(startSec * SR);
  const sN = Math.min(buf.length, Math.ceil((startSec + durSec + r) * SR));
  for (let i = s0; i < sN; i++) {
    const t = (i - s0) / SR;
    buf[i] += oscFn(frequency, t) * env(t, durSec, a, d, s, r) * gainAmp;
  }
}

// soft-limiter
function normalise(buf, target = 0.88) {
  let mx = 0;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > mx) mx = Math.abs(buf[i]);
  if (mx < 1e-9) return;
  const ratio = target / mx;
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * ratio);
}

// ── Track builders ────────────────────────────────────────────────────────────

/**
 * lobby-chill  — A-minor, calm & spacious, 80 BPM, 8 bars
 */
function genLobbyChillSamples() {
  const BPM  = 80;
  const beat = 60 / BPM;       // seconds per beat
  const bars = 8;
  const totalSec = bars * 4 * beat;
  const buf  = new Float32Array(Math.ceil(totalSec * SR));

  // chord tones per bar (Am F C G × 2)
  const chords = [
    [f('A3'), f('C4'), f('E4')],  // Am
    [f('F3'), f('A3'), f('C4')],  // F
    [f('C4'), f('E4'), f('G4')],  // C
    [f('G3'), f('B3'), f('D4')],  // G
  ];

  for (let bar = 0; bar < bars; bar++) {
    const ch    = chords[bar % 4];
    const barT  = bar * 4 * beat;

    // Pad — soft sine chord, whole bar
    ch.forEach(freq => {
      addNote(buf, barT, 4*beat, freq, oscSine, 0.15, 0.2, 0.3, 0.7, 0.4);
      addNote(buf, barT, 4*beat, freq*2, oscSine, 0.06, 0.2, 0.3, 0.6, 0.4);
    });

    // Bass — root, half-note pulse
    const rootFreq = ch[0] / 2;
    addNote(buf, barT,           2*beat, rootFreq, oscSine, 0.38, 0.02, 0.08, 0.7, 0.3);
    addNote(buf, barT + 2*beat,  2*beat, rootFreq, oscSine, 0.28, 0.02, 0.08, 0.6, 0.3);

    // Melody — arpeggio every dotted-quarter
    const arpStep = beat * 0.75;
    for (let step = 0; step < 5; step++) {
      const noteFreq = ch[step % ch.length] * 2;
      addNote(buf, barT + step * arpStep, beat * 0.55, noteFreq, oscSine, 0.2, 0.01, 0.05, 0.7, 0.15);
    }
  }

  normalise(buf);
  return buf;
}

/**
 * lobby-upbeat  — C major, cheerful, 120 BPM, 8 bars
 */
function genLobbyUpbeatSamples() {
  const BPM  = 120;
  const beat = 60 / BPM;
  const bars = 8;
  const totalSec = bars * 4 * beat;
  const buf  = new Float32Array(Math.ceil(totalSec * SR));

  // C G Am F chord progression
  const chords = [
    [f('C4'), f('E4'), f('G4')],
    [f('G3'), f('B3'), f('D4')],
    [f('A3'), f('C4'), f('E4')],
    [f('F3'), f('A3'), f('C4')],
  ];

  // C major scale (for melody runs)
  const scaleUp   = ['C5','D5','E5','F5','G5','A5','B5','C6'].map(f);
  const scaleDown = [...scaleUp].reverse();

  for (let bar = 0; bar < bars; bar++) {
    const ch   = chords[bar % 4];
    const barT = bar * 4 * beat;

    // Bass — quarter notes, triangle (warm)
    for (let q = 0; q < 4; q++) {
      addNote(buf, barT + q*beat, beat*0.85, ch[0]/2, oscTri, 0.32, 0.01, 0.05, 0.8, 0.1);
    }

    // Inner harmony — two chord tones pumping on beats 1 & 3
    [0, 2].forEach(qb => {
      ch.forEach(fr => {
        addNote(buf, barT + qb*beat, beat*1.8, fr, oscSine, 0.12, 0.02, 0.1, 0.6, 0.2);
      });
    });

    // Melody — eighth notes, alternating up/down scale runs
    const run = (bar % 2 === 0) ? scaleUp : scaleDown;
    for (let e = 0; e < 8; e++) {
      const noteF = run[e % run.length];
      addNote(buf, barT + e*beat*0.5, beat*0.42, noteF, oscSine, 0.22, 0.005, 0.04, 0.75, 0.08);
    }

    // Hi-hat-like click (noise approximated by high-freq sine)
    for (let e = 0; e < 8; e++) {
      const clickF = 5000 + (e % 3) * 700;
      addNote(buf, barT + e*beat*0.5, 0.03, clickF, oscSine, 0.04, 0.001, 0.005, 0.1, 0.01);
    }
  }

  normalise(buf);
  return buf;
}

/**
 * question-action  — E minor, driving tension, 140 BPM, 8 bars
 */
function genQuestionActionSamples() {
  const BPM  = 140;
  const beat = 60 / BPM;
  const bars = 8;
  const totalSec = bars * 4 * beat;
  const buf  = new Float32Array(Math.ceil(totalSec * SR));

  // Em - D - C - B chord progression (minor, tense)
  const chords = [
    [f('E3'), f('G3'), f('B3')],
    [f('D3'), f('F#3'), f('A3')],
    [f('C3'), f('E3'), f('G3')],
    [f('B2'), f('D#3'), f('F#3')],
  ];

  // Driving sixteenth-note arpeggio pattern (indices into chord)
  const arPat = [0, 1, 2, 1,  0, 2, 1, 0,  2, 1, 0, 2,  1, 0, 2, 1];

  for (let bar = 0; bar < bars; bar++) {
    const ch   = chords[bar % 4];
    const barT = bar * 4 * beat;
    const sixteenth = beat / 4;

    // Bass — driving eighth notes, saw wave (punchy)
    for (let e = 0; e < 8; e++) {
      addNote(buf, barT + e*beat*0.5, beat*0.38, ch[0]/2, oscSaw, 0.3, 0.005, 0.03, 0.85, 0.05);
    }

    // Arpeggio — 16th notes
    for (let s = 0; s < 16; s++) {
      const noteF = ch[arPat[s] % ch.length] * 2;
      addNote(buf, barT + s*sixteenth, sixteenth*0.75, noteF, oscSaw, 0.18, 0.003, 0.02, 0.8, 0.05);
    }

    // Tension chord stabs — beats 2 & 4
    [1, 3].forEach(qb => {
      ch.forEach(fr => {
        addNote(buf, barT + qb*beat, beat*0.22, fr*2, oscSq, 0.08, 0.003, 0.02, 0.5, 0.05);
      });
    });

    // Kick drum approximation (sine bowed down)
    [0, 2].forEach(qb => {
      const kickDur = 0.15;
      const s0 = Math.floor((barT + qb*beat) * SR);
      const sN = Math.min(buf.length, s0 + Math.ceil(kickDur * SR));
      for (let i = s0; i < sN; i++) {
        const t = (i - s0) / SR;
        const kickFreq = 80 * Math.exp(-t * 25);
        buf[i] += Math.sin(2 * Math.PI * kickFreq * t) * Math.exp(-t * 18) * 0.45;
      }
    });
  }

  normalise(buf);
  return buf;
}

/**
 * question-electronic  — pulsing electronic feel, 128 BPM, 8 bars
 */
function genQuestionElectronicSamples() {
  const BPM  = 128;
  const beat = 60 / BPM;
  const bars = 8;
  const totalSec = bars * 4 * beat;
  const buf  = new Float32Array(Math.ceil(totalSec * SR));

  // Dm - Am - Bb - C arpeggios
  const chords = [
    [f('D3'), f('F3'), f('A3'), f('C4')],
    [f('A2'), f('C3'), f('E3'), f('G3')],
    [f('Bb2'), f('D3'), f('F3'), f('A3')],
    [f('C3'), f('E3'), f('G3'), f('B3')],
  ];

  for (let bar = 0; bar < bars; bar++) {
    const ch   = chords[bar % 4];
    const barT = bar * 4 * beat;
    const eighth = beat * 0.5;

    // Pulsing square-wave bass on every eighth
    for (let e = 0; e < 8; e++) {
      addNote(buf, barT + e*eighth, eighth*0.7, ch[0]/2, oscSq, 0.28, 0.003, 0.02, 0.9, 0.04);
    }

    // Fast up arpeggio — 16th notes through 4 chord tones × 4
    const sixteenth = beat / 4;
    for (let s = 0; s < 16; s++) {
      const noteF = ch[s % ch.length] * 2;
      addNote(buf, barT + s*sixteenth, sixteenth*0.6, noteF, oscSaw, 0.16, 0.002, 0.01, 0.75, 0.03);
    }

    // Saw pad chord — whole bar, filtered feel (detuned pair)
    ch.forEach(fr => {
      addNote(buf, barT, 4*beat, fr * 1.002, oscSaw, 0.06, 0.12, 0.15, 0.6, 0.35);
      addNote(buf, barT, 4*beat, fr * 0.998, oscSaw, 0.06, 0.12, 0.15, 0.6, 0.35);
    });

    // Snare-like whump on beats 2 & 4
    [1, 3].forEach(qb => {
      const snareDur = 0.1;
      const s0 = Math.floor((barT + qb*beat) * SR);
      const sN = Math.min(buf.length, s0 + Math.ceil(snareDur * SR));
      for (let i = s0; i < sN; i++) {
        const t  = (i - s0) / SR;
        const decay = Math.exp(-t * 40);
        // white-noise approximation via chaotic high-freq
        const noise = Math.sin(2*Math.PI*3700*t) * Math.sin(2*Math.PI*1900*t)
                    + Math.sin(2*Math.PI*5100*t) * Math.sin(2*Math.PI*2300*t);
        buf[i] += noise * decay * 0.12;
      }
    });
  }

  normalise(buf);
  return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'public', 'audio', 'bgm');
fs.mkdirSync(outDir, { recursive: true });

console.log('Generating BGM tracks...');

const tracks = [
  { name: 'lobby-chill.wav',          gen: genLobbyChillSamples        },
  { name: 'lobby-upbeat.wav',         gen: genLobbyUpbeatSamples       },
  { name: 'question-action.wav',      gen: genQuestionActionSamples    },
  { name: 'question-electronic.wav',  gen: genQuestionElectronicSamples },
];

for (const { name, gen } of tracks) {
  process.stdout.write(`  generating ${name}... `);
  const samples = gen();
  writeWav(path.join(outDir, name), samples);
}

console.log('Done.');
