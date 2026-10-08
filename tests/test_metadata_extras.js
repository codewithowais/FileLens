/**
 * Metadata coverage: EXIF + GPS, UserComment (AI settings in JPEG), compressed PNG text,
 * Word/Office documents, WebP / HEIC EXIF, XMP AI labels, script-generated document hints.
 */
const zlib = require('zlib');
const FFprobeParser = require('../public/js/ffprobe-parser.js');
const AiDetector = require('../public/js/ai-detector.js');
const MetaExtras = require('../public/js/metadata-extras.js');
global.AiDetector = AiDetector; global.MetaExtras = MetaExtras;

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };
const parse = (buf, name, type) => FFprobeParser.parse({ name, size: buf.length, type, lastModified: 1700000000000 }, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));

// ---------- little-endian TIFF/EXIF builder ----------
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const ascii = (s) => Buffer.from(s + '\0', 'latin1');
const rationals = (arr) => Buffer.concat(arr.flatMap(([n, d]) => [u32(n), u32(d)]));
function buildTiff({ ifd0, exif, gps }) {
  const ifds = { ifd0: [...ifd0], exif, gps };
  const size = (list) => 2 + list.length * 12 + 4;
  const off = { ifd0: 8 };
  if (exif) { ifds.ifd0.push({ tag: 0x8769, type: 4, count: 1, ptr: 'exif' }); }
  if (gps) { ifds.ifd0.push({ tag: 0x8825, type: 4, count: 1, ptr: 'gps' }); }
  ifds.ifd0.sort((a, b) => a.tag - b.tag);
  off.exif = off.ifd0 + size(ifds.ifd0);
  off.gps = off.exif + (exif ? size(exif) : 0);
  let dataPos = off.gps + (gps ? size(gps) : 0);
  const data = [];
  const emit = (list) => {
    const sorted = [...list].sort((a, b) => a.tag - b.tag);
    const parts = [u16(sorted.length)];
    for (const e of sorted) {
      let valueField;
      if (e.ptr) valueField = u32(off[e.ptr]);
      else if (e.bytes.length <= 4) valueField = Buffer.concat([e.bytes, Buffer.alloc(4 - e.bytes.length)]);
      else { valueField = u32(dataPos); data.push(e.bytes); dataPos += e.bytes.length; }
      parts.push(u16(e.tag), u16(e.type), u32(e.count), valueField);
    }
    parts.push(u32(0));
    return Buffer.concat(parts);
  };
  const out = [Buffer.from('II*\0'), u32(8), emit(ifds.ifd0)];
  if (exif) out.push(emit(exif));
  if (gps) out.push(emit(gps));
  out.push(...data);
  return Buffer.concat(out);
}
const jpegWith = (tiff, extraSegments = []) => {
  const app1 = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const seg = (marker, body) => Buffer.concat([Buffer.from([0xFF, marker]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const sof = seg(0xC0, Buffer.from([8, 0x01, 0x80, 0x01, 0xE0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), seg(0xE1, app1), ...extraSegments, sof, Buffer.from([0xFF, 0xD9])]);
};

// ---------- zip builder (for docx) ----------
function buildZip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text); const comp = zlib.deflateRawSync(raw); const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034B50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014B50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054B50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const docx = (core, app, extra = {}) => buildZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>', 'docProps/core.xml': core, 'docProps/app.xml': app, ...extra });

// ---------- PNG builder ----------
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); o.write(type, 4, 'latin1'); data.copy(o, 8); o.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])), 8 + data.length); return o; };
const png = (chunks) => { const ih = Buffer.alloc(13); ih.writeUInt32BE(512, 0); ih.writeUInt32BE(512, 4); ih[8] = 8; ih[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ih), ...chunks, chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1])), chunk('IEND', Buffer.alloc(0))]); };

(async () => {
  // 1. JPEG: camera EXIF + GPS (San Francisco-ish) ------------------------------------------------
  const tiff = buildTiff({
    ifd0: [
      { tag: 0x010F, type: 2, count: 6, bytes: ascii('Apple') }, { tag: 0x0110, type: 2, count: 14, bytes: ascii('iPhone 14 Pro') },
      { tag: 0x0131, type: 2, count: 7, bytes: ascii('17.4.1') }
    ],
    exif: [
      { tag: 0x829A, type: 5, count: 1, bytes: rationals([[1, 120]]) }, { tag: 0x829D, type: 5, count: 1, bytes: rationals([[178, 100]]) },
      { tag: 0x8827, type: 3, count: 1, bytes: u16(64) }, { tag: 0x9003, type: 2, count: 20, bytes: ascii('2025:08:01 10:11:12') },
      { tag: 0x920A, type: 5, count: 1, bytes: rationals([[69, 10]]) }
    ],
    gps: [
      { tag: 0x0001, type: 2, count: 2, bytes: ascii('N') }, { tag: 0x0002, type: 5, count: 3, bytes: rationals([[37, 1], [46, 1], [2964, 100]]) },
      { tag: 0x0003, type: 2, count: 2, bytes: ascii('W') }, { tag: 0x0004, type: 5, count: 3, bytes: rationals([[122, 1], [25, 1], [984, 100]]) },
      { tag: 0x0005, type: 1, count: 1, bytes: Buffer.from([0]) }, { tag: 0x0006, type: 5, count: 1, bytes: rationals([[1250, 100]]) }
    ]
  });
  let r = await parse(jpegWith(tiff), 'phone.jpg', 'image/jpeg'); let t = r.all_tags;
  check('EXIF camera: Apple iPhone 14 Pro', t.Make === 'Apple' && t.Model === 'iPhone 14 Pro', `[${t.Make} ${t.Model}]`);
  check('EXIF exposure: 1/120 s, f/1.8, ISO 64, 6.9 mm', t.ExposureTime === '1/120 s' && t.FNumber === 'f/1.8' && t.ISO === '64' && t.FocalLength === '6.9 mm', `[${t.ExposureTime} ${t.FNumber} ISO${t.ISO} ${t.FocalLength}]`);
  check('EXIF date taken', t.DateTimeOriginal === '2025:08:01 10:11:12');
  check('GPS latitude  37.7749 N', Math.abs(+t.GPSLatitude - 37.7749) < 0.0002, `[${t.GPSLatitude}]`);
  check('GPS longitude -122.4194 (West is negative)', Math.abs(+t.GPSLongitude + 122.4194) < 0.0002, `[${t.GPSLongitude}]`);
  check('GPS altitude + readable position', t.GPSAltitude === '12.5 m' && /N, .*W$/.test(t.GPSPosition), `[${t.GPSPosition} | ${t.GPSAltitude}]`);
  check('Camera photo is NOT flagged as AI', !r.ai_analysis.is_ai);

  // 2. JPEG with A1111 settings in EXIF UserComment (UTF-16) -------------------------------------
  const params = 'neon samurai portrait\nNegative prompt: lowres\nSteps: 30, Sampler: Euler a, CFG scale: 7, Seed: 99, Size: 512x768, Model hash: abc123, Model: dreamshaper_8, Version: v1.8.0';
  const uc = Buffer.concat([Buffer.from('UNICODE\0'), Buffer.from(params, 'utf16le')]);
  const tiff2 = buildTiff({ ifd0: [], exif: [{ tag: 0x9286, type: 7, count: uc.length, bytes: uc }] });
  r = await parse(jpegWith(tiff2), 'sd.jpg', 'image/jpeg'); t = r.all_tags;
  check('JPEG UserComment decoded', /Steps: 30/.test(t.UserComment || ''), `[${(t.UserComment || '').slice(0, 30)}…]`);
  check('JPEG Stable Diffusion detected, model dreamshaper_8', r.ai_analysis.is_ai && r.ai_analysis.model === 'dreamshaper_8', `[${r.ai_analysis.label} | ${r.ai_analysis.model}]`);
  check('  prompt & seed recovered', /neon samurai/.test(r.ai_analysis.prompt || '') && r.ai_analysis.settings.seed === '99');

  // 3. PNG with COMPRESSED text (zTXt + compressed iTXt) -----------------------------------------
  const ztxt = chunk('zTXt', Buffer.concat([Buffer.from('parameters\0\0'), zlib.deflateSync(Buffer.from(params))]));
  r = await parse(png([ztxt]), 'z.png', 'image/png');
  check('PNG zTXt (compressed) AI settings found', r.ai_analysis.is_ai && r.ai_analysis.model === 'dreamshaper_8', `[${r.ai_analysis.model}]`);
  const itxt = chunk('iTXt', Buffer.concat([Buffer.from('prompt\0'), Buffer.from([1, 0]), Buffer.from('\0\0'), zlib.deflateSync(Buffer.from(JSON.stringify({ 1: { class_type: 'KSampler', inputs: { seed: 5, steps: 20, cfg: 5, sampler_name: 'euler' } }, 2: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl_turbo.safetensors' } } })))]));
  r = await parse(png([itxt]), 'c.png', 'image/png');
  check('PNG compressed iTXt (ComfyUI) found', r.ai_analysis.is_ai && /ComfyUI/.test(r.ai_analysis.tool || '') && r.ai_analysis.model === 'sdxl_turbo', `[${r.ai_analysis.tool} | ${r.ai_analysis.model}]`);
  const utf = chunk('iTXt', Buffer.concat([Buffer.from('parameters\0'), Buffer.from([0, 0]), Buffer.from('\0\0'), Buffer.from('un chat très mignon 猫\nSteps: 10, Sampler: Euler, Seed: 1, Model: m1')]));
  r = await parse(png([utf]), 'u.png', 'image/png');
  check('PNG UTF-8 prompt keeps accents & CJK', /très mignon 猫/.test(r.ai_analysis.prompt || ''), `[${r.ai_analysis.prompt}]`);

  // 4. Word documents ----------------------------------------------------------------------------
  const core = (creator, last, created, modified, title = '') => `<cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z"><dc:title>${title}</dc:title><dc:creator>${creator}</dc:creator><cp:lastModifiedBy>${last}</cp:lastModifiedBy><cp:revision>4</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified></cp:coreProperties>`;
  const app = '<Properties><Application>Microsoft Office Word</Application><AppVersion>16.0000</AppVersion><Company>Acme</Company><Pages>3</Pages><Words>1200</Words><TotalTime>45</TotalTime></Properties>';
  r = await parse(docx(core('Jane Doe', 'Bob Ray', '2025-01-02T09:00:00Z', '2025-01-05T17:30:00Z', 'Quarterly report'), app), 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); t = r.all_tags;
  check('DOCX author / last saved by', t.Author === 'Jane Doe' && t.LastModifiedBy === 'Bob Ray', `[${t.Author} / ${t.LastModifiedBy}]`);
  check('DOCX program, version, pages, words', t.Application === 'Microsoft Office Word' && t.AppVersion === '16.0000' && t.Pages === '3' && t.Words === '1200');
  check('DOCX created / modified dates', t.creation_time === '2025-01-02T09:00:00Z' && t.modification_time === '2025-01-05T17:30:00Z');
  check('DOCX treated as a document (not a phone)', /Microsoft Office Word/.test(r.device_info.device_name) && r.device_info.is_document);
  check('DOCX "saved again later" verdict, not "re-encoded"', r.tamper_analysis.verdict === 'EDITED_LATER', `[${r.tamper_analysis.verdict_label}]`);
  check('DOCX normal document not flagged AI', !r.ai_analysis.is_ai);

  r = await parse(docx(core('python-docx', 'python-docx', '2013-12-23T23:15:00Z', '2013-12-23T23:15:00Z'), '<Properties/>'), 'gen.docx', 'application/zip');
  check('python-docx file: hint shown but NOT called AI', !r.ai_analysis.is_ai && r.ai_analysis.hints.some(h => /python-docx/.test(h)), `[${r.ai_analysis.hints.length} hint(s)]`);

  r = await parse(docx(core('Jane', 'Jane', '2025-01-02T09:00:00Z', '2025-01-02T09:00:00Z', 'ChatGPT tutorial for beginners'), app), 'tut.docx', 'application/zip');
  check('Title "ChatGPT tutorial" is NOT confirmed AI (topic, not tool)', r.ai_analysis.confidence !== 'confirmed', `[${r.ai_analysis.confidence}]`);

  r = await parse(docx(core('Gamma', 'Gamma', '2025-03-01T00:00:00Z', '2025-03-01T00:00:00Z'), '<Properties><Application>Gamma</Application></Properties>'), 'deck.pptx', 'application/zip');
  r.all_tags.Software; check('Presentation made by "Gamma" (AI deck tool) as Creator → AI', r.ai_analysis.is_ai && /Gamma/.test(r.ai_analysis.tool || ''), `[${r.ai_analysis.tool}]`);

  // 5. WebP with EXIF + HEIC-style container -----------------------------------------------------
  const riffWebp = (chunks) => { const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]); const h = Buffer.alloc(8); h.write('RIFF'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
  const webChunk = (id, data) => { const h = Buffer.alloc(8); h.write(id); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8x = Buffer.alloc(10); vp8x.writeUIntLE(1023, 4, 3); vp8x.writeUIntLE(767, 7, 3);
  r = await parse(riffWebp([webChunk('VP8X', vp8x), webChunk('EXIF', Buffer.concat([Buffer.from('Exif\0\0'), tiff]))]), 'p.webp', 'image/webp');
  check('WebP EXIF + GPS + real dimensions', r.all_tags.Make === 'Apple' && r.all_tags.GPSPosition && r.streams[0].width === 1024 && r.streams[0].height === 768, `[${r.streams[0].width}x${r.streams[0].height}]`);

  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(4), Buffer.from('mif1heic')]);
  const ispe = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ispe'), Buffer.alloc(4), Buffer.from([0, 0, 0x0F, 0xA0, 0, 0, 0x0B, 0xB8])]);
  r = await parse(Buffer.concat([ftyp, ispe, Buffer.from('Exif\0\0'), tiff, Buffer.alloc(64)]), 'IMG_0001.HEIC', 'image/heic');
  check('HEIC: EXIF, GPS and size (4000×3000) found', r.all_tags.Model === 'iPhone 14 Pro' && r.all_tags.GPSPosition && r.streams[0].width === 4000 && r.streams[0].height === 3000, `[${r.streams[0] && r.streams[0].width}x${r.streams[0] && r.streams[0].height}]`);

  // 6. TIFF file, Apple ISO-6709 string, XMP label ------------------------------------------------
  r = await parse(tiff, 'scan.tif', 'image/tiff');
  check('TIFF: camera and GPS read', r.all_tags.Make === 'Apple' && !!r.all_tags.GPSPosition);
  const iso = {}; iso.Location = '+37.7749-122.4194+012.500/'; MetaExtras.applyIso6709(iso);
  check('Apple ISO-6709 location parsed', Math.abs(+iso.GPSLatitude - 37.7749) < 1e-6 && Math.abs(+iso.GPSLongitude + 122.4194) < 1e-6 && iso.GPSAltitude === '12.5 m', `[${iso.GPSPosition}]`);

  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreatorTool="Some Editor 3" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia" photoshop:Credit="Made by tool"></rdf:Description></rdf:RDF></x:xmpmeta>';
  const seg = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xmp)]);
  const app1xmp = Buffer.concat([Buffer.from([0xFF, 0xE1, (seg.length + 2) >> 8, (seg.length + 2) & 255]), seg]);
  r = await parse(Buffer.concat([Buffer.from([0xFF, 0xD8]), app1xmp, Buffer.from([0xFF, 0xD9])]), 'x.jpg', 'image/jpeg'); t = r.all_tags;
  check('XMP: DigitalSourceType + CreatorTool + Credit read', t.DigitalSourceType === 'trainedAlgorithmicMedia' && t.CreatorTool === 'Some Editor 3' && t.Credit === 'Made by tool', `[${t.DigitalSourceType}]`);
  check('  → flagged as AI via standard IPTC label', r.ai_analysis.is_ai && r.ai_analysis.confidence === 'confirmed');

  // 7. Nothing is invented: files without an encoder tag must not get one ----------------------------
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE'), Buffer.from('fmt '), Buffer.from([16, 0, 0, 0, 1, 0, 2, 0, 0x44, 0xAC, 0, 0, 0x10, 0xB1, 2, 0, 4, 0, 16, 0]), Buffer.from('data'), Buffer.from([0, 0, 0, 0])]);
  r = await parse(wav, 'plain.wav', 'audio/wav');
  check('Plain WAV has no invented encoder tag', !r.all_tags.encoder && !r.format.tags.encoder, `[${r.all_tags.encoder}]`);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0])]);
  r = await parse(mp4, 'empty.mp4', 'video/mp4');
  check('MP4 with no tracks gets no fabricated audio stream', r.streams.length === 0, `[${r.streams.length} streams]`);
  check('MP4 brand fields come from the file (no invented compat brands)', r.format.tags.major_brand === 'isom' && !/mp41/.test(r.format.tags.compatible_brands || ''), `[${r.format.tags.compatible_brands}]`);
  check('Bare MP4 is not blamed on LAVF / CoreAudio', !/lavf|coreaudio/i.test(JSON.stringify(r.all_tags)) && r.tamper_analysis.verdict !== 'RE_ENCODED');
  check('HEIC photo is not reported as audio', (await parse(Buffer.concat([ftyp, Buffer.alloc(300)]), 'a.heic', 'image/heic')).streams.every(s => s.codec_type !== 'audio'));

  console.log(failed ? `\n${failed} check(s) FAILED` : '\n✅ ALL METADATA COVERAGE TESTS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
