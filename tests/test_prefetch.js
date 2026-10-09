/**
 * Prefetch: the next part is split in the background and can be swapped in without another analysis.
 */
global.window = global;
const fs = require('fs');
new Function(fs.readFileSync(__dirname + '/../public/js/audio-engine.js', 'utf8')).call(global);
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };

let seed = 9; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
const sr = 16000, secs = 40, n = sr * secs;
const mk = (ch, len, rate) => { const d = Array.from({ length: ch }, () => new Float32Array(len)); return { d, sampleRate: rate, numberOfChannels: ch, length: len, duration: len / rate, copyToChannel(a, c) { d[c].set(a); }, getChannelData(c) { return d[c]; } }; };
const full = mk(1, n, sr);
for (let i = 0; i < n; i++) { const t = i / sr; full.d[0][i] = 0.3 * Math.sin(2 * Math.PI * (150 + 5 * Math.floor(t / 10)) * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t)) + 0.01 * rnd(); }
const make = () => { const e = new AudioEngine(); e.audioContext = { createBuffer: mk }; e.originalBuffer = full; e.fullBuffer = full; e.useWorkers = false; e.previewSeconds = 10; return e; };
const states = [];

(async () => {
  const e = make(); e.onPrefetchState = s => states.push(s);
  e.setExcerpt(0); await e.analyzeAndDecompose();
  check('Prefetch is allowed within the memory budget', e.canPrefetch());
  e.prefetchBudget = 1000; check('…and refused when the memory budget is too small', !e.canPrefetch() && !e.startPrefetch(10)); e.prefetchBudget = 0;
  check('Nothing is prefetched past the end of the recording', !e.startPrefetch(39.8));

  check('Prefetch starts for the next part', e.startPrefetch(10) === true && e._pf.state === 'running');
  check('Asking again for the same part does not start a second job', e.startPrefetch(10) === true);
  await e._pf.promise;
  check('It becomes ready', e._pf.state === 'ready' && e.prefetchReadyFor(10) && !e.prefetchReadyFor(20));
  check(`State changes were reported (${states.join(' → ')})`, states.join(',') === 'running,ready');

  e.stemValues.main_voice = 2.0; e.stemMutes.music = true;            // the user's settings must survive the swap
  const adopted = await e.adoptPrefetched(10);
  check('The prefetched part is swapped in', adopted && Math.abs(e.excerptStart - 10) < 1e-9 && e.originalBuffer.length === 10 * sr && e._pf === null);
  check('User gains and mutes are kept', e.stemValues.main_voice === 2.0 && e.stemMutes.music === true);

  // identical to analysing that part directly
  const ref = make(); ref.setExcerpt(10); await ref.analyzeAndDecompose();
  let md = 0; for (const id of Object.keys(ref.stems)) { const a = ref.stems[id].getChannelData(0), b = e.stems[id].getChannelData(0); for (let i = 0; i < a.length; i++) md = Math.max(md, Math.abs(a[i] - b[i])); }
  check(`Same layers as a direct analysis (max difference ${md.toExponential(1)})`, md < 1e-6);

  // handover is quick when prepared, and waits when still running
  e.startPrefetch(20);
  const waited = await e.adoptPrefetched(20);
  check('Adopting while the part is still being prepared waits for it', waited && Math.abs(e.excerptStart - 20) < 1e-9);

  // a jump somewhere else drops the prefetch
  e.startPrefetch(30); const other = await e.adoptPrefetched(5);
  check('A jump to a different part drops the prefetch', other === false && e._pf === null);

  // the last part is pulled back to end where the file ends
  e.startPrefetch(35); await e._pf.promise;
  check('The last part starts where the recording can still fill it', e.prefetchReadyFor(35) && e.prefetchReadyFor(30));
  await e.adoptPrefetched(35); check('…and is swapped in', Math.abs(e.excerptStart - 30) < 1e-9);

  // cancel and file change
  e.startPrefetch(10); e.cancelPrefetch(); check('Cancel discards it', e._pf === null);
  e.startPrefetch(10); e.cancelPrefetch.call(e); await new Promise(r => setTimeout(r, 50));
  check('A cancelled job does not come back to life', e._pf === null);
  process.exit(failed ? 1 : 0);
})();
