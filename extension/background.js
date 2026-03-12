const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

let capturingTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CAPTURE') {
    startCapture();
  } else if (message.type === 'STOP_CAPTURE') {
    stopCapture();
  } else if (message.type === 'AUDIO_CHUNK') {
    processAudioChunk(message.audio);
  }
});

async function startCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.error('No active tab found');
      return;
    }

    capturingTabId = tab.id;

    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, async (streamId) => {
      if (chrome.runtime.lastError) {
        console.error('getMediaStreamId error:', chrome.runtime.lastError.message);
        return;
      }

      // Create offscreen document for audio capture
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab audio for transcription'
      });

      // Send streamId to offscreen document
      chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        streamId: streamId
      });

      console.log('Stream ID sent to offscreen document');
    });
  } catch (err) {
    console.error('Capture error:', err);
  }
}

async function stopCapture() {
  // Tell offscreen document to stop recording
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });

  // Close the offscreen document
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // Already closed or doesn't exist
  }

  capturingTabId = null;
  chrome.storage.local.set({ capturing: false });
  console.log('Capture stopped');
}

async function processAudioChunk(base64) {
  try {
    // Step 1: Transcribe
    const transcribeRes = await fetch(`${API_BASE}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: base64 })
    });

    if (!transcribeRes.ok) return;
    const transcribeData = await transcribeRes.json();
    const transcript = transcribeData.transcript;

    if (!transcript || transcript.trim().length === 0) return;

    // Step 2: Analyze
    const analyzeRes = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript })
    });

    if (!analyzeRes.ok) return;
    const analyzeData = await analyzeRes.json();
    const entities = analyzeData.entities || [];

    if (entities.length === 0) return;

    // Step 3: For stock entities, fetch stock data
    const enrichedEntities = await Promise.all(
      entities.map(async (entity) => {
        if (entity.type === 'stock') {
          try {
            const stockRes = await fetch(`${API_BASE}/stock`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ticker: entity.ticker })
            });
            if (stockRes.ok) {
              const stockData = await stockRes.json();
              return { ...entity, ...stockData };
            }
          } catch (e) {
            console.error('Stock fetch error:', e);
          }
        }
        return entity;
      })
    );

    // Step 4: Send to content script
    if (capturingTabId) {
      chrome.tabs.sendMessage(capturingTabId, {
        type: 'CONTEXT_DATA',
        entities: enrichedEntities
      });
    }
  } catch (err) {
    console.error('Processing error:', err);
  }
}
