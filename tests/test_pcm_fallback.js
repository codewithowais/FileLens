/**
 * Built-in AIFF / CAF decoder: decodes real files made by macOS afconvert and compares them with the
 * same audio as WAV, sample by sample.
 */
global.window = global;
const fs = require('fs');
new Function(fs.readFileSync(__dirname + '/../public/js/audio-engine.js', 'utf8')).call(global);

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// reference: tests/fixtures/tiny.wav and the AIFF / CAF files that macOS afconvert made from it
const wav = fs.readFileSync(__dirname + '/fixtures/tiny.wav');
const wv = new DataView(ab(wav)); const wavSr = wv.getUint32(24, true);
let dataAt = 12; while (wav.toString('latin1', dataAt, dataAt + 4) !== 'data') dataAt += 8 + wv.getUint32(dataAt + 4, true);
const nFrames = wv.getUint32(dataAt + 4, true) / 2;
for (const f of ['tiny.aiff', 'tiny.caf']) {
  const r = PcmFallback.decode(ab(fs.readFileSync(`${__dirname}/fixtures/${f}`)));
  check(`${f}: sample rate and channel count`, r.sampleRate === wavSr && r.channels.length === 1, `[${r.sampleRate} Hz, ${r.channels.length} ch]`);
  check(`${f}: length matches the WAV`, r.channels[0].length === nFrames, `[${r.channels[0].length} frames]`);
  let maxErr = 0; for (let i = 0; i < nFrames; i++) maxErr = Math.max(maxErr, Math.abs(r.channels[0][i] - wv.getInt16(dataAt + 8 + i * 2, true) / 32768));
  check(`${f}: audio is identical to the WAV it came from (max error ${maxErr.toExponential(1)})`, maxErr < 1e-6);
}

// synthetic: 24-bit big-endian AIFF, mono, 44100 Hz
const frames = 100, comm = Buffer.alloc(26); comm.writeUInt16BE(1, 0); comm.writeUInt32BE(frames, 2); comm.writeUInt16BE(24, 6);
comm.writeUInt16BE(0x400E, 8); comm.writeUInt32BE(0xAC440000, 10); comm.writeUInt32BE(0, 14);   // 44100 as 80-bit extended
const pcm = Buffer.alloc(frames * 3); for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(i / 5) * 4000000); pcm.writeIntBE(v, i * 3, 3); }
const ssnd = Buffer.concat([Buffer.alloc(8), pcm]);
const hdr = (id, b) => { const h = Buffer.alloc(8); h.write(id); h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
const body = Buffer.concat([Buffer.from('AIFF'), hdr('COMM', comm.subarray(0, 18)), hdr('SSND', ssnd)]);
const form = Buffer.concat([Buffer.from('FORM'), Buffer.from([0, 0, 0, 0]), body]); form.writeUInt32BE(body.length, 4);
const r24 = PcmFallback.decode(ab(form));
check('Synthetic 24-bit AIFF: rate 44100, 100 frames', r24.sampleRate === 44100 && r24.channels[0].length === 100, `[${r24.sampleRate} Hz, ${r24.channels[0].length}]`);
check('Synthetic 24-bit AIFF: values correct', Math.abs(r24.channels[0][10] - Math.sin(2) * 4000000 / 8388608) < 1e-6);
check('Garbage is rejected, not decoded', (() => { try { return PcmFallback.decode(ab(Buffer.from('FORM____AIFF'))) === undefined; } catch (e) { return true; } })());
check('Non-AIFF/CAF returns null', PcmFallback.decode(ab(Buffer.from('RIFFxxxxWAVE'))) === null);

console.log(failed ? `\n${failed} check(s) FAILED` : '\n✅ PCM FALLBACK TESTS PASSED');
process.exit(failed ? 1 : 0);
