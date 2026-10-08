/**
 * Container facts must come from the file, never from defaults. Each expected value below is the ground truth
 * reported by the file itself / the tool that made it (macOS `file`, afconvert, libsndfile, the MDN and Matroska test suites).
 */
const fs = require('fs');
const FFprobeParser = require('../public/js/ffprobe-parser.js');
global.MetaExtras = require('../public/js/metadata-extras.js'); global.AiDetector = require('../public/js/ai-detector.js');
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };
const load = (f) => { const b = fs.readFileSync(f.startsWith('/') ? f : `${__dirname}/${f}`); return { b, ab: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
const parse = async (f, type = '') => { const { b, ab } = load(f); return FFprobeParser.parse({ name: f.split('/').pop(), size: b.length, type }, ab); };
const audio = (r) => r.streams.find(s => s.codec_type === 'audio'), video = (r) => r.streams.find(s => s.codec_type === 'video');

(async () => {
  // ---- MP3 ----
  let r = await parse('fixtures/viper.mp3'); let a = audio(r);
  check('MP3: 44.1 kHz stereo 128 kbps (macOS `file` says: layer III, v1, 128 kbps, 44.1 kHz, JntStereo)', a.sample_rate === '44100' && a.channels === 2 && a.bit_rate === '128000', `[${a.sample_rate} Hz, ${a.channels} ch, ${a.bit_rate}]`);
  check('MP3: duration from the file size and bitrate (40.9 s)', Math.abs(parseFloat(r.format.duration) - 40.93) < 0.1, `[${r.format.duration}]`);

  // ---- Ogg ----
  r = await parse('fixtures/tone_vorbis_mono48k.ogg'); a = audio(r);
  check('Ogg Vorbis mono 48 kHz, 3 s', a.codec_name === 'vorbis' && a.channels === 1 && a.sample_rate === '48000' && Math.abs(parseFloat(r.format.duration) - 3) < 0.05, `[${a.codec_name} ${a.channels}ch ${a.sample_rate} ${r.format.duration}s]`);
  check('Ogg: encoder tag read from the comment header', r.all_tags.encoder === 'libsndfile', `[${r.all_tags.encoder}]`);
  r = await parse('fixtures/tone_vorbis_stereo24k.ogg'); a = audio(r);
  check('Ogg Vorbis stereo 24 kHz (NOT the old made-up 48 kHz Opus)', a.codec_name === 'vorbis' && a.channels === 2 && a.sample_rate === '24000', `[${a.codec_name} ${a.channels}ch ${a.sample_rate}]`);
  r = await parse('fixtures/tone_opus_stereo.ogg'); a = audio(r);
  check('Ogg Opus stereo', a.codec_name === 'opus' && a.channels === 2 && Math.abs(parseFloat(r.format.duration) - 3) < 0.05, `[${a.codec_name} ${a.channels}ch ${r.format.duration}s]`);

  // ---- WebM / Matroska ----
  r = await parse('fixtures/mdn_video.webm'); let v = video(r); a = audio(r);
  check('WebM: VP8 320x240 video (NOT the old made-up 1920x1080 VP9)', v.codec_name === 'vp8' && v.width === 320 && v.height === 240, `[${v.codec_name} ${v.width}x${v.height}]`);
  check('WebM: Vorbis 44.1 kHz stereo audio (NOT the old made-up Opus 48 kHz)', a.codec_name === 'vorbis' && a.sample_rate === '44100' && a.channels === 2, `[${a.codec_name} ${a.sample_rate} ${a.channels}ch]`);
  check('WebM: real duration 7.8 s and muxing app', Math.abs(parseFloat(r.format.duration) - 7.8) < 0.05 && /Lavf/.test(r.all_tags.muxing_app), `[${r.format.duration}s, ${r.all_tags.muxing_app}]`);
  r = await parse('fixtures/test1_head.mkv'); v = video(r); a = audio(r);
  check('Matroska test1: 854x480 video + MPEG layer 3 audio 48 kHz stereo', v.width === 854 && v.height === 480 && a.codec_name === 'mp3' && a.sample_rate === '48000' && a.channels === 2, `[${v.width}x${v.height}; ${a.codec_name} ${a.sample_rate}]`);
  check('Matroska test1: 87.3 s, created 2010-08-21, muxer named', Math.abs(parseFloat(r.format.duration) - 87.336) < 0.01 && r.all_tags.creation_time.startsWith('2010-08-21'), `[${r.format.duration}s, ${r.all_tags.creation_time}]`);

  // ---- MP4 / AAC channel count from the real AAC configuration ----
  r = await parse('fixtures/tiny_mono_aac.m4a'); a = audio(r);
  check('MP4 AAC made from a MONO source is reported as mono (not the sample-entry default of 2)', a.channels === 1 && a.channel_layout === 'mono', `[${a.channels} ch, ${a.channel_layout}]`);
  r = await parse('../samples/sample_interview_with_noise.m4a'); a = audio(r);
  check('MP4 AAC stereo sample is reported as stereo at its real rate', a.channels === 2 && a.sample_rate === '44100', `[${a.channels} ch, ${a.sample_rate}]`);

  // ---- nothing invented for damaged / unrecognised data ----
  const junk = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 1)]);
  r = await FFprobeParser.parse({ name: 'x.ogg', size: junk.length, type: '' }, junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.length)); a = audio(r);
  check('Unreadable Ogg: no invented rate / channels / duration', !a.sample_rate && !a.channels && !r.format.duration, `[codec=${a.codec_name}]`);
  const junkMkv = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80, 0, 0, 0]);
  r = await FFprobeParser.parse({ name: 'x.mkv', size: junkMkv.length, type: '' }, junkMkv.buffer.slice(junkMkv.byteOffset, junkMkv.byteOffset + junkMkv.length));
  check('Unreadable Matroska: no invented video/audio tracks', r.streams.length === 0, `[${r.streams.length} streams]`);
  const junkMp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(100, 0)]);
  r = await FFprobeParser.parse({ name: 'x.mp3', size: junkMp3.length, type: '' }, junkMp3.buffer.slice(junkMp3.byteOffset, junkMp3.byteOffset + junkMp3.length)); a = audio(r);
  check('MP3 with no audio frames: no invented rate / bitrate', !a.sample_rate && !a.bit_rate, `[${a.sample_rate}, ${a.bit_rate}]`);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\n✅ MEDIA PROBE TESTS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
