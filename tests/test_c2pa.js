/**
 * C2PA verification against REAL signed files from the C2PA project (tests/fixtures, from
 * github.com/contentauth/c2pa-rs, sdk/tests/fixtures) plus deliberate tampering.
 */
const fs = require('fs');
const V = require('../public/js/c2pa-verifier.js');
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed++; };
const load = (n) => new Uint8Array(fs.readFileSync(__dirname + '/fixtures/' + n));
const find = (u8, text, from = 0) => { const t = Buffer.from(text); return Buffer.from(u8).indexOf(t, from); };
const topBox = (u8, type) => { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let p = 0; while (p + 8 <= u8.length) { const sz = dv.getUint32(p) || (u8.length - p); if (Buffer.from(u8.subarray(p + 4, p + 8)).toString('latin1') === type) return p; p += sz; } return -1; };
const flip = (u8, idx) => { const c = new Uint8Array(u8); c[idx] ^= 0x01; return c; };

(async () => {
  console.log('--- genuine files ---');
  for (const f of ['CA.jpg', 'C.jpg']) {
    const r = await V.verify(load(f));
    check(`${f}: manifest found and read`, r.present && r.status !== 'unreadable' && r.manifests === 1, `[${r.container}]`);
    check(`${f}: signature valid`, r.checks.find(c => /Signature is math/.test(c.name)).ok === true);
    check(`${f}: all signed assertion hashes match`, r.checks.find(c => /Assertion hashes/.test(c.name)).ok === true);
    check(`${f}: file content matches signed hash`, r.contentBinding === 'match');
    check(`${f}: signer read from certificate`, r.signer.name === 'C2PA Signer' && /C2PA Test/.test(r.signer.organization), `[${r.signer.name} / ${r.signer.organization}]`);
    check(`${f}: test certificate is NOT on the real trust list`, r.signer.trusted === false && r.status === 'valid_untrusted', `[${r.status}]`);
    check(`${f}: trusted signing time read from timestamp`, r.time && r.time.value === '2024-08-06T21:53:37Z', `[${r.time && r.time.value}]`);
  }
  const c = await V.verify(load('C.jpg'));
  check('C.jpg: claim generator + actions + source type', c.claim.generator === 'make_test_images' && c.actions[0].action === 'c2pa.created' && c.actions[0].digitalSourceType === 'algorithmicMedia', `[${c.claim.generator}; ${c.actions[0].action}; ${c.actions[0].digitalSourceType}]`);
  check('C.jpg: "algorithmicMedia" = made by software, NOT labelled as AI', c.ai.marked === false && c.ai.algorithmic === true);

  console.log('--- trust list ---');
  const anchors = require('../public/js/c2pa-trust-anchors.js');
  check('Official trust list embedded', anchors.length === 30, `[${anchors.length} anchors]`);
  // Trust the test CA: the same file must now come out fully verified
  const raw = load('CA.jpg');
  const loc = require('../public/js/c2pa-verifier.js');
  // extract the intermediate cert from the file itself and make it the only anchor
  const certs = []; const buf = Buffer.from(raw);
  for (let i = 0; i + 4 < buf.length; i++) if (buf[i] === 0x30 && buf[i + 1] === 0x82 && buf[i + 4] === 0x30 && buf[i + 5] === 0x82 && buf[i + 8] === 0xA0 && buf[i + 9] === 0x03) { const len = (buf[i + 2] << 8 | buf[i + 3]) + 4; certs.push(buf.subarray(i, i + len)); i += len; }
  check('Found the 2 embedded certificates', certs.length >= 2, `[${certs.length}]`);
  const intermediate = certs.find(c => { const t = c.toString('latin1'); return t.includes('Test Intermediate Root CA') && !t.includes('C2PA Signer'); });
  check('Located the intermediate CA certificate', !!intermediate);
  V.setTrustAnchors([intermediate.toString('base64')]);
  const trusted = await V.verify(raw);
  check('When its CA is trusted, status becomes "valid"', trusted.status === 'valid' && trusted.signer.trusted === true, `[${trusted.status}; by ${trusted.signer.trustedBy}]`);
  V.setTrustAnchors([anchors[0]]);
  check('Unrelated trust anchor does not make it trusted', (await V.verify(raw)).status === 'valid_untrusted');
  V.setTrustAnchors(null); V._anchors = null;

  console.log('--- tampering must be caught ---');
  // 1. change one pixel-data byte near the end of the image
  const pixelTamper = flip(raw, raw.length - 2000);
  let r = await V.verify(pixelTamper);
  check('Edited image data → INVALID (content hash mismatch)', r.status === 'invalid' && r.contentBinding === 'mismatch', `[${r.status}]`);
  check('  signature itself still valid (only content changed)', r.checks.find(x => /Signature is math/.test(x.name)).ok === true);

  // 2. change the claim (title) → signature must fail
  const t = find(raw, 'dc:title'); const titleChar = find(raw, 'CA.jpg', t);
  r = await V.verify(flip(raw, titleChar));
  check('Edited claim text → INVALID (signature fails)', r.status === 'invalid' && r.checks.find(x => /Signature is math/.test(x.name)).ok === false, `[${r.status}]`);

  // 3. change an assertion (action name) → assertion hash must fail
  const a = find(raw, 'c2pa.color_adjustments');
  r = await V.verify(flip(raw, a + 5));
  check('Edited assertion → INVALID (assertion hash mismatch)', r.status === 'invalid' && r.checks.find(x => /Assertion hashes/.test(x.name)).ok === false, `[${r.status}]`);

  // 4. copying the credentials onto a different picture must fail
  const other = new Uint8Array(raw); for (let i = 0; i < 64; i++) other[raw.length - 500 + i] ^= 0xFF;
  check('Credentials copied onto different pixels → INVALID', (await V.verify(other)).status === 'invalid');

  // 5. a signature byte flipped
  const sigAt = find(raw, 'c2pa.signature');
  r = await V.verify(flip(raw, sigAt + 600));
  check('Damaged signature area is never reported as valid', r.status !== 'valid' && r.status !== 'valid_untrusted', `[${r.status}]`);

  console.log('--- MP4 / BMFF ---');
  const mp4 = load('video1.mp4');
  r = await V.verify(mp4);
  check('video1.mp4: credentials found in the MP4 container', r.present && r.container.startsWith('MP4'), `[${r.container}]`);
  check('video1.mp4: box-based content hash MATCHES', r.contentBinding === 'match', `[${r.contentBinding}]`);
  check('video1.mp4: signature + assertions valid', r.checks.find(x => /Signature is math/.test(x.name)).ok === true && r.checks.find(x => /Assertion hashes/.test(x.name)).ok === true);
  check('video1.mp4: status valid_untrusted (test certificate)', r.status === 'valid_untrusted', `[${r.status}]`);
  const mdatAt = find(mp4, 'mdat');
  r = await V.verify(flip(mp4, mdatAt + 4000));
  check('Edited video data → INVALID', r.status === 'invalid' && r.contentBinding === 'mismatch', `[${r.status}]`);
  const moovAt = topBox(mp4, 'moov');
  check('Located the real moov box', moovAt > 0, `[at ${moovAt}]`);
  r = await V.verify(flip(mp4, moovAt + 8 + 12));      // inside the mvhd header (creation time)
  check('Edited video header (moov) → INVALID', r.status === 'invalid' && r.contentBinding === 'mismatch', `[${r.status}]`);
  const ftypAt = topBox(mp4, 'ftyp');
  r = await V.verify(flip(mp4, ftypAt + 8 + 6));       // ftyp brand: excluded from the hash by the C2PA spec
  check('ftyp is excluded by the spec, so changing the brand alone stays valid (documented behaviour)', r.status === 'valid_untrusted', `[${r.status}]`);
  // shifting the file (adding bytes before the content) changes the hashed box offsets
  const shifted = new Uint8Array(mp4.length + 16);
  const ftypEnd = 8 + (new DataView(mp4.buffer, mp4.byteOffset).getUint32(0));
  shifted.set(mp4.subarray(0, ftypEnd - 8), 0);
  const pad = Buffer.alloc(16); pad.writeUInt32BE(16, 0); pad.write('wide', 4);
  const ft = new DataView(mp4.buffer, mp4.byteOffset).getUint32(0);
  shifted.set(mp4.subarray(0, ft), 0); shifted.set(pad, ft); shifted.set(mp4.subarray(ft), ft + 16);
  r = await V.verify(shifted);
  check('Re-arranged boxes (offsets changed) → INVALID', r.status === 'invalid', `[${r.status}]`);
  const mp4Buf = Buffer.from(mp4);
  const oldClaim = mp4Buf.indexOf('c2pa.claim'), newClaim = mp4Buf.lastIndexOf('c2pa.claim');
  check('File carries two signed versions (original + edit)', oldClaim > 0 && newClaim > oldClaim && r !== null, `[claims at ${oldClaim} and ${newClaim}]`);
  const hist = await V.verify(mp4);
  check('History check passes on the genuine file', hist.checks.some(x => /Earlier signed/.test(x.name) && x.ok === true), `[${hist.manifests} manifests]`);
  r = await V.verify(flip(mp4, oldClaim + 40));
  check('Tampered ORIGINAL (earlier) version → INVALID', r.status === 'invalid' && r.checks.find(x => /Earlier signed/.test(x.name)).ok === false, `[${r.status}]`);
  r = await V.verify(flip(mp4, newClaim + 40));
  check('Tampered NEWEST claim → INVALID', r.status === 'invalid', `[${r.status}]`);
  r = await V.verify(load('dashinit.mp4'));
  check('Streaming (fragmented) MP4: signature valid but honestly "partial"', r.status === 'partial' && r.contentBinding === 'unchecked', `[${r.status}]`);
  r = await V.verify(new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D, 0, 0, 2, 0]));
  check('MP4 without credentials → none', r.present === false);

  console.log('--- end to end through the file parser ---');
  const FFprobeParser = require('../public/js/ffprobe-parser.js');
  global.AiDetector = require('../public/js/ai-detector.js'); global.MetaExtras = require('../public/js/metadata-extras.js');
  const parsed = await FFprobeParser.parse({ name: 'CA.jpg', size: raw.length, type: 'image/jpeg' }, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  check('Parser attaches the verification report', parsed.c2pa && parsed.c2pa.status === 'valid_untrusted' && /not on the official C2PA trust list/.test(parsed.c2pa.headline), `[${parsed.c2pa.headline}]`);
  check('AI analysis carries credentials + signer', parsed.ai_analysis.content_credentials.present && parsed.ai_analysis.content_credentials.signer === 'C2PA Signer');
  check('Edited-photo credentials (no AI label) do not flag AI', !parsed.ai_analysis.is_ai, `[${parsed.ai_analysis.label}]`);
  const tamperedParsed = await FFprobeParser.parse({ name: 'CA.jpg', size: raw.length, type: 'image/jpeg' }, pixelTamper.buffer.slice(pixelTamper.byteOffset, pixelTamper.byteOffset + pixelTamper.byteLength));
  check('Tampered file shows FAILED headline end to end', tamperedParsed.c2pa.status === 'invalid' && /FAILED/.test(tamperedParsed.c2pa.headline));

  console.log('--- files without credentials ---');
  r = await V.verify(new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]));
  check('Plain JPEG → no credentials', r.present === false && r.status === 'none');
  r = await V.verify(new Uint8Array(5000).fill(7));
  check('Random bytes → no credentials, no crash', r.present === false);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\n✅ ALL C2PA VERIFICATION TESTS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
