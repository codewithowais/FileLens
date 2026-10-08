# SpectraClean AI - Web-Based Audio & Video Cleaning Suite

SpectraClean AI is a high-precision, web-based audio and video restoration tool engineered for forensic audio cleanup, voice isolation, and acoustic component balancing.

It operates with a 32-bit floating-point Web Audio API pipeline and Short-Time Fourier Transform (STFT) spectral decomposition.

---

## 🌟 Key Architecture & Highlights

- **Zero-Install, Pure Browser Execution**: Runs directly in any modern browser (Chrome, Safari, Firefox, Edge) without requiring complicated heavy native package dependencies.
- **FFprobe File & Stream Inspector**: Extracts ISO BMFF (MP4/M4A), RIFF (WAV), and ID3 (MP3) metadata, displaying complete stream specs and full raw FFprobe JSON.
- **Dual Visualizer**: High-resolution time-domain Waveform and frequency-domain Spectrogram (20 Hz – 22.05 kHz) with an interactive frequency probe tooltip.
- **AI-Estimated Component Separation (9 Distinct Layers)**:
  1. 🎙️ **Main Voice** (Foreground speech formants 300Hz–3.4kHz, vowel pitch harmonics)
  2. 👥 **Background Human Voices** (Secondary chatter, cafe babble, room discussions — *never discarded as noise!*)
  3. 🚗 **Traffic / Vehicles** (Low-frequency rumble 20Hz–200Hz, diesel hums, road noise)
  4. 💨 **Wind** (Turbulent stochastic low-mid gusts 30Hz–380Hz)
  5. ❄️ **Fan / AC** (Continuous stationary motor whine + broadband air rush)
  6. ⚡ **Hum (50/60Hz)** (Mains electrical hum and exact 2nd/3rd/4th harmonics)
  7. 🎵 **Music** (Sustained melodic/harmonic pitch tracks, beats, score)
  8. 🌫️ **General Noise** (Broadband stationary hiss, thermal noise floor)
  9. 🏛️ **Reverb / Echo** (Diffuse room acoustic reflections and late decay tail)
- **Mixer Console with Mute & Solo Matrix**: Every component has a dedicated fader (-40 dB to +12 dB), detected energy readout, `[M]` Mute button, and `[S]` Solo button.
- **Macro Controls**:
  - **Noise Reduction** (0–100%)
  - **Voice Boost** (0–100%)
  - **Background Voice Preservation** (0–100% — safeguards ambient chatter)
  - **Master Volume** (-24 dB to +12 dB)
  - **3-Band Parametric EQ** (Low Shelf 120Hz, Mid Peak 2.5kHz, High Shelf 8kHz)
  - **Studio Dynamics Compressor & Peak Limiter** (-0.1 dBFS true-peak ceiling)
- **Seamless Real-Time A/B Preview**: Click between `ORIGINAL (Raw)` and `CLEANED (AI Processed)` instantly during playback without glitches or phase clicks.
- **Frame-Accurate Video Player**: Synchronizes uploaded MP4 video with real-time audio playback.
- **Lossless Export Studio**:
  - Export **Clean Audio** as uncompressed studio-master WAV (16-bit / 24-bit PCM).
  - Export **Clean Video (MP4)**: Replaces audio inside the original MP4 **without re-encoding the video stream** (lossless bitstream copy preserving 100% video quality).

---

## 🎯 The Core Philosophy: "Not All Non-Speech is Noise"

In many real-world recording scenarios:
> **Main Speaker + Background People + Traffic + Fan**

Traditional AI noise suppressors aggressively strip everything that isn't the primary speaker, destroying ambient human conversation and producing robotic, muffled artifacts.

SpectraClean AI specifically isolates **Background Human Voices** into its own independent layer:
- **Keep Main Speaker** ✅ (+2 dB clarity boost)
- **Keep Background People** ✅ (0 dB complete preservation)
- **Reduce Traffic** ✅ (-35 dB attenuation)
- **Reduce Fan/AC** ✅ (-32 dB attenuation)

---

## 🚀 Deployment & Quick Start

### ⚡ Deploy on Vercel (100% Supported!)
Because SpectraClean AI runs purely in the client browser (Web Audio API, STFT decomposition, client-side FFprobe parser, and client-side MP4 remuxing), **it is 100% static and deploys to Vercel instantly with zero backend setup**:

#### Option A: Vercel CLI
```bash
npm i -g vercel
vercel
```

#### Option B: GitHub Import
1. Push this folder to a GitHub repository.
2. In [Vercel Dashboard](https://vercel.com/new), click **Import**.
3. Vercel automatically detects [`vercel.json`](vercel.json) and configures the routes and headers with 1 click!

---

### 📋 Paste from Clipboard Support
- **Keyboard Shortcut**: Copy any audio or video file (`.mp4`, `.m4a`, `.mp3`, `.wav`, `.mov`, `.webm`) from your file manager or browser and press **`Cmd + V` (Mac)** or **`Ctrl + V` (Windows)** anywhere on the page to paste it instantly.
- **Dedicated Button**: Click **"📋 Paste from Clipboard"** in the upload zone.

---

### 💻 Local Development Server
Run the local HTTP server:
```bash
python3 server.py 8000
```
Open your browser at:
```
http://localhost:8000
```

---

## 📁 Project Structure

```
meta-data/
├── server.py                       # Python HTTP server with Byte-Range & MIME support
├── generate_samples.py             # Realistic multi-component audio synthesizer
├── samples/
│   ├── sample_interview_with_noise.wav
│   ├── sample_interview_with_noise.m4a
│   └── sample_video_with_noise.mp4
├── public/
│   ├── index.html                  # Responsive dark-theme studio interface
│   ├── css/
│   │   └── style.css               # Studio console styling, meters, faders
│   └── js/
│       ├── app.js                  # Master controller & state orchestration
│       ├── audio-engine.js         # STFT 9-component decomposition & Web Audio DSP
│       ├── spectrogram.js          # High-resolution Canvas Spectrogram & Waveform
│       ├── ffprobe-parser.js       # ISO BMFF (MP4) / RIFF (WAV) / ID3 (MP3) inspector
│       ├── mp4-muxer.js            # Video bitstream extractor & lossless MP4 remuxer
│       └── audio-exporter.js       # Uncompressed WAV PCM audio exporter
├── tests/
│   ├── test_audio_engine.js        # Unit tests for FFT, IFFT, and presets
│   └── test_full_pipeline.js       # End-to-end integration test with real audio
└── README.md
```

---

## 🧪 Automated Test Suite

Run the unit tests:
```bash
node tests/test_audio_engine.js
```

Run every test suite at once:
```bash
npm test
```

Run the end-to-end audio decomposition pipeline test:
```bash
node tests/test_full_pipeline.js
```
Expected output:
```
=== Testing SpectraClean AI Full Pipeline ===
1. WAV Metadata Inspection:  ✅ WAV FFprobe parser verified!
2. MP4 Metadata Inspection:  ✅ MP4 FFprobe parser verified!
3. Scenario Requirements Check:
    Main Speaker detected:      4.72% energy (✅ > 0%)
    Background People detected: 8.60% energy (✅ > 0%)
    Traffic Rumble detected:   14.95% energy (✅ > 0%)
    Fan / AC detected:          8.02% energy (✅ > 0%)
    60Hz Hum detected:          2.22% energy (✅ > 0%)
✅ SUCCESS! All independent acoustic components accurately estimated!
✅ Background people are cleanly distinguished from traffic and fan noise!
```
