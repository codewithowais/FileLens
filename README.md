# FileLens

**See where any file really came from.**

FileLens is a free, private file inspector that runs entirely in your browser. Drop in a photo, video, audio file, PDF or Office document and it tells you, in plain English:

- **What it is, who made it, when, and on what device or program**
- **Whether AI made it**, and which tool, model and settings, when the file says so
- **Whether its Content Credentials (C2PA) are genuine**, or were changed after signing
- **What it gives away**, such as GPS location, camera, author and edit history
- **How to clean up its audio**, with Before/After listening and download

Nothing is uploaded. Your files are analysed on your own device.

> Live: https://filelens-app.vercel.app

---

## What it reads

| File type | What FileLens extracts |
|---|---|
| **Photos** (JPEG, PNG, WebP, HEIC, AVIF, TIFF) | Camera, lens, exposure, date taken, **GPS location**, IPTC credits, XMP, compressed PNG text, AI generation settings |
| **Video / audio** (MP4, MOV, M4A, WAV, MP3, FLAC, OGG, WebM) | Streams, codecs, duration, dates, device and software tags, comments, Apple location |
| **Documents** (PDF, DOCX, XLSX, PPTX, ODT/ODS/ODP) | Author, last saved by, program and version, dates, pages, words, revisions |
| **Anything else** | Hash, entropy, magic bytes, container layout |

FileLens only reports what is actually stored in the file. It never invents metadata.

## AI origin detection

It looks for the marks AI tools leave behind:

- **Standard labels:** IPTC `DigitalSourceType` and C2PA Content Credentials (OpenAI, Adobe Firefly, Google and others)
- **Tool fingerprints:** Stable Diffusion / AUTOMATIC1111 / Forge, ComfyUI, InvokeAI, NovelAI, Midjourney job IDs
- **Named tools** in Software / Creator / Producer fields (Suno, ElevenLabs, Sora, Gamma, Claude, and about 50 more)
- **Hints (not proof)** for files made by libraries such as python-docx or ReportLab

For each hit it shows the vendor, tool, model, prompt, seed, date and the evidence behind the verdict.

**Honest limits.** "No AI marks found" does **not** prove a person made the file. Screenshots and social media strip these marks, and text that an AI wrote and a person pasted into a document leaves no trace in any file. FileLens does not try to guess from pixels or writing style.

## Content Credentials (C2PA) verification

FileLens cryptographically checks Content Credentials in **JPEG, PNG, MP4 and MOV** files:

1. The signature over the claim (ES256/384/512, PS256/384/512, EdDSA)
2. Every signed assertion hash
3. The **content hash**, so edits after signing are caught (including box-based MP4 hashes)
4. The **history**: earlier signed versions must be intact and match what the newest one recorded
5. The certificate chain, against the official **C2PA trust list** (embedded, 30 certificate authorities)

Results: *verified*, *valid but signer not on the trust list*, *partly checked*, *failed*, or *unreadable*.

Not checked yet: certificate revocation, the timestamp service's own signature, fragmented (streaming) MP4s, and HEIC/AVIF files. Valid credentials prove who signed a file and that it is unchanged since. They do not prove the content is true.

The trust list in `public/js/c2pa-trust-anchors.js` changes over time. Refresh it from
[c2pa-org/conformance-public](https://github.com/c2pa-org/conformance-public/tree/main/trust-list).

## Audio cleaning

For files with audio, a second tab separates the sound into nine estimated layers (main voice, background voices, traffic, wind, fan/AC, hum, music, noise, reverb) using STFT spectral masking. **Simple** mode gives you a one-click clean, a Before/After switch and a few sliders. **Advanced** mode adds a full mixer with mute/solo, EQ, compressor, de-esser, de-hum and a peak limiter. Export cleaned audio as WAV, or replace the audio in an MP4 without re-encoding the video.

**Volume boost:** the Overall volume control goes up to **+30 dB**, with one-tap +6 / +12 / +18 / +24 dB buttons. A limiter and soft clipper after it keep loud boosts from distorting (peaks never exceed about -0.8 dBFS).

**Rewind / fast-forward:** the ⏪ / ⏩ buttons jump 10 seconds on a click and scan quickly while held. Keyboard (in the studio): `←` / `→` skip 5 s, `Shift` + arrow skips 30 s, `J` / `L` skip 10 s, `Space` plays or pauses.

**Long recordings:** the studio previews 3 minutes (you pick where), and the download cleans the whole recording in one streaming pass. A 65-minute voice memo downloads in about 3 minutes.

The analysis runs when you open the Audio Cleaning tab, so file details appear instantly.

---

## Run locally

```bash
python3 server.py 8000
```

then open http://localhost:8000. It is a static site, so any static server works.

## Deploy

FileLens is 100% static and deploys to Vercel with no backend. `vercel.json` serves the `public/` folder.

```bash
npx vercel --prod
```

## Tests

```bash
npm test
```

Runs 8 suites, including C2PA verification against real signed files from the C2PA project (in `tests/fixtures`) with deliberate tampering to prove edits are caught.

## Project layout

```
public/
├── index.html
├── css/style.css
└── js/
    ├── app.js                  UI controller
    ├── ffprobe-parser.js       format parsers (MP4, WAV, MP3, FLAC, OGG, WebM, JPEG, PNG, WebP, GIF, PDF)
    ├── metadata-extras.js      EXIF + GPS, IPTC, PNG text, Office/OpenDocument, built-in inflate
    ├── ai-detector.js          AI origin detection
    ├── c2pa-verifier.js        Content Credentials verification
    ├── c2pa-trust-anchors.js   official C2PA trust list
    ├── audio-engine.js         STFT separation + Web Audio chain
    ├── spectrogram.js          waveform / spectrogram
    ├── audio-exporter.js       WAV export
    └── mp4-muxer.js            lossless MP4 audio replacement
tests/                          test suites and fixtures
server.py                       small local static server
```

## Privacy

Everything runs in your browser. Files are never sent anywhere. The only external request is the Google Fonts stylesheet.

## License

MIT
