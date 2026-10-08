/**
 * FileLens - C2PA (Content Credentials) verifier
 *
 * Reads the signed provenance manifest embedded in a file and checks it:
 *   1. The signature (COSE_Sign1) over the claim, using the certificate inside the manifest
 *   2. Every assertion hash listed in the claim
 *   3. The data hash that ties the manifest to the actual file bytes (detects edits after signing)
 *   4. The certificate chain, checked against the official C2PA trust list when it is loaded
 *
 * Everything runs locally (WebCrypto). Nothing is uploaded.
 *
 * Not covered (reported as "not checked", never silently passed): MP4/HEIC "bmff" hashes,
 * "boxes" hashes, certificate revocation (OCSP), and the timestamp authority's own signature.
 */

// ---------------------------------------------------------------------------------------------
// CBOR
// ---------------------------------------------------------------------------------------------
class Cbor {
  static decode(bytes, start = 0) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = start;
    const readLen = (ai) => {
      if (ai < 24) return ai;
      if (ai === 24) return bytes[p++];
      if (ai === 25) { const v = dv.getUint16(p); p += 2; return v; }
      if (ai === 26) { const v = dv.getUint32(p); p += 4; return v; }
      if (ai === 27) { const hi = dv.getUint32(p), lo = dv.getUint32(p + 4); p += 8; return hi * 4294967296 + lo; }
      if (ai === 31) return -1;
      throw new Error('bad CBOR length');
    };
    const item = (depth) => {
      if (depth > 64) throw new Error('CBOR too deep');
      const ib = bytes[p++];
      const major = ib >> 5, ai = ib & 31;
      if (major === 7) {
        if (ai === 20) return false; if (ai === 21) return true; if (ai === 22 || ai === 23) return null;
        if (ai === 25) { const h = dv.getUint16(p); p += 2; const e = (h >> 10) & 31, f = h & 1023; return (h & 0x8000 ? -1 : 1) * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (f + 1024) * 2 ** (e - 25)); }
        if (ai === 26) { const v = dv.getFloat32(p); p += 4; return v; }
        if (ai === 27) { const v = dv.getFloat64(p); p += 8; return v; }
        if (ai === 31) return Cbor.BREAK;
        return undefined;
      }
      const len = readLen(ai);
      switch (major) {
        case 0: return len;
        case 1: return -1 - len;
        case 2: case 3: {
          if (len === -1) { // indefinite-length string: concatenate chunks
            const parts = [];
            for (;;) { const c = item(depth + 1); if (c === Cbor.BREAK) break; parts.push(c); }
            if (major === 3) return parts.join('');
            const total = parts.reduce((a, c) => a + c.length, 0); const out = new Uint8Array(total); let o = 0;
            parts.forEach(c => { out.set(c, o); o += c.length; }); return out;
          }
          const chunk = bytes.subarray(p, p + len); p += len;
          return major === 2 ? new Uint8Array(chunk) : new TextDecoder('utf-8').decode(chunk);
        }
        case 4: {
          const arr = [];
          if (len === -1) { for (;;) { const v = item(depth + 1); if (v === Cbor.BREAK) break; arr.push(v); } }
          else for (let i = 0; i < len; i++) arr.push(item(depth + 1));
          return arr;
        }
        case 5: {
          const map = new Map();
          if (len === -1) { for (;;) { const k = item(depth + 1); if (k === Cbor.BREAK) break; map.set(k, item(depth + 1)); } }
          else for (let i = 0; i < len; i++) { const k = item(depth + 1); map.set(k, item(depth + 1)); }
          return map;
        }
        case 6: return { tag: len, value: item(depth + 1) };
        default: throw new Error('bad CBOR');
      }
    };
    const value = item(0);
    return { value, end: p };
  }

  static head(major, n) {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
    return [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }

  /** CBOR encoding of the COSE Sig_structure ["Signature1", protected, external_aad, payload]. */
  static sigStructure(protectedBytes, payload) {
    const text = new TextEncoder().encode('Signature1');
    const parts = [Uint8Array.from([0x84]), Uint8Array.from(Cbor.head(3, text.length)), text,
      Uint8Array.from(Cbor.head(2, protectedBytes.length)), protectedBytes, Uint8Array.from([0x40]),
      Uint8Array.from(Cbor.head(2, payload.length)), payload];
    const total = parts.reduce((a, c) => a + c.length, 0); const out = new Uint8Array(total); let o = 0;
    parts.forEach(c => { out.set(c, o); o += c.length; });
    return out;
  }

  static get(map, key) { return map instanceof Map ? map.get(key) : undefined; }
}
Cbor.BREAK = Symbol('break');

// ---------------------------------------------------------------------------------------------
// ASN.1 DER / X.509 (just what is needed)
// ---------------------------------------------------------------------------------------------
class Der {
  static read(buf, pos) {
    const tag = buf[pos]; let len = buf[pos + 1]; let hdr = 2;
    if (len & 0x80) { const n = len & 0x7F; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i]; hdr = 2 + n; }
    return { tag, hdr, len, start: pos, body: pos + hdr, end: pos + hdr + len };
  }
  static children(buf, node) { const out = []; let p = node.body; while (p < node.end) { const c = Der.read(buf, p); out.push(c); p = c.end; } return out; }
  static oid(buf, node) {
    const b = buf.subarray(node.body, node.end); const parts = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0;
    for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 127); if (!(b[i] & 128)) { parts.push(v); v = 0; } }
    return parts.join('.');
  }
  static string(buf, node) { return new TextDecoder(node.tag === 0x1E ? 'utf-16be' : 'utf-8').decode(buf.subarray(node.body, node.end)); }
  static time(buf, node) {
    const s = new TextDecoder().decode(buf.subarray(node.body, node.end));
    let m;
    if (node.tag === 0x17 && (m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/))) { const yy = +m[1]; return `${yy >= 50 ? 1900 + yy : 2000 + yy}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}Z`; }
    if (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    return s;
  }
  static wrap(tag, body) {
    const n = body.length; const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
    const out = new Uint8Array(1 + len.length + n); out[0] = tag; out.set(len, 1); out.set(body, 1 + len.length); return out;
  }
  /** RSA keys labelled id-RSASSA-PSS are re-labelled rsaEncryption, which every WebCrypto accepts. */
  static normalizeRsaSpki(spki) {
    try {
      const seq = Der.read(spki, 0); const [alg, bits] = Der.children(spki, seq);
      const oid = Der.oid(spki, Der.children(spki, alg)[0]);
      if (oid !== '1.2.840.113549.1.1.10') return spki;
      const algId = Uint8Array.from([0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00]);
      const bitsRaw = spki.subarray(bits.start, bits.end);
      const body = new Uint8Array(algId.length + bitsRaw.length); body.set(algId, 0); body.set(bitsRaw, algId.length);
      return Der.wrap(0x30, body);
    } catch (e) { return spki; }
  }
  /** ECDSA signature in DER (SEQUENCE{r,s}) -> raw r||s of fixed size, as WebCrypto expects. */
  static ecdsaToRaw(buf, size) {
    const seq = Der.read(buf, 0); const [r, s] = Der.children(buf, seq);
    const fix = (n) => { let b = buf.subarray(n.body, n.end); while (b.length > size && b[0] === 0) b = b.subarray(1); const out = new Uint8Array(size); out.set(b, size - b.length); return out; };
    const out = new Uint8Array(size * 2); out.set(fix(r), 0); out.set(fix(s), size); return out;
  }
}

const OID_NAMES = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.8': 'ST', '2.5.4.7': 'L' };
const SIG_ALGS = {
  '1.2.840.10045.4.3.2': { kind: 'ecdsa', hash: 'SHA-256' }, '1.2.840.10045.4.3.3': { kind: 'ecdsa', hash: 'SHA-384' }, '1.2.840.10045.4.3.4': { kind: 'ecdsa', hash: 'SHA-512' },
  '1.2.840.113549.1.1.11': { kind: 'rsa', hash: 'SHA-256' }, '1.2.840.113549.1.1.12': { kind: 'rsa', hash: 'SHA-384' }, '1.2.840.113549.1.1.13': { kind: 'rsa', hash: 'SHA-512' },
  '1.2.840.113549.1.1.10': { kind: 'pss' }, '1.3.101.112': { kind: 'ed25519' }
};
const HASH_OIDS = { '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512', '1.3.14.3.2.26': 'SHA-1' };

class X509 {
  static parse(der) {
    const cert = Der.read(der, 0); const [tbs, sigAlg, sigBits] = Der.children(der, cert);
    const f = Der.children(der, tbs); let i = 0;
    if (f[0].tag === 0xA0) i++;                 // explicit version
    const serial = f[i++]; const tbsSigAlg = f[i++]; const issuer = f[i++]; const validity = f[i++]; const subject = f[i++]; const spki = f[i++];
    const name = (n) => {
      const out = {};
      Der.children(der, n).forEach(rdn => Der.children(der, rdn).forEach(atv => {
        const [o, v] = Der.children(der, atv); const key = OID_NAMES[Der.oid(der, o)]; if (key && !out[key]) out[key] = Der.string(der, v);
      }));
      return out;
    };
    const [nb, na] = Der.children(der, validity);
    const sa = Der.children(der, sigAlg);
    const algOid = Der.oid(der, sa[0]);
    let pss = null;
    if (algOid === '1.2.840.113549.1.1.10' && sa[1]) {            // RSASSA-PSS parameters
      pss = { hash: 'SHA-1', salt: 20 };
      Der.children(der, sa[1]).forEach(p => {
        const inner = Der.children(der, p)[0];
        if (p.tag === 0xA0) pss.hash = HASH_OIDS[Der.oid(der, Der.children(der, inner)[0])] || pss.hash;
        if (p.tag === 0xA2) pss.salt = der[inner.body] !== undefined ? parseInt(Array.from(der.subarray(inner.body, inner.end)).map(b => b.toString(16).padStart(2, '0')).join(''), 16) : 20;
      });
    }
    const sigBody = der.subarray(sigBits.body + 1, sigBits.end);
    return {
      der, tbs: der.subarray(tbs.start, tbs.end), spki: der.subarray(spki.start, spki.end),
      subjectDer: der.subarray(subject.start, subject.end), issuerDer: der.subarray(issuer.start, issuer.end),
      subject: name(subject), issuer: name(issuer), notBefore: Der.time(der, nb), notAfter: Der.time(der, na),
      sigAlgOid: algOid, pss, signature: sigBody
    };
  }
  static label(n) { return [n.CN, n.O].filter(Boolean).join(' · ') || 'Unknown'; }
}

// ---------------------------------------------------------------------------------------------
// JUMBF
// ---------------------------------------------------------------------------------------------
class Jumbf {
  static u32(b, o) { return ((b[o] * 16777216) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]); }
  static type(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  /** Parses sibling boxes in [start,end). Superboxes ('jumb') are parsed recursively. */
  static parse(b, start, end, depth = 0) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = Jumbf.u32(b, p); const type = Jumbf.type(b, p + 4); let hdr = 8;
      if (size === 1) { size = Jumbf.u32(b, p + 8) * 4294967296 + Jumbf.u32(b, p + 12); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      const box = { type, start: p, hdr, body: p + hdr, end: p + size };
      if (type === 'jumb' && depth < 12) {
        const kids = Jumbf.parse(b, box.body, box.end, depth + 1);
        const jumd = kids.find(k => k.type === 'jumd');
        if (jumd) {
          const uuid = Array.from(b.subarray(jumd.body, jumd.body + 16)).map(x => x.toString(16).padStart(2, '0')).join('');
          let q = jumd.body + 17, label = '';
          while (q < jumd.end && b[q] !== 0) label += String.fromCharCode(b[q++]);
          box.uuid = uuid; box.label = label;
        }
        box.children = kids.filter(k => k.type !== 'jumd');
      }
      out.push(box);
      p += size;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Locating the manifest store inside different file types
// ---------------------------------------------------------------------------------------------
class C2paLocator {
  static concat(parts) { const n = parts.reduce((a, c) => a + c.length, 0); const o = new Uint8Array(n); let p = 0; parts.forEach(c => { o.set(c, p); p += c.length; }); return o; }

  static find(u8) {
    return this.fromJpeg(u8) || this.fromPng(u8) || this.fromBmff(u8) || this.scan(u8);
  }

  static fromJpeg(u8) {
    if (!(u8[0] === 0xFF && u8[1] === 0xD8)) return null;
    const groups = new Map(); let p = 2;
    while (p + 4 <= u8.length && u8[p] === 0xFF) {
      const m = u8[p + 1]; const len = (u8[p + 2] << 8) | u8[p + 3];
      if (m === 0xDA || len < 2) break;
      if (m === 0xEB && u8[p + 4] === 0x4A && u8[p + 5] === 0x50) {
        const en = (u8[p + 6] << 8) | u8[p + 7]; const z = Jumbf.u32(u8, p + 8);
        const payload = u8.subarray(p + 12, p + 2 + len);
        if (!groups.has(en)) groups.set(en, []);
        groups.get(en).push({ z, payload, segStart: p, segEnd: p + 2 + len });
      }
      p += 2 + len;
    }
    for (const parts of groups.values()) {
      parts.sort((a, b) => a.z - b.z);
      if (!parts.length || Jumbf.type(parts[0].payload, 4) !== 'jumb') continue;
      // Continuation segments repeat the 8-byte box header; drop it.
      const joined = this.concat(parts.map((s, i) => (i === 0 ? s.payload : s.payload.subarray(8))));
      return { store: joined, container: 'JPEG (APP11)', ranges: parts.map(s => [s.segStart, s.segEnd]) };
    }
    return null;
  }

  static fromPng(u8) {
    if (!(u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47)) return null;
    let p = 8;
    while (p + 12 <= u8.length) {
      const len = Jumbf.u32(u8, p); const type = Jumbf.type(u8, p + 4);
      if (type === 'caBX') return { store: u8.subarray(p + 8, p + 8 + len), container: 'PNG (caBX chunk)', ranges: [[p, p + 12 + len]] };
      p += 12 + len;
    }
    return null;
  }

  static fromBmff(u8) {
    if (!(u8.length > 12 && Jumbf.type(u8, 4) === 'ftyp')) return null;
    const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
    let p = 0;
    while (p + 8 <= u8.length) {
      let size = Jumbf.u32(u8, p); const type = Jumbf.type(u8, p + 4); let hdr = 8;
      if (size === 1) { size = Jumbf.u32(u8, p + 8) * 4294967296 + Jumbf.u32(u8, p + 12); hdr = 16; } else if (size === 0) size = u8.length - p;
      if (size < hdr) break;
      if (type === 'uuid') {
        const id = Array.from(u8.subarray(p + hdr, p + hdr + 16)).map(x => x.toString(16).padStart(2, '0')).join('');
        if (id === C2PA_UUID) {
          let q = p + hdr + 16 + 4; let purpose = ''; while (q < p + size && u8[q] !== 0) purpose += String.fromCharCode(u8[q++]); q++;
          if (purpose === 'manifest') { q += 8; return { store: u8.subarray(q, p + size), container: 'MP4/HEIC (uuid box)', ranges: [[p, p + size]], bmff: true }; }
        }
      }
      p += size;
    }
    return null;
  }

  /** Last resort for PDF / WAV / other containers: look for a JUMBF 'jumb' box labelled c2pa. */
  static scan(u8) {
    const limit = u8.length;
    for (let i = 4; i + 40 < limit; i++) {
      if (u8[i] === 0x6A && u8[i + 1] === 0x75 && u8[i + 2] === 0x6D && u8[i + 3] === 0x62 && u8[i + 8 + 4 - 4 + 0] !== undefined &&
          u8[i + 8] === 0 && u8[i + 12] === 0x6A && u8[i + 13] === 0x75 && u8[i + 14] === 0x6D && u8[i + 15] === 0x64 &&
          u8[i + 16] === 0x63 && u8[i + 17] === 0x32 && u8[i + 18] === 0x70 && u8[i + 19] === 0x61) {
        const size = Jumbf.u32(u8, i - 4);
        if (size > 32 && i - 4 + size <= limit) return { store: u8.subarray(i - 4, i - 4 + size), container: 'embedded JUMBF', ranges: [[i - 4, i - 4 + size]] };
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// ISO BMFF (MP4 / MOV / HEIC / AVIF) box tree and the C2PA "bmff" content hash
// ---------------------------------------------------------------------------------------------
class Bmff {
  static get CONTAINERS() { return ['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'moof', 'traf', 'mfra', 'mvex', 'sinf', 'schi']; }

  /** Parses the box tree. Returns { top: [...], byPath: Map(path -> boxes) }. */
  static parseTree(u8) {
    const byPath = new Map(); const top = [];
    const walk = (start, end, parentPath, depth, sink) => {
      let p = start;
      while (p + 8 <= end) {
        let size = Jumbf.u32(u8, p); const type = Jumbf.type(u8, p + 4); let hdr = 8;
        if (size === 1) { size = Jumbf.u32(u8, p + 8) * 4294967296 + Jumbf.u32(u8, p + 12); hdr = 16; }
        else if (size === 0) size = end - p;
        if (size < hdr || p + size > end) break;
        const path = parentPath + '/' + type;
        const box = { type, offset: p, size, hdr, path };
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push(box);
        sink.push(box);
        if (depth < 8 && (this.CONTAINERS.includes(type) || type === 'meta')) {
          box.children = [];
          walk(p + hdr + (type === 'meta' ? 4 : 0), p + size, path, depth + 1, box.children);
        }
        p += size;
      }
    };
    walk(0, u8.length, '', 0, top);
    return { top, byPath };
  }

  static be64(n) { const b = new Uint8Array(8); const hi = Math.floor(n / 4294967296), lo = n >>> 0; for (let i = 0; i < 4; i++) { b[i] = (hi >>> (24 - 8 * i)) & 255; b[4 + i] = (lo >>> (24 - 8 * i)) & 255; } return b; }

  /**
   * Builds the byte stream that the "c2pa.hash.bmff" assertion hashes: the file minus the excluded
   * boxes, and (for v2/v3) with the 8-byte file offset of each remaining top-level box inserted.
   */
  static hashInput(u8, assertion, version) {
    const field = (o, k) => (o instanceof Map ? o.get(k) : o && o[k]);
    const { top, byPath } = this.parseTree(u8);
    const tlOffsets = top.map(b => b.offset).sort((a, b) => a - b);
    const excl = [];
    for (const ex of (field(assertion, 'exclusions') || [])) {
      const xpath = field(ex, 'xpath'); const boxes = byPath.get(xpath) || [];
      for (const box of boxes) {
        const length = field(ex, 'length'); if (length !== undefined && length !== null && Number(length) !== box.size) continue;
        const ver = field(ex, 'version'), flags = field(ex, 'flags');
        if (ver !== undefined && ver !== null && u8[box.offset + box.hdr] !== Number(ver)) continue;
        if (flags && flags.length >= 3) {
          const want = (flags[0] << 16) | (flags[1] << 8) | flags[2];
          const have = (u8[box.offset + box.hdr + 1] << 16) | (u8[box.offset + box.hdr + 2] << 8) | u8[box.offset + box.hdr + 3];
          const exact = field(ex, 'exact'); const isExact = exact === undefined || exact === null ? true : exact;
          if (isExact ? want !== have : ((want | have) !== want)) continue;
        }
        const dataMaps = field(ex, 'data');
        if (dataMaps && dataMaps.length) {
          let all = true;
          for (const dm of dataMaps) {
            const off = box.offset + Number(field(dm, 'offset')); const val = field(dm, 'value');
            for (let i = 0; i < val.length; i++) if (u8[off + i] !== val[i]) { all = false; break; }
            if (!all) break;
          }
          if (!all) continue;
        }
        const subset = field(ex, 'subset');
        if (subset && subset.length) {
          for (const sm of subset) {
            const so = Number(field(sm, 'offset')), sl = Number(field(sm, 'length'));
            if (so > box.size) continue;
            excl.push([box.offset + so, sl === 0 ? box.size - so : Math.min(sl, box.size - so)]);
          }
        } else {
          excl.push([box.offset, box.size]);
          const i = tlOffsets.indexOf(box.offset); if (i >= 0) tlOffsets.splice(i, 1);
        }
      }
    }
    excl.sort((a, b) => a[0] - b[0]);
    // included ranges = whole file minus exclusions
    const included = []; let pos = 0;
    for (const [st, ln] of excl) { if (ln <= 0) continue; if (st > pos) included.push([pos, st - 1]); pos = Math.max(pos, st + ln); }
    if (pos < u8.length) included.push([pos, u8.length - 1]);
    if (!excl.length) { included.length = 0; included.push([0, u8.length - 1]); }
    if (excl.length && excl[excl.length - 1][0] + excl[excl.length - 1][1] > u8.length) throw new Error('exclusion range exceeds file');

    const items = [];
    if (version > 1) {
      for (const r of included) {
        let cur = r[0];
        for (const os of tlOffsets) {
          if (os >= cur && os <= r[1]) { if (os > cur) items.push({ s: cur, e: os - 1 }); items.push({ marker: os, s: os, e: os }); cur = os; }
        }
        items.push({ s: cur, e: r[1] });
      }
      // top-level boxes whose first byte is not hashed (partially excluded) still contribute their offset
      const firstStart = items.length ? items[0].s : 0, lastEnd = items.length ? items[items.length - 1].e : u8.length - 1;
      for (const os of tlOffsets) {
        if (!items.some(it => os >= it.s && os <= it.e) && os > firstStart && os < lastEnd) items.push({ marker: os, s: os, e: os });
      }
      items.sort((a, b) => a.s - b.s);
    } else included.forEach(r => items.push({ s: r[0], e: r[1] }));

    const parts = [];
    for (const it of items) parts.push(it.marker !== undefined ? this.be64(it.marker) : u8.subarray(it.s, it.e + 1));
    return C2paLocator.concat(parts);
  }
}

// ---------------------------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------------------------
class C2paVerifier {
  static get subtle() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
    try { return require('crypto').webcrypto.subtle; } catch (e) { return null; }
  }

  static async digest(alg, bytes) {
    const name = ({ sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512', 'SHA-256': 'SHA-256', 'SHA-384': 'SHA-384', 'SHA-512': 'SHA-512' })[alg];
    if (!name) throw new Error('unsupported hash ' + alg);
    return new Uint8Array(await this.subtle.digest(name, bytes));
  }

  static eq(a, b) { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  static hex(b) { return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(''); }

  /** Replaces the trust list (base64 DER certificates). Used for updated lists and in tests. */
  static setTrustAnchors(base64List) { this._anchors = null; this._override = base64List; }

  static trustAnchors() {
    if (this._anchors) return this._anchors;
    let list = [];
    try { list = this._override || ((typeof C2PA_TRUST_ANCHORS !== 'undefined') ? C2PA_TRUST_ANCHORS : require('./c2pa-trust-anchors.js')); } catch (e) { list = []; }
    this._anchors = list.map(b64 => {
      try { const der = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(b64, 'base64')) : Uint8Array.from(atob(b64), c => c.charCodeAt(0)); return X509.parse(der); } catch (e) { return null; }
    }).filter(Boolean);
    return this._anchors;
  }

  /** Verifies a certificate's signature using the issuer's public key (SPKI). */
  static async verifyCertSignature(cert, issuer) {
    const info = SIG_ALGS[cert.sigAlgOid];
    if (!info) return null;
    const s = this.subtle;
    try {
      if (info.kind === 'ecdsa') {
        const curve = issuer.spki.length > 130 ? (issuer.spki.length > 150 ? 'P-521' : 'P-384') : 'P-256';
        const size = curve === 'P-256' ? 32 : curve === 'P-384' ? 48 : 66;
        const key = await s.importKey('spki', issuer.spki, { name: 'ECDSA', namedCurve: curve }, false, ['verify']);
        return await s.verify({ name: 'ECDSA', hash: info.hash }, key, Der.ecdsaToRaw(cert.signature, size), cert.tbs);
      }
      if (info.kind === 'rsa') {
        const key = await s.importKey('spki', Der.normalizeRsaSpki(issuer.spki), { name: 'RSASSA-PKCS1-v1_5', hash: info.hash }, false, ['verify']);
        return await s.verify('RSASSA-PKCS1-v1_5', key, cert.signature, cert.tbs);
      }
      if (info.kind === 'pss') {
        const hash = (cert.pss && cert.pss.hash) || 'SHA-256';
        const key = await s.importKey('spki', Der.normalizeRsaSpki(issuer.spki), { name: 'RSA-PSS', hash }, false, ['verify']);
        return await s.verify({ name: 'RSA-PSS', saltLength: (cert.pss && cert.pss.salt) || 32 }, key, cert.signature, cert.tbs);
      }
      if (info.kind === 'ed25519') {
        const key = await s.importKey('spki', issuer.spki, { name: 'Ed25519' }, false, ['verify']);
        return await s.verify('Ed25519', key, cert.signature, cert.tbs);
      }
    } catch (e) { return null; }
    return null;
  }

  static async verifyCose(coseAlg, leaf, protectedBytes, payload, signature) {
    const s = this.subtle; const toBeSigned = Cbor.sigStructure(protectedBytes, payload);
    const spec = {
      '-7': { imp: { name: 'ECDSA', namedCurve: 'P-256' }, ver: { name: 'ECDSA', hash: 'SHA-256' } },
      '-35': { imp: { name: 'ECDSA', namedCurve: 'P-384' }, ver: { name: 'ECDSA', hash: 'SHA-384' } },
      '-36': { imp: { name: 'ECDSA', namedCurve: 'P-521' }, ver: { name: 'ECDSA', hash: 'SHA-512' } },
      '-37': { imp: { name: 'RSA-PSS', hash: 'SHA-256' }, ver: { name: 'RSA-PSS', saltLength: 32 } },
      '-38': { imp: { name: 'RSA-PSS', hash: 'SHA-384' }, ver: { name: 'RSA-PSS', saltLength: 48 } },
      '-39': { imp: { name: 'RSA-PSS', hash: 'SHA-512' }, ver: { name: 'RSA-PSS', saltLength: 64 } },
      '-8': { imp: { name: 'Ed25519' }, ver: { name: 'Ed25519' } }
    }[String(coseAlg)];
    if (!spec) return { ok: null, note: `Signature algorithm ${coseAlg} is not supported by this browser` };
    try {
      const key = await s.importKey('spki', Der.normalizeRsaSpki(leaf.spki), spec.imp, false, ['verify']);
      const ok = await s.verify(spec.ver, key, signature, toBeSigned);
      return { ok };
    } catch (e) { return { ok: null, note: 'Could not run the signature check here (' + (e.message || e) + ')' }; }
  }

  static timestampFromSigTst(unprot) {
    try {
      const tst = Cbor.get(unprot, 'sigTst2') || Cbor.get(unprot, 'sigTst');
      const tokens = tst && Cbor.get(tst, 'tstTokens');
      const val = tokens && tokens[0] && Cbor.get(tokens[0], 'val');
      if (!val) return null;
      for (let i = 0; i + 17 < val.length; i++) {
        if (val[i] === 0x18 && val[i + 1] === 0x0F && val[i + 2] >= 0x32 && val[i + 2] <= 0x33) {
          const s = new TextDecoder().decode(val.subarray(i + 2, i + 17));
          if (/^\d{14}Z$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  static decodeAssertion(u8, box) {
    const content = (box.children || []).find(c => ['cbor', 'json', 'bfdb', 'bidb'].includes(c.type));
    if (!content) return { raw: null };
    const data = u8.subarray(content.body, content.end);
    try {
      if (content.type === 'cbor') return { type: 'cbor', value: Cbor.decode(data).value };
      if (content.type === 'json') return { type: 'json', value: JSON.parse(new TextDecoder().decode(data)) };
    } catch (e) { /* fall through */ }
    return { type: content.type, value: null };
  }

  /**
   * @returns {Promise<object>} report, always with `present` and `status`.
   */
  /** Checks an earlier ("ingredient") manifest on its own: assertion hashes and its signature. */
  static async checkEarlierManifest(store, box) {
    const sub = (b, label) => (b.children || []).find(c => c.type === 'jumb' && c.label === label);
    const out = { label: box.label, ok: true, problems: [] };
    try {
      const assertionStore = sub(box, 'c2pa.assertions'); const claimBox = sub(box, 'c2pa.claim') || sub(box, 'c2pa.claim.v2'); const sigBox = sub(box, 'c2pa.signature');
      if (!claimBox || !sigBox) throw new Error('claim or signature missing');
      const cc = claimBox.children.find(c => c.type === 'cbor'); const claimBytes = store.subarray(cc.body, cc.end);
      const claim = Cbor.decode(claimBytes).value; const g = (k) => Cbor.get(claim, k);
      const byLabel = new Map(((assertionStore && assertionStore.children) || []).filter(c => c.type === 'jumb').map(b => [b.label, b]));
      for (const ref of [].concat(g('assertions') || [], g('created_assertions') || [], g('gathered_assertions') || [])) {
        const label = (Cbor.get(ref, 'url') || '').split('/').pop(); const ab = byLabel.get(label);
        if (!ab) { out.problems.push(`assertion ${label} missing`); continue; }
        const actual = await this.digest(Cbor.get(ref, 'alg') || g('alg') || 'sha256', store.subarray(ab.body, ab.end));
        if (!this.eq(actual, Cbor.get(ref, 'hash'))) out.problems.push(`assertion ${label} altered`);
      }
      const sc = sigBox.children.find(c => c.type === 'cbor');
      let cose = Cbor.decode(store.subarray(sc.body, sc.end)).value; if (cose && cose.tag === 18) cose = cose.value;
      const [pb, unprot, pl, sig] = cose; const prot = pb.length ? Cbor.decode(pb).value : new Map();
      const x5 = Cbor.get(prot, 33) || Cbor.get(unprot, 33) || Cbor.get(unprot, 'x5chain') || Cbor.get(prot, 'x5chain');
      const leaf = X509.parse((Array.isArray(x5) ? x5 : [x5])[0]);
      const sv = await this.verifyCose(Cbor.get(prot, 1), leaf, pb, pl && pl.length ? pl : claimBytes, sig);
      if (sv.ok === false) out.problems.push('signature invalid'); else if (sv.ok === null) out.unchecked = true;
      out.signer = leaf.subject.CN || leaf.subject.O || null;
    } catch (e) { out.problems.push('unreadable: ' + (e.message || e)); }
    out.ok = out.problems.length === 0;
    return out;
  }

  static async verify(u8, options = {}) {
    const report = { present: false, status: 'none', checks: [], signer: null, time: null, claim: null, actions: [], ai: { marked: false, sourceTypes: [] }, manifests: 0, container: null };
    const check = (name, ok, note) => report.checks.push({ name, ok, note: note || '' });
    let located;
    try { located = C2paLocator.find(u8); } catch (e) { located = null; }
    if (!located) return report;
    report.present = true; report.container = located.container;

    try {
      const nodes = Jumbf.parse(located.store, 0, located.store.length);
      const storeBox = nodes.find(n => n.type === 'jumb' && n.label === 'c2pa');
      if (!storeBox) throw new Error('no C2PA manifest store');
      const store = located.store;
      const manifests = (storeBox.children || []).filter(c => c.type === 'jumb');
      report.manifests = manifests.length;
      const active = manifests[manifests.length - 1];
      if (!active) throw new Error('no manifest');
      const sub = (box, label) => (box.children || []).find(c => c.type === 'jumb' && c.label === label);
      const assertionStore = sub(active, 'c2pa.assertions');
      const claimBox = sub(active, 'c2pa.claim') || sub(active, 'c2pa.claim.v2');
      const sigBox = sub(active, 'c2pa.signature');
      if (!claimBox || !sigBox) throw new Error('manifest is missing its claim or signature');

      // ---- claim ----
      const claimContent = claimBox.children.find(c => c.type === 'cbor');
      const claimBytes = store.subarray(claimContent.body, claimContent.end);
      const claim = Cbor.decode(claimBytes).value;
      const g = (k) => Cbor.get(claim, k);
      const cgi = g('claim_generator_info');
      const cgInfo = Array.isArray(cgi) ? cgi[0] : cgi;
      report.claim = {
        generator: (cgInfo && Cbor.get(cgInfo, 'name')) || g('claim_generator') || null,
        generator_version: (cgInfo && Cbor.get(cgInfo, 'version')) || null,
        title: g('dc:title') || null, format: g('dc:format') || null, instance_id: g('instanceID') || g('instance_id') || null,
        version: g('claim_generator_info') && Cbor.get(claim, 'created_assertions') ? 2 : 1
      };
      const claimAlg = g('alg') || 'sha256';

      // ---- assertions (decode + hash check) ----
      const assertionBoxes = (assertionStore && assertionStore.children || []).filter(c => c.type === 'jumb');
      const byLabel = new Map(assertionBoxes.map(b => [b.label, b]));
      const refs = [].concat(g('assertions') || [], g('created_assertions') || [], g('gathered_assertions') || []);
      let assertionFail = 0, assertionOk = 0, assertionSkipped = 0;
      for (const ref of refs) {
        const url = Cbor.get(ref, 'url') || ''; const label = url.split('/').pop();
        const box = byLabel.get(label);
        const expected = Cbor.get(ref, 'hash'); const alg = Cbor.get(ref, 'alg') || claimAlg;
        if (!box) { assertionFail++; check(`Assertion ${label}`, false, 'listed in the claim but missing from the file'); continue; }
        try {
          const actual = await this.digest(alg, store.subarray(box.body, box.end));
          if (this.eq(actual, expected)) assertionOk++; else { assertionFail++; check(`Assertion ${label}`, false, 'content does not match its signed hash'); }
        } catch (e) { assertionSkipped++; }
      }
      check('Assertion hashes', assertionFail === 0 ? (assertionSkipped && !assertionOk ? null : true) : false,
        assertionFail ? `${assertionFail} assertion(s) were altered or are missing` : `${assertionOk} of ${refs.length} signed assertions match`);

      // ---- decode assertions we care about ----
      const decoded = {};
      for (const b of assertionBoxes) decoded[b.label.replace(/__\d+$/, '')] = decoded[b.label.replace(/__\d+$/, '')] || this.decodeAssertion(store, b).value;
      const actionsAssertion = decoded['c2pa.actions'] || decoded['c2pa.actions.v2'];
      const actionList = actionsAssertion ? (Cbor.get(actionsAssertion, 'actions') || (actionsAssertion.actions) || []) : [];
      const AI_TYPES = ['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia', 'compositeSynthetic'];
      const field = (o, k) => (o instanceof Map ? o.get(k) : o && o[k]);
      for (const a of actionList) {
        const dst = String(field(a, 'digitalSourceType') || '').split('/').pop();
        const agent = field(a, 'softwareAgent');
        const agentName = agent && typeof agent === 'object' ? (field(agent, 'name') || null) : agent || null;
        const entry = { action: field(a, 'action') || null, softwareAgent: agentName, when: field(a, 'when') || null, digitalSourceType: dst || null, description: field(a, 'description') || null };
        report.actions.push(entry);
        if (dst && AI_TYPES.includes(dst)) { report.ai.marked = true; if (!report.ai.sourceTypes.includes(dst)) report.ai.sourceTypes.push(dst); }
        if (dst === 'algorithmicMedia') report.ai.algorithmic = true;
      }
      const genAi = decoded['cawg.ai_generative_training'] || decoded['c2pa.training-mining'];
      if (genAi) report.ai.trainingAssertion = true;

      // ---- earlier signed versions (history) ----
      if (manifests.length > 1) {
        const earlier = manifests.slice(0, -1);
        const problems = [];
        for (const em of earlier) { const r = await this.checkEarlierManifest(store, em); if (!r.ok) problems.push(`${em.label.slice(-8)}: ${r.problems.join(', ')}`); }
        // the newest manifest must reference each earlier one by hash
        for (const ab of assertionBoxes.filter(b => /^c2pa\.ingredient/.test(b.label))) {
          const val = this.decodeAssertion(store, ab).value; if (!val) continue;
          const ref = Cbor.get(val, 'c2pa_manifest') || Cbor.get(val, 'activeManifest');
          if (!ref) continue;
          const target = manifests.find(m => m.label === (Cbor.get(ref, 'url') || '').split('/').pop());
          if (!target) continue;
          const alg = Cbor.get(ref, 'alg') || claimAlg; const want = Cbor.get(ref, 'hash');
          const a1 = await this.digest(alg, store.subarray(target.body, target.end));
          const a2 = await this.digest(alg, store.subarray(target.start, target.end));
          if (!this.eq(a1, want) && !this.eq(a2, want)) problems.push(`${target.label.slice(-8)}: no longer matches the hash recorded when it was signed`);
        }
        check('Earlier signed versions are intact', problems.length === 0, problems.length ? 'The recorded history was altered: ' + problems.join('; ') : `${earlier.length} earlier signed version(s) match what was recorded`);
      }

      // ---- data hash (ties manifest to the file) ----
      const dh = decoded['c2pa.hash.data'];
      if (dh) {
        const excl = (field(dh, 'exclusions') || []).map(e => [Number(field(e, 'start')), Number(field(e, 'length'))]).sort((a, b) => a[0] - b[0]);
        const parts = []; let pos = 0;
        for (const [st, ln] of excl) { if (st > pos) parts.push(u8.subarray(pos, st)); pos = Math.max(pos, st + ln); }
        if (pos < u8.length) parts.push(u8.subarray(pos));
        const actual = await this.digest(field(dh, 'alg') || claimAlg, C2paLocator.concat(parts));
        const ok = this.eq(actual, field(dh, 'hash'));
        check('File content matches the signed hash', ok, ok ? 'The image/file data has not changed since it was signed' : 'The file was changed after it was signed, or the credentials were copied from another file');
        report.contentBinding = ok ? 'match' : 'mismatch';
      } else if (decoded['c2pa.hash.bmff.v3'] || decoded['c2pa.hash.bmff.v2'] || decoded['c2pa.hash.bmff']) {
        const key = decoded['c2pa.hash.bmff.v3'] ? 'c2pa.hash.bmff.v3' : decoded['c2pa.hash.bmff.v2'] ? 'c2pa.hash.bmff.v2' : 'c2pa.hash.bmff';
        const bh = decoded[key]; const version = key.endsWith('v3') ? 3 : key.endsWith('v2') ? 2 : 1;
        const fileHash = field(bh, 'hash');
        if (u8.length > 400 * 1024 * 1024) {
          check('File content matches the signed hash', null, 'The file is too large to hash in the browser');
          report.contentBinding = 'unchecked';
        } else if (!fileHash || field(bh, 'merkle')) {
          check('File content matches the signed hash', null, 'This is a fragmented (streaming) video that uses per-segment hashes, which are not checked yet, so edits after signing would not be caught');
          report.contentBinding = 'unchecked';
        } else {
          const input = Bmff.hashInput(u8, bh, version);
          const actual = await this.digest(field(bh, 'alg') || claimAlg, input);
          const ok = this.eq(actual, fileHash);
          check('File content matches the signed hash', ok, ok ? 'The video/file data has not changed since it was signed' : 'The file was changed after it was signed, or the credentials were copied from another file');
          report.contentBinding = ok ? 'match' : 'mismatch';
        }
      } else if (decoded['c2pa.hash.boxes']) {
        check('File content matches the signed hash', null, 'This file uses a per-box hash that is not checked yet, so edits after signing would not be caught');
        report.contentBinding = 'unchecked';
      } else {
        check('File content matches the signed hash', null, 'No data hash found in the credentials');
        report.contentBinding = 'unchecked';
      }

      // ---- signature ----
      const sigContent = sigBox.children.find(c => c.type === 'cbor');
      let cose = Cbor.decode(store.subarray(sigContent.body, sigContent.end)).value;
      if (cose && cose.tag === 18) cose = cose.value;
      const [protectedBytes, unprot, payloadField, signature] = cose;
      const prot = protectedBytes.length ? Cbor.decode(protectedBytes).value : new Map();
      const coseAlg = Cbor.get(prot, 1);
      let x5 = Cbor.get(prot, 33) || Cbor.get(unprot, 33) || Cbor.get(unprot, 'x5chain') || Cbor.get(prot, 'x5chain');
      const chainDer = (Array.isArray(x5) ? x5 : [x5]).filter(Boolean);
      if (!chainDer.length) throw new Error('no certificate in signature');
      const chain = chainDer.map(d => X509.parse(d));
      const leaf = chain[0];
      const payload = payloadField && payloadField.length ? payloadField : claimBytes;
      const sig = await this.verifyCose(coseAlg, leaf, protectedBytes, payload, signature);
      check('Signature is mathematically valid', sig.ok, sig.ok === true ? 'The claim was signed by the key in the certificate' : sig.ok === false ? 'The signature does not match the claim: the credentials were altered or forged' : sig.note);

      // ---- time ----
      const ts = this.timestampFromSigTst(unprot);
      const nowIso = new Date().toISOString();
      report.time = ts ? { value: ts, source: 'timestamp authority', verified: false } : null;
      const signedAt = ts || null;

      // ---- certificate chain ----
      let chainOk = true;
      for (let i = 0; i < chain.length - 1; i++) {
        const r = await this.verifyCertSignature(chain[i], chain[i + 1]);
        if (r !== true) { chainOk = r === false ? false : null; if (r === false) break; }
      }
      const anchors = this.trustAnchors();
      let trusted = false, anchorName = null;
      if (anchors.length) {
        const top = chain[chain.length - 1];
        for (const a of anchors) {
          if (this.eq(a.der, top.der) || this.eq(a.der, leaf.der)) { trusted = true; anchorName = X509.label(a.subject); break; }
          if (this.eq(a.subjectDer, top.issuerDer) && (await this.verifyCertSignature(top, a)) === true) { trusted = true; anchorName = X509.label(a.subject); break; }
        }
      }
      const at = signedAt || nowIso;
      const validAtSigning = leaf.notBefore <= at && at <= leaf.notAfter;
      report.signer = {
        name: leaf.subject.CN || leaf.subject.O || 'Unknown', organization: leaf.subject.O || null, country: leaf.subject.C || null,
        issuer: X509.label(leaf.issuer), notBefore: leaf.notBefore, notAfter: leaf.notAfter,
        chain: chain.map(c => X509.label(c.subject)), trusted, trustedBy: anchorName, trustListLoaded: anchors.length > 0, expiredNow: nowIso > leaf.notAfter
      };
      check('Certificate chain is consistent', chainOk, chainOk === true ? 'Each certificate is signed by the next' : chainOk === false ? 'A certificate in the chain was not signed by its issuer' : 'The chain could not be fully checked');
      check('Signer is on the official C2PA trust list', anchors.length ? trusted : null, anchors.length ? (trusted ? `Chains to "${anchorName}"` : 'The signer is not on the C2PA trust list. Anyone can create credentials with their own certificate') : 'The trust list was not loaded');
      check(ts ? 'Certificate was valid when signed' : 'Certificate is valid today', validAtSigning, ts ? 'Checked against the timestamp in the file' : 'No trusted timestamp was found, so today\'s date was used');

      // ---- overall status ----
      const failed = report.checks.some(c => c.ok === false && /Assertion|File content|Signature|Earlier signed/.test(c.name));
      const certFail = report.checks.some(c => c.ok === false && /Certificate/.test(c.name));
      const unchecked = report.checks.some(c => c.ok === null && /File content|Signature/.test(c.name));
      if (failed || certFail) report.status = 'invalid';
      else if (unchecked) report.status = 'partial';
      else if (!anchors.length || !trusted) report.status = 'valid_untrusted';
      else report.status = 'valid';
    } catch (e) {
      report.status = 'unreadable';
      report.error = e.message || String(e);
      check('Credentials could be read', false, 'The embedded credentials are damaged or use a layout this tool does not understand (' + report.error + ')');
    }
    report.headline = this.headline(report);
    return report;
  }

  static headline(report) {
    const who = report.signer ? report.signer.name : 'an unknown signer';
    switch (report.status) {
      case 'valid': return `Verified: signed by ${who}, and the file has not changed since.`;
      case 'valid_untrusted': return `Signature is valid and the file is unchanged, but "${who}" is not on the official C2PA trust list.`;
      case 'partial': return `Signature by ${who} is valid, but the file's content could not be checked against it.`;
      case 'invalid': return 'FAILED: the credentials do not match this file. It was changed after signing, or the credentials are forged or copied.';
      case 'unreadable': return 'Content Credentials are present but could not be read.';
      default: return 'No Content Credentials.';
    }
  }
}

if (typeof window !== 'undefined') window.C2paVerifier = C2paVerifier;
if (typeof module !== 'undefined' && module.exports) module.exports = C2paVerifier;
