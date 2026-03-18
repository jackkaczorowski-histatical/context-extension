const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

let capturingTabId = null;
let capturingTabTitle = null;
let pendingStreamId = null;
let isProcessing = false;
const transcriptQueue = [];
let transcriptBuffer = '';
let bufferTimer = null;
let sessionEntities = [];
let sessionTranscript = '';
let isPaused = false;

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
  } else if (message.type === 'PAUSE_CAPTURE') {
    console.log('[BACKGROUND] Capture paused');
    isPaused = true;
    if (bufferTimer) {
      clearTimeout(bufferTimer);
      bufferTimer = null;
    }
  } else if (message.type === 'RESUME_CAPTURE') {
    console.log('[BACKGROUND] Capture resumed');
    isPaused = false;
    if (transcriptBuffer.trim().length > 0 && !bufferTimer) {
      bufferTimer = setTimeout(() => {
        flushTranscriptBuffer();
      }, 12000);
    }
  } else if (message.type === 'SEEK_DETECTED') {
    console.log('[BACKGROUND] Seek detected, clearing transcript buffer');
    transcriptBuffer = '';
    if (bufferTimer) {
      clearTimeout(bufferTimer);
      bufferTimer = null;
    }
  } else if (message.type === 'TRANSCRIPT') {
    if (isPaused) return;
    console.log('[BACKGROUND] Received TRANSCRIPT:', message.transcript);
    transcriptBuffer += (transcriptBuffer ? ' ' : '') + message.transcript;
    sessionTranscript += (sessionTranscript ? ' ' : '') + message.transcript;
    if (!bufferTimer) {
      bufferTimer = setTimeout(() => {
        flushTranscriptBuffer();
      }, 12000);
    }
  }
});

function flushTranscriptBuffer() {
  if (bufferTimer) {
    clearTimeout(bufferTimer);
    bufferTimer = null;
  }
  const text = transcriptBuffer.trim();
  transcriptBuffer = '';
  if (text.length > 0) {
    console.log('[BACKGROUND] Flushing buffer:', text.length, 'chars');
    transcriptQueue.push(text);
    if (!isProcessing) processNextTranscript();
  }
}

async function startCapture() {
  try {
    // Close any existing offscreen document before proceeding
    try {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) {
        console.log('[BACKGROUND] Existing offscreen document found, closing before restart');
        await chrome.offscreen.closeDocument();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (e) {
      // Ignore — document may not exist
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.error('[BACKGROUND] No active tab found');
      return;
    }

    capturingTabId = tab.id;
    capturingTabTitle = tab.title || '';
    console.log('[BACKGROUND] START_CAPTURE: stored capturingTabId =', capturingTabId, 'title =', capturingTabTitle, 'url =', tab.url);

    // Store activeTabId, URL, title, and sessionStart for content script
    chrome.storage.local.set({
      activeTabId: tab.id,
      activeTabUrl: tab.url,
      capturingTabTitle: capturingTabTitle,
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

  // Flush any remaining buffered transcript
  flushTranscriptBuffer();

  // Small delay after closing offscreen doc before resetting state
  await new Promise(resolve => setTimeout(resolve, 500));

  capturingTabId = null;
  capturingTabTitle = null;
  pendingStreamId = null;
  sessionEntities = [];
  sessionTranscript = '';
  isPaused = false;
  chrome.storage.local.remove('activeTabId');
  chrome.storage.local.set({ capturing: false, sessionHistory: [] });
  console.log('[BACKGROUND] Capture stopped');
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
        body: JSON.stringify({ transcript, pageTitle: capturingTabTitle, userProfile, tasteProfile, depth, previousEntities: sessionEntities, sessionContext: sessionTranscript.slice(-2000) }),
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

    // Step 2: Enrich entities — stocks get price data, others pass through as-is
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
        }
        return entity;
      })
    );

    // Step 3: Save entities to storage (content script picks them up via onChanged)
    console.log('[BACKGROUND] Saving', enrichedEntities.length, 'entities to storage');
    await chrome.storage.local.set({ pendingEntities: enrichedEntities, pendingTimestamp: Date.now() });
    const newHistoryEntries = [];
    enrichedEntities.forEach(e => {
      const term = e.term || e.name || '';
      if (term) {
        sessionEntities.push(term);
        newHistoryEntries.push({ term, type: e.type || 'other', timestamp: Date.now(), description: '' });
      }
    });
    // Append to sessionHistory in storage
    const histData = await chrome.storage.local.get('sessionHistory');
    const history = histData.sessionHistory || [];
    history.push(...newHistoryEntries);
    await chrome.storage.local.set({ sessionHistory: history });
    console.log('[BACKGROUND] Saved pendingEntities to storage, session total:', sessionEntities.length);
  } catch (err) {
    console.error('[BACKGROUND] Processing error:', err.message || err);
  }

  // Process next transcript in queue
  processNextTranscript();
}
