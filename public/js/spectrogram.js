/**
 * SpectraClean AI - High-Resolution Spectrogram & Waveform Visualizer
 * - Dual visual display: Interactive Waveform & Frequency Spectrogram
 * - Color-mapped decibel heat map (Inferno/Magma palette)
 * - Multi-Mode Spectrogram Viewing:
 *   * 'cleaned' : Live Final Cleaned Output
 *   * 'split'   : Split Compare (Left: Before / Right: After)
 *   * 'original': Raw Unprocessed Audio
 *   * 'delta'   : Removed Noise & Attenuation Delta
 * - Frequency guides: Hum (50/60Hz), Traffic (20-220Hz), Formants (300-3400Hz), etc.
 * - Interactive Scrubbing Playhead & Frequency Probing Tooltip
 */

class AudioVisualizer {
  constructor(waveformCanvas, spectrogramCanvas, tooltipEl) {
    this.waveCanvas = waveformCanvas;
    this.specCanvas = spectrogramCanvas;
    this.tooltip = tooltipEl;

    this.waveCtx = waveformCanvas ? waveformCanvas.getContext('2d') : null;
    this.specCtx = spectrogramCanvas ? spectrogramCanvas.getContext('2d') : null;

    this.audioBuffer = null;
    this.processedBuffer = null;
    
    // Separate spectrogram matrices for Original, Processed, and Delta
    this.originalSpectrogramData = null;
    this.processedSpectrogramData = null;
    this.numSpecFrames = 0;
    this.numSpecBins = 0;
    this.maxFreq = 22050;
    this.minDb = -90;
    this.maxDb = 0;

    // View modes: 'cleaned' (default), 'split', 'original', 'delta'
    this.specViewMode = 'cleaned';

    this.currentTime = 0;
    this.duration = 0;
    this.isDragging = false;
    this.onSeek = null;

    // Live Voice State & Peak Envelopes for instantaneous 60fps rendering
    this.voiceState = {
      mainDb: 2.0,
      bgDb: 0.0,
      isMainMuted: false,
      isMainSolo: false,
      isBgMuted: false,
      isBgSolo: false,
      voiceBoostPct: 0,
      bgPreservePct: 100
    };
    this.stemPeaks = {};
    this.liveMixGains = {};
    this.liveMutes = {};
    this.liveSolos = {};

    // Offscreen Canvas for GPU-accelerated heatmap caching (prevents 240,000-pixel re-renders)
    this.specOffscreen = document.createElement('canvas');
    this.specOffscreen.width = spectrogramCanvas ? spectrogramCanvas.width : 1200;
    this.specOffscreen.height = spectrogramCanvas ? spectrogramCanvas.height : 200;
    this.specOffscreenCtx = this.specOffscreen.getContext('2d');
    this.hasCachedHeatmap = false;

    // Palette lookup table (Magma / Inferno 256 colors)
    this.colorMap = this.generateMagmaPalette();
    this.deltaColorMap = this.generateDeltaPalette();

    this.bindEvents();
  }

  generateMagmaPalette() {
    const palette = [];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let r, g, b;
      if (t < 0.25) {
        const u = t / 0.25;
        r = Math.floor(10 + 40 * u);
        g = Math.floor(5 + 15 * u);
        b = Math.floor(20 + 70 * u);
      } else if (t < 0.5) {
        const u = (t - 0.25) / 0.25;
        r = Math.floor(50 + 120 * u);
        g = Math.floor(20 + 40 * u);
        b = Math.floor(90 + 30 * u);
      } else if (t < 0.75) {
        const u = (t - 0.5) / 0.25;
        r = Math.floor(170 + 70 * u);
        g = Math.floor(60 + 90 * u);
        b = Math.floor(120 - 70 * u);
      } else {
        const u = (t - 0.75) / 0.25;
        r = Math.floor(240 + 15 * u);
        g = Math.floor(150 + 105 * u);
        b = Math.floor(50 + 150 * u);
      }
      palette.push([r, g, b]);
    }
    return palette;
  }

  generateDeltaPalette() {
    // Cyan to Electric Violet palette for removed noise
    const palette = [];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let r, g, b;
      if (t < 0.33) {
        const u = t / 0.33;
        r = Math.floor(5 + 20 * u);
        g = Math.floor(15 + 60 * u);
        b = Math.floor(30 + 120 * u);
      } else if (t < 0.66) {
        const u = (t - 0.33) / 0.33;
        r = Math.floor(25 + 160 * u);
        g = Math.floor(75 + 140 * u);
        b = Math.floor(150 + 80 * u);
      } else {
        const u = (t - 0.66) / 0.34;
        r = Math.floor(185 + 70 * u);
        g = Math.floor(215 + 40 * u);
        b = Math.floor(230 + 25 * u);
      }
      palette.push([r, g, b]);
    }
    return palette;
  }

  setAudioBuffers(originalBuffer, processedBuffer = null) {
    this.audioBuffer = originalBuffer;
    this.duration = originalBuffer ? originalBuffer.duration : 0;
    this.originalSpectrogramData = this.computeSpectrogramForBuffer(originalBuffer);
    this.hasCachedHeatmap = false;

    if (processedBuffer) {
      this.processedBuffer = processedBuffer;
      this.processedSpectrogramData = this.computeSpectrogramForBuffer(processedBuffer);
    } else {
      this.processedBuffer = null;
      this.processedSpectrogramData = this.originalSpectrogramData;
    }

    this.render();
  }

  setProcessedBuffer(buffer) {
    this.processedBuffer = buffer;
    if (buffer) {
      this.processedSpectrogramData = this.computeSpectrogramForBuffer(buffer);
    }
    this.hasCachedHeatmap = false;
    this.render();
  }

  setSpecViewMode(mode) {
    this.specViewMode = mode;
    this.hasCachedHeatmap = false;
    this.renderSpectrogram();
  }

  setVoiceState(voiceState) {
    this.voiceState = { ...this.voiceState, ...voiceState };
    this.renderSpectrogram();
    this.renderWaveform();
  }

  setStems(stems) {
    if (!stems || !this.waveCanvas) return;
    const width = this.waveCanvas.width || 1200;
    this.stemPeaks = {};

    for (const id in stems) {
      const buffer = stems[id];
      if (!buffer) continue;
      const channelData = buffer.getChannelData(0);
      const step = Math.ceil(channelData.length / width);
      const minArr = new Float32Array(width);
      const maxArr = new Float32Array(width);

      for (let x = 0; x < width; x++) {
        let min = 0;
        let max = 0;
        const startIdx = x * step;
        for (let j = 0; j < step && startIdx + j < channelData.length; j++) {
          const val = channelData[startIdx + j];
          if (val < min) min = val;
          if (val > max) max = val;
        }
        minArr[x] = min;
        maxArr[x] = max;
      }

      this.stemPeaks[id] = { min: minArr, max: maxArr };
    }
    this.renderWaveform();
  }

  updateLiveWaveform(stemValues, stemMutes = {}, stemSolos = {}) {
    this.liveMixGains = stemValues || {};
    this.liveMutes = stemMutes || {};
    this.liveSolos = stemSolos || {};
    this.renderWaveform();
  }

  computeSpectrogramForBuffer(buffer) {
    if (!buffer) return null;

    const channelData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    this.maxFreq = sampleRate / 2;

    const fftSize = 1024;
    const hopSize = 512;
    const halfFft = fftSize / 2;
    const numSamples = channelData.length;
    const numFrames = Math.floor((numSamples - fftSize) / hopSize) + 1;

    // Window
    const window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }

    const fft = new FastFFT(fftSize);
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    const specData = new Float32Array(numFrames * halfFft);
    this.numSpecFrames = numFrames;
    this.numSpecBins = halfFft;

    for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
      const offset = frameIdx * hopSize;
      for (let i = 0; i < fftSize; i++) {
        real[i] = channelData[offset + i] * window[i];
        imag[i] = 0;
      }

      fft.transform(real, imag);

      const frameBase = frameIdx * halfFft;
      for (let k = 0; k < halfFft; k++) {
        const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        const db = 20 * Math.log10(Math.max(1e-5, mag));
        specData[frameBase + k] = db;
      }
    }

    return specData;
  }

  render() {
    this.renderWaveform();
    this.renderSpectrogram();
  }

  renderWaveform() {
    if (!this.waveCtx || !this.audioBuffer) return;

    const canvas = this.waveCanvas;
    const ctx = this.waveCtx;
    const width = canvas.width;
    const height = canvas.height;
    const halfH = height / 2;

    ctx.clearRect(0, 0, width, height);

    const isLightTheme = document.body.dataset.theme === 'light';

    // Clean minimal background
    ctx.fillStyle = isLightTheme ? '#ffffff' : '#09090b';
    ctx.fillRect(0, 0, width, height);

    // Center baseline
    ctx.strokeStyle = isLightTheme ? '#e4e4e7' : '#27272a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, halfH);
    ctx.lineTo(width, halfH);
    ctx.stroke();

    const origData = this.audioBuffer.getChannelData(0);
    const step = Math.ceil(origData.length / width);

    // 1. Draw Original Waveform in subtle reference gray
    ctx.fillStyle = isLightTheme ? 'rgba(161, 161, 170, 0.35)' : 'rgba(113, 113, 122, 0.35)';
    for (let x = 0; x < width; x++) {
      let min = 1.0;
      let max = -1.0;
      const startIdx = x * step;
      for (let j = 0; j < step && startIdx + j < origData.length; j++) {
        const val = origData[startIdx + j];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      const yMin = halfH - max * (halfH - 8);
      const yMax = halfH - min * (halfH - 8);
      ctx.fillRect(x, yMin, 1, Math.max(1, yMax - yMin));
    }

    // 2. Draw Processed Waveform (Clean minimal high-contrast)
    const procWaveColor = isLightTheme ? '#18181b' : '#fafafa';
    const hasStemPeaks = this.stemPeaks && Object.keys(this.stemPeaks).length > 0;
    if (hasStemPeaks) {
      const anySolo = Object.values(this.liveSolos).some(v => v === true);
      const mixMin = new Float32Array(width);
      const mixMax = new Float32Array(width);

      for (const id in this.stemPeaks) {
        if (this.liveMutes[id]) continue;
        if (anySolo && !this.liveSolos[id]) continue;

        const gain = this.liveMixGains[id] !== undefined ? this.liveMixGains[id] : 1.0;
        if (gain <= 0) continue;

        const p = this.stemPeaks[id];
        for (let x = 0; x < width; x++) {
          mixMin[x] += p.min[x] * gain;
          mixMax[x] += p.max[x] * gain;
        }
      }

      ctx.fillStyle = procWaveColor;
      for (let x = 0; x < width; x++) {
        const yMin = halfH - mixMax[x] * (halfH - 8);
        const yMax = halfH - mixMin[x] * (halfH - 8);
        ctx.fillRect(x, Math.max(0, yMin), 1, Math.max(1, yMax - yMin));
      }
    } else if (this.processedBuffer) {
      const procData = this.processedBuffer.getChannelData(0);
      const procStep = Math.ceil(procData.length / width);

      ctx.fillStyle = procWaveColor;
      for (let x = 0; x < width; x++) {
        let min = 1.0;
        let max = -1.0;
        const startIdx = x * procStep;
        for (let j = 0; j < procStep && startIdx + j < procData.length; j++) {
          const val = procData[startIdx + j];
          if (val < min) min = val;
          if (val > max) max = val;
        }
        const yMin = halfH - max * (halfH - 8);
        const yMax = halfH - min * (halfH - 8);
        ctx.fillRect(x, yMin, 1, Math.max(1, yMax - yMin));
      }
    }

    // 3. Status Badge on Canvas
    ctx.font = '500 10px monospace';
    const mainDb = this.voiceState?.mainDb || 0;
    const isMuted = this.voiceState?.isMainMuted;
    ctx.fillStyle = isMuted ? '#ef4444' : (isLightTheme ? '#52525b' : '#a1a1aa');
    const badgeStatus = isMuted ? '● VOICE MUTED' : (mainDb > 0 ? `● VOICE ENHANCED (${mainDb > 0 ? '+' : ''}${mainDb.toFixed(1)} dB)` : '● CLEANED WAVEFORM (Live Mix)');
    ctx.fillText(badgeStatus, 12, 18);

    // 4. Playhead Scrubber Line
    if (this.duration > 0) {
      const playheadX = (this.currentTime / this.duration) * width;
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // Playhead handle
      ctx.fillStyle = '#f43f5e';
      ctx.beginPath();
      ctx.arc(playheadX, 6, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  renderSpectrogramHeatmap() {
    if (!this.specOffscreenCtx) return;

    const width = this.specOffscreen.width;
    const height = this.specOffscreen.height;
    const ctx = this.specOffscreenCtx;

    const origData = this.originalSpectrogramData;
    const procData = this.processedSpectrogramData || origData;
    if (!origData) return;

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    const numFrames = this.numSpecFrames;
    const halfFft = this.numSpecBins;
    const minDb = this.minDb;
    const maxDb = this.maxDb;
    const dbRange = maxDb - minDb;

    const mode = this.specViewMode;
    const halfWidth = Math.floor(width / 2);

    for (let x = 0; x < width; x++) {
      const frameIdx = Math.floor((x / width) * numFrames);
      const frameBase = frameIdx * halfFft;

      // Determine which data matrix to read for this x column
      let activeMatrix = procData;
      let isDelta = false;

      if (mode === 'original') {
        activeMatrix = origData;
      } else if (mode === 'split') {
        // Left side is Original, Right side is Processed
        activeMatrix = x < halfWidth ? origData : procData;
      } else if (mode === 'delta') {
        isDelta = true;
      } else {
        // 'cleaned'
        activeMatrix = procData;
      }

      for (let y = 0; y < height; y++) {
        const normY = 1.0 - y / height;
        const binFraction = Math.pow(normY, 1.8);
        const binIdx = Math.min(halfFft - 1, Math.floor(binFraction * halfFft));

        let db = 0;
        let colorArray = this.colorMap;

        if (isDelta) {
          // Difference: Original dB - Cleaned dB (how much noise was removed)
          const origDb = origData[frameBase + binIdx];
          const procDb = procData[frameBase + binIdx];
          const diff = Math.max(0, origDb - procDb);
          db = diff; // 0 to 40 dB reduction
          const normalized = Math.max(0, Math.min(1, diff / 30.0));
          const colorIdx = Math.floor(normalized * 255);
          colorArray = this.deltaColorMap;
          const [r, g, b] = colorArray[colorIdx] || [0, 0, 0];
          const pixelIdx = (y * width + x) * 4;
          data[pixelIdx] = r;
          data[pixelIdx + 1] = g;
          data[pixelIdx + 2] = b;
          data[pixelIdx + 3] = 255;
          continue;
        } else {
          db = activeMatrix[frameBase + binIdx];
        }

        const normalized = Math.max(0, Math.min(1, (db - minDb) / dbRange));
        const colorIdx = Math.floor(normalized * 255);
        const [r, g, b] = colorArray[colorIdx] || [0, 0, 0];

        const pixelIdx = (y * width + x) * 4;
        data[pixelIdx] = r;
        data[pixelIdx + 1] = g;
        data[pixelIdx + 2] = b;
        data[pixelIdx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    this.hasCachedHeatmap = true;
  }

  renderSpectrogram() {
    if (!this.specCtx) return;

    const canvas = this.specCanvas;
    const ctx = this.specCtx;
    const width = canvas.width;
    const height = canvas.height;

    if (!this.originalSpectrogramData) return;

    if (!this.hasCachedHeatmap) {
      this.renderSpectrogramHeatmap();
    }

    // Ultra-fast GPU Blit (<0.05ms)
    ctx.drawImage(this.specOffscreen, 0, 0, width, height);

    const mode = this.specViewMode;
    const halfWidth = Math.floor(width / 2);

    // If Split Mode: Draw vertical divider line
    if (mode === 'split') {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(halfWidth, 0);
      ctx.lineTo(halfWidth, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Labels on each side
      ctx.font = 'bold 11px monospace';
      ctx.fillStyle = '#f43f5e';
      ctx.fillText('◄ BEFORE (RAW ORIGINAL)', 14, 22);

      ctx.fillStyle = '#10b981';
      ctx.fillText('AFTER (FINAL CLEANED) ►', halfWidth + 14, 22);
    } else {
      // Draw view mode badge
      ctx.font = 'bold 11px monospace';
      if (mode === 'cleaned') {
        ctx.fillStyle = '#10b981';
        ctx.fillText('● DISPLAYING: FINAL CLEANED AUDIO SPECTRUM (Real-Time Output)', 14, 22);
      } else if (mode === 'original') {
        ctx.fillStyle = '#f43f5e';
        ctx.fillText('● DISPLAYING: RAW ORIGINAL SPECTRUM (Unprocessed Input)', 14, 22);
      } else if (mode === 'delta') {
        ctx.fillStyle = '#38bdf8';
        ctx.fillText('● DISPLAYING: REMOVED NOISE & FREQUENCY ATTENUATION (Delta)', 14, 22);
      }
    }

    // Draw Acoustic Layer Guideline Overlays
    this.drawAcousticGuides(ctx, width, height);

    // Draw Playhead
    if (this.duration > 0) {
      const playheadX = (this.currentTime / this.duration) * width;
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    }
  }

  drawAcousticGuides(ctx, width, height) {
    // 1. Live Voice Formant Band Overlay (300 Hz - 3400 Hz)
    if (this.voiceState) {
      const binFrac300 = 300 / this.maxFreq;
      const binFrac3400 = 3400 / this.maxFreq;
      const y300 = Math.floor((1.0 - Math.pow(binFrac300, 1 / 1.8)) * height);
      const y3400 = Math.floor((1.0 - Math.pow(binFrac3400, 1 / 1.8)) * height);

      const isMuted = this.voiceState.isMainMuted;
      const isSolo = this.voiceState.isMainSolo;
      const mainDb = this.voiceState.mainDb !== undefined ? this.voiceState.mainDb : 0;
      const bgDb = this.voiceState.bgDb !== undefined ? this.voiceState.bgDb : 0;

      // Radiant vocal formant band
      const grad = ctx.createLinearGradient(0, y3400, 0, y300);
      if (isMuted) {
        grad.addColorStop(0, 'rgba(239, 68, 68, 0.22)');
        grad.addColorStop(1, 'rgba(239, 68, 68, 0.06)');
      } else if (isSolo) {
        grad.addColorStop(0, 'rgba(245, 158, 11, 0.25)');
        grad.addColorStop(1, 'rgba(245, 158, 11, 0.08)');
      } else if (mainDb > 0) {
        grad.addColorStop(0, 'rgba(16, 185, 129, 0.24)');
        grad.addColorStop(1, 'rgba(6, 182, 212, 0.16)');
      } else {
        grad.addColorStop(0, 'rgba(6, 182, 212, 0.16)');
        grad.addColorStop(1, 'rgba(6, 182, 212, 0.06)');
      }

      ctx.fillStyle = grad;
      ctx.fillRect(0, y3400, width, Math.max(1, y300 - y3400));

      // Border lines for Speech Formant band
      ctx.strokeStyle = isMuted ? 'rgba(239, 68, 68, 0.65)' : (mainDb > 0 ? 'rgba(16, 185, 129, 0.75)' : 'rgba(6, 182, 212, 0.6)');
      ctx.setLineDash([6, 3]);
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.moveTo(0, y3400);
      ctx.lineTo(width, y3400);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, y300);
      ctx.lineTo(width, y300);
      ctx.stroke();
      ctx.setLineDash([]);

      // Live Voice HUD Badge directly on the Spectrogram
      ctx.font = 'bold 10px monospace';
      const mainText = isMuted ? 'MUTED 🔴' : `${mainDb > 0 ? '+' : ''}${mainDb.toFixed(1)} dB ${mainDb > 0 ? 'BOOSTED' : ''}`;
      const bgText = bgDb >= -1 ? '100% PRESERVED ✅' : `${bgDb.toFixed(1)} dB`;
      const badgeText = `🎙️ SPEECH FORMANTS (300Hz-3.4kHz) • Main Voice: ${mainText} | Background Voices: ${bgText}`;

      ctx.fillStyle = 'rgba(7, 10, 18, 0.88)';
      const textWidth = ctx.measureText(badgeText).width;
      ctx.fillRect(10, Math.max(10, y3400 + 4), textWidth + 16, 18);
      ctx.strokeStyle = isMuted ? '#ef4444' : (mainDb > 0 ? '#10b981' : '#06b6d4');
      ctx.lineWidth = 1;
      ctx.strokeRect(10, Math.max(10, y3400 + 4), textWidth + 16, 18);

      ctx.fillStyle = isMuted ? '#fca5a5' : (mainDb > 0 ? '#6ee7b7' : '#67e8f9');
      ctx.fillText(badgeText, 16, Math.max(10, y3400 + 4) + 13);
    }

    const guides = [
      { freq: 60, label: '60Hz Hum', color: 'rgba(234, 179, 8, 0.45)' },
      { freq: 150, label: 'Traffic Rumble', color: 'rgba(245, 158, 11, 0.45)' },
      { freq: 7000, label: 'Sibilance / Hiss', color: 'rgba(148, 163, 184, 0.45)' }
    ];

    ctx.font = '10px monospace';
    for (const guide of guides) {
      const binFraction = guide.freq / this.maxFreq;
      const normY = Math.pow(binFraction, 1 / 1.8);
      const y = Math.floor((1.0 - normY) * height);

      if (y > 10 && y < height - 10) {
        ctx.strokeStyle = guide.color;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = guide.color;
        ctx.fillText(guide.label, 8, y - 3);
      }
    }
  }

  updatePlayhead(timeInSeconds) {
    this.currentTime = timeInSeconds;
    this.render();
  }

  bindEvents() {
    const handleSeek = (e, canvas) => {
      if (!this.duration || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const fraction = Math.max(0, Math.min(1, clickX / rect.width));
      const targetTime = fraction * this.duration;
      if (this.onSeek) this.onSeek(targetTime);
    };

    [this.waveCanvas, this.specCanvas].forEach(canvas => {
      if (!canvas) return;

      canvas.addEventListener('mousedown', (e) => {
        this.isDragging = true;
        handleSeek(e, canvas);
      });

      canvas.addEventListener('mousemove', (e) => {
        if (this.isDragging) {
          if (!this._seekRaf) {
            this._seekRaf = requestAnimationFrame(() => {
              this._seekRaf = null;
              handleSeek(e, canvas);
            });
          }
        }
        this.updateTooltip(e, canvas);
      });

      canvas.addEventListener('mouseup', () => {
        if (this._seekRaf) {
          cancelAnimationFrame(this._seekRaf);
          this._seekRaf = null;
        }
        this.isDragging = false;
      });

      canvas.addEventListener('mouseleave', () => {
        if (this._seekRaf) {
          cancelAnimationFrame(this._seekRaf);
          this._seekRaf = null;
        }
        this.isDragging = false;
        if (this.tooltip) this.tooltip.style.display = 'none';
      });
    });
  }

  updateTooltip(e, canvas) {
    if (!this.tooltip || !this.duration) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const timeFrac = Math.max(0, Math.min(1, x / rect.width));
    const timeSec = (timeFrac * this.duration).toFixed(2);

    if (canvas === this.specCanvas) {
      const normY = 1.0 - y / rect.height;
      const binFraction = Math.pow(normY, 1.8);
      const freqHz = Math.floor(binFraction * this.maxFreq);

      let acousticTag = 'Ambient';
      if (freqHz <= 65) acousticTag = 'Sub-bass / Hum';
      else if (freqHz <= 220) acousticTag = 'Traffic / Engine Rumble';
      else if (freqHz <= 3500) acousticTag = 'Vocal Formants / Speech';
      else if (freqHz <= 7000) acousticTag = 'Presence / Fan Whine';
      else acousticTag = 'Hiss / Air';

      this.tooltip.innerHTML = `<strong>${timeSec}s</strong> | <strong>${freqHz} Hz</strong> <span style="color:#10b981">(${acousticTag})</span>`;
    } else {
      this.tooltip.innerHTML = `Time: <strong>${timeSec}s</strong> / ${this.duration.toFixed(2)}s`;
    }

    this.tooltip.style.left = `${e.clientX + 14}px`;
    this.tooltip.style.top = `${e.clientY - 24}px`;
    this.tooltip.style.display = 'block';
  }
}

window.AudioVisualizer = AudioVisualizer;
