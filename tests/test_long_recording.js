/**
 * Long recordings: the studio previews a window, the download cleans the WHOLE file in one streaming pass.
 * The streaming pass must give the same audio as summing the nine stems with the same gains.
 */
global.window = global;
const fs = require('fs');
new Function(fs.readFileSync(__dirname + '/../public/js/audio-engine.js', 'utf8')).call(global);
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };

let seed = 777; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
const sr = 16000, seconds = 20, n = sr * seconds;
const L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { const t = i / sr, sp = Math.sin(2 * Math.PI * 220 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1.5 * t)); L[i] = 0.3 * sp + 0.15 * Math.sin(2 * Math.PI * 60 * t) + 0.04 * rnd(); R[i] = 0.25 * sp + 0.15 * Math.sin(2 * Math.PI * 60 * t + 1) + 0.04 * rnd(); }
const mk = (ch, len, rate) => { const d = Array.from({ length: ch }, () => new Float32Array(len)); return { d, sampleRate: rate, numberOfChannels: ch, length: len, duration: len / rate, copyToChannel(a, c) { d[c].set(a); }, getChannelData(c) { return d[c]; } }; };
const full = mk(2, n, sr); full.d[0].set(L); full.d[1].set(R);
const eng = new AudioEngine();
eng.audioContext = { createBuffer: (ch, len, rate) => mk(ch, len, rate) };
eng.originalBuffer = full; eng.fullBuffer = full;

(async () => {
  // --- preview window ---
  eng.setExcerpt(5, 6);
  check('Preview window: 6 s taken from 5 s', eng.isExcerpt && eng.originalBuffer.length === 6 * sr && Math.abs(eng.excerptStart - 5) < 1e-9, `[${eng.originalBuffer.duration}s from ${eng.excerptStart}s]`);
  check('Preview window holds the right samples', eng.originalBuffer.getChannelData(0)[100] === L[5 * sr + 100]);
  eng.setExcerpt(0, 999);
  check('Short recordings are used whole (no preview mode)', !eng.isExcerpt && eng.originalBuffer === full);
  eng.setExcerpt(18, 6);
  check('Window start is clamped to the end of the file', Math.abs(eng.excerptStart - 14) < 1e-9, `[starts at ${eng.excerptStart}s]`);

  // --- streaming mix equals the sum of the stems ---
  eng.setExcerpt(0, 999);                         // decompose the whole 20 s so we can compare like for like
  await eng.analyzeAndDecompose();
  eng.applyPreset('cafe_preserve_voices'); eng.setStemGain('main_voice', 5); eng.setStemMute('music', true);
  const gains = eng.getEffectiveGains();
  check('Mute is reflected in the effective gains', gains[eng.componentDefs.findIndex(c => c.id === 'music')] === 0);
  const ids = eng.componentDefs.map(c => c.id);
  const sum = [new Float32Array(n), new Float32Array(n)];
  ids.forEach((id, s) => { for (let c = 0; c < 2; c++) { const d = eng.stems[id].getChannelData(c); for (let i = 0; i < n; i++) sum[c][i] += gains[s] * d[i]; } });
  const t0 = Date.now();
  const mixed = await eng.mixWithGains(full, gains);
  const ms = Date.now() - t0;
  let maxDiff = 0, peak = 0; for (let c = 0; c < 2; c++) { const m = mixed.getChannelData(c); for (let i = 0; i < n; i++) { maxDiff = Math.max(maxDiff, Math.abs(m[i] - sum[c][i])); peak = Math.max(peak, Math.abs(sum[c][i])); } }
  check(`Streaming mix == sum of stems (max difference ${maxDiff.toExponential(1)}, peak ${peak.toFixed(2)})`, maxDiff < 1e-4 * Math.max(1, peak));
  check(`Streaming mix of ${seconds}s stereo took ${ms} ms`, ms < 20000);

  // --- unity gains give back the original ---
  const unity = await eng.mixWithGains(full, ids.map(() => 1));
  let e = 0, p = 0; for (let i = 4096; i < n - 4096; i++) { e += (unity.getChannelData(0)[i] - L[i]) ** 2; p += L[i] ** 2; }
  check('Unity gains reproduce the original recording', 10 * Math.log10(e / p) < -60, `[error ${(10 * Math.log10(e / p)).toFixed(0)} dB]`);

  // --- mono input ---
  const mono = mk(1, n, sr); mono.d[0].set(L);
  const monoMix = await eng.mixWithGains(mono, ids.map(() => 1));
  check('Mono recordings stay mono', monoMix.numberOfChannels === 1 && monoMix.length === n);

  // --- cancel ---
  const ac = new AbortController(); setTimeout(() => ac.abort(), 30);
  let aborted = false; try { await eng.mixWithGains(full, gains, () => {}, ac.signal); } catch (err) { aborted = err.name === 'AbortError'; }
  check('Cleaning can be cancelled', aborted);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\n✅ LONG RECORDING TESTS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
