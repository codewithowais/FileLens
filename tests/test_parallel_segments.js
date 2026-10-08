/**
 * Splitting the stem synthesis into parallel segments must give the same stems as one pass.
 */
global.window = global;
const fs = require('fs');
new Function(fs.readFileSync(__dirname + '/../public/js/audio-engine.js', 'utf8')).call(global);
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };

let seed = 3; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
const sr = 16000, n = sr * 12;
const mk = (ch, len, rate) => { const d = Array.from({ length: ch }, () => new Float32Array(len)); return { d, sampleRate: rate, numberOfChannels: ch, length: len, duration: len / rate, copyToChannel(a, c) { d[c].set(a); }, getChannelData(c) { return d[c]; } }; };
const full = mk(2, n, sr);
for (let i = 0; i < n; i++) { const t = i / sr, sp = Math.sin(2 * Math.PI * 220 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t)); full.d[0][i] = 0.3 * sp + 0.15 * Math.sin(2 * Math.PI * 60 * t) + 0.04 * rnd(); full.d[1][i] = 0.25 * sp + 0.04 * rnd(); }
async function run(seg) { const e = new AudioEngine(); e.audioContext = { createBuffer: mk }; e.originalBuffer = full; e.fullBuffer = full; e.segmentCount = seg; e.useWorkers = false; await e.analyzeAndDecompose(); return e; }

(async () => {
  const a = await run(1), b = await run(4);
  let maxDiff = 0, peak = 0;
  for (const id of Object.keys(a.stems)) for (let c = 0; c < 2; c++) {
    const x = a.stems[id].getChannelData(c), y = b.stems[id].getChannelData(c);
    for (let i = 0; i < n; i++) { maxDiff = Math.max(maxDiff, Math.abs(x[i] - y[i])); peak = Math.max(peak, Math.abs(x[i])); }
  }
  check(`4 segments == 1 pass (max difference ${maxDiff.toExponential(1)}, peak ${peak.toFixed(2)})`, maxDiff < 1e-4 * Math.max(1, peak));
  // a worker that fails after delivering one segment: the main thread finishes the rest, nothing is added twice
  global.Worker = function () {};
  const c = new AudioEngine(); c.audioContext = { createBuffer: mk }; c.originalBuffer = full; c.fullBuffer = full; c.segmentCount = 4;
  c.runSegmentsOnWorkers = async (count, jobFor, merge) => { merge(await AudioEngine.synthSegment(jobFor(0), null, null, false), 0); throw new Error('worker died'); };
  const warn = console.warn; console.warn = () => {};
  await c.analyzeAndDecompose(); console.warn = warn; delete global.Worker;
  let d2 = 0; for (const id of Object.keys(a.stems)) { const x = a.stems[id].getChannelData(0), y = c.stems[id].getChannelData(0); for (let i = 0; i < n; i++) d2 = Math.max(d2, Math.abs(x[i] - y[i])); }
  check(`Worker failure mid-way falls back without double-counting (max difference ${d2.toExponential(1)})`, d2 < 1e-4 * Math.max(1, peak) && c.useWorkers === false);
  // shorter than one analysis frame: no crash, silent stems
  const tiny = mk(1, 1000, sr); const t = new AudioEngine(); t.audioContext = { createBuffer: mk }; t.originalBuffer = tiny; t.fullBuffer = tiny; t.useWorkers = false;
  let tinyOk = true; try { await t.analyzeAndDecompose(); } catch (e) { tinyOk = false; }
  check('A recording shorter than one frame does not crash', tinyOk);
  check('Component ids match the engine definitions', JSON.stringify(AudioEngine.COMPONENT_IDS) === JSON.stringify(a.componentDefs.map(c => c.id)));
  process.exit(failed ? 1 : 0);
})();
