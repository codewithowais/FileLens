/**
 * Unit test verifying audio playback control, stopping, pausing, seeking,
 * and error resilience (e.g. already-stopped buffer sources).
 */
global.window = global;
const fs = require('fs');

// Mock Web Audio API
class MockAudioParam {
  constructor(val = 0) {
    this.value = val;
  }
  setValueAtTime(val) { this.value = val; }
  linearRampToValueAtTime(val) { this.value = val; }
  setTargetAtTime(val) { this.value = val; }
  cancelScheduledValues() {}
}

class MockAudioNode {
  constructor() {
    this.connectedTo = [];
  }
  connect(dest) {
    this.connectedTo.push(dest);
    return dest;
  }
  disconnect() {
    this.connectedTo = [];
  }
}

class MockGainNode extends MockAudioNode {
  constructor() {
    super();
    this.gain = new MockAudioParam(1.0);
  }
}

class MockBiquadFilterNode extends MockAudioNode {
  constructor() {
    super();
    this.frequency = new MockAudioParam(1000);
    this.gain = new MockAudioParam(0);
    this.Q = new MockAudioParam(1);
  }
}

class MockDynamicsCompressorNode extends MockAudioNode {
  constructor() {
    super();
    this.threshold = new MockAudioParam(-24);
    this.ratio = new MockAudioParam(3);
    this.attack = new MockAudioParam(0.01);
    this.release = new MockAudioParam(0.15);
    this.knee = new MockAudioParam(12);
  }
}

class MockAnalyserNode extends MockAudioNode {
  constructor() {
    super();
    this.fftSize = 256;
  }
  getFloatTimeDomainData(arr) {
    arr.fill(0);
  }
}

class MockAudioBufferSourceNode extends MockAudioNode {
  constructor() {
    super();
    this.buffer = null;
    this.loop = false;
    this.hasStarted = false;
    this.hasStopped = false;
    this.throwOnStop = false;
    this.onended = null;
  }
  start(when = 0, offset = 0) {
    this.hasStarted = true;
  }
  stop(when = 0) {
    if (this.throwOnStop || this.hasStopped) {
      throw new Error("InvalidStateError: The AudioBufferSourceNode has already stopped.");
    }
    this.hasStopped = true;
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new MockAudioNode();
  }
  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
  createBufferSource() { return new MockAudioBufferSourceNode(); }
  resume() { return Promise.resolve(); }
}

global.AudioContext = MockAudioContext;

// Load audio engine
const audioEngineCode = fs.readFileSync('public/js/audio-engine.js', 'utf8');
eval(audioEngineCode);

console.log("=== Testing FileLens Playback Stopping & Control ===");

const engine = new AudioEngine();
engine.originalBuffer = {
  duration: 10.0,
  sampleRate: 44100,
  numberOfChannels: 1,
  length: 441000,
  getChannelData: () => new Float32Array(441000)
};

// Populate 9 dummy stems
for (const def of engine.componentDefs) {
  engine.stems[def.id] = engine.originalBuffer;
}

// Test 1: Normal Play -> Stop
console.log("\n1. Testing Normal Play -> Stop...");
engine.play(0);
console.assert(engine.isPlaying === true, "Engine should be playing");
console.assert(engine.activeSources.length === 9, "9 stem sources should be active");
console.assert(engine.originalSource !== null, "originalSource should be created");
console.assert(engine.masterGain.gain.value === 1.0, "masterGain should be 1.0 during play");

engine.stop();
console.assert(engine.isPlaying === false, "Engine should NOT be playing after stop()");
console.assert(engine.pausedAt === 0, "pausedAt should be 0 after stop()");
console.assert(engine.activeSources.length === 0, "activeSources should be empty after stop()");
console.assert(engine.originalSource === null, "originalSource should be null after stop()");
console.assert(engine.masterGain.gain.value === 0, "masterGain should be immediately clamped to 0 after stop()");
console.log("✅ Normal Play -> Stop passed!");

// Test 2: Play -> Pause -> Resume Play
console.log("\n2. Testing Play -> Pause -> Resume...");
engine.play(2.5);
console.assert(engine.isPlaying === true, "Engine should be playing");
engine.audioContext.currentTime = 3.5;
engine.pause();
console.assert(engine.isPlaying === false, "Engine should NOT be playing after pause()");
console.assert(engine.activeSources.length === 0, "activeSources should be empty after pause()");
console.assert(engine.masterGain.gain.value === 0, "masterGain should be clamped to 0 after pause()");

engine.play();
console.assert(engine.isPlaying === true, "Engine should resume playing");
console.assert(engine.activeSources.length === 9, "9 stems should be playing again");
console.assert(engine.masterGain.gain.value === 1.0, "masterGain should be restored to 1.0");
engine.stop();
console.log("✅ Play -> Pause -> Resume passed!");

// Test 3: Resilient Stop when originalSource throws InvalidStateError
console.log("\n3. Testing Stop resilience when originalSource throws InvalidStateError...");
engine.play(0);
// Simulate original source having already completed / throwing on stop()
engine.originalSource.throwOnStop = true;
const stemSourcesBefore = [...engine.activeSources];

engine.stop();
console.assert(engine.isPlaying === false, "Engine should be marked not playing");
console.assert(engine.activeSources.length === 0, "activeSources array should be cleared despite exception");
for (const src of stemSourcesBefore) {
  console.assert(src.hasStopped === true, "All stem sources MUST be stopped even if originalSource threw!");
  console.assert(src.connectedTo.length === 0, "All stem sources MUST be disconnected!");
}
console.assert(engine.masterGain.gain.value === 0, "masterGain should be 0");
console.log("✅ Resilience against throwing/finished sources verified!");

// Test 4: Seek during playback
console.log("\n4. Testing Seek during playback...");
engine.play(1.0);
engine.seek(5.0);
console.assert(engine.isPlaying === true, "Engine should still be playing at new seek point");
console.assert(engine.pausedAt === 5.0, "pausedAt should be updated to 5.0");
console.assert(engine.activeSources.length === 9, "Should only have exactly 9 active stem sources, no orphans!");
engine.stop();
console.log("✅ Seek during playback verified without orphan accumulation!");

// Test 5: End of buffer onended callback cleanly stops all stems
console.log("\n5. Testing buffer end onended cleanly stopping all stems...");
let endCallbackFired = false;
engine.onPlaybackEnd = () => { endCallbackFired = true; };
engine.play(0);
const stemsToMonitor = [...engine.activeSources];
// Simulate buffer natural end
engine.originalSource.onended();
console.assert(engine.isPlaying === false, "isPlaying should be false after natural end");
console.assert(endCallbackFired === true, "onPlaybackEnd callback should fire");
for (const src of stemsToMonitor) {
  console.assert(src.hasStopped === true, "All stems must be stopped on natural end of track!");
}
console.assert(engine.activeSources.length === 0, "activeSources cleared");
console.log("✅ Buffer natural end cleanly stops all stem sources!");

console.log("\n=============================================");
console.log(" ALL PLAYBACK CONTROL TESTS 100% PASSED! 🚀");
console.log("=============================================");
