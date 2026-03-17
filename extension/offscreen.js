let mediaRecorder = null;
let captureStream = null;
let audioChunks = [];
let chunkInterval = null;

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

    // Stop gracefully if any track ends
    stream.getTracks().forEach(track => {
      track.addEventListener('ended', () => {
        console.warn('[OFFSCREEN] Track ended, stopping recording');
        stopRecording();
      });
    });

    startNewRecorder(stream);

    // Every 8 seconds, harvest the current recording and send it
    chunkInterval = setInterval(() => {
      harvestAndRestart(stream);
    }, 8000);

    console.log('[OFFSCREEN] Recording started with 8s batch interval');

  } catch (err) {
    console.error('[OFFSCREEN] getUserMedia error:', err.name, err.message);
  }
}

function startNewRecorder(stream) {
  // Check if stream tracks are still live
  const tracks = stream.getTracks();
  const allLive = tracks.length > 0 && tracks.every(t => t.readyState === 'live');
  if (!allLive) {
    console.warn('[OFFSCREEN] Stream tracks not live, cannot start recorder');
    return;
  }

  audioChunks = [];

  try {
    const recorder = new MediaRecorder(stream);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      console.error('[OFFSCREEN] MediaRecorder error:', event.error.name, event.error.message);
    };

    recorder.start(250); // Collect data every 250ms
    mediaRecorder = recorder;
    console.log('[OFFSCREEN] MediaRecorder started');
  } catch (err) {
    console.error('[OFFSCREEN] MediaRecorder.start() failed:', err.name, err.message);
  }
}

function harvestAndRestart(stream) {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    // Try to start a fresh recorder if old one died
    startNewRecorder(stream);
    return;
  }

  // Stop current recorder — this triggers a final ondataavailable
  mediaRecorder.onstop = () => {
    if (audioChunks.length > 0) {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      sendAudioChunk(blob);
    }
    // Start a fresh recorder immediately
    startNewRecorder(stream);
  };

  try {
    mediaRecorder.stop();
  } catch (e) {
    console.warn('[OFFSCREEN] recorder.stop() failed:', e.message);
    startNewRecorder(stream);
  }
}

async function sendAudioChunk(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    console.log('[OFFSCREEN] Sending AUDIO_CHUNK, size:', base64.length);
    chrome.runtime.sendMessage({ type: 'AUDIO_CHUNK', audio: base64 });
  } catch (e) {
    console.error('[OFFSCREEN] Failed to send audio chunk:', e.message);
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function stopRecording() {
  if (chunkInterval) {
    clearInterval(chunkInterval);
    chunkInterval = null;
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) { /* already stopped */ }
  }
  mediaRecorder = null;
  audioChunks = [];

  if (captureStream) {
    captureStream.getTracks().forEach(track => track.stop());
    captureStream = null;
  }

  console.log('[OFFSCREEN] Recording stopped');
}
