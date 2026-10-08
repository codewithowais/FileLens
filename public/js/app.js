/**
 * FileLens - Master Application Controller
 * Wires together Audio Engine, Spectrogram Visualizer, FFprobe Inspector,
 * Multi-Stem Mixer Console, Transport, and Lossless Exporters.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Instances
  const audioEngine = new AudioEngine();
  let visualizer = null;
  let currentFile = null;
  let ffprobeData = null;
  let animationFrameId = null;

  // DOM Elements
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const btnLoadDemoWav = document.getElementById('btnLoadDemoWav');
  const btnLoadDemoMp4 = document.getElementById('btnLoadDemoMp4');
  const btnQuickDemoWav = document.getElementById('btnQuickDemoWav');
  const btnPasteClipboard = document.getElementById('btnPasteClipboard');
  const toastNotification = document.getElementById('toastNotification');
  let toastTimeout = null;

  // Progress & Cancellation Elements
  const progressOverlay = document.getElementById('progressOverlay');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  const progressStatus = document.getElementById('progressStatus');
  const progressSubstatus = document.getElementById('progressSubstatus');
  const btnCancelProgress = document.getElementById('btnCancelProgress');
  const btnOverlayClose = document.getElementById('btnOverlayClose');
  const progressWatchdogNotice = document.getElementById('progressWatchdogNotice');

  let activeAbortController = null;
  let progressWatchdogTimer = null;

  function cancelCurrentOperation() {
    stopPlayback();
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    hideProgress();
    showToast("⏹️ Operation cancelled. Workspace is ready.", "info", 3000);
  }

  if (btnCancelProgress) btnCancelProgress.addEventListener('click', cancelCurrentOperation);
  if (btnOverlayClose) btnOverlayClose.addEventListener('click', cancelCurrentOperation);

  function showToast(message, type = 'info', duration = 3500) {
    if (!toastNotification) return;
    toastNotification.className = `toast-notification ${type}`;
    toastNotification.innerHTML = message;
    toastNotification.style.display = 'flex';
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toastNotification.style.display = 'none';
    }, duration);
  }

  const workspace = document.getElementById('workspace');
  const audioProcessingSection = document.getElementById('audioProcessingSection');
  const metadataSection = document.getElementById('metadataSection');
  const nonAudioNotice = document.getElementById('nonAudioNotice');

  // Workspace Mode Navigation Bar Buttons
  const btnModeStudio = document.getElementById('btnModeStudio');
  const btnModeMetadata = document.getElementById('btnModeMetadata');
  let currentWorkspaceView = 'studio';

  function isSupportedMedia(file) {
    // Universal support: any file can be inspected for full metadata & forensics
    return Boolean(file);
  }

  // ==========================================================================
  // Audio Cleaning Studio — prepared on demand so metadata appears instantly
  // ==========================================================================
  const PREWARM_MAX_BYTES = 25 * 1024 * 1024;
  let studioState = 'idle'; // idle | loading | ready | error
  let studioPromise = null;
  let pendingAudioBytes = null;

  function setStudioProgress(fraction, text) {
    const bar = document.getElementById('studioLoadingBar');
    const label = document.getElementById('studioLoadingText');
    if (bar) bar.style.width = Math.round(fraction * 100) + '%';
    if (label) label.textContent = text;
  }

  function setStudioBusy(busy) {
    if (audioProcessingSection) audioProcessingSection.classList.toggle('studio-busy', busy);
    const box = document.getElementById('studioLoading');
    if (box) box.style.display = busy ? 'flex' : 'none';
  }

  // ---- Long recordings: choose which part to preview -----------------------------------------
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s2).padStart(2, '0');
  }
  function parseClock(text) {
    const parts = String(text).trim().split(':').map(x => x.trim());
    if (!parts.length || parts.length > 3 || parts.some(x => !/^\d+(\.\d+)?$/.test(x))) return NaN;
    return parts.reduce((acc, x) => acc * 60 + parseFloat(x), 0);
  }

  // The player's clock and slider cover the WHOLE recording; only a part of it is loaded at a time.
  function windowOffset() { return audioEngine.isExcerpt ? (audioEngine.excerptStart || 0) : 0; }
  function totalDuration() { return audioEngine.isExcerpt && audioEngine.fullBuffer ? audioEngine.fullBuffer.duration : audioEngine.getDuration(); }
  function updateDurationLabel() {
    if (durationDisplay) durationDisplay.textContent = formatTime(totalDuration());
  }
  function refreshTransport() {
    const total = totalDuration(), t = windowOffset() + audioEngine.getCurrentTime();
    if (currentTimeDisplay) currentTimeDisplay.textContent = formatTime(t);
    if (timelineScrubber && total > 0) timelineScrubber.value = (t / total) * 100;
  }
  /** Jump anywhere in the whole recording, loading the part that contains it when needed. */
  async function seekGlobal(t, resume) {
    const total = totalDuration();
    if (!(total > 0)) return;
    t = Math.max(0, Math.min(total - 0.05, t));
    const off = windowOffset(), len = audioEngine.getDuration();
    if (!audioEngine.isExcerpt || (t >= off && t < off + len - 0.05)) {
      audioEngine.seek(t - off);
    } else {
      showToast('Loading that part of the recording…', 'info', 2500);
      await previewFrom(t);
      if (studioState !== 'ready') return;
      audioEngine.seek(Math.max(0, t - windowOffset()));
    }
    if (previewVideo && currentFile && currentFile.type.includes('video')) previewVideo.currentTime = t;
    refreshTransport();
    if (visualizer && visualizer.updatePlayhead) visualizer.updatePlayhead(audioEngine.getCurrentTime());
    if (resume && !audioEngine.isPlaying) togglePlayPause();
  }

  function updateExcerptBar() {
    const bar = document.getElementById('excerptBar');
    const long = audioEngine.isExcerpt && audioEngine.fullBuffer;
    const wavLabel = document.getElementById('lblExportWav'), mp4Label = document.getElementById('lblExportMp4');
    if (wavLabel) wavLabel.textContent = long ? 'Download cleaned audio (whole recording)' : 'Download cleaned audio';
    if (mp4Label) mp4Label.textContent = long ? 'Download cleaned video (whole recording)' : 'Download cleaned video';
    if (!bar) return;
    if (!long) { bar.style.display = 'none'; return; }
    const total = audioEngine.fullBuffer.duration, start = audioEngine.excerptStart, len = audioEngine.originalBuffer.duration;
    document.getElementById('excerptText').innerHTML =
      `<strong>Long recording (${fmtClock(total)}).</strong> You are previewing ${fmtClock(start)}–${fmtClock(start + len)}. ` +
      `Playback continues into the next part automatically. Whatever you set here is applied to the <strong>whole recording</strong> when you download.`;
    document.getElementById('excerptStart').value = fmtClock(start);
    bar.style.display = 'flex';
  }

  async function previewFrom(startSec) {
    if (studioState !== 'ready' || !audioEngine.isExcerpt) return;
    stopPlayback();
    const snap = { values: { ...audioEngine.stemValues }, mutes: { ...audioEngine.stemMutes }, solos: { ...audioEngine.stemSolos } };
    const activePreset = (document.querySelector('.btn-preset.active-preset') || {}).dataset;
    studioState = 'loading'; setStudioBusy(true); setStudioProgress(0.02, 'Preparing the preview…');
    try {
      audioEngine.setExcerpt(startSec, AudioEngine.MAX_PREVIEW_SECONDS);
      await audioEngine.analyzeAndDecompose((p, m) => setStudioProgress(0.05 + 0.93 * p, `${m} (${Math.floor(p * 100)}%)`),
        activeAbortController ? activeAbortController.signal : undefined);
      Object.assign(audioEngine.stemValues, snap.values); Object.assign(audioEngine.stemMutes, snap.mutes); Object.assign(audioEngine.stemSolos, snap.solos);
      audioEngine.updateAllStemGains();
      renderMixerStrips(audioEngine.componentDefs, audioEngine.componentEnergy);
      visualizer.setAudioBuffers(audioEngine.originalBuffer);
      visualizer.setStems(audioEngine.stems);
      visualizer.updatePlayhead(0);
      updateDurationLabel();
      syncPresetUi(activePreset ? activePreset.preset : null);
      updateProcessedWaveformPreview();
      updateExcerptBar();
      refreshTransport();
      studioState = 'ready';
    } catch (err) {
      if (!(err && err.name === 'AbortError')) {
        console.warn('Preview failed:', err);
        showToast('⚠️ Could not prepare that part of the recording.', 'warning', 5000);
      }
      studioState = 'ready';
    } finally {
      setStudioBusy(false);
    }
  }

  const btnExcerptApply = document.getElementById('btnExcerptApply');
  if (btnExcerptApply) btnExcerptApply.addEventListener('click', () => {
    const t = parseClock(document.getElementById('excerptStart').value);
    if (isNaN(t)) { showToast('Type a time like 12:30 (minutes:seconds).', 'warning', 3500); return; }
    previewFrom(t);
  });
  const excerptStartInput = document.getElementById('excerptStart');
  if (excerptStartInput) excerptStartInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnExcerptApply.click(); });

  // ---- Whole original: streams the untouched file with the browser's own player (low memory) ----
  const originalPlayer = document.getElementById('originalPlayer');
  const originalPlayerWrap = document.getElementById('originalPlayerWrap');
  const btnPlayOriginal = document.getElementById('btnPlayOriginal');
  let originalPlayerUrl = null;
  function closeOriginalPlayer() {
    if (!originalPlayer) return;
    try { originalPlayer.pause(); } catch (e) {}
    originalPlayer.removeAttribute('src');
    try { originalPlayer.load(); } catch (e) {}
    if (originalPlayerUrl) { URL.revokeObjectURL(originalPlayerUrl); originalPlayerUrl = null; }
    if (originalPlayerWrap) originalPlayerWrap.style.display = 'none';
    if (btnPlayOriginal) btnPlayOriginal.textContent = 'Play whole original';
  }
  if (btnPlayOriginal && originalPlayer) btnPlayOriginal.addEventListener('click', () => {
    if (originalPlayerUrl) { closeOriginalPlayer(); return; }
    if (!currentFile) return;
    stopPlayback();
    originalPlayerUrl = URL.createObjectURL(currentFile);
    originalPlayer.src = originalPlayerUrl;
    originalPlayerWrap.style.display = 'flex';
    btnPlayOriginal.textContent = 'Close original player';
    originalPlayer.play().catch(() => {});
  });
  // Never play the original and the studio at the same time
  if (originalPlayer) originalPlayer.addEventListener('play', () => { if (audioEngine.isPlaying) stopPlayback(); });

  function prepareStudio() {
    if (studioState === 'ready' || studioState === 'loading') return studioPromise;
    if (!pendingAudioBytes || !currentFile) return Promise.resolve();
    studioState = 'loading';
    const file = currentFile;
    const bytes = pendingAudioBytes;
    const signal = activeAbortController ? activeAbortController.signal : undefined;
    if (currentWorkspaceView === 'studio') setStudioBusy(true);
    setStudioProgress(0.05, 'Decoding audio…');

    studioPromise = (async () => {
      try {
        await audioEngine.decodeAudio(bytes);
        if (currentFile !== file || (signal && signal.aborted)) return;
        // Long recordings: the studio previews a few minutes; the download covers all of it
        audioEngine.setExcerpt(0, AudioEngine.MAX_PREVIEW_SECONDS);
        const audioBuf = audioEngine.originalBuffer;

        const hasVideo = ffprobeData && ffprobeData.streams && ffprobeData.streams.some(st => st.codec_type === 'video');
        if (hasVideo) setupVideoPreview(file);
        else if (videoContainer) videoContainer.style.display = 'none';

        await audioEngine.analyzeAndDecompose((progress, message) => {
          setStudioProgress(0.1 + 0.88 * progress, `${message} (${Math.floor(progress * 100)}%)`);
        }, signal);
        if (currentFile !== file || (signal && signal.aborted)) return;

        renderMixerStrips(audioEngine.componentDefs, audioEngine.componentEnergy);
        visualizer.setAudioBuffers(audioBuf);
        visualizer.setStems(audioEngine.stems);
        visualizer.updatePlayhead(0);
        updateDurationLabel();

        // Start from the recommended clean so sliders, mixer and sound all agree
        applyAutoCleanUi(false);
        updateExcerptBar();
        studioState = 'ready';
        setStudioBusy(false);
      } catch (err) {
        if (err && err.name === 'AbortError') { studioState = 'idle'; setStudioBusy(false); return; }
        console.warn('Studio preparation failed:', err);
        studioState = 'error';
        setStudioBusy(false);
        setStudioAvailable(false, 'Your browser could not read audio from this file.');
        setWorkspaceView('metadata');
        showAudioNotice({ reason: 'Your browser could not read audio from this file (the format may not be supported, or the file has no sound). Try converting it to MP3, WAV or M4A.' });
        showToast('⚠️ Audio cleaning could not open this file. The file details are still available below.', 'warning', 6000);
      }
    })();
    return studioPromise;
  }

  function setWorkspaceView(mode) {
    if (mode === 'both') mode = 'metadata';
    if (mode === 'studio' && btnModeStudio && btnModeStudio.disabled) mode = 'metadata';
    currentWorkspaceView = mode;
    if (btnModeStudio) btnModeStudio.classList.toggle('active', mode === 'studio');
    if (btnModeMetadata) btnModeMetadata.classList.toggle('active', mode === 'metadata');
    if (audioProcessingSection) audioProcessingSection.style.display = mode === 'studio' ? 'block' : 'none';
    if (metadataSection) metadataSection.style.display = mode === 'metadata' ? 'block' : 'none';
    if (nonAudioNotice && mode === 'studio') nonAudioNotice.style.display = 'none';
    if (mode === 'studio') {
      if (studioState === 'idle') prepareStudio();
      else if (studioState === 'loading') setStudioBusy(true);
    }
  }

  // Studio tab only makes sense for files that contain audio
  function setStudioAvailable(available, reason) {
    if (!btnModeStudio) return;
    btnModeStudio.disabled = !available;
    btnModeStudio.title = available ? '' : (reason || 'This file has no audio track to clean');
  }

  const MEDIA_EXTENSIONS = ['mp3', 'wav', 'wave', 'm4a', 'm4b', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'aifc', 'caf', 'amr', 'awb', 'mka', 'weba',
    'mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', '3gp', '3g2', 'wmv', 'flv', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', 'ogv'];

  /**
   * Decides whether Audio Cleaning can be offered, and tells the user why when it can't.
   * The browser, not our parser, has the final say on whether audio can be decoded, so a media
   * file whose tracks we could not read is still allowed to try.
   */
  function decideAudioSupport(file, data) {
    const streams = (data && data.streams) || [];
    const format = (data && data.format) || {};
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const mime = (file.type || '').toLowerCase();
    if (streams.some(st => st.codec_type === 'audio')) return { available: true };

    const isImage = mime.startsWith('image/') || /^(image2|webp|heif|gif|png|tiff)/i.test(format.format_name || '') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp', 'svg'].includes(ext);
    if (isImage) return { available: false, reason: 'This is an image, so there is no audio to clean.' };
    if (isDocumentData(format) || ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'rtf', 'zip'].includes(ext)) {
      return { available: false, reason: 'This is a document, so there is no audio to clean.' };
    }
    const looksMedia = mime.startsWith('audio/') || mime.startsWith('video/') || MEDIA_EXTENSIONS.includes(ext);
    const foundVideoOnly = streams.some(st => st.codec_type === 'video');
    // A file named/typed as audio (e.g. .m4a) whose only parsed track is "video" is usually cover art
    // or a track we misread, so let the browser decide whether it can decode sound.
    const AUDIO_EXTENSIONS = ['mp3', 'wav', 'wave', 'm4a', 'm4b', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'aifc', 'caf', 'amr', 'awb', 'mka', 'weba'];
    if (foundVideoOnly && (mime.startsWith('audio/') || AUDIO_EXTENSIONS.includes(ext))) return { available: true, unsure: true };
    if (foundVideoOnly) return { available: false, reason: 'FileLens found a video track but no sound track in this file, so there is nothing to clean.' };
    if (looksMedia) return { available: true, unsure: true };
    return { available: false, canTryAnyway: true, reason: 'FileLens could not find audio in this file type. If you think it has sound, you can try anyway.' };
  }

  let lastFileBytes = null;

  function showAudioNotice(decision) {
    if (!nonAudioNotice) return;
    nonAudioNotice.innerHTML = `<span class="notice-icon">ℹ️</span><span class="notice-msg"></span>`;
    nonAudioNotice.querySelector('.notice-msg').textContent = `${decision.reason} Everything else about the file is shown below.`;
    if (decision.canTryAnyway) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-sm btn-outline notice-action'; btn.textContent = 'Try audio cleaning anyway';
      btn.addEventListener('click', () => {
        if (!lastFileBytes) return;
        pendingAudioBytes = lastFileBytes; studioState = 'idle'; studioPromise = null;
        setStudioAvailable(true);
        nonAudioNotice.style.display = 'none';
        setWorkspaceView('studio');
      });
      nonAudioNotice.appendChild(btn);
    }
    nonAudioNotice.style.display = 'flex';
  }

  // Replace the large dropzone with a compact bar once a file is loaded
  function showFileBar() {
    const bar = document.getElementById('fileBar');
    if (!bar || !currentFile) return;
    const fmt = (ffprobeData && ffprobeData.format) || {};
    const bytes = currentFile.size || 0;
    const dur = parseFloat(fmt.duration || 0);
    const kinds = ((ffprobeData && ffprobeData.streams) || []).map(st => st.codec_type);
    const icon = kinds.includes('video') ? '🎬' : kinds.includes('audio') ? '🎧' : (currentFile.type || '').startsWith('image') ? '🖼️' : '📄';
    document.getElementById('fileBarIcon').textContent = icon;
    document.getElementById('fileBarName').textContent = currentFile.name;
    document.getElementById('fileBarMeta').textContent =
      [formatBytes(bytes), dur > 0 && !String(currentFile.type || '').startsWith('image') ? formatTime(dur).replace(/\.\d+$/, '') : null, currentFile.type || fmt.format_name].filter(Boolean).join(' · ');
    document.body.classList.add('has-file');
    bar.style.display = 'flex';
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  if (btnModeStudio) btnModeStudio.addEventListener('click', () => setWorkspaceView('studio'));
  if (btnModeMetadata) btnModeMetadata.addEventListener('click', () => setWorkspaceView('metadata'));

  const btnAdvToggle = document.getElementById('btnAdvToggle');
  if (btnAdvToggle) btnAdvToggle.addEventListener('click', () => {
    const on = document.body.classList.toggle('show-adv');
    btnAdvToggle.textContent = on ? 'Hide advanced ▴' : 'Show advanced ▾';
    if (!on) {
      const active = document.querySelector('.meta-tab.active');
      if (active && active.classList.contains('meta-tab-adv')) document.querySelector('.meta-tab[data-tab="overview"]').click();
    }
  });

  const btnOpenAnother = document.getElementById('btnOpenAnother');
  if (btnOpenAnother) btnOpenAnother.addEventListener('click', () => {
    document.getElementById('fileInput').click();
  });

  // Universal Metadata Elements
  const metadataGrid = document.getElementById('metadataGrid');
  const rawJsonText = document.getElementById('rawJsonText') ? document.getElementById('rawJsonText').querySelector('code') : null;
  const btnCopyJson = document.getElementById('btnCopyJson');
  const metaTabs = document.querySelectorAll('.meta-tab');
  const metaTabContents = document.querySelectorAll('.meta-tab-content');
  const metaSearchInput = document.getElementById('metaSearchInput');
  const metaTagsTbody = document.getElementById('metaTagsTbody');
  const atomTreeWrapper = document.getElementById('atomTreeWrapper');
  const forensicsGrid = document.getElementById('forensicsGrid');
  const tamperContainer = document.getElementById('tamperContainer');
  const btnExportMetaJson = document.getElementById('btnExportMetaJson');
  const btnExportMetaCsv = document.getElementById('btnExportMetaCsv');
  const btnCopyAllMeta = document.getElementById('btnCopyAllMeta');

  // Device Origin Banner Elements
  const deviceOriginBanner = document.getElementById('deviceOriginBanner');
  const deviceBannerIcon = document.getElementById('deviceBannerIcon');
  const deviceBannerName = document.getElementById('deviceBannerName');
  const deviceBannerBadge = document.getElementById('deviceBannerBadge');
  const deviceBannerStatus = document.getElementById('deviceBannerStatus');
  const valDeviceNo = document.getElementById('valDeviceNo');
  const valSerialNo = document.getElementById('valSerialNo');
  const valLens = document.getElementById('valLens');
  const valHost = document.getElementById('valHost');
  const deviceBannerDesc = document.getElementById('deviceBannerDesc');
  const btnJumpToMetadata = document.getElementById('btnJumpToMetadata');

  // Visualizer & Video Elements
  const waveformCanvas = document.getElementById('waveformCanvas');
  const spectrogramCanvas = document.getElementById('spectrogramCanvas');
  const canvasTooltip = document.getElementById('canvasTooltip');
  const waveformWrapper = document.getElementById('waveformWrapper');
  const spectrogramWrapper = document.getElementById('spectrogramWrapper');
  const previewVideo = document.getElementById('previewVideo');
  const videoContainer = document.getElementById('videoContainer');
  const vizTabs = document.querySelectorAll('.viz-tab');
  const btnSpecModes = document.querySelectorAll('.btn-spec-mode');
  const specCanvasLabel = document.getElementById('specCanvasLabel');

  // Final Output Status & VU Meter Elements
  const finalModeBadge = document.getElementById('finalModeBadge');
  const vuMeterBar = document.getElementById('vuMeterBar');
  const vuDbReadout = document.getElementById('vuDbReadout');
  const finalSummaryChips = document.getElementById('finalSummaryChips');
  const valNoiseReductionEstimate = document.getElementById('valNoiseReductionEstimate');
  const valBgVoiceStatus = document.getElementById('valBgVoiceStatus');
  const valSpeechClarityGain = document.getElementById('valSpeechClarityGain');

  // Live Voice Monitor HUD Elements
  const liveVoiceMonitor = document.getElementById('liveVoiceMonitor');
  const lvmStatusBadge = document.getElementById('lvmStatusBadge');
  const lvmMainDb = document.getElementById('lvmMainDb');
  const lvmMainBar = document.getElementById('lvmMainBar');
  const lvmMainSub = document.getElementById('lvmMainSub');
  const lvmBgDb = document.getElementById('lvmBgDb');
  const lvmBgBar = document.getElementById('lvmBgBar');
  const lvmBgSub = document.getElementById('lvmBgSub');
  const lvmSnrDb = document.getElementById('lvmSnrDb');
  const lvmSnrBar = document.getElementById('lvmSnrBar');
  const lvmSnrSub = document.getElementById('lvmSnrSub');

  // Transport Elements
  const btnPlayPause = document.getElementById('btnPlayPause');
  const playIcon = btnPlayPause.querySelector('.play-icon');
  const pauseIcon = btnPlayPause.querySelector('.pause-icon');
  const btnStop = document.getElementById('btnStop');
  const btnLoop = document.getElementById('btnLoop');
  const currentTimeDisplay = document.getElementById('currentTimeDisplay');
  const durationDisplay = document.getElementById('durationDisplay');
  const timelineScrubber = document.getElementById('timelineScrubber');

  // A/B Switcher
  const btnAbOriginal = document.getElementById('btnAbOriginal');
  const btnAbCleaned = document.getElementById('btnAbCleaned');

  // Mixer & Presets
  const mixerGrid = document.getElementById('mixerGrid');
  const presetButtons = document.querySelectorAll('.btn-preset');

  // Macros & DSP
  const slNoiseReduction = document.getElementById('slNoiseReduction');
  const slVoiceBoost = document.getElementById('slVoiceBoost');
  const slBgPreserve = document.getElementById('slBgPreserve');
  const slMasterVol = document.getElementById('slMasterVol');
  const lblNoiseReduction = document.getElementById('lblNoiseReduction');
  const lblVoiceBoost = document.getElementById('lblVoiceBoost');
  const lblBgPreserve = document.getElementById('lblBgPreserve');
  const lblMasterVol = document.getElementById('lblMasterVol');

  const eqLow = document.getElementById('eqLow');
  const eqMid = document.getElementById('eqMid');
  const eqHigh = document.getElementById('eqHigh');
  const lblEqLow = document.getElementById('lblEqLow');
  const lblEqMid = document.getElementById('lblEqMid');
  const lblEqHigh = document.getElementById('lblEqHigh');

  const compThreshold = document.getElementById('compThreshold');
  const compRatio = document.getElementById('compRatio');
  const lblCompThreshold = document.getElementById('lblCompThreshold');
  const lblCompRatio = document.getElementById('lblCompRatio');

  // Theme Switcher Elements
  const themeSelectorWrap = document.getElementById('themeSelectorWrap');
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  const themeDropdown = document.getElementById('themeDropdown');
  const themeOpts = document.querySelectorAll('.theme-opt');
  const currentThemeIcon = document.getElementById('currentThemeIcon');
  const currentThemeName = document.getElementById('currentThemeName');

  // Studio Quick Bar & Workflow Complexity Elements
  const btnAutoClean = document.getElementById('btnAutoClean');
  const btnWfQuick = document.getElementById('btnWfQuick');
  const btnWfPro = document.getElementById('btnWfPro');
  const selCleanAlgorithm = document.getElementById('selCleanAlgorithm');

  // Pro Audio Enhancements Rack Elements
  const slDeReverb = document.getElementById('slDeReverb');
  const lblDeReverb = document.getElementById('lblDeReverb');
  const slDeEsser = document.getElementById('slDeEsser');
  const lblDeEsser = document.getElementById('lblDeEsser');
  const groupDeHum = document.getElementById('groupDeHum');
  const lblDeHum = document.getElementById('lblDeHum');
  const groupHighPass = document.getElementById('groupHighPass');
  const lblHighPass = document.getElementById('lblHighPass');

  // Export
  const btnExportWav = document.getElementById('btnExportWav');
  const btnExportMp4 = document.getElementById('btnExportMp4');
  const videoExportBox = document.getElementById('videoExportBox');
  const exportProgress = document.getElementById('exportProgress');
  const exportStatusText = document.getElementById('exportStatusText');

  // Initialize Visualizer
  visualizer = new AudioVisualizer(waveformCanvas, spectrogramCanvas, canvasTooltip);
  visualizer.onSeek = (seekTime) => {
    audioEngine.seek(seekTime);
    if (previewVideo && currentFile && currentFile.type.includes('video')) {
      previewVideo.currentTime = seekTime + (audioEngine.excerptStart || 0);
    }
  };

  // 1. File Upload & Demo Handling
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleIncomingFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleIncomingFile(e.target.files[0]);
    }
  });

  let cachedDemoAudioBlob = null;
  let cachedDemoVideoBlob = null;

  const loadDemoWav = async () => {
    stopPlayback();
    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();
    const abortSignal = activeAbortController.signal;

    try {
      showProgress(0.05, "Loading Demo Multi-Noise Audio...", "High-speed audio stream transfer...");
      let blob = cachedDemoAudioBlob;
      if (!blob) {
        const response = await fetch('/samples/sample_interview_with_noise.m4a', { signal: abortSignal });
        if (!response.ok) throw new Error("Could not load sample file");
        blob = await response.blob();
        cachedDemoAudioBlob = blob;
      }
      if (abortSignal.aborted) return;
      const file = new File([blob], "cafe_interview_with_noise.m4a", { type: "audio/mp4" });
      await handleIncomingFile(file);
    } catch (err) {
      if (err.name === 'AbortError' || abortSignal.aborted) {
        hideProgress();
        return;
      }
      console.warn("Could not load demo audio:", err);
      showToast("Failed to load demo file: " + err.message, 'warning');
      hideProgress();
    }
  };

  const loadDemoMp4 = async () => {
    stopPlayback();
    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();
    const abortSignal = activeAbortController.signal;

    try {
      showProgress(0.05, "Loading Demo Multi-Noise Video (MP4)...", "High-speed video stream transfer...");
      let blob = cachedDemoVideoBlob;
      if (!blob) {
        const response = await fetch('/samples/sample_video_with_noise.mp4', { signal: abortSignal });
        if (!response.ok) throw new Error("Could not load sample MP4 file");
        blob = await response.blob();
        cachedDemoVideoBlob = blob;
      }
      if (abortSignal.aborted) return;
      const file = new File([blob], "cafe_interview_with_noise.mp4", { type: "video/mp4" });
      await handleIncomingFile(file);
    } catch (err) {
      if (err.name === 'AbortError' || abortSignal.aborted) {
        hideProgress();
        return;
      }
      showToast("Failed to load demo MP4 file: " + err.message, 'warning');
      hideProgress();
    }
  };

  if (btnLoadDemoWav) btnLoadDemoWav.addEventListener('click', () => loadDemoWav(false));
  if (btnLoadDemoMp4) btnLoadDemoMp4.addEventListener('click', () => loadDemoMp4());
  if (btnQuickDemoWav) btnQuickDemoWav.addEventListener('click', () => loadDemoWav(false));
  if (btnQuickDemoMp4) btnQuickDemoMp4.addEventListener('click', () => loadDemoMp4());

  // Clipboard Paste Handler (Global Cmd+V / Ctrl+V and Dedicated Button)
  window.addEventListener('paste', async (e) => {
    // 1. Check e.clipboardData.files
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
      for (let i = 0; i < e.clipboardData.files.length; i++) {
        const file = e.clipboardData.files[i];
        if (isSupportedMedia(file)) {
          e.preventDefault();
          showToast(`📋 Pasted <strong>${escapeHtml(file.name)}</strong> from clipboard!`, 'info');
          await handleIncomingFile(file);
          return;
        }
      }
    }

    // 2. Check e.clipboardData.items
    if (e.clipboardData && e.clipboardData.items) {
      for (let i = 0; i < e.clipboardData.items.length; i++) {
        const item = e.clipboardData.items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file && isSupportedMedia(file)) {
            e.preventDefault();
            const displayName = file.name || `clipboard_media_${Date.now()}`;
            showToast(`📋 Pasted <strong>${escapeHtml(displayName)}</strong> from clipboard!`, 'info');
            await handleIncomingFile(file);
            return;
          }
        }
      }
    }
  });

  if (btnPasteClipboard) {
    btnPasteClipboard.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard || !navigator.clipboard.read) {
          showToast("💡 <strong>Tip:</strong> Copy an MP4/WAV/MP3 file and press <strong>Cmd+V / Ctrl+V</strong> to paste directly!", "info", 5000);
          return;
        }

        const clipboardItems = await navigator.clipboard.read();
        let pastedFile = null;

        for (const item of clipboardItems) {
          for (const type of item.types) {
            const blob = await item.getType(type);
            let ext = 'bin';
            if (type.includes('mp4')) ext = 'mp4';
            else if (type.includes('wav')) ext = 'wav';
            else if (type.includes('mp3')) ext = 'mp3';
            else if (type.includes('m4a')) ext = 'm4a';
            else if (type.includes('ogg')) ext = 'ogg';
            else if (type.includes('flac')) ext = 'flac';
            else if (type.includes('png')) ext = 'png';
            else if (type.includes('jpeg') || type.includes('jpg')) ext = 'jpg';
            else if (type.includes('webp')) ext = 'webp';
            else if (type.includes('pdf')) ext = 'pdf';
            pastedFile = new File([blob], `clipboard_file_${Date.now()}.${ext}`, { type });
            break;
          }
          if (pastedFile) break;
        }

        if (pastedFile) {
          showToast(`📋 Pasted file from clipboard!`, 'info');
          await handleIncomingFile(pastedFile);
        } else {
          showToast("📋 No file found on clipboard. Copy any file and press <strong>Cmd+V</strong> (or Ctrl+V)!", "warning", 5000);
        }
      } catch (err) {
        showToast("💡 To paste a copied file, simply press <strong>Cmd+V / Ctrl+V</strong> on your keyboard!", "info", 5000);
      }
    });
  }

  async function handleIncomingFile(file) {
    stopPlayback();
    closeOriginalPlayer();
    // Each file gets its own abort signal so a previous file's background work stops
    if (activeAbortController) activeAbortController.abort();
    activeAbortController = new AbortController();
    const abortSignal = activeAbortController.signal;

    currentFile = file;
    studioState = 'idle';
    studioPromise = null;
    pendingAudioBytes = null;
    audioEngine.stems = {};
    showProgress(0.1, "Reading file…", `Reading ${file.name}`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      if (abortSignal.aborted) return;

      // 1. Metadata & forensics (fast) — this is what we show first
      showProgress(0.4, "Reading file details…", "Inspecting streams, tags and signatures");
      ffprobeData = await FFprobeParser.parse(file, arrayBuffer);
      if (abortSignal.aborted) return;
      renderMetadata(ffprobeData);

      const audioDecision = decideAudioSupport(file, ffprobeData);
      const hasAudio = audioDecision.available;
      setStudioAvailable(hasAudio, audioDecision.reason);
      setWorkspaceView('metadata');
      lastFileBytes = arrayBuffer;

      if (hasAudio) {
        // Audio decoding + noise analysis is heavy, so it happens when the cleaning tab is
        // opened (or quietly in the background for normal-sized files).
        pendingAudioBytes = arrayBuffer;
        if (nonAudioNotice) nonAudioNotice.style.display = 'none';
        if (file.size <= PREWARM_MAX_BYTES) {
          setTimeout(() => { if (currentFile === file && studioState === 'idle') prepareStudio(); }, 1200);
        }
      } else {
        showAudioNotice(audioDecision);
        if (videoContainer) videoContainer.style.display = 'none';
        showToast(`📁 <strong>${escapeHtml(file.name)}</strong> inspected! Full metadata, tags, and binary forensics extracted.`, 'info', 4000);
      }

      // Show Workspace
      hideProgress();
      showFileBar();
      if (workspace) workspace.style.display = 'block';

      // Auto-scroll to workspace
      if (workspace) workspace.scrollIntoView({ behavior: 'smooth' });

    } catch (err) {
      if (err.name === 'AbortError' || abortSignal.aborted) {
        console.log("File inspection/decoding aborted by user");
        hideProgress();
        return;
      }
      console.error(err);
      showToast("Error inspecting file: " + err.message, 'warning', 5000);
      hideProgress();
    }
  }

  function showProgress(fraction, text, subtext = "") {
    if (!progressOverlay) return;
    document.body.classList.remove('has-file');
    progressOverlay.style.display = 'flex';
    const pct = Math.min(100, Math.max(0, Math.floor(fraction * 100)));
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressPercent) progressPercent.textContent = `${pct}%`;
    if (progressStatus) progressStatus.textContent = text;
    if (progressSubstatus) {
      progressSubstatus.textContent = subtext || (pct < 100 ? "Decomposing 9 AI audio layers..." : "Ready!");
    }

    clearTimeout(progressWatchdogTimer);
    if (progressWatchdogNotice) progressWatchdogNotice.style.display = 'none';

    // Watchdog: If a single step hangs or takes > 6s, display the helpful notice with Cancel reminder
    progressWatchdogTimer = setTimeout(() => {
      if (progressOverlay && progressOverlay.style.display !== 'none' && progressWatchdogNotice) {
        progressWatchdogNotice.style.display = 'block';
      }
    }, 6000);
  }

  function hideProgress() {
    clearTimeout(progressWatchdogTimer);
    if (progressWatchdogNotice) progressWatchdogNotice.style.display = 'none';
    if (progressOverlay) progressOverlay.style.display = 'none';
  }

  // Tab Navigation for Metadata Categories
  metaTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      metaTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const targetTab = tab.dataset.tab;

      metaTabContents.forEach(content => {
        content.style.display = 'none';
        content.classList.remove('active');
      });

      const activeContent = document.getElementById(`tabContent${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`);
      if (activeContent) {
        activeContent.style.display = 'block';
        activeContent.classList.add('active');
      }
    });
  });

  // Real-Time Search & Filtering for Metadata
  if (metaSearchInput) {
    metaSearchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();

      // Filter Overview Stream Cards
      document.querySelectorAll('.meta-box').forEach(box => {
        box.style.display = box.textContent.toLowerCase().includes(q) ? 'block' : 'none';
      });

      // Filter Tags Table Rows
      if (metaTagsTbody) {
        metaTagsTbody.querySelectorAll('tr').forEach(row => {
          row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      }

      // Filter Atom Tree Nodes
      if (atomTreeWrapper) {
        atomTreeWrapper.querySelectorAll('.atom-node').forEach(node => {
          node.style.display = node.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
        });
      }

      // Filter Forensics Cards
      if (forensicsGrid) {
        forensicsGrid.querySelectorAll('.forensic-card').forEach(card => {
          card.style.display = card.textContent.toLowerCase().includes(q) ? 'block' : 'none';
        });
      }
    });
  }

  // Metadata Export & Copy Action Handlers
  if (btnExportMetaJson) {
    btnExportMetaJson.addEventListener('click', () => {
      if (!ffprobeData) return;
      const blob = new Blob([JSON.stringify(ffprobeData, null, 2)], { type: 'application/json' });
      const filename = (currentFile ? currentFile.name : 'metadata') + '_ffprobe.json';
      AudioExporter.downloadBlob(blob, filename);
      showToast(`📥 Exported metadata JSON for ${filename}`, 'info');
    });
  }

  if (btnExportMetaCsv) {
    btnExportMetaCsv.addEventListener('click', () => {
      if (!ffprobeData) return;
      let csv = 'Category,Property,Value\n';
      // Format
      const fmt = ffprobeData.format || {};
      for (const k in fmt) {
        if (typeof fmt[k] !== 'object') csv += `Format,"${k}","${String(fmt[k]).replace(/"/g, '""')}"\n`;
      }
      // Tags
      const tags = ffprobeData.all_tags || fmt.tags || {};
      for (const k in tags) {
        csv += `Tag,"${k}","${String(tags[k]).replace(/"/g, '""')}"\n`;
      }
      // Forensics
      const fore = ffprobeData.forensics || {};
      for (const k in fore) {
        csv += `Forensics,"${k}","${String(fore[k]).replace(/"/g, '""')}"\n`;
      }
      const blob = new Blob([csv], { type: 'text/csv' });
      const filename = (currentFile ? currentFile.name : 'metadata') + '_metadata.csv';
      AudioExporter.downloadBlob(blob, filename);
      showToast(`📊 Exported metadata CSV for ${filename}`, 'info');
    });
  }

  if (btnCopyAllMeta) {
    btnCopyAllMeta.addEventListener('click', () => {
      if (!ffprobeData) return;
      navigator.clipboard.writeText(JSON.stringify(ffprobeData, null, 2));
      showToast('📋 All metadata copied to clipboard!', 'info');
    });
  }

  if (btnCopyJson) {
    btnCopyJson.addEventListener('click', () => {
      if (!ffprobeData) return;
      navigator.clipboard.writeText(JSON.stringify(ffprobeData, null, 2));
      btnCopyJson.textContent = 'Copied!';
      setTimeout(() => btnCopyJson.textContent = 'Copy JSON', 2000);
    });
  }

  if (btnJumpToMetadata) {
    btnJumpToMetadata.addEventListener('click', () => {
      setWorkspaceView('metadata');
      if (metadataSection) {
        metadataSection.style.display = 'block';
        metadataSection.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }

  // Friendly Humanizer Helper Functions for Non-Technical Users
  function getFriendlyFormatName(fmtLong, fmtName, filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    if (ext === 'mp4') return { title: 'MP4 Video Container', badge: 'Universal Video Format', desc: 'Supported on 99% of phones, TVs, and web browsers.' };
    if (ext === 'm4a') return { title: 'M4A Audio Container', badge: 'High-Efficiency Apple Audio', desc: 'Modern AAC-compressed audio, standard on iPhones and Macs.' };
    if (ext === 'wav') return { title: 'WAV Studio Audio', badge: '100% Lossless Master', desc: 'Uncompressed pure sound without any quality reduction.' };
    if (ext === 'mp3') return { title: 'MP3 Audio', badge: 'Universal Music Format', desc: 'Standard compressed music file compatible with all players.' };
    if (ext === 'mov') return { title: 'Apple QuickTime Movie', badge: 'High-Definition Video', desc: 'Professional video container designed for high-fidelity playback.' };
    if (ext === 'png') return { title: 'PNG Graphic Image', badge: 'Lossless Picture', desc: 'High-quality graphic supporting transparent backgrounds.' };
    if (ext === 'jpg' || ext === 'jpeg') return { title: 'JPEG Photograph', badge: 'Standard Camera Photo', desc: 'Standard compressed photo format used by digital cameras.' };
    if (ext === 'pdf') return { title: 'Adobe PDF Document', badge: 'Fixed Layout Document', desc: 'Standard electronic document containing text and embedded media.' };
    return { title: fmtLong || fmtName || 'Media File', badge: 'Standard Container', desc: 'Digital media container enclosing audio/video tracks.' };
  }

  function getFriendlyBitrateInfo(bitrateKbps) {
    const kbps = parseInt(bitrateKbps || 0);
    if (kbps <= 0) return { text: 'N/A (Static Media)', badge: 'Static File', desc: 'Image or document without streaming playback.' };
    if (kbps < 96) return { text: `${kbps} kbps`, badge: 'Voice / Speech Clarity', desc: 'Compact speech recording, lightweight and easy to stream.' };
    if (kbps <= 192) return { text: `${kbps} kbps`, badge: 'Standard Streaming Quality', desc: 'Balanced sound quality (standard on Spotify / YouTube).' };
    if (kbps <= 320) return { text: `${kbps} kbps`, badge: 'High-Fidelity Audio', desc: 'Near-CD clarity capturing subtle vocal and acoustic details.' };
    return { text: `${(kbps / 1000).toFixed(1)} Mbps (${kbps} kbps)`, badge: 'High Bitrate / Studio Master', desc: 'High bandwidth with rich detail and minimal compression.' };
  }

  function getFriendlySampleRate(sampleRate) {
    const hz = parseInt(sampleRate || 0);
    if (!hz) return { text: 'Not stated in file', badge: 'Unknown', desc: 'The file does not say how many sound snapshots it takes per second.' };
    if (hz >= 96000) return { text: `${hz.toLocaleString()} Hz`, badge: 'Ultra High-Res Studio Audio', desc: 'Audiophile/mastering grade clarity.' };
    if (hz >= 48000) return { text: '48,000 Hz (48 kHz)', badge: 'Pro Video / Film Standard', desc: 'Broadcast audio standard synchronized with 24/30 FPS video.' };
    if (hz >= 44100) return { text: '44,100 Hz (44.1 kHz)', badge: 'CD Master Quality', desc: 'Standard music clarity (captures the full range of human hearing 20Hz–20kHz).' };
    if (hz >= 22050) return { text: `${hz.toLocaleString()} Hz`, badge: 'Voice / Speech Clarity', desc: 'Compact speech recording.' };
    return { text: `${hz} Hz`, badge: 'Standard Audio', desc: 'Number of sound snapshots taken per second.' };
  }

  function getFriendlyChannels(ch, layout) {
    if (!parseInt(ch || 0)) return { text: 'Not stated in file', badge: 'Unknown', desc: 'The file does not say how many audio channels it has.' };
    const c = parseInt(ch);
    if (c === 1) return { text: '1 Channel (Mono)', badge: 'Single Audio Source', desc: 'Plays the identical sound equally in both ears / speakers.' };
    if (c === 2) return { text: '2 Channels (Stereo)', badge: 'Left & Right Ear Experience', desc: 'Realistic spatial sound separation between left and right ears.' };
    if (c === 6) return { text: '6 Channels (5.1 Surround)', badge: 'Home Cinema Surround', desc: 'Separate audio for Center, Left, Right, Subwoofer, and Rear speakers.' };
    return { text: `${c} Channels (${layout || 'Multi-channel'})`, badge: 'Surround Sound', desc: 'Multi-directional sound layout.' };
  }

  function getFriendlyBitDepth(bits, sampleFmt) {
    const b = parseInt(bits || 16);
    if (sampleFmt === 'fltp' || sampleFmt === 'flt') {
      return { text: '32-bit Floating Point', badge: 'Studio Distortion-Free Math', desc: 'Pro digital format that avoids clipping distortion even during loud peaks.' };
    }
    if (b >= 24) return { text: '24-bit PCM', badge: 'High Dynamic Range (Studio Pro)', desc: 'Extra quiet noise floor and maximum detail.' };
    return { text: '16-bit PCM', badge: 'Standard CD Precision', desc: 'Standard dynamic range for consumer audio playback.' };
  }

  function getFriendlyResolution(width, height) {
    const w = parseInt(width || 0);
    const h = parseInt(height || 0);
    if (w >= 3840 || h >= 2160) return { text: `${w} x ${h}`, badge: '4K Ultra HD', desc: 'Ultra-crisp resolution with over 8 million pixels.' };
    if (w >= 2560 || h >= 1440) return { text: `${w} x ${h}`, badge: '2K Quad HD', desc: 'Crisp gaming / desktop monitor resolution.' };
    if (w >= 1920 || h >= 1080) return { text: `${w} x ${h}`, badge: 'Full HD 1080p', desc: 'Standard modern video definition for TVs and computers.' };
    if (w >= 1280 || h >= 720) return { text: `${w} x ${h}`, badge: 'HD 720p', desc: 'Standard high-definition for web video.' };
    return { text: `${w} x ${h}`, badge: 'Standard Definition (SD)', desc: 'Compact video dimensions.' };
  }

  function getFriendlyFps(fpsStr) {
    let fps = 30;
    if (fpsStr && fpsStr.includes('/')) {
      const parts = fpsStr.split('/');
      fps = Math.round(parseFloat(parts[0]) / parseFloat(parts[1] || 1));
    } else {
      fps = Math.round(parseFloat(fpsStr || 30));
    }
    if (fps >= 60) return { text: `${fps} frames/sec`, badge: 'Super Smooth Motion (60 FPS)', desc: 'Ideal for fast action, sports, and gaming.' };
    if (fps >= 29) return { text: `${fps} frames/sec`, badge: 'Standard Video Motion (30 FPS)', desc: 'Standard smoothness for web videos, television, and YouTube.' };
    if (fps >= 23) return { text: `${fps} frames/sec`, badge: 'Cinematic Movie Motion (24 FPS)', desc: 'Classic Hollywood film motion cadence.' };
    return { text: `${fps} fps`, badge: 'Variable Rate', desc: 'Individual still picture frames shown every second.' };
  }

  function getFriendlyAudioCodec(codec, longName) {
    const c = (codec || '').toLowerCase();
    if (c === 'aac') return { title: 'AAC (Advanced Audio Coding)', badge: 'Modern High-Efficiency', desc: 'Crystal-clear compression used by YouTube, Apple, and smartphones.' };
    if (c === 'mp3') return { title: 'MP3 Audio', badge: 'Universal Standard', desc: 'Legacy compressed format supported by every media player.' };
    if (c.includes('pcm')) return { title: 'Uncompressed PCM Audio (WAV)', badge: '100% Lossless Master', desc: 'Pure digital audio without any quality loss.' };
    if (c === 'flac') return { title: 'FLAC Audio', badge: 'Lossless Compressed', desc: 'Compressed like a ZIP file with 100% bit-for-bit studio audio quality.' };
    if (c === 'opus') return { title: 'Opus Audio', badge: 'Ultra Low-Latency Voice', desc: 'Modern state-of-the-art voice & music codec used in Discord/Zoom.' };
    return { title: longName || codec || 'Audio', badge: 'Audio Codec', desc: 'Algorithm used to compress and decode sound.' };
  }

  function getFriendlyVideoCodec(codec, longName) {
    const c = (codec || '').toLowerCase();
    if (c === 'h264' || c === 'avc1') return { title: 'H.264 / AVC', badge: 'Universal Video Standard', desc: 'Plays on 99.9% of devices, browsers, TVs, and phones in the world.' };
    if (c === 'hevc' || c === 'h265') return { title: 'H.265 / HEVC', badge: 'High-Efficiency 4K', desc: 'Provides half the file size of H.264 at identical visual quality.' };
    if (c === 'vp9') return { title: 'Google VP9', badge: 'Modern Web Video', desc: 'Efficient open video standard used by YouTube for 4K.' };
    if (c === 'av1') return { title: 'AV1 Next-Gen', badge: 'Next-Generation Codec', desc: 'State-of-the-art open royalty-free video compression.' };
    if (c === 'mjpeg') return { title: 'Motion JPEG', badge: 'Frame Image Sequence', desc: 'Series of JPEG photographs played in rapid sequence.' };
    return { title: longName || codec || 'Video', badge: 'Video Codec', desc: 'Algorithm used to compress and decompress video frames.' };
  }

  // Internal bookkeeping keys that are not real metadata
  const INTERNAL_TAG_KEYS = ['exif_present', 'photoshop_present', 'file_extension', 'xmp_history', 'ai_parameters', 'ai_prompt', '__xmp'];
  function visibleTagEntries(tags) {
    return Object.entries(tags || {}).filter(([k, v]) => !INTERNAL_TAG_KEYS.includes(k) && v !== '' && v !== null && v !== undefined);
  }
  function isDocumentData(format) { return Boolean(format && (format.is_document || format.format_name === 'pdf')); }
  const DOC_NAMES = { pdf: 'PDF document', docx: 'Word document', xlsx: 'Excel spreadsheet', pptx: 'PowerPoint presentation', odt: 'OpenDocument text document', ods: 'OpenDocument spreadsheet', odp: 'OpenDocument presentation' };

  function humanizeTagKey(rawKey) {
    const map = {
      'encoder': { label: 'Software / Encoding Tool', hint: 'Application or script that exported this file' },
      'creation_time': { label: 'Original Recording Date & Time', hint: 'Timestamp when this media was originally recorded' },
      'modification_time': { label: 'Last Saved / Modified Date', hint: 'Timestamp when this file was last edited or re-saved' },
      'DateTimeOriginal': { label: 'Camera Capture Shutter Date', hint: 'Exact moment the camera sensor clicked the photo' },
      'ModifyDate': { label: 'Software Edit Date', hint: 'When the photo was saved in an editor like Photoshop' },
      'DateTime': { label: 'File Date', hint: 'Saved date recorded in EXIF' },
      'Make': { label: '📱 Camera / Device Manufacturer', hint: 'Company that manufactured the hardware (Apple, Sony, Canon, Samsung, DJI, Zoom)' },
      'Model': { label: '📱 Hardware Model Name', hint: 'Exact camera or smartphone model (iPhone 14 Pro, Alpha 7 IV, Galaxy S23)' },
      'Device': { label: '📱 Recording Hardware Device', hint: 'Hardware device stamped in file metadata' },
      'Hardware': { label: '📱 Hardware Platform', hint: 'Physical hardware specification' },
      'LensModel': { label: '🔍 Camera Lens / Optics', hint: 'Camera lens, optical focal length, and aperture specifications' },
      'LensSpecification': { label: '🔍 Lens Optical Range', hint: 'Optical zoom range and max apertures' },
      'LensMake': { label: '🔍 Lens Manufacturer', hint: 'Company that designed and built the lens' },
      'BodySerialNumber': { label: '🔢 Camera Hardware Serial Number', hint: 'Unique factory hardware serial number stamped on device' },
      'SerialNumber': { label: '🔢 Hardware Serial Number', hint: 'Factory device identifier' },
      'HostComputer': { label: '💻 Host Workstation / Computer', hint: 'Operating system or computer hardware that processed the file' },
      'FocalLength': { label: '🔭 Optical Focal Length', hint: 'Camera lens zoom distance in millimeters' },
      'Software': { label: 'Software Application Used', hint: 'Application or firmware running when saved' },
      'Artist': { label: 'Artist / Author Name', hint: 'Creator credited in metadata' },
      'Author': { label: 'Document Author', hint: 'Person or entity who wrote the document' },
      'Title': { label: 'Media Title', hint: 'Song, video, or document title' },
      'bext_originator': { label: '🎙️ Studio Audio Hardware Device', hint: 'Professional Broadcast Wave field recorder (Zoom, Sound Devices, Tascam)' },
      'bext_origination_date': { label: 'Sound Recording Date', hint: 'Broadcast Wave Format audio capture date' },
      'bext_origination_time': { label: 'Sound Recording Time', hint: 'Broadcast Wave Format audio capture time' },
      'major_brand': { label: 'Primary File Specification', hint: 'ISO Base Media File standard compatibility badge' },
      'minor_version': { label: 'Encoder Build Version', hint: 'Technical version number of the container writer' },
      'compatible_brands': { label: 'Device Compatibility Profiles', hint: 'List of media player standards this file adheres to' },
      'pdf_version': { label: 'PDF Document Format Version', hint: 'Adobe PDF specification standard' },
      'ai_prompt': { label: '🤖 AI Generation Prompt', hint: 'Text description used by AI model to generate this image' },
      'ai_parameters': { label: '🤖 AI Model Seeds & Settings', hint: 'Generation settings: steps, seed, sampler, CFG' },
      'comment': { label: 'Embedded Comment / Notes', hint: 'Text notes left by the creator or software' },
      'GPSPosition': { label: '📍 Location (GPS)', hint: 'Where the file was created. Remove before sharing if you want to keep this private' },
      'GPSLatitude': { label: '📍 Latitude', hint: 'North/south position in decimal degrees (negative = south)' },
      'GPSLongitude': { label: '📍 Longitude', hint: 'East/west position in decimal degrees (negative = west)' },
      'GPSAltitude': { label: '📍 Altitude', hint: 'Height above sea level' },
      'GPSTimeStamp': { label: '📍 GPS Time', hint: 'Time reported by the GPS receiver (UTC)' },
      'GPSDateStamp': { label: '📍 GPS Date', hint: 'Date reported by the GPS receiver' },
      'Location': { label: '📍 Location', hint: 'Location string stored by the recording device' },
      'UserComment': { label: 'Embedded Comment (EXIF)', hint: 'Free-text comment. AI image tools store their prompt and settings here' },
      'ImageDescription': { label: 'Image Description', hint: 'Caption or prompt stored with the image' },
      'Copyright': { label: 'Copyright Notice', hint: 'Rights statement written by the creator' },
      'Orientation': { label: 'Photo Rotation Flag', hint: 'How the camera was held (1 = normal)' },
      'ExposureTime': { label: '📷 Shutter Speed', hint: 'How long the sensor was exposed' },
      'FNumber': { label: '📷 Aperture', hint: 'Lens opening: smaller f-number = more light' },
      'ISO': { label: '📷 ISO Sensitivity', hint: 'Sensor sensitivity: higher numbers brighten but add grain' },
      'FocalLength': { label: '📷 Focal Length', hint: 'Lens zoom distance' },
      'FocalLengthIn35mm': { label: '📷 Focal Length (35mm equivalent)', hint: 'Zoom comparable to a full-frame camera' },
      'Flash': { label: '📷 Flash', hint: 'Whether the flash fired' },
      'ExposureBias': { label: '📷 Exposure Compensation', hint: 'Brightness adjustment the photographer chose' },
      'OffsetTimeOriginal': { label: 'Time Zone of Capture', hint: 'Offset from UTC when the photo was taken' },
      'DateTimeDigitized': { label: 'Date Digitized', hint: 'When the image was converted to digital' },
      'CameraOwnerName': { label: 'Camera Owner', hint: 'Owner name set in the camera' },
      'ImageUniqueID': { label: 'Image Unique ID', hint: 'ID assigned by the camera to this exact image' },
      'PixelXDimension': { label: 'Image Width (px)', hint: 'Width in pixels' },
      'PixelYDimension': { label: 'Image Height (px)', hint: 'Height in pixels' },
      'CreatorTool': { label: 'Program That Created It', hint: 'Software that first made this file' },
      'DigitalSourceType': { label: 'How It Was Made (IPTC label)', hint: 'Standard label such as "trainedAlgorithmicMedia" (AI) or "digitalCapture" (camera)' },
      'Credit': { label: 'Credit Line', hint: 'Who should be credited' },
      'Source': { label: 'Source', hint: 'Original provider of the content' },
      'DocumentID': { label: 'Document ID', hint: 'Unique ID that stays with the document across saves' },
      'OriginalDocumentID': { label: 'Original Document ID', hint: 'ID of the very first version' },
      'LastModifiedBy': { label: '✏️ Last Saved By', hint: 'Person or program that saved the most recent version' },
      'Application': { label: 'Program Used', hint: 'Application that saved the file' },
      'AppVersion': { label: 'Program Version', hint: 'Version of the application' },
      'Company': { label: 'Company / Organisation', hint: 'Organisation name stored in the document' },
      'Template': { label: 'Template Used', hint: 'Template the document was based on' },
      'Revision': { label: 'Revision Number', hint: 'How many times the document was saved' },
      'TotalEditingTime': { label: 'Total Editing Time', hint: 'Minutes the document was open for editing' },
      'Pages': { label: 'Pages', hint: 'Number of pages' }, 'Words': { label: 'Word Count', hint: 'Number of words' }, 'Slides': { label: 'Slides', hint: 'Number of slides' },
      'EmbeddedImages': { label: 'Pictures Inside', hint: 'Number of images embedded in the document' },
      'FilesInside': { label: 'Parts Inside', hint: 'Number of internal files this container holds' },
      'Producer': { label: 'Program That Exported It', hint: 'Software that produced the final PDF' },
      'Creator': { label: 'Program That Created It', hint: 'Application that first made the document' },
      'CreationDate': { label: 'Date Created', hint: 'When the document was created' },
      'ModDate': { label: 'Date Last Modified', hint: 'When the document was last saved' },
      'IPTC Creator': { label: 'Photographer / Creator (IPTC)', hint: 'Name entered by the creator' },
      'IPTC Credit': { label: 'Credit (IPTC)', hint: 'Credit line stored in the photo' },
      'IPTC Caption': { label: 'Caption (IPTC)', hint: 'Description stored in the photo' },
      'IPTC Keywords': { label: 'Keywords (IPTC)', hint: 'Search keywords stored in the photo' }
    };
    return map[rawKey] || { label: rawKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), hint: 'Metadata tag extracted from container' };
  }

  // AI Check tab: who/what/when made this file, with the evidence
  function renderAiTab(data) {
    const box = document.getElementById('aiContainer');
    const btn = document.getElementById('tabAiBtn');
    if (!box) return;
    const ai = data.ai_analysis || { is_ai: false, evidence: [], notes: [], settings: {}, content_credentials: {} };
    const cc = ai.content_credentials || {};
    const miss = '<span class="ai-missing">Not stored in this file</span>';
    const val = (v) => v ? escapeHtml(String(v)) : miss;
    const kind = ai.confidence === 'confirmed' ? 'ai-yes' : ai.confidence === 'likely' ? 'ai-maybe' : 'ai-none';
    const icon = ai.is_ai ? '🤖' : '🔎';
    const headline = ai.is_ai
      ? `${ai.label}${ai.tool ? ' with ' + ai.tool : ''}`
      : 'No AI marks found in this file';
    const sub = ai.is_ai
      ? (ai.confidence === 'confirmed' ? 'The file itself says it was made or changed by AI.' : 'The file mentions an AI tool, but not in a standard label, so treat this as a strong hint rather than certain.')
      : 'We looked for AI labels, tool fingerprints and Content Credentials and found none.';
    if (btn) { btn.classList.toggle('meta-tab-alert', ai.is_ai); btn.textContent = ai.is_ai ? '🤖 AI Check ●' : '🤖 AI Check'; }

    const settingChips = Object.entries(ai.settings || {}).filter(([, v]) => v)
      .map(([k, v]) => `<span class="ai-chip"><b>${escapeHtml(k === 'cfg' ? 'CFG scale' : k.replace(/_/g, ' '))}</b> ${escapeHtml(String(v))}</span>`).join('');
    const rows = [
      ['Made by', val(ai.vendor)],
      ['App / tool', val(ai.tool)],
      ['AI model', val(ai.model)],
      ['When it was made', ai.created_at ? `${escapeHtml(ai.created_at)}<small class="ai-src">${escapeHtml(ai.created_at_source || '')}</small>` : miss]
    ];
    if (ai.prompt) rows.push(['Prompt used', `<pre class="ai-pre">${escapeHtml(ai.prompt)}</pre>`]);
    if (ai.negative_prompt) rows.push(['Negative prompt', `<pre class="ai-pre">${escapeHtml(ai.negative_prompt)}</pre>`]);
    if (settingChips) rows.push(['Settings', `<div class="ai-chips">${settingChips}</div>`]);
    const v = cc.verification;
    const ccLabel = { valid: '✅ Verified', valid_untrusted: '⚠️ Signature valid, signer not on the trust list', partial: '⚠️ Signature valid, file content not checked', invalid: '🚩 Failed verification', unreadable: '⚠️ Present but unreadable' };
    rows.push(['Content Credentials', cc.present
      ? `${v ? escapeHtml(ccLabel[v.status] || v.status) : 'Present'}${cc.generator ? ' · made with ' + escapeHtml(cc.generator) : ''}${cc.time ? ' · ' + escapeHtml(cc.time) : ''}${cc.actions && cc.actions.length ? '<small class="ai-src">Actions: ' + escapeHtml(cc.actions.join(', ')) + '</small>' : ''}${v ? '<small class="ai-src">Details below</small>' : '<small class="ai-src">Not verified</small>'}`
      : '<span class="ai-missing">None (no signed provenance data)</span>']);

    let verifyHtml = '';
    if (v && v.present) {
      const cls = { valid: 'cc-good', valid_untrusted: 'cc-warn', partial: 'cc-warn', invalid: 'cc-bad', unreadable: 'cc-warn' }[v.status] || 'cc-warn';
      const sg = v.signer;
      const icon = (c) => c.ok === true ? '✅' : c.ok === false ? (/trust list/i.test(c.name) ? '⚠️' : '❌') : '➖';
      verifyHtml = `<div class="cc-card ${cls}">
        <h4>🔏 Content Credentials check</h4>
        <div class="cc-headline">${escapeHtml(v.headline || '')}</div>
        ${sg ? `<div class="ai-table cc-table">
          <div class="ai-row"><div class="ai-key">Signed by</div><div class="ai-val">${escapeHtml(sg.name)}${sg.organization && sg.organization !== sg.name ? ' · ' + escapeHtml(sg.organization) : ''}${sg.country ? ' (' + escapeHtml(sg.country) + ')' : ''}</div></div>
          <div class="ai-row"><div class="ai-key">Certificate issued by</div><div class="ai-val">${escapeHtml(sg.issuer)}</div></div>
          <div class="ai-row"><div class="ai-key">Certificate valid</div><div class="ai-val">${escapeHtml(sg.notBefore.slice(0, 10))} to ${escapeHtml(sg.notAfter.slice(0, 10))}</div></div>
          <div class="ai-row"><div class="ai-key">Signed on</div><div class="ai-val">${v.time ? escapeHtml(v.time.value) + '<small class="ai-src">From the timestamp service named in the file</small>' : '<span class="ai-missing">No trusted timestamp</span>'}</div></div>
          <div class="ai-row"><div class="ai-key">Official trust list</div><div class="ai-val">${sg.trusted ? '✅ Chains to ' + escapeHtml(sg.trustedBy) : sg.trustListLoaded ? '⚠️ Not on the C2PA trust list' : 'Not loaded'}</div></div>
          ${v.manifests > 1 ? `<div class="ai-row"><div class="ai-key">History</div><div class="ai-val">${v.manifests} signed versions are recorded, and all of them are checked</div></div>` : ''}
        </div>` : ''}
        <ul class="cc-checks">${v.checks.map(c => `<li>${icon(c)} <b>${escapeHtml(c.name)}</b>${c.note ? '<span>' + escapeHtml(c.note) + '</span>' : ''}</li>`).join('')}</ul>
        <p class="cc-foot">Not checked: whether the certificate was revoked, and the timestamp service's own signature. Valid credentials prove who signed the file and that it is unchanged since. They do not prove the content is true.</p>
      </div>`;
    }

    const hintsHtml = (ai.hints || []).length ? `<div class="ai-notes"><h4>Hints (not proof)</h4><ul>${ai.hints.map(h => `<li>${escapeHtml(h)}</li>`).join('')}</ul></div>` : '';
    const evidence = (ai.evidence || []).length
      ? `<div class="ai-evidence"><h4>What we found</h4>${ai.evidence.map(e => `
          <div class="ai-ev"><span class="ai-ev-badge ev-${e.strength}">${e.strength === 'strong' ? 'Strong' : e.strength === 'medium' ? 'Likely' : 'Info'}</span>
          <div><b>${escapeHtml(e.source)}</b><span>${escapeHtml(e.detail)}</span></div></div>`).join('')}</div>`
      : '';

    box.innerHTML = `
      <div class="ai-verdict ${kind}">
        <span class="ai-verdict-icon">${icon}</span>
        <div><div class="ai-verdict-title">${escapeHtml(headline)}</div><div class="ai-verdict-sub">${escapeHtml(sub)}</div></div>
      </div>
      <div class="ai-table">${rows.map(([k, val2]) => `<div class="ai-row"><div class="ai-key">${k}</div><div class="ai-val">${val2}</div></div>`).join('')}</div>
      ${verifyHtml}
      ${evidence}
      ${hintsHtml}
      <div class="ai-notes"><h4>Good to know</h4><ul>${(ai.notes || []).map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`;
  }

  // Plain-English summary for non-technical readers
  function renderPlainSummary(data, devInfo, friendlyFmt) {
    const box = document.getElementById('plainSummary');
    if (!box) return;
    const format = data.format || {};
    const streams = data.streams || [];
    const forensics = data.forensics || {};
    const tags = data.all_tags || format.tags || {};
    const tamper = data.tamper_analysis || {};
    const audio = streams.find(st => st.codec_type === 'audio');
    const video = streams.find(st => st.codec_type === 'video');
    const dur = parseFloat(format.duration || 0);
    const isImage = String(forensics.mime_detected || (currentFile && currentFile.type) || '').startsWith('image/');
    const size = formatBytes(parseInt(format.size || (currentFile && currentFile.size) || 0));

    const secs = Math.round(dur);
    const len = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} sec` : `${secs} second`;
    let what;
    if (isImage) what = `an image (${video ? video.width + ' × ' + video.height + ' pixels' : 'picture'})`;
    else if (video && audio) what = `a ${len} video with sound`;
    else if (video) what = `a ${len} silent video`;
    else if (audio) what = `a ${len} audio recording`;
    else what = 'a file';
    const ext = ((currentFile && currentFile.name.split('.').pop()) || '').toUpperCase();

    const rows = [];
    const isPdf = isDocumentData(format);
    const isStillImagePlain = String(forensics.mime_detected || (currentFile && currentFile.type) || '').startsWith('image/');
    const docName = DOC_NAMES[format.format_name] || 'document';
    rows.push({ icon: '📄', title: 'What it is', state: 'info',
      text: isPdf ? `This is a ${docName} (${size})${tags.Pages ? ', ' + tags.Pages + ' page' + (tags.Pages === '1' ? '' : 's') : ''}${tags.Words ? ', about ' + Number(tags.Words).toLocaleString() + ' words' : ''}.` : `This is ${what}, stored as ${/^[AEFHILMNORSX]/.test(ext) ? 'an' : 'a'} ${ext || 'media'} file (${size}).` });

    const ai = data.ai_analysis || {};
    if (ai.is_ai) {
      const parts = [];
      if (ai.tool) parts.push(`made with ${ai.tool}`);
      if (ai.model && ai.model !== ai.tool) parts.push(`using the model "${ai.model}"`);
      const when = ai.created_at ? `, around ${String(ai.created_at).replace(/T.*$/, '')}` : '';
      const who = parts.length ? `It was ${parts.join(', ')}${when}.` : `The file carries AI marks${when}.`;
      rows.push({ icon: '🤖', title: 'Made by AI?', state: 'ai', text: `${ai.confidence === 'confirmed' ? 'Yes.' : 'Probably.'} ${who} Open the AI Check tab for the full details.` });
    } else {
      rows.push({ icon: '🤖', title: 'Made by AI?', state: 'info', text: isPdf
        ? 'No AI labels were found. A document only records the program that saved it, so this cannot show whether AI helped write the text.'
        : 'No AI labels were found in this file. That doesn\'t prove a person made it, because AI marks are often removed when files are shared. See the AI Check tab.' });
    }

    const c2 = data.c2pa;
    if (c2 && c2.present) {
      rows.push({ icon: '🔏', title: 'Content Credentials', state: { valid: 'good', valid_untrusted: 'warn', partial: 'warn', invalid: 'bad', unreadable: 'warn' }[c2.status] || 'info',
        text: `${c2.headline || 'Signed provenance data is attached to this file.'} Open the AI Check tab for the details.` });
    }

    const created = (tamper.original_data || {}).created_at;
    const hasDate = created && created !== 'N/A' && !/^not explicitly/i.test(created);
    const hasDevice = devInfo && devInfo.detected !== false && devInfo.device_name && !/not tagged|untagged/i.test(devInfo.device_name);
    const isDoc = devInfo && devInfo.is_document;
    if (hasDate || hasDevice) {
      rows.push({ icon: '🗓️', title: 'Where it came from', state: 'info',
        text: `${hasDevice ? (isDoc ? 'Created with ' : 'Made on ') + devInfo.device_name : 'Made on an unknown device'}${isDoc && tags.Author && !/^un-?named$/i.test(tags.Author) ? ', written by ' + tags.Author : ''}${isDoc && tags.LastModifiedBy && tags.LastModifiedBy !== tags.Author ? ', last saved by ' + tags.LastModifiedBy : ''}${hasDate ? ', dated ' + String(created).replace(/^(\d{4}):(\d{2}):(\d{2}).*$/, '$1-$2-$3').replace(/T.*$/, '').replace(/ \d{2}:\d{2}:\d{2}.*$/, '') : ''}.` });
    } else {
      rows.push({ icon: '🗓️', title: 'Where it came from', state: 'warn', text: 'The file doesn\'t say when or on what device it was made. This is common for files sent through WhatsApp or social media, which remove that information.' });
    }

    const risk = String(tamper.risk_level || 'LOW').toUpperCase();
    if (tamper.verdict === 'AI_GENERATED') rows.push({ icon: '🕵️', title: 'Has it been edited?', state: 'info', text: 'It was created by software rather than recorded by a camera or microphone, so there is no original recording to compare it with.' });
    else if (risk === 'HIGH' || risk === 'CRITICAL') rows.push({ icon: '🕵️', title: 'Has it been edited?', state: 'bad', text: 'Yes, there are clear signs it was changed after it was recorded. See the Edit History tab for what we found.' });
    else if (risk === 'MEDIUM' && isPdf) rows.push({ icon: '🕵️', title: 'Has it been edited?', state: 'warn', text: tamper.summary || 'It was saved again after it was created.' });
    else if (risk === 'MEDIUM') rows.push({ icon: '🕵️', title: 'Has it been edited?', state: 'warn', text: 'It was re-saved or converted after it was first recorded. That is normal when files are shared or exported, but the original has not been kept.' });
    else rows.push({ icon: '🕵️', title: 'Has it been edited?', state: 'good', text: isPdf ? 'No signs of editing were found in the file\'s information. (A document cannot prove that its text is unchanged.)' : 'No signs of editing were found. (Missing traces do not prove a file is untouched, because editing tools can remove them.)' });

    const tagKeys = visibleTagEntries(tags).map(([k]) => k);
    const hasGps = tags.GPSPosition || tagKeys.some(k => /gps|location|latitude|longitude/i.test(k));
    if (hasGps) rows.push({ icon: '📍', title: 'Location', state: 'bad', text: `${tags.GPSPosition ? 'This file records where it was made: ' + tags.GPSPosition + (tags.GPSAltitude ? ' (altitude ' + tags.GPSAltitude + ')' : '') + '.' : 'This file contains location information.'} Remove it before sharing publicly if you want to keep your location private.` });
    if (hasGps) rows.push({ icon: '🏷️', title: 'Other hidden information', state: 'info', text: `${tagKeys.length} details are stored inside the file. Open the Hidden Info tab to read them.` });
    else rows.push({ icon: '🏷️', title: 'Hidden information', state: tagKeys.length ? 'info' : 'good', text: tagKeys.length ? `${tagKeys.length} extra details are stored inside the file (such as software used or dates). Open the Hidden Info tab to read them. No location data was found.` : 'No hidden details are stored inside this file. No location data was found.' });

    if (audio) {
      const sr = getFriendlySampleRate(audio.sample_rate);
      const ch = getFriendlyChannels(audio.channels, audio.channel_layout);
      rows.push({ icon: '🔊', title: 'Sound quality', state: 'info', text: `${sr.badge} — ${((ch.text.match(/\(([^)]+)\)/) || [])[1] || ch.text).toLowerCase()} sound. ${sr.desc}` });
    }
    if (video) {
      const res = getFriendlyResolution(video.width, video.height);
      if (!isImage) rows.push({ icon: '🎬', title: 'Picture quality', state: 'info', text: `${res.badge} (${res.text}). ${res.desc}` });
    }
    rows.push({ icon: isPdf ? '💻' : '📱', title: (isPdf || isStillImagePlain) ? 'Will it open everywhere?' : 'Will it play everywhere?', state: 'info', text: friendlyFmt.desc });

    const icons = { good: '✅', warn: '⚠️', bad: '🚩', info: 'ℹ️', ai: '🤖' };
    box.innerHTML = `<h3 class="section-subtitle">In plain English</h3>` + rows.map(r => `
      <div class="plain-row plain-${r.state}">
        <span class="plain-icon">${r.icon}</span>
        <div class="plain-body"><strong>${escapeHtml(r.title)}</strong><span>${escapeHtml(r.text)}</span></div>
        <span class="plain-state" title="${r.state}">${icons[r.state]}</span>
      </div>`).join('');
  }

  // At-a-glance summary cards shown at the top of the metadata view
  function renderGlance(data, devInfo, friendlyFmt, bitRateKbps) {
    const grid = document.getElementById('glanceGrid');
    if (!grid) return;
    const format = data.format || {};
    const streams = data.streams || [];
    const forensics = data.forensics || {};
    const tags = data.all_tags || format.tags || {};
    const tamper = data.tamper_analysis || {};
    const audio = streams.find(st => st.codec_type === 'audio');
    const video = streams.find(st => st.codec_type === 'video');
    const dur = parseFloat(format.duration || 0);
    const isImage = String(forensics.mime_detected || (currentFile && currentFile.type) || '').startsWith('image/');
    const cards = [];

    cards.push({ label: 'File type', value: friendlyFmt.title, sub: forensics.mime_detected || format.format_name });
    cards.push({ label: 'Size', value: formatBytes(parseInt(format.size || (currentFile && currentFile.size) || 0)), sub: parseInt(format.size || 0).toLocaleString() + ' bytes' });
    if (dur > 0 && !isImage) cards.push({ label: 'Duration', value: formatTime(dur).replace(/\.\d+$/, ''), sub: dur.toFixed(2) + ' seconds' });
    if (video) {
      const res = getFriendlyResolution(video.width, video.height);
      const fps = getFriendlyFps(video.avg_frame_rate || '30');
      cards.push(isImage
        ? { label: 'Dimensions', value: res.text.replace(' x ', ' × ') + ' px', sub: `${(video.codec_name || '').toUpperCase()} image` }
        : { label: 'Video', value: res.text, sub: `${(video.codec_name || '').toUpperCase()} · ${fps.text} · ${res.badge}` });
    }
    if (audio) {
      const sr = getFriendlySampleRate(audio.sample_rate);
      const ch = getFriendlyChannels(audio.channels, audio.channel_layout);
      cards.push({ label: 'Audio', value: (audio.codec_name || '').toUpperCase() + ' · ' + sr.text.replace(/ \(.*\)/, ''), sub: `${ch.text}${bitRateKbps > 0 ? ' · ' + bitRateKbps + ' kbps' : ''}` });
    }
    const orig = tamper.original_data || {};
    const created = orig.created_at && orig.created_at !== 'N/A' && !/^not explicitly/i.test(orig.created_at) ? orig.created_at : (tags.creation_time || tags.DateTimeOriginal || tags.bext_origination_date);
    cards.push({ label: isDocumentData(format) ? 'Created' : 'Recorded', value: created || 'Not stored in file', sub: created ? (isDocumentData(format) ? 'Date saved inside the file' : 'Date embedded by the recording device') : 'No timestamp tags found' });
    const aiRes = data.ai_analysis;
    if (aiRes) {
      cards.push({ label: 'Made by AI?', value: aiRes.is_ai ? (aiRes.confidence === 'confirmed' ? 'Yes' : 'Probably') : 'No marks found',
        sub: aiRes.is_ai ? [aiRes.tool, aiRes.model].filter(Boolean).join(' · ') || 'See AI Check' : 'Click for details', color: aiRes.is_ai ? '#a855f7' : null, tab: 'ai' });
    }
    if (tamper.verdict_label) {
      cards.push({ label: 'Edited?', value: tamper.verdict_label, sub: 'Risk: ' + (tamper.risk_level || 'LOW'), color: tamper.badge_color, tab: 'tamper' });
    }
    if (forensics.sha256) {
      cards.push({ label: 'File fingerprint', value: forensics.sha256.slice(0, 16) + '…', sub: 'Unique ID of this exact file · click to copy', copy: forensics.sha256, mono: true });
    }

    grid.innerHTML = '';
    cards.forEach(c => {
      const el = document.createElement(c.copy || c.tab ? 'button' : 'div');
      if (el.tagName === 'BUTTON') el.type = 'button';
      el.className = 'glance-card' + (c.copy || c.tab ? ' glance-clickable' : '');
      el.innerHTML = `<span class="glance-label">${escapeHtml(c.label)}</span>
        <span class="glance-value${c.mono ? ' mono' : ''}"${c.color ? ` style="color:${c.color}"` : ''}>${escapeHtml(String(c.value))}</span>
        <span class="glance-sub">${escapeHtml(String(c.sub || ''))}</span>`;
      if (c.copy) el.addEventListener('click', () => { navigator.clipboard.writeText(c.copy); showToast('📋 SHA-256 copied', 'info', 2000); });
      if (c.tab) el.addEventListener('click', () => { const t = document.querySelector(`.meta-tab[data-tab="${c.tab}"]`); if (t) t.click(); });
      grid.appendChild(el);
    });
  }

  // 2. Render Universal FFprobe & File Metadata Inspector
  function renderMetadata(data) {
    metadataGrid.innerHTML = '';
    const format = data.format || {};
    const streams = data.streams || [];
    const forensics = data.forensics || {};
    const tags = data.all_tags || format.tags || {};
    const containerTree = data.container_tree || [];

    // Tab 1: Overview & Streams
    const fileSizeMb = (parseInt(format.size || 0) / (1024 * 1024)).toFixed(2);
    const bitRateKbps = Math.round(parseInt(format.bit_rate || 0) / 1000);
    const durationSec = parseFloat(format.duration || 0).toFixed(2);

    const friendlyFmt = getFriendlyFormatName(format.format_long_name, format.format_name, format.filename);
    const bitrateInfo = getFriendlyBitrateInfo(bitRateKbps);

    const devInfo = data.device_info || {
      detected: false,
      device_name: 'Device Not Tagged (Common for WhatsApp / Forwarded Files)',
      hardware_type: 'Untagged Asset',
      hardware_icon: '📱',
      badge_color: '#eab308',
      explanation: 'No hardware tags embedded in container.'
    };

    // Update Persistent Top Device Origin Banner
    if (deviceOriginBanner) {
      if (deviceBannerIcon) deviceBannerIcon.textContent = devInfo.hardware_icon || '📱';
      if (deviceBannerName) deviceBannerName.textContent = devInfo.device_name || 'Untagged Media Asset';
      if (deviceBannerBadge) {
        deviceBannerBadge.textContent = devInfo.hardware_type || 'Media Asset';
        deviceBannerBadge.style.color = devInfo.badge_color || '#10b981';
        deviceBannerBadge.style.borderColor = (devInfo.badge_color || '#10b981') + '50';
      }
      if (deviceBannerStatus) deviceBannerStatus.textContent = devInfo.confidence || 'Detected';
      if (valDeviceNo) valDeviceNo.textContent = devInfo.device_no || devInfo.model_no || 'Not Stamped';
      if (valSerialNo) valSerialNo.textContent = devInfo.serial ? `SN: ${devInfo.serial}` : (devInfo.is_hardware_device ? 'Protected by Phone OS' : (devInfo.serial_no || 'Not Stamped'));
      if (valLens) valLens.textContent = devInfo.lens || (devInfo.is_hardware_device ? 'Standard Sensor Optics' : 'N/A');
      if (valHost) valHost.textContent = devInfo.host_computer || devInfo.manufacturer || 'Standard System';
      if (deviceBannerDesc) deviceBannerDesc.textContent = devInfo.explanation;
      const chips = document.getElementById('deviceBannerSpecsRow');
      if (chips) chips.style.display = devInfo.is_document ? 'none' : '';
      deviceOriginBanner.style.display = 'flex';
    }

    renderAiTab(data);
    renderPlainSummary(data, devInfo, friendlyFmt);
    renderGlance(data, devInfo, friendlyFmt, bitRateKbps);

    const containerBox = document.createElement('div');
    containerBox.className = 'meta-box';
    containerBox.innerHTML = `
      <div class="meta-box-header">
        <span class="meta-title">📦 ${escapeHtml(friendlyFmt.title)}</span>
        <span class="meta-pill meta-pill-purple">${escapeHtml(friendlyFmt.badge)}</span>
      </div>
      <div class="meta-specs">
        <div class="meta-row meta-device-highlight-row">
          <div class="meta-label-group">
            <span class="meta-label">${devInfo.hardware_icon || '📱'} Created On / Recording Device</span>
            <span class="meta-hint">${escapeHtml(devInfo.explanation)}</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val meta-val-device" style="color:${devInfo.badge_color || '#10b981'}; font-weight:700;">
              ${escapeHtml(devInfo.device_name)}
            </span>
            <span class="meta-pill" style="background:${devInfo.badge_color || '#10b981'}20; color:${devInfo.badge_color || '#10b981'}; border-color:${devInfo.badge_color || '#10b981'}50;">
              ${escapeHtml(devInfo.hardware_type)}
            </span>
            ${devInfo.lens ? `<span class="meta-pill meta-pill-purple" title="Optics & Lens Specification">🔍 ${escapeHtml(devInfo.lens)}</span>` : ''}
            ${devInfo.host_computer ? `<span class="meta-pill" title="Host Workstation">💻 ${escapeHtml(devInfo.host_computer)}</span>` : ''}
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-label-group">
            <span class="meta-label">🔢 Device No. / Model Number</span>
            <span class="meta-hint">Hardware model identifier stamped in file header</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val" style="font-family:var(--font-mono); color:#38bdf8; font-weight:700;">
              ${escapeHtml(devInfo.device_no || devInfo.model_no || 'Not Embedded')}
            </span>
            <span class="meta-pill">${escapeHtml(devInfo.model_no || 'Model Tag')}</span>
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-label-group">
            <span class="meta-label">🔒 Device Serial Number</span>
            <span class="meta-hint">${escapeHtml(devInfo.serial ? 'Physical body serial number stamped by camera hardware' : 'Smartphones omit physical serial numbers (IMEI) for anti-tracking privacy')}</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val" style="font-family:var(--font-mono); color:${devInfo.serial ? '#10b981' : '#94a3b8'};">
              ${escapeHtml(devInfo.serial ? devInfo.serial : (devInfo.serial_no || 'Not Stamped'))}
            </span>
            <span class="meta-pill ${devInfo.serial ? 'meta-pill-success' : ''}">${devInfo.serial ? 'Hardware Stamped' : 'Privacy Protected'}</span>
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-label-group">
            <span class="meta-label">📄 File Name & Format</span>
            <span class="meta-hint">${escapeHtml(friendlyFmt.desc)}</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val">${escapeHtml(format.filename || 'File')}</span>
            <span class="meta-pill">${escapeHtml(format.format_name || 'Container')}</span>
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-label-group">
            <span class="meta-label">💾 File Size</span>
            <span class="meta-hint">Storage space occupied on your device</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val">${fileSizeMb} MB</span>
            <span class="meta-pill">${parseInt(format.size || 0).toLocaleString()} bytes</span>
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-label-group">
            <span class="meta-label">⏱️ Playback Duration</span>
            <span class="meta-hint">Total playtime length</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val">${durationSec > 0 ? durationSec + ' sec' : 'Static Media'}</span>
            ${durationSec > 0 ? `<span class="meta-pill meta-pill-success">${(durationSec / 60).toFixed(1)} mins</span>` : ''}
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-label-group">
            <span class="meta-label">⚡ Overall Data Rate (Bitrate)</span>
            <span class="meta-hint">${escapeHtml(bitrateInfo.desc)}</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val">${escapeHtml(bitrateInfo.text)}</span>
            <span class="meta-pill meta-pill-warning">${escapeHtml(bitrateInfo.badge)}</span>
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-label-group">
            <span class="meta-label">🎛️ Media Tracks (Streams)</span>
            <span class="meta-hint">Individual audio, video, or data components</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val">${streams.length} Track${streams.length === 1 ? '' : 's'}</span>
            <span class="meta-pill">${streams.map(s => s.codec_type).join(' + ')}</span>
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-label-group">
            <span class="meta-label">🛡️ True Identity (MIME Type)</span>
            <span class="meta-hint">Verified internal file format signature</span>
          </div>
          <div class="meta-val-group">
            <span class="meta-val" style="color:#67e8f9;">${escapeHtml(forensics.mime_detected || 'Unknown')}</span>
            <span class="meta-pill meta-pill-success">Verified</span>
          </div>
        </div>
      </div>
    `;
    const isDocFile = isDocumentData(format);
    if (isDocFile) {
      // Rows that only make sense for recordings are removed for documents
      const hideLabels = ['Device No.', 'Device Serial', 'Playback Duration', 'Overall Data Rate', 'Media Tracks'];
      containerBox.querySelectorAll('.meta-row').forEach(row => {
        const label = (row.querySelector('.meta-label') || {}).textContent || '';
        if (hideLabels.some(h => label.includes(h))) row.remove();
        else if (label.includes('Created On / Recording Device')) row.querySelector('.meta-label').textContent = '🛠️ Created with';
      });
    }
    metadataGrid.appendChild(containerBox);


    // ---- Extra detail cards: camera/photo settings, location, document properties ----
    const addInfoBox = (title, pill, rowsData, pillClass = '') => {
      const data = rowsData.filter(r => r[1] !== null && r[1] !== undefined && r[1] !== '');
      if (!data.length) return;
      const box = document.createElement('div');
      box.className = 'meta-box';
      box.innerHTML = `
        <div class="meta-box-header"><span class="meta-title">${title}</span>${pill ? `<span class="meta-pill ${pillClass}">${escapeHtml(pill)}</span>` : ''}</div>
        <div class="meta-specs">${data.map(([label, value, hint]) => `
          <div class="meta-row">
            <div class="meta-label-group"><span class="meta-label">${label}</span>${hint ? `<span class="meta-hint">${escapeHtml(hint)}</span>` : ''}</div>
            <div class="meta-val-group"><span class="meta-val">${escapeHtml(String(value))}</span></div>
          </div>`).join('')}</div>`;
      metadataGrid.appendChild(box);
    };

    if (!isDocFile) {
      const cam = [tags.Make, tags.Model].filter(Boolean).join(' ');
      addInfoBox('📷 Photo details', tags.exif_present ? 'EXIF found' : '', [
        ['Camera', cam, 'Maker and model that took the photo'],
        ['Lens', tags.LensModel || tags.LensSpecification],
        ['Shutter speed', tags.ExposureTime], ['Aperture', tags.FNumber], ['ISO', tags.ISO],
        ['Focal length', tags.FocalLength ? tags.FocalLength + (tags.FocalLengthIn35mm ? ` (${tags.FocalLengthIn35mm} equivalent)` : '') : ''],
        ['Flash', tags.Flash], ['Exposure compensation', tags.ExposureBias],
        ['Taken', tags.DateTimeOriginal ? tags.DateTimeOriginal + (tags.OffsetTimeOriginal ? ' (UTC' + tags.OffsetTimeOriginal + ')' : '') : ''],
        ['Last edited', tags.ModifyDate], ['Software', tags.Software, 'Program that last wrote this file'],
        ['Owner', tags.CameraOwnerName], ['Artist', tags.Artist], ['Copyright', tags.Copyright],
        ['Description', tags.ImageDescription || tags.Description]
      ]);
      if (tags.GPSPosition) {
        addInfoBox('📍 Location', 'Private data', [
          ['Position', tags.GPSPosition, 'Where the file was created'],
          ['Latitude / Longitude', `${tags.GPSLatitude}, ${tags.GPSLongitude}`, 'Decimal degrees (negative = south / west)'],
          ['Altitude', tags.GPSAltitude], ['GPS time', [tags.GPSDateStamp, tags.GPSTimeStamp].filter(Boolean).join(' ')]
        ], 'meta-pill-warning');
      }
      addInfoBox('🏷️ Credits & rights', 'IPTC / XMP', [
        ['Creator', tags['IPTC Creator']], ['Credit', tags.Credit || tags['IPTC Credit']], ['Source', tags.Source || tags['IPTC Source']],
        ['Caption', tags['IPTC Caption']], ['Keywords', tags['IPTC Keywords']], ['City', tags['IPTC City']], ['Country', tags['IPTC Country']],
        ['How it was made (label)', tags.DigitalSourceType, 'Standard IPTC label'], ['Created with', tags.CreatorTool]
      ]);
    } else {
      addInfoBox('📝 Document details', DOC_NAMES[format.format_name] || 'Document', [
        ['Title', tags.Title], ['Subject', tags.Subject], ['Author', tags.Author, 'Person or program recorded as the creator'],
        ['Last saved by', tags.LastModifiedBy], ['Created', tags.creation_time || tags.CreationDate], ['Last modified', tags.modification_time || tags.ModDate],
        ['Created with', tags.Creator], ['Exported / saved with', tags.Producer || tags.Software || tags.Application],
        ['Program version', tags.AppVersion], ['Company', tags.Company], ['Template', tags.Template],
        ['Revision', tags.Revision], ['Editing time', tags.TotalEditingTime], ['Pages', tags.Pages], ['Words', tags.Words], ['Slides', tags.Slides],
        ['Pictures inside', tags.EmbeddedImages], ['Keywords', tags.Keywords], ['Description', tags.Description]
      ]);
    }

    // Render Stream Boxes
    const isStillImage = /^(image2|webp|heif|gif|png|tiff)/i.test(format.format_name || '') || String(forensics.mime_detected || '').startsWith('image/');
    streams.forEach(stream => {
      if (isDocFile) return;
      const isVideo = stream.codec_type === 'video';
      const isAudio = stream.codec_type === 'audio';
      const box = document.createElement('div');
      box.className = 'meta-box';

      if (isVideo) {
        const vCodec = getFriendlyVideoCodec(stream.codec_name, stream.codec_long_name);
        const resInfo = getFriendlyResolution(stream.width, stream.height);
        const fpsInfo = getFriendlyFps(stream.avg_frame_rate || '30');

        box.innerHTML = `
          <div class="meta-box-header">
            <span class="meta-title">${isStillImage ? '🖼️ Image' : '📺 Video Track #' + (stream.index + 1)}: ${escapeHtml(vCodec.title)}</span>
            <span class="meta-pill meta-pill-purple">${escapeHtml(vCodec.badge)}</span>
          </div>
          <div class="meta-specs">
            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🎬 Video Compression (Codec)</span>
                <span class="meta-hint">${escapeHtml(vCodec.desc)}</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(stream.codec_name.toUpperCase())}</span>
                <span class="meta-pill">${escapeHtml(stream.codec_long_name || stream.codec_name)}</span>
              </div>
            </div>

            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">📐 Screen Resolution (Clarity)</span>
                <span class="meta-hint">${escapeHtml(resInfo.desc)}</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(resInfo.text)}</span>
                <span class="meta-pill meta-pill-success">${escapeHtml(resInfo.badge)}</span>
              </div>
            </div>

            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🖼️ Screen Shape (Aspect Ratio)</span>
                <span class="meta-hint">Width to height screen ratio</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(stream.display_aspect_ratio || '16:9')}</span>
                <span class="meta-pill">${stream.display_aspect_ratio === '16:9' ? 'Widescreen' : (stream.display_aspect_ratio === '9:16' ? 'Vertical Reel' : 'Standard')}</span>
              </div>
            </div>

            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🏎️ Motion Smoothness (Frame Rate)</span>
                <span class="meta-hint">${escapeHtml(fpsInfo.desc)}</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(fpsInfo.text)}</span>
                <span class="meta-pill meta-pill-warning">${escapeHtml(fpsInfo.badge)}</span>
              </div>
            </div>

            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🎨 Color Detail (Pixel Format)</span>
                <span class="meta-hint">Color depth sampling used for human vision</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(stream.pix_fmt || 'yuv420p')}</span>
                <span class="meta-pill">8-bit Standard Color</span>
              </div>
            </div>
            ${stream.color_space ? `
            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🌈 Color Space</span>
                <span class="meta-hint">Broadcast color standard</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(stream.color_space)}</span>
              </div>
            </div>` : ''}
          </div>
        `;
      } else if (isAudio) {
        const aCodec = getFriendlyAudioCodec(stream.codec_name, stream.codec_long_name);
        const srInfo = getFriendlySampleRate(stream.sample_rate);
        const chInfo = getFriendlyChannels(stream.channels, stream.channel_layout);
        const bdInfo = getFriendlyBitDepth(stream.bits_per_sample, stream.sample_fmt);

        box.innerHTML = `
          <div class="meta-box-header">
            <span class="meta-title">🎙️ Audio Track #${stream.index + 1}: ${escapeHtml(aCodec.title)}</span>
            <span class="meta-pill meta-pill-success">${escapeHtml(aCodec.badge)}</span>
          </div>
          <div class="meta-specs">
            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🎧 Audio Compression (Codec)</span>
                <span class="meta-hint">${escapeHtml(aCodec.desc)}</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(stream.codec_name.toUpperCase())}</span>
                <span class="meta-pill">${escapeHtml(stream.codec_long_name || stream.codec_name)}</span>
              </div>
            </div>

            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🎵 Sound Clarity (Sample Rate)</span>
                <span class="meta-hint">${escapeHtml(srInfo.desc)}</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(srInfo.text)}</span>
                <span class="meta-pill meta-pill-success">${escapeHtml(srInfo.badge)}</span>
              </div>
            </div>

            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🔊 Speaker Setup (Channels)</span>
                <span class="meta-hint">${escapeHtml(chInfo.desc)}</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(chInfo.text)}</span>
                <span class="meta-pill">${escapeHtml(chInfo.badge)}</span>
              </div>
            </div>

            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">🎯 Dynamic Precision (Bit Depth)</span>
                <span class="meta-hint">${escapeHtml(bdInfo.desc)}</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(bdInfo.text)}</span>
                <span class="meta-pill meta-pill-purple">${escapeHtml(bdInfo.badge)}</span>
              </div>
            </div>
          </div>
        `;
      } else {
        box.innerHTML = `
          <div class="meta-box-header">
            <span class="meta-title">💾 Track #${stream.index + 1}: Data Channel</span>
            <span class="meta-pill">${escapeHtml(stream.codec_name || 'data')}</span>
          </div>
          <div class="meta-specs">
            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">Track Type</span>
                <span class="meta-hint">Embedded subtitles, chapters, or binary information</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${escapeHtml(stream.codec_long_name || 'Binary Data Track')}</span>
              </div>
            </div>
            <div class="meta-row">
              <div class="meta-label-group">
                <span class="meta-label">Payload Size</span>
                <span class="meta-hint">Dedicated data footprint</span>
              </div>
              <div class="meta-val-group">
                <span class="meta-val">${stream.size ? (parseInt(stream.size)/1024).toFixed(2) + ' KB' : 'Streamed'}</span>
              </div>
            </div>
          </div>
        `;
      }
      metadataGrid.appendChild(box);
    });

    // Tab 2: Populate All Tags & Properties Table
    if (metaTagsTbody) {
      metaTagsTbody.innerHTML = '';
      const tagEntries = visibleTagEntries(tags);
      if (tagEntries.length === 0) {
        metaTagsTbody.innerHTML = `<tr><td colspan="2" style="color:var(--text-dim); text-align:center; padding:20px;">No embedded ID3, EXIF, or text tags found in this file container.</td></tr>`;
      } else {
        const priorityKeys = [
          'Make', 'Model', 'Device', 'Hardware', 'Camera', 'LensModel', 'LensSpecification', 'LensMake',
          'BodySerialNumber', 'SerialNumber', 'HostComputer', 'bext_originator', 'Software', 'encoder',
          'DateTimeOriginal', 'creation_time', 'ModifyDate', 'modification_time'
        ];
        tagEntries.sort((a, b) => {
          const idxA = priorityKeys.indexOf(a[0]);
          const idxB = priorityKeys.indexOf(b[0]);
          if (idxA !== -1 && idxB !== -1) return idxA - idxB;
          if (idxA !== -1) return -1;
          if (idxB !== -1) return 1;
          return a[0].localeCompare(b[0]);
        });

        tagEntries.forEach(([key, val]) => {
          const info = humanizeTagKey(key);
          const isHardwareTag = ['Make', 'Model', 'Device', 'Hardware', 'Camera', 'LensModel', 'BodySerialNumber', 'HostComputer', 'bext_originator'].includes(key);
          const tr = document.createElement('tr');
          if (isHardwareTag) tr.className = 'tr-hardware-highlight';
          tr.innerHTML = `
            <td class="tag-key">
              <span class="tag-human-name">${escapeHtml(info.label)}</span>
              <span class="tag-tech-name">${escapeHtml(key)}</span>
              <span class="tag-hint">${escapeHtml(info.hint)}</span>
            </td>
            <td class="tag-val">
              <span class="tag-human-val">${escapeHtml(String(val))}</span>
            </td>
          `;
          metaTagsTbody.appendChild(tr);
        });
      }
    }

    // Tab 3: Populate Container Atom / Chunk Tree
    function getFriendlyAtomDesc(box, origDesc) {
      const b = (box || '').toLowerCase();
      if (b.includes('ftyp')) return { role: 'Identity Badge', desc: 'Declares file compatibility format and player rules' };
      if (b.includes('mvhd')) return { role: 'Movie Master Header', desc: 'Master timescale, video length, and playback volume' };
      if (b.includes('moov')) return { role: 'Timeline & Index', desc: 'Blueprint of all audio/video frames and synchronization' };
      if (b.includes('trak')) return { role: 'Media Track', desc: 'Dedicated stream channel for Video, Audio, or Subtitles' };
      if (b.includes('mdat')) return { role: 'Raw Media Payload', desc: 'The actual heavy audio sound waves and compressed video pictures' };
      if (b.includes('fmt')) return { role: 'Audio Format Spec', desc: 'Defines sample rate (Hz), channels (Stereo/Mono), and bit depth' };
      if (b.includes('data')) return { role: 'Raw Audio Payload', desc: 'Uncompressed audio sound samples' };
      if (b.includes('bext')) return { role: 'Studio Broadcast Header', desc: 'Microphone hardware, recording timestamp, and sound history' };
      if (b.includes('id3')) return { role: 'ID3 Tag Container', desc: 'Stores song title, artist name, and album artwork' };
      if (b.includes('ihdr')) return { role: 'Image Header', desc: 'Width, height, bit depth, and color type' };
      if (b.includes('idat')) return { role: 'Compressed Image Payload', desc: 'The actual compressed graphic pixels' };
      return { role: 'Structural Container Box', desc: origDesc || 'Container block' };
    }

    if (atomTreeWrapper) {
      atomTreeWrapper.innerHTML = '';
      if (containerTree.length === 0) {
        atomTreeWrapper.innerHTML = `<p style="color:var(--text-dim); text-align:center;">No structural atom/chunk tree parsed for this format.</p>`;
      } else {
        containerTree.forEach(item => {
          const div = document.createElement('div');
          div.className = 'atom-node';
          const sizeKb = (item.size / 1024).toFixed(2);
          const fInfo = getFriendlyAtomDesc(item.box, item.desc);
          div.innerHTML = `
            <div class="atom-left">
              <span class="atom-pill">${escapeHtml(item.box)}</span>
              <div class="atom-desc-group">
                <span class="atom-role">${escapeHtml(fInfo.role)}</span>
                <span class="atom-desc">${escapeHtml(fInfo.desc)}</span>
              </div>
            </div>
            <div class="atom-right">
              <span>Offset: 0x${item.offset.toString(16).toUpperCase()} (${item.offset} B)</span>
              <span class="meta-pill">${sizeKb} KB</span>
            </div>
          `;
          atomTreeWrapper.appendChild(div);
        });
      }
    }

    // Tab 4: Populate Forensics & Binary Signatures
    if (forensicsGrid) {
      forensicsGrid.innerHTML = `
        <div class="forensic-card">
          <div class="forensic-card-header">
            <h4>SHA-256 Checksum Fingerprint</h4>
            <span class="forensic-badge">Digital DNA</span>
          </div>
          <p class="forensic-val" style="color:#67e8f9;">${forensics.sha256 || 'N/A'}</p>
          <div class="forensic-info-box">
            <strong>💡 What is this?</strong>
            <span>The file's permanent digital fingerprint. If even 1 single pixel, letter, or millisecond of audio is modified, this entire 64-character code changes. Proves whether a file was altered or is an authentic original.</span>
          </div>
        </div>
        <div class="forensic-card">
          <div class="forensic-card-header">
            <h4>Shannon Entropy (Randomness & Compression)</h4>
            <span class="forensic-badge">Packing Density</span>
          </div>
          <p class="forensic-val">${forensics.entropy || 'N/A'}</p>
          <div class="forensic-info-box">
            <strong>💡 What is this?</strong>
            <span>Measures how compressed or scrambled data is (scale: 0 to 8). Plain text / uncompressed audio scores low (3–6); compressed videos or encrypted files score high (7.8–8.0).</span>
          </div>
        </div>
        <div class="forensic-card">
          <div class="forensic-card-header">
            <h4>Detected MIME Type</h4>
            <span class="forensic-badge">True Format</span>
          </div>
          <p class="forensic-val" style="color:#f59e0b;">${forensics.mime_detected || 'application/octet-stream'}</p>
          <div class="forensic-info-box">
            <strong>💡 What is this?</strong>
            <span>The true identity of the file detected from its internal code, even if someone renames the file extension to deceive the system.</span>
          </div>
        </div>
        <div class="forensic-card">
          <div class="forensic-card-header">
            <h4>Exact File Size</h4>
            <span class="forensic-badge">Byte Count</span>
          </div>
          <p class="forensic-val">${parseInt(format.size || 0).toLocaleString()} bytes (${forensics.file_size_formatted || ''})</p>
          <div class="forensic-info-box">
            <strong>💡 What is this?</strong>
            <span>The exact byte-for-byte storage footprint of this file on disk down to the single byte.</span>
          </div>
        </div>
        <div class="forensic-card" style="grid-column: 1 / -1;">
          <div class="forensic-card-header">
            <h4>Magic Bytes Hex & ASCII Dump (First 32 Bytes)</h4>
            <span class="forensic-badge">Binary Signature</span>
          </div>
          <pre class="hex-dump-pre"><code>HEX:   ${forensics.magic_hex || ''}\nASCII: ${forensics.magic_ascii || ''}</code></pre>
          <div class="forensic-info-box">
            <strong>💡 What is this?</strong>
            <span>The file's internal "passport" stamped at byte 0. Operating systems read this specific header sequence to know what program can safely open the file.</span>
          </div>
        </div>
      `;
    }

    // Tab: Populate Tamper & Modification History
    if (tamperContainer) {
      const tamper = data.tamper_analysis || {};
      const orig = tamper.original_data || {};
      const mod = tamper.modified_data || {};
      const ai = tamper.ai_detection || {};
      const anomalies = tamper.anomalies || [];
      const trail = tamper.audit_trail || [];

      tamperContainer.innerHTML = `
        <!-- Verdict Banner -->
        <div class="tamper-verdict-card" style="border-left: 4px solid ${tamper.badge_color || '#10b981'};">
          <div class="tamper-verdict-header">
            <span class="tamper-badge" style="background:${tamper.badge_color || '#10b981'}20; color:${tamper.badge_color || '#10b981'}; border:1px solid ${tamper.badge_color || '#10b981'}50;">
              ${escapeHtml(tamper.verdict_label || 'Untouched Original')}
            </span>
            <span class="tamper-risk-pill risk-${(tamper.risk_level || 'low').toLowerCase()}">
              Risk: ${escapeHtml(tamper.risk_level || 'LOW')}
            </span>
          </div>
          <p class="tamper-summary-text">${escapeHtml(tamper.summary || 'No metadata modifications detected.')}</p>
        </div>

        <!-- Side-by-Side: Original (Pehla Data) vs Modified (Jo Modify Hua) -->
        <div class="tamper-comparison-grid">
          <!-- Left: Pehla Data (Original / Native) -->
          <div class="tamper-card tamper-card-original">
            <div class="tamper-card-header">
              <span class="tamper-card-icon">🕒</span>
              <h4>Original State (as first recorded)</h4>
              <span class="tamper-card-tag tag-orig">Original</span>
            </div>
            <div class="tamper-kv-list">
              <div class="tamper-kv"><span class="tk-label">Original Device:</span><span class="tk-val tk-orig" style="color:${devInfo.badge_color || '#10b981'}; font-weight:700;">${devInfo.hardware_icon || '📱'} ${escapeHtml(devInfo.device_name || orig.device_or_camera || 'Native Recorder')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Device No. / Model:</span><span class="tk-val" style="font-weight:600; color:#38bdf8;">🏷️ ${escapeHtml(devInfo.device_no || devInfo.model_no || 'Not Embedded')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Hardware Serial No:</span><span class="tk-val">🔢 ${escapeHtml(devInfo.serial_no || devInfo.serial || 'Not Stamped / Privacy Protected')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Hardware Type:</span><span class="tk-val">${escapeHtml(devInfo.hardware_type || orig.hardware_type || 'Hardware Device')}</span></div>
              ${devInfo.lens ? `<div class="tamper-kv"><span class="tk-label">Optics / Lens:</span><span class="tk-val">🔍 ${escapeHtml(devInfo.lens)}</span></div>` : ''}
              <div class="tamper-kv"><span class="tk-label">Creation Date:</span><span class="tk-val tk-orig">${escapeHtml(orig.created_at || 'N/A')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Firmware / Native Tool:</span><span class="tk-val">${escapeHtml(orig.origin_software || 'Camera Hardware')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Hardware Tag Status:</span><span class="tk-val">${escapeHtml(devInfo.confidence || 'Detected')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Initial Container:</span><span class="tk-val">${escapeHtml(format.format_name || 'Native Stream')}</span></div>
            </div>
          </div>

          <!-- Right: Jo Modify Hua (Modified State) -->
          <div class="tamper-card tamper-card-modified">
            <div class="tamper-card-header">
              <span class="tamper-card-icon">✏️</span>
              <h4>Modified State (what changed since)</h4>
              <span class="tamper-card-tag tag-mod">Altered</span>
            </div>
            <div class="tamper-kv-list">
              <div class="tamper-kv"><span class="tk-label">Modification Date:</span><span class="tk-val tk-mod">${escapeHtml(mod.modified_at || 'Not Modified')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Modifying Software:</span><span class="tk-val tk-agent">${escapeHtml(mod.modifying_software || 'None Detected')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Time Elapsed:</span><span class="tk-val">${escapeHtml(mod.time_elapsed || 'None')}</span></div>
              <div class="tamper-kv"><span class="tk-label">Detected Changes:</span><span class="tk-val">${escapeHtml(mod.detected_changes || 'None')}</span></div>
            </div>
          </div>
        </div>

        ${ai.is_ai ? `
        <!-- AI Footprints Recovered -->
        <div class="tamper-ai-card">
          <div class="tamper-card-header">
            <span class="tamper-card-icon">🤖</span>
            <h4>AI Generation Parameters Recovered</h4>
            <span class="tamper-card-tag tag-ai">Synthetic Media</span>
          </div>
          ${ai.prompt ? `<div class="ai-param-block"><strong>Embedded AI Prompt:</strong><pre>${escapeHtml(ai.prompt)}</pre></div>` : ''}
          ${ai.parameters ? `<div class="ai-param-block"><strong>Model / Sampler Parameters:</strong><pre>${escapeHtml(ai.parameters)}</pre></div>` : ''}
        </div>
        ` : ''}

        <!-- Audit Trail Timeline -->
        <div class="tamper-audit-section">
          <h4>📜 Chronological Edit History & Audit Trail</h4>
          ${trail.length === 0 ? `
            <p class="tamper-empty-msg">No multi-step history logs found in this file's metadata.</p>
          ` : `
            <div class="tamper-timeline">
              ${trail.map(t => `
                <div class="timeline-step">
                  <div class="timeline-dot"></div>
                  <div class="timeline-content">
                    <div class="timeline-top">
                      <span class="timeline-step-num">Step #${t.step}</span>
                      <span class="timeline-action">${escapeHtml(t.action)}</span>
                      <span class="timeline-time">${escapeHtml(t.timestamp)}</span>
                    </div>
                    <div class="timeline-agent">
                      <strong>Tool / Agent:</strong> ${escapeHtml(t.software)}
                      ${t.changed ? `<span class="timeline-changed">(${escapeHtml(t.changed)})</span>` : ''}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <!-- Forensic Anomalies Alert List -->
        ${anomalies.length > 0 ? `
        <div class="tamper-anomalies-section">
          <h4>⚠️ Detected Forensic Anomalies & Red Flags</h4>
          <ul class="tamper-anomalies-list">
            ${anomalies.map(a => `<li>${escapeHtml(a)}</li>`).join('')}
          </ul>
        </div>
        ` : ''}
      `;
    }

    // Tab 5: Populate Raw JSON
    if (rawJsonText) {
      rawJsonText.textContent = JSON.stringify(data, null, 2);
    }
  }

  // 3. Setup Synchronized Video Preview (if video file)
  function setupVideoPreview(file) {
    const isVideo = ffprobeData && ffprobeData.streams
      ? ffprobeData.streams.some(s => s.codec_type === 'video')
      : file.type.includes('video');
    if (isVideo) {
      const videoUrl = URL.createObjectURL(file);
      previewVideo.src = videoUrl;
      previewVideo.muted = true;
      previewVideo.defaultMuted = true;
      previewVideo.volume = 0;
      videoContainer.style.display = 'flex';
      videoExportBox.style.display = 'flex';
    } else {
      videoContainer.style.display = 'none';
      videoExportBox.style.display = 'none';
    }
  }

  // 4. Render 9 Component Mixer Strips
  function renderMixerStrips(defs, energyStats) {
    mixerGrid.innerHTML = '';

    defs.forEach(def => {
      const strip = document.createElement('div');
      strip.className = 'channel-strip';
      if (def.id === 'bg_voice') {
        strip.classList.add('highlight-strip'); // Special highlight for background people
      }

      const detectedPct = (energyStats[def.id] || 0).toFixed(1);

      strip.innerHTML = `
        <div class="strip-top-indicator" style="background-color: ${def.color};"></div>
        <div class="strip-header">
          <span class="strip-icon">${def.icon}</span>
          <div class="strip-name">${def.name}</div>
          <div class="strip-energy">${detectedPct}% Energy</div>
        </div>
        <div class="strip-buttons">
          <button class="btn-mute" id="mute_${def.id}" title="Mute (M)">M</button>
          <button class="btn-solo" id="solo_${def.id}" title="Solo (S)">S</button>
        </div>
        <div class="fader-wrapper">
          <input type="range" class="vertical-slider" id="fader_${def.id}" min="-40" max="12" value="0" step="0.5">
        </div>
        <div class="strip-db-readout" id="db_${def.id}">0.0 dB</div>
      `;

      mixerGrid.appendChild(strip);

      // Wire fader slider
      const fader = strip.querySelector(`#fader_${def.id}`);
      const dbLabel = strip.querySelector(`#db_${def.id}`);
      fader.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        dbLabel.textContent = val <= -40 ? '-INF' : (val > 0 ? `+${val.toFixed(1)} dB` : `${val.toFixed(1)} dB`);
        audioEngine.setStemGain(def.id, val);
        updateLiveVoiceMonitor();
        updateFinalStatusDashboard();
        updateProcessedWaveformPreviewDebounced();
      });

      // Wire Mute button
      const btnMute = strip.querySelector(`#mute_${def.id}`);
      btnMute.addEventListener('click', () => {
        const isMuted = !btnMute.classList.contains('active');
        btnMute.classList.toggle('active', isMuted);
        audioEngine.setStemMute(def.id, isMuted);
        updateLiveVoiceMonitor();
        updateFinalStatusDashboard();
        updateProcessedWaveformPreviewDebounced();
      });

      // Wire Solo button
      const btnSolo = strip.querySelector(`#solo_${def.id}`);
      btnSolo.addEventListener('click', () => {
        const isSoloed = !btnSolo.classList.contains('active');
        btnSolo.classList.toggle('active', isSoloed);
        audioEngine.setStemSolo(def.id, isSoloed);
        updateLiveVoiceMonitor();
        updateFinalStatusDashboard();
        updateProcessedWaveformPreviewDebounced();
      });
    });
  }

  function syncPresetUi(presetName) {
    presetButtons.forEach(btn => {
      btn.classList.toggle('active-preset', btn.dataset.preset === presetName);
    });

    // Update mixer strip fader positions and db labels from audio engine state
    audioEngine.componentDefs.forEach(def => {
      const fader = document.getElementById(`fader_${def.id}`);
      const dbLabel = document.getElementById(`db_${def.id}`);
      const muteBtn = document.getElementById(`mute_${def.id}`);
      const soloBtn = document.getElementById(`solo_${def.id}`);

      if (fader && dbLabel) {
        const linearGain = audioEngine.stemValues[def.id] || 1.0;
        const db = linearGain <= 0 ? -40 : Math.round(20 * Math.log10(linearGain) * 10) / 10;
        fader.value = db;
        dbLabel.textContent = db <= -40 ? '-INF' : (db > 0 ? `+${db.toFixed(1)} dB` : `${db.toFixed(1)} dB`);
      }

      if (muteBtn) muteBtn.classList.toggle('active', audioEngine.stemMutes[def.id] || false);
      if (soloBtn) soloBtn.classList.toggle('active', audioEngine.stemSolos[def.id] || false);
    });

    updateLiveVoiceMonitor();
    updateFinalStatusDashboard();
  }

  // Preset Buttons
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      audioEngine.applyPreset(preset);
      syncPresetUi(preset);
      updateProcessedWaveformPreviewDebounced();
    });
  });

  // 5. Macro Controls Wiring
  slNoiseReduction.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    lblNoiseReduction.textContent = `${val}%`;
    audioEngine.applyMacros(val, parseInt(slVoiceBoost.value), parseInt(slBgPreserve.value));
    syncMixerUiFromEngine();
    updateLiveVoiceMonitor();
    updateFinalStatusDashboard();
    updateProcessedWaveformPreviewDebounced();
  });

  slVoiceBoost.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    lblVoiceBoost.textContent = `${val}%`;
    audioEngine.applyMacros(parseInt(slNoiseReduction.value), val, parseInt(slBgPreserve.value));
    syncMixerUiFromEngine();
    updateLiveVoiceMonitor();
    updateFinalStatusDashboard();
    updateProcessedWaveformPreviewDebounced();
  });

  slBgPreserve.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    lblBgPreserve.textContent = `${val}%`;
    audioEngine.applyMacros(parseInt(slNoiseReduction.value), parseInt(slVoiceBoost.value), val);
    syncMixerUiFromEngine();
    updateLiveVoiceMonitor();
    updateFinalStatusDashboard();
    updateProcessedWaveformPreviewDebounced();
  });

  const hintMasterVol = document.getElementById('hintMasterVol');
  slMasterVol.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    lblMasterVol.textContent = val > 0 ? `+${val.toFixed(1)} dB` : `${val.toFixed(1)} dB`;
    audioEngine.setMasterVolume(val);
    document.querySelectorAll('#groupBoost .btn-segmented').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.boost) === val));
    if (hintMasterVol) hintMasterVol.textContent = val > 12
      ? 'Very loud. Background noise and hiss get louder too, so lower the "Remove background noise" setting only if the voice sounds thin.'
      : 'Makes everything louder, up to +30 dB. A limiter stops it from distorting.';
  });
  document.querySelectorAll('#groupBoost .btn-segmented').forEach(btn => btn.addEventListener('click', () => {
    slMasterVol.value = btn.dataset.boost;
    slMasterVol.dispatchEvent(new Event('input', { bubbles: true }));
  }));

  function syncMixerUiFromEngine() {
    audioEngine.componentDefs.forEach(def => {
      const fader = document.getElementById(`fader_${def.id}`);
      const dbLabel = document.getElementById(`db_${def.id}`);
      if (fader && dbLabel) {
        const linearGain = audioEngine.stemValues[def.id] || 1.0;
        const db = linearGain <= 0 ? -40 : Math.round(20 * Math.log10(linearGain) * 10) / 10;
        fader.value = db;
        dbLabel.textContent = db <= -40 ? '-INF' : (db > 0 ? `+${db.toFixed(1)} dB` : `${db.toFixed(1)} dB`);
      }
    });
  }

  // EQ Wiring
  const updateEq = () => {
    const l = parseFloat(eqLow.value);
    const m = parseFloat(eqMid.value);
    const h = parseFloat(eqHigh.value);
    lblEqLow.textContent = `${l > 0 ? '+' : ''}${l} dB`;
    lblEqMid.textContent = `${m > 0 ? '+' : ''}${m} dB`;
    lblEqHigh.textContent = `${h > 0 ? '+' : ''}${h} dB`;
    audioEngine.setEQ(l, m, h);
  };
  eqLow.addEventListener('input', updateEq);
  eqMid.addEventListener('input', updateEq);
  eqHigh.addEventListener('input', updateEq);

  // Dynamics Compressor Wiring
  const updateComp = () => {
    const thresh = parseFloat(compThreshold.value);
    const ratio = parseFloat(compRatio.value);
    lblCompThreshold.textContent = `${thresh} dB`;
    lblCompRatio.textContent = `${ratio.toFixed(1)}:1`;
    audioEngine.setCompressor(thresh, ratio);
  };
  compThreshold.addEventListener('input', updateComp);
  compRatio.addEventListener('input', updateComp);

  // ==========================================================================
  // Theme Switching Management (Obsidian, Sapphire, Cyber, Amber)
  // ==========================================================================
  const themeMap = {
    dark: { icon: '🌙', name: 'Dark' },
    obsidian: { icon: '🌙', name: 'Dark' },
    light: { icon: '☀️', name: 'Light' }
  };

  function applyTheme(themeKey) {
    const isLight = themeKey === 'light';
    const normalized = isLight ? 'light' : 'dark';

    // Set attributes on both <html> and <body> for 100% reliable CSS selector matching
    document.documentElement.setAttribute('data-theme', normalized);
    document.body.setAttribute('data-theme', normalized);

    // Sync classes
    document.body.classList.remove('dark-theme', 'light-theme');
    document.body.classList.add(isLight ? 'light-theme' : 'dark-theme');

    if (currentThemeIcon) currentThemeIcon.textContent = themeMap[normalized].icon;
    if (currentThemeName) currentThemeName.textContent = themeMap[normalized].name;

    if (themeOpts) {
      themeOpts.forEach(opt => {
        const optIsLight = opt.dataset.theme === 'light';
        opt.classList.toggle('active', optIsLight === isLight);
      });
    }

    localStorage.setItem('filelens_theme', normalized);

    if (window.spectrogram && window.spectrogram.audioBuffer) {
      window.spectrogram.renderWaveform();
    }
  }

  const savedTheme = localStorage.getItem('filelens_theme') || localStorage.getItem('spectraclean_theme') || 'dark';
  applyTheme(savedTheme);

  if (btnThemeToggle && themeDropdown) {
    btnThemeToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = themeDropdown.style.display === 'none' || !themeDropdown.style.display;
      themeDropdown.style.display = isHidden ? 'flex' : 'none';
    });

    document.addEventListener('click', (e) => {
      if (themeSelectorWrap && !themeSelectorWrap.contains(e.target)) {
        themeDropdown.style.display = 'none';
      }
    });

    if (themeOpts) {
      themeOpts.forEach(opt => {
        opt.addEventListener('click', () => {
          const newTheme = opt.dataset.theme === 'light' ? 'light' : 'dark';
          applyTheme(newTheme);
          themeDropdown.style.display = 'none';
          showToast(`🎨 Switched to ${themeMap[newTheme].name} mode`, 'info', 2000);
        });
      });
    }
  }

  // ==========================================================================
  // Workflow Complexity Toggle (Quick Clean vs Pro Studio)
  // ==========================================================================
  function setWorkflowMode(mode) {
    const isQuick = mode === 'quick';
    document.body.classList.toggle('wf-quick', isQuick);
    if (btnWfQuick) btnWfQuick.classList.toggle('active', isQuick);
    if (btnWfPro) btnWfPro.classList.toggle('active', !isQuick);
    localStorage.setItem('filelens_workflow', mode);
  }

  if (btnWfQuick) btnWfQuick.addEventListener('click', () => setWorkflowMode('quick'));
  if (btnWfPro) btnWfPro.addEventListener('click', () => setWorkflowMode('pro'));

  const savedWf = localStorage.getItem('filelens_workflow') || localStorage.getItem('spectraclean_workflow') || 'quick';
  setWorkflowMode(savedWf);

  // ==========================================================================
  // ✨ 1-Click Auto Clean
  // ==========================================================================
  function applyAutoCleanUi(announce) {
    audioEngine.applyAutoClean();

    // Synchronize Macro Sliders
    if (slNoiseReduction) { slNoiseReduction.value = 85; lblNoiseReduction.textContent = '85%'; }
    if (slVoiceBoost) { slVoiceBoost.value = 35; lblVoiceBoost.textContent = '35%'; }
    if (slBgPreserve) { slBgPreserve.value = 100; lblBgPreserve.textContent = '100%'; }

    // Synchronize Pro DSP Rack
    if (slDeReverb) { slDeReverb.value = 20; lblDeReverb.textContent = '20%'; }
    if (slDeEsser) { slDeEsser.value = 25; lblDeEsser.textContent = '25%'; }
    if (eqLow) { eqLow.value = 0; lblEqLow.textContent = '0 dB'; }
    if (eqMid) { eqMid.value = 1.5; lblEqMid.textContent = '+1.5 dB'; }
    if (eqHigh) { eqHigh.value = 0.5; lblEqHigh.textContent = '+0.5 dB'; }

    if (groupDeHum) {
      groupDeHum.querySelectorAll('.btn-segmented').forEach(b => {
        b.classList.toggle('active', b.dataset.dehum === '60hz');
      });
      if (lblDeHum) lblDeHum.textContent = '60 Hz (Active)';
    }

    if (groupHighPass) {
      groupHighPass.querySelectorAll('.btn-segmented').forEach(b => {
        b.classList.toggle('active', b.dataset.hp === '40');
      });
      if (lblHighPass) lblHighPass.textContent = '40 Hz (Standard)';
    }

    syncPresetUi('cafe_preserve_voices');
    syncMixerUiFromEngine();
    updateLiveVoiceMonitor();
    updateFinalStatusDashboard();
    updateProcessedWaveformPreviewDebounced();
    if (announce) {
  showToast("✨ 1-Click Auto Clean applied: Speech clarity boosted, noise removed & background voices preserved!", "success", 4000);
    }
  }

  if (btnAutoClean) {
    btnAutoClean.addEventListener('click', () => applyAutoCleanUi(true));
  }

  // ==========================================================================
  // Pro Audio Enhancements Rack Listeners
  // ==========================================================================
  if (slDeReverb) {
    slDeReverb.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      lblDeReverb.textContent = `${val}%`;
      audioEngine.setDeReverb(val);
      syncMixerUiFromEngine();
      updateFinalStatusDashboard();
      updateProcessedWaveformPreviewDebounced();
    });
  }

  if (slDeEsser) {
    slDeEsser.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      lblDeEsser.textContent = `${val}%`;
      audioEngine.setDeEsser(val);
      updateFinalStatusDashboard();
      updateProcessedWaveformPreviewDebounced();
    });
  }

  if (groupDeHum) {
    groupDeHum.querySelectorAll('.btn-segmented').forEach(btn => {
      btn.addEventListener('click', () => {
        groupDeHum.querySelectorAll('.btn-segmented').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.dehum;
        if (lblDeHum) {
          lblDeHum.textContent = mode === 'off' ? 'Off' : (mode === '50hz' ? '50 Hz (Active)' : '60 Hz (Active)');
        }
        audioEngine.setDeHum(mode);
        updateFinalStatusDashboard();
        updateProcessedWaveformPreviewDebounced();
      });
    });
  }

  if (groupHighPass) {
    groupHighPass.querySelectorAll('.btn-segmented').forEach(btn => {
      btn.addEventListener('click', () => {
        groupHighPass.querySelectorAll('.btn-segmented').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const hp = parseInt(btn.dataset.hp);
        if (lblHighPass) {
          lblHighPass.textContent = hp === 20 ? 'Off (20 Hz)' : `${hp} Hz`;
        }
        audioEngine.setHighPassFilter(hp);
        updateFinalStatusDashboard();
        updateProcessedWaveformPreviewDebounced();
      });
    });
  }

  if (selCleanAlgorithm) {
    selCleanAlgorithm.addEventListener('change', (e) => {
      audioEngine.setCleanAlgorithm(e.target.value);
      showToast(`🧠 Switched AI Profile: ${e.target.options[e.target.selectedIndex].text}`, 'info', 3000);
    });
  }

  // 6. Visualizer Tabs & A/B Switching
  vizTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      vizTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      if (view === 'waveform') {
        waveformWrapper.style.display = 'block';
        spectrogramWrapper.style.display = 'none';
      } else if (view === 'spectrogram') {
        waveformWrapper.style.display = 'none';
        spectrogramWrapper.style.display = 'block';
      } else {
        waveformWrapper.style.display = 'block';
        spectrogramWrapper.style.display = 'block';
      }
    });
  });

  // Spectrogram Comparison Mode Switcher
  btnSpecModes.forEach(btn => {
    btn.addEventListener('click', () => {
      btnSpecModes.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      visualizer.setSpecViewMode(mode);
      if (specCanvasLabel) {
        if (mode === 'cleaned') specCanvasLabel.textContent = 'STFT Frequency Spectrogram (20 Hz - 22 kHz) — Final Cleaned (Active Mix)';
        else if (mode === 'split') specCanvasLabel.textContent = 'STFT Frequency Spectrogram (20 Hz - 22 kHz) — Split Compare (Left: Raw | Right: Cleaned)';
        else if (mode === 'original') specCanvasLabel.textContent = 'STFT Frequency Spectrogram (20 Hz - 22 kHz) — Raw Original (Unprocessed)';
        else if (mode === 'delta') specCanvasLabel.textContent = 'STFT Frequency Spectrogram (20 Hz - 22 kHz) — Removed Noise & Frequency Delta';
      }
    });
  });

  btnAbOriginal.addEventListener('click', () => {
    btnAbOriginal.classList.add('active');
    btnAbCleaned.classList.remove('active');
    audioEngine.setPlaybackMode('original');
    updateFinalStatusDashboard();
  });

  btnAbCleaned.addEventListener('click', () => {
    btnAbCleaned.classList.add('active');
    btnAbOriginal.classList.remove('active');
    audioEngine.setPlaybackMode('cleaned');
    updateFinalStatusDashboard();
  });

  // 7. Transport Controls (Play, Pause, Stop, Seek, Timecode)
  btnPlayPause.addEventListener('click', togglePlayPause);
  btnStop.addEventListener('click', stopPlayback);

  btnLoop.addEventListener('click', () => {
    audioEngine.isLooping = !audioEngine.isLooping;
    btnLoop.classList.toggle('active', audioEngine.isLooping);
  });

  let scrubberRaf = null;
  timelineScrubber.addEventListener('input', (e) => {
    const total = totalDuration();
    if (!(total > 0)) return;
    const target = (parseFloat(e.target.value) / 100) * total;
    const off = windowOffset(), len = audioEngine.getDuration();
    if (currentTimeDisplay) currentTimeDisplay.textContent = formatTime(target);
    // Inside the loaded part: seek live while dragging. Outside it: wait until the slider is released.
    if (!audioEngine.isExcerpt || (target >= off && target < off + len - 0.05)) {
      if (!scrubberRaf) {
        scrubberRaf = requestAnimationFrame(() => {
          scrubberRaf = null;
          seekGlobal(target, false);
        });
      }
    }
  });
  timelineScrubber.addEventListener('change', (e) => {
    const total = totalDuration();
    if (!(total > 0) || studioState !== 'ready') return;
    const target = (parseFloat(e.target.value) / 100) * total;
    const off = windowOffset(), len = audioEngine.getDuration();
    if (audioEngine.isExcerpt && (target < off || target >= off + len - 0.05)) seekGlobal(target, audioEngine.isPlaying);
  });

  // ---- Rewind / fast-forward -------------------------------------------------------------------
  function jumpTo(t) {
    if (studioState !== 'ready') return;
    seekGlobal(t, audioEngine.isPlaying);
  }
  function skipBy(delta) {
    if (!audioEngine.originalBuffer) return;
    jumpTo(windowOffset() + audioEngine.getCurrentTime() + delta);
  }

  // Click = jump 10 s. Press and hold = scan quickly (about 16x) until released.
  function wireSkipButton(btn, direction) {
    let holdTimer = null, scanTimer = null, scanning = false;
    const stop = () => { clearTimeout(holdTimer); clearInterval(scanTimer); holdTimer = scanTimer = null; };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      scanning = false;
      holdTimer = setTimeout(() => { scanning = true; scanTimer = setInterval(() => skipBy(direction * 2), 120); }, 350);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
    btn.addEventListener('click', (e) => { if (scanning) { scanning = false; e.preventDefault(); return; } skipBy(direction * 10); });
  }
  const btnBack = document.getElementById('btnBack'), btnForward = document.getElementById('btnForward');
  if (btnBack) wireSkipButton(btnBack, -1);
  if (btnForward) wireSkipButton(btnForward, 1);

  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      togglePlayPause();
      return;
    }
    // arrow keys: only in the cleaning studio, and never while typing or using a slider / menu
    if (currentWorkspaceView !== 'studio' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowLeft') { e.preventDefault(); skipBy(-step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); skipBy(step); }
    else if (e.key === 'j' || e.key === 'J') { e.preventDefault(); skipBy(-10); }
    else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); skipBy(10); }
  });

  function togglePlayPause() {
    if (originalPlayer && !originalPlayer.paused && !audioEngine.isPlaying) originalPlayer.pause();
    if (!audioEngine.originalBuffer) {
      showToast("Please upload an audio/video file first or load a demo!", "warning", 3000);
      return;
    }

    if (audioEngine.isPlaying) {
      audioEngine.pause();
      if (previewVideo) {
        try { previewVideo.pause(); } catch (e) {}
      }
      setPlayButtonState(false);
      cancelAnimationFrame(animationFrameId);
    } else {
      audioEngine.play();
      if (previewVideo && currentFile && currentFile.type.includes('video')) {
        previewVideo.currentTime = audioEngine.getCurrentTime() + (audioEngine.excerptStart || 0);
        try { previewVideo.play(); } catch (e) {}
      }
      setPlayButtonState(true);
      startTransportAnimation();
    }
  }

  function stopPlayback() {
    audioEngine.stop();
    if (previewVideo) {
      try {
        previewVideo.pause();
        previewVideo.currentTime = audioEngine.excerptStart || 0;
      } catch (e) {}
    }
    setPlayButtonState(false);
    cancelAnimationFrame(animationFrameId);
    refreshTransport();
    visualizer.updatePlayhead(0);
    if (vuMeterBar) vuMeterBar.style.width = '0%';
    if (vuDbReadout) vuDbReadout.textContent = '-INF dB';
  }

  function setPlayButtonState(isPlaying) {
    playIcon.style.display = isPlaying ? 'none' : 'block';
    pauseIcon.style.display = isPlaying ? 'block' : 'none';
  }

  function startTransportAnimation() {
    cancelAnimationFrame(animationFrameId);
    const tick = () => {
      if (audioEngine.isPlaying) {
        const curTime = audioEngine.getCurrentTime();
        const duration = audioEngine.getDuration();
        refreshTransport();

        if (duration > 0) {
          visualizer.updatePlayhead(curTime);

          // Keep video in sync with audio
          if (previewVideo && currentFile && currentFile.type.includes('video')) {
            if (Math.abs(previewVideo.currentTime - (curTime + (audioEngine.excerptStart || 0))) > 0.08) {
              previewVideo.currentTime = curTime + (audioEngine.excerptStart || 0);
            }
          }
        }

        // Live Output VU Meter animation
        const levels = audioEngine.getLiveAudioLevels();
        if (levels.isPlaying && levels.peakDb > -60) {
          const pct = Math.max(0, Math.min(100, ((levels.peakDb + 60) / 60) * 100));
          if (vuMeterBar) vuMeterBar.style.width = `${pct}%`;
          if (vuDbReadout) vuDbReadout.textContent = `${levels.peakDb.toFixed(1)} dB`;
        } else {
          if (vuMeterBar) vuMeterBar.style.width = '0%';
          if (vuDbReadout) vuDbReadout.textContent = '-INF dB';
        }

        animationFrameId = requestAnimationFrame(tick);
      }
    };
    animationFrameId = requestAnimationFrame(tick);
  }

  audioEngine.onPlaybackEnd = async () => {
    // Long recording: when the previewed part ends, load the next part and keep playing,
    // so the whole recording can be listened to from start to finish.
    const full = audioEngine.fullBuffer;
    if (audioEngine.isExcerpt && full && !audioEngine.isLooping) {
      const nextStart = audioEngine.excerptStart + audioEngine.originalBuffer.duration;
      if (nextStart < full.duration - 0.5) {
        showToast('Loading the next part of the recording…', 'info', 2500);
        await previewFrom(nextStart);
        if (studioState === 'ready') togglePlayPause();
        return;
      }
    }
    stopPlayback();
  };

  // Debounced processed waveform preview update
  let previewTimeout = null;
  function updateProcessedWaveformPreviewDebounced() {
    clearTimeout(previewTimeout);
    updateFinalStatusDashboard();
    previewTimeout = setTimeout(() => {
      updateProcessedWaveformPreview();
    }, 450);
  }

  async function updateProcessedWaveformPreview() {
    try {
      const rendered = await audioEngine.renderCleanedAudioBuffer();
      visualizer.setProcessedBuffer(rendered);
      updateFinalStatusDashboard();
    } catch (e) {
      console.warn("Waveform preview update deferred:", e);
    }
  }

  // Real-Time Live Voice Monitor & Isolation HUD Updater
  function updateLiveVoiceMonitor() {
    const mainLin = audioEngine.stemValues['main_voice'] !== undefined ? audioEngine.stemValues['main_voice'] : 1.0;
    const bgLin = audioEngine.stemValues['bg_voice'] !== undefined ? audioEngine.stemValues['bg_voice'] : 1.0;
    const isMainMuted = audioEngine.stemMutes['main_voice'] || false;
    const isMainSolo = audioEngine.stemSolos['main_voice'] || false;
    const isBgMuted = audioEngine.stemMutes['bg_voice'] || false;
    const isBgSolo = audioEngine.stemSolos['bg_voice'] || false;

    const mainDb = mainLin <= 0 ? -40 : Math.round(20 * Math.log10(mainLin) * 10) / 10;
    const bgDb = bgLin <= 0 ? -40 : Math.round(20 * Math.log10(bgLin) * 10) / 10;

    // 1. Update Main Voice Column
    if (lvmMainDb) {
      if (isMainMuted) {
        lvmMainDb.textContent = 'MUTED (OFF)';
        lvmMainDb.className = 'lvm-col-val val-coral';
      } else {
        lvmMainDb.textContent = `${mainDb > 0 ? '+' : ''}${mainDb.toFixed(1)} dB`;
        lvmMainDb.className = mainDb > 0 ? 'lvm-col-val val-emerald' : 'lvm-col-val val-cyan';
      }
    }
    if (lvmMainBar) {
      if (isMainMuted) {
        lvmMainBar.style.width = '0%';
      } else {
        const pct = Math.max(0, Math.min(100, ((mainDb + 40) / 52) * 100));
        lvmMainBar.style.width = `${pct}%`;
      }
    }
    if (lvmMainSub) {
      if (isMainMuted) {
        lvmMainSub.textContent = 'Main voice channel silenced';
      } else if (isMainSolo) {
        lvmMainSub.textContent = 'SOLO ACTIVE: Isolated foreground vocal';
      } else if (mainDb > 0.5) {
        const gainFactor = Math.round((mainLin - 1.0) * 100);
        lvmMainSub.textContent = `Vocal Formants Boosted (+${gainFactor}% presence)`;
      } else if (mainDb < -6) {
        lvmMainSub.textContent = 'Main voice attenuated';
      } else {
        lvmMainSub.textContent = 'Natural vocal level (0.0 dB)';
      }
    }

    // 2. Update Background Human Voices Column
    if (lvmBgDb) {
      if (isBgMuted) {
        lvmBgDb.textContent = 'MUTED (OFF)';
        lvmBgDb.className = 'lvm-col-val val-coral';
      } else if (bgDb >= -0.5) {
        lvmBgDb.textContent = `${bgDb.toFixed(1)} dB (100% ✅)`;
        lvmBgDb.className = 'lvm-col-val val-cyan';
      } else {
        const pct = Math.max(0, Math.min(100, Math.round(bgLin * 100)));
        lvmBgDb.textContent = `${bgDb.toFixed(1)} dB (${pct}%)`;
        lvmBgDb.className = 'lvm-col-val val-amber';
      }
    }
    if (lvmBgBar) {
      if (isBgMuted) {
        lvmBgBar.style.width = '0%';
      } else {
        const pct = Math.max(0, Math.min(100, bgLin * 100));
        lvmBgBar.style.width = `${pct}%`;
      }
    }
    if (lvmBgSub) {
      if (isBgMuted) {
        lvmBgSub.textContent = 'Secondary chatter muted';
      } else if (isBgSolo) {
        lvmBgSub.textContent = 'SOLO ACTIVE: Background people isolated';
      } else if (bgDb >= -0.5) {
        lvmBgSub.textContent = '100% Preserved: Ambient human speech protected ✅';
      } else {
        const cut = Math.round((1 - bgLin) * 100);
        lvmBgSub.textContent = `Partial reduction: -${cut}% ambient speech suppressed`;
      }
    }

    // 3. Update Voice vs Noise Dynamic Contrast (SNR)
    const trafficLin = audioEngine.stemValues['traffic'] !== undefined ? audioEngine.stemValues['traffic'] : 1.0;
    const fanLin = audioEngine.stemValues['fan_ac'] !== undefined ? audioEngine.stemValues['fan_ac'] : 1.0;
    const humLin = audioEngine.stemValues['hum'] !== undefined ? audioEngine.stemValues['hum'] : 1.0;
    const avgNoiseLin = (trafficLin + fanLin + humLin) / 3.0;

    const noiseDb = avgNoiseLin <= 0 ? -40 : Math.round(20 * Math.log10(avgNoiseLin) * 10) / 10;
    const snrDelta = Math.round((mainDb - noiseDb) * 10) / 10;

    if (lvmSnrDb) {
      lvmSnrDb.textContent = `+${Math.max(0, snrDelta).toFixed(1)} dB`;
    }
    if (lvmSnrBar) {
      const snrPct = Math.max(5, Math.min(100, (snrDelta / 45) * 100));
      lvmSnrBar.style.width = `${snrPct}%`;
    }
    if (lvmSnrSub) {
      if (snrDelta >= 25) {
        lvmSnrSub.textContent = 'High speech clarity: Traffic, fan & hum suppressed';
      } else if (snrDelta >= 10) {
        lvmSnrSub.textContent = 'Moderate clarity contrast above noise';
      } else {
        lvmSnrSub.textContent = 'Standard noise floor';
      }
    }

    // 4. Update Header Badge
    if (lvmStatusBadge) {
      if (isMainMuted) {
        lvmStatusBadge.textContent = '🔇 Main Speaker Muted';
        lvmStatusBadge.style.color = '#fca5a5';
        lvmStatusBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        lvmStatusBadge.style.background = 'rgba(239, 68, 68, 0.15)';
      } else if (isMainSolo) {
        lvmStatusBadge.textContent = '⭐ Main Speaker Soloed';
        lvmStatusBadge.style.color = '#fde047';
        lvmStatusBadge.style.borderColor = 'rgba(234, 179, 8, 0.4)';
        lvmStatusBadge.style.background = 'rgba(234, 179, 8, 0.15)';
      } else if (mainDb > 0.5) {
        lvmStatusBadge.textContent = `🎙️ Main Voice Boosted (+${mainDb.toFixed(1)} dB)`;
        lvmStatusBadge.style.color = '#6ee7b7';
        lvmStatusBadge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        lvmStatusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
      } else {
        lvmStatusBadge.textContent = '🟢 Speech Formants Active & Balanced';
        lvmStatusBadge.style.color = '#67e8f9';
        lvmStatusBadge.style.borderColor = 'rgba(6, 182, 212, 0.4)';
        lvmStatusBadge.style.background = 'rgba(6, 182, 212, 0.15)';
      }
    }

    // 5. Update Visualizer Live State & Live Waveform instantly!
    if (visualizer) {
      visualizer.setVoiceState({
        mainDb,
        bgDb,
        isMainMuted,
        isMainSolo,
        isBgMuted,
        isBgSolo,
        voiceBoostPct: slVoiceBoost ? parseInt(slVoiceBoost.value) : 0,
        bgPreservePct: slBgPreserve ? parseInt(slBgPreserve.value) : 100
      });
      visualizer.updateLiveWaveform(audioEngine.stemValues, audioEngine.stemMutes, audioEngine.stemSolos);
    }
  }

  // Real-Time Final Mix & Impact Dashboard Updater
  function updateFinalStatusDashboard() {
    const isCleaned = audioEngine.playbackMode === 'cleaned';
    if (finalModeBadge) {
      finalModeBadge.textContent = isCleaned ? '🟢 Output: FINAL CLEANED AUDIO (Sliders Active)' : '🔴 Output: RAW ORIGINAL AUDIO (Bypassed)';
      finalModeBadge.style.color = isCleaned ? '#6ee7b7' : '#fda4af';
      finalModeBadge.style.borderColor = isCleaned ? 'rgba(16, 185, 129, 0.4)' : 'rgba(244, 63, 94, 0.4)';
      finalModeBadge.style.background = isCleaned ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)';
    }

    if (finalSummaryChips) {
      finalSummaryChips.innerHTML = '';
      audioEngine.componentDefs.forEach(def => {
        const linearGain = audioEngine.stemValues[def.id] !== undefined ? audioEngine.stemValues[def.id] : 1.0;
        const isMuted = audioEngine.stemMutes[def.id] || false;
        const isSolo = audioEngine.stemSolos[def.id] || false;
        const db = linearGain <= 0 ? -40 : Math.round(20 * Math.log10(linearGain) * 10) / 10;

        let statusClass = 'unity';
        let statusText = `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;

        if (isMuted) {
          statusClass = 'muted';
          statusText = 'MUTED (OFF)';
        } else if (isSolo) {
          statusClass = 'boosted';
          statusText = `SOLO (${db > 0 ? '+' : ''}${db.toFixed(1)} dB)`;
        } else if (def.id === 'bg_voice' && db >= -1) {
          statusClass = 'preserved';
          statusText = `${db.toFixed(1)} dB (100% PRESERVED ✅)`;
        } else if (db > 0.5) {
          statusClass = 'boosted';
          statusText = `+${db.toFixed(1)} dB (BOOSTED)`;
        } else if (db <= -6) {
          const cutPct = Math.min(99, Math.round((1 - linearGain) * 100));
          statusClass = 'reduced';
          statusText = `${db.toFixed(1)} dB (-${cutPct}% 🔻)`;
        }

        const chip = document.createElement('div');
        chip.className = 'summary-chip';
        chip.innerHTML = `
          <span>${def.icon}</span>
          <span class="chip-name">${escapeHtml(def.name)}:</span>
          <span class="chip-val ${statusClass}">${statusText}</span>
        `;
        finalSummaryChips.appendChild(chip);
      });

      // Pro DSP Rack Active Enhancements
      if (audioEngine.dspSettings.deHumEnabled) {
        const humChip = document.createElement('div');
        humChip.className = 'summary-chip';
        humChip.innerHTML = `
          <span>⚡</span>
          <span class="chip-name">De-Hum:</span>
          <span class="chip-val boosted">${audioEngine.dspSettings.deHumMode.toUpperCase()} Notch</span>
        `;
        finalSummaryChips.appendChild(humChip);
      }
      if (audioEngine.dspSettings.highPassFreq && audioEngine.dspSettings.highPassFreq > 20) {
        const hpChip = document.createElement('div');
        hpChip.className = 'summary-chip';
        hpChip.innerHTML = `
          <span>🌊</span>
          <span class="chip-name">High-Pass:</span>
          <span class="chip-val reduced">${audioEngine.dspSettings.highPassFreq} Hz Cut</span>
        `;
        finalSummaryChips.appendChild(hpChip);
      }
      if (audioEngine.dspSettings.deEsserAmount && audioEngine.dspSettings.deEsserAmount > 0) {
        const deChip = document.createElement('div');
        deChip.className = 'summary-chip';
        deChip.innerHTML = `
          <span>🎙️</span>
          <span class="chip-name">De-Esser:</span>
          <span class="chip-val reduced">${audioEngine.dspSettings.deEsserAmount}% Tamed</span>
        `;
        finalSummaryChips.appendChild(deChip);
      }
      if (audioEngine.dspSettings.deReverbAmount && audioEngine.dspSettings.deReverbAmount > 0) {
        const revChip = document.createElement('div');
        revChip.className = 'summary-chip';
        revChip.innerHTML = `
          <span>🏛️</span>
          <span class="chip-name">De-Reverb:</span>
          <span class="chip-val reduced">${audioEngine.dspSettings.deReverbAmount}% Dried</span>
        `;
        finalSummaryChips.appendChild(revChip);
      }
    }

    // High level metrics
    const trafficGain = audioEngine.stemValues.traffic !== undefined ? audioEngine.stemValues.traffic : 1.0;
    const fanGain = audioEngine.stemValues.fan_ac !== undefined ? audioEngine.stemValues.fan_ac : 1.0;
    const humGain = audioEngine.stemValues.hum !== undefined ? audioEngine.stemValues.hum : 1.0;
    const voiceGain = audioEngine.stemValues.main_voice !== undefined ? audioEngine.stemValues.main_voice : 1.0;
    const bgGain = audioEngine.stemValues.bg_voice !== undefined ? audioEngine.stemValues.bg_voice : 1.0;

    const avgNoiseLin = (trafficGain + fanGain + humGain) / 3;
    const noiseCutDb = avgNoiseLin > 0 ? (20 * Math.log10(avgNoiseLin)).toFixed(1) : '-40.0';
    const noiseCutPct = Math.max(0, Math.min(99, Math.round((1 - avgNoiseLin) * 100)));

    if (valNoiseReductionEstimate) {
      valNoiseReductionEstimate.textContent = `${noiseCutDb} dB (${noiseCutPct}% noise removed)`;
    }

    if (valBgVoiceStatus) {
      const bgDb = bgGain > 0 ? (20 * Math.log10(bgGain)).toFixed(1) : '-40.0';
      if (bgGain >= 0.95) {
        valBgVoiceStatus.textContent = '100% PRESERVED (0.0 dB) ✅';
        valBgVoiceStatus.className = 'impact-value val-cyan';
      } else {
        valBgVoiceStatus.textContent = `${bgDb} dB`;
      }
    }

    if (valSpeechClarityGain) {
      const vDb = voiceGain > 0 ? (20 * Math.log10(voiceGain)).toFixed(1) : '0.0';
      valSpeechClarityGain.textContent = `${vDb > 0 ? '+' : ''}${vDb} dB Boost`;
    }
  }

  // 8. Export Center Wiring
  btnExportWav.addEventListener('click', async () => {
    showExportStatus(audioEngine.isExcerpt ? 'Cleaning the whole recording…' : 'Rendering the cleaned audio…');
    try {
      const rendered = await audioEngine.renderCleanedAudioBuffer((prog, msg) => {
        showExportStatus(msg, prog);
      }, { full: true });
      const wavBlob = AudioExporter.bufferToWaveBlob(rendered, 16);
      const filename = currentFile.name.replace(/\.[^/.]+$/, "") + "_cleaned.wav";
      AudioExporter.downloadBlob(wavBlob, filename);
      hideExportStatus();
    } catch (err) {
      alert("Failed to export WAV: " + err.message);
      hideExportStatus();
    }
  });

  btnExportMp4.addEventListener('click', async () => {
    if (!currentFile) return;
    showExportStatus("Preparing Lossless Stream Remuxer...");
    try {
      const rendered = await audioEngine.renderCleanedAudioBuffer((prog, msg) => showExportStatus(msg, prog), { full: true });
      const outputBlob = await MP4Remuxer.replaceAudioInMP4(currentFile, rendered, (prog, msg) => {
        showExportStatus(msg);
      });
      const ext = outputBlob.type.includes('webm') ? 'webm' : 'mp4';
      const filename = currentFile.name.replace(/\.[^/.]+$/, "") + `_cleaned.${ext}`;
      AudioExporter.downloadBlob(outputBlob, filename);
      hideExportStatus();
    } catch (err) {
      alert("Failed to remux video: " + err.message);
      hideExportStatus();
    }
  });

  function showExportStatus(msg, fraction) {
    exportProgress.style.display = 'flex';
    exportStatusText.textContent = (fraction !== undefined && fraction !== null) ? `${msg} ${Math.min(100, Math.round(fraction * 100))}%` : msg;
  }

  function hideExportStatus() {
    setTimeout(() => {
      exportProgress.style.display = 'none';
    }, 1500);
  }

  // Helpers
  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  // Pre-render 9-layer mixer strips so console structure is ready
  renderMixerStrips(audioEngine.componentDefs, {});
  setWorkspaceView('metadata');
  updateLiveVoiceMonitor();
  updateFinalStatusDashboard();
});
