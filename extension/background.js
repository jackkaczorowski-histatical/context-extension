const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

let capturingTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CAPTURE') {
    startCapture();
  } else if (message.type === 'STOP_CAPTURE') {
    stopCapture();
  } else if (message.type === 'AUDIO_CHUNK') {
    console.log('[BACKGROUND] Received AUDIO_CHUNK, size:', message.audio.length, 'chars');
    processAudioChunk(message.audio);
  }
});

async function startCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.error('[BACKGROUND] No active tab found');
      return;
    }

    capturingTabId = tab.id;

    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
      if (chrome.runtime.lastError) {
        console.error('[BACKGROUND] getMediaStreamId error:', chrome.runtime.lastError.message);
        return;
      }

      console.log('[BACKGROUND] Got streamId, sending to content script');

      chrome.tabs.sendMessage(tab.id, {
        type: 'START_RECORDING',
        streamId: streamId
      });
    });
  } catch (err) {
    console.error('[BACKGROUND] Capture error:', err.message || err);
  }
}

function stopCapture() {
  if (capturingTabId) {
    chrome.tabs.sendMessage(capturingTabId, { type: 'STOP_RECORDING' });
    capturingTabId = null;
  }
  chrome.storage.local.set({ capturing: false });
  console.log('[BACKGROUND] Capture stopped');
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

    console.log('[BACKGROUND] Transcribe response:', transcript);

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

    console.log('[BACKGROUND] Analyze response:', JSON.stringify(entities));

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
              console.log('[BACKGROUND] Stock response for', entity.ticker, ':', JSON.stringify(stockData));
              return { ...entity, ...stockData };
            }
          } catch (e) {
            console.error('[BACKGROUND] Stock fetch error:', e.message || e);
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
    console.error('[BACKGROUND] Processing error:', err.message || err);
  }
}
