/**
 * One-click clean adapts to the recording: hum is found (and only when present), noisy audio is cleaned
 * harder than clean audio, and quiet speech is brought up.
 */
global.window = global;
const fs = require('fs');
new Function(fs.readFileSync(__dirname + '/../public/js/audio-engine.js', 'utf8')).call(global);
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };

let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
const sr = 16000;
const mk = (len, fill) => { const d = new Float32Array(len); for (let i = 0; i < len; i++) d[i] = fill(i / sr); return { sampleRate: sr, numberOfChannels: 1, length: len, duration: len / sr, getChannelData: () => d }; };
// speech-like: bursts of a ~140 Hz voice with harmonics, pauses between words
const speech = (t, amp) => { const env = Math.max(0, Math.sin(2 * Math.PI * 0.8 * t)) ** 0.5; let v = 0; const ph = 2 * Math.PI * (140 * t - (20 / (2 * Math.PI * 0.3)) * Math.cos(2 * Math.PI * 0.3 * t));   // gliding pitch like real speech
  for (let h = 1; h <= 12; h++) v += Math.sin(h * ph) / h; return amp * env * v * 0.3; };
const make = ({ amp = 0.3, noise = 0.002, hum = 0, humHz = 50 }) => mk(sr * 60, t => speech(t, amp) + noise * (rnd() * 2) + hum * (Math.sin(2 * Math.PI * humHz * t) + 0.5 * Math.sin(2 * Math.PI * 2 * humHz * t) + 0.3 * Math.sin(2 * Math.PI * 3 * humHz * t)));
const eng = new AudioEngine();
eng.audioContext = null;

const clean = AudioEngine.analyzeRecording(make({ noise: 0.0005 }));
const noisy = AudioEngine.analyzeRecording(make({ noise: 0.05 }));
const hum50 = AudioEngine.analyzeRecording(make({ hum: 0.02, humHz: 50 }));
const hum60 = AudioEngine.analyzeRecording(make({ hum: 0.02, humHz: 60 }));
const quiet = AudioEngine.analyzeRecording(make({ amp: 0.02, noise: 0.0003 }));

check(`No hum reported on clean audio (humHz=${clean.humHz})`, clean.humHz === 0);
check(`50 Hz hum found (humHz=${hum50.humHz}, ${hum50.humDb.toFixed(1)} dB)`, hum50.humHz === 50);
check(`60 Hz hum found (humHz=${hum60.humHz})`, hum60.humHz === 60);
const rc = eng.recommendAutoClean(clean), rn = eng.recommendAutoClean(noisy);
check(`Noisy audio is cleaned harder (${rn.noiseReduction}% vs ${rc.noiseReduction}%; SNR ${noisy.snrDb.toFixed(0)} vs ${clean.snrDb.toFixed(0)} dB)`, rn.noiseReduction > rc.noiseReduction);
const rq = eng.recommendAutoClean(quiet), rl = eng.recommendAutoClean(clean);
check(`Quiet speech is brought up (+${rq.masterVolume} dB, loud one +${rl.masterVolume} dB)`, rq.masterVolume > rl.masterVolume && rq.masterVolume <= 15);
check('Without an analysis a safe default is used', eng.recommendAutoClean(null).noiseReduction === 85);
check('Tiny files do not crash', !AudioEngine.analyzeRecording(mk(100, () => 0)).valid);
eng.applyAutoClean(eng.recommendAutoClean(hum50));
check('Hum recommendation turns the notch on', eng.dspSettings.deHumEnabled && eng.dspSettings.deHumFreq === 50);
eng.applyAutoClean(eng.recommendAutoClean(clean));
check('No hum: notch stays off', !eng.dspSettings.deHumEnabled);
process.exit(failed ? 1 : 0);
