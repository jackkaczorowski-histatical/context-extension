const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

let capturingTabId = null;
let capturingTabTitle = null;
let pendingStreamId = null;
let isProcessing = false;
const transcriptQueue = [];

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
    console.log('[BACKGROUND] Received AUDIO_CHUNK, size:', message.audio?.length);
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
    capturingTabTitle = tab.title || '';
    console.log('[BACKGROUND] START_CAPTURE: stored capturingTabId =', capturingTabId, 'title =', capturingTabTitle, 'url =', tab.url);

    // Store activeTabId, URL, and sessionStart for content script
    chrome.storage.local.set({
      activeTabId: tab.id,
      activeTabUrl: tab.url,
      sessionStart: Date.now()
    });

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
  capturingTabTitle = null;
  pendingStreamId = null;
  transcriptQueue.length = 0;
  chrome.storage.local.remove('activeTabId');
  chrome.storage.local.set({ capturing: false });
  console.log('[BACKGROUND] Capture stopped');
}

async function processAudioChunk(base64Audio) {
  if (!base64Audio) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
      res = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64Audio }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      console.error('[BACKGROUND] Transcribe failed, status:', res.status);
      return;
    }

    const data = await res.json();
    const transcript = (data.transcript || '').trim();

    if (transcript.length === 0) {
      console.log('[BACKGROUND] Empty transcript, skipping');
      return;
    }

    console.log('[BACKGROUND] Transcript:', transcript);
    transcriptQueue.push(transcript);
    if (!isProcessing) processNextTranscript();
  } catch (err) {
    console.error('[BACKGROUND] processAudioChunk error:', err.message || err);
  }
}

async function processNextTranscript() {
  if (transcriptQueue.length === 0) {
    isProcessing = false;
    console.log('[BACKGROUND] Queue empty, lock released');
    return;
  }

  isProcessing = true;
  const transcript = transcriptQueue.shift();
  console.log('[BACKGROUND] Processing transcript:', transcript);

  try {
    // Fetch user profile and engagement history for analyze request
    const storageData = await chrome.storage.local.get(['userProfile', 'likedEntities', 'ignoreList', 'extensionSettings']);
    const userProfile = storageData.userProfile || null;

    // Build taste profile from engagement history
    const likedCounts = {};
    (storageData.likedEntities || []).forEach(e => {
      const t = e.type || 'other';
      likedCounts[t] = (likedCounts[t] || 0) + 1;
    });
    const ignoredCounts = {};
    (storageData.ignoreList || []).forEach(term => {
      ignoredCounts['unknown'] = (ignoredCounts['unknown'] || 0) + 1;
    });
    const tasteProfile = { liked: likedCounts, ignored: ignoredCounts };
    const depth = (storageData.extensionSettings && storageData.extensionSettings.depth) || 2;

    // Step 1: Analyze
    const analyzeController = new AbortController();
    const analyzeTimeout = setTimeout(() => analyzeController.abort(), 10000);
    let analyzeRes;
    try {
      analyzeRes = await fetch(`${API_BASE}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, pageTitle: capturingTabTitle, userProfile, tasteProfile, depth }),
        signal: analyzeController.signal
      });
    } finally {
      clearTimeout(analyzeTimeout);
    }

    if (!analyzeRes.ok) {
      console.log('[BACKGROUND] Analyze failed, status:', analyzeRes.status);
      processNextTranscript();
      return;
    }
    const analyzeData = await analyzeRes.json();
    const entities = analyzeData.entities || [];

    console.log('[BACKGROUND] Analyze response:', JSON.stringify(entities));

    if (entities.length === 0) {
      console.log('[BACKGROUND] No entities found, skipping');
      processNextTranscript();
      return;
    }

    // Step 2: Enrich entities — stocks get price data, others get descriptions
    const enrichedEntities = await Promise.all(
      entities.map(async (entity) => {
        if (entity.type === 'stock') {
          try {
            const stockController = new AbortController();
            const stockTimeout = setTimeout(() => stockController.abort(), 10000);
            let stockRes;
            try {
              stockRes = await fetch(`${API_BASE}/stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker: entity.ticker }),
                signal: stockController.signal
              });
            } finally {
              clearTimeout(stockTimeout);
            }
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
            const profileData = await chrome.storage.local.get('userProfile');
            const ctxController = new AbortController();
            const ctxTimeout = setTimeout(() => ctxController.abort(), 10000);
            let contextRes;
            try {
              contextRes = await fetch(`${API_BASE}/context`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ term, userProfile: profileData.userProfile || null }),
                signal: ctxController.signal
              });
            } finally {
              clearTimeout(ctxTimeout);
            }
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

    // Step 3: Save entities to storage (content script picks them up via onChanged)
    console.log('[BACKGROUND] Saving', enrichedEntities.length, 'entities to storage');
    await chrome.storage.local.set({ pendingEntities: enrichedEntities, pendingTimestamp: Date.now() });
    console.log('[BACKGROUND] Saved pendingEntities to storage');
  } catch (err) {
    console.error('[BACKGROUND] Processing error:', err.message || err);
  }

  // Process next transcript in queue
  processNextTranscript();
}
