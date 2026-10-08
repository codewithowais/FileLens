/**
 * End-to-end test of the Audio Cleaning player in a real browser (needs Playwright + Chromium).
 *   node tests/e2e/player.js
 * Builds an 8-minute test recording whose pitch encodes the minute (300 Hz + 100 Hz per minute), so the test can
 * check not only the clock but that the audio actually loaded for a position is the audio from that position.
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const root = path.join(__dirname, '..', '..', 'public');
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require(path.join(cp.execSync('npm root -g').toString().trim(), 'playwright')); }

const SR = 16000, MIN = 8, N = SR * 60 * MIN;
function makeWav(file) {
  const data = Buffer.alloc(44 + N * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + N * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(N * 2, 40);
  let phase = 0, seed = 1;
  for (let i = 0; i < N; i++) {
    const t = i / SR, f = 300 + 100 * Math.floor(t / 60);
    phase += 2 * Math.PI * f / SR;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data.writeInt16LE(Math.round(9000 * Math.sin(phase) + (seed / 4294967296 - 0.5) * 200), 44 + i * 2);
  }
  fs.writeFileSync(file, data);
}

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${name} ${extra}`); if (!ok) failed++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const clock = (txt) => { const m = txt.trim().split(':').map(Number); return m.length === 3 ? m[0] * 3600 + m[1] * 60 + m[2] : m[0] * 60 + m[1]; };

(async () => {
  const wav = path.join(os.tmpdir(), `filelens_player_test_${process.pid}.wav`); makeWav(wav);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }).listen(0);
  const port = server.address().port;
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await playwright.chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  const state = () => page.evaluate(() => {
    const e = window.__audioEngine;
    return { cur: document.getElementById('currentTimeDisplay').textContent, dur: document.getElementById('durationDisplay').textContent,
      slider: parseFloat(document.getElementById('timelineScrubber').value), playing: e.isPlaying, start: e.excerptStart, len: e.originalBuffer.duration,
      mode: e.playbackMode, paused: !e.isPlaying };
  });
  // The pitch of the audio at the player's current position, from the samples that are actually loaded
  const pitchHere = () => page.evaluate(() => {
    const e = window.__audioEngine, b = e.originalBuffer, d = b.getChannelData(0), sr = b.sampleRate;
    const at = Math.min(b.duration - 0.5, e.getCurrentTime() + 0.1), i0 = Math.floor(at * sr), n = Math.floor(0.25 * sr);
    let z = 0; for (let i = i0 + 1; i < i0 + n; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) z++;
    return { hz: z / 2 / 0.25, minute: Math.floor((e.excerptStart + at) / 60) };
  });
  const drag = async (seconds, total) => {
    await page.evaluate(([s, t]) => { const el = document.getElementById('timelineScrubber'); el.value = (s / t) * 100; el.dispatchEvent(new Event('input', { bubbles: true })); }, [seconds, total]);
    await page.waitForTimeout(700);                       // playback keeps ticking while the slider is held
    await page.evaluate(() => document.getElementById('timelineScrubber').dispatchEvent(new Event('change', { bubbles: true })));
  };
  const waitWindow = (start) => page.waitForFunction(s => Math.abs(window.__audioEngine.excerptStart - s) < 1 && window.__audioEngine.stems.main_voice && !document.querySelector('#studioLoading:not([style*="none"])'), start, { timeout: 120000 });
  const expectHz = (minute) => 300 + 100 * minute;

  await page.goto(`http://localhost:${port}/`);
  await page.setInputFiles('input[type=file]', wav);
  await page.waitForSelector('#btnModeStudio:not([disabled])', { timeout: 60000 });
  await page.click('#btnModeStudio');
  await page.waitForFunction(() => window.__audioEngine && window.__audioEngine.stems && window.__audioEngine.stems.main_voice, null, { timeout: 120000 });
  let s = await state();
  check(`Clock covers the whole recording (${s.dur})`, clock(s.dur) === MIN * 60);
  check('Only a part is loaded at a time (3-minute window)', near(s.len, 180, 1));
  check('Long-recording bar is shown', await page.isVisible('#excerptBar'));

  // play / pause
  await page.click('#btnPlayPause'); await page.waitForTimeout(2200); s = await state();
  check(`Play advances the clock (${s.cur})`, s.playing && clock(s.cur) >= 1 && clock(s.cur) <= 4);
  await page.click('#btnPlayPause'); await page.waitForTimeout(300); const p1 = await state(); await page.waitForTimeout(1000); const p2 = await state();
  check(`Pause holds the position (${p1.cur} → ${p2.cur})`, !p2.playing && p1.cur === p2.cur);

  // seek inside the loaded part (while paused)
  await drag(90, MIN * 60); await page.waitForTimeout(400); s = await state(); let ph = await pitchHere();
  check(`Seek inside the part to 1:30 (clock ${s.cur})`, near(clock(s.cur), 90, 1.5) && !s.playing);
  check(`…and the audio there is from minute 1 (${ph.hz} Hz, expect ${expectHz(1)})`, near(ph.hz, expectHz(1), 8));

  // skip buttons and keys (play first)
  await page.click('#btnPlayPause'); await page.waitForTimeout(500);
  const before = clock((await state()).cur); await page.click('#btnForward'); await page.waitForTimeout(400);
  const after = clock((await state()).cur);
  check(`+10 s button (${before} → ${after})`, near(after - before, 10.4, 1.5));
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(300);
  const back = clock((await state()).cur);
  check(`Left arrow goes back 5 s (${after} → ${back})`, near(after - back, 5 - 0.7, 1.5));

  // auto-advance into the next part while playing
  await drag(176, MIN * 60); await page.waitForTimeout(500);
  await waitWindow(180).catch(() => {}); await page.waitForTimeout(1500); s = await state(); ph = await pitchHere();
  check(`Playback continues into the next part by itself (window starts ${s.start.toFixed(0)} s, playing=${s.playing}, clock ${s.cur})`, near(s.start, 180, 1) && s.playing && clock(s.cur) >= 180);
  check(`…and plays minute 3 (${ph.hz} Hz, expect ${expectHz(3)})`, near(ph.hz, expectHz(3), 8));

  // end of the recording: the last part is pulled back to end where the file ends, but playback must carry on
  // from where the previous part stopped (6:00), not replay the part from its own start (5:00)
  await drag(5 * 60 + 57, MIN * 60); await waitWindow(300).catch(() => {}); await page.waitForTimeout(1500);
  s = await state(); ph = await pitchHere();
  check(`Hand-over into the last part carries on from 6:00 (window starts ${s.start.toFixed(0)} s, clock ${s.cur}, playing=${s.playing})`, near(s.start, 300, 1) && s.playing && clock(s.cur) >= 360 && clock(s.cur) < 368);
  check(`…and plays minute 6 (${ph.hz} Hz, expect ${expectHz(6)})`, near(ph.hz, expectHz(6), 8));

  // seek far outside the loaded part while playing, like a user dragging the slider
  await drag(7 * 60 + 10, MIN * 60); await waitWindow(300).catch(() => {}); await page.waitForTimeout(1500);
  s = await state(); ph = await pitchHere();
  check(`Seek to 7:10 loads that part (window starts ${s.start.toFixed(0)} s; the last part ends where the file ends, so it starts at 5:00)`, near(s.start, 300, 1));
  check(`…keeps playing from there (clock ${s.cur}, playing=${s.playing})`, s.playing && near(clock(s.cur), 432, 4));
  check(`…and the audio is from minute 7 (${ph.hz} Hz, expect ${expectHz(7)})`, near(ph.hz, expectHz(7), 8));

  // seek back to an earlier part while paused: loads it, stays paused
  await page.click('#btnPlayPause'); await page.waitForTimeout(300);
  await drag(2 * 60 + 20, MIN * 60); await waitWindow(140).catch(() => {}); await page.waitForTimeout(800);
  s = await state(); ph = await pitchHere();
  check(`Seek back to 2:20 while paused stays paused (window starts ${s.start.toFixed(0)} s, clock ${s.cur}, playing=${s.playing})`, !s.playing && near(s.start, 140, 1) && near(clock(s.cur), 140, 1.5));
  check(`…audio is from minute 2 (${ph.hz} Hz, expect ${expectHz(2)})`, near(ph.hz, expectHz(2), 8));

  // stop
  await page.click('#btnPlayPause'); await page.waitForTimeout(800); await page.click('#btnStop'); await page.waitForTimeout(300); s = await state();
  check(`Stop stops (playing=${s.playing}, clock ${s.cur})`, !s.playing);

  // before / after
  await page.click('#btnAbOriginal'); check('Before/After: Before selects the original', (await state()).mode === 'original');
  await page.click('#btnAbCleaned'); check('Before/After: After selects the cleaned audio', (await state()).mode === 'cleaned');

  // whole original
  await page.click('#btnPlayOriginal'); await page.waitForTimeout(2500);
  const orig = await page.evaluate(() => { const a = document.getElementById('originalPlayer'); return { dur: a.duration, t: a.currentTime, playing: !a.paused, wrap: document.getElementById('originalPlayerWrap').style.display }; });
  check(`Whole-original player opens and plays the full file (duration ${orig.dur.toFixed(0)} s, at ${orig.t.toFixed(1)} s)`, orig.wrap === 'flex' && orig.playing && near(orig.dur, MIN * 60, 2) && orig.t > 1);
  await page.evaluate(() => { document.getElementById('originalPlayer').currentTime = 400; }); await page.waitForTimeout(500);
  check('…and can jump anywhere in it', (await page.evaluate(() => document.getElementById('originalPlayer').currentTime)) >= 400);
  await page.click('#btnPlayOriginal');
  check('…and closes again', (await page.evaluate(() => document.getElementById('originalPlayerWrap').style.display)) === 'none');

  check(`No page errors (${errors.length})`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close(); server.close(); fs.unlinkSync(wav);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
