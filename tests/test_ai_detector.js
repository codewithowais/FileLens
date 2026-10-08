/**
 * AI-origin detector: builds realistic files and checks that tool / model / time / prompt are found,
 * and that ordinary camera files are NOT flagged.
 */
const FFprobeParser = require('../public/js/ffprobe-parser.js');
const AiDetector = require('../public/js/ai-detector.js');
global.AiDetector = AiDetector;

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };

// ---- helpers: tiny valid PNG with text chunks ----
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])), 8 + data.length); return out; };
const png = (w, h, texts = {}) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(texts)) parts.push(chunk('tEXt', Buffer.concat([Buffer.from(k), Buffer.from([0]), Buffer.from(v)])));
  parts.push(chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1])), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
};
const parse = async (buf, name, type) => {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  return FFprobeParser.parse({ name, size: buf.length, type, lastModified: 1700000000000 }, ab);
};

(async () => {
  // 1. Stable Diffusion (AUTOMATIC1111) PNG
  const a1111 = 'a red fox in a snowy forest, 4k\nNegative prompt: blurry, lowres\nSteps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234567890, Size: 768x768, Model hash: 31e35c80fc, Model: sd_xl_base_1.0, Version: v1.7.0';
  let r = await parse(png(768, 768, { parameters: a1111, 'Creation Time': '2025-03-04T10:20:30Z' }), 'fox.png', 'image/png');
  let ai = r.ai_analysis;
  check('A1111 PNG flagged as AI (confirmed)', ai.is_ai && ai.confidence === 'confirmed', `[${ai.label}]`);
  check('  model = sd_xl_base_1.0', ai.model === 'sd_xl_base_1.0', `[${ai.model}]`);
  check('  seed / steps / sampler parsed', ai.settings.seed === '1234567890' && ai.settings.steps === '28' && /DPM/.test(ai.settings.sampler));
  check('  prompt + negative prompt', /red fox/.test(ai.prompt) && /blurry/.test(ai.negative_prompt));
  check('  creation time found', /2025-03-04/.test(ai.created_at || ''), `[${ai.created_at} via ${ai.created_at_source}]`);
  check('  tamper verdict says AI', r.tamper_analysis.verdict === 'AI_GENERATED');

  // 2. ComfyUI PNG
  const comfy = JSON.stringify({
    3: { class_type: 'KSampler', inputs: { seed: 42, steps: 30, cfg: 6.5, sampler_name: 'euler', model: ['4', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'cyberpunk city at night' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'watermark' } }
  });
  r = await parse(png(1024, 1024, { prompt: comfy }), 'city.png', 'image/png'); ai = r.ai_analysis;
  check('ComfyUI PNG flagged', ai.is_ai && /ComfyUI/.test(ai.tool), `[${ai.tool}]`);
  check('  checkpoint model = flux1-dev', ai.model === 'flux1-dev', `[${ai.model}]`);
  check('  prompt extracted', /cyberpunk/.test(ai.prompt || ''));

  // 3. Image with C2PA-style OpenAI credentials + IPTC label (JPEG-ish bytes)
  const c2pa = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x10]), Buffer.from('c2pa.actions c2pa.created ChatGPT OpenAI 2025-06-01T12:34:56Z http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'), Buffer.alloc(300, 1), Buffer.from([0xFF, 0xD9])]);
  r = await parse(c2pa, 'gen.jpg', 'image/jpeg'); ai = r.ai_analysis;
  check('C2PA + IPTC label flagged as AI', ai.is_ai && ai.confidence === 'confirmed', `[${ai.label}]`);
  check('  vendor OpenAI/ChatGPT', /OpenAI|ChatGPT/i.test(ai.vendor || ai.tool || ''), `[${ai.vendor} / ${ai.tool}]`);
  check('  C2PA time found', ai.content_credentials.time === '2025-06-01T12:34:56Z', `[${ai.content_credentials.time}]`);

  // 4. Audio: MP3 with an ID3 comment from Suno
  const id3 = (frames) => { const body = Buffer.concat(frames); const hdr = Buffer.from('ID3'); const sz = Buffer.from([(body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f, (body.length >> 7) & 0x7f, body.length & 0x7f]); return Buffer.concat([hdr, Buffer.from([3, 0, 0]), sz, body]); };
  const frame = (id, text) => { const d = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]); const h = Buffer.alloc(10); h.write(id, 0); h.writeUInt32BE(d.length, 4); return Buffer.concat([h, d]); };
  const mp3 = Buffer.concat([id3([frame('TIT2', 'Neon Rain'), frame('COMM', 'made with suno studio, v4')]), Buffer.alloc(2000, 0xff)]);
  r = await parse(mp3, 'song.mp3', 'audio/mpeg'); ai = r.ai_analysis;
  check('Suno MP3 flagged', ai.is_ai && /Suno/.test(ai.tool || ''), `[${ai.tool} | ${ai.label}]`);

  // 4b. PDF whose Info fields are hex-encoded UTF-16 (LibreOffice style) must still be read
  const hex = (str) => '<feff' + [...str].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '>';
  const pdf = Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Producer ${hex('LibreOffice 24.2')} /Creator ${hex('Writer')} /CreationDate (D:20260511092633Z') >>\nendobj\ntrailer\n<< /Info 1 0 R >>\n%%EOF`, 'latin1');
  r = await parse(pdf, 'resume.pdf', 'application/pdf');
  check('PDF hex-encoded Producer/Creator decoded', r.all_tags.Producer === 'LibreOffice 24.2' && r.all_tags.Creator === 'Writer', `[${r.all_tags.Producer} / ${r.all_tags.Creator}]`);
  check('PDF date formatted', r.all_tags.CreationDate === '2026-05-11T09:26:33Z', `[${r.all_tags.CreationDate}]`);
  check('PDF origin shows the program, not a phone', /LibreOffice/.test(r.device_info.device_name));
  check('PDF is not flagged as AI and explains the limit', !r.ai_analysis.is_ai && /document/i.test(r.ai_analysis.notes[0]));

  // 5. Normal camera-style PNG: must NOT be flagged
  r = await parse(png(640, 480, { Software: 'Adobe Photoshop 25.0', Make: 'Canon', Model: 'EOS R5' }), 'photo.png', 'image/png'); ai = r.ai_analysis;
  check('Camera/Photoshop PNG is NOT flagged as AI', !ai.is_ai, `[${ai.label}]`);

  // 6. Plain random binary: no false positives
  const rnd = Buffer.alloc(3 * 1024 * 1024); for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761) >>> 24;
  r = await parse(rnd, 'blob.bin', 'application/octet-stream'); ai = r.ai_analysis;
  check('Random binary is NOT flagged', !ai.is_ai);

  // 7. Speed on a big file
  const big = Buffer.alloc(50 * 1024 * 1024, 7); const t = Date.now();
  AiDetector.analyze({ format: {}, streams: [], all_tags: {} }, new Uint8Array(big), { name: 'big.mp4' });
  check('Detector is fast on a 50 MB file', Date.now() - t < 1500, `(${Date.now() - t} ms)`);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\n✅ ALL AI DETECTOR TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
