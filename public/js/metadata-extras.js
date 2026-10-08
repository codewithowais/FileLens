/**
 * FileLens - Extra metadata extractors
 *
 *  - Full EXIF (camera, exposure, lens, UserComment) incl. GPS location
 *  - EXIF discovery inside HEIC / AVIF / WebP / TIFF files
 *  - IPTC (credit, creator, caption, keywords) from JPEG APP13
 *  - PNG compressed text (zTXt, compressed iTXt) and eXIf chunks
 *  - ZIP-based documents: Word / Excel / PowerPoint (OOXML) and OpenDocument
 *  - Apple / QuickTime ISO-6709 location strings
 */
class MetaExtras {
  // ---------------------------------------------------------------- helpers
  /**
   * Decompresses raw-deflate ("deflate-raw") or zlib ("deflate") data.
   * Uses the browser's DecompressionStream when present, otherwise the built-in decoder below.
   */
  static async inflate(bytes, format = 'deflate-raw') {
    if (typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' && typeof Response !== 'undefined') {
      try {
        const ds = new DecompressionStream(format);
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (e) { /* fall through to the JS decoder */ }
    }
    try { return this.inflateSync(bytes, format === 'deflate'); } catch (e) { return null; }
  }

  /** Small DEFLATE decoder (same algorithm as zlib's "puff"). */
  static inflateSync(src, zlibWrapper = false, maxOut = 16 * 1024 * 1024) {
    let pos = zlibWrapper ? 2 : 0, bitBuf = 0, bitCnt = 0;
    let out = new Uint8Array(Math.min(Math.max(src.length * 4, 1024), maxOut)), outPos = 0;
    const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

    const bits = (need) => {
      let val = bitBuf;
      while (bitCnt < need) {
        if (pos >= src.length) throw new Error('out of input');
        val |= src[pos++] << bitCnt; bitCnt += 8;
      }
      bitBuf = val >>> need; bitCnt -= need;
      return val & ((1 << need) - 1);
    };
    const build = (lengths, n) => {
      const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
      for (let i = 0; i < n; i++) count[lengths[i]]++;
      for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
      for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
      return { count, symbol };
    };
    const decode = (h) => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len <= 15; len++) {
        code |= bits(1);
        const count = h.count[len];
        if (code - count < first) return h.symbol[index + (code - first)];
        index += count; first += count; first <<= 1; code <<= 1;
      }
      throw new Error('bad code');
    };
    const put = (b) => {
      if (outPos >= out.length) {
        if (out.length >= maxOut) throw new Error('output too large');
        const bigger = new Uint8Array(Math.min(out.length * 2, maxOut)); bigger.set(out); out = bigger;
      }
      out[outPos++] = b;
    };
    let fixedL = null, fixedD = null;
    const codes = (lencode, distcode) => {
      for (;;) {
        let sym = decode(lencode);
        if (sym < 256) put(sym);
        else if (sym === 256) return;
        else {
          sym -= 257; if (sym >= 29) throw new Error('bad length');
          const len = LBASE[sym] + bits(LEXT[sym]);
          const ds = decode(distcode); if (ds >= 30) throw new Error('bad distance');
          const dist = DBASE[ds] + bits(DEXT[ds]);
          if (dist > outPos) throw new Error('distance too far');
          for (let i = 0; i < len; i++) put(out[outPos - dist]);
        }
      }
    };
    let last;
    do {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > src.length) throw new Error('truncated');
        const len = src[pos] | (src[pos + 1] << 8); pos += 4;
        for (let i = 0; i < len; i++) { if (pos >= src.length) throw new Error('truncated'); put(src[pos++]); }
      } else if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8; for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7; for (let i = 280; i < 288; i++) l[i] = 8;
          fixedL = build(l, 288); fixedD = build(new Uint8Array(30).fill(5), 30);
        }
        codes(fixedL, fixedD);
      } else if (type === 2) {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        const lengths = new Uint8Array(320);
        for (let i = 0; i < ncode; i++) lengths[ORDER[i]] = bits(3);
        const lencode0 = build(lengths.subarray(0, 19), 19);
        const lens = new Uint8Array(nlen + ndist);
        for (let i = 0; i < nlen + ndist;) {
          const sym = decode(lencode0);
          if (sym < 16) lens[i++] = sym;
          else {
            let rep, val = 0;
            if (sym === 16) { if (i === 0) throw new Error('bad repeat'); val = lens[i - 1]; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3); else rep = 11 + bits(7);
            if (i + rep > nlen + ndist) throw new Error('bad repeat');
            while (rep--) lens[i++] = val;
          }
        }
        codes(build(lens.subarray(0, nlen), nlen), build(lens.subarray(nlen), ndist));
      } else throw new Error('bad block');
    } while (!last);
    return out.slice(0, outPos);
  }

  static utf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return String.fromCharCode(...bytes); }
  }

  static latin1(bytes, start, end) {
    let s = '';
    for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  static decimalToDms(v, pos, neg) {
    const hemi = v >= 0 ? pos : neg;
    return `${Math.abs(v).toFixed(6)}° ${hemi}`;
  }

  static setGpsPosition(tags) {
    const lat = parseFloat(tags.GPSLatitude), lon = parseFloat(tags.GPSLongitude);
    if (isFinite(lat) && isFinite(lon)) {
      tags.GPSPosition = `${this.decimalToDms(lat, 'N', 'S')}, ${this.decimalToDms(lon, 'E', 'W')}`;
    }
  }

  // ------------------------------------------------------------------- EXIF
  /**
   * Parses a TIFF/EXIF block starting at `tiffOffset` (the "II*\0" / "MM\0*" header).
   */
  static parseExif(uint8, tiffOffset, tags) {
    try {
      if (tiffOffset < 0 || tiffOffset + 8 > uint8.length) return false;
      const isLE = uint8[tiffOffset] === 0x49 && uint8[tiffOffset + 1] === 0x49;
      const isBE = uint8[tiffOffset] === 0x4D && uint8[tiffOffset + 1] === 0x4D;
      if (!isLE && !isBE) return false;

      const u16 = (o) => (o + 2 > uint8.length ? 0 : isLE ? (uint8[o] | (uint8[o + 1] << 8)) : ((uint8[o] << 8) | uint8[o + 1]));
      const u32 = (o) => (o + 4 > uint8.length ? 0 : isLE
        ? (uint8[o] | (uint8[o + 1] << 8) | (uint8[o + 2] << 16) | (uint8[o + 3] * 0x1000000))
        : ((uint8[o] * 0x1000000) | (uint8[o + 1] << 16) | (uint8[o + 2] << 8) | uint8[o + 3]));
      const s32 = (o) => { const v = u32(o); return v > 0x7FFFFFFF ? v - 0x100000000 : v; };
      const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

      const rational = (o) => { const d = u32(o + 4); return d ? u32(o) / d : 0; };
      const srational = (o) => { const d = s32(o + 4); return d ? s32(o) / d : 0; };

      const readValue = (type, count, valOffset) => {
        const size = (typeSize[type] || 1) * count;
        const dataPtr = size > 4 ? tiffOffset + u32(valOffset) : valOffset;
        if (dataPtr < 0 || dataPtr + size > uint8.length) return null;
        if (type === 2) return this.latin1(uint8, dataPtr, dataPtr + count).replace(/\0+$/, '').trim();
        if (type === 3) { const a = []; for (let i = 0; i < count; i++) a.push(u16(dataPtr + i * 2)); return a; }
        if (type === 4) { const a = []; for (let i = 0; i < count; i++) a.push(u32(dataPtr + i * 4)); return a; }
        if (type === 5) { const a = []; for (let i = 0; i < count; i++) a.push(rational(dataPtr + i * 8)); return a; }
        if (type === 10) { const a = []; for (let i = 0; i < count; i++) a.push(srational(dataPtr + i * 8)); return a; }
        if (type === 1 || type === 7) return uint8.subarray(dataPtr, dataPtr + count);
        return null;
      };

      const decodeUserComment = (bytes) => {
        if (!bytes || bytes.length < 9) return '';
        const prefix = this.latin1(bytes, 0, 8);
        const body = bytes.subarray(8);
        let out = '';
        if (prefix.startsWith('UNICODE')) {
          const tryOrder = (be) => { let s = ''; for (let i = 0; i + 1 < body.length; i += 2) s += String.fromCharCode(be ? (body[i] << 8) | body[i + 1] : (body[i + 1] << 8) | body[i]); return s; };
          const a = tryOrder(isBE), b = tryOrder(!isBE);
          const score = (s) => (s.match(/[\x20-\x7e]/g) || []).length / Math.max(1, s.length);
          out = score(a) >= score(b) ? a : b;
        } else {
          out = this.latin1(body, 0, body.length);
        }
        return out.replace(/\0/g, '').trim();
      };

      const fmtExposure = (v) => (v >= 1 ? `${v.toFixed(1)} s` : v > 0 ? `1/${Math.round(1 / v)} s` : '');
      const visited = new Set();
      let gpsLatRef = 'N', gpsLonRef = 'E', gpsAltRef = 0;

      const dmsToDec = (arr) => (arr && arr.length >= 3 ? arr[0] + arr[1] / 60 + arr[2] / 3600 : null);

      const parseIFD = (ifdOffset, kind, depth) => {
        if (depth > 4 || visited.has(kind + ifdOffset)) return;
        visited.add(kind + ifdOffset);
        const base = tiffOffset + ifdOffset;
        if (base + 2 > uint8.length) return;
        const count = Math.min(u16(base), 512);
        let cur = base + 2;
        for (let i = 0; i < count && cur + 12 <= uint8.length; i++, cur += 12) {
          const tag = u16(cur), type = u16(cur + 2), num = u32(cur + 4), valOffset = cur + 8;

          if (tag === 0x8769 && kind === 'ifd0') { parseIFD(u32(valOffset), 'exif', depth + 1); continue; }
          if (tag === 0x8825 && kind === 'ifd0') { parseIFD(u32(valOffset), 'gps', depth + 1); continue; }
          if (num > 100000) continue;
          const v = readValue(type, num, valOffset);
          if (v === null || v === undefined) continue;
          const first = Array.isArray(v) ? v[0] : v;

          if (kind === 'ifd0') {
            if (tag === 0x010E && v) tags.ImageDescription = v;
            else if (tag === 0x010F && v) tags.Make = v;
            else if (tag === 0x0110 && v) tags.Model = v;
            else if (tag === 0x0112) tags.Orientation = String(first);
            else if (tag === 0x0131 && v) tags.Software = v;
            else if (tag === 0x0132 && v) tags.ModifyDate = v;
            else if (tag === 0x013B && v) tags.Artist = v;
            else if (tag === 0x013C && v) tags.HostComputer = v;
            else if (tag === 0x8298 && v) tags.Copyright = v;
          } else if (kind === 'exif') {
            if (tag === 0x829A) tags.ExposureTime = fmtExposure(first);
            else if (tag === 0x829D) tags.FNumber = `f/${(+first).toFixed(1)}`;
            else if (tag === 0x8827) tags.ISO = String(first);
            else if (tag === 0x9003 && v) tags.DateTimeOriginal = v;
            else if (tag === 0x9004 && v) tags.DateTimeDigitized = v;
            else if (tag === 0x9011 && v) tags.OffsetTimeOriginal = v;
            else if (tag === 0x9204) tags.ExposureBias = `${first > 0 ? '+' : ''}${(+first).toFixed(1)} EV`;
            else if (tag === 0x9209) tags.Flash = (first & 1) ? 'Flash fired' : 'No flash';
            else if (tag === 0x920A) tags.FocalLength = `${(+first).toFixed(1)} mm`;
            else if (tag === 0x9286) { const c = decodeUserComment(v); if (c) tags.UserComment = c; }
            else if (tag === 0xA002) tags.PixelXDimension = String(first);
            else if (tag === 0xA003) tags.PixelYDimension = String(first);
            else if (tag === 0xA405) tags.FocalLengthIn35mm = `${first} mm`;
            else if (tag === 0xA420 && v) tags.ImageUniqueID = v;
            else if (tag === 0xA430 && v) tags.CameraOwnerName = v;
            else if (tag === 0xA431 && v) tags.BodySerialNumber = v;
            else if (tag === 0xA432 && Array.isArray(v)) tags.LensSpecification = v.map(x => +x.toFixed(1)).join(', ');
            else if (tag === 0xA433 && v) tags.LensMake = v;
            else if (tag === 0xA434 && v) tags.LensModel = v;
          } else if (kind === 'gps') {
            if (tag === 0x0001 && v) gpsLatRef = String(v);
            else if (tag === 0x0002) { const d = dmsToDec(v); if (d !== null) tags.GPSLatitude = String(d); }
            else if (tag === 0x0003 && v) gpsLonRef = String(v);
            else if (tag === 0x0004) { const d = dmsToDec(v); if (d !== null) tags.GPSLongitude = String(d); }
            else if (tag === 0x0005) gpsAltRef = first;
            else if (tag === 0x0006) tags.GPSAltitude = `${(gpsAltRef === 1 ? -1 : 1) * (+first)}`;
            else if (tag === 0x0007 && Array.isArray(v)) tags.GPSTimeStamp = v.map(x => String(Math.floor(x)).padStart(2, '0')).join(':') + ' UTC';
            else if (tag === 0x001D && v) tags.GPSDateStamp = v;
          }
        }
        // chain to next IFD (thumbnail) is intentionally ignored
      };

      const first = u32(tiffOffset + 4);
      if (first <= 0 || tiffOffset + first >= uint8.length) return false;
      parseIFD(first, 'ifd0', 0);

      if (tags.GPSLatitude !== undefined && /^S/i.test(gpsLatRef)) tags.GPSLatitude = String(-Math.abs(+tags.GPSLatitude));
      if (tags.GPSLongitude !== undefined && /^W/i.test(gpsLonRef)) tags.GPSLongitude = String(-Math.abs(+tags.GPSLongitude));
      if (tags.GPSAltitude !== undefined) tags.GPSAltitude = `${(+tags.GPSAltitude).toFixed(1)} m`;
      this.setGpsPosition(tags);
      if (tags.GPSLatitude !== undefined) { tags.GPSLatitude = (+tags.GPSLatitude).toFixed(6); tags.GPSLongitude = (+tags.GPSLongitude).toFixed(6); }
      tags.exif_present = 'True';
      return true;
    } catch (e) { return false; }
  }

  /** Finds an embedded EXIF block anywhere in the first/last part of files that don't expose it directly. */
  static findExifAnywhere(uint8, tags) {
    const limit = Math.min(uint8.length, 4 * 1024 * 1024);
    for (let i = 0; i + 14 < limit; i++) {
      // "Exif\0\0" followed by a TIFF header
      if (uint8[i] === 0x45 && uint8[i + 1] === 0x78 && uint8[i + 2] === 0x69 && uint8[i + 3] === 0x66 && uint8[i + 4] === 0 && uint8[i + 5] === 0) {
        const t = i + 6;
        if ((uint8[t] === 0x49 && uint8[t + 1] === 0x49 && uint8[t + 2] === 0x2A) || (uint8[t] === 0x4D && uint8[t + 1] === 0x4D && uint8[t + 3] === 0x2A)) {
          if (this.parseExif(uint8, t, tags)) return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------- IPTC
  static parseIptcFromApp13(uint8, start, end, tags) {
    try {
      let p = start;
      const head = this.latin1(uint8, p, p + 14);
      if (!head.startsWith('Photoshop 3.0')) return;
      p += 14;
      const names = { 5: 'IPTC Title', 25: 'IPTC Keywords', 40: 'IPTC Instructions', 55: 'IPTC Date Created', 80: 'IPTC Creator', 90: 'IPTC City',
        101: 'IPTC Country', 105: 'IPTC Headline', 110: 'IPTC Credit', 115: 'IPTC Source', 116: 'IPTC Copyright', 120: 'IPTC Caption' };
      while (p + 12 < end && this.latin1(uint8, p, p + 4) === '8BIM') {
        const id = (uint8[p + 4] << 8) | uint8[p + 5];
        let q = p + 6;
        const nameLen = uint8[q]; q += 1 + nameLen; if ((1 + nameLen) % 2) q++;
        const size = (uint8[q] * 0x1000000) + (uint8[q + 1] << 16) + (uint8[q + 2] << 8) + uint8[q + 3]; q += 4;
        if (id === 0x0404) {
          let r = q;
          while (r + 5 <= q + size && uint8[r] === 0x1C) {
            const rec = uint8[r + 1], ds = uint8[r + 2], len = (uint8[r + 3] << 8) | uint8[r + 4];
            if (rec === 2 && names[ds] && len > 0) {
              const val = this.utf8(uint8.subarray(r + 5, r + 5 + len)).trim();
              if (ds === 25 && tags[names[ds]]) tags[names[ds]] += ', ' + val; else if (!tags[names[ds]]) tags[names[ds]] = val;
            }
            r += 5 + len;
          }
        }
        p = q + size + (size % 2);
      }
    } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------- WebP chunks
  static parseWebPChunks(uint8, tags) {
    const out = { width: 0, height: 0 };
    let p = 12;
    const le32 = (o) => uint8[o] | (uint8[o + 1] << 8) | (uint8[o + 2] << 16) | (uint8[o + 3] * 0x1000000);
    while (p + 8 <= uint8.length) {
      const type = this.latin1(uint8, p, p + 4);
      const size = le32(p + 4);
      const d = p + 8;
      if (type === 'VP8X') { out.width = 1 + (uint8[d + 4] | (uint8[d + 5] << 8) | (uint8[d + 6] << 16)); out.height = 1 + (uint8[d + 7] | (uint8[d + 8] << 8) | (uint8[d + 9] << 16)); }
      else if (type === 'EXIF') {
        const off = this.latin1(uint8, d, d + 6) === 'Exif\0\0' ? d + 6 : d;
        this.parseExif(uint8, off, tags);
      } else if (type === 'XMP ') {
        tags.__xmp = this.utf8(uint8.subarray(d, Math.min(d + size, uint8.length)));
      }
      if (size < 0 || size > uint8.length) break;
      p = d + size + (size % 2);
    }
    return out;
  }

  // -------------------------------------------------------------------- PNG
  /** Reads compressed PNG text chunks and the eXIf chunk. Returns list of {keyword, text}. */
  static async parsePngExtra(uint8, tags) {
    const texts = [];
    const dv = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    let p = 8;
    while (p + 12 <= uint8.length) {
      const len = dv.getUint32(p);
      const type = this.latin1(uint8, p + 4, p + 8);
      const d = p + 8;
      if (len > uint8.length) break;
      if (type === 'zTXt') {
        let z = d; while (z < d + len && uint8[z] !== 0) z++;
        const keyword = this.latin1(uint8, d, z);
        const body = await this.inflate(uint8.subarray(z + 2, d + len), 'deflate');
        if (body) texts.push({ keyword, text: this.utf8(body) });
      } else if (type === 'iTXt') {
        let z = d; while (z < d + len && uint8[z] !== 0) z++;
        const keyword = this.latin1(uint8, d, z);
        const compFlag = uint8[z + 1];
        let q = z + 3;
        while (q < d + len && uint8[q] !== 0) q++; q++;      // language tag
        while (q < d + len && uint8[q] !== 0) q++; q++;      // translated keyword
        if (compFlag === 1) {
          const body = await this.inflate(uint8.subarray(q, d + len), 'deflate');
          if (body) texts.push({ keyword, text: this.utf8(body) });
        }
      } else if (type === 'eXIf') {
        this.parseExif(uint8, d, tags);
      }
      p = d + len + 4;
    }
    return texts;
  }

  // ------------------------------------------------- Apple ISO-6709 location
  static applyIso6709(tags) {
    const raw = tags.Location || tags['com.apple.quicktime.location.ISO6709'];
    if (!raw) return;
    const m = String(raw).match(/([+-]\d{1,3}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
      tags.GPSLatitude = (+m[1]).toFixed(6);
      tags.GPSLongitude = (+m[2]).toFixed(6);
      if (m[3]) tags.GPSAltitude = `${(+m[3]).toFixed(1)} m`;
      this.setGpsPosition(tags);
    }
  }

  // ------------------------------------------------------- ZIP-based documents
  static readZipEntries(uint8) {
    const dv = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    let eocd = -1;
    for (let i = uint8.length - 22; i >= Math.max(0, uint8.length - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const total = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < total && p + 46 <= uint8.length; i++) {
      if (dv.getUint32(p, true) !== 0x02014B50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = this.utf8(uint8.subarray(p + 46, p + 46 + nlen));
      entries.push({ name, method, csize, usize, offset: lho });
      p += 46 + nlen + elen + clen;
    }
    return entries;
  }

  static async readZipFile(uint8, entry) {
    if (!entry || entry.usize > 2 * 1024 * 1024) return null;
    const dv = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    const o = entry.offset;
    if (o + 30 > uint8.length || dv.getUint32(o, true) !== 0x04034B50) return null;
    const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
    const data = uint8.subarray(start, start + entry.csize);
    if (entry.method === 0) return this.utf8(data);
    if (entry.method === 8) { const out = await this.inflate(data, 'deflate-raw'); return out ? this.utf8(out) : null; }
    return null;
  }

  static xmlText(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() : null;
  }

  /**
   * Parses DOCX / XLSX / PPTX / ODT / ODS / ODP (and plain ZIP) files.
   * Returns a result object shaped like the other parsers, or null if not a ZIP.
   */
  static async parseZipDocument(uint8, filename, fileSize, ext) {
    const entries = this.readZipEntries(uint8);
    if (!entries) return null;
    const names = entries.map(e => e.name);
    const find = (n) => entries.find(e => e.name === n);
    const tags = {};
    let kind = 'zip', kindLong = 'ZIP Archive', icon = '🗜️';

    const isOoxml = names.includes('[Content_Types].xml');
    const mimetype = find('mimetype') ? (await this.readZipFile(uint8, find('mimetype')) || '').trim() : '';

    if (isOoxml) {
      kind = names.some(n => n.startsWith('word/')) ? 'docx' : names.some(n => n.startsWith('xl/')) ? 'xlsx' : names.some(n => n.startsWith('ppt/')) ? 'pptx' : (ext || 'ooxml');
      kindLong = { docx: 'Microsoft Word Document', xlsx: 'Microsoft Excel Workbook', pptx: 'Microsoft PowerPoint Presentation' }[kind] || 'Office Open XML Document';
      const core = await this.readZipFile(uint8, find('docProps/core.xml'));
      const app = await this.readZipFile(uint8, find('docProps/app.xml'));
      if (core) {
        const set = (k, v) => { if (v) tags[k] = v; };
        set('Title', this.xmlText(core, 'dc:title')); set('Subject', this.xmlText(core, 'dc:subject'));
        set('Author', this.xmlText(core, 'dc:creator')); set('LastModifiedBy', this.xmlText(core, 'cp:lastModifiedBy'));
        set('Keywords', this.xmlText(core, 'cp:keywords')); set('Description', this.xmlText(core, 'dc:description'));
        set('Revision', this.xmlText(core, 'cp:revision'));
        set('creation_time', this.xmlText(core, 'dcterms:created')); set('modification_time', this.xmlText(core, 'dcterms:modified'));
        set('LastPrinted', this.xmlText(core, 'cp:lastPrinted'));
      }
      if (app) {
        const set = (k, v) => { if (v) tags[k] = v; };
        const application = this.xmlText(app, 'Application'), version = this.xmlText(app, 'AppVersion');
        set('Application', application); set('AppVersion', version);
        set('Company', this.xmlText(app, 'Company')); set('Template', this.xmlText(app, 'Template'));
        set('Pages', this.xmlText(app, 'Pages')); set('Words', this.xmlText(app, 'Words'));
        set('Slides', this.xmlText(app, 'Slides')); set('TotalEditingTime', this.xmlText(app, 'TotalTime') ? this.xmlText(app, 'TotalTime') + ' min' : null);
        if (application) tags.Software = version ? `${application} ${version}` : application;
      }
      if (!tags.Software && tags.Author) tags.Software = tags.Author;  // e.g. "python-docx" is stored as author
    } else if (mimetype.startsWith('application/vnd.oasis.opendocument')) {
      kind = mimetype.includes('text') ? 'odt' : mimetype.includes('spreadsheet') ? 'ods' : 'odp';
      kindLong = { odt: 'OpenDocument Text', ods: 'OpenDocument Spreadsheet', odp: 'OpenDocument Presentation' }[kind];
      const meta = await this.readZipFile(uint8, find('meta.xml'));
      if (meta) {
        const set = (k, v) => { if (v) tags[k] = v; };
        set('Title', this.xmlText(meta, 'dc:title')); set('Subject', this.xmlText(meta, 'dc:subject'));
        set('Description', this.xmlText(meta, 'dc:description')); set('Keywords', this.xmlText(meta, 'meta:keyword'));
        set('Author', this.xmlText(meta, 'meta:initial-creator')); set('LastModifiedBy', this.xmlText(meta, 'dc:creator'));
        set('creation_time', this.xmlText(meta, 'meta:creation-date')); set('modification_time', this.xmlText(meta, 'dc:date'));
        set('Software', this.xmlText(meta, 'meta:generator')); set('Revision', this.xmlText(meta, 'meta:editing-cycles'));
        const stats = meta.match(/<meta:document-statistic([^>]*)>/i);
        if (stats) { const pc = stats[1].match(/page-count="(\d+)"/); const wc = stats[1].match(/word-count="(\d+)"/); if (pc) tags.Pages = pc[1]; if (wc) tags.Words = wc[1]; }
      }
    }

    const media = names.filter(n => /(^|\/)(media|Pictures)\//i.test(n) && !n.endsWith('/'));
    if (media.length) tags.EmbeddedImages = String(media.length);
    tags.FilesInside = String(entries.length);

    const isDocument = kind !== 'zip';
    return {
      streams: [{ index: 0, codec_name: kind, codec_long_name: kindLong, codec_type: 'data' }],
      format: {
        filename, nb_streams: 1, format_name: kind, format_long_name: kindLong,
        size: fileSize.toString(), bit_rate: '0', probe_score: 100, tags, is_document: isDocument
      },
      container_tree: entries.slice(0, 300).map(e => ({ box: e.name.split('/').pop() || e.name, offset: e.offset, size: e.csize, desc: e.name })),
      all_tags: tags
    };
  }
}

/**
 * Readers for the technical facts inside audio/video containers (sample rate, channels, duration...).
 * They report only what the file states; when a value cannot be determined they return undefined.
 */
class MediaProbe {
  // ---------------------------------------------------------------- MP3
  static mp3Info(u8, start, fileSize) {
    const BR = {
      '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
      '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
      '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    const parseAt = (p) => {
      if (p + 4 > u8.length || u8[p] !== 0xFF || (u8[p + 1] & 0xE0) !== 0xE0) return null;
      const vBits = (u8[p + 1] >> 3) & 3, lBits = (u8[p + 1] >> 1) & 3, brI = (u8[p + 2] >> 4) & 15, srI = (u8[p + 2] >> 2) & 3, pad = (u8[p + 2] >> 1) & 1, mode = (u8[p + 3] >> 6) & 3;
      if (vBits === 1 || lBits === 0 || brI === 0 || brI === 15 || srI === 3) return null;
      const layer = 4 - lBits, mpeg1 = vBits === 3, ver = mpeg1 ? 1 : 2;
      const bitrate = BR[`${ver}-${layer}`][brI] * 1000, sampleRate = SR[vBits][srI];
      const spf = layer === 1 ? 384 : (layer === 3 && !mpeg1 ? 576 : 1152);
      const frameLen = layer === 1 ? (Math.floor(12 * bitrate / sampleRate) + pad) * 4 : Math.floor((spf / 8) * bitrate / sampleRate) + pad;
      return { layer, mpeg1, vBits, bitrate, sampleRate, channels: mode === 3 ? 1 : 2, spf, frameLen, hasCrc: (u8[p + 1] & 1) === 0 };
    };
    let p = start, first = null;
    for (; p + 4 < Math.min(u8.length, start + 262144); p++) {
      const h = parseAt(p);
      if (h && h.frameLen > 0) { const n = parseAt(p + h.frameLen); if (n && n.sampleRate === h.sampleRate && n.layer === h.layer) { first = h; break; } }
    }
    if (!first) return null;
    const out = { sampleRate: first.sampleRate, channels: first.channels, bitrate: first.bitrate, layer: first.layer, mpeg: first.mpeg1 ? '1' : (first.vBits === 0 ? '2.5' : '2'), frameStart: p, vbr: false };
    const side = first.mpeg1 ? (first.channels === 1 ? 17 : 32) : (first.channels === 1 ? 9 : 17);
    const x = p + 4 + (first.hasCrc ? 2 : 0) + side;
    const tag = String.fromCharCode(u8[x] || 0, u8[x + 1] || 0, u8[x + 2] || 0, u8[x + 3] || 0);
    const be32 = (o) => ((u8[o] * 16777216) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3]);
    let frames = null, bytes = null;
    if (tag === 'Xing' || tag === 'Info') { const fl = be32(x + 4); if (fl & 1) frames = be32(x + 8); if (fl & 2) bytes = be32(x + (fl & 1 ? 12 : 8)); out.vbr = tag === 'Xing'; }
    else { const v = p + 4 + 32; if (String.fromCharCode(u8[v], u8[v + 1], u8[v + 2], u8[v + 3]) === 'VBRI') { frames = be32(v + 14); bytes = be32(v + 10); out.vbr = true; } }
    const id3v1 = fileSize >= 128 && String.fromCharCode(u8[fileSize - 128], u8[fileSize - 127], u8[fileSize - 126]) === 'TAG' ? 128 : 0;
    if (frames) { out.duration = frames * first.spf / first.sampleRate; out.bitrate = Math.round(((bytes || (fileSize - p - id3v1)) * 8) / out.duration); }
    else out.duration = ((fileSize - p - id3v1) * 8) / first.bitrate;
    return out;
  }

  // ---------------------------------------------------------------- Ogg
  static oggInfo(u8) {
    const le32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) + u8[o + 3] * 16777216;
    const le64 = (o) => le32(o) + le32(o + 4) * 4294967296;
    const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
    if (ascii(0, 4) !== 'OggS') return null;
    const segs = u8[26], len0 = Array.from(u8.subarray(27, 27 + segs)).reduce((a, b) => a + b, 0), d = 27 + segs;
    const out = { tags: {} };
    if (ascii(d, 8) === 'OpusHead') { out.codec = 'opus'; out.channels = u8[d + 9]; out.preSkip = u8[d + 10] | (u8[d + 11] << 8); out.sampleRate = le32(d + 12); out.decodeRate = 48000; }
    else if (u8[d] === 1 && ascii(d + 1, 6) === 'vorbis') { out.codec = 'vorbis'; out.channels = u8[d + 11]; out.sampleRate = le32(d + 12); out.bitrateNominal = le32(d + 20); out.decodeRate = out.sampleRate; }
    else if (u8[d] === 0x7F && ascii(d + 1, 4) === 'FLAC') { out.codec = 'flac'; }
    else return out;
    // comment header (second packet) - search the first pages for it
    const region = u8.subarray(d + len0, Math.min(u8.length, d + len0 + 131072));
    const rs = (o, n) => new TextDecoder('utf-8').decode(region.subarray(o, o + n));
    const rl = (o) => (region[o] | (region[o + 1] << 8) | (region[o + 2] << 16)) + region[o + 3] * 16777216;
    let h = -1; const marker = out.codec === 'opus' ? 'OpusTags' : '\x03vorbis';
    for (let i = 0; i + marker.length < region.length; i++) { let ok = true; for (let j = 0; j < marker.length; j++) if (region[i + j] !== marker.charCodeAt(j)) { ok = false; break; } if (ok) { h = i + marker.length; break; } }
    if (h >= 0) {
      try {
        const vl = rl(h); out.vendor = rs(h + 4, vl); let q = h + 4 + vl; const n = rl(q); q += 4;
        for (let i = 0; i < n && q + 4 <= region.length; i++) { const l = rl(q); q += 4; const kv = rs(q, l); q += l; const eq = kv.indexOf('='); if (eq > 0) out.tags[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1); }
      } catch (e) { /* damaged comments */ }
    }
    // duration from the last page's granule position
    for (let i = u8.length - 14; i >= Math.max(0, u8.length - 131072); i--) {
      if (u8[i] === 0x4F && u8[i + 1] === 0x67 && u8[i + 2] === 0x67 && u8[i + 3] === 0x53) {
        const g = le64(i + 6);
        if (g > 0 && g < 2 ** 52) out.duration = out.codec === 'opus' ? Math.max(0, g - (out.preSkip || 0)) / 48000 : (out.sampleRate ? g / out.sampleRate : undefined);
        break;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- Matroska / WebM
  static mkvInfo(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const readId = (p) => { const b = u8[p]; if (!b) return null; let n = 1; while (!(b & (0x80 >> (n - 1)))) n++; if (n > 4) return null; let id = 0; for (let i = 0; i < n; i++) id = id * 256 + u8[p + i]; return { id, len: n }; };
    const readSize = (p) => { const b = u8[p]; if (!b) return null; let n = 1; while (!(b & (0x80 >> (n - 1)))) n++; if (n > 8) return null; let v = b & ((0x80 >> (n - 1)) - 1), allOnes = v === ((0x80 >> (n - 1)) - 1); for (let i = 1; i < n; i++) { v = v * 256 + u8[p + i]; if (u8[p + i] !== 255) allOnes = false; } return { size: allOnes ? -1 : v, len: n }; };
    const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[p + i]; return v; };
    const flt = (p, n) => (n === 4 ? dv.getFloat32(p) : n === 8 ? dv.getFloat64(p) : NaN);
    const str = (p, n) => new TextDecoder('utf-8').decode(u8.subarray(p, p + n)).replace(/\0+$/, '');
    const out = { tracks: [], info: {}, timecodeScale: 1000000 };
    const IDS = { EBML: 0x1A45DFA3, SEGMENT: 0x18538067, INFO: 0x1549A966, TRACKS: 0x1654AE6B, CLUSTER: 0x1F43B675, TRACKENTRY: 0xAE, VIDEO: 0xE0, AUDIO: 0xE1 };
    const walk = (start, end, handler, depth) => {
      let p = start;
      while (p + 2 <= end) {
        const id = readId(p); if (!id) break; const sz = readSize(p + id.len); if (!sz) break;
        const body = p + id.len + sz.len, bodyEnd = sz.size < 0 ? end : Math.min(end, body + sz.size);
        if (handler(id.id, body, bodyEnd, depth) === 'stop') return 'stop';
        p = bodyEnd;
      }
    };
    walk(0, u8.length, (id, b, e) => {
      if (id === IDS.EBML) walk(b, e, (i, bb, ee) => { if (i === 0x4282) out.docType = str(bb, ee - bb); });
      else if (id === IDS.SEGMENT) {
        const r = walk(b, e, (i, bb, ee) => {
          if (i === IDS.CLUSTER) return 'stop';
          if (i === IDS.INFO) walk(bb, ee, (x, xb, xe) => {
            if (x === 0x2AD7B1) out.timecodeScale = uint(xb, xe - xb);
            else if (x === 0x4489) out.info.duration = flt(xb, xe - xb);
            else if (x === 0x4D80) out.info.muxingApp = str(xb, xe - xb);
            else if (x === 0x5741) out.info.writingApp = str(xb, xe - xb);
            else if (x === 0x7BA9) out.info.title = str(xb, xe - xb);
            else if (x === 0x4461) { const ns = dv.getBigInt64(xb); out.info.dateUTC = new Date(Date.UTC(2001, 0, 1) + Number(ns / 1000000n)).toISOString(); }
          });
          else if (i === IDS.TRACKS) walk(bb, ee, (t, tb, te) => {
            if (t !== IDS.TRACKENTRY) return;
            const tr = {};
            walk(tb, te, (x, xb, xe) => {
              if (x === 0xD7) tr.number = uint(xb, xe - xb); else if (x === 0x83) tr.type = uint(xb, xe - xb); else if (x === 0x86) tr.codecId = str(xb, xe - xb);
              else if (x === 0x536E) tr.name = str(xb, xe - xb); else if (x === 0x22B59C) tr.language = str(xb, xe - xb); else if (x === 0x23E383) tr.defaultDuration = uint(xb, xe - xb);
              else if (x === IDS.VIDEO) walk(xb, xe, (v, vb, ve) => { if (v === 0xB0) tr.width = uint(vb, ve - vb); else if (v === 0xBA) tr.height = uint(vb, ve - vb); else if (v === 0x54B0) tr.displayWidth = uint(vb, ve - vb); else if (v === 0x54BA) tr.displayHeight = uint(vb, ve - vb); });
              else if (x === IDS.AUDIO) walk(xb, xe, (v, vb, ve) => { if (v === 0xB5) tr.sampleRate = flt(vb, ve - vb); else if (v === 0x9F) tr.channels = uint(vb, ve - vb); else if (v === 0x6264) tr.bitDepth = uint(vb, ve - vb); });
            });
            out.tracks.push(tr);
          });
        });
        return 'stop';
      }
    });
    if (!out.docType && !out.tracks.length && !Object.keys(out.info).length) return null;
    if (out.info.duration) out.duration = out.info.duration * out.timecodeScale / 1e9;
    return out;
  }

  // ---------------------------------------------------------------- AAC (MP4 esds)
  /** Reads the AudioSpecificConfig inside an MP4 'esds' box. `from` is any offset before the box. */
  static aacConfig(u8, from, limit) {
    const end = Math.min(u8.length - 8, limit || from + 400);
    for (let i = from; i < end; i++) {
      if (u8[i] === 0x65 && u8[i + 1] === 0x73 && u8[i + 2] === 0x64 && u8[i + 3] === 0x73) {       // 'esds'
        let p = i + 8;                                                                              // skip version/flags
        const len = () => { let n = 0; for (let k = 0; k < 4; k++) { const b = u8[p++]; n = (n << 7) | (b & 0x7F); if (!(b & 0x80)) break; } return n; };
        if (u8[p++] !== 0x03) return null; len(); p += 2; const fl = u8[p++]; if (fl & 0x80) p += 2; if (fl & 0x40) p += u8[p] + 1; if (fl & 0x20) p += 2;
        if (u8[p++] !== 0x04) return null; len(); const oti = u8[p]; p += 13;
        const avg = ((u8[p - 4] << 24) | (u8[p - 3] << 16) | (u8[p - 2] << 8) | u8[p - 1]) >>> 0;
        if (u8[p++] !== 0x05) return { objectTypeIndication: oti, avgBitrate: avg || undefined };
        const n = len(); const asc = u8.subarray(p, p + n);
        let bit = 0; const bits = (c) => { let v = 0; for (let k = 0; k < c; k++) { v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; } return v; };
        let aot = bits(5); if (aot === 31) aot = 32 + bits(6);
        const fi = bits(4); const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        const sampleRate = fi === 15 ? bits(24) : rates[fi];
        const cc = bits(4);
        return { audioObjectType: aot, sampleRate, channels: cc === 7 ? 8 : (cc >= 1 && cc <= 6 ? cc : undefined), avgBitrate: avg || undefined };
      }
    }
    return null;
  }
}

MetaExtras.Probe = MediaProbe;

if (typeof window !== 'undefined') window.MetaExtras = MetaExtras;
if (typeof module !== 'undefined' && module.exports) module.exports = MetaExtras;
