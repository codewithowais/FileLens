/**
 * FileLens - Audio Engine
 * High-performance Web Audio API processing engine:
 * - STFT Spectral Decomposition into 9 AI-Estimated Components
 * - Real-time Multi-Stem Mixer (Gain, Mute, Solo)
 * - Master Dynamics & EQ (3-Band EQ, Compressor, Limiter)
 * - Seamless A/B Original vs Cleaned preview switching
 */

/**
 * Lets the browser paint / handle input between chunks of heavy work.
 * MessageChannel is not throttled in background tabs the way setTimeout(0) is.
 */
const yieldToUI = (() => {
  if (typeof MessageChannel === 'undefined' || typeof document === 'undefined') return () => new Promise(r => setTimeout(r, 0));
  const ch = new MessageChannel();
  const waiting = [];
  ch.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
  return () => new Promise(r => { waiting.push(r); ch.port2.postMessage(0); });
})();

/**
 * Built-in decoders for uncompressed AIFF / AIFF-C and CAF audio, used when the browser cannot
 * decode them itself (Chrome and Firefox cannot). Returns { sampleRate, channels: Float32Array[] }.
 */
class PcmFallback {
  static decode(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const tag = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (tag === 'FORM') return this.aiff(u8);
    if (tag === 'caff') return this.caf(u8);
    return null;
  }

  static samples(view, offset, frames, channels, bits, littleEndian, isFloat) {
    const bps = bits / 8, out = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) {
        const o = offset + (f * channels + c) * bps;
        if (o + bps > view.byteLength) return out;
        let v;
        if (isFloat) v = bits === 64 ? view.getFloat64(o, littleEndian) : view.getFloat32(o, littleEndian);
        else if (bits === 8) v = view.getInt8(o) / 128;
        else if (bits === 16) v = view.getInt16(o, littleEndian) / 32768;
        else if (bits === 24) {
          const b0 = view.getUint8(o), b1 = view.getUint8(o + 1), b2 = view.getUint8(o + 2);
          let n = littleEndian ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
          if (n & 0x800000) n -= 0x1000000; v = n / 8388608;
        } else if (bits === 32) v = view.getInt32(o, littleEndian) / 2147483648;
        else throw new Error(`${bits}-bit audio is not supported`);
        out[c][f] = v;
      }
    }
    return out;
  }

  static aiff(u8) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const isC = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === 'AIFC';
    let p = 12, comm = null, ssnd = null;
    while (p + 8 <= u8.length) {
      const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]); const size = view.getUint32(p + 4);
      if (id === 'COMM') {
        const channels = view.getUint16(p + 8), frames = view.getUint32(p + 10), bits = view.getUint16(p + 14);
        const expo = view.getUint16(p + 16) & 0x7FFF, hi = view.getUint32(p + 18), lo = view.getUint32(p + 22);
        const sampleRate = Math.round((hi * 4294967296 + lo) * Math.pow(2, expo - 16383 - 63));
        let comp = 'NONE'; if (isC && size >= 22) comp = String.fromCharCode(u8[p + 26], u8[p + 27], u8[p + 28], u8[p + 29]);
        comm = { channels, frames, bits, sampleRate, comp };
      } else if (id === 'SSND') ssnd = { offset: p + 8 + 8 + view.getUint32(p + 8) };
      p += 8 + size + (size % 2);
    }
    if (!comm || !ssnd) throw new Error('not a valid AIFF file');
    const comp = comm.comp;
    if (!['NONE', 'sowt', 'fl32', 'fl64', 'FL32', 'FL64', 'twos', 'in24', 'in32'].includes(comp)) throw new Error(`compressed AIFF-C (${comp}) is not supported`);
    const isFloat = /^fl/i.test(comp); const bits = comp === 'fl32' || comp === 'FL32' ? 32 : comp === 'fl64' || comp === 'FL64' ? 64 : comm.bits;
    return { sampleRate: comm.sampleRate, channels: this.samples(view, ssnd.offset, comm.frames, comm.channels, bits, comp === 'sowt', isFloat) };
  }

  static caf(u8) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 8, desc = null, data = null;
    while (p + 12 <= u8.length) {
      const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
      const size = Number(view.getBigInt64(p + 4)); const body = p + 12;
      if (id === 'desc') {
        desc = { sampleRate: view.getFloat64(body), format: String.fromCharCode(u8[body + 8], u8[body + 9], u8[body + 10], u8[body + 11]), flags: view.getUint32(body + 12),
          bytesPerPacket: view.getUint32(body + 16), channels: view.getUint32(body + 24), bits: view.getUint32(body + 28) };
      } else if (id === 'data') {
        const len = size < 0 ? u8.length - body : size; data = { offset: body + 4, length: len - 4 };
      }
      if (size < 0) break;
      p = body + size;
    }
    if (!desc || !data) throw new Error('not a valid CAF file');
    if (desc.format !== 'lpcm') throw new Error(`compressed CAF audio (${desc.format}) is not supported`);
    const frames = Math.floor(data.length / (desc.channels * desc.bits / 8));
    return { sampleRate: desc.sampleRate, channels: this.samples(view, data.offset, frames, desc.channels, desc.bits, !!(desc.flags & 2), !!(desc.flags & 1)) };
  }
}

/**
 * Per-frame spectral masks that split a frame into the nine estimated components.
 * Masks sum to 1 in every frequency bin, so the stems add back up to the original.
 */
class StemMasker {
  constructor(sampleRate, fftSize, stemIds) {
    this.halfFft = fftSize / 2;
    this.numStems = stemIds.length;
    const half = this.halfFft;
    this.freqHz = new Float32Array(half);
    for (let k = 0; k < half; k++) this.freqHz[k] = (k * sampleRate) / fftSize;
    // electrical hum bins (50/60 Hz and harmonics)
    this.isHumBin = new Uint8Array(half);
    const humTargets = [50, 60, 100, 120, 150, 180, 200, 240, 300, 360, 480];
    for (let k = 0; k < half; k++) {
      for (let t = 0; t < humTargets.length; t++) if (Math.abs(this.freqHz[k] - humTargets[t]) <= 2.2) { this.isHumBin[k] = 1; break; }
    }
    this.stemMasks = new Array(this.numStems); this.prevMasks = new Array(this.numStems);
    for (let s = 0; s < this.numStems; s++) { this.stemMasks[s] = new Float32Array(half); this.prevMasks[s] = new Float32Array(half); }
    const idx = (id) => stemIds.indexOf(id);
    this.IDX = { main: idx('main_voice'), bg: idx('bg_voice'), traffic: idx('traffic'), wind: idx('wind'), fan: idx('fan_ac'), hum: idx('hum'), music: idx('music'), noise: idx('noise'), reverb: idx('reverb') };
  }

  /** Returns the smoothed masks for one frame. Optionally accumulates per-stem energy. */
  compute(mag, noiseFloor, vocalProminence, energyAccum) {
    const { halfFft, numStems, freqHz, isHumBin, stemMasks, prevMasks, IDX } = this;
    for (let s = 0; s < numStems; s++) stemMasks[s].fill(0);
    for (let k = 0; k < halfFft; k++) {
      const f = freqHz[k], m = mag[k];
      const baseline = noiseFloor[k] || 1e-5;
      const snr = m / (baseline + 1e-6);
      const voicedBin = vocalProminence > 0.40 && snr > 2.2;

      if (f < 35) stemMasks[IDX.traffic][k] = 0.92;                                                   // sub-bass rumble
      if (isHumBin[k] && snr > 1.8) stemMasks[IDX.hum][k] = 0.88;                                       // mains hum
      if (f >= 35 && f <= 220 && !stemMasks[IDX.hum][k]) {
        // Rumble sits in these bins, but so do a voice's lowest harmonics: where the voice stands clearly above
        // the noise floor, mostly leave them to the voice so it keeps its body
        stemMasks[IDX.traffic][k] = Math.min(1.0, (220 - f) / 180) * (voicedBin ? 0.25 : 0.78);
      }
      if (f >= 30 && f <= 380) stemMasks[IDX.wind][k] = 0.28 * (1.0 - Math.min(1.0, snr / 10.0));
      if (f >= 200 && f <= 5500) stemMasks[IDX.fan][k] = Math.min(1.0, baseline / (m + 1e-6)) * 0.70;
      if (f > 4000) stemMasks[IDX.noise][k] = Math.min(1.0, baseline / (m + 1e-6)) * 0.75;

      const isPeak = k > 1 && k < halfFft - 1 && m > mag[k - 1] && m > mag[k + 1];
      // A voice is not only the 300-3400 Hz band: its low harmonics (down to ~85 Hz) give it body and its
      // sibilants and air (up to ~10 kHz) give it clarity. Where it stands clearly above the noise floor it
      // keeps those bins too, otherwise they would be handed to the noise stems and cut away.
      if (voicedBin && (f < 280 || f > 3800) && f >= 85 && f <= 10000) { stemMasks[IDX.main][k] = 0.70; stemMasks[IDX.bg][k] = 0.05; }
      if (f >= 280 && f <= 3800) {
        if (voicedBin) { stemMasks[IDX.main][k] = isPeak ? 0.90 : 0.78; stemMasks[IDX.bg][k] = isPeak ? 0.06 : 0.14; }
        else if (vocalProminence > 0.20 || (snr > 1.15 && snr <= 2.2)) { stemMasks[IDX.main][k] = 0.16; stemMasks[IDX.bg][k] = 0.74; }
      }
      if (f >= 500 && f <= 8000 && snr > 3.0 && vocalProminence < 0.35) stemMasks[IDX.music][k] = 0.65;
      if (f >= 300 && f <= 4500 && vocalProminence < 0.28 && snr > 1.05 && snr < 1.9) stemMasks[IDX.reverb][k] = 0.38;

      // Normalise so the masks sum to 1 (full energy conservation)
      let maskSum = 0;
      for (let s = 0; s < numStems; s++) maskSum += stemMasks[s][k];
      if (maskSum > 0) { const inv = 1.0 / maskSum; for (let s = 0; s < numStems; s++) stemMasks[s][k] *= inv; }
      else stemMasks[IDX.noise][k] = 1.0;

      // Temporal smoothing: fast attack, slower decay
      let smoothSum = 0;
      for (let s = 0; s < numStems; s++) {
        const cur = stemMasks[s][k], prev = prevMasks[s][k];
        const smoothed = prev + (cur > prev ? 0.85 : 0.42) * (cur - prev);
        stemMasks[s][k] = smoothed; prevMasks[s][k] = smoothed; smoothSum += smoothed;
      }
      if (smoothSum > 0) { const inv = 1.0 / smoothSum; for (let s = 0; s < numStems; s++) stemMasks[s][k] *= inv; }
      if (energyAccum) for (let s = 0; s < numStems; s++) energyAccum[s] += m * stemMasks[s][k];
    }
    return stemMasks;
  }
}

class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.originalBuffer = null;
    this.processedBuffer = null;
    this.stems = {}; // 9 component audio buffers
    this.stemGains = {}; // GainNode for each stem
    this.stemMutes = {}; // boolean
    this.stemSolos = {}; // boolean
    this.stemValues = {}; // linear gain value (1.0 = 0dB)

    // Component definitions
    this.componentDefs = [
      { id: 'main_voice', name: 'Main Voice', icon: '🎙️', desc: 'Foreground speaker, formants 300Hz-3.4kHz, pitch harmonics', color: '#18181b' },
      { id: 'bg_voice', name: 'Background Human Voices', icon: '👥', desc: 'Secondary chatter, ambient discussion, crowd babble', color: '#3f3f46' },
      { id: 'traffic', name: 'Traffic / Vehicles', icon: '🚗', desc: 'Low-frequency rumble 20-200Hz, engine hums, tire noise', color: '#71717a' },
      { id: 'wind', name: 'Wind', icon: '💨', desc: 'Turbulent low/mid stochastic gusts 30-380Hz', color: '#71717a' },
      { id: 'fan_ac', name: 'Fan / AC', icon: '❄️', desc: 'Stationary motor whine + broadband continuous air rush', color: '#71717a' },
      { id: 'hum', name: 'Hum (50/60Hz)', icon: '⚡', desc: 'Mains electrical hum and exact 2nd/3rd/4th harmonics', color: '#71717a' },
      { id: 'music', name: 'Music', icon: '🎵', desc: 'Sustained melodic/harmonic pitch tracks, beats, score', color: '#52525b' },
      { id: 'noise', name: 'General Noise', icon: '🌫️', desc: 'Broadband stationary hiss, thermal noise floor', color: '#a1a1aa' },
      { id: 'reverb', name: 'Reverb / Echo', icon: '🏛️', desc: 'Diffuse room acoustic reflections and late decay tail', color: '#71717a' }
    ];

    // Master DSP nodes
    this.eqLow = null;
    this.eqMid = null;
    this.eqHigh = null;
    this.compressor = null;
    this.limiter = null;
    this.masterGain = null;
    this.originalGain = null;
    this.cleanedGain = null;

    // Transport state
    this.isPlaying = false;
    this.isLooping = false;
    this.playbackMode = 'cleaned'; // 'original' or 'cleaned'
    this.startTime = 0;
    this.pausedAt = 0;
    this.activeSources = [];
    this.originalSource = null;

    // Component energy statistics detected from analysis
    this.componentEnergy = {};

    // Macro controls state
    this.macros = {
      noiseReduction: 0,
      voiceBoost: 0,
      bgPreservation: 100, // Default 100% to preserve background voices!
      masterVolume: 0 // dB
    };
    this.masterGainLinear = 1.0;

    // Advanced DSP Processing Nodes
    this.hpFilter = null;
    this.notchHum = null;
    this.deEsser = null;

    this.dspSettings = {
      highPassFreq: 20, // Hz
      deHumMode: 'off',
      deHumFreq: 60,
      deHumEnabled: false,
      deEsserAmount: 0, // %
      deReverbAmount: 0 // %
    };

    this.eqSettings = { low: 0, mid: 0, high: 0 };
    this.compSettings = { threshold: -24, ratio: 3, attack: 0.01, release: 0.15 };
    this.limiter = null;
    this.cleanAlgorithm = 'neural_wiener';
    this.fullBuffer = null;       // the whole decoded recording
    this.isExcerpt = false;       // true when the studio previews only part of it
    this.excerptStart = 0;        // seconds

    this.isGraphSetup = false;
  }

  /**
   * Fast peak limiter (brick-wall style compressor) that stops boosted audio from clipping.
   */
  /**
   * Transfer curve of the soft clipper that sits after the limiter: untouched up to 0.7, then a smooth
   * roll-off that tops out below full scale. A large volume boost can briefly overshoot the limiter
   * (it has no look-ahead); this keeps those peaks round instead of hard-clipped.
   */
  static softClipCurve(n = 4097) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x), knee = 0.7, room = 0.25;
      c[i] = Math.sign(x) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
    }
    return c;
  }
  static createSoftClipper(ctx) {
    const sh = ctx.createWaveShaper();
    sh.curve = AudioEngine.softClipCurve();
    sh.oversample = '2x';
    return sh;
  }

  static createLimiter(ctx) {
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -1.0;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;
    return lim;
  }

  static get MAX_PREVIEW_SECONDS() { return 180; }
  static get COMPONENT_IDS() { return ['main_voice', 'bg_voice', 'traffic', 'wind', 'fan_ac', 'hum', 'music', 'noise', 'reverb']; }
  /**
   * De-hum filter settings. When de-hum is off the filter must be a true bypass: an all-pass filter.
   * (A notch with a tiny Q is NOT a bypass: it removes almost the whole spectrum.)
   */
  static notchConfig(enabled, freq) {
    return enabled ? { type: 'notch', frequency: freq || 60, Q: 14.0 } : { type: 'allpass', frequency: 1000, Q: 0.707 };
  }
  static applyNotchConfig(node, cfg) { node.type = cfg.type; node.frequency.value = cfg.frequency; node.Q.value = cfg.Q; }
  static get NOISE_PERCENTILE() { return 0.15; }
  /** Error thrown when the user cancels (DOMException where available). */
  static abortError() {
    if (typeof DOMException !== 'undefined') return new DOMException('Cancelled by user', 'AbortError');
    const e = new Error('Cancelled by user'); e.name = 'AbortError'; return e;
  }
  static get STFT() { return { fftSize: 2048, hopSize: 512 }; }
  static now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
  static hannWindow() {
    if (!AudioEngine._hann) {
      const { fftSize } = AudioEngine.STFT; const w = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
      AudioEngine._hann = w;
    }
    return AudioEngine._hann;
  }
  /** Magnitude of the mono mid channel from a packed L + jR spectrum. */
  static midMagnitudes(specR, specI, fftSize, isStereo, mag) {
    const half = fftSize / 2;
    for (let k = 0; k < half; k++) {
      const nk = k === 0 ? 0 : fftSize - k;
      const zr = specR[k], zi = specI[k], cr = specR[nk], ci = -specI[nk];
      const lr = 0.5 * (zr + cr), li = 0.5 * (zi + ci);
      let mr = lr, mi = li;
      if (isStereo) { const rr = 0.5 * (zi - ci), ri = -0.5 * (zr - cr); mr = 0.5 * (lr + rr); mi = 0.5 * (li + ri); }
      mag[k] = Math.sqrt(mr * mr + mi * mi);
    }
  }

  initAudioContext() {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass();
    }
    return this.audioContext;
  }

  /**
   * Makes the audio context run at the recording's own sample rate (clamped to 16-48 kHz). The browser resamples
   * everything it decodes to the context rate, so a 22 kHz voice memo would otherwise be inflated to 48 kHz:
   * slower to decode and more than twice the samples to analyse.
   */
  useContextRate(rate) {
    const target = rate ? Math.max(16000, Math.min(48000, Math.round(rate))) : 0;   // 0 = the browser's default rate
    if (!this.audioContext) { if (!target) return; }
    else if (target ? this.audioContext.sampleRate === target : !this._customRate) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    let ctx;
    try { ctx = target ? new AudioContextClass({ sampleRate: target }) : new AudioContextClass(); } catch (e) { return; }   // unsupported: keep what we have
    if (this.audioContext) {
      this.stopSources();
      try { this.audioContext.close(); } catch (e) {}
      // the old graph belonged to the old context: setupAudioGraph builds a new one
      this.isGraphSetup = false; this.stemGains = {};
      for (const n of ['stemBus', 'hpFilter', 'notchHum', 'deEsser', 'eqLow', 'eqMid', 'eqHigh', 'compressor', 'limiter', 'softClip', 'analyser', 'masterGain', 'originalGain', 'cleanedGain']) this[n] = null;
    }
    this.audioContext = ctx;
    this._customRate = !!target;
  }

  async resumeAudioContextIfNeeded() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (e) {
        console.warn("AudioContext resume pending user gesture:", e);
      }
    }
  }

  /**
   * Decodes an ArrayBuffer (from uploaded file) into an AudioBuffer.
   */
  async decodeAudio(arrayBuffer, sampleRateHint = 0) {
    this.cancelPrefetch();                  // anything prepared belongs to the previous file
    this.useContextRate(sampleRateHint);   // 0 (unknown rate) goes back to the browser default
    this.initAudioContext();
    // Clone array buffer because decodeAudioData detaches it
    const bufferCopy = arrayBuffer.slice(0);

    return new Promise((resolve, reject) => {
      let isSettled = false;
      const onDone = (buf) => {
        if (isSettled) return;
        isSettled = true;
        this.originalBuffer = buf; this.fullBuffer = buf; this.isExcerpt = false; this.excerptStart = 0;
        resolve(buf);
      };
      const onErr = (err) => {
        if (isSettled) return;
        // The browser could not decode it: try the built-in AIFF / CAF decoder
        try {
          const pcm = PcmFallback.decode(arrayBuffer);
          if (pcm && pcm.channels.length && pcm.channels[0].length) {
            const buf = this.audioContext.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
            pcm.channels.forEach((ch, i) => buf.copyToChannel(ch, i));
            isSettled = true;
            this.originalBuffer = buf; this.fullBuffer = buf; this.isExcerpt = false; this.excerptStart = 0;
            resolve(buf);
            return;
          }
        } catch (fallbackErr) {
          err = fallbackErr;
        }
        isSettled = true;
        reject(err || new Error("Failed to decode audio data"));
      };

      try {
        const promiseOrVoid = this.audioContext.decodeAudioData(bufferCopy, onDone, onErr);
        if (promiseOrVoid && typeof promiseOrVoid.then === 'function') {
          promiseOrVoid.then(onDone).catch(onErr);
        }
      } catch (syncErr) {
        onErr(syncErr);
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Long recordings: the studio works on a preview window, the download covers the whole file
  // -------------------------------------------------------------------------------------------

  /**
   * Chooses the part of the recording the studio previews. Recordings up to `maxSec` are used whole.
   */
  /** The part of the recording that starts at `startSec`: where it really starts (it cannot run past the end) and its length, in samples. */
  excerptGeometry(startSec, maxSec = this.previewSeconds || AudioEngine.MAX_PREVIEW_SECONDS) {
    const full = this.fullBuffer || this.originalBuffer;
    const sr = full.sampleRate, total = full.length;
    const len = Math.min(total, Math.round(maxSec * sr));
    const start = len >= total ? 0 : Math.max(0, Math.min(total - len, Math.round(startSec * sr)));
    return { full, sr, total, len, start, whole: len >= total };
  }

  /** Copies the part of the recording that starts at `startSec` into its own buffer. */
  makeExcerpt(startSec = 0, maxSec = this.previewSeconds || AudioEngine.MAX_PREVIEW_SECONDS) {
    const g = this.excerptGeometry(startSec, maxSec);
    if (g.whole) return { buffer: g.full, start: 0, isExcerpt: false };
    const b = this.audioContext.createBuffer(g.full.numberOfChannels, g.len, g.sr);
    for (let c = 0; c < g.full.numberOfChannels; c++) b.copyToChannel(g.full.getChannelData(c).subarray(g.start, g.start + g.len), c);
    return { buffer: b, start: g.start / g.sr, isExcerpt: true };
  }

  setExcerpt(startSec = 0, maxSec = this.previewSeconds || AudioEngine.MAX_PREVIEW_SECONDS) {
    const full = this.fullBuffer || this.originalBuffer;
    if (!full) return;
    this.fullBuffer = full;
    const ex = this.makeExcerpt(startSec, maxSec);
    this.originalBuffer = ex.buffer; this.isExcerpt = ex.isExcerpt; this.excerptStart = ex.start;
  }

  // -------------------------------------------------------------------------------------------
  // Prefetch: while one part plays, the next part is split into its layers in the background, so the
  // hand-over (or a jump to it) does not have to wait
  // -------------------------------------------------------------------------------------------

  /** Memory limit for the decoded recording plus two parts' worth of layers (bytes). */
  static get PREFETCH_BUDGET_BYTES() { return 3 * 1024 * 1024 * 1024; }

  /** True when holding the current and the next part at once fits the memory budget. */
  canPrefetch() {
    const g = this.excerptGeometry(0);
    const ch = g.full.numberOfChannels, layers = this.componentDefs.length;
    const fullBytes = g.total * ch * 4, partBytes = layers * g.len * ch * 4;
    return fullBytes + 2 * partBytes <= (this.prefetchBudget || AudioEngine.PREFETCH_BUDGET_BYTES);
  }

  _setPrefetchState(state) { if (this.onPrefetchState) { try { this.onPrefetchState(state); } catch (e) {} } }

  /**
   * Starts splitting the part that begins at `startSec` in the background. Does nothing when it is already
   * ready or running, when there is no next part, or when memory would not allow it.
   */
  startPrefetch(startSec) {
    if (!this.fullBuffer || !this.isExcerpt || !this.stems.main_voice) return false;
    if (startSec >= this.fullBuffer.duration - 0.5) return false;
    const g = this.excerptGeometry(startSec);
    const pf = this._pf;
    if (pf && pf.source === g.full && pf.key === g.start) return true;
    this.cancelPrefetch();
    if (!this.canPrefetch()) return false;
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : { signal: null, abort() {} };
    const job = { key: g.start, source: g.full, state: 'running', abort: ac, result: null, promise: null };
    this._pf = job;
    this._setPrefetchState('running');
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    job.promise = (async () => {
      try {
        const ex = this.makeExcerpt(startSec);
        // leave a core or two free so the playing audio and the page stay smooth
        const r = await this.decomposeBuffer(ex.buffer, () => {}, ac.signal, { maxWorkers: Math.max(1, cores - 2) });
        if (this._pf !== job) return;
        job.result = { buffer: ex.buffer, start: ex.start, stems: r.stems, energy: r.energy };
        job.state = 'ready';
        this._setPrefetchState('ready');
      } catch (e) {
        if (this._pf === job) { this._pf = null; this._setPrefetchState('idle'); }
      }
    })();
    return true;
  }

  /** True when the part starting at `startSec` is already split and waiting. */
  prefetchReadyFor(startSec) {
    const pf = this._pf;
    if (!pf || pf.state !== 'ready' || !this.fullBuffer) return false;
    const g = this.excerptGeometry(startSec);
    return pf.source === g.full && pf.key === g.start;
  }

  /**
   * Makes the prefetched part the live one if it is the part starting at `startSec` (waiting for it when it is
   * still being prepared). Anything else that was being prepared is dropped. Returns whether it was used.
   */
  async adoptPrefetched(startSec) {
    const pf = this._pf;
    if (!pf || !this.fullBuffer) return false;
    const g = this.excerptGeometry(startSec);
    if (pf.source !== g.full || pf.key !== g.start) { this.cancelPrefetch(); return false; }
    if (pf.state === 'running') await pf.promise;
    if (this._pf !== pf || pf.state !== 'ready') return false;
    const r = pf.result;
    this._pf = null; this._setPrefetchState('idle');
    this.originalBuffer = r.buffer; this.isExcerpt = true; this.excerptStart = r.start;
    this._installStems({ stems: r.stems, energy: r.energy }, false);          // keeps the user's gains
    return true;
  }

  cancelPrefetch() {
    const pf = this._pf;
    if (!pf) return;
    this._pf = null;
    try { pf.abort.abort(); } catch (e) {}
    this._setPrefetchState('idle');
  }

  /** The gain each stem should have right now (mute / solo / fader), in componentDefs order. */
  getEffectiveGains() {
    const anySolo = Object.values(this.stemSolos).some(v => v === true);
    return this.componentDefs.map(def => {
      const v = this.stemValues[def.id] !== undefined ? this.stemValues[def.id] : 1.0;
      if (this.stemMutes[def.id]) return 0;
      if (anySolo) return this.stemSolos[def.id] ? v : 0;
      return v;
    });
  }

  /**
   * Learns the steady background level of every frequency: the level it sits at during its quietest
   * ~15% of frames. Frames are sampled evenly across the WHOLE recording (at most ~4,000 of them),
   * so the result does not depend on how long the recording is and costs about a second.
   */
  async learnNoiseStatistics(left, right, isStereo, sampleRate, progress, abortSignal) {
    const { fftSize, hopSize } = AudioEngine.STFT;
    const halfFft = fftSize / 2, numSamples = left.length;
    const numFrames = Math.max(0, Math.floor((numSamples - fftSize) / hopSize) + 1);
    const window = AudioEngine.hannWindow();
    const fft = new FastFFT(fftSize);
    const real = new Float32Array(fftSize), imag = new Float32Array(fftSize);
    const LOG_MIN = -6, BPD = 12, NB = 120;                       // 10 decades of magnitude, 12 bins each
    const hist = new Uint32Array(halfFft * NB);
    const stride = Math.max(1, Math.floor(numFrames / 4000));
    let used = 0, lastYield = AudioEngine.now();
    for (let f = 0; f < numFrames; f += stride) {
      if (abortSignal && abortSignal.aborted) throw AudioEngine.abortError();
      if (AudioEngine.now() - lastYield > 20) { await yieldToUI(); lastYield = AudioEngine.now(); progress(f / numFrames); }
      const off = f * hopSize;
      for (let i = 0; i < fftSize; i++) { real[i] = (isStereo ? 0.5 * (left[off + i] + right[off + i]) : left[off + i]) * window[i]; imag[i] = 0; }
      fft.transform(real, imag);
      for (let k = 0; k < halfFft; k++) {
        const m = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        let b = Math.floor((Math.log10(m + 1e-12) - LOG_MIN) * BPD);
        hist[k * NB + (b < 0 ? 0 : b >= NB ? NB - 1 : b)]++;
      }
      used++;
    }
    const noiseFloor = new Float32Array(halfFft).fill(1e-4);
    const target = Math.max(1, Math.floor(used * AudioEngine.NOISE_PERCENTILE));
    for (let k = 0; k < halfFft; k++) {
      let c = 0;
      for (let b = 0; b < NB; b++) { c += hist[k * NB + b]; if (c >= target) { noiseFloor[k] = Math.pow(10, LOG_MIN + (b + 0.5) / BPD); break; } }
    }
    return { noiseFloor, framesSampled: used };
  }

  /** Noise profile for a recording, learned once and reused by the preview and the full download. */
  async getNoiseStats(source, progress = () => {}, abortSignal = null) {
    if (!this._noiseCache) this._noiseCache = new WeakMap();
    if (this._noiseCache.has(source)) return this._noiseCache.get(source);
    const n = source.numberOfChannels;
    const stats = await this.learnNoiseStatistics(source.getChannelData(0), n > 1 ? source.getChannelData(1) : source.getChannelData(0), n > 1, source.sampleRate, progress, abortSignal);
    this._noiseCache.set(source, stats);
    return stats;
  }

  /**
   * Cleans a whole recording with the current stem gains in one streaming pass: instead of building
   * nine stems, the gains are folded into a single mask per frame. Memory stays at one output copy,
   * so hour-long recordings work. Produces the same audio as summing the stems.
   */
  async mixWithGains(source, gains, progressCallback = () => {}, abortSignal = null) {
    const sampleRate = source.sampleRate, numChannels = source.numberOfChannels, numSamples = source.length;
    const left = source.getChannelData(0), right = numChannels > 1 ? source.getChannelData(1) : left, isStereo = numChannels > 1;
    const { fftSize, hopSize } = AudioEngine.STFT;
    const halfFft = fftSize / 2;
    const stemIds = this.componentDefs.map(c => c.id), numStems = stemIds.length;

    const { noiseFloor } = await this.getNoiseStats(source, (p) => progressCallback(0.1 * p, 'Listening for background noise…'), abortSignal);
    const numFrames = Math.max(0, Math.floor((numSamples - fftSize) / hopSize) + 1);
    const kSpeech0 = Math.ceil(300 * fftSize / sampleRate), kSpeech1 = Math.floor(3400 * fftSize / sampleRate);

    const target = this.audioContext.createBuffer(numChannels, numSamples, sampleRate);
    const outL = target.getChannelData(0), outR = isStereo ? target.getChannelData(1) : null;
    const window = AudioEngine.hannWindow(), w2 = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) w2[i] = window[i] * window[i];
    const winSumAt = (i) => {
      let sum = 0; const base = Math.floor(i / hopSize);
      for (let j = 0; j < fftSize / hopSize; j++) { const f = base - j; if (f < 0 || f >= numFrames) continue; sum += w2[i - f * hopSize]; }
      return sum;
    };

    const masker = new StemMasker(sampleRate, fftSize, stemIds);
    const fft = new FastFFT(fftSize);
    const real = new Float32Array(fftSize), imag = new Float32Array(fftSize);
    const specR = new Float32Array(fftSize), specI = new Float32Array(fftSize);
    const outRe = new Float32Array(fftSize), outIm = new Float32Array(fftSize);
    const mag = new Float32Array(halfFft), combined = new Float32Array(halfFft);
    let finalized = 0, lastYield = AudioEngine.now();

    const finalize = (upTo) => {
      for (let i = finalized; i < upTo; i++) {
        const ws = winSumAt(i); const norm = ws > 1e-4 ? 1.0 / ws : 1.0;
        outL[i] *= norm; if (isStereo) outR[i] *= norm;
      }
      finalized = upTo;
    };

    for (let f = 0; f < numFrames; f++) {
      if (abortSignal && abortSignal.aborted) throw AudioEngine.abortError();
      if (AudioEngine.now() - lastYield > 20) { await yieldToUI(); lastYield = AudioEngine.now(); progressCallback(0.1 + 0.88 * (f / numFrames), 'Cleaning the recording…'); }
      const off = f * hopSize;
      for (let i = 0; i < fftSize; i++) { real[i] = left[off + i] * window[i]; imag[i] = isStereo ? right[off + i] * window[i] : 0; }
      fft.transform(real, imag);
      for (let i = 0; i < fftSize; i++) { specR[i] = real[i]; specI[i] = imag[i]; }
      AudioEngine.midMagnitudes(specR, specI, fftSize, isStereo, mag);

      let vocal = 0, total = 0;
      for (let k = 0; k < halfFft; k++) { total += mag[k]; if (k >= kSpeech0 && k <= kSpeech1) vocal += mag[k]; }
      const masks = masker.compute(mag, noiseFloor, total > 0 ? vocal / total : 0, null);
      combined.fill(0);
      for (let s = 0; s < numStems; s++) { const g = gains[s]; if (g === 0) continue; const m = masks[s]; for (let k = 0; k < halfFft; k++) combined[k] += g * m[k]; }

      outRe[0] = specR[0] * combined[0]; outIm[0] = specI[0] * combined[0];
      for (let k = 1; k < halfFft; k++) {
        const w = combined[k];
        outRe[k] = specR[k] * w; outIm[k] = specI[k] * w;
        outRe[fftSize - k] = specR[fftSize - k] * w; outIm[fftSize - k] = specI[fftSize - k] * w;
      }
      outRe[halfFft] = specR[halfFft] * combined[halfFft - 1]; outIm[halfFft] = specI[halfFft] * combined[halfFft - 1];
      fft.inverseTransform(outRe, outIm);
      for (let i = 0; i < fftSize; i++) { outL[off + i] += outRe[i] * window[i]; if (isStereo) outR[off + i] += outIm[i] * window[i]; }
      finalize(Math.min(numSamples, (f + 1) * hopSize));
    }
    finalize(numSamples);
    progressCallback(0.98, 'Cleaning the recording…');
    return target;
  }

  static get WARMUP_FRAMES() { return 16; }

  /** How many parallel segments to split `numFrames` into (1 = no splitting). */
  planSegments(numFrames, maxWorkers = 0) {
    if (this.segmentCount) return Math.max(1, Math.min(this.segmentCount, numFrames));
    if (numFrames < 1500) return 1; // under ~17 s: splitting is not worth it
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const canWork = typeof Worker !== 'undefined' && this.useWorkers !== false;
    return canWork ? Math.max(1, Math.min(8, maxWorkers || cores)) : 1;
  }

  /**
   * Runs `count` synthesis jobs: on workers when available (falling back to the main thread if the
   * workers fail to start), otherwise one after another on the main thread.
   */
  async runSegments(count, jobFor, merge, onProgress, abortSignal) {
    const useWorkers = count > 1 && typeof Worker !== 'undefined' && this.useWorkers !== false;
    const merged = new Set();                               // a segment must be added to the stems exactly once
    const mergeOnce = (res, g) => { merge(res); merged.add(g); };
    if (useWorkers) {
      try { await this.runSegmentsOnWorkers(count, jobFor, mergeOnce, onProgress, abortSignal); return; }
      catch (err) { if (err && err.name === 'AbortError') throw err; console.warn('Workers unavailable, using the main thread:', err); this.useWorkers = false; }
    }
    for (let g = 0; g < count; g++) {
      if (merged.has(g)) continue;                          // a worker already delivered this one before it failed
      if (abortSignal && abortSignal.aborted) throw AudioEngine.abortError();
      const res = await AudioEngine.synthSegment(jobFor(g), (p) => onProgress(g, p), abortSignal, true);
      mergeOnce(res, g); onProgress(g, 1);
    }
  }

  runSegmentsOnWorkers(count, jobFor, merge, onProgress, abortSignal) {
    return new Promise((resolve, reject) => {
      const workers = []; let pending = count, done = false;
      const finish = (err) => {
        if (done) return; done = true;
        workers.forEach(w => { try { w.terminate(); } catch (e) {} });
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        err ? reject(err) : resolve();
      };
      const onAbort = () => finish(AudioEngine.abortError());
      if (abortSignal) { if (abortSignal.aborted) return finish(AudioEngine.abortError()); abortSignal.addEventListener('abort', onAbort); }
      try {
        for (let g = 0; g < count; g++) {
          const w = new Worker(AudioEngine.workerUrl || 'js/stem-worker.js'); workers.push(w);
          w.onerror = (e) => finish(new Error((e && e.message) || 'worker failed'));
          w.onmessage = (e) => {
            const m = e.data;
            if (m.progress !== undefined) { onProgress(g, m.progress); return; }
            if (m.error) { finish(new Error(m.error)); return; }
            try { merge(m.result, g); } catch (err) { finish(err); return; }
            onProgress(g, 1);
            if (--pending === 0) finish();
          };
          const job = jobFor(g);
          const transfer = [job.left.buffer]; if (job.right) transfer.push(job.right.buffer);
          w.postMessage(job, transfer);
        }
      } catch (err) { finish(err); }
    });
  }

  /**
   * Masks and re-synthesizes `nFrames` consecutive STFT frames of one segment. Pure function of its
   * input, so it can run on the main thread or inside a worker. The first `warm` frames only prime the
   * mask smoothing and are not written out (they belong to the previous segment).
   * Stems whose mask is essentially zero in a frame are skipped (no inverse FFT needed).
   */
  static async synthSegment(job, onProgress, abortSignal, yieldOften) {
    const { left, right, isStereo, sampleRate, noiseFloor, warm, nFrames } = job;
    const { fftSize, hopSize } = AudioEngine.STFT, halfFft = fftSize / 2;
    const stemIds = AudioEngine.COMPONENT_IDS, numStems = stemIds.length;
    const window = AudioEngine.hannWindow();
    const outStart = warm * hopSize, outLen = (nFrames - 1) * hopSize + fftSize - outStart;
    const stemL = [], stemR = [];
    for (let s = 0; s < numStems; s++) { stemL.push(new Float32Array(outLen)); stemR.push(isStereo ? new Float32Array(outLen) : new Float32Array(0)); }
    const windowSum = new Float32Array(outLen), energy = new Float64Array(numStems);
    const masker = new StemMasker(sampleRate, fftSize, stemIds), fft = new FastFFT(fftSize);
    const real = new Float32Array(fftSize), imag = new Float32Array(fftSize);
    const origR = new Float32Array(fftSize), origI = new Float32Array(fftSize);
    const stemReal = new Float32Array(fftSize), stemImag = new Float32Array(fftSize);
    const mag = new Float32Array(halfFft);
    const kSpeech0 = Math.ceil(300 * fftSize / sampleRate), kSpeech1 = Math.floor(3400 * fftSize / sampleRate);
    const right2 = isStereo ? right : left;
    let lastYield = AudioEngine.now(), lastReport = 0;
    for (let f = 0; f < nFrames; f++) {
      if (abortSignal && abortSignal.aborted) throw AudioEngine.abortError();
      if (yieldOften && AudioEngine.now() - lastYield > 20) { await yieldToUI(); lastYield = AudioEngine.now(); if (onProgress) onProgress(f / nFrames); }
      else if (!yieldOften && onProgress && f - lastReport >= 400) { lastReport = f; onProgress(f / nFrames); }
      const offset = f * hopSize;
      // One complex FFT carries both channels (L in real part, R in imaginary part)
      for (let i = 0; i < fftSize; i++) { real[i] = left[offset + i] * window[i]; imag[i] = isStereo ? right2[offset + i] * window[i] : 0; }
      fft.transform(real, imag);
      for (let i = 0; i < fftSize; i++) { origR[i] = real[i]; origI[i] = imag[i]; }
      AudioEngine.midMagnitudes(origR, origI, fftSize, isStereo, mag);
      let vocal = 0, total = 0;
      for (let k = 0; k < halfFft; k++) { total += mag[k]; if (k >= kSpeech0 && k <= kSpeech1) vocal += mag[k]; }
      const masks = masker.compute(mag, noiseFloor, total > 0 ? vocal / total : 0, f >= warm ? energy : null);
      if (f < warm) continue;
      const o = offset - outStart;
      // Synthesize each stem: a real-valued mask is symmetric, so masking Z = L + jR and
      // inverse-transforming returns the stem's left channel (real) and right channel (imag).
      for (let s = 0; s < numStems; s++) {
        const mask = masks[s];
        let peak = 0; for (let k = 0; k < halfFft; k++) if (mask[k] > peak) peak = mask[k];
        if (peak < 1e-5) continue;
        stemReal[0] = origR[0] * mask[0]; stemImag[0] = origI[0] * mask[0];
        for (let k = 1; k < halfFft; k++) {
          const w = mask[k];
          stemReal[k] = origR[k] * w; stemImag[k] = origI[k] * w;
          stemReal[fftSize - k] = origR[fftSize - k] * w; stemImag[fftSize - k] = origI[fftSize - k] * w;
        }
        stemReal[halfFft] = origR[halfFft] * mask[halfFft - 1]; stemImag[halfFft] = origI[halfFft] * mask[halfFft - 1];
        fft.inverseTransform(stemReal, stemImag);
        const tl = stemL[s], tr = stemR[s];
        for (let i = 0; i < fftSize; i++) {
          tl[o + i] += stemReal[i] * window[i];
          if (isStereo) tr[o + i] += stemImag[i] * window[i];
        }
      }
      for (let i = 0; i < fftSize; i++) windowSum[o + i] += window[i] * window[i];
    }
    return { stemL, stemR, windowSum, energy, sampleStart: job.sampleStart };
  }

  /**
   * Runs the AI Spectral Decomposition into 9 Estimated Components.
   * Uses Fast STFT analysis and psychoacoustic spectral masking.
   */
  async analyzeAndDecompose(progressCallback = () => {}, abortSignal = null) {
    if (!this.originalBuffer) throw new Error("No audio loaded");
    const r = await this.decomposeBuffer(this.originalBuffer, progressCallback, abortSignal);
    this._installStems(r, true);
    this.timings = r.timings;
    return { stems: this.stems, energy: this.componentEnergy };
  }

  /** Makes a decomposition the live one. `resetGains` puts every layer back to 0 dB (a fresh analysis). */
  _installStems(r, resetGains) {
    for (const id of Object.keys(r.stems)) {
      this.stems[id] = r.stems[id];
      if (resetGains) { this.stemValues[id] = 1.0; this.stemMutes[id] = false; this.stemSolos[id] = false; }
    }
    Object.assign(this.componentEnergy, r.energy);
  }

  /**
   * Splits `buffer` (a part of the recording, or all of it) into the nine layers without touching the live
   * state, so it can also run in the background for a part that is not playing yet.
   */
  async decomposeBuffer(buffer, progressCallback = () => {}, abortSignal = null, opts = {}) {
    if (abortSignal && abortSignal.aborted) throw AudioEngine.abortError();
    const sampleRate = buffer.sampleRate;
    const numChannels = buffer.numberOfChannels;
    const numSamples = buffer.length;
    // Masks are estimated from a mono (mid) mix, then applied to each channel so the
    // stereo image of the original is preserved in every stem.
    const inputLeft = buffer.getChannelData(0);
    const inputRight = numChannels > 1 ? buffer.getChannelData(1) : inputLeft;
    const isStereo = numChannels > 1;

    const { fftSize, hopSize } = AudioEngine.STFT;
    const halfFft = fftSize / 2;
    const numFrames = Math.floor((numSamples - fftSize) / hopSize) + 1;
    const window = AudioEngine.hannWindow();
    const stemIds = this.componentDefs.map(c => c.id);
    const numStems = stemIds.length;

    const tStart = AudioEngine.now();
    // Pass 1: learn the background noise from the WHOLE recording (not just the preview window)
    const { noiseFloor } = await this.getNoiseStats(this.fullBuffer || buffer,
      (p) => progressCallback(0.1 + 0.3 * p, "AI Spectral Modeling: Estimating Acoustic Floors & Formants..."), abortSignal);
    const tNoise = AudioEngine.now();

    // Stems are written straight into AudioBuffers (no second copy in memory)
    const stemBuffers = {}, stemLeft = {}, stemRight = {};
    for (const id of stemIds) {
      stemBuffers[id] = this.audioContext.createBuffer(isStereo ? 2 : 1, numSamples, sampleRate);   // mono stays mono: half the memory and work
      stemLeft[id] = stemBuffers[id].getChannelData(0);
      stemRight[id] = isStereo ? stemBuffers[id].getChannelData(1) : null;
    }
    const stemLeftArr = stemIds.map(id => stemLeft[id]);
    const stemRightArr = stemIds.map(id => stemRight[id]);   // null entries for mono
    const energyAccumArr = new Float64Array(numStems);
    const windowSum = new Float32Array(numSamples);

    // Pass 2: multi-component spectral masking and inverse STFT synthesis. The frames are split into
    // segments that run in parallel on background workers (or one after another when workers are
    // unavailable); each segment's output is added into the stems where they overlap.
    const segCount = numFrames < 1 ? 0 : this.planSegments(numFrames, opts.maxWorkers);   // under one frame (~46 ms): nothing to separate
    const bounds = [];
    for (let g = 0; g < segCount; g++) bounds.push([Math.floor(numFrames * g / segCount), Math.floor(numFrames * (g + 1) / segCount)]);
    const segProgress = new Array(segCount).fill(0);
    const reportProgress = () => progressCallback(0.4 + 0.5 * (segProgress.reduce((a, b) => a + b, 0) / segCount), "AI Stem Separation: Synthesizing 9 Component Channels...");
    const merge = (res) => {
      for (let s = 0; s < numStems; s++) {
        const dl = stemLeftArr[s], dr = stemRightArr[s], sl = res.stemL[s], sr = res.stemR[s];
        for (let i = 0, o = res.sampleStart; i < sl.length; i++, o++) dl[o] += sl[i];
        if (isStereo) for (let i = 0, o = res.sampleStart; i < sr.length; i++, o++) dr[o] += sr[i];
        energyAccumArr[s] += res.energy[s];
      }
      for (let i = 0, o = res.sampleStart; i < res.windowSum.length; i++, o++) windowSum[o] += res.windowSum[i];
    };
    const jobFor = (g) => {
      const warm = g === 0 ? 0 : AudioEngine.WARMUP_FRAMES;
      const f0 = bounds[g][0] - warm, f1 = bounds[g][1];
      const a = f0 * hopSize, b = (f1 - 1) * hopSize + fftSize;
      return { left: inputLeft.slice(a, b), right: isStereo ? inputRight.slice(a, b) : null, isStereo, sampleRate, noiseFloor,
        warm, nFrames: f1 - f0, sampleStart: a + warm * hopSize };
    };
    if (segCount) await this.runSegments(segCount, jobFor, merge, (g, p) => { segProgress[g] = p; reportProgress(); }, abortSignal);

    const tSynth = AudioEngine.now();
    // Normalize overlap-add by window sum
    for (let i = 0; i < numSamples; i++) {
      const norm = windowSum[i] > 1e-4 ? 1.0 / windowSum[i] : 1.0;
      for (let s = 0; s < numStems; s++) { stemLeftArr[s][i] *= norm; if (isStereo) stemRightArr[s][i] *= norm; }
    }

    // Energy percentages for UI display
    let totalAllEnergy = 0;
    for (let s = 0; s < numStems; s++) totalAllEnergy += energyAccumArr[s];
    const energy = {};
    for (let s = 0; s < numStems; s++) energy[stemIds[s]] = totalAllEnergy > 0 ? (energyAccumArr[s] / totalAllEnergy) * 100 : 0;
    const tEnd = AudioEngine.now();
    const timings = { noiseStatsMs: Math.round(tNoise - tStart), synthMs: Math.round(tSynth - tNoise), finishMs: Math.round(tEnd - tSynth), segments: segCount };
    progressCallback(1.0, "AI Decomposition Complete: 9 Component Layers Isolated.");
    return { stems: stemBuffers, energy, timings };
  }


  /**
   * Sets stem gain in decibels (-40dB to +12dB).
   */
  setStemGain(id, gainDb) {
    // Convert dB to linear gain: -39.9 dB or lower is complete silence (0 linear gain)
    const linearGain = gainDb <= -39.9 ? 0 : Math.pow(10, gainDb / 20);
    this.stemValues[id] = linearGain;
    this.updateStemAudioGain(id);
  }

  /**
   * Toggles Mute for a component stem.
   */
  setStemMute(id, isMuted) {
    this.stemMutes[id] = isMuted;
    this.updateAllStemGains();
  }

  /**
   * Toggles Solo for a component stem.
   */
  setStemSolo(id, isSoloed) {
    this.stemSolos[id] = isSoloed;
    this.updateAllStemGains();
  }

  /**
   * Updates all stem gain nodes according to current Mute/Solo matrix.
   */
  updateAllStemGains() {
    for (const def of this.componentDefs) {
      this.updateStemAudioGain(def.id);
    }
  }

  updateStemAudioGain(id) {
    const gainNode = this.stemGains[id];
    if (!gainNode || !this.audioContext) return;

    // Check if any stem is currently soloed
    const anySolo = Object.values(this.stemSolos).some(v => v === true);

    let targetGain = 0;
    if (this.stemMutes[id]) {
      targetGain = 0;
    } else if (anySolo) {
      // If solo is active on any stem, only soloed stems are heard
      targetGain = this.stemSolos[id] ? (this.stemValues[id] !== undefined ? this.stemValues[id] : 1.0) : 0;
    } else {
      targetGain = this.stemValues[id] !== undefined ? this.stemValues[id] : 1.0;
    }

    // Apply immediate, click-free gain change
    const now = this.audioContext.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(targetGain, now);
  }

  /**
   * Quick Preset Configuration
   */
  applyPreset(presetName) {
    // Reset all mutes and solos
    for (const def of this.componentDefs) {
      this.stemMutes[def.id] = false;
      this.stemSolos[def.id] = false;
      this.stemValues[def.id] = 1.0;
    }

    switch (presetName) {
      case 'cafe_preserve_voices':
        // Prompt specific: Keep main speaker ✅ Keep background people ✅ Reduce traffic ✅ Reduce fan ✅
        this.setStemGain('main_voice', 2.0);      // +2 dB Boost
        this.setStemGain('bg_voice', 0.0);        // 0 dB Full Preservation!
        this.setStemGain('traffic', -35.0);       // Heavily reduced
        this.setStemGain('fan_ac', -32.0);        // Heavily reduced
        this.setStemGain('hum', -40.0);           // Removed
        this.setStemGain('wind', -30.0);          // Reduced
        this.setStemGain('noise', -24.0);         // Reduced
        this.setStemGain('music', -12.0);         // Ducked
        this.setStemGain('reverb', -6.0);         // Tamed
        break;

      case 'voice_only':
        // Aggressive vocal isolation (foreground only)
        this.setStemGain('main_voice', 3.0);
        this.setStemGain('bg_voice', -30.0);
        this.setStemGain('traffic', -40.0);
        this.setStemGain('wind', -40.0);
        this.setStemGain('fan_ac', -40.0);
        this.setStemGain('hum', -40.0);
        this.setStemGain('noise', -35.0);
        this.setStemGain('music', -35.0);
        this.setStemGain('reverb', -15.0);
        break;

      case 'remove_traffic_wind':
        this.setStemGain('main_voice', 0.0);
        this.setStemGain('bg_voice', 0.0);
        this.setStemGain('traffic', -40.0);
        this.setStemGain('wind', -40.0);
        break;

      case 'remove_fan_hum':
        this.setStemGain('main_voice', 0.0);
        this.setStemGain('bg_voice', 0.0);
        this.setStemGain('fan_ac', -40.0);
        this.setStemGain('hum', -40.0);
        this.setStemGain('noise', -20.0);
        break;

      case 'dry_voice':
        this.setStemGain('main_voice', 1.0);
        this.setStemGain('reverb', -40.0);
        break;

      case 'reset_unity':
      default:
        for (const def of this.componentDefs) {
          this.setStemGain(def.id, 0.0); // 0 dB
        }
        break;
    }

    this.updateAllStemGains();
  }

  /**
   * Applies high-level Macro sliders:
   * - Noise Reduction (0 - 100%)
   * - Voice Boost (0 - 100%)
   * - Background Voice Preservation (0 - 100%)
   */
  applyMacros(nrPercent, vbPercent, bgpPercent) {
    this.macros.noiseReduction = nrPercent;
    this.macros.voiceBoost = vbPercent;
    this.macros.bgPreservation = bgpPercent;

    // Noise Reduction scales down non-voice noise stems
    const nrFactor = nrPercent / 100.0; // 0.0 to 1.0
    // At high noise reduction (e.g. >= 95%), attenuate down to -60 dB (complete silence)
    const nrDb = nrFactor >= 0.95 ? -60.0 : -45.0 * Math.pow(nrFactor, 1.2);

    this.setStemGain('traffic', nrDb);
    this.setStemGain('wind', nrDb);
    this.setStemGain('fan_ac', nrDb);
    this.setStemGain('hum', nrDb <= -39.9 ? -60 : nrDb * 1.2);
    this.setStemGain('noise', nrDb);

    // Voice Boost enhances main voice
    const vbDb = (vbPercent / 100.0) * 6.0; // 0 to +6 dB
    this.setStemGain('main_voice', vbDb);

    // Background Voice Preservation protects background people
    // 100% = 0 dB (fully preserved). 0% = attenuated with noise reduction
    const bgpFactor = bgpPercent / 100.0;
    const bgpDb = (1.0 - bgpFactor) * Math.min(0, nrDb * 0.8);
    this.setStemGain('bg_voice', bgpDb);
  }

  /**
   * Setup Web Audio routing graph
   */
  setupAudioGraph() {
    if (!this.audioContext) return;
    if (this.isGraphSetup) {
      this.setPlaybackMode(this.playbackMode);
      this.updateAllStemGains();
      return;
    }

    // 1. Crossfader nodes for Original vs Cleaned
    this.originalGain = this.audioContext.createGain();
    this.originalGain.gain.value = this.playbackMode === 'original' ? 1.0 : 0.0;

    this.cleanedGain = this.audioContext.createGain();
    this.cleanedGain.gain.value = this.playbackMode === 'cleaned' ? 1.0 : 0.0;

    // 2. Stem Bus
    this.stemBus = this.audioContext.createGain();

    // 3. High-Pass Filter (Sub-bass rumble elimination)
    this.hpFilter = this.audioContext.createBiquadFilter();
    this.hpFilter.type = 'highpass';
    this.hpFilter.frequency.value = this.dspSettings.highPassFreq || 20;
    this.hpFilter.Q.value = 0.707;

    // 4. De-Hum Notch Filter (50Hz or 60Hz)
    this.notchHum = this.audioContext.createBiquadFilter();
    AudioEngine.applyNotchConfig(this.notchHum, AudioEngine.notchConfig(this.dspSettings.deHumEnabled, this.dspSettings.deHumFreq));

    // 5. De-Esser (Sibilance control at 6.8 kHz)
    this.deEsser = this.audioContext.createBiquadFilter();
    this.deEsser.type = 'peaking';
    this.deEsser.frequency.value = 6800;
    this.deEsser.Q.value = 1.8;
    const deEssCut = -(this.dspSettings.deEsserAmount / 100.0) * 15.0;
    this.deEsser.gain.value = deEssCut;

    // 6. 3-Band Parametric EQ
    this.eqLow = this.audioContext.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 120;
    this.eqLow.gain.value = 0;

    this.eqMid = this.audioContext.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 2500;
    this.eqMid.Q.value = 1.2;
    this.eqMid.gain.value = 0;

    this.eqHigh = this.audioContext.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 8000;
    this.eqHigh.gain.value = 0;

    // 7. Dynamics Compressor
    this.compressor = this.audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.15;

    // 8. Master Output Gain
    this.masterGain = this.audioContext.createGain();
    this.masterGain.gain.value = 1.0;

    // Connect Cleaned processing chain with High-Pass, De-Hum, and De-Esser
    this.stemBus.connect(this.hpFilter);
    this.hpFilter.connect(this.notchHum);
    this.notchHum.connect(this.deEsser);
    this.deEsser.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.compressor);
    this.compressor.connect(this.cleanedGain);

    // Both chains go to Master Gain -> Peak Limiter -> Destination & Analyser
    this.limiter = AudioEngine.createLimiter(this.audioContext);
    this.originalGain.connect(this.masterGain);
    this.cleanedGain.connect(this.masterGain);
    this.softClip = AudioEngine.createSoftClipper(this.audioContext);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.softClip);
    this.softClip.connect(this.audioContext.destination);

    // 9. Master Analyser for real-time output VU meter
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.softClip.connect(this.analyser);

    // Create GainNodes for each stem
    for (const def of this.componentDefs) {
      const g = this.audioContext.createGain();
      const val = this.stemValues[def.id] !== undefined ? this.stemValues[def.id] : 1.0;
      g.gain.value = val;
      g.connect(this.stemBus);
      this.stemGains[def.id] = g;
    }

    this.isGraphSetup = true;
    this.setPlaybackMode(this.playbackMode);
    this.updateAllStemGains();
  }

  /**
   * Real-time DSP Control Setters
   */
  setHighPassFilter(freqHz) {
    this.dspSettings.highPassFreq = freqHz;
    if (this.audioContext && this.hpFilter) {
      const now = this.audioContext.currentTime;
      this.hpFilter.frequency.cancelScheduledValues(now);
      this.hpFilter.frequency.setValueAtTime(freqHz, now);
    }
  }

  setDeHum(mode) {
    const enabled = mode === '50hz' || mode === '60hz';
    this.dspSettings.deHumMode = mode;
    this.dspSettings.deHumEnabled = enabled;
    if (enabled) this.dspSettings.deHumFreq = mode === '50hz' ? 50 : 60;
    if (!this.audioContext || !this.notchHum) return;       // the download render reads dspSettings
    AudioEngine.applyNotchConfig(this.notchHum, AudioEngine.notchConfig(enabled, this.dspSettings.deHumFreq));
  }

  setDeEsser(amountPercent) {
    this.dspSettings.deEsserAmount = amountPercent;
    if (!this.audioContext || !this.deEsser) return;
    const now = this.audioContext.currentTime;
    const cutDb = -(amountPercent / 100.0) * 15.0;
    this.deEsser.gain.cancelScheduledValues(now);
    this.deEsser.gain.setValueAtTime(cutDb, now);
  }

  setDeReverb(amountPercent) {
    this.dspSettings.deReverbAmount = amountPercent;
    const factor = amountPercent / 100.0;
    const revDb = factor >= 0.95 ? -60.0 : -42.0 * factor;
    this.setStemGain('reverb', revDb);
  }

  setCleanAlgorithm(algo) {
    this.cleanAlgorithm = algo;
  }

  /**
   * Listens to the WHOLE recording (sampled, so it takes a fraction of a second even for hours of audio)
   * and measures what the automatic clean needs to know: how noisy it is, whether there is mains hum
   * (50 or 60 Hz), how much low rumble and sibilance there is, and how loud the speech is.
   */
  static analyzeRecording(buffer) {
    const sr = buffer.sampleRate, n = buffer.length, nc = buffer.numberOfChannels;
    const L = buffer.getChannelData(0), R = nc > 1 ? buffer.getChannelData(1) : L;
    const out = { humHz: 0, humDb: 0, snrDb: 30, speechDb: -30, noiseDb: -60, sibilanceDb: -20, rumbleDb: -30, valid: false };
    if (n < sr) return out;                                    // under a second: not enough to judge

    // ---- Loudness, noise level, rumble and sibilance from up to 600 evenly spaced frames ----
    const { fftSize } = AudioEngine.STFT, half = fftSize / 2, win = AudioEngine.hannWindow(), fft = new FastFFT(fftSize);
    const real = new Float32Array(fftSize), imag = new Float32Array(fftSize);
    const bin = (hz) => Math.max(1, Math.min(half - 1, Math.round(hz * fftSize / sr)));
    const lo1 = bin(80), sp0 = bin(300), sp1 = bin(3400), sb0 = bin(5000), sb1 = Math.min(half - 1, bin(9000));
    const frames = Math.min(600, Math.floor((n - fftSize) / fftSize));
    const fr = [];
    for (let f = 0; f < frames; f++) {
      const off = Math.floor(f * (n - fftSize) / Math.max(1, frames - 1));
      let sum = 0;
      for (let i = 0; i < fftSize; i++) { const v = nc > 1 ? 0.5 * (L[off + i] + R[off + i]) : L[off + i]; sum += v * v; real[i] = v * win[i]; imag[i] = 0; }
      fft.transform(real, imag);
      let eLow = 0, eSp = 0, eSib = 0;
      for (let k = 1; k < lo1; k++) eLow += real[k] * real[k] + imag[k] * imag[k];
      for (let k = sp0; k <= sp1; k++) eSp += real[k] * real[k] + imag[k] * imag[k];
      for (let k = sb0; k <= sb1; k++) eSib += real[k] * real[k] + imag[k] * imag[k];
      fr.push({ db: 10 * Math.log10(sum / fftSize + 1e-12), eLow, eSp, eSib });
    }
    if (fr.length < 20) return out;
    const sorted = fr.map(x => x.db).sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    out.noiseDb = pct(0.10); out.speechDb = pct(0.90);
    out.snrDb = Math.max(0, out.speechDb - out.noiseDb);
    const loud = fr.filter(x => x.db >= pct(0.7));
    const sum = (arr, key) => arr.reduce((a, x) => a + x[key], 0);
    const dB = (a, b) => 10 * Math.log10((a + 1e-20) / (b + 1e-20));
    out.sibilanceDb = dB(sum(loud, 'eSib'), sum(loud, 'eSp'));
    out.rumbleDb = dB(sum(fr, 'eLow'), sum(fr, 'eSp'));

    // ---- Mains hum: look for a steady tone at 50/60 Hz (+ harmonics) in the quietest stretches ----
    const D = Math.max(1, Math.floor(sr / 1000)), nd = Math.floor(n / D), rate = sr / D;
    const x = new Float32Array(nd);
    for (let i = 0; i < nd; i++) { let a = 0; const o = i * D; for (let j = 0; j < D; j += 2) a += nc > 1 ? 0.5 * (L[o + j] + R[o + j]) : L[o + j]; x[i] = a / Math.ceil(D / 2); }
    const W = Math.floor(rate * 4);
    if (nd >= W * 2) {
      const wins = [];
      for (let o = 0; o + W <= nd; o += W) { let e = 0; for (let i = o; i < o + W; i++) e += x[i] * x[i]; wins.push({ o, e }); }
      wins.sort((a, b) => a.e - b.e);
      const chosen = wins.slice(0, Math.min(6, wins.length));
      const goertzel = (o, hz) => {
        const w = 2 * Math.PI * hz / rate, c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
        for (let i = 0; i < W; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (W - 1)); const s0 = x[o + i] * h + c * s1 - s2; s2 = s1; s1 = s0; }
        return s1 * s1 + s2 * s2 - c * s1 * s2;
      };
      const med = (a) => { const b = a.slice().sort((p, q) => p - q); return b[Math.floor(b.length / 2)]; };
      for (const f0 of [50, 60]) {
        const per = [1, 2, 3].map(h => med(chosen.map(c => 10 * Math.log10((goertzel(c.o, f0 * h) + 1e-20) / (0.5 * (goertzel(c.o, f0 * h - 5) + goertzel(c.o, f0 * h + 5)) + 1e-20)))));
        const score = (per[0] + per[1] + per[2]) / 3, strong = per.filter(v => v >= 5).length;
        if (score >= 7 && per[0] >= 5 && strong >= 2 && score > out.humDb) { out.humDb = score; out.humHz = f0; }
      }
    }
    out.valid = true;
    return out;
  }

  /**
   * Turns a recording analysis into settings. The aim is a natural result: noise is turned down, not erased
   * (the heavy cuts that remove every trace of noise make speech sound thin and "underwater"), and every
   * correction is kept small unless the recording clearly needs it. Without an analysis a gentle
   * general-purpose clean is used.
   */
  recommendAutoClean(a = this.recordingAnalysis) {
    const rec = { noiseReduction: 40, voiceBoost: 20, bgPreserve: 100, deReverb: 10, deEsser: 15, humHz: 0, highPass: 40,
      eq: [0, 1.0, 0], comp: { threshold: -22, ratio: 2 }, masterVolume: 0, notes: [] };
    if (!a || !a.valid) return rec;
    // Noise stems are turned down by about 9 dB on clean audio up to about 22 dB on noisy audio
    rec.noiseReduction = Math.max(25, Math.min(55, Math.round(55 - (a.snrDb - 5) * 0.9)));
    rec.notes.push(a.snrDb >= 35 ? 'clean recording, very light noise reduction' : a.snrDb >= 20 ? 'moderate background noise reduced' : 'noisy recording, noise reduced');
    rec.humHz = a.humHz;                                   // 0 = no hum found, leave the notch off
    if (a.humHz) rec.notes.push(`${a.humHz} Hz hum removed`);
    rec.highPass = a.rumbleDb > -8 ? 80 : 40;
    if (rec.highPass === 80) rec.notes.push('low rumble cut');
    rec.deEsser = a.sibilanceDb > -12 ? 30 : a.sibilanceDb > -16 ? 20 : 10;
    rec.deReverb = a.snrDb < 20 ? 15 : 10;
    // Bring quiet speech up to a comfortable level (never turns loud recordings down)
    rec.masterVolume = Math.max(0, Math.min(9, Math.round((-20 - a.speechDb) * 2) / 2));
    if (rec.masterVolume >= 1) rec.notes.push(`volume +${rec.masterVolume} dB`);
    return rec;
  }

  /** One-click clean: applies the settings recommended for this recording and returns them. */
  applyAutoClean(rec = this.recommendAutoClean()) {
    this.applyPreset('reset_unity');
    this.applyMacros(rec.noiseReduction, rec.voiceBoost, rec.bgPreserve);
    this.setStemGain('music', -6);
    if (rec.humHz) this.setStemGain('hum', -30);
    this.setDeHum(rec.humHz === 50 ? '50hz' : rec.humHz === 60 ? '60hz' : 'off');
    this.setHighPassFilter(rec.highPass);
    this.setDeEsser(rec.deEsser);
    this.setDeReverb(rec.deReverb);
    this.setEQ(rec.eq[0], rec.eq[1], rec.eq[2]);
    this.setMasterVolume(rec.masterVolume);
    if (rec.comp) this.setCompressor(rec.comp.threshold, rec.comp.ratio, 15, 250);
    this.updateAllStemGains();
    return rec;
  }

  /**
   * Seamless A/B Original vs Cleaned crossfade
   */
  setPlaybackMode(mode) {
    this.playbackMode = mode;
    if (!this.audioContext || !this.originalGain || !this.cleanedGain) return;

    const now = this.audioContext.currentTime;
    const fadeTime = 0.02; // 20ms click-free crossfade

    if (mode === 'original') {
      this.originalGain.gain.cancelScheduledValues(now);
      this.originalGain.gain.setValueAtTime(this.originalGain.gain.value, now);
      this.originalGain.gain.linearRampToValueAtTime(1.0, now + fadeTime);

      this.cleanedGain.gain.cancelScheduledValues(now);
      this.cleanedGain.gain.setValueAtTime(this.cleanedGain.gain.value, now);
      this.cleanedGain.gain.linearRampToValueAtTime(0.0, now + fadeTime);
    } else {
      this.originalGain.gain.cancelScheduledValues(now);
      this.originalGain.gain.setValueAtTime(this.originalGain.gain.value, now);
      this.originalGain.gain.linearRampToValueAtTime(0.0, now + fadeTime);

      this.cleanedGain.gain.cancelScheduledValues(now);
      this.cleanedGain.gain.setValueAtTime(this.cleanedGain.gain.value, now);
      this.cleanedGain.gain.linearRampToValueAtTime(1.0, now + fadeTime);
    }
  }

  /**
   * Reads real-time peak and RMS decibel level from the Master Analyser node
   */
  getLiveAudioLevels() {
    if (!this.analyser || !this.isPlaying) {
      return { peakDb: -90, rmsDb: -90, peak: 0, rms: 0, isPlaying: false };
    }
    const bufferLength = this.analyser.fftSize;
    const timeData = new Float32Array(bufferLength);
    this.analyser.getFloatTimeDomainData(timeData);

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < bufferLength; i++) {
      const val = Math.abs(timeData[i]);
      if (val > peak) peak = val;
      sumSquares += val * val;
    }
    const rms = Math.sqrt(sumSquares / bufferLength);
    const peakDb = peak > 1e-4 ? 20 * Math.log10(peak) : -90;
    const rmsDb = rms > 1e-4 ? 20 * Math.log10(rms) : -90;

    return { peakDb, rmsDb, peak, rms, isPlaying: true };
  }

  /**
   * Master EQ Controls
   */
  setEQ(lowDb, midDb, highDb) {
    this.eqSettings = { low: lowDb, mid: midDb, high: highDb };
    if (!this.audioContext) return;
    this.eqSettings = { low: lowDb, mid: midDb, high: highDb };
    const now = this.audioContext.currentTime;
    if (this.eqLow) this.eqLow.gain.setTargetAtTime(lowDb, now, 0.02);
    if (this.eqMid) this.eqMid.gain.setTargetAtTime(midDb, now, 0.02);
    if (this.eqHigh) this.eqHigh.gain.setTargetAtTime(highDb, now, 0.02);
  }

  /**
   * Master Dynamics Compressor
   */
  setCompressor(thresholdDb, ratio, attackMs = 10, releaseMs = 150) {
    this.compSettings = { threshold: thresholdDb, ratio, attack: attackMs / 1000, release: releaseMs / 1000 };
    if (!this.audioContext || !this.compressor) return;
    const now = this.audioContext.currentTime;
    this.compressor.threshold.setTargetAtTime(thresholdDb, now, 0.02);
    this.compressor.ratio.setTargetAtTime(ratio, now, 0.02);
    this.compressor.attack.setTargetAtTime(attackMs / 1000.0, now, 0.02);
    this.compressor.release.setTargetAtTime(releaseMs / 1000.0, now, 0.02);
  }

  /**
   * Master Volume
   */
  setMasterVolume(gainDb) {
    this.macros.masterVolume = gainDb;
    const linearGain = gainDb <= -40 ? 0 : Math.pow(10, gainDb / 20);
    this.masterGainLinear = linearGain;
    if (this.audioContext && this.masterGain && this.isPlaying) {
      this.masterGain.gain.setTargetAtTime(linearGain, this.audioContext.currentTime, 0.02);
    }
  }

  /**
   * Playback Control: Play from given offset
   */
  play(startOffset = null) {
    if (!this.originalBuffer) return;
    this.initAudioContext();

    // 1. ALWAYS guarantee all prior sources are completely killed and disconnected
    this.stopSources();
    this.isPlaying = false;

    this.setupAudioGraph();

    const duration = this.getDuration();
    let offset = startOffset !== null ? startOffset : this.pausedAt;
    if (duration > 0 && offset >= duration) {
      offset = 0;
    }
    this.pausedAt = offset;

    const ctxTime = this.audioContext.currentTime;
    this.startTime = ctxTime - offset;

    // 2. Restore master volume output immediately
    if (this.masterGain) {
      const targetVol = this.masterGainLinear !== undefined ? this.masterGainLinear : 1.0;
      this.masterGain.gain.cancelScheduledValues(ctxTime);
      this.masterGain.gain.setValueAtTime(targetVol, ctxTime);
    }

    // 3. Synchronize crossfader gains immediately at start timestamp
    const hasStems = !!(this.stems && this.stems.main_voice);
    if (this.playbackMode === 'original' || !hasStems) {
      this.originalGain.gain.setValueAtTime(1.0, ctxTime);
      this.cleanedGain.gain.setValueAtTime(0.0, ctxTime);
    } else {
      this.originalGain.gain.setValueAtTime(0.0, ctxTime);
      this.cleanedGain.gain.setValueAtTime(1.0, ctxTime);
    }

    // 4. Start Original audio buffer source
    this.originalSource = this.audioContext.createBufferSource();
    this.originalSource.buffer = this.originalBuffer;
    this.originalSource.loop = this.isLooping;
    this.originalSource.connect(this.originalGain);
    this.originalSource.start(0, offset);

    // 5. Start all 9 Stem buffer sources synchronously!
    this.activeSources = [];
    for (const def of this.componentDefs) {
      const stemBuffer = this.stems[def.id];
      if (stemBuffer) {
        const src = this.audioContext.createBufferSource();
        src.buffer = stemBuffer;
        src.loop = this.isLooping;
        src.connect(this.stemGains[def.id]);
        src.start(0, offset);
        this.activeSources.push(src);
      }
    }

    this.updateAllStemGains();

    // 6. Handle natural end of playback
    this.originalSource.onended = () => {
      if (!this.isLooping && this.isPlaying) {
        this.stop();
        if (this.onPlaybackEnd) this.onPlaybackEnd();
      }
    };

    this.isPlaying = true;
  }

  /**
   * Pause playback
   */
  pause() {
    this.pausedAt = this.getCurrentTime();
    this.isPlaying = false;
    this.stopSources();
  }

  /**
   * Stop and reset playhead to beginning
   */
  stop() {
    this.isPlaying = false;
    this.pausedAt = 0;
    this.stopSources();
  }

  /**
   * Completely and safely stops, silences, and disconnects all 10 audio buffer sources.
   * Uses isolated try/catches so an exception on one source never prevents stopping others.
   */
  stopSources() {
    // A. Hardware-level instant zero clamp on master output
    if (this.audioContext && this.masterGain) {
      try {
        const now = this.audioContext.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(0, now);
      } catch (e) {}
    }

    // B. Stop and disconnect the original source
    if (this.originalSource) {
      const src = this.originalSource;
      this.originalSource = null;
      try { src.onended = null; } catch (e) {}
      try { src.stop(0); } catch (e) {}
      try { src.disconnect(); } catch (e) {}
    }

    // C. Stop and disconnect every active stem source individually
    if (this.activeSources && Array.isArray(this.activeSources) && this.activeSources.length > 0) {
      const sourcesToStop = this.activeSources;
      this.activeSources = [];
      for (const src of sourcesToStop) {
        if (src) {
          try { src.onended = null; } catch (e) {}
          try { src.stop(0); } catch (e) {}
          try { src.disconnect(); } catch (e) {}
        }
      }
    }
  }

  seek(timeInSeconds) {
    const duration = this.getDuration();
    const target = Math.max(0, Math.min(duration, timeInSeconds));
    const wasPlaying = this.isPlaying;

    this.stopSources();
    this.pausedAt = target;

    if (wasPlaying) {
      this.play(target);
    } else {
      this.isPlaying = false;
    }
  }

  getCurrentTime() {
    if (!this.isPlaying || !this.audioContext) {
      return this.pausedAt;
    }
    const duration = this.getDuration();
    if (duration === 0) return 0;
    const elapsed = this.audioContext.currentTime - this.startTime;
    return this.isLooping ? (elapsed % duration) : Math.min(duration, elapsed);
  }

  getDuration() {
    return this.originalBuffer ? this.originalBuffer.duration : 0;
  }

  /**
   * Final safety: if any sample still exceeds -0.1 dBFS after limiting, scale the whole
   * render down (pure gain change, no distortion).
   */
  static guardPeaks(buffer, ceiling = 0.989) {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    }
    if (peak > ceiling) {
      const g = ceiling / peak;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= g;
      }
    }
    return peak;
  }

  /**
   * Renders the Cleaned Audio to an offline AudioBuffer for export.
   */
  async renderCleanedAudioBuffer(progressCallback = () => {}, options = {}) {
    if (!this.originalBuffer || !this.stems.main_voice) {
      throw new Error("No decomposed audio available to render");
    }
    // `full`: clean the WHOLE recording with the current settings (used for downloads of long
    // recordings, where the studio only previews a part of it).
    const useFull = Boolean(options.full && this.isExcerpt && this.fullBuffer);
    let mixed = null;
    if (useFull) {
      mixed = await this.mixWithGains(this.fullBuffer, this.getEffectiveGains(), (p, msg) => progressCallback(0.02 + 0.8 * p, msg), options.signal);
    } else {
      progressCallback(0.1, "Rendering High-Precision Master Mix...");
    }

    const base = useFull ? this.fullBuffer : this.originalBuffer;
    const sampleRate = base.sampleRate;
    const numChannels = base.numberOfChannels;
    const numSamples = base.length;

    // Create OfflineAudioContext
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx = new OfflineContext(numChannels, numSamples, sampleRate);

    // Sum all 9 stems according to active gain / mute / solo settings
    const stemBus = offlineCtx.createGain();
    const anySolo = Object.values(this.stemSolos).some(v => v === true);

    if (useFull) {
      const src = offlineCtx.createBufferSource();
      src.buffer = mixed;
      src.connect(stemBus);
      src.start(0);
    }

    for (const def of (useFull ? [] : this.componentDefs)) {
      const stemBuffer = this.stems[def.id];
      if (stemBuffer) {
        const src = offlineCtx.createBufferSource();
        src.buffer = stemBuffer;

        const gainNode = offlineCtx.createGain();
        let targetGain = 0;
        if (this.stemMutes[def.id]) {
          targetGain = 0;
        } else if (anySolo) {
          targetGain = this.stemSolos[def.id] ? this.stemValues[def.id] : 0;
        } else {
          targetGain = this.stemValues[def.id];
        }

        gainNode.gain.value = targetGain;
        src.connect(gainNode);
        gainNode.connect(stemBus);
        src.start(0);
      }
    }

    // Apply High-Pass Rumble Filter in offline context
    const hp = offlineCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = this.dspSettings.highPassFreq || 20;
    hp.Q.value = 0.707;

    // Apply De-Hum Notch Filter in offline context
    const notch = offlineCtx.createBiquadFilter();
    AudioEngine.applyNotchConfig(notch, AudioEngine.notchConfig(this.dspSettings.deHumEnabled, this.dspSettings.deHumFreq));

    // Apply De-Esser in offline context
    const deEss = offlineCtx.createBiquadFilter();
    deEss.type = 'peaking';
    deEss.frequency.value = 6800;
    deEss.Q.value = 1.8;
    deEss.gain.value = -(this.dspSettings.deEsserAmount / 100.0) * 15.0;

    // Apply Master EQ & Dynamics in offline context
    const eqL = offlineCtx.createBiquadFilter();
    eqL.type = 'lowshelf';
    eqL.frequency.value = 120;
    eqL.gain.value = this.eqSettings.low;

    const eqM = offlineCtx.createBiquadFilter();
    eqM.type = 'peaking';
    eqM.frequency.value = 2500;
    eqM.Q.value = 1.2;
    eqM.gain.value = this.eqSettings.mid;

    const eqH = offlineCtx.createBiquadFilter();
    eqH.type = 'highshelf';
    eqH.frequency.value = 8000;
    eqH.gain.value = this.eqSettings.high;

    const comp = offlineCtx.createDynamicsCompressor();
    comp.threshold.value = this.compSettings.threshold;
    comp.knee.value = 12;
    comp.ratio.value = this.compSettings.ratio;
    comp.attack.value = this.compSettings.attack;
    comp.release.value = this.compSettings.release;

    // NOTE: use the stored master level, not masterGain.gain.value (which is 0 while paused/stopped)
    const master = offlineCtx.createGain();
    master.gain.value = this.masterGainLinear !== undefined ? this.masterGainLinear : 1.0;
    const limiter = AudioEngine.createLimiter(offlineCtx);

    stemBus.connect(hp);
    hp.connect(notch);
    notch.connect(deEss);
    deEss.connect(eqL);
    eqL.connect(eqM);
    eqM.connect(eqH);
    eqH.connect(comp);
    comp.connect(master);
    const softClip = AudioEngine.createSoftClipper(offlineCtx);
    master.connect(limiter);
    limiter.connect(softClip);
    softClip.connect(offlineCtx.destination);

    progressCallback(useFull ? 0.85 : 0.5, "Applying EQ, compression and limiter...");
    const renderedBuffer = await offlineCtx.startRendering();
    AudioEngine.guardPeaks(renderedBuffer);
    progressCallback(1.0, "Master Audio Rendered Successfully.");

    return renderedBuffer;
  }
}

/**
 * High-Performance Radix-2 Cooley-Tukey FFT with Precomputed Bit-Reversal
 */
class FastFFT {
  constructor(size) {
    this.size = size;
    const half = size / 2;
    this.cosTable = new Float32Array(half);
    this.sinTable = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }

    // Precompute bit-reversal swap pairs once at initialization
    const swapI = [];
    const swapJ = [];
    let j = 0;
    for (let i = 0; i < size - 1; i++) {
      if (i < j) {
        swapI.push(i);
        swapJ.push(j);
      }
      let k = size >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }
    this.swapI = new Int32Array(swapI);
    this.swapJ = new Int32Array(swapJ);
    this.numSwaps = swapI.length;
  }

  transform(real, imag) {
    const n = this.size;
    const swapI = this.swapI;
    const swapJ = this.swapJ;
    const numSwaps = this.numSwaps;

    // Instant bit-reversal permutation without bit shifts or while loops
    for (let s = 0; s < numSwaps; s++) {
      const i = swapI[s];
      const j = swapJ[s];
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }

    const cosTable = this.cosTable;
    const sinTable = this.sinTable;

    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        let k = 0;
        for (let j = 0; j < halfLen; j++) {
          const cos = cosTable[k];
          const sin = sinTable[k];
          const idx2 = i + j + halfLen;
          const idx1 = i + j;
          const tr = real[idx2] * cos - imag[idx2] * sin;
          const ti = real[idx2] * sin + imag[idx2] * cos;
          real[idx2] = real[idx1] - tr;
          imag[idx2] = imag[idx1] - ti;
          real[idx1] += tr;
          imag[idx1] += ti;
          k += step;
        }
      }
    }
  }

  inverseTransform(real, imag) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      imag[i] = -imag[i];
    }
    this.transform(real, imag);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      real[i] *= inv;
      imag[i] = -imag[i] * inv;
    }
  }
}

// Background workers load the same (cache-busted) copy of this file as the page
if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
  try { const u = new URL(document.currentScript.src); AudioEngine.workerUrl = new URL('stem-worker.js' + u.search, u).href; } catch (e) {}
}

window.AudioEngine = AudioEngine;
window.PcmFallback = PcmFallback;
window.FastFFT = FastFFT;
