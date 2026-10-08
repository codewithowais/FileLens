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

      if (f < 35) stemMasks[IDX.traffic][k] = 0.92;                                                   // sub-bass rumble
      if (isHumBin[k] && snr > 1.8) stemMasks[IDX.hum][k] = 0.88;                                       // mains hum
      if (f >= 35 && f <= 220 && !stemMasks[IDX.hum][k]) stemMasks[IDX.traffic][k] = Math.min(1.0, (220 - f) / 180) * 0.78;
      if (f >= 30 && f <= 380) stemMasks[IDX.wind][k] = 0.28 * (1.0 - Math.min(1.0, snr / 10.0));
      if (f >= 200 && f <= 5500) stemMasks[IDX.fan][k] = Math.min(1.0, baseline / (m + 1e-6)) * 0.70;
      if (f > 4000) stemMasks[IDX.noise][k] = Math.min(1.0, baseline / (m + 1e-6)) * 0.75;

      const isPeak = k > 1 && k < halfFft - 1 && m > mag[k - 1] && m > mag[k + 1];
      if (f >= 280 && f <= 3800) {
        if (vocalProminence > 0.40 && snr > 2.2) { stemMasks[IDX.main][k] = isPeak ? 0.90 : 0.78; stemMasks[IDX.bg][k] = isPeak ? 0.06 : 0.14; }
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
  async decodeAudio(arrayBuffer) {
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
  setExcerpt(startSec = 0, maxSec = AudioEngine.MAX_PREVIEW_SECONDS) {
    const full = this.fullBuffer || this.originalBuffer;
    if (!full) return;
    this.fullBuffer = full;
    const sr = full.sampleRate, total = full.length;
    const len = Math.min(total, Math.round(maxSec * sr));
    if (len >= total) { this.originalBuffer = full; this.isExcerpt = false; this.excerptStart = 0; return; }
    const start = Math.max(0, Math.min(total - len, Math.round(startSec * sr)));
    const b = this.audioContext.createBuffer(full.numberOfChannels, len, sr);
    for (let c = 0; c < full.numberOfChannels; c++) b.copyToChannel(full.getChannelData(c).subarray(start, start + len), c);
    this.originalBuffer = b; this.isExcerpt = true; this.excerptStart = start / sr;
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
   * ~15% of frames. Frames are sampled evenly across the WHOLE recording (at most ~12,000 of them),
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
    const stride = Math.max(1, Math.floor(numFrames / 12000));
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

  /**
   * Runs the AI Spectral Decomposition into 9 Estimated Components.
   * Uses Fast STFT analysis and psychoacoustic spectral masking.
   */
  async analyzeAndDecompose(progressCallback = () => {}, abortSignal = null) {
    if (!this.originalBuffer) throw new Error("No audio loaded");
    if (abortSignal && abortSignal.aborted) throw AudioEngine.abortError();

    const sampleRate = this.originalBuffer.sampleRate;
    const numChannels = this.originalBuffer.numberOfChannels;
    const numSamples = this.originalBuffer.length;
    // Masks are estimated from a mono (mid) mix, then applied to each channel so the
    // stereo image of the original is preserved in every stem.
    const inputLeft = this.originalBuffer.getChannelData(0);
    const inputRight = numChannels > 1 ? this.originalBuffer.getChannelData(1) : inputLeft;
    const isStereo = numChannels > 1;

    const { fftSize, hopSize } = AudioEngine.STFT;
    const halfFft = fftSize / 2;
    const numFrames = Math.floor((numSamples - fftSize) / hopSize) + 1;
    const window = AudioEngine.hannWindow();
    const stemIds = this.componentDefs.map(c => c.id);
    const numStems = stemIds.length;

    // Pass 1: learn the background noise from the WHOLE recording (not just the preview window)
    const { noiseFloor } = await this.getNoiseStats(this.fullBuffer || this.originalBuffer,
      (p) => progressCallback(0.1 + 0.3 * p, "AI Spectral Modeling: Estimating Acoustic Floors & Formants..."), abortSignal);
    const kSpeech0 = Math.ceil(300 * fftSize / sampleRate), kSpeech1 = Math.floor(3400 * fftSize / sampleRate);

    // Stems are written straight into AudioBuffers (no second copy in memory)
    const stemBuffers = {}, stemLeft = {}, stemRight = {};
    for (const id of stemIds) {
      stemBuffers[id] = this.audioContext.createBuffer(2, numSamples, sampleRate);
      stemLeft[id] = stemBuffers[id].getChannelData(0);
      stemRight[id] = stemBuffers[id].getChannelData(1);
    }
    const stemLeftArr = stemIds.map(id => stemLeft[id]);
    const stemRightArr = stemIds.map(id => stemRight[id]);
    const energyAccumArr = new Float64Array(numStems);

    const masker = new StemMasker(sampleRate, fftSize, stemIds);
    const fft = new FastFFT(fftSize);
    const real = new Float32Array(fftSize), imag = new Float32Array(fftSize);
    const origSpecReal = new Float32Array(fftSize), origSpecImag = new Float32Array(fftSize);
    const stemReal = new Float32Array(fftSize), stemImag = new Float32Array(fftSize);
    const mag = new Float32Array(halfFft);
    const windowSum = new Float32Array(numSamples);
    let lastYield = AudioEngine.now();

    // Pass 2: multi-component spectral masking and inverse STFT synthesis
    for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
      if (abortSignal && abortSignal.aborted) throw AudioEngine.abortError();
      if (AudioEngine.now() - lastYield > 20) {
        await yieldToUI(); lastYield = AudioEngine.now();
        progressCallback(0.4 + 0.5 * (frameIdx / numFrames), "AI Stem Separation: Synthesizing 9 Component Channels...");
      }
      const offset = frameIdx * hopSize;
      // One complex FFT carries both channels (L in real part, R in imaginary part)
      for (let i = 0; i < fftSize; i++) { real[i] = inputLeft[offset + i] * window[i]; imag[i] = isStereo ? inputRight[offset + i] * window[i] : 0; }
      fft.transform(real, imag);
      for (let i = 0; i < fftSize; i++) { origSpecReal[i] = real[i]; origSpecImag[i] = imag[i]; }
      AudioEngine.midMagnitudes(origSpecReal, origSpecImag, fftSize, isStereo, mag);

      let vocal = 0, total = 0;
      for (let k = 0; k < halfFft; k++) { total += mag[k]; if (k >= kSpeech0 && k <= kSpeech1) vocal += mag[k]; }
      const stemMasks = masker.compute(mag, noiseFloor, total > 0 ? vocal / total : 0, energyAccumArr);

      // Synthesize each stem: a real-valued mask is symmetric, so masking Z = L + jR and
      // inverse-transforming returns the stem's left channel (real) and right channel (imag).
      for (let s = 0; s < numStems; s++) {
        const mask = stemMasks[s];
        stemReal[0] = origSpecReal[0] * mask[0]; stemImag[0] = origSpecImag[0] * mask[0];
        for (let k = 1; k < halfFft; k++) {
          const w = mask[k];
          stemReal[k] = origSpecReal[k] * w; stemImag[k] = origSpecImag[k] * w;
          stemReal[fftSize - k] = origSpecReal[fftSize - k] * w; stemImag[fftSize - k] = origSpecImag[fftSize - k] * w;
        }
        stemReal[halfFft] = origSpecReal[halfFft] * mask[halfFft - 1]; stemImag[halfFft] = origSpecImag[halfFft] * mask[halfFft - 1];
        fft.inverseTransform(stemReal, stemImag);
        const targetL = stemLeftArr[s], targetR = stemRightArr[s];
        for (let i = 0; i < fftSize; i++) {
          targetL[offset + i] += stemReal[i] * window[i];
          if (isStereo) targetR[offset + i] += stemImag[i] * window[i];
        }
      }
      for (let i = 0; i < fftSize; i++) windowSum[offset + i] += window[i] * window[i];
    }

    // Normalize overlap-add by window sum
    for (let i = 0; i < numSamples; i++) {
      const norm = windowSum[i] > 1e-4 ? 1.0 / windowSum[i] : 1.0;
      for (let s = 0; s < numStems; s++) { stemLeftArr[s][i] *= norm; stemRightArr[s][i] *= norm; }
    }
    if (!isStereo) for (const id of stemIds) stemRight[id].set(stemLeft[id]);

    // Energy percentages for UI display
    let totalAllEnergy = 0;
    for (let s = 0; s < numStems; s++) totalAllEnergy += energyAccumArr[s];
    for (let s = 0; s < numStems; s++) this.componentEnergy[stemIds[s]] = totalAllEnergy > 0 ? (energyAccumArr[s] / totalAllEnergy) * 100 : 0;
    for (const id of stemIds) {
      this.stems[id] = stemBuffers[id];
      this.stemValues[id] = 1.0; this.stemMutes[id] = false; this.stemSolos[id] = false;
    }
    progressCallback(1.0, "AI Decomposition Complete: 9 Component Layers Isolated.");
    return { stems: this.stems, energy: this.componentEnergy };
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

  applyAutoClean() {
    this.applyPreset('cafe_preserve_voices');
    this.setDeHum('60hz');
    this.setHighPassFilter(40);
    this.setDeEsser(25);
    this.setDeReverb(20);
    this.setEQ(0, 1.5, 0.5);
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

window.AudioEngine = AudioEngine;
window.PcmFallback = PcmFallback;
window.FastFFT = FastFFT;
