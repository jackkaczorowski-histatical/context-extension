let mediaRecorder = null;
let captureStream = null;

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

    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        console.log('[OFFSCREEN] Audio chunk captured, blob size:', event.data.size, 'bytes');
        try {
          const base64 = await blobToBase64(event.data);
          chrome.runtime.sendMessage({ type: 'AUDIO_CHUNK', audio: base64 });
        } catch (e) {
          console.error('[OFFSCREEN] Failed to send audio chunk:', e.name, e.message);
        }
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error('[OFFSCREEN] MediaRecorder error:', event.error.name, event.error.message);
    };

    mediaRecorder.start(4000); // 4-second chunks
    console.log('[OFFSCREEN] MediaRecorder started, mimeType:', mediaRecorder.mimeType);
  } catch (err) {
    console.error('[OFFSCREEN] getUserMedia error:', err.name, err.message);
  }
}

function stopRecording() {
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
