// Background worker: re-synthesizes one segment of the recording (see AudioEngine.synthSegment).
self.window = self;
importScripts('audio-engine.js' + self.location.search);   // same version as the page
self.onmessage = async (e) => {
  try {
    const job = e.data;
    const result = await AudioEngine.synthSegment(job, (p) => self.postMessage({ progress: p }), null, false);
    const transfer = [result.windowSum.buffer, ...result.stemL.map(a => a.buffer), ...result.stemR.map(a => a.buffer)];
    self.postMessage({ result }, transfer);
  } catch (err) {
    self.postMessage({ error: (err && err.message) || String(err) });
  }
};
