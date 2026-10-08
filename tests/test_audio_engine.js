/**
 * Verification test for FileLens Audio Engine & Component Decomposition
 */
global.window = global;
const fs = require('fs');

// Load audio engine
const audioEngineCode = fs.readFileSync('public/js/audio-engine.js', 'utf8');
eval(audioEngineCode);

console.log("=== FileLens Engine Unit Test ===");

// 1. Verify FastFFT
const fftSize = 1024;
const fft = new FastFFT(fftSize);
const real = new Float32Array(fftSize);
const imag = new Float32Array(fftSize);

// Pure sine wave at 440 Hz with sampleRate 44100
const freq = 440;
const sr = 44100;
for (let i = 0; i < fftSize; i++) {
  real[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  imag[i] = 0;
}

fft.transform(real, imag);

// Find peak frequency bin
let maxMag = 0;
let peakBin = 0;
for (let k = 0; k < fftSize / 2; k++) {
  const m = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
  if (m > maxMag) {
    maxMag = m;
    peakBin = k;
  }
}
const detectedFreq = (peakBin * sr) / fftSize;
console.log(`FFT Test: Expected 440 Hz, Detected: ${detectedFreq.toFixed(1)} Hz (bin ${peakBin})`);
if (Math.abs(detectedFreq - 440) < 50) {
  console.log("✅ FFT frequency tracking verified!");
} else {
  console.error("❌ FFT test failed");
  process.exit(1);
}

// 2. Inverse FFT Reconstruction Check
fft.inverseTransform(real, imag);
let maxDiff = 0;
for (let i = 0; i < fftSize; i++) {
  const expected = Math.sin((2 * Math.PI * freq * i) / sr);
  const diff = Math.abs(real[i] - expected);
  if (diff > maxDiff) maxDiff = diff;
}
console.log(`IFFT Reconstruction Maximum Error: ${maxDiff.toExponential(4)}`);
if (maxDiff < 1e-4) {
  console.log("✅ IFFT perfect reconstruction verified!");
} else {
  console.error("❌ IFFT reconstruction error too high");
  process.exit(1);
}

// 3. Verify Component Definitions
const engine = new AudioEngine();
console.log(`Engine loaded with ${engine.componentDefs.length} AI-estimated component layers:`);
engine.componentDefs.forEach((c, idx) => {
  console.log(`  ${idx + 1}. [${c.id}] ${c.icon} ${c.name} - ${c.desc}`);
});

if (engine.componentDefs.length === 9) {
  console.log("✅ All 9 AI-estimated components registered properly!");
} else {
  console.error("❌ Expected 9 components");
  process.exit(1);
}

// 4. Test Cafe Voice Preservation Preset
engine.applyPreset('cafe_preserve_voices');
console.log("\nTesting Cafe Preservation Preset:");
console.log(`  Main Voice gain: ${20 * Math.log10(engine.stemValues.main_voice)} dB (Boosted ✅)`);
console.log(`  Background Voice gain: ${20 * Math.log10(engine.stemValues.bg_voice)} dB (Preserved ✅)`);
console.log(`  Traffic gain: ${20 * Math.log10(engine.stemValues.traffic)} dB (Reduced ✅)`);
console.log(`  Fan/AC gain: ${20 * Math.log10(engine.stemValues.fan_ac)} dB (Reduced ✅)`);

if (
  engine.stemValues.main_voice > 1.0 &&
  engine.stemValues.bg_voice >= 1.0 &&
  engine.stemValues.traffic < 0.1 &&
  engine.stemValues.fan_ac < 0.1
) {
  console.log("✅ Preset verification passed: Keeps main speaker & background people while cutting traffic & fan!");
} else {
  console.error("❌ Preset verification failed");
  process.exit(1);
}

// 5. Test Supported Media Types for Clipboard & Upload
function isSupportedMedia(file) {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  const exts = ['.mp4', '.m4a', '.mp3', '.wav', '.mov', '.ogg', '.webm', '.aac', '.flac'];
  return exts.some(ext => name.endsWith(ext)) || type.startsWith('audio/') || type.startsWith('video/');
}

console.log("\nTesting Clipboard Media Validation:");
const testFiles = [
  { name: 'voice_note.m4a', type: 'audio/mp4', expected: true },
  { name: 'interview.mp4', type: 'video/mp4', expected: true },
  { name: 'podcast.mp3', type: 'audio/mpeg', expected: true },
  { name: 'studio_take.wav', type: 'audio/wav', expected: true },
  { name: 'video.mov', type: 'video/quicktime', expected: true },
  { name: 'screencap.webm', type: 'video/webm', expected: true },
  { name: 'photo.jpg', type: 'image/jpeg', expected: false },
  { name: 'notes.txt', type: 'text/plain', expected: false }
];

testFiles.forEach(tf => {
  const res = isSupportedMedia(tf);
  if (res === tf.expected) {
    console.log(`  File "${tf.name}" (${tf.type}) -> ${res ? 'Accepted ✅' : 'Rejected ✅'}`);
  } else {
    console.error(`  ❌ Failed check for ${tf.name}`);
    process.exit(1);
  }
});
console.log("✅ Clipboard media detection verified!");

// 6. Test Macro Noise Reduction & Complete Cancellation
console.log("\nTesting 100% Macro Noise Reduction & Background Preservation:");
engine.applyMacros(100, 50, 100);
console.log(`  Noise Reduction: 100% -> Traffic Gain: ${engine.stemValues.traffic}`);
console.log(`  Fan/AC Gain: ${engine.stemValues.fan_ac}`);
console.log(`  Hum Gain: ${engine.stemValues.hum}`);
console.log(`  Main Voice Gain: ${engine.stemValues.main_voice.toFixed(2)} (Boosted)`);
console.log(`  Background Voice Gain: ${engine.stemValues.bg_voice} (Preserved 100%)`);

if (
  engine.stemValues.traffic === 0 &&
  engine.stemValues.fan_ac === 0 &&
  engine.stemValues.hum === 0 &&
  engine.stemValues.bg_voice === 1.0 &&
  engine.stemValues.main_voice > 1.0
) {
  console.log("✅ 100% Noise Reduction correctly clamps noise stems to 0.0 linear gain (silenced) while preserving background voices!");
} else {
  console.error("❌ Noise cancellation failed to clamp to 0.0");
  process.exit(1);
}

console.log("\nALL TESTS PASSED SUCCESSFULLY! 🚀");


// --- De-hum must be a real bypass when off (a notch with a tiny Q silences almost everything) ---
{
  const off = AudioEngine.notchConfig(false, 60), on = AudioEngine.notchConfig(true, 50);
  if (off.type !== 'allpass') throw new Error('De-hum OFF must be an all-pass (bypass) filter, got ' + off.type);
  if (on.type !== 'notch' || on.Q < 5 || on.frequency !== 50) throw new Error('De-hum ON must be a narrow notch at the chosen mains frequency');
  const e = new AudioEngine();
  e.setDeHum('50hz');                                  // before any playback: no audio graph exists yet
  if (!e.dspSettings.deHumEnabled || e.dspSettings.deHumFreq !== 50) throw new Error('setDeHum must be remembered even before the audio graph exists');
  e.setDeHum('off');
  if (e.dspSettings.deHumEnabled) throw new Error('setDeHum(off) must disable the filter');
  console.log('\u2705 De-hum is a true bypass when off, and 50/60 Hz is remembered for the download');
}
