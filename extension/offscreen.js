let mediaRecorder = null;
let captureStream = null;
let deepgramSocket = null;

const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

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

    // Fetch the Deepgram API key from our secure endpoint
    let token;
    try {
      const tokenRes = await fetch(`${API_BASE}/deepgram-token`);
      if (!tokenRes.ok) {
        console.error('[OFFSCREEN] Failed to fetch Deepgram token:', tokenRes.status);
        return;
      }
      const tokenData = await tokenRes.json();
      token = tokenData.token;
    } catch (e) {
      console.error('[OFFSCREEN] Token fetch error:', e.message);
      return;
    }

    // Connect to Deepgram's live streaming WebSocket
    const dgUrl = 'wss://api.deepgram.com/v1/listen?' +
      'model=nova-2&interim_results=false&utterance_end_ms=1500&vad_events=true';

    deepgramSocket = new WebSocket(dgUrl, ['token', token]);

    deepgramSocket.onopen = () => {
      console.log('[OFFSCREEN] Deepgram WebSocket connected');

      // Start MediaRecorder and stream audio data to Deepgram
      const recorder = new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
          deepgramSocket.send(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error('[OFFSCREEN] MediaRecorder error:', event.error.name, event.error.message);
      };

      try {
        recorder.start(250); // Send data every 250ms
        console.log('[OFFSCREEN] MediaRecorder started, streaming to Deepgram');
        mediaRecorder = recorder;
      } catch (err) {
        console.error('[OFFSCREEN] MediaRecorder.start() failed:', err.name, err.message);
      }
    };

    deepgramSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle final transcripts
        if (data.is_final && data.channel?.alternatives?.[0]?.transcript) {
          const transcript = data.channel.alternatives[0].transcript.trim();
          if (transcript.length > 0) {
            console.log('[OFFSCREEN] Final transcript:', transcript);
            chrome.runtime.sendMessage({ type: 'TRANSCRIPT', transcript });
          }
        }
      } catch (e) {
        console.error('[OFFSCREEN] Error parsing Deepgram message:', e.message);
      }
    };

    deepgramSocket.onerror = (event) => {
      console.error('[OFFSCREEN] Deepgram WebSocket error');
    };

    deepgramSocket.onclose = (event) => {
      console.log('[OFFSCREEN] Deepgram WebSocket closed:', event.code, event.reason);
    };

  } catch (err) {
    console.error('[OFFSCREEN] getUserMedia error:', err.name, err.message);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  if (deepgramSocket) {
    if (deepgramSocket.readyState === WebSocket.OPEN) {
      deepgramSocket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    deepgramSocket.close();
    deepgramSocket = null;
  }

  if (captureStream) {
    captureStream.getTracks().forEach(track => track.stop());
    captureStream = null;
  }

  console.log('[OFFSCREEN] Recording stopped');
}
