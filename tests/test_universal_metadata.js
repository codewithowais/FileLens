/**
 * Test Universal Metadata Parser & Forensic Inspector
 * Verifies parsing of:
 * - Audio & Video files (MP4, WAV)
 * - Image files (PNG, JPEG synthetic mocks)
 * - Document files (PDF synthetic mock)
 * - Cryptographic SHA-256 forensics & Shannon entropy
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Provide crypto mock if needed
if (!global.crypto) {
  global.crypto = {
    subtle: {
      digest: async (algo, buffer) => {
        const hash = crypto.createHash('sha256');
        hash.update(Buffer.from(buffer));
        return hash.digest().buffer;
      }
    }
  };
}

const FFprobeParser = require('../public/js/ffprobe-parser');
const script = FFprobeParser;

async function runTests() {
  console.log('=== Testing Universal Metadata & Forensic Inspector ===\n');

  // 1. Test WAV
  const wavBuf = fs.readFileSync(path.join(__dirname, '../public/samples/sample_interview_with_noise.wav'));
  const wavArrayBuf = wavBuf.buffer.slice(wavBuf.byteOffset, wavBuf.byteOffset + wavBuf.byteLength);
  const wavMeta = await script.parse({ name: 'interview.wav', size: wavBuf.length }, wavArrayBuf);

  console.log('1. WAV Audio Inspection:');
  console.log(`   Format: ${wavMeta.format.format_name} (${wavMeta.format.format_long_name})`);
  console.log(`   SHA-256: ${wavMeta.forensics.sha256}`);
  console.log(`   Entropy: ${wavMeta.forensics.entropy}`);
  console.log(`   Streams: ${wavMeta.streams.length} (${wavMeta.streams[0].codec_type})`);
  console.log(`   Chunks in Tree: ${wavMeta.container_tree.length}`);
  if (wavMeta.streams[0].codec_type !== 'audio') throw new Error('WAV should have audio stream');
  if (!wavMeta.forensics.sha256 || wavMeta.forensics.sha256.length !== 64) throw new Error('Missing or invalid SHA-256 hash');
  console.log('   ✅ WAV parsed successfully!\n');

  // 2. Test MP4 Video
  const mp4Buf = fs.readFileSync(path.join(__dirname, '../public/samples/sample_video_with_noise.mp4'));
  const mp4ArrayBuf = mp4Buf.buffer.slice(mp4Buf.byteOffset, mp4Buf.byteOffset + mp4Buf.byteLength);
  const mp4Meta = await script.parse({ name: 'interview.mp4', size: mp4Buf.length }, mp4ArrayBuf);

  console.log('2. MP4 Video Inspection:');
  console.log(`   Format: ${mp4Meta.format.format_name}`);
  console.log(`   SHA-256: ${mp4Meta.forensics.sha256}`);
  console.log(`   Atoms in Tree: ${mp4Meta.container_tree.length}`);
  console.log(`   Streams: ${mp4Meta.streams.length}`);
  mp4Meta.streams.forEach(s => {
    console.log(`     Stream #${s.index} [${s.codec_type}]: ${s.codec_name} ${s.width ? `${s.width}x${s.height}` : `${s.sample_rate}Hz`}`);
  });
  if (!mp4Meta.streams.some(s => s.codec_type === 'audio')) throw new Error('MP4 should have audio stream');
  console.log('   ✅ MP4 parsed successfully!\n');

  // 3. Test Synthetic PNG Image
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, // IHDR length 13
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x07, 0x80, // width: 1920
    0x00, 0x00, 0x04, 0x38, // height: 1080
    0x08, // 8-bit depth
    0x02, // RGB color
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00  // CRC
  ]);
  const pngArrayBuf = pngHeader.buffer.slice(pngHeader.byteOffset, pngHeader.byteOffset + pngHeader.byteLength);
  const pngMeta = await script.parse({ name: 'snapshot.png', size: pngHeader.length }, pngArrayBuf);

  console.log('3. PNG Image Inspection:');
  console.log(`   Format: ${pngMeta.format.format_name} (${pngMeta.format.format_long_name})`);
  console.log(`   Resolution: ${pngMeta.streams[0].width} x ${pngMeta.streams[0].height}`);
  console.log(`   Bit Depth: ${pngMeta.streams[0].bits_per_sample}-bit`);
  console.log(`   MIME: ${pngMeta.forensics.mime_detected}`);
  if (pngMeta.streams[0].width !== 1920 || pngMeta.streams[0].height !== 1080) throw new Error('PNG resolution mismatch');
  console.log('   ✅ PNG parsed successfully!\n');

  // 4. Test Synthetic PDF Document
  const pdfString = "%PDF-1.7\n1 0 obj\n<< /Title (Confidential Audio Report) /Author (FileLens) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF";
  const pdfBuf = Buffer.from(pdfString, 'utf8');
  const pdfArrayBuf = pdfBuf.buffer.slice(pdfBuf.byteOffset, pdfBuf.byteOffset + pdfBuf.byteLength);
  const pdfMeta = await script.parse({ name: 'report.pdf', size: pdfBuf.length }, pdfArrayBuf);

  console.log('4. PDF Document Inspection:');
  console.log(`   Format: ${pdfMeta.format.format_name} (${pdfMeta.format.format_long_name})`);
  console.log(`   PDF Version: ${pdfMeta.format.tags.pdf_version}`);
  console.log(`   Tags: Title = "${pdfMeta.format.tags.Title}", Author = "${pdfMeta.format.tags.Author}"`);
  console.log(`   MIME: ${pdfMeta.forensics.mime_detected}`);
  if (pdfMeta.format.tags.pdf_version !== '1.7') throw new Error('PDF version mismatch');
  if (pdfMeta.format.tags.Title !== 'Confidential Audio Report') throw new Error('PDF title mismatch');
  console.log('   ✅ PDF parsed successfully!\n');

  // 5. Test Tamper & Edit History (Photoshop XMP JPEG Mock)
  const xmpMockString = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"><xmp:CreateDate>2021-06-15T10:30:00+05:00</xmp:CreateDate><xmp:ModifyDate>2024-03-22T18:45:10+05:00</xmp:ModifyDate><xmpMM:History><rdf:Seq><rdf:li stEvt:action="created" stEvt:when="2021-06-15T10:30:00+05:00" stEvt:softwareAgent="Apple iPhone 12 Pro"/><rdf:li stEvt:action="saved" stEvt:when="2024-03-22T18:45:10+05:00" stEvt:softwareAgent="Adobe Photoshop 25.1" stEvt:changed="/"/></rdf:Seq></xmpMM:History></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const xmpPayload = Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "utf8"),
    Buffer.from(xmpMockString, "utf8")
  ]);
  const app1Len = xmpPayload.length + 2;
  const jpegMock = Buffer.concat([
    Buffer.from([0xFF, 0xD8]), // SOI
    Buffer.from([0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF]), // APP1 marker + len
    xmpPayload,
    Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]), // SOF0 (1920x1080)
    Buffer.from([0xFF, 0xD9]) // EOI
  ]);
  const jpegArrayBuf = jpegMock.buffer.slice(jpegMock.byteOffset, jpegMock.byteOffset + jpegMock.byteLength);
  const jpegMeta = await script.parse({ name: 'edited_evidence.jpg', size: jpegMock.length }, jpegArrayBuf);

  console.log('5. Tamper & Edit History Inspection (Photoshop XMP):');
  console.log(`   Verdict: ${jpegMeta.tamper_analysis.verdict_label} (${jpegMeta.tamper_analysis.verdict})`);
  console.log(`   Pehlay Ka Data: Created on ${jpegMeta.tamper_analysis.original_data.created_at} by ${jpegMeta.tamper_analysis.original_data.device_or_camera}`);
  console.log(`   Modify Data: Altered on ${jpegMeta.tamper_analysis.modified_data.modified_at} using ${jpegMeta.tamper_analysis.modified_data.modifying_software}`);
  console.log(`   Time Elapsed: ${jpegMeta.tamper_analysis.modified_data.time_elapsed}`);
  console.log(`   Audit Steps: ${jpegMeta.tamper_analysis.audit_trail.length} recorded events`);
  if (jpegMeta.tamper_analysis.verdict !== 'TAMPERED') throw new Error('Expected TAMPERED verdict');
  if (jpegMeta.tamper_analysis.audit_trail.length !== 2) throw new Error('Expected 2 audit steps');
  console.log('   ✅ Tamper & Edit History verified successfully!\n');

  // 6. Test AI-Generated Image Mock (PNG with prompt parameters)
  const aiPromptText = "parameters\0ultra photorealistic portrait of an old astronaut, cinematic lighting, 8k\nSteps: 25, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 39182910";
  const aiChunkBuf = Buffer.from(aiPromptText, 'latin1');
  const aiPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // Signature
    Buffer.from([0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x00, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // IHDR (1024x1024)
    Buffer.from([(aiChunkBuf.length >> 24) & 0xFF, (aiChunkBuf.length >> 16) & 0xFF, (aiChunkBuf.length >> 8) & 0xFF, aiChunkBuf.length & 0xFF]),
    Buffer.from("tEXt", "utf8"),
    aiChunkBuf,
    Buffer.from([0x00, 0x00, 0x00, 0x00]) // CRC
  ]);
  const aiPngArrayBuf = aiPng.buffer.slice(aiPng.byteOffset, aiPng.byteOffset + aiPng.byteLength);
  const aiPngMeta = await script.parse({ name: 'ai_character.png', size: aiPng.length }, aiPngArrayBuf);

  console.log('6. AI-Generated Image Inspection (Embedded Prompts):');
  console.log(`   Verdict: ${aiPngMeta.tamper_analysis.verdict_label} (${aiPngMeta.tamper_analysis.verdict})`);
  console.log(`   Is AI: ${aiPngMeta.tamper_analysis.ai_detection.is_ai}`);
  console.log(`   Recovered Prompt: "${aiPngMeta.tamper_analysis.ai_detection.prompt.slice(0, 50)}..."`);
  if (!aiPngMeta.tamper_analysis.ai_detection.is_ai) throw new Error('Expected AI detection true');
  if (aiPngMeta.tamper_analysis.verdict !== 'AI_GENERATED') throw new Error('Expected AI_GENERATED verdict');
  console.log('   ✅ AI Generation footprint verified successfully!\n');

  // 7. Test Device & Recording Hardware Detection
  console.log('7. Device & Hardware Origin Detection:');

  // 7A: Apple iPhone 14 Pro Detection (Model ID expansion & Lens Model)
  const iphoneXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/"><tiff:Make>Apple</tiff:Make><tiff:Model>iPhone15,2</tiff:Model><exif:LensModel>iPhone 14 Pro back triple camera 6.86mm f/1.78</exif:LensModel><exif:BodySerialNumber>DNPK8912P7</exif:BodySerialNumber></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const iphonePayload = Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "utf8"),
    Buffer.from(iphoneXmp, "utf8")
  ]);
  const iphoneApp1Len = iphonePayload.length + 2;
  const iphoneJpeg = Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    Buffer.from([0xFF, 0xE1, (iphoneApp1Len >> 8) & 0xFF, iphoneApp1Len & 0xFF]),
    iphonePayload,
    Buffer.from([0xFF, 0xD9])
  ]);
  const iphoneMeta = await script.parse({ name: 'iphone_photo.jpg', size: iphoneJpeg.length }, iphoneJpeg.buffer.slice(iphoneJpeg.byteOffset, iphoneJpeg.byteOffset + iphoneJpeg.byteLength));
  console.log(`   [iPhone] Device: ${iphoneMeta.device_info.device_name} (${iphoneMeta.device_info.hardware_type})`);
  console.log(`   [iPhone] Lens: ${iphoneMeta.device_info.lens}, SN: ${iphoneMeta.device_info.serial}`);
  if (iphoneMeta.device_info.device_name !== 'Apple iPhone 14 Pro') throw new Error(`Expected Apple iPhone 14 Pro, got ${iphoneMeta.device_info.device_name}`);
  if (iphoneMeta.device_info.hardware_type !== 'Smartphone Camera & Audio') throw new Error('Expected Smartphone Camera & Audio');
  if (iphoneMeta.device_info.lens !== 'iPhone 14 Pro back triple camera 6.86mm f/1.78') throw new Error('Lens mismatch');

  // 7B: Sony Alpha 7 IV Camera Detection
  const sonyXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"><tiff:Make>SONY</tiff:Make><tiff:Model>ILCE-7M4</tiff:Model></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const sonyPayload = Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "utf8"),
    Buffer.from(sonyXmp, "utf8")
  ]);
  const sonyApp1Len = sonyPayload.length + 2;
  const sonyJpeg = Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    Buffer.from([0xFF, 0xE1, (sonyApp1Len >> 8) & 0xFF, sonyApp1Len & 0xFF]),
    sonyPayload,
    Buffer.from([0xFF, 0xD9])
  ]);
  const sonyMeta = await script.parse({ name: 'sony_raw.jpg', size: sonyJpeg.length }, sonyJpeg.buffer.slice(sonyJpeg.byteOffset, sonyJpeg.byteOffset + sonyJpeg.byteLength));
  console.log(`   [Sony] Device: ${sonyMeta.device_info.device_name} (${sonyMeta.device_info.hardware_type})`);
  if (!sonyMeta.device_info.device_name.includes('Sony Alpha 7 IV')) throw new Error(`Expected Sony Alpha 7 IV, got ${sonyMeta.device_info.device_name}`);
  if (sonyMeta.device_info.hardware_type !== 'Mirrorless Camera') throw new Error('Expected Mirrorless Camera');

  // 7C: Broadcast Wave Studio Recorder Detection
  const bextOriginator = "Zoom H6 Handy Recorder\0";
  const bextBuf = Buffer.alloc(256 + 32 + 10 + 8);
  bextBuf.write("Zoom H6 Handy Recorder", 256, "ascii");
  const bextChunkLen = bextBuf.length;
  const wavWithBext = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // Size
    Buffer.from("WAVE", "ascii"),
    Buffer.from("fmt ", "ascii"),
    Buffer.from([16, 0, 0, 0, 1, 0, 2, 0, 0x44, 0xAC, 0, 0, 0x10, 0xB1, 2, 0, 4, 0, 16, 0]),
    Buffer.from("bext", "ascii"),
    Buffer.from([bextChunkLen & 0xFF, (bextChunkLen >> 8) & 0xFF, (bextChunkLen >> 16) & 0xFF, (bextChunkLen >> 24) & 0xFF]),
    bextBuf,
    Buffer.from("data", "ascii"),
    Buffer.from([0, 0, 0, 0])
  ]);
  const bextMeta = await script.parse({ name: 'field_recording.wav', size: wavWithBext.length }, wavWithBext.buffer.slice(wavWithBext.byteOffset, wavWithBext.byteOffset + wavWithBext.byteLength));
  console.log(`   [BWF WAV] Device: ${bextMeta.device_info.device_name} (${bextMeta.device_info.hardware_type})`);
  if (!bextMeta.device_info.device_name.includes('Zoom H6')) throw new Error('Expected Zoom H6 Handy Recorder');

  // 7D: Apple Core Media signature — only reported when the file really contains it
  const appleBuf = fs.readFileSync("samples/sample_video_with_noise.mp4");
  const appleMeta = await script.parse({ name: "sample_video_with_noise.mp4", size: appleBuf.length }, appleBuf.buffer.slice(appleBuf.byteOffset, appleBuf.byteOffset + appleBuf.byteLength));
  console.log(`   [Core Media] Device: ${appleMeta.device_info.device_name} (${appleMeta.device_info.hardware_type})`);
  if (!appleMeta.device_info.device_name.includes('Apple')) throw new Error('Expected Apple Core Media signature from the real handler name');
  if (/lavf/i.test(JSON.stringify(appleMeta.all_tags))) throw new Error('No encoder may be invented');

  const plainBuf = fs.readFileSync("samples/sample_interview_with_noise.m4a");
  const plainMeta = await script.parse({ name: "sample_interview_with_noise.m4a", size: plainBuf.length }, plainBuf.buffer.slice(plainBuf.byteOffset, plainBuf.byteOffset + plainBuf.byteLength));
  console.log(`   [No signature] Device: ${plainMeta.device_info.device_name}`);
  if (plainMeta.device_info.device_name.includes('Apple')) throw new Error('An M4A with no Apple marker must not be called Apple');

  // 7E: Untagged / Social Media Stripped Fallback
  const emptyBuf = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const emptyMeta = await script.parse({ name: "unknown.bin", size: 8 }, emptyBuf.buffer.slice(emptyBuf.byteOffset, emptyBuf.byteOffset + emptyBuf.byteLength));
  console.log(`   [Untagged] Device: ${emptyMeta.device_info.device_name} (${emptyMeta.device_info.hardware_type})`);
  if (!emptyMeta.device_info.device_name.includes('Device Not Tagged')) throw new Error('Expected Device Not Tagged message');

  console.log('   ✅ Device & Hardware Origin detection verified across all formats!\n');

  console.log('====================================================');
  console.log(' ALL UNIVERSAL METADATA & FORENSIC TESTS PASSED! 🚀');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
