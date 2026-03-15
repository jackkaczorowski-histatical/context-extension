let mediaRecorder = null;
let captureStream = null;
let recordingInterval = null;

// Signal to background that we're ready
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
console.log('[OFFSCREEN] Ready, sent OFFSCREEN_READY');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_RECORDING') {
    console.log('[OFFSCREEN] Received START_RECORDING with streamId:', message.streamId);
    startRecording(message.streamId);
  } else if (message.type === 'STOP_RECORDING') {
    stopRecording();
  }
});

async function startRecording(streamId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    captureStream = stream;

    // Play audio back so the tab isn't muted
    const audio = new Audio();
    audio.srcObject = stream;
    audio.play();

    function startNewRecorder() {
      const chunks = [];
      const recorder = new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = async () => {
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        console.log('[OFFSCREEN] Complete audio blob created, size:', blob.size, 'bytes');
        try {
          const base64 = await blobToBase64(blob);
          chrome.runtime.sendMessage({ type: 'AUDIO_CHUNK', audio: base64 });
        } catch (e) {
          console.error('[OFFSCREEN] Failed to send audio chunk:', e.name, e.message);
        }
      };

      recorder.onerror = (event) => {
        console.error('[OFFSCREEN] MediaRecorder error:', event.error.name, event.error.message);
      };

      try {
        recorder.start();
      } catch (err) {
        console.error('[OFFSCREEN] MediaRecorder.start() failed:', err.name, err.message);
        stopRecording();
        startRecording(streamId);
        return;
      }
      console.log('[OFFSCREEN] New MediaRecorder started, mimeType:', recorder.mimeType);
      mediaRecorder = recorder;
    }

    // Start the first recorder
    startNewRecorder();

    // Every 8 seconds, stop the current recorder (triggers onstop which sends the blob)
    // and start a fresh one
    recordingInterval = setInterval(() => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      startNewRecorder();
    }, 8000);

  } catch (err) {
    console.error('[OFFSCREEN] getUserMedia error:', err.name, err.message);
  }
}

function stopRecording() {
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (captureStream) {
    captureStream.getTracks().forEach(track => track.stop());
    captureStream = null;
  }
  mediaRecorder = null;
  console.log('[OFFSCREEN] Recording stopped');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}
