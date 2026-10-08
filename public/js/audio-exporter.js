/**
 * SpectraClean AI - Audio Exporter
 * Encodes AudioBuffer into studio-grade uncompressed WAV (16-bit/24-bit PCM)
 * and triggers instant file download.
 */

class AudioExporter {
  /**
   * Encodes an AudioBuffer to a WAV blob (RIFF PCM)
   */
  static bufferToWaveBlob(audioBuffer, bitDepth = 16) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const bufferSize = 44 + dataSize;

    const arrayBuffer = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuffer);

    // RIFF chunk descriptor
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 = PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    // data sub-chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write interleaved audio samples
    const channels = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }

    let offset = 44;
    if (bitDepth === 16) {
      for (let i = 0; i < length; i++) {
        for (let c = 0; c < numChannels; c++) {
          const sample = Math.max(-1, Math.min(1, channels[c][i]));
          const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
          view.setInt16(offset, intSample, true);
          offset += 2;
        }
      }
    } else if (bitDepth === 24) {
      for (let i = 0; i < length; i++) {
        for (let c = 0; c < numChannels; c++) {
          const sample = Math.max(-1, Math.min(1, channels[c][i]));
          const intSample = Math.floor(sample < 0 ? sample * 0x800000 : sample * 0x7FFFFF);
          view.setUint8(offset, intSample & 0xFF);
          view.setUint8(offset + 1, (intSample >> 8) & 0xFF);
          view.setUint8(offset + 2, (intSample >> 16) & 0xFF);
          offset += 3;
        }
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  static writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  /**
   * Triggers download of a Blob in the browser
   */
  static downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 2000);
  }
}

window.AudioExporter = AudioExporter;
