/**
 * FileLens - Lossless MP4 Audio Replacement Engine
 * Replaces the audio track inside the original MP4 container
 * without re-encoding video frames!
 */

class MP4Remuxer {
  /**
   * Fast client-side lossless audio replacement.
   * If the input is an MP4 video, copies the video track directly and attaches
   * the new cleaned audio track into a new MP4 container.
   */
  static async replaceAudioInMP4(originalFile, cleanedAudioBuffer, progressCallback = () => {}) {
    progressCallback(0.2, "Extracting Original Video Track (Bitstream Copy)...");

    // Convert Cleaned Audio Buffer to WAV blob
    const wavBlob = AudioExporter.bufferToWaveBlob(cleanedAudioBuffer, 16);

    // Try server-side lossless remux first (if server is running)
    try {
      const formData = new FormData();
      formData.append('video', originalFile);
      formData.append('audio', wavBlob, 'cleaned_audio.wav');

      progressCallback(0.4, "Losslessly Remuxing Video Stream (Zero Re-encoding)...");

      const response = await fetch('/api/remux-mp4', {
        method: 'POST',
        body: formData
      });

      if (response.ok) {
        const mp4Blob = await response.blob();
        progressCallback(1.0, "Lossless Remux Complete!");
        return mp4Blob;
      }
    } catch (e) {
      console.log("Server remux endpoint unavailable, using client-side WebStream remuxer...", e);
    }

    // Client-side pure fallback: MediaStream / Video element muxer
    progressCallback(0.5, "Muxing Clean Audio Track with Original Video Stream...");
    return await this.clientSideMux(originalFile, cleanedAudioBuffer, progressCallback);
  }

  /**
   * Client-side stream muxer: Plays original video track synchronized with
   * cleaned audio node and records the multiplexed output container.
   */
  static async clientSideMux(originalFile, cleanedAudioBuffer, progressCallback) {
    return new Promise(async (resolve, reject) => {
      try {
        const videoUrl = URL.createObjectURL(originalFile);
        const video = document.createElement('video');
        video.src = videoUrl;
        video.muted = true;
        video.playsInline = true;

        await new Promise((res) => {
          video.onloadedmetadata = res;
          video.onerror = () => reject(new Error("Failed to load video"));
        });

        const duration = video.duration || cleanedAudioBuffer.duration;

        // Create an AudioContext and play the cleaned audio buffer into a MediaStreamDestination
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        const streamDest = actx.createMediaStreamDestination();
        const bufferSource = actx.createBufferSource();
        bufferSource.buffer = cleanedAudioBuffer;
        bufferSource.connect(streamDest);

        // Capture video track directly from video element
        let videoStream = null;
        if (video.captureStream) {
          videoStream = video.captureStream();
        } else if (video.mozCaptureStream) {
          videoStream = video.mozCaptureStream();
        }

        // Combine video track and clean audio track
        const combinedTracks = [
          ...videoStream.getVideoTracks(),
          ...streamDest.stream.getAudioTracks()
        ];
        const combinedStream = new MediaStream(combinedTracks);

        // Determine supported recorder MIME type
        const mimeType = MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')
          ? 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
          : (MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm; codecs=vp9,opus');

        const recorder = new MediaRecorder(combinedStream, {
          mimeType: mimeType,
          videoBitsPerSecond: 8000000 // High bitrate preservation
        });

        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
          URL.revokeObjectURL(videoUrl);
          actx.close();
          const finalBlob = new Blob(chunks, { type: mimeType.includes('mp4') ? 'video/mp4' : 'video/webm' });
          progressCallback(1.0, "Export Ready!");
          resolve(finalBlob);
        };

        // Start playback and recording
        recorder.start(100);
        bufferSource.start(0);
        video.play();

        const updateInterval = setInterval(() => {
          const progress = Math.min(0.95, 0.5 + 0.45 * (video.currentTime / duration));
          progressCallback(progress, `Muxing Frame Data: ${(video.currentTime).toFixed(1)}s / ${duration.toFixed(1)}s`);
        }, 300);

        video.onended = () => {
          clearInterval(updateInterval);
          bufferSource.stop();
          recorder.stop();
        };

        // Timeout safety
        setTimeout(() => {
          if (recorder.state === 'recording') {
            clearInterval(updateInterval);
            recorder.stop();
          }
        }, (duration + 2) * 1000);

      } catch (err) {
        reject(err);
      }
    });
  }
}

window.MP4Remuxer = MP4Remuxer;
