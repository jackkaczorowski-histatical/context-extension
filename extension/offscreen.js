const TOKEN_URL = 'https://context-extension-zv8d.vercel.app/api/deepgram-token';

let mediaRecorder = null;
let captureStream = null;
let dgSocket = null;
let keepAliveInterval = null;
let intentionalClose = false;
let currentStream = null;

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

async function fetchTempToken() {
  console.log('[OFFSCREEN] Fetching temporary Deepgram token...');
  const res = await fetch(TOKEN_URL);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Token fetch failed: ${res.status} ${errText}`);
  }
  const data = await res.json();
  if (!data.token) {
    throw new Error('Token response missing token field');
  }
  console.log('[OFFSCREEN] Got temp token, length:', data.token.length);
  return data.token;
}

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
    currentStream = stream;

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

    await connectAndStream(stream);

  } catch (err) {
    console.error('[OFFSCREEN] startRecording error:', err.name, err.message);
  }
}

async function connectAndStream(stream) {
  // Check tracks are still live
  const tracks = stream.getTracks();
  const allLive = tracks.length > 0 && tracks.every(t => t.readyState === 'live');
  if (!allLive) {
    console.warn('[OFFSCREEN] Stream tracks not live, cannot connect');
    return;
  }

  let token;
  try {
    token = await fetchTempToken();
  } catch (e) {
    console.error('[OFFSCREEN] Token error:', e.message);
    return;
  }

  const dgUrl = 'wss://api.deepgram.com/v1/listen?' +
    'model=nova-2&smart_format=true&punctuate=true';

  console.log('[OFFSCREEN] Connecting to Deepgram WebSocket...');
  intentionalClose = false;
  dgSocket = new WebSocket(dgUrl, ['token', token]);

  dgSocket.onopen = () => {
    console.log('[OFFSCREEN] Deepgram WebSocket connected');

    // Start MediaRecorder streaming audio to WebSocket
    startMediaRecorder(stream);

    // Send KeepAlive every 8 seconds
    keepAliveInterval = setInterval(() => {
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 8000);
  };

  dgSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.is_final && data.channel?.alternatives?.[0]?.transcript) {
        const transcript = data.channel.alternatives[0].transcript.trim();
        if (transcript.length > 0) {
          console.log('[OFFSCREEN] Transcript:', transcript);
          chrome.runtime.sendMessage({ type: 'TRANSCRIPT', transcript });
        }
      }
    } catch (e) {
      console.error('[OFFSCREEN] Error parsing Deepgram message:', e.message);
    }
  };

  dgSocket.onerror = () => {
    console.error('[OFFSCREEN] Deepgram WebSocket error, readyState:', dgSocket?.readyState);
  };

  dgSocket.onclose = (event) => {
    console.log('[OFFSCREEN] Deepgram WebSocket closed. code:', event.code, 'reason:', event.reason);
    clearKeepAlive();

    // Reconnect if unexpected close and stream is still live
    if (!intentionalClose && currentStream) {
      const live = currentStream.getTracks().some(t => t.readyState === 'live');
      if (live) {
        console.log('[OFFSCREEN] Unexpected close, reconnecting in 2s...');
        setTimeout(() => {
          if (currentStream) connectAndStream(currentStream);
        }, 2000);
      }
    }
  };
}

function startMediaRecorder(stream) {
  // Stop existing recorder if any
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) { /* ok */ }
  }

  const tracks = stream.getTracks();
  const allLive = tracks.length > 0 && tracks.every(t => t.readyState === 'live');
  if (!allLive) {
    console.warn('[OFFSCREEN] Cannot start recorder, tracks not live');
    return;
  }

  try {
    const recorder = new MediaRecorder(stream);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(event.data);
      }
    };

    recorder.onerror = (event) => {
      console.error('[OFFSCREEN] MediaRecorder error:', event.error?.name, event.error?.message);
    };

    recorder.start(250);
    mediaRecorder = recorder;
    console.log('[OFFSCREEN] MediaRecorder started, streaming to Deepgram');
  } catch (err) {
    console.error('[OFFSCREEN] MediaRecorder.start() failed:', err.name, err.message);
  }
}

function clearKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function stopRecording() {
  intentionalClose = true;
  currentStream = null;

  clearKeepAlive();

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) { /* already stopped */ }
  }
  mediaRecorder = null;

  if (dgSocket) {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    dgSocket.close();
    dgSocket = null;
  }

  if (captureStream) {
    captureStream.getTracks().forEach(track => track.stop());
    captureStream = null;
  }

  console.log('[OFFSCREEN] Recording stopped');
}
