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
check('Without an analysis a gentle default is used', eng.recommendAutoClean(null).noiseReduction === 40 && eng.recommendAutoClean(null).humHz === 0);
check('Tiny files do not crash', !AudioEngine.analyzeRecording(mk(100, () => 0)).valid);
eng.applyAutoClean(eng.recommendAutoClean(hum50));
check('Hum recommendation turns the notch on', eng.dspSettings.deHumEnabled && eng.dspSettings.deHumFreq === 50);
eng.applyAutoClean(eng.recommendAutoClean(clean));
check('No hum: notch stays off', !eng.dspSettings.deHumEnabled);

// --- A voice must keep its body and clarity: the default clean may turn noise down, never thin the voice out ---
(async () => {
  const sr2 = 16000, n2 = sr2 * 14;
  const clean = new Float32Array(n2), env = new Float32Array(n2), input = new Float32Array(n2);
  let pink = 0;
  for (let i = 0; i < n2; i++) {
    const t = i / sr2, e = Math.max(0, Math.sin(2 * Math.PI * 0.5 * t)) ** 0.7; env[i] = e;
    const f0 = 120 + 25 * Math.sin(2 * Math.PI * 0.4 * t), ph = 2 * Math.PI * (120 * t - (25 / (2 * Math.PI * 0.4)) * Math.cos(2 * Math.PI * 0.4 * t));
    let v = 0; for (let h = 1; h <= 20; h++) { const fh = h * f0; v += (Math.exp(-((fh - 600) ** 2) / 80000) + 0.7 * Math.exp(-((fh - 1700) ** 2) / 245000) + 0.15) * Math.sin(h * ph) / h; }
    clean[i] = 0.25 * e * v; pink = 0.97 * pink + 0.2 * rnd();
    input[i] = clean[i] + 0.01 * (pink + 0.3 * rnd());
  }
  const mkBuf = (ch, len, rate) => { const d = Array.from({ length: ch }, () => new Float32Array(len)); return { d, sampleRate: rate, numberOfChannels: ch, length: len, duration: len / rate, copyToChannel(a, c) { d[c].set(a); }, getChannelData(c) { return d[c]; } }; };
  const buf = mkBuf(1, n2, sr2); buf.d[0].set(input);
  const e = new AudioEngine(); e.audioContext = { createBuffer: mkBuf }; e.originalBuffer = buf; e.fullBuffer = buf; e.useWorkers = false;
  await e.analyzeAndDecompose();
  e.recordingAnalysis = AudioEngine.analyzeRecording(buf);
  e.applyAutoClean(e.recommendAutoClean());
  const gains = e.getEffectiveGains(), out = new Float32Array(n2);
  e.componentDefs.forEach((d, s) => { const x = e.stems[d.id].getChannelData(0); for (let i = 0; i < n2; i++) out[i] += gains[s] * x[i]; });
  const band = (a, f0, f1) => { const N = 2048, fft = new FastFFT(N), w = AudioEngine.hannWindow(), re = new Float32Array(N), im = new Float32Array(N); let acc = 0; for (let o = 0; o + N < n2; o += N) { if (env[o + N / 2] < 0.7) continue; for (let i = 0; i < N; i++) { re[i] = a[o + i] * w[i]; im[i] = 0; } fft.transform(re, im); for (let k = Math.round(f0 * N / sr2); k <= Math.round(f1 * N / sr2); k++) acc += re[k] * re[k] + im[k] * im[k]; } return acc; };
  const lowDb = 10 * Math.log10(band(out, 80, 250) / band(clean, 80, 250)), midDb = 10 * Math.log10(band(out, 300, 3400) / band(clean, 300, 3400));
  check(`Voice body (80-250 Hz) is kept after the default clean (${lowDb.toFixed(1)} dB)`, lowDb > -3);
  check(`Voice mids (300-3400 Hz) are kept (${midDb.toFixed(1)} dB)`, midDb > -3 && midDb < 3);
  let pauseIn = 0, pauseOut = 0; for (let i = 0; i < n2; i++) if (env[i] < 0.02) { pauseIn += input[i] ** 2; pauseOut += out[i] ** 2; }
  const cutDb = 10 * Math.log10(pauseIn / pauseOut);
  check(`Noise is turned down but not erased (${cutDb.toFixed(1)} dB in the pauses)`, cutDb > 4 && cutDb < 30);
  
})();
