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

    this.isGraphSetup = false;
  }

  /**
   * Fast peak limiter (brick-wall style compressor) that stops boosted audio from clipping.
   */
  static createLimiter(ctx) {
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -1.0;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;
    return lim;
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
        this.originalBuffer = buf;
        resolve(buf);
      };
      const onErr = (err) => {
        if (isSettled) return;
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

  /**
   * Runs the AI Spectral Decomposition into 9 Estimated Components.
   * Uses Fast STFT analysis and psychoacoustic spectral masking.
   */
  async analyzeAndDecompose(progressCallback = () => {}, abortSignal = null) {
    if (!this.originalBuffer) throw new Error("No audio loaded");
    if (abortSignal && abortSignal.aborted) {
      throw new DOMException("Decomposition aborted by user", "AbortError");
    }

    const sampleRate = this.originalBuffer.sampleRate;
    const numChannels = this.originalBuffer.numberOfChannels;
    const numSamples = this.originalBuffer.length;

    // Masks are estimated from a mono (mid) mix, then applied to each channel so the
    // stereo image of the original is preserved in every stem.
    const inputLeft = this.originalBuffer.getChannelData(0);
    const inputRight = numChannels > 1 ? this.originalBuffer.getChannelData(1) : inputLeft;
    const isStereo = numChannels > 1;

    // STFT Parameters
    const fftSize = 2048;
    const hopSize = 512;
    const halfFft = fftSize / 2;
    const numFrames = Math.floor((numSamples - fftSize) / hopSize) + 1;

    // Hanning Window
    const window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }

    // Allocate 9 stem arrays for output left and right
    const stemIds = this.componentDefs.map(c => c.id);
    const stemLeft = {};
    const stemRight = {};
    const energyAccumulators = {};

    for (const id of stemIds) {
      stemLeft[id] = new Float32Array(numSamples);
      stemRight[id] = new Float32Array(numSamples);
      energyAccumulators[id] = 0;
    }

    // Prepare FFT tables
    const fft = new FastFFT(fftSize);

    // Frame buffers
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    const mag = new Float32Array(halfFft);
    const freqHz = new Float32Array(halfFft);

    for (let k = 0; k < halfFft; k++) {
      freqHz[k] = (k * sampleRate) / fftSize;
    }

    // Running noise floor tracker (minimum statistics over time frames for fan/hiss)
    const noiseFloor = new Float32Array(halfFft).fill(1e-4);
    const speechPresenceHistory = new Float32Array(numFrames);

    // Precompute electrical hum target bins once (eliminates 1M+ inner loop allocations)
    const isHumBin = new Uint8Array(halfFft);
    const humTargets = [50, 60, 100, 120, 150, 180, 200, 240, 300, 360, 480];
    for (let k = 0; k < halfFft; k++) {
      const f = freqHz[k];
      for (let t = 0; t < humTargets.length; t++) {
        if (Math.abs(f - humTargets[t]) <= 2.2) {
          isHumBin[k] = 1;
          break;
        }
      }
    }

    const getTime = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let lastYield = getTime();

    // First pass: Track spectral stationary baseline and speech presence
    for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
      if (abortSignal && abortSignal.aborted) {
        throw new DOMException("Decomposition aborted by user", "AbortError");
      }
      const now = getTime();
      if (now - lastYield > 20) {
        await yieldToUI();
        lastYield = getTime();
        progressCallback(0.1 + 0.3 * (frameIdx / numFrames), "AI Spectral Modeling: Estimating Acoustic Floors & Formants...");
      }

      const offset = frameIdx * hopSize;
      for (let i = 0; i < fftSize; i++) {
        real[i] = (isStereo ? 0.5 * (inputLeft[offset + i] + inputRight[offset + i]) : inputLeft[offset + i]) * window[i];
        imag[i] = 0;
      }

      fft.transform(real, imag);

      let frameVocalEnergy = 0;
      let totalFrameEnergy = 0;

      for (let k = 0; k < halfFft; k++) {
        const m = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        mag[k] = m;
        totalFrameEnergy += m;

        // Track minimum statistics for stationary noise (Fan / AC / Hiss)
        if (m < noiseFloor[k]) {
          noiseFloor[k] = noiseFloor[k] * 0.9 + m * 0.1;
        } else {
          noiseFloor[k] = noiseFloor[k] * 0.999 + m * 0.001;
        }

        // Formant speech band (300Hz - 3400Hz)
        if (freqHz[k] >= 300 && freqHz[k] <= 3400) {
          frameVocalEnergy += m;
        }
      }

      speechPresenceHistory[frameIdx] = totalFrameEnergy > 0 ? frameVocalEnergy / totalFrameEnergy : 0;
    }

    // Second pass: Multi-Component Spectral Masking & Inverse STFT Synthesis
    const windowSum = new Float32Array(numSamples);
    const numStems = stemIds.length;
    const stemIdMap = {};
    stemIds.forEach((id, idx) => { stemIdMap[id] = idx; });

    // Pre-allocate mask arrays ONCE outside frame loop (eliminates 10,000+ GC heap allocations)
    const stemMasks = new Array(numStems);
    const prevMasks = new Array(numStems);
    for (let s = 0; s < numStems; s++) {
      stemMasks[s] = new Float32Array(halfFft);
      prevMasks[s] = new Float32Array(halfFft);
    }

    // Direct numeric indices:
    const IDX_MAIN   = stemIdMap['main_voice'];
    const IDX_BG     = stemIdMap['bg_voice'];
    const IDX_TRAF   = stemIdMap['traffic'];
    const IDX_WIND   = stemIdMap['wind'];
    const IDX_FAN    = stemIdMap['fan_ac'];
    const IDX_HUM    = stemIdMap['hum'];
    const IDX_MUSIC  = stemIdMap['music'];
    const IDX_NOISE  = stemIdMap['noise'];
    const IDX_REVERB = stemIdMap['reverb'];

    const stemLeftArr = stemIds.map(id => stemLeft[id]);
    const stemRightArr = stemIds.map(id => stemRight[id]);
    const energyAccumArr = new Float64Array(numStems);

    // Prepare stem-specific FFT buffers
    const origSpecReal = new Float32Array(fftSize);
    const origSpecImag = new Float32Array(fftSize);
    const stemReal = new Float32Array(fftSize);
    const stemImag = new Float32Array(fftSize);

    lastYield = getTime();

    for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
      if (abortSignal && abortSignal.aborted) {
        throw new DOMException("Decomposition aborted by user", "AbortError");
      }
      const now = getTime();
      if (now - lastYield > 20) {
        await yieldToUI();
        lastYield = getTime();
        progressCallback(0.4 + 0.5 * (frameIdx / numFrames), "AI Stem Separation: Synthesizing 9 Component Channels...");
      }

      const offset = frameIdx * hopSize;

      // One complex FFT carries both channels (L in real part, R in imaginary part)
      for (let i = 0; i < fftSize; i++) {
        real[i] = inputLeft[offset + i] * window[i];
        imag[i] = isStereo ? inputRight[offset + i] * window[i] : 0;
      }
      fft.transform(real, imag);

      // Keep the packed spectrum Z = L + jR for synthesis
      for (let i = 0; i < fftSize; i++) {
        origSpecReal[i] = real[i];
        origSpecImag[i] = imag[i];
      }

      // Mid-channel magnitude per bin: M = (L + R) / 2 = (Z[k] + conj(Z[N-k])) / 2 * ... (see derivation below)
      // L[k] = (Z[k] + conj(Z[N-k])) / 2 ,  R[k] = (Z[k] - conj(Z[N-k])) / (2j)
      for (let k = 0; k < halfFft; k++) {
        const nk = k === 0 ? 0 : fftSize - k;
        const zr = origSpecReal[k], zi = origSpecImag[k];
        const cr = origSpecReal[nk], ci = -origSpecImag[nk];
        const lr = 0.5 * (zr + cr), li = 0.5 * (zi + ci);
        let mr = lr, mi = li;
        if (isStereo) {
          const rr = 0.5 * (zi - ci), ri = -0.5 * (zr - cr);
          mr = 0.5 * (lr + rr); mi = 0.5 * (li + ri);
        }
        mag[k] = Math.sqrt(mr * mr + mi * mi);
      }

      const vocalProminence = speechPresenceHistory[frameIdx];

      // Reset pre-allocated mask buffers (zero GC)
      for (let s = 0; s < numStems; s++) {
        stemMasks[s].fill(0);
      }

      for (let k = 0; k < halfFft; k++) {
        const f = freqHz[k];
        const m = mag[k];
        const baseline = noiseFloor[k] || 1e-5;
        const snr = m / (baseline + 1e-6);

        // Sub-bass rumble (< 35 Hz) -> direct to traffic
        if (f < 35) {
          stemMasks[IDX_TRAF][k] = 0.92;
        }

        // 1. Hum (50/60 Hz harmonics from precomputed bit-table)
        if (isHumBin[k] && snr > 1.8) {
          stemMasks[IDX_HUM][k] = 0.88;
        }

        // 2. Traffic / Vehicles: Low frequency rumble 35Hz - 220Hz
        if (f >= 35 && f <= 220 && !stemMasks[IDX_HUM][k]) {
          stemMasks[IDX_TRAF][k] = Math.min(1.0, (220 - f) / 180) * 0.78;
        }

        // 3. Wind: Low-mid turbulent gusts (30Hz - 380Hz)
        if (f >= 30 && f <= 380) {
          stemMasks[IDX_WIND][k] = 0.28 * (1.0 - Math.min(1.0, snr / 10.0));
        }

        // 4. Fan / AC: Stationary floor in 200Hz - 5500Hz
        if (f >= 200 && f <= 5500) {
          stemMasks[IDX_FAN][k] = Math.min(1.0, baseline / (m + 1e-6)) * 0.70;
        }

        // 5. General Noise / Hiss: High frequency stationary floor
        if (f > 4000) {
          const hissRatio = Math.min(1.0, baseline / (m + 1e-6));
          stemMasks[IDX_NOISE][k] = hissRatio * 0.75;
        }

        // 6. Speech Formant Bands: Foreground Voice vs Background Chatter
        const isPeak = k > 1 && k < halfFft - 1 && m > mag[k-1] && m > mag[k+1];

        if (f >= 280 && f <= 3800) {
          if (vocalProminence > 0.40 && snr > 2.2) {
            stemMasks[IDX_MAIN][k] = isPeak ? 0.90 : 0.78;
            stemMasks[IDX_BG][k]   = isPeak ? 0.06 : 0.14;
          } else if (vocalProminence > 0.20 || (snr > 1.15 && snr <= 2.2)) {
            stemMasks[IDX_MAIN][k] = 0.16;
            stemMasks[IDX_BG][k]   = 0.74;
          }
        }

        // 7. Music: Harmonic persistence above vocal band
        if (f >= 500 && f <= 8000 && snr > 3.0 && vocalProminence < 0.35) {
          stemMasks[IDX_MUSIC][k] = 0.65;
        }

        // 8. Reverb / Echo: Diffuse decay tail in mid frequencies
        if (f >= 300 && f <= 4500 && vocalProminence < 0.28 && snr > 1.05 && snr < 1.9) {
          stemMasks[IDX_REVERB][k] = 0.38;
        }

        // Normalization: Ensure sum of masks = 1.0 (Full energy conservation)
        let maskSum = 0;
        for (let s = 0; s < numStems; s++) {
          maskSum += stemMasks[s][k];
        }

        if (maskSum > 0) {
          const invSum = 1.0 / maskSum;
          for (let s = 0; s < numStems; s++) {
            stemMasks[s][k] *= invSum;
          }
        } else {
          stemMasks[IDX_NOISE][k] = 1.0;
        }

        // Adaptive Temporal Smoothing: Fast attack (0.85), smooth decay (0.42)
        let smoothSum = 0;
        for (let s = 0; s < numStems; s++) {
          const cur = stemMasks[s][k];
          const prev = prevMasks[s][k];
          const alpha = cur > prev ? 0.85 : 0.42;
          const smoothed = prev + alpha * (cur - prev);
          stemMasks[s][k] = smoothed;
          prevMasks[s][k] = smoothed;
          smoothSum += smoothed;
        }
        if (smoothSum > 0) {
          const invSmooth = 1.0 / smoothSum;
          for (let s = 0; s < numStems; s++) {
            stemMasks[s][k] *= invSmooth;
          }
        }

        // Accumulate energy statistics for UI
        for (let s = 0; s < numStems; s++) {
          energyAccumArr[s] += m * stemMasks[s][k];
        }
      }

      // Synthesize each stem: a real-valued mask is symmetric, so masking Z = L + jR and
      // inverse-transforming returns the stem's left channel (real) and right channel (imag).
      for (let s = 0; s < numStems; s++) {
        const mask = stemMasks[s];
        stemReal[0] = origSpecReal[0] * mask[0];
        stemImag[0] = origSpecImag[0] * mask[0];
        for (let k = 1; k < halfFft; k++) {
          const w = mask[k];
          stemReal[k] = origSpecReal[k] * w;
          stemImag[k] = origSpecImag[k] * w;
          stemReal[fftSize - k] = origSpecReal[fftSize - k] * w;
          stemImag[fftSize - k] = origSpecImag[fftSize - k] * w;
        }
        stemReal[halfFft] = origSpecReal[halfFft] * mask[halfFft - 1];
        stemImag[halfFft] = origSpecImag[halfFft] * mask[halfFft - 1];

        fft.inverseTransform(stemReal, stemImag);

        const targetL = stemLeftArr[s];
        const targetR = stemRightArr[s];
        for (let i = 0; i < fftSize; i++) {
          targetL[offset + i] += stemReal[i] * window[i];
          if (isStereo) targetR[offset + i] += stemImag[i] * window[i];
        }
      }

      // Window overlap sum for normalization
      for (let i = 0; i < fftSize; i++) {
        windowSum[offset + i] += window[i] * window[i];
      }
    }

    // Normalize overlap-add by window sum
    for (let i = 0; i < numSamples; i++) {
      const norm = windowSum[i] > 1e-4 ? 1.0 / windowSum[i] : 1.0;
      for (let s = 0; s < numStems; s++) {
        stemLeftArr[s][i] *= norm;
        stemRightArr[s][i] *= norm;
      }
    }

    // Calculate energy percentages for UI display
    let totalAllEnergy = 0;
    for (let s = 0; s < numStems; s++) {
      totalAllEnergy += energyAccumArr[s];
    }
    for (let s = 0; s < numStems; s++) {
      const id = stemIds[s];
      this.componentEnergy[id] = totalAllEnergy > 0 ? (energyAccumArr[s] / totalAllEnergy) * 100 : 0;
    }
    if (!isStereo) {
      for (const id of stemIds) stemRight[id].set(stemLeft[id]);
    }
    // Create AudioBuffers for each stem
    for (const id of stemIds) {
      const buffer = this.audioContext.createBuffer(2, numSamples, sampleRate);
      buffer.copyToChannel(stemLeft[id], 0);
      buffer.copyToChannel(stemRight[id], 1);
      this.stems[id] = buffer;
      this.stemValues[id] = 1.0; // 0 dB unity gain default
      this.stemMutes[id] = false;
      this.stemSolos[id] = false;
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
    this.notchHum.type = 'notch';
    this.notchHum.frequency.value = this.dspSettings.deHumFreq || 60;
    this.notchHum.Q.value = this.dspSettings.deHumEnabled ? 14.0 : 0.001;

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
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.audioContext.destination);

    // 9. Master Analyser for real-time output VU meter
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.limiter.connect(this.analyser);

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
    this.dspSettings.deHumMode = mode;
    if (!this.audioContext || !this.notchHum) return;
    const now = this.audioContext.currentTime;
    if (mode === '50hz') {
      this.notchHum.frequency.setValueAtTime(50, now);
      this.notchHum.Q.setValueAtTime(14.0, now);
      this.dspSettings.deHumEnabled = true;
    } else if (mode === '60hz') {
      this.notchHum.frequency.setValueAtTime(60, now);
      this.notchHum.Q.setValueAtTime(14.0, now);
      this.dspSettings.deHumEnabled = true;
    } else {
      this.notchHum.frequency.setValueAtTime(10, now);
      this.notchHum.Q.setValueAtTime(0.001, now);
      this.dspSettings.deHumEnabled = false;
    }
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
  async renderCleanedAudioBuffer(progressCallback = () => {}) {
    if (!this.originalBuffer || !this.stems.main_voice) {
      throw new Error("No decomposed audio available to render");
    }

    progressCallback(0.1, "Rendering High-Precision Master Mix...");

    const sampleRate = this.originalBuffer.sampleRate;
    const numChannels = this.originalBuffer.numberOfChannels;
    const numSamples = this.originalBuffer.length;

    // Create OfflineAudioContext
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx = new OfflineContext(numChannels, numSamples, sampleRate);

    // Sum all 9 stems according to active gain / mute / solo settings
    const stemBus = offlineCtx.createGain();
    const anySolo = Object.values(this.stemSolos).some(v => v === true);

    for (const def of this.componentDefs) {
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
    notch.type = 'notch';
    notch.frequency.value = this.dspSettings.deHumFreq || 60;
    notch.Q.value = this.dspSettings.deHumEnabled ? 14.0 : 0.001;

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
    master.connect(limiter);
    limiter.connect(offlineCtx.destination);

    progressCallback(0.5, "Mastering Audio Engine Running...");
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
window.FastFFT = FastFFT;
