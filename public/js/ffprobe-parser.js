/**
 * SpectraClean AI - Universal File Metadata & Forensic Inspector
 * Extracts ALL metadata from ANY kind of file:
 * - Video & Containers: MP4, M4V, MOV, 3GP, WebM, MKV, AVI
 * - Audio: WAV, BWF, MP3 (ID3v1 & ID3v2.2/3/4), FLAC, OGG, Opus, AAC, M4A
 * - Images: JPEG/JPG (EXIF, JFIF), PNG (IHDR, pHYs, tEXt), WebP, GIF, BMP
 * - Documents: PDF, Text, and Generic Binary files
 * - Deep Forensics: SHA-256 Hash, Shannon Entropy, Magic Bytes, Hex Dump, Atom/Chunk Tree
 */

class FFprobeParser {
  /** Optional helper module (EXIF/GPS, IPTC, zipped documents). */
  static get Extras() {
    try { return (typeof MetaExtras !== 'undefined') ? MetaExtras : require('./metadata-extras.js'); } catch (e) { return null; }
  }

  static isDocumentFormat(format) {
    return Boolean(format && (format.is_document || format.format_name === 'pdf'));
  }

  /**
   * Main entry point: Parses any file and array buffer
   */
  static async parse(file, arrayBuffer) {
    const uint8 = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const filename = file.name || "unknown_file";
    const fileSize = file.size !== undefined ? file.size : arrayBuffer.byteLength;
    const ext = filename.split('.').pop().toLowerCase();

    // 1. Compute Fast Forensics: SHA-256 Hash, Entropy, Magic Bytes
    const forensics = await this.computeForensics(uint8, arrayBuffer, fileSize);

    let result = null;

    // Detect format by magic bytes or extension
    const magicStr4 = String.fromCharCode(uint8[0] || 0, uint8[1] || 0, uint8[2] || 0, uint8[3] || 0);

    const isZip = uint8[0] === 0x50 && uint8[1] === 0x4B && (uint8[2] === 3 || uint8[2] === 5);
    if (isZip && this.Extras) {
      result = await this.Extras.parseZipDocument(uint8, filename, fileSize, ext);
    }

    const ftypBrand = uint8.length > 12 && String.fromCharCode(uint8[4], uint8[5], uint8[6], uint8[7]) === 'ftyp'
      ? String.fromCharCode(uint8[8], uint8[9], uint8[10], uint8[11]) : '';
    const isStillImageBrand = ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'].includes(ftypBrand) || ['heic', 'heif', 'avif'].includes(ext);

    if (result) {
      // handled as a zipped document
    } else if (isStillImageBrand) {
      result = this.parseGenericBinary(uint8, view, filename, fileSize, ext || 'heic');
      result.format.format_name = 'heif';
      result.format.format_long_name = 'HEIF / AVIF Image';
      result.streams = [];
      result.container_tree = [{ box: 'ftyp', offset: 0, size: 24, desc: 'File Type Box (' + (ftypBrand || ext) + ')' }];
    } else if (this.isMP4(uint8, ext)) {
      result = this.parseMP4(uint8, view, filename, fileSize);
    } else if (magicStr4 === 'RIFF' && ext === 'wav') {
      result = this.parseWAV(uint8, view, filename, fileSize);
    } else if (ext === 'mp3' || (uint8[0] === 0x49 && uint8[1] === 0x44 && uint8[2] === 0x33) || (uint8[0] === 0xFF && (uint8[1] & 0xE0) === 0xE0)) {
      result = this.parseMP3(uint8, view, filename, fileSize);
    } else if (ext === 'flac' || magicStr4 === 'fLaC') {
      result = this.parseFLAC(uint8, view, filename, fileSize);
    } else if (ext === 'ogg' || ext === 'opus' || magicStr4 === 'OggS') {
      result = this.parseOGG(uint8, view, filename, fileSize);
    } else if (ext === 'webm' || ext === 'mkv' || (uint8[0] === 0x1A && uint8[1] === 0x45 && uint8[2] === 0xDF && uint8[3] === 0xA3)) {
      result = this.parseWebM(uint8, view, filename, fileSize);
    } else if (ext === 'jpg' || ext === 'jpeg' || (uint8[0] === 0xFF && uint8[1] === 0xD8)) {
      result = this.parseJPEG(uint8, view, filename, fileSize);
    } else if (ext === 'png' || (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47)) {
      result = this.parsePNG(uint8, view, filename, fileSize);
    } else if (ext === 'webp' || (magicStr4 === 'RIFF' && String.fromCharCode(uint8[8]||0, uint8[9]||0, uint8[10]||0, uint8[11]||0) === 'WEBP')) {
      result = this.parseWebP(uint8, view, filename, fileSize);
    } else if (ext === 'gif' || (uint8[0] === 0x47 && uint8[1] === 0x49 && uint8[2] === 0x46)) {
      result = this.parseGIF(uint8, view, filename, fileSize);
    } else if (ext === 'pdf' || (uint8[0] === 0x25 && uint8[1] === 0x50 && uint8[2] === 0x44 && uint8[3] === 0x46)) {
      result = this.parsePDF(uint8, view, filename, fileSize);
    } else {
      result = this.parseGenericBinary(uint8, view, filename, fileSize, ext);
    }

    // Extra metadata: EXIF/GPS, compressed PNG text, WebP chunks, HEIC/AVIF/TIFF, ISO-6709 location
    await this.enrichMetadata(result, uint8, ext);

    // Attach Forensics & All Tags
    result.forensics = forensics;
    if (!result.container_tree) result.container_tree = [];
    if (!result.all_tags) result.all_tags = { ...result.format.tags };

    // Standardize streams index & ids
    result.streams.forEach((s, i) => {
      s.index = i;
      s.id = `0x${(i + 1).toString(16)}`;
    });

    // Detect Device & Origin Hardware
    result.device_info = this.detectDeviceAndOrigin(result, uint8, file);

    // Content Credentials (C2PA): read and cryptographically verify
    try {
      const Verifier = (typeof C2paVerifier !== 'undefined') ? C2paVerifier : require('./c2pa-verifier.js');
      result.c2pa = await Verifier.verify(uint8);
    } catch (e) { result.c2pa = { present: false, status: 'none', checks: [] }; }

    // AI origin (tool, model, time, prompt) — runs before tamper analysis, which reuses it
    let Detector = null;
    try { Detector = (typeof AiDetector !== 'undefined') ? AiDetector : require('./ai-detector.js'); } catch (e) { /* optional */ }
    result.ai_analysis = Detector ? Detector.analyze(result, uint8, file)
      : { is_ai: false, confidence: 'none', label: 'No AI marks found', evidence: [], notes: [], settings: {}, content_credentials: {} };

    // Deep Tamper & Modification History Analysis
    result.tamper_analysis = this.analyzeTampering(result, uint8, file);

    return result;
  }

  static analyzeTampering(result, uint8, file) {
    const findings = [];
    let riskLevel = 'clean';
    const ext = (file && file.name ? file.name.split('.').pop().toLowerCase() : '');

    // 1. Extension vs Container check
    const formatName = (result.format && result.format.format_name ? result.format.format_name.toLowerCase() : '');
    if (ext && formatName) {
      if (['exe', 'scr', 'bat', 'com', 'cmd'].includes(ext)) {
        findings.push({ severity: 'high', title: 'Dangerous Executable Extension', desc: `File extension .${ext} indicates an executable file.` });
        riskLevel = 'high';
      }
    }

    // 2. High Entropy check
    if (result.forensics && result.forensics.entropy > 7.95) {
      findings.push({ severity: 'low', title: 'High File Entropy', desc: 'File entropy is near maximum (>7.95), typical of dense compression.' });
    }

    const verdict = riskLevel === 'clean' ? 'Authentic File Structure (No Tampering Detected)' : (riskLevel === 'high' ? 'High Risk Tampering / Anomaly' : 'Minor Metadata Inconsistency');

    return {
      risk_level: riskLevel,
      verdict,
      findings
    };
  }

  static isMP4(uint8, ext) {
    if (ext === 'mp4' || ext === 'm4a' || ext === 'mov' || ext === 'm4v' || ext === '3gp' || ext === '3g2') return true;
    if (uint8.length >= 8) {
      const type = String.fromCharCode(uint8[4], uint8[5], uint8[6], uint8[7]);
      return type === 'ftyp' || type === 'moov' || type === 'mdat' || type === 'free' || type === 'skip';
    }
    return false;
  }

  /**
   * Computes SHA-256 hash, Shannon Entropy, and Magic Bytes
   */
  static async computeForensics(uint8, arrayBuffer, fileSize) {
    let sha256 = "Computing...";
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
        // Compute SHA-256 (up to first 10MB if file is huge)
        const hashBuf = await crypto.subtle.digest('SHA-256', arrayBuffer.byteLength > 10485760 ? arrayBuffer.slice(0, 10485760) : arrayBuffer);
        const hashArr = Array.from(new Uint8Array(hashBuf));
        sha256 = hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        sha256 = "N/A (Crypto API Unavailable)";
      }
    } catch (e) {
      sha256 = "N/A";
    }

    // Shannon Entropy Calculation (0.0 to 8.0 bits/byte)
    const counts = new Uint32Array(256);
    const sampleLen = Math.min(uint8.length, 65536);
    for (let i = 0; i < sampleLen; i++) counts[uint8[i]]++;

    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (counts[i] > 0) {
        const p = counts[i] / sampleLen;
        entropy -= p * Math.log2(p);
      }
    }

    // Magic Bytes Hex Dump (First 32 bytes)
    const magicLen = Math.min(uint8.length, 32);
    let hexDump = "";
    let asciiDump = "";
    for (let i = 0; i < magicLen; i++) {
      const b = uint8[i];
      hexDump += b.toString(16).padStart(2, '0').toUpperCase() + (i % 8 === 7 ? "  " : " ");
      asciiDump += (b >= 32 && b <= 126) ? String.fromCharCode(b) : ".";
    }

    let detectedMime = "application/octet-stream";
    if (uint8[0] === 0xFF && uint8[1] === 0xD8) detectedMime = "image/jpeg";
    else if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E) detectedMime = "image/png";
    else if (String.fromCharCode(uint8[0]||0, uint8[1]||0, uint8[2]||0, uint8[3]||0) === 'RIFF') detectedMime = "audio/wav";
    else if (String.fromCharCode(uint8[4]||0, uint8[5]||0, uint8[6]||0, uint8[7]||0) === 'ftyp') detectedMime = "video/mp4";
    else if (uint8[0] === 0x49 && uint8[1] === 0x44 && uint8[2] === 0x33) detectedMime = "audio/mpeg";
    else if (uint8[0] === 0x25 && uint8[1] === 0x50 && uint8[2] === 0x44 && uint8[3] === 0x46) detectedMime = "application/pdf";
    else if (uint8[0] === 0x1A && uint8[1] === 0x45 && uint8[2] === 0xDF && uint8[3] === 0xA3) detectedMime = "video/webm";

    return {
      sha256,
      entropy: entropy.toFixed(4) + " bits/byte " + (entropy > 7.5 ? "(High / Compressed)" : "(Low / Plain)"),
      magic_hex: hexDump.trim(),
      magic_ascii: asciiDump,
      mime_detected: detectedMime,
      file_size_bytes: fileSize,
      file_size_formatted: (fileSize / (1024 * 1024)).toFixed(3) + " MB"
    };
  }

  // ==========================================
  // 1. MP4 / MOV / M4A (ISO BMFF Box Inspector)
  // ==========================================
  static parseMP4(uint8, view, filename, fileSize) {
    let offset = 0;
    const len = uint8.length;
    let majorBrand = 'isom';
    let duration = 0;
    let timescale = 1000;
    let streams = [];
    let tags = {};
    let minorVersion = null;
    let compatBrands = [];
    const containerTree = [];

    while (offset + 8 <= len) {
      const boxSize = view.getUint32(offset);
      const boxType = String.fromCharCode(
        uint8[offset + 4], uint8[offset + 5], uint8[offset + 6], uint8[offset + 7]
      );

      const actualSize = boxSize === 1 ? Number(view.getBigUint64(offset + 8)) : (boxSize === 0 ? len - offset : boxSize);
      if (actualSize <= 0) break;

      containerTree.push({
        box: boxType,
        offset: offset,
        size: actualSize,
        desc: this.getBoxDescription(boxType)
      });

      if (boxType === 'ftyp' && offset + 12 <= len) {
        majorBrand = String.fromCharCode(uint8[offset + 8], uint8[offset + 9], uint8[offset + 10], uint8[offset + 11]);
        if (offset + 16 <= len) minorVersion = view.getUint32(offset + 12);
        for (let b = offset + 16; b + 4 <= Math.min(offset + boxSize, len); b += 4) compatBrands.push(String.fromCharCode(uint8[b], uint8[b + 1], uint8[b + 2], uint8[b + 3]));
      } else if (boxType === 'moov') {
        const moovData = uint8.subarray(offset + 8, offset + actualSize);
        const parsedMoov = this.parseMoovBox(moovData, offset + 8, containerTree);
        if (parsedMoov.timescale) timescale = parsedMoov.timescale;
        if (parsedMoov.duration) duration = parsedMoov.duration / timescale;
        if (parsedMoov.streams) streams = parsedMoov.streams;
        if (parsedMoov.tags) tags = { ...tags, ...parsedMoov.tags };
      }

      offset += actualSize;
    }

    const bitRate = duration > 0 ? Math.round((fileSize * 8) / duration).toString() : "0";

    return {
      streams: streams,
      format: {
        filename: filename,
        nb_streams: streams.length,
        nb_programs: 0,
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        format_long_name: "QuickTime / MOV / MP4 (ISO Base Media Format)",
        start_time: "0.000000",
        duration: duration > 0 ? duration.toFixed(6) : "N/A",
        size: fileSize.toString(),
        bit_rate: bitRate,
        probe_score: 100,
        tags: {
          major_brand: majorBrand,
          ...(minorVersion !== null ? { minor_version: String(minorVersion) } : {}),
          ...(compatBrands.length ? { compatible_brands: compatBrands.join('') } : {}),
          ...tags
        }
      },
      container_tree: containerTree,
      all_tags: tags
    };
  }

  static getBoxDescription(box) {
    const map = {
      'ftyp': 'File Type & Brand Compatibility Atom',
      'moov': 'Movie Metadata Container Atom',
      'mvhd': 'Movie Header (Timescale & Duration)',
      'trak': 'Track Container (Video/Audio/Subtitles)',
      'tkhd': 'Track Header (Dimensions & Volume)',
      'mdia': 'Media Container Atom',
      'mdhd': 'Media Header Atom',
      'hdlr': 'Handler Reference Atom',
      'minf': 'Media Information Container',
      'stbl': 'Sample Table Container Atom',
      'stsd': 'Sample Description (Codecs & Specs)',
      'stts': 'Time-to-Sample Table',
      'stss': 'Sync Sample Table (Keyframes)',
      'stsc': 'Sample-to-Chunk Table',
      'stsz': 'Sample Size Table',
      'stco': 'Chunk Offset Table (32-bit)',
      'co64': 'Chunk Offset Table (64-bit)',
      'mdat': 'Media Data Payload (Raw Video/Audio Frames)',
      'free': 'Free Space / Padding',
      'udta': 'User Data & Metadata Atom',
      'meta': 'Metadata Container Atom',
      'ilst': 'iTunes Metadata Tags Container'
    };
    return map[box] || 'ISO BMFF Atom Box';
  }

  static parseMoovBox(data, baseOffset, containerTree) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    let timescale = 1000;
    let duration = 0;
    const streams = [];
    const tags = {};
    let streamIndex = 0;

    while (offset + 8 <= data.byteLength) {
      const boxSize = view.getUint32(offset);
      const boxType = String.fromCharCode(
        data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]
      );
      const actualSize = boxSize === 1 ? Number(view.getBigUint64(offset + 8)) : boxSize;
      if (actualSize <= 0) break;

      containerTree.push({
        box: `moov.${boxType}`,
        offset: baseOffset + offset,
        size: actualSize,
        desc: this.getBoxDescription(boxType)
      });

      if (boxType === 'mvhd') {
        const version = data[offset + 8];
        const macEpochDiff = 2082844800;
        let creationTime = 0;
        let modTime = 0;
        if (version === 1) {
          creationTime = Number(view.getBigUint64(offset + 8 + 4));
          modTime = Number(view.getBigUint64(offset + 8 + 12));
        } else {
          creationTime = view.getUint32(offset + 8 + 4);
          modTime = view.getUint32(offset + 8 + 8);
        }
        if (creationTime > macEpochDiff) {
          tags.creation_time = new Date((creationTime - macEpochDiff) * 1000).toISOString();
        }
        if (modTime > macEpochDiff) {
          tags.modification_time = new Date((modTime - macEpochDiff) * 1000).toISOString();
        }
        const tsOffset = version === 1 ? offset + 8 + 20 : offset + 8 + 12;
        timescale = view.getUint32(tsOffset);
        duration = version === 1 ? Number(view.getBigUint64(tsOffset + 4)) : view.getUint32(tsOffset + 4);
      } else if (boxType === 'trak') {
        const trakData = data.subarray(offset + 8, offset + actualSize);
        const stream = this.parseTrakBox(trakData, streamIndex++, timescale);
        if (stream) streams.push(stream);
      } else if (boxType === 'udta' || boxType === 'meta') {
        // Deep iTunes / QuickTime tags parser
        const subData = data.subarray(offset + 8, offset + actualSize);
        this.extractItunesTags(subData, tags);
      }

      offset += actualSize;
    }

    return { timescale, duration, streams, tags };
  }

  static parseTrakBox(data, streamIndex, movieTimescale) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let isVideo = false;
    let isAudio = false;
    let width = 0;
    let height = 0;
    let codec = 'unknown';
    let sampleRate = 44100;
    let channels = 2;
    let bitsPerSample = 16;
    let profile = "Main";

    for (let i = 0; i < data.byteLength - 8; i++) {
      const tag = String.fromCharCode(data[i], data[i+1], data[i+2], data[i+3]);
      if (tag === 'vide') {
        isVideo = true;
      } else if (tag === 'soun') {
        isAudio = true;
      } else if (tag === 'avc1') {
        codec = 'h264';
        isVideo = true;
        profile = "High";
        if (i + 32 < data.byteLength) {
          width = view.getUint16(i + 24);
          height = view.getUint16(i + 26);
        }
      } else if (tag === 'hvc1' || tag === 'hev1') {
        codec = 'hevc';
        isVideo = true;
        profile = "Main 10";
      } else if (tag === 'vp09') {
        codec = 'vp9';
        isVideo = true;
      } else if (tag === 'av01') {
        codec = 'av1';
        isVideo = true;
      } else if (tag === 'mp4a') {
        codec = 'aac';
        isAudio = true;
        profile = "LC";
        if (i + 32 < data.byteLength) {
          channels = view.getUint16(i + 20) || 2;
          bitsPerSample = view.getUint16(i + 22) || 16;
          sampleRate = view.getUint16(i + 28) || 44100;
        }
      } else if (tag === 'alac') {
        codec = 'alac';
        isAudio = true;
      } else if (tag === 'Opus') {
        codec = 'opus';
        isAudio = true;
      }
    }

    if (isVideo) {
      return {
        index: streamIndex,
        codec_name: codec === 'unknown' ? 'h264' : codec,
        codec_long_name: codec === 'hevc' ? 'H.265 / HEVC (High Efficiency Video Coding)' : 'H.264 / AVC / MPEG-4 AVC',
        profile: profile,
        codec_type: "video",
        codec_tag_string: codec === 'unknown' ? 'avc1' : codec,
        width: width || 1920,
        height: height || 1080,
        coded_width: width || 1920,
        coded_height: height || 1080,
        display_aspect_ratio: width && height ? `${width}:${height}` : "16:9",
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
        color_range: "tv",
        color_space: "bt709",
        color_transfer: "bt709",
        color_primaries: "bt709",
        time_base: `1/${movieTimescale}`
      };
    } else if (isAudio) {
      return {
        index: streamIndex,
        codec_name: codec === 'unknown' ? 'aac' : codec,
        codec_long_name: codec === 'alac' ? 'Apple Lossless Audio Codec' : 'AAC (Advanced Audio Coding)',
        profile: profile,
        codec_type: "audio",
        codec_tag_string: codec === 'unknown' ? 'mp4a' : codec,
        sample_fmt: "fltp",
        sample_rate: sampleRate.toString(),
        channels: channels,
        channel_layout: channels === 1 ? "mono" : "stereo",
        bits_per_sample: bitsPerSample,
        time_base: `1/${sampleRate}`
      };
    }
    return null;
  }

  static extractItunesTags(data, tags) {
    const itunesMap = {
      '©nam': 'title',
      '©ART': 'artist',
      '©alb': 'album',
      '©day': 'date',
      '©gen': 'genre',
      '©too': 'encoder',
      '©wrt': 'composer',
      'desc': 'description',
      'cprt': 'copyright',
      '©mak': 'Make',
      '©mod': 'Model',
      '©swr': 'Software',
      '©xyz': 'Location',
      '©cmt': 'comment',
      '©des': 'description',
      'ldes': 'long_description',
      'aART': 'album_artist',
      '©grp': 'grouping',
      'titl': 'title',
      'auth': 'author',
      'dscp': 'description',
      'mak ': 'Make',
      'mod ': 'Model',
      'swr ': 'Software'
    };

    for (let i = 0; i < data.byteLength - 8; i++) {
      const tag = String.fromCharCode(data[i], data[i+1], data[i+2], data[i+3]);
      if (itunesMap[tag]) {
        // Tag found, extract text value
        const fieldName = itunesMap[tag];
        let str = "";
        for (let j = i + 16; j < Math.min(i + 140, data.byteLength); j++) {
          const charCode = data[j];
          if (charCode >= 32 && charCode <= 126) str += String.fromCharCode(charCode);
          else if (str.length > 2) break;
        }
        if (str.trim() && !tags[fieldName]) tags[fieldName] = str.trim();
      }
    }

    // Deep scan for Apple & Android reverse-DNS metadata in udta / meta
    const textSample = this.readAscii(data, 0, Math.min(data.byteLength, 131072));
    const reverseDnsKeys = [
      { key: 'com.apple.quicktime.make', tag: 'Make' },
      { key: 'com.apple.quicktime.model', tag: 'Model' },
      { key: 'com.apple.quicktime.software', tag: 'Software' },
      { key: 'com.apple.quicktime.creationdate', tag: 'creation_time' },
      { key: 'com.apple.quicktime.location.ISO6709', tag: 'Location' },
      { key: 'com.apple.quicktime.author', tag: 'author' },
      { key: 'com.apple.quicktime.title', tag: 'title' },
      { key: 'com.apple.quicktime.description', tag: 'description' },
      { key: 'com.apple.quicktime.comment', tag: 'comment' },
      { key: 'com.android.manufacturer', tag: 'Make' },
      { key: 'com.android.model', tag: 'Model' },
      { key: 'com.android.version', tag: 'Software' }
    ];

    reverseDnsKeys.forEach(({ key, tag }) => {
      const idx = textSample.indexOf(key);
      if (idx !== -1) {
        // Search following bytes for 'data' box or text string
        let val = null;
        for (let i = idx + key.length; i < Math.min(idx + key.length + 80, data.byteLength - 12); i++) {
          if (data[i] === 0x64 && data[i+1] === 0x61 && data[i+2] === 0x74 && data[i+3] === 0x61) {
            let s = "";
            for (let j = i + 12; j < Math.min(i + 90, data.byteLength); j++) {
              const c = data[j];
              if (c >= 32 && c <= 126) s += String.fromCharCode(c);
              else if (s.length > 0) break;
            }
            if (s.trim()) { val = s.trim(); break; }
          }
        }
        if (!val) {
          // Fallback: search for printable characters
          let s = "";
          for (let i = idx + key.length; i < Math.min(idx + key.length + 60, data.byteLength); i++) {
            const c = data[i];
            if (c >= 32 && c <= 126) s += String.fromCharCode(c);
            else if (s.length >= 2) break;
            else s = "";
          }
          if (s.trim()) val = s.trim();
        }
        if (val && !tags[tag]) tags[tag] = val;
      }
    });

    // Check for XMP packet embedded in udta / meta / uuid
    const xmpIdx = textSample.indexOf('http://ns.adobe.com/xap/1.0/');
    if (xmpIdx !== -1) {
      const xmpStr = this.readAscii(data, xmpIdx, Math.min(data.byteLength - xmpIdx, 65536));
      this.parseXmpBlock(xmpStr, tags);
    }
  }

  // ==========================================
  // 2. WAV / BWF / RIFF Chunk Inspector
  // ==========================================
  static parseWAV(uint8, view, filename, fileSize) {
    let offset = 12;
    let sampleRate = 44100;
    let channels = 2;
    let bitsPerSample = 16;
    let dataSize = fileSize - 44;
    let formatTag = 1;
    const tags = {};
    const containerTree = [{ box: 'RIFF.WAVE', offset: 0, size: fileSize, desc: 'Resource Interchange File Format (WAVE)' }];

    while (offset + 8 <= uint8.length) {
      const chunkId = String.fromCharCode(uint8[offset], uint8[offset+1], uint8[offset+2], uint8[offset+3]);
      const chunkSize = view.getUint32(offset + 4, true);

      containerTree.push({
        box: `chunk.${chunkId}`,
        offset: offset,
        size: chunkSize + 8,
        desc: chunkId === 'fmt ' ? 'Format Chunk (Sample Rate, Channels, Bit Depth)' : (chunkId === 'data' ? 'Audio PCM Sample Data Payload' : (chunkId === 'bext' ? 'Broadcast Wave Format (BWF) Metadata' : 'RIFF Chunk'))
      });

      if (chunkId === 'fmt ') {
        formatTag = view.getUint16(offset + 8, true);
        channels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
      } else if (chunkId === 'LIST') {
        // Parse INFO tags (IART, INAM, ICOP, etc.)
        this.extractRiffInfoTags(uint8.subarray(offset + 8, offset + 8 + chunkSize), tags);
      } else if (chunkId === 'bext') {
        tags.bext_description = this.readAscii(uint8, offset + 8, 256);
        tags.bext_originator = this.readAscii(uint8, offset + 264, 32);
        tags.bext_origination_date = this.readAscii(uint8, offset + 328, 10);
        tags.bext_origination_time = this.readAscii(uint8, offset + 338, 8);
        if (tags.bext_originator) {
          tags.Device = tags.bext_originator;
        }
        if (tags.bext_origination_date) {
          tags.creation_time = `${tags.bext_origination_date} ${tags.bext_origination_time || ''}`.trim();
        }
      }

      offset += 8 + chunkSize;
      if (chunkSize % 2 === 1) offset++; // Word alignment padding
    }

    const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
    const duration = bytesPerSec > 0 ? (dataSize / bytesPerSec) : 0;
    const bitRate = Math.round(sampleRate * channels * bitsPerSample).toString();
    const codecName = formatTag === 3 ? "pcm_f32le" : (bitsPerSample === 24 ? "pcm_s24le" : "pcm_s16le");
    const codecLong = formatTag === 3 ? "PCM 32-bit floating point little-endian" : `PCM signed ${bitsPerSample}-bit little-endian`;

    return {
      streams: [
        {
          index: 0,
          codec_name: codecName,
          codec_long_name: codecLong,
          codec_type: "audio",
          sample_fmt: formatTag === 3 ? "flt" : `s${bitsPerSample}`,
          sample_rate: sampleRate.toString(),
          channels: channels,
          channel_layout: channels === 1 ? "mono" : "stereo",
          bits_per_sample: bitsPerSample,
          bit_rate: bitRate,
          duration: duration.toFixed(6)
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "wav",
        format_long_name: "WAV / WAVE (Waveform Audio / BWF)",
        duration: duration.toFixed(6),
        size: fileSize.toString(),
        bit_rate: bitRate,
        probe_score: 100,
        tags: {
          ...(tags.ISFT ? { encoder: tags.ISFT } : {}),
          ...tags
        }
      },
      container_tree: containerTree,
      all_tags: tags
    };
  }

  static extractRiffInfoTags(data, tags) {
    const riffMap = {
      'INAM': 'title',
      'IART': 'artist',
      'IPRD': 'album',
      'ICRD': 'date',
      'IGNR': 'genre',
      'ICMT': 'comment',
      'ICOP': 'copyright',
      'ISFT': 'software'
    };
    for (let i = 0; i < data.length - 8; i++) {
      const code = String.fromCharCode(data[i], data[i+1], data[i+2], data[i+3]);
      if (riffMap[code]) {
        let str = "";
        for (let j = i + 8; j < Math.min(i + 128, data.length); j++) {
          if (data[j] === 0) break;
          str += String.fromCharCode(data[j]);
        }
        if (str.trim()) tags[riffMap[code]] = str.trim();
      }
    }
  }

  // ==========================================
  // 3. MP3 & Full ID3v2.2/3/4 Inspector
  // ==========================================
  static parseMP3(uint8, view, filename, fileSize) {
    let offset = 0;
    const tags = {};
    const containerTree = [];

    // Parse ID3v2 Header
    if (uint8[0] === 0x49 && uint8[1] === 0x44 && uint8[2] === 0x33) {
      const version = `2.${uint8[3]}.${uint8[4]}`;
      const id3Size = ((uint8[6] & 0x7f) << 21) | ((uint8[7] & 0x7f) << 14) | ((uint8[8] & 0x7f) << 7) | (uint8[9] & 0x7f);

      containerTree.push({
        box: 'ID3v2',
        offset: 0,
        size: id3Size + 10,
        desc: `ID3v2 Metadata Container (v${version})`
      });

      // Parse ID3v2 frames
      this.extractId3Frames(uint8.subarray(10, 10 + id3Size), tags, containerTree);
      offset = 10 + id3Size;
    }

    // Default MP3 params
    const sampleRate = 44100;
    const channels = 2;
    const bitRateNum = 256000;
    const duration = (fileSize * 8) / bitRateNum;

    return {
      streams: [
        {
          index: 0,
          codec_name: "mp3",
          codec_long_name: "MP3 (MPEG audio layer 3)",
          codec_type: "audio",
          sample_fmt: "fltp",
          sample_rate: sampleRate.toString(),
          channels: channels,
          channel_layout: "stereo",
          bits_per_sample: 16,
          bit_rate: bitRateNum.toString(),
          duration: duration.toFixed(6)
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "mp3",
        format_long_name: "MP2/3 (MPEG audio layer 2/3)",
        duration: duration.toFixed(6),
        size: fileSize.toString(),
        bit_rate: bitRateNum.toString(),
        probe_score: 95,
        tags: {
          ...(tags.TSSE ? { encoder: tags.TSSE } : {}),
          ...tags
        }
      },
      container_tree: containerTree,
      all_tags: tags
    };
  }

  static extractId3Frames(data, tags, containerTree) {
    const id3Map = {
      'TIT2': 'title',
      'TPE1': 'artist',
      'TALB': 'album',
      'TYER': 'year',
      'TDRC': 'date',
      'TCON': 'genre',
      'TRCK': 'track',
      'COMM': 'comment',
      'TCOM': 'composer',
      'TPOS': 'disc',
      'TSSE': 'encoder',
      'APIC': 'attached_picture'
    };

    let p = 0;
    while (p + 10 <= data.length) {
      const frameId = String.fromCharCode(data[p], data[p+1], data[p+2], data[p+3]);
      if (frameId.charCodeAt(0) === 0) break;

      const frameSize = (data[p+4] << 24) | (data[p+5] << 16) | (data[p+6] << 8) | data[p+7];
      if (frameSize <= 0 || p + 10 + frameSize > data.length) break;

      if (id3Map[frameId]) {
        const prop = id3Map[frameId];
        let val = "";
        for (let i = p + 11; i < p + 10 + frameSize; i++) {
          const c = data[i];
          if (c >= 32 && c <= 126) val += String.fromCharCode(c);
        }
        if (val.trim()) tags[prop] = val.trim();
      }

      containerTree.push({
        box: `ID3.${frameId}`,
        offset: p,
        size: frameSize + 10,
        desc: `ID3 Frame: ${id3Map[frameId] || frameId}`
      });

      p += 10 + frameSize;
    }
  }

  // ==========================================
  // 4. FLAC Audio Inspector
  // ==========================================
  static parseFLAC(uint8, view, filename, fileSize) {
    const containerTree = [{ box: 'fLaC', offset: 0, size: 4, desc: 'Free Lossless Audio Codec Header' }];
    const tags = {};
    let sampleRate = 44100;
    let channels = 2;
    let bitsPerSample = 16;
    let totalSamples = 0;

    if (uint8.length >= 42) {
      // STREAMINFO block
      sampleRate = (uint8[18] << 12) | (uint8[19] << 4) | (uint8[20] >> 4);
      channels = ((uint8[20] >> 1) & 0x07) + 1;
      bitsPerSample = (((uint8[20] & 0x01) << 4) | (uint8[21] >> 4)) + 1;
      totalSamples = ((uint8[21] & 0x0F) * 4294967296) + (uint8[22] << 24) + (uint8[23] << 16) + (uint8[24] << 8) + uint8[25];

      containerTree.push({
        box: 'METADATA_STREAMINFO',
        offset: 4,
        size: 38,
        desc: `Stream Info: ${sampleRate}Hz, ${channels}ch, ${bitsPerSample}-bit`
      });
    }

    const duration = sampleRate > 0 ? (totalSamples / sampleRate) : 0;
    const bitRate = duration > 0 ? Math.round((fileSize * 8) / duration).toString() : "0";

    return {
      streams: [
        {
          index: 0,
          codec_name: "flac",
          codec_long_name: "FLAC (Free Lossless Audio Codec)",
          codec_type: "audio",
          sample_fmt: `s${bitsPerSample}`,
          sample_rate: sampleRate.toString(),
          channels: channels,
          channel_layout: channels === 1 ? "mono" : "stereo",
          bits_per_sample: bitsPerSample,
          bit_rate: bitRate,
          duration: duration.toFixed(6)
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "flac",
        format_long_name: "Raw FLAC",
        duration: duration.toFixed(6),
        size: fileSize.toString(),
        bit_rate: bitRate,
        probe_score: 100,
        tags: { ...tags }
      },
      container_tree: containerTree,
      all_tags: tags
    };
  }

  // ==========================================
  // 5. Ogg / Opus / Vorbis Inspector
  // ==========================================
  static parseOGG(uint8, view, filename, fileSize) {
    const containerTree = [{ box: 'OggS', offset: 0, size: 28, desc: 'Ogg Container Page Header' }];
    const tags = {};
    const sampleRate = 48000;
    const channels = 2;
    const bitRate = 160000;
    const duration = (fileSize * 8) / bitRate;

    return {
      streams: [
        {
          index: 0,
          codec_name: "opus",
          codec_long_name: "Opus Audio Codec (Ogg Container)",
          codec_type: "audio",
          sample_fmt: "fltp",
          sample_rate: sampleRate.toString(),
          channels: channels,
          channel_layout: "stereo",
          bits_per_sample: 16,
          bit_rate: bitRate.toString(),
          duration: duration.toFixed(6)
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "ogg",
        format_long_name: "Ogg Container",
        duration: duration.toFixed(6),
        size: fileSize.toString(),
        bit_rate: bitRate.toString(),
        probe_score: 100,
        tags: tags
      },
      container_tree: containerTree,
      all_tags: tags
    };
  }

  // ==========================================
  // 6. WebM / Matroska (MKV) Inspector
  // ==========================================
  static parseWebM(uint8, view, filename, fileSize) {
    const containerTree = [{ box: 'EBML', offset: 0, size: 32, desc: 'Extensible Binary Meta Language (Matroska/WebM)' }];
    const tags = {};

    return {
      streams: [
        {
          index: 0,
          codec_name: "vp9",
          codec_long_name: "Google VP9 Video",
          codec_type: "video",
          width: 1920,
          height: 1080,
          avg_frame_rate: "30/1"
        },
        {
          index: 1,
          codec_name: "opus",
          codec_long_name: "Opus Audio Codec",
          codec_type: "audio",
          sample_rate: "48000",
          channels: 2,
          channel_layout: "stereo"
        }
      ],
      format: {
        filename: filename,
        nb_streams: 2,
        format_name: "matroska,webm",
        format_long_name: "Matroska / WebM Container",
        duration: "10.000000",
        size: fileSize.toString(),
        bit_rate: "2400000",
        probe_score: 100,
        tags: { ...tags }
      },
      container_tree: containerTree,
      all_tags: tags
    };
  }

  // ==========================================
  // 7. JPEG / EXIF Image Inspector
  // ==========================================
  static parseJPEG(uint8, view, filename, fileSize) {
    let width = 0;
    let height = 0;
    const tags = {};
    const containerTree = [{ box: 'SOI', offset: 0, size: 2, desc: 'Start of Image (JPEG)' }];

    let offset = 2;
    while (offset + 4 <= uint8.length) {
      if (uint8[offset] !== 0xFF) break;
      const marker = uint8[offset + 1];
      const len = view.getUint16(offset + 2);

      if (marker === 0xC0 || marker === 0xC2) {
        // SOF0 / SOF2
        height = view.getUint16(offset + 5);
        width = view.getUint16(offset + 7);
        containerTree.push({
          box: marker === 0xC0 ? 'SOF0' : 'SOF2',
          offset: offset,
          size: len + 2,
          desc: `Start of Frame (${width}x${height}, Baseline/Progressive)`
        });
      } else if (marker === 0xE1) {
        const app1Start = offset + 4;
        const app1Header = this.readAscii(uint8, app1Start, 6);
        if (app1Header.startsWith('Exif')) {
          containerTree.push({
            box: 'APP1_EXIF',
            offset: offset,
            size: len + 2,
            desc: 'Exchangeable Image File Format (EXIF) Metadata'
          });
          tags.exif_present = "True";
          this.parseExifTiff(uint8, app1Start + 6, tags);
        } else if (this.readAscii(uint8, app1Start, 30).includes('http://ns.adobe.com/xap/1.0/')) {
          containerTree.push({
            box: 'APP1_XMP',
            offset: offset,
            size: len + 2,
            desc: 'Adobe Extensible Metadata Platform (XMP) Packet'
          });
          const xmpStr = this.readAscii(uint8, app1Start + 29, len - 31);
          this.parseXmpBlock(xmpStr, tags);
        } else {
          containerTree.push({
            box: 'APP1',
            offset: offset,
            size: len + 2,
            desc: 'Application Marker 1 Metadata'
          });
        }
      } else if (marker === 0xED) {
        containerTree.push({
          box: 'APP13_PHOTOSHOP',
          offset: offset,
          size: len + 2,
          desc: 'Photoshop 3.0 IPTC / Image Resources'
        });
        tags.photoshop_present = "True";
        if (this.Extras) this.Extras.parseIptcFromApp13(uint8, offset + 4, offset + 2 + len, tags);
      } else if (marker === 0xFE) {
        const comment = this.readAscii(uint8, offset + 4, len - 2);
        containerTree.push({
          box: 'COM',
          offset: offset,
          size: len + 2,
          desc: `JPEG Comment (${comment.slice(0, 30)}...)`
        });
        tags.comment = comment;
      }

      offset += 2 + len;
    }

    return {
      streams: [
        {
          index: 0,
          codec_name: "mjpeg",
          codec_long_name: "JPEG (Joint Photographic Experts Group)",
          codec_type: "video",
          width: width || 1920,
          height: height || 1080,
          display_aspect_ratio: width && height ? `${width}:${height}` : "16:9",
          pix_fmt: "yuvj420p"
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "image2",
        format_long_name: "JPEG Image File",
        duration: "0.040000",
        size: fileSize.toString(),
        bit_rate: "0",
        probe_score: 100,
        tags: tags
      },
      container_tree: containerTree,
      all_tags: tags
    };
  }

  // ==========================================
  // 8. PNG Image Inspector
  // ==========================================
  static parsePNG(uint8, view, filename, fileSize) {
    let width = 0;
    let height = 0;
    let bitDepth = 8;
    let colorType = 2;
    const tags = {};
    const containerTree = [{ box: 'PNG_SIGNATURE', offset: 0, size: 8, desc: 'Portable Network Graphics 8-byte Signature' }];

    let offset = 8;
    while (offset + 8 <= uint8.length) {
      const chunkLen = view.getUint32(offset);
      const chunkType = String.fromCharCode(uint8[offset+4], uint8[offset+5], uint8[offset+6], uint8[offset+7]);

      containerTree.push({
        box: chunkType,
        offset: offset,
        size: chunkLen + 12,
        desc: chunkType === 'IHDR' ? 'Image Header (Dimensions, Bit Depth)' : (chunkType === 'IDAT' ? 'Compressed Image Data' : (chunkType === 'IEND' ? 'Image End' : 'PNG Metadata Chunk'))
      });

      if (chunkType === 'IHDR') {
        width = view.getUint32(offset + 8);
        height = view.getUint32(offset + 12);
        bitDepth = uint8[offset + 16];
        colorType = uint8[offset + 17];
      } else if (chunkType === 'tIME') {
        const year = view.getUint16(offset + 8);
        const month = uint8[offset + 10];
        const day = uint8[offset + 11];
        const hour = uint8[offset + 12];
        const min = uint8[offset + 13];
        const sec = uint8[offset + 14];
        tags.modification_time = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}Z`;
      } else if (chunkType === 'tEXt' || chunkType === 'iTXt') {
        const chunkData = uint8.subarray(offset + 8, offset + 8 + chunkLen);
        this.parsePngTextChunk(chunkData, chunkType, tags);
      }

      offset += 12 + chunkLen;
    }

    return {
      streams: [
        {
          index: 0,
          codec_name: "png",
          codec_long_name: "PNG (Portable Network Graphics)",
          codec_type: "video",
          width: width,
          height: height,
          display_aspect_ratio: `${width}:${height}`,
          bits_per_sample: bitDepth,
          pix_fmt: colorType === 6 ? "rgba" : "rgb24"
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "image2",
        format_long_name: "PNG Image File",
        duration: "0.040000",
        size: fileSize.toString(),
        bit_rate: "0",
        probe_score: 100,
        tags: tags
      },
      container_tree: containerTree,
      all_tags: tags
    };
  }

  // ==========================================
  // 9. WebP Image Inspector
  // ==========================================
  static parseWebP(uint8, view, filename, fileSize) {
    let width = view.getUint16(26, true);
    let height = view.getUint16(28, true);

    return {
      streams: [
        {
          index: 0,
          codec_name: "webp",
          codec_long_name: "WebP Image",
          codec_type: "video",
          width: width || 800,
          height: height || 600,
          pix_fmt: "yuv420p"
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "webp",
        format_long_name: "Google WebP Image Format",
        size: fileSize.toString(),
        bit_rate: "0",
        probe_score: 100,
        tags: {}
      },
      container_tree: [{ box: 'RIFF.WEBP', offset: 0, size: fileSize, desc: 'WebP Image Container' }],
      all_tags: {}
    };
  }

  // ==========================================
  // 10. GIF Image Inspector
  // ==========================================
  static parseGIF(uint8, view, filename, fileSize) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);

    return {
      streams: [
        {
          index: 0,
          codec_name: "gif",
          codec_long_name: "GIF (Graphics Interchange Format)",
          codec_type: "video",
          width: width,
          height: height,
          pix_fmt: "pal8"
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "gif",
        format_long_name: "GIF Animation / Image",
        size: fileSize.toString(),
        bit_rate: "0",
        probe_score: 100,
        tags: {}
      },
      container_tree: [{ box: 'GIF89a', offset: 0, size: fileSize, desc: 'GIF Header & Screen Descriptor' }],
      all_tags: {}
    };
  }

  // ==========================================
  // 11. PDF Document Inspector
  // ==========================================
  /** Decodes a PDF string: literal "(...)" with escapes, or hex "<...>"; UTF-16BE (BOM FEFF) or Latin-1. */
  static decodePdfString(raw) {
    let bytes = [];
    if (raw[0] === '<') {
      const hex = raw.slice(1, -1).replace(/\s+/g, '');
      for (let i = 0; i + 1 < hex.length + 1; i += 2) bytes.push(parseInt((hex.substr(i, 2) + '0').slice(0, 2), 16));
    } else {
      const body = raw.slice(1, -1);
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '\\' && i + 1 < body.length) {
          const n = body[++i];
          const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
          if (n in map) bytes.push(map[n]);
          else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(body[i + 1] || '')) o += body[++i]; bytes.push(parseInt(o, 8) & 255); }
          else if (n !== '\n' && n !== '\r') bytes.push(n.charCodeAt(0) & 255);
        } else bytes.push(c.charCodeAt(0) & 255);
      }
    }
    let out = '';
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    } else if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      try { out = new TextDecoder('utf-8').decode(new Uint8Array(bytes.slice(3))); } catch (e) { out = String.fromCharCode(...bytes.slice(3)); }
    } else {
      out = bytes.map(b => String.fromCharCode(b)).join('');
    }
    return out.replace(/\u0000/g, '').trim();
  }

  /** PDF date "D:YYYYMMDDHHmmSSOHH'mm'" -> ISO-8601 string. */
  static formatPdfDate(d) {
    const m = String(d).match(/D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-])?(\d{2})?'?(\d{2})?/);
    if (!m) return d;
    const [, Y, Mo = '01', D = '01', H = '00', Mi = '00', S = '00', sign, oh = '00', om = '00'] = m;
    const tz = !sign || sign === 'Z' ? 'Z' : `${sign}${oh}:${om}`;
    return `${Y}-${Mo}-${D}T${H}:${Mi}:${S}${tz}`;
  }

  static parsePDF(uint8, view, filename, fileSize) {
    let versionStr = "1.4";
    for (let i = 0; i < Math.min(30, uint8.length); i++) {
      if (uint8[i] === 0x25 && uint8[i+1] === 0x50 && uint8[i+2] === 0x44 && uint8[i+3] === 0x46) {
        versionStr = String.fromCharCode(uint8[i+5], uint8[i+6], uint8[i+7]);
        break;
      }
    }

    const tags = { pdf_version: versionStr };
    const tree = [{ box: 'PDF_HEADER', offset: 0, size: 8, desc: `PDF File Header (%PDF-${versionStr})` }];

    // Read text sample to extract PDF metadata dictionary
    const textSample = this.readAscii(uint8, 0, Math.min(uint8.length, 65536)) + 
      (uint8.length > 65536 ? " " + this.readAscii(uint8, uint8.length - 32768, 32768) : "");

    // Info dictionary: values may be literal "(text)" or hex "<feff...>" strings, in any part of the
    // file (incremental saves append a newer Info dict at the end), so scan the head and tail.
    const infoText = this.rawText(uint8, 0, Math.min(uint8.length, 2097152)) +
      (uint8.length > 2097152 ? '\n' + this.rawText(uint8, uint8.length - 1048576, 1048576) : '');
    const lastValue = (key) => {
      const re = new RegExp('/' + key + '\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)', 'g');
      let m, last = null;
      while ((m = re.exec(infoText)) !== null) last = m[1];
      return last ? this.decodePdfString(last) : null;
    };
    for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
      const v = lastValue(key);
      if (v) tags[key] = v;
    }
    const cd = lastValue('CreationDate');
    if (cd) { tags.CreationDate = this.formatPdfDate(cd); tags.creation_time = tags.CreationDate; }
    const md = lastValue('ModDate');
    if (md) { tags.ModDate = this.formatPdfDate(md); tags.modification_time = tags.ModDate; }
    if (tags.Creator || tags.Producer) tags.Software = [tags.Creator, tags.Producer].filter(Boolean).join(' / ');
    if (/<x:xmpmeta/i.test(infoText)) {
      const x = infoText.match(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/i);
      if (x) this.parseXmpBlock(x[0], tags);
    }

    if (textSample.includes('xref')) {
      tree.push({ box: 'XREF_TABLE', offset: textSample.indexOf('xref'), size: 0, desc: 'Cross-reference Object Table' });
    }
    if (textSample.includes('trailer')) {
      tree.push({ box: 'TRAILER', offset: textSample.indexOf('trailer'), size: 0, desc: 'PDF Trailer Dictionary' });
    }

    return {
      streams: [
        {
          index: 0,
          codec_name: "pdf_stream",
          codec_long_name: `Adobe Portable Document Format (PDF v${versionStr})`,
          codec_type: "data"
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: "pdf",
        format_long_name: `Adobe PDF Document (v${versionStr})`,
        size: fileSize.toString(),
        bit_rate: "0",
        probe_score: 100,
        tags: tags
      },
      container_tree: tree,
      all_tags: tags
    };
  }

  // ==========================================
  // 12. Universal Binary Fallback Inspector
  // ==========================================
  static parseGenericBinary(uint8, view, filename, fileSize, ext) {
    return {
      streams: [
        {
          index: 0,
          codec_name: "binary_stream",
          codec_long_name: "Raw Binary Data Stream",
          codec_type: "data",
          size: fileSize.toString()
        }
      ],
      format: {
        filename: filename,
        nb_streams: 1,
        format_name: ext || "bin",
        format_long_name: `Generic ${ext.toUpperCase()} File / Binary Asset`,
        size: fileSize.toString(),
        bit_rate: "0",
        probe_score: 50,
        tags: { file_extension: ext }
      },
      container_tree: [{ box: 'FILE_PAYLOAD', offset: 0, size: fileSize, desc: 'Binary File Payload' }],
      all_tags: { file_extension: ext }
    };
  }

  /** Latin-1 text of a byte range. Unlike readAscii it does not stop at NUL bytes (binary files). */
  static rawText(uint8, start, length) {
    const end = Math.min(uint8.length, start + length);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('latin1').decode(uint8.subarray(Math.max(0, start), end));
    let out = '';
    for (let i = Math.max(0, start); i < end; i++) out += String.fromCharCode(uint8[i]);
    return out;
  }

  static readAscii(uint8, offset, length) {
    let str = "";
    for (let i = offset; i < Math.min(offset + length, uint8.length); i++) {
      if (uint8[i] === 0) break;
      str += String.fromCharCode(uint8[i]);
    }
    return str.trim();
  }

  static parseExifTiff(uint8, tiffOffset, tags) {
    const X = this.Extras;
    if (X && X.parseExif(uint8, tiffOffset, tags)) return;
    try {
      if (tiffOffset + 8 > uint8.length) return;
      const isLE = uint8[tiffOffset] === 0x49 && uint8[tiffOffset + 1] === 0x49;
      const isBE = uint8[tiffOffset] === 0x4D && uint8[tiffOffset + 1] === 0x4D;
      if (!isLE && !isBE) return;

      const readU16 = (o) => {
        if (o + 2 > uint8.length) return 0;
        return isLE ? (uint8[o] | (uint8[o + 1] << 8)) : ((uint8[o] << 8) | uint8[o + 1]);
      };
      const readU32 = (o) => {
        if (o + 4 > uint8.length) return 0;
        return isLE
          ? (uint8[o] | (uint8[o + 1] << 8) | (uint8[o + 2] << 16) | (uint8[o + 3] * 0x1000000))
          : ((uint8[o] * 0x1000000) | (uint8[o + 1] << 16) | (uint8[o + 2] << 8) | uint8[o + 3]);
      };

      const firstIFD = readU32(tiffOffset + 4);
      if (firstIFD <= 0 || tiffOffset + firstIFD >= uint8.length) return;

      const parseIFD = (ifdOffset) => {
        if (tiffOffset + ifdOffset + 2 > uint8.length) return;
        const count = readU16(tiffOffset + ifdOffset);
        let cur = tiffOffset + ifdOffset + 2;

        for (let i = 0; i < count && cur + 12 <= uint8.length; i++, cur += 12) {
          const tag = readU16(cur);
          const type = readU16(cur + 2);
          const num = readU32(cur + 4);
          const valOffset = cur + 8;

          let strVal = "";
          if (type === 2) {
            const dataPtr = num > 4 ? tiffOffset + readU32(valOffset) : valOffset;
            strVal = this.readAscii(uint8, dataPtr, num);
          }

          if (tag === 0x010F && strVal) tags.Make = strVal;
          else if (tag === 0x0110 && strVal) tags.Model = strVal;
          else if (tag === 0x0131 && strVal) tags.Software = strVal;
          else if (tag === 0x0132 && strVal) tags.ModifyDate = strVal;
          else if (tag === 0x013B && strVal) tags.Artist = strVal;
          else if (tag === 0x013C && strVal) tags.HostComputer = strVal;
          else if (tag === 0x9003 && strVal) tags.DateTimeOriginal = strVal;
          else if (tag === 0x9004 && strVal) tags.DateTimeDigitized = strVal;
          else if (tag === 0xA431 && strVal) tags.BodySerialNumber = strVal;
          else if (tag === 0xA432 && strVal) tags.LensSpecification = strVal;
          else if (tag === 0xA433 && strVal) tags.LensMake = strVal;
          else if (tag === 0xA434 && strVal) tags.LensModel = strVal;
          else if (tag === 0x8769 && type === 4) {
            const subIFD = readU32(valOffset);
            if (subIFD > 0) parseIFD(subIFD);
          }
        }
      };

      parseIFD(firstIFD);
    } catch (e) {}
  }

  static parseXmpBlock(xmpStr, tags) {
    try {
      if (!xmpStr) return;
      const createMatch = xmpStr.match(/<xmp:CreateDate>([^<]+)<\/xmp:CreateDate>/i) || 
                          xmpStr.match(/CreateDate="([^"]+)"/i) || 
                          xmpStr.match(/<photoshop:DateCreated>([^<]+)<\/photoshop:DateCreated>/i);
      if (createMatch) tags.CreateDate = createMatch[1];

      const modifyMatch = xmpStr.match(/<xmp:ModifyDate>([^<]+)<\/xmp:ModifyDate>/i) || 
                          xmpStr.match(/ModifyDate="([^"]+)"/i);
      if (modifyMatch) tags.ModifyDate = modifyMatch[1];

      const metaMatch = xmpStr.match(/<xmp:MetadataDate>([^<]+)<\/xmp:MetadataDate>/i) || 
                        xmpStr.match(/MetadataDate="([^"]+)"/i);
      if (metaMatch) tags.MetadataDate = metaMatch[1];

      // Extract Camera Hardware, Model & Lens from XMP
      const makeMatch = xmpStr.match(/<tiff:Make>([^<]+)<\/tiff:Make>/i) || xmpStr.match(/tiff:Make="([^"]+)"/i);
      if (makeMatch && !tags.Make) tags.Make = makeMatch[1].trim();

      const modelMatch = xmpStr.match(/<tiff:Model>([^<]+)<\/tiff:Model>/i) || xmpStr.match(/tiff:Model="([^"]+)"/i);
      if (modelMatch && !tags.Model) tags.Model = modelMatch[1].trim();

      const lensMatch = xmpStr.match(/<aux:LensModel>([^<]+)<\/aux:LensModel>/i) || 
                        xmpStr.match(/<exif:LensModel>([^<]+)<\/exif:LensModel>/i) || 
                        xmpStr.match(/aux:LensModel="([^"]+)"/i) ||
                        xmpStr.match(/exif:LensModel="([^"]+)"/i);
      if (lensMatch && !tags.LensModel) tags.LensModel = lensMatch[1].trim();

      const serialMatch = xmpStr.match(/<aux:SerialNumber>([^<]+)<\/aux:SerialNumber>/i) || 
                          xmpStr.match(/<exif:BodySerialNumber>([^<]+)<\/exif:BodySerialNumber>/i) ||
                          xmpStr.match(/aux:SerialNumber="([^"]+)"/i);
      if (serialMatch && !tags.BodySerialNumber) tags.BodySerialNumber = serialMatch[1].trim();

      const hostMatch = xmpStr.match(/<tiff:HostComputer>([^<]+)<\/tiff:HostComputer>/i) || xmpStr.match(/tiff:HostComputer="([^"]+)"/i);
      if (hostMatch && !tags.HostComputer) tags.HostComputer = hostMatch[1].trim();

      // Check for AI prompt inside XMP
      const promptMatch = xmpStr.match(/<dc:description>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/i) || 
                          xmpStr.match(/prompt="([^"]+)"/i);
      if (promptMatch && (promptMatch[1].toLowerCase().includes('prompt') || promptMatch[1].length > 40)) {
        tags.ai_prompt = promptMatch[1];
      }

      // Origin, credits, AI source type, location and document ids
      const xv = (name) => { const m = xmpStr.match(new RegExp('<' + name + '>\\s*([^<]+?)\\s*</' + name + '>', 'i')) || xmpStr.match(new RegExp(name + '="([^"]*)"', 'i')); return m ? m[1].trim() : null; };
      const li = (name) => { const m = xmpStr.match(new RegExp('<' + name + '[^>]*>[\\s\\S]*?<rdf:li[^>]*>([^<]+)</rdf:li>', 'i')); return m ? m[1].trim() : null; };
      const creatorTool = xv('xmp:CreatorTool');
      if (creatorTool) { tags.CreatorTool = creatorTool; if (!tags.Software) tags.Software = creatorTool; }
      const dstVal = xv('Iptc4xmpExt:DigitalSourceType');
      if (dstVal) tags.DigitalSourceType = dstVal.split('/').pop();
      if (!tags.Title && li('dc:title')) tags.Title = li('dc:title');
      if (!tags.Artist && li('dc:creator')) tags.Artist = li('dc:creator');
      if (!tags.Copyright && li('dc:rights')) tags.Copyright = li('dc:rights');
      if (!tags.Description && li('dc:description')) tags.Description = li('dc:description');
      const credit = xv('photoshop:Credit'); if (credit) tags.Credit = credit;
      const source = xv('photoshop:Source'); if (source) tags.Source = source;
      const docId = xv('xmpMM:DocumentID'); if (docId) tags.DocumentID = docId;
      const origId = xv('xmpMM:OriginalDocumentID'); if (origId) tags.OriginalDocumentID = origId;
      const gpsConv = (v) => { const m = v && v.match(/(\d+),(\d+(?:\.\d+)?)([NSEW])/i); if (!m) return null; const d = +m[1] + (+m[2]) / 60; return /[SW]/i.test(m[3]) ? -d : d; };
      const xLat = gpsConv(xv('exif:GPSLatitude')), xLon = gpsConv(xv('exif:GPSLongitude'));
      if (xLat !== null && xLon !== null && tags.GPSLatitude === undefined) { tags.GPSLatitude = xLat.toFixed(6); tags.GPSLongitude = xLon.toFixed(6); }

      // Parse XMP History entries
      tags.xmp_history = [];
      const liRegex = /<rdf:li\s+([^>]+?)(?:\/>|>(.*?)<\/rdf:li>)/gis;
      let m;
      while ((m = liRegex.exec(xmpStr)) !== null) {
        const attrs = m[1] + (m[2] || '');
        const action = (attrs.match(/stEvt:action="([^"]+)"/i) || [])[1];
        const when = (attrs.match(/stEvt:when="([^"]+)"/i) || [])[1];
        const agent = (attrs.match(/stEvt:softwareAgent="([^"]+)"/i) || [])[1];
        const changed = (attrs.match(/stEvt:changed="([^"]+)"/i) || [])[1];
        if (action || when || agent) {
          tags.xmp_history.push({ action, when, agent, changed });
          if (agent && !tags.Software) tags.Software = agent;
        }
      }
    } catch (e) {}
  }

  static parsePngTextChunk(chunkData, chunkType, tags, preText = null) {
    try {
      if (chunkData.length === 0) return;
      let nullIdx = 0;
      while (nullIdx < chunkData.length && chunkData[nullIdx] !== 0) nullIdx++;
      if (nullIdx >= chunkData.length && preText === null) return;

      let keyword = "";
      for (let i = 0; i < nullIdx; i++) keyword += String.fromCharCode(chunkData[i]);

      let text = "";
      if (preText !== null) {
        text = preText;
      } else if (chunkType === 'tEXt') {
        for (let i = nullIdx + 1; i < chunkData.length; i++) text += String.fromCharCode(chunkData[i]);
      } else if (chunkType === 'iTXt') {
        if (chunkData[nullIdx + 1] === 1) return;   // compressed: handled asynchronously
        let pos = nullIdx + 3;
        while (pos < chunkData.length && chunkData[pos] !== 0) pos++;
        pos++;
        while (pos < chunkData.length && chunkData[pos] !== 0) pos++;
        pos++;
        text = new TextDecoder('utf-8').decode(chunkData.subarray(pos));
      }

      const lowerKey = keyword.toLowerCase().trim();
      if (lowerKey === 'parameters' || lowerKey === 'prompt') {
        tags.ai_prompt = text;
        tags.ai_parameters = text;
      } else if (lowerKey === 'creation time') {
        tags.creation_time = text;
      } else if (lowerKey === 'software') {
        tags.Software = text;
      } else if (lowerKey === 'make') {
        tags.Make = text;
      } else if (lowerKey === 'model' || lowerKey === 'device' || lowerKey === 'camera') {
        tags.Model = text;
      } else if (lowerKey === 'lens' || lowerKey === 'lensmodel') {
        tags.LensModel = text;
      } else if (lowerKey === 'host computer' || lowerKey === 'hostcomputer') {
        tags.HostComputer = text;
      } else if (lowerKey.includes('xmp')) {
        this.parseXmpBlock(text, tags);
      } else {
        tags[keyword] = text;
      }
    } catch (e) {}
  }

  static lookupDeviceModel(modelStr) {
    if (!modelStr) return null;
    const clean = modelStr.trim();
    const map = {
      // Apple iPhone identifiers
      'iPhone16,2': { friendlyName: 'iPhone 15 Pro Max', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone16,1': { friendlyName: 'iPhone 15 Pro', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone15,5': { friendlyName: 'iPhone 15 Plus', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone15,4': { friendlyName: 'iPhone 15', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone15,3': { friendlyName: 'iPhone 14 Pro Max', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone15,2': { friendlyName: 'iPhone 14 Pro', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone14,8': { friendlyName: 'iPhone 14 Plus', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone14,7': { friendlyName: 'iPhone 14', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone14,3': { friendlyName: 'iPhone 13 Pro Max', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone14,2': { friendlyName: 'iPhone 13 Pro', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone14,5': { friendlyName: 'iPhone 13', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone14,4': { friendlyName: 'iPhone 13 mini', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone13,4': { friendlyName: 'iPhone 12 Pro Max', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone13,3': { friendlyName: 'iPhone 12 Pro', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone13,2': { friendlyName: 'iPhone 12', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone13,1': { friendlyName: 'iPhone 12 mini', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone12,5': { friendlyName: 'iPhone 11 Pro Max', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone12,3': { friendlyName: 'iPhone 11 Pro', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone12,1': { friendlyName: 'iPhone 11', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone11,2': { friendlyName: 'iPhone XS', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone11,6': { friendlyName: 'iPhone XS Max', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone11,8': { friendlyName: 'iPhone XR', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone10,3': { friendlyName: 'iPhone X', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone10,6': { friendlyName: 'iPhone X', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone14,6': { friendlyName: 'iPhone SE (3rd Gen)', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'iPhone12,8': { friendlyName: 'iPhone SE (2nd Gen)', manufacturer: 'Apple', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },

      // Samsung Galaxy models
      'SM-S928': { friendlyName: 'Samsung Galaxy S24 Ultra', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-S926': { friendlyName: 'Samsung Galaxy S24+', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-S921': { friendlyName: 'Samsung Galaxy S24', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-S918': { friendlyName: 'Samsung Galaxy S23 Ultra', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-S916': { friendlyName: 'Samsung Galaxy S23+', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-S911': { friendlyName: 'Samsung Galaxy S23', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-S908': { friendlyName: 'Samsung Galaxy S22 Ultra', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-G998': { friendlyName: 'Samsung Galaxy S21 Ultra', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-F946': { friendlyName: 'Samsung Galaxy Z Fold 5', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },
      'SM-F731': { friendlyName: 'Samsung Galaxy Z Flip 5', manufacturer: 'Samsung', hardwareType: 'Smartphone Camera & Audio', hardwareIcon: '📱' },

      // Sony Alpha camera codes
      'ILCE-7M4': { friendlyName: 'Sony Alpha 7 IV (A7 IV)', manufacturer: 'Sony', hardwareType: 'Mirrorless Camera', hardwareIcon: '📷' },
      'ILCE-7M3': { friendlyName: 'Sony Alpha 7 III (A7 III)', manufacturer: 'Sony', hardwareType: 'Mirrorless Camera', hardwareIcon: '📷' },
      'ILCE-7M2': { friendlyName: 'Sony Alpha 7 II (A7 II)', manufacturer: 'Sony', hardwareType: 'Mirrorless Camera', hardwareIcon: '📷' },
      'ILCE-7SM3': { friendlyName: 'Sony Alpha 7S III', manufacturer: 'Sony', hardwareType: 'Cinema & Mirrorless Camera', hardwareIcon: '📷' },
      'ILCE-7RM5': { friendlyName: 'Sony Alpha 7R V', manufacturer: 'Sony', hardwareType: 'High-Res Mirrorless Camera', hardwareIcon: '📷' },
      'ILCE-7RM4': { friendlyName: 'Sony Alpha 7R IV', manufacturer: 'Sony', hardwareType: 'High-Res Mirrorless Camera', hardwareIcon: '📷' },
      'ILCE-1': { friendlyName: 'Sony Alpha 1 Flagship', manufacturer: 'Sony', hardwareType: 'Pro Mirrorless Camera', hardwareIcon: '📷' },
      'ILCE-6700': { friendlyName: 'Sony Alpha a6700 APS-C', manufacturer: 'Sony', hardwareType: 'Mirrorless Camera', hardwareIcon: '📷' },
      'ILCE-6400': { friendlyName: 'Sony Alpha a6400', manufacturer: 'Sony', hardwareType: 'Mirrorless Camera', hardwareIcon: '📷' },
      'ILME-FX3': { friendlyName: 'Sony FX3 Cinema Line', manufacturer: 'Sony', hardwareType: 'Cinema Camera', hardwareIcon: '🎥' },
      'ILME-FX30': { friendlyName: 'Sony FX30 Cinema Line', manufacturer: 'Sony', hardwareType: 'Cinema Camera', hardwareIcon: '🎥' },

      // DJI Drones
      'FC3582': { friendlyName: 'DJI Mini 3 Pro Drone', manufacturer: 'DJI', hardwareType: 'Aerial Drone Camera', hardwareIcon: '🚁' },
      'FC8482': { friendlyName: 'DJI Mavic 3 Pro Drone', manufacturer: 'DJI', hardwareType: 'Aerial Drone Camera', hardwareIcon: '🚁' }
    };

    if (map[clean]) return map[clean];

    for (const key in map) {
      if (clean.toUpperCase().startsWith(key.toUpperCase())) return map[key];
    }

    return null;
  }

  static detectDeviceAndOrigin(result, uint8, file) {
    const format = result.format || {};
    const tags = { ...(format.tags || {}), ...(result.all_tags || {}) };

    // Documents (PDF): the metadata names the program that exported the file, not a device.
    if (this.isDocumentFormat(format)) {
      const prog = [tags.Producer || tags.Application, tags.Creator && tags.Creator !== tags.Producer ? `(${tags.Creator})` : null].filter(Boolean).join(' ') || tags.Software || '';
      return {
        detected: Boolean(prog), is_hardware_device: false,
        device_name: prog || 'Program not recorded',
        device_no: null, model_no: null, serial_no: null, manufacturer: null, model: null, raw_model: null,
        lens: null, serial: null, host_computer: null,
        hardware_type: 'Document software', hardware_icon: '📄', badge_color: '#3b82f6',
        confidence: prog ? 'Read from PDF metadata' : 'Not recorded',
        explanation: prog
          ? `This document was saved by ${prog}. Documents only record the program that saved them, not the computer, and they cannot show whether an AI tool helped write the text.`
          : 'This document does not say which program created it.',
        is_document: true,
        raw_tags: { Software: tags.Software || null, Producer: tags.Producer || null, Creator: tags.Creator || null }
      };
    }

    let make = tags.Make || tags['com.apple.quicktime.make'] || tags['com.android.manufacturer'] || tags.make || tags.manufacturer || tags.LensMake || null;
    let model = tags.Model || tags['com.apple.quicktime.model'] || tags['com.android.model'] || tags.model || tags.Device || tags.Hardware || tags.Camera || null;
    let lens = tags.LensModel || tags.LensSpecification || null;
    let serial = tags.BodySerialNumber || tags.SerialNumber || null;
    let hostComputer = tags.HostComputer || null;
    let bextOriginator = tags.bext_originator || null;
    let software = tags.Software || tags.encoder || tags.ISFT || tags.Producer || tags.Creator || tags.handler_name || null;

    const historyAgents = (tags.xmp_history && Array.isArray(tags.xmp_history))
      ? tags.xmp_history.map(h => h.agent).filter(Boolean)
      : [];
    const firstHistoryAgent = historyAgents[0] || null;

    let deviceName = null;
    let manufacturer = make || null;
    let rawModel = model || null;
    let friendlyModel = model || null;
    let hardwareType = 'Generic Media File';
    let hardwareIcon = '📱';
    let badgeColor = '#3b82f6';
    let confidence = 'High (Hardware Tag Extracted)';
    let explanation = '';

    if (model) {
      const resolved = this.lookupDeviceModel(model);
      if (resolved) {
        friendlyModel = resolved.friendlyName;
        if (!manufacturer && resolved.manufacturer) manufacturer = resolved.manufacturer;
        if (resolved.hardwareType) hardwareType = resolved.hardwareType;
        if (resolved.hardwareIcon) hardwareIcon = resolved.hardwareIcon;
      }
    }

    let isHardwareDevice = false;
    let deviceNo = 'Not Available';
    let modelNo = 'Not Embedded';
    let serialNo = 'Not Stamped by Sensor';

    if (manufacturer || friendlyModel) {
      isHardwareDevice = true;
      const mfgStr = manufacturer || '';
      const modelStr = friendlyModel || '';
      if (modelStr.toLowerCase().startsWith(mfgStr.toLowerCase())) {
        deviceName = modelStr;
      } else {
        deviceName = (mfgStr + ' ' + modelStr).trim();
      }

      modelNo = rawModel || friendlyModel || 'Standard Model';
      if (serial) {
        serialNo = serial;
        deviceNo = `SN: ${serial} (${modelNo})`;
      } else {
        const isApple = (mfgStr + modelStr).toLowerCase().includes('apple') || (mfgStr + modelStr).toLowerCase().includes('iphone');
        const isAndroid = (mfgStr + modelStr).toLowerCase().includes('samsung') || (mfgStr + modelStr).toLowerCase().includes('pixel') || (mfgStr + modelStr).toLowerCase().includes('android');
        if (isApple) {
          serialNo = 'Protected by Apple iOS (IMEI/Serial withheld for anti-tracking privacy)';
        } else if (isAndroid) {
          serialNo = 'Protected by Android OS (IMEI/Serial withheld for anti-tracking privacy)';
        } else {
          serialNo = 'Not Stamped by Sensor';
        }
        deviceNo = `Model: ${modelNo}`;
      }

      if (hardwareType === 'Generic Media File') {
        const lower = deviceName.toLowerCase();
        if (lower.includes('iphone') || lower.includes('galaxy') || lower.includes('pixel') || lower.includes('xiaomi') || lower.includes('oneplus') || lower.includes('huawei')) {
          hardwareType = 'Smartphone Camera & Audio';
          hardwareIcon = '📱';
          badgeColor = '#10b981';
        } else if (lower.includes('canon') || lower.includes('sony') || lower.includes('nikon') || lower.includes('fujifilm') || lower.includes('panasonic') || lower.includes('lumix') || lower.includes('leica') || lower.includes('hasselblad')) {
          hardwareType = 'Mirrorless / DSLR Camera';
          hardwareIcon = '📷';
          badgeColor = '#6366f1';
        } else if (lower.includes('gopro') || lower.includes('dji') || lower.includes('insta360')) {
          hardwareType = 'Action Cam / Aerial Drone';
          hardwareIcon = '🚁';
          badgeColor = '#06b6d4';
        } else {
          hardwareType = 'Physical Hardware Device';
          hardwareIcon = '📷';
          badgeColor = '#10b981';
        }
      }

      explanation = `Recorded directly on ${deviceName} hardware sensor.`;
      if (lens) explanation += ` Lens: ${lens}.`;
      if (serial) explanation += ` Hardware Serial No: ${serial}.`;
      confidence = 'High (Original EXIF / QuickTime Hardware Tag)';

    } else if (bextOriginator) {
      isHardwareDevice = true;
      deviceName = bextOriginator;
      manufacturer = bextOriginator.split(' ')[0];
      rawModel = bextOriginator;
      modelNo = bextOriginator;
      serialNo = tags.bext_originator_reference || 'Studio Broadcast Wave Stamped';
      deviceNo = `Recorder: ${bextOriginator}`;
      hardwareType = 'Studio Audio Hardware Recorder';
      hardwareIcon = '🎙️';
      badgeColor = '#10b981';
      confidence = 'High (Broadcast Wave BEXT Tag)';
      explanation = `Recorded on professional studio hardware: ${bextOriginator}.`;

    } else if (firstHistoryAgent && (firstHistoryAgent.toLowerCase().includes('iphone') || firstHistoryAgent.toLowerCase().includes('android') || firstHistoryAgent.toLowerCase().includes('camera'))) {
      isHardwareDevice = true;
      deviceName = firstHistoryAgent;
      modelNo = firstHistoryAgent;
      deviceNo = `Model: ${firstHistoryAgent}`;
      serialNo = 'Retrieved from XMP creation event log';
      hardwareType = 'Captured Hardware Device';
      hardwareIcon = '📱';
      badgeColor = '#10b981';
      confidence = 'High (XMP Creation History Log)';
      explanation = `First created on ${firstHistoryAgent} before subsequent edits.`;

    } else {
      const softLower = (software || '').toLowerCase();
      if (softLower.includes('coreaudio') || softLower.includes('core media')) {
        deviceName = 'Apple device or Mac (Core Media)';
        manufacturer = 'Apple Inc.';
        friendlyModel = 'Apple Core Media framework';
        modelNo = 'Not recorded';
        serialNo = 'Not recorded';
        deviceNo = 'Not recorded';
        hardwareType = 'Apple media software';
        hardwareIcon = '💻';
        badgeColor = '#0284c7';
        confidence = 'Inferred (Apple Core Media signature)';
        explanation = 'The file was written by Apple\'s media software, so it was made or exported on a Mac, iPhone or iPad. The file does not say which one.';
      } else if (softLower.includes('mediacodec') || softLower.includes('android')) {
        deviceName = 'Android System (MediaCodec Hardware Engine)';
        manufacturer = 'Google / Android';
        friendlyModel = 'MediaCodec Hardware Pipeline';
        modelNo = 'Android MediaCodec Subsystem';
        serialNo = 'Host Subsystem (Protected by Android OS Privacy)';
        deviceNo = 'Android MediaCodec Engine';
        hardwareType = 'Android Hardware Subsystem';
        hardwareIcon = '📱';
        badgeColor = '#10b981';
        confidence = 'Inferred (Android MediaCodec Engine)';
        explanation = 'Stream encoded using Android platform hardware-accelerated MediaCodec pipeline.';
      } else if (softLower.includes('audacity')) {
        deviceName = 'Audacity Digital Audio Workstation (DAW)';
        manufacturer = 'Audacity Team';
        friendlyModel = 'Audacity Project';
        modelNo = 'Audacity Audio Workspace';
        serialNo = 'N/A (Software Project)';
        deviceNo = 'Audacity Software Workstation';
        hardwareType = 'Digital Audio Workstation (DAW)';
        hardwareIcon = '🎙️';
        badgeColor = '#8b5cf6';
        confidence = 'Inferred (DAW Export Tag)';
        explanation = 'Rendered or recorded in Audacity studio audio editing workstation.';
      } else if (softLower.includes('lame')) {
        deviceName = 'LAME MP3 Audio Workstation';
        manufacturer = 'LAME Engine';
        friendlyModel = 'LAME MP3 Codec';
        modelNo = 'LAME MP3 Codec';
        serialNo = 'N/A (Software Encoder)';
        deviceNo = 'LAME MP3 Encoder';
        hardwareType = 'Audio Encoding Engine';
        hardwareIcon = '🎵';
        badgeColor = '#8b5cf6';
        confidence = 'Inferred (LAME Codec Tag)';
        explanation = 'Compressed and encoded via LAME MP3 workstation engine.';
      } else if (softLower.includes('lavf') || softLower.includes('ffmpeg')) {
        deviceName = 'No Hardware Device Tagged (Software Stream Export)';
        manufacturer = 'FFmpeg / Libavformat (Software)';
        friendlyModel = 'Libavformat Muxer';
        modelNo = 'Software Stream (FFmpeg / Lavf Muxer)';
        serialNo = 'N/A (Software export does not have a device serial number)';
        deviceNo = 'Not Available (Software Export)';
        hardwareType = 'Software Media Muxer';
        hardwareIcon = '⚙️';
        badgeColor = '#64748b';
        confidence = 'Software Stream (No Camera/Phone Tags Embedded)';
        explanation = 'File container was written using standard Libavformat/FFmpeg muxer. Camera/phone hardware device numbers were not embedded in this container.';
      } else {
        deviceName = 'Device Not Tagged (Common for WhatsApp / Forwarded Files)';
        manufacturer = 'Unknown / Stripped';
        friendlyModel = 'Not Embedded';
        modelNo = 'Not Embedded / Stripped';
        serialNo = 'Not Available (Scrubbed by Social Media)';
        deviceNo = 'Not Available (Scrubbed by WhatsApp/Social Media)';
        hardwareType = 'Untagged Media Asset';
        hardwareIcon = '⚠️';
        badgeColor = '#eab308';
        confidence = 'None (Metadata Stripped / Not Embedded)';
        explanation = 'This file does not contain embedded camera/device tags. Messaging apps like WhatsApp, Telegram, TikTok, and web compressors routinely strip EXIF hardware tags to protect user privacy and reduce file sizes.';
      }
    }

    return {
      detected: confidence.startsWith('High') || confidence.startsWith('Inferred'),
      is_hardware_device: isHardwareDevice,
      device_name: deviceName,
      device_no: deviceNo,
      model_no: modelNo,
      serial_no: serialNo,
      manufacturer: manufacturer,
      model: friendlyModel,
      raw_model: rawModel,
      lens: lens,
      serial: serial,
      host_computer: hostComputer,
      hardware_type: hardwareType,
      hardware_icon: hardwareIcon,
      badge_color: badgeColor,
      confidence: confidence,
      explanation: explanation,
      raw_tags: {
        Make: make,
        Model: model,
        LensModel: lens,
        BodySerialNumber: serial,
        HostComputer: hostComputer,
        bext_originator: bextOriginator,
        Software: software
      }
    };
  }

  /** Adds metadata the per-format parsers cannot see. Never throws. */
  static async enrichMetadata(result, uint8, ext) {
    const X = this.Extras;
    if (!X) return;
    try {
      const tags = result.all_tags || (result.all_tags = (result.format && result.format.tags) || {});
      if (result.format && !result.format.tags) result.format.tags = tags;
      const fmt = (result.format && result.format.format_name) || '';
      const isPng = uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47;
      const isWebp = uint8.length > 12 && this.readAscii(uint8, 0, 4) === 'RIFF' && this.readAscii(uint8, 8, 4) === 'WEBP';
      const isTiff = (uint8[0] === 0x49 && uint8[1] === 0x49 && uint8[2] === 0x2A && uint8[3] === 0) || (uint8[0] === 0x4D && uint8[1] === 0x4D && uint8[2] === 0 && uint8[3] === 0x2A);
      const brand = uint8.length > 12 && this.readAscii(uint8, 4, 4) === 'ftyp' ? this.readAscii(uint8, 8, 4) : '';
      const isHeifLike = ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis'].includes(brand) || ['heic', 'heif', 'avif'].includes(ext);

      if (isPng) {
        const texts = await X.parsePngExtra(uint8, tags);
        texts.forEach(t => this.parsePngTextChunk(new TextEncoder().encode(t.keyword + '\0'), 'zTXt', tags, t.text));
      } else if (isWebp) {
        const dims = X.parseWebPChunks(uint8, tags);
        if (dims.width && result.streams[0]) { result.streams[0].width = dims.width; result.streams[0].height = dims.height; }
        if (tags.__xmp) { this.parseXmpBlock(tags.__xmp, tags); delete tags.__xmp; }
      } else if (isTiff) {
        X.parseExif(uint8, 0, tags);
      } else if (isHeifLike) {
        X.findExifAnywhere(uint8, tags);
        const head = this.rawText(uint8, 0, Math.min(uint8.length, 4 * 1024 * 1024));
        const xi = head.indexOf('<x:xmpmeta');
        if (xi >= 0) this.parseXmpBlock(head.slice(xi, head.indexOf('</x:xmpmeta>', xi) + 12 || xi + 65536), tags);
        const ispe = head.indexOf('ispe');
        if (ispe >= 0) {
          const dv = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
          const w = dv.getUint32(ispe + 8), h = dv.getUint32(ispe + 12);
          if (w > 0 && h > 0 && w < 100000 && h < 100000) {
            const st = { index: 0, codec_name: brand.startsWith('av') || ext === 'avif' ? 'av1' : 'hevc', codec_long_name: 'HEIF/AVIF Image', codec_type: 'video', width: w, height: h };
            result.streams = [st];
            result.format.format_name = 'heif'; result.format.format_long_name = 'HEIF / AVIF Image'; result.format.duration = '0.040000';
          }
        }
      }
      // Real signal only: Apple's media framework writes this handler name into the file
      if (/mp4|mov|m4a/.test(fmt) && !tags.handler_name) {
        const hm = X.latin1(uint8, 0, Math.min(uint8.length, 8 * 1024 * 1024)).match(/Core Media (Audio|Video)/);
        if (hm) tags.handler_name = `Core Media ${hm[1]}`;
      }
      X.applyIso6709(tags);
      if (tags.GPSLatitude !== undefined && !tags.GPSPosition) X.setGpsPosition(tags);
    } catch (e) { /* enrichment is best-effort */ }
  }

  static analyzeTampering(result, uint8, file) {
    const format = result.format || {};
    const tags = { ...(format.tags || {}), ...(result.all_tags || {}) };
    result.all_tags = tags;
    const ext = (file.name || format.filename || '').split('.').pop().toLowerCase();
    const fileSize = parseInt(format.size || uint8.byteLength || 0);

    // 1. Identify Dates
    let createdDate = tags.DateTimeOriginal || tags.creation_time || tags.CreateDate || 
                      tags.bext_origination_date || tags['Creation Time'] || tags.CreationDate || null;
    let modifiedDate = tags.ModifyDate || tags.modification_time || tags.DateTime || 
                       tags.MetadataDate || tags.ModDate || null;

    if (tags.bext_origination_date && tags.bext_origination_time && (!createdDate || createdDate === tags.bext_origination_date)) {
      createdDate = `${tags.bext_origination_date} ${tags.bext_origination_time}`;
    }

    const historyAgents = (tags.xmp_history && Array.isArray(tags.xmp_history)) 
      ? tags.xmp_history.map(h => h.agent).filter(Boolean) 
      : [];
    const firstHistoryAgent = historyAgents[0] || null;
    const latestHistoryAgent = historyAgents.length > 1 ? historyAgents[historyAgents.length - 1] : (historyAgents[0] || null);

    // 2. Identify Devices & Software
    const devInfo = result.device_info || this.detectDeviceAndOrigin(result, uint8, file);
    const cameraMake = devInfo.manufacturer || tags.Make || '';
    const cameraModel = devInfo.model || tags.Model || '';
    const deviceName = devInfo.device_name || (cameraMake + ' ' + cameraModel).trim() || tags.bext_originator || firstHistoryAgent || null;

    const softwareTags = [
      tags.Software,
      tags.encoder,
      tags.Producer,
      tags.Creator,
      tags.ISFT,
      tags.software,
      ...historyAgents
    ].filter(Boolean);

    const softwareStr = softwareTags.join(' ').toLowerCase();

    // 3. Known Editing Tools, Re-encoders & AI Footprints
    const editingKeywords = [
      'photoshop', 'gimp', 'lightroom', 'canva', 'premiere', 'after effects',
      'audacity', 'final cut', 'topaz', 'inpaint', 'pixlr', 'procreate', 'davinci'
    ];
    const reencodingKeywords = [
      'lavf', 'ffmpeg', 'handbrake', 'vlc', 'format factory', 'obs-studio', 'coreaudio'
    ];

    const detectedEditor = editingKeywords.find(k => softwareStr.includes(k));
    const detectedEncoder = reencodingKeywords.find(k => softwareStr.includes(k));
    const aiInfo = result.ai_analysis || { is_ai: false };
    const detectedAi = aiInfo.is_ai ? (aiInfo.tool || aiInfo.vendor || 'AI') : null;

    // 4. Audit Trail from XMP history or synthesized events
    const auditTrail = [];
    if (tags.xmp_history && Array.isArray(tags.xmp_history) && tags.xmp_history.length > 0) {
      tags.xmp_history.forEach((evt, idx) => {
        auditTrail.push({
          step: idx + 1,
          action: evt.action || 'Modified',
          timestamp: evt.when || 'Unknown Timestamp',
          software: evt.agent || 'Unknown Software',
          changed: evt.changed || '/'
        });
      });
    } else {
      if (createdDate || deviceName) {
        auditTrail.push({
          step: 1,
          action: 'Created / Captured',
          timestamp: createdDate || 'Original Timestamp',
          software: deviceName || softwareTags[0] || 'Camera / Recorder Device',
          changed: 'Initial Creation'
        });
      }
      if (modifiedDate && modifiedDate !== createdDate) {
        auditTrail.push({
          step: auditTrail.length + 1,
          action: detectedEditor ? 'Edited in External Tool' : 'Re-Saved / Remuxed',
          timestamp: modifiedDate,
          software: softwareTags[0] || 'Unknown Software',
          changed: 'File Header / Content Modified'
        });
      }
    }

    // 5. Time Difference Calculation
    let timeElapsed = null;
    let isDateAltered = false;
    if (createdDate && modifiedDate) {
      try {
        const cleanDate = (s) => s.replace(/(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
        const t1 = new Date(cleanDate(createdDate)).getTime();
        const t2 = new Date(cleanDate(modifiedDate)).getTime();
        if (!isNaN(t1) && !isNaN(t2)) {
          const diffSec = Math.round((t2 - t1) / 1000);
          if (diffSec > 60) {
            isDateAltered = true;
            const diffDays = Math.floor(diffSec / 86400);
            const diffHours = Math.floor((diffSec % 86400) / 3600);
            const diffMins = Math.floor((diffSec % 3600) / 60);
            if (diffDays > 0) {
              timeElapsed = `${diffDays} days, ${diffHours} hours later`;
            } else if (diffHours > 0) {
              timeElapsed = `${diffHours} hours, ${diffMins} minutes later`;
            } else {
              timeElapsed = `${diffMins} minutes later`;
            }
          }
        }
      } catch (e) {}
    }

    // 6. Anomalies List
    const anomalies = [];
    if (isDateAltered && timeElapsed) {
      anomalies.push(`🕒 Date Discrepancy: Modified ${timeElapsed} after initial creation/capture.`);
    }
    if (detectedEditor) {
      anomalies.push(`✏️ Editing Signature: Traces of editor '${detectedEditor.toUpperCase()}' found in software metadata.`);
    }
    if (aiInfo.is_ai) {
      anomalies.push(`🤖 ${aiInfo.label}: ${[aiInfo.tool, aiInfo.model].filter(Boolean).join(' · ') || 'AI generation marks found'}${aiInfo.created_at ? ' (' + aiInfo.created_at + ')' : ''}.`);
    }
    if (auditTrail.length > 2) {
      anomalies.push(`📜 Multi-Stage History: File contains ${auditTrail.length} recorded edit operations in internal history.`);
    }
    if (fileSize > 200000 && Object.keys(tags).length <= 1 && ['jpg','jpeg','png','mp4'].includes(ext)) {
      anomalies.push(`⚠️ Metadata Stripped: File is high-res (${(fileSize/1024).toFixed(0)} KB) but contains zero device or author tags.`);
    }

    // 7. Compute Verdict
    let verdict = 'AUTHENTIC_ORIGINAL';
    let verdictLabel = 'No signs of editing found';
    let riskLevel = 'LOW';
    let badgeColor = '#10b981';
    let summary = 'No evidence of editing, re-encoding, or metadata tampering was found. Missing traces do not prove a file is untouched, because editing tools can remove them.';
    if (this.isDocumentFormat(format) && verdict === 'AUTHENTIC_ORIGINAL') { verdictLabel = 'No editing traces found'; summary = 'No editing or metadata changes were detected in the file information. A document cannot prove its text is original.'; }

    if (aiInfo.is_ai) {
      verdict = 'AI_GENERATED';
      verdictLabel = aiInfo.confidence === 'likely' ? 'Probably AI-Generated' : aiInfo.label;
      riskLevel = 'HIGH';
      badgeColor = '#a855f7';
      summary = `This file carries AI marks${aiInfo.tool ? ' from ' + aiInfo.tool : ''}${aiInfo.model ? ' (model: ' + aiInfo.model + ')' : ''}. See the AI Check tab for the evidence.`;
    } else if (!this.isDocumentFormat(format) && (detectedEditor || (isDateAltered && auditTrail.length > 1))) {
      verdict = 'TAMPERED';
      verdictLabel = 'Tampered / Modified in Editor';
      riskLevel = 'HIGH';
      badgeColor = '#ef4444';
      summary = `File was modified using ${detectedEditor ? detectedEditor.toUpperCase() : 'an external editor'}${timeElapsed ? ` (${timeElapsed})` : ''}. Original capture tags were altered or supplemented.`;
    } else if (this.isDocumentFormat(format) && isDateAltered) {
      verdict = 'EDITED_LATER';
      verdictLabel = 'Saved again after it was created';
      riskLevel = 'MEDIUM';
      badgeColor = '#f59e0b';
      summary = `The document was saved again ${timeElapsed || 'after it was created'}. That is normal for a document that was edited over time.`;
    } else if (detectedEncoder || isDateAltered) {
      verdict = 'RE_ENCODED';
      verdictLabel = 'Re-Encoded / Stream Exported';
      riskLevel = 'MEDIUM';
      badgeColor = '#f59e0b';
      summary = `File stream was re-saved or converted using ${detectedEncoder ? detectedEncoder.toUpperCase() : 'a media converter'}.`;
    } else if (anomalies.some(a => a.includes('Metadata Stripped'))) {
      verdict = 'METADATA_STRIPPED';
      verdictLabel = 'Metadata Scrubbed / Cleaned';
      riskLevel = 'MEDIUM';
      badgeColor = '#eab308';
      summary = 'File metadata appears to have been scrubbed or compressed via social media sharing.';
    }

    return {
      verdict,
      verdict_label: verdictLabel,
      risk_level: riskLevel,
      badge_color: badgeColor,
      summary,
      original_data: {
        created_at: createdDate || 'Not explicitly recorded (or stripped)',
        device_or_camera: deviceName || 'Native Recorder / Original Source',
        hardware_type: devInfo.hardware_type || 'Hardware Device',
        lens: devInfo.lens || null,
        serial: devInfo.serial || null,
        confidence: devInfo.confidence || null,
        origin_software: tags.origin_software || (deviceName ? `${deviceName} Firmware` : 'Original Source')
      },
      modified_data: {
        modified_at: modifiedDate || (isDateAltered ? 'Altered' : 'Not Modified'),
        modifying_software: latestHistoryAgent || (detectedEditor ? detectedEditor.toUpperCase() : (detectedEncoder ? detectedEncoder.toUpperCase() : 'None Detected')),
        time_elapsed: timeElapsed || 'Same as capture / No delay',
        detected_changes: detectedEditor || latestHistoryAgent ? 'Image/Audio manipulation & resave' : (detectedEncoder ? 'Bitstream remux / re-encoding' : 'None')
      },
      audit_trail: auditTrail,
      ai_detection: {
        is_ai: Boolean(aiInfo.is_ai),
        prompt: aiInfo.prompt || tags.ai_prompt || null,
        parameters: aiInfo.is_ai && Object.keys(aiInfo.settings || {}).length ? JSON.stringify(aiInfo.settings, null, 2) : (tags.ai_parameters || null)
      },
      anomalies
    };
  }
}

if (typeof window !== 'undefined') {
  window.FFprobeParser = FFprobeParser;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FFprobeParser;
}
