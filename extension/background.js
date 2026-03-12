const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

let capturingTabId = null;
let pendingStreamId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CAPTURE') {
    startCapture();
  } else if (message.type === 'STOP_CAPTURE') {
    stopCapture();
  } else if (message.type === 'OFFSCREEN_READY') {
    console.log('[BACKGROUND] Offscreen document ready');
    if (pendingStreamId) {
      chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        streamId: pendingStreamId
      });
      console.log('[BACKGROUND] Sent START_RECORDING to offscreen document');
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
          chrome.runtime.sendMessage({
            type: 'START_RECORDING',
            streamId: streamId
          });
          console.log('[BACKGROUND] Sent START_RECORDING to existing offscreen document');
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
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });

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

    // Step 4: Send results to content script
    if (capturingTabId) {
      await sendToContentScript(capturingTabId, {
        type: 'CONTEXT_DATA',
        entities: enrichedEntities
      });
    }
  } catch (err) {
    console.error('[BACKGROUND] Processing error:', err.message || err);
  }
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
    injectImmediately: true
  });
  console.log('[BACKGROUND] Content script injected into tab', tabId);
}

async function sendToContentScript(tabId, message) {
  try {
    await injectContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, message);
    console.log('[BACKGROUND] Sent', message.type, 'to tab', tabId);
  } catch (e) {
    console.warn('[BACKGROUND] First send failed, retrying:', e.message || e);
    try {
      await injectContentScript(tabId);
      await new Promise(resolve => setTimeout(resolve, 300));
      await chrome.tabs.sendMessage(tabId, message);
      console.log('[BACKGROUND] Sent', message.type, 'to tab', tabId, '(retry)');
    } catch (e2) {
      console.error('[BACKGROUND] Retry failed:', e2.message || e2);
    }
  }
}
