const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

let capturingTabId = null;
let pendingStreamId = null;
let isProcessing = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CAPTURE') {
    startCapture();
  } else if (message.type === 'STOP_CAPTURE') {
    stopCapture();
  } else if (message.type === 'OFFSCREEN_READY') {
    console.log('[BACKGROUND] Offscreen document ready');
    if (pendingStreamId) {
      try {
        chrome.runtime.sendMessage({
          type: 'START_RECORDING',
          streamId: pendingStreamId
        });
        console.log('[BACKGROUND] Sent START_RECORDING to offscreen document');
      } catch (e) {
        console.error('[BACKGROUND] Failed to send START_RECORDING:', e.message || e);
      }
      pendingStreamId = null;
    }
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
    console.log('[BACKGROUND] START_CAPTURE: stored capturingTabId =', capturingTabId, 'url =', tab.url);

    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, async (streamId) => {
      try {
        if (chrome.runtime.lastError) {
          console.error('[BACKGROUND] getMediaStreamId error:', chrome.runtime.lastError.message);
          return;
        }

        console.log('[BACKGROUND] Got streamId');

        const hasDoc = await chrome.offscreen.hasDocument();

        if (hasDoc) {
          console.log('[BACKGROUND] Offscreen document already exists, sending START_RECORDING');
          await new Promise(resolve => setTimeout(resolve, 500));
          try {
            chrome.runtime.sendMessage({
              type: 'START_RECORDING',
              streamId: streamId
            });
            console.log('[BACKGROUND] Sent START_RECORDING to existing offscreen document');
          } catch (e) {
            console.error('[BACKGROUND] Failed to send to existing offscreen:', e.message || e);
          }
        } else {
          console.log('[BACKGROUND] Creating offscreen document');
          pendingStreamId = streamId;

          await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'Capture tab audio for transcription'
          });

          console.log('[BACKGROUND] Offscreen document created, waiting for OFFSCREEN_READY');
        }
      } catch (err) {
        console.error('[BACKGROUND] Offscreen setup error:', err.message || err);
      }
    });
  } catch (err) {
    console.error('[BACKGROUND] Capture error:', err.message || err);
  }
}

async function stopCapture() {
  try {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  } catch (e) {
    // Offscreen doc may already be gone
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // Already closed or doesn't exist
  }

  capturingTabId = null;
  pendingStreamId = null;
  chrome.storage.local.set({ capturing: false });
  console.log('[BACKGROUND] Capture stopped');
}

async function processAudioChunk(base64) {
  console.log('[BACKGROUND] Processing chunk');
  if (isProcessing) { console.log('[BACKGROUND] Skipping chunk - already processing'); return; }
  isProcessing = true;
  console.log('[BACKGROUND] Lock acquired');
  try {
    // Step 1: Transcribe
    const transcribeRes = await fetch(`${API_BASE}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: base64 })
    });

    if (!transcribeRes.ok) {
      console.log('[BACKGROUND] Transcribe failed, status:', transcribeRes.status);
      return;
    }
    const transcribeData = await transcribeRes.json();
    const transcript = transcribeData.transcript;

    console.log('[BACKGROUND] Transcribe response:', transcript);

    if (!transcript || transcript.trim().length === 0) {
      console.log('[BACKGROUND] Empty transcript, skipping');
      return;
    }

    // Step 2: Analyze
    const analyzeRes = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript })
    });

    if (!analyzeRes.ok) {
      console.log('[BACKGROUND] Analyze failed, status:', analyzeRes.status);
      return;
    }
    const analyzeData = await analyzeRes.json();
    const entities = analyzeData.entities || [];

    console.log('[BACKGROUND] Analyze response:', JSON.stringify(entities));

    if (entities.length === 0) {
      console.log('[BACKGROUND] No entities found, skipping');
      return;
    }

    // Step 3: Enrich entities — stocks get price data, others get descriptions
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
        } else if (!entity.description) {
          try {
            const term = entity.term || entity.name || '';
            const contextRes = await fetch(`${API_BASE}/context`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ term })
            });
            if (contextRes.ok) {
              const contextData = await contextRes.json();
              console.log('[BACKGROUND] Context response for', term, ':', JSON.stringify(contextData));
              return { ...entity, description: contextData.description || '' };
            }
          } catch (e) {
            console.error('[BACKGROUND] Context fetch error:', e.message || e);
          }
        }
        return entity;
      })
    );

    // Step 4: Save entities to storage (content script picks them up via onChanged)
    console.log('[BACKGROUND] Step 4: saving', enrichedEntities.length, 'entities to storage');
    await chrome.storage.local.set({ pendingEntities: enrichedEntities, pendingTimestamp: Date.now() });
    console.log('[BACKGROUND] Saved pendingEntities to storage');
  } catch (err) {
    console.error('[BACKGROUND] Processing error:', err.message || err);
  } finally {
    isProcessing = false;
    console.log('[BACKGROUND] Lock released');
  }
}

