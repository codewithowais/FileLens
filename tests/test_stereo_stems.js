/**
 * Verifies the STFT decomposition keeps stereo: left and right differ, and the sum of all
 * stems reconstructs each original channel (energy-conserving masks).
 */
global.window = global;
const fs = require('fs');
new Function(fs.readFileSync(__dirname + '/../public/js/audio-engine.js', 'utf8')).call(global);

const sr = 16000, n = sr * 2;
const L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) {
  L[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / sr) + 0.05 * Math.sin(2 * Math.PI * 60 * i / sr);
  R[i] = 0.4 * Math.sin(2 * Math.PI * 880 * i / sr) + 0.02 * (Math.random() - 0.5);
}
const store = [];
const mkBuf = (ch) => { const d = Array.from({ length: ch }, () => new Float32Array(n)); return { d, copyToChannel(a, c) { d[c].set(a); }, getChannelData(c) { return d[c]; } }; };
const eng = new AudioEngine();
eng.audioContext = { createBuffer: (ch) => { const b = mkBuf(ch); store.push(b); return b; } };
eng.originalBuffer = { sampleRate: sr, numberOfChannels: 2, length: n, getChannelData: (c) => (c ? R : L) };

(async () => {
  await eng.analyzeAndDecompose();
  const ids = eng.componentDefs.map(c => c.id);
  const sum = [new Float32Array(n), new Float32Array(n)];
  ids.forEach(id => { for (let c = 0; c < 2; c++) { const d = eng.stems[id].getChannelData(c); for (let i = 0; i < n; i++) sum[c][i] += d[i]; } });
  const err = (a, b) => { let e = 0, p = 0; for (let i = 2048; i < n - 2048; i++) { e += (a[i] - b[i]) ** 2; p += b[i] ** 2; } return 10 * Math.log10(e / p); };
  const eL = err(sum[0], L), eR = err(sum[1], R);
  // Cross-talk: right-channel sum must not look like the left channel
  const eCross = err(sum[1], L);
  console.log(`Reconstruction error  L: ${eL.toFixed(1)} dB   R: ${eR.toFixed(1)} dB   (R vs L cross: ${eCross.toFixed(1)} dB)`);
  if (eL > -30 || eR > -30) { console.error('❌ stems do not reconstruct the original channels'); process.exit(1); }
  if (eCross < -10) { console.error('❌ right channel collapsed to left'); process.exit(1); }
  console.log('✅ Stereo preserved: stems reconstruct both channels independently');
})();
