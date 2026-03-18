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
let usageTimer = null;
let lastTranscriptSave = 0;

function getUsageKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `usage_${yyyy}-${mm}-${dd}`;
}

async function incrementUsage(field, amount = 1) {
  const key = getUsageKey();
  const data = await chrome.storage.local.get(key);
  const usage = data[key] || { minutes: 0, transcripts: 0, entities: 0, contextFetches: 0 };
  usage[field] = (usage[field] || 0) + amount;
  await chrome.storage.local.set({ [key]: usage });
}

function startUsageTimer() {
  if (usageTimer) return;
  usageTimer = setInterval(() => {
    if (!isPaused) incrementUsage('minutes');
  }, 60000);
}

function stopUsageTimer() {
  if (usageTimer) {
    clearInterval(usageTimer);
    usageTimer = null;
  }
}

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
  } else if (message.type === 'CONTEXT_FETCH') {
    incrementUsage('contextFetches');
  } else if (message.type === 'TRANSCRIPT') {
    if (isPaused) return;
    console.log('[BACKGROUND] Received TRANSCRIPT:', message.transcript);
    transcriptBuffer += (transcriptBuffer ? ' ' : '') + message.transcript;
    sessionTranscript += (sessionTranscript ? ' ' : '') + message.transcript;
    const now = Date.now();
    if (now - lastTranscriptSave > 5000) {
      lastTranscriptSave = now;
      chrome.storage.local.set({ sessionTranscript });
    }
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
  if (capturingTabId !== null) {
    console.log('[BACKGROUND] Already capturing, ignoring duplicate START_CAPTURE');
    return;
  }
  startUsageTimer();
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

  // Save final sessionTranscript before clearing
  chrome.storage.local.set({ sessionTranscript });

  // Increment session count
  try {
    const scData = await chrome.storage.local.get('sessionCount');
    await chrome.storage.local.set({ sessionCount: (scData.sessionCount || 0) + 1 });
  } catch (e) {
    console.error('[BACKGROUND] Session count error:', e.message || e);
  }

  // Save session entities to persistent knowledge base
  try {
    const histData = await chrome.storage.local.get(['sessionHistory', 'knowledgeBase']);
    const sessionHist = histData.sessionHistory || [];
    const kb = histData.knowledgeBase || {};
    const title = capturingTabTitle || '';
    sessionHist.forEach(entry => {
      const term = entry.term;
      if (!term) return;
      const key = term.toLowerCase();
      if (kb[key]) {
        kb[key].timesSeen++;
        kb[key].source = title;
        if (entry.description) kb[key].expanded = true;
      } else {
        kb[key] = {
          term,
          type: entry.type || 'other',
          firstSeen: entry.timestamp || Date.now(),
          timesSeen: 1,
          expanded: !!entry.description,
          source: title
        };
      }
    });
    await chrome.storage.local.set({ knowledgeBase: kb });
    console.log('[BACKGROUND] Knowledge base updated, total terms:', Object.keys(kb).length);
  } catch (e) {
    console.error('[BACKGROUND] Knowledge base update error:', e.message || e);
  }

  // Check if weekly digest is due (7+ days since last)
  try {
    const digestData = await chrome.storage.local.get(['lastDigestDate', 'knowledgeBase']);
    const kb = digestData.knowledgeBase || {};
    const lastDigest = digestData.lastDigestDate || 0;
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (now - lastDigest >= sevenDays && Object.keys(kb).length > 0) {
      const entries = Object.values(kb);
      const weekAgo = now - sevenDays;

      // New terms this week
      const newThisWeek = entries.filter(e => e.firstSeen >= weekAgo);

      // Top 5 most-expanded terms
      const expanded = entries.filter(e => e.expanded).sort((a, b) => b.timesSeen - a.timesSeen).slice(0, 5);

      // Videos by term count
      const videoCounts = {};
      entries.forEach(e => {
        if (e.source) videoCounts[e.source] = (videoCounts[e.source] || 0) + 1;
      });
      const topVideos = Object.entries(videoCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const videoCount = Object.keys(videoCounts).length;

      // Dominant topics
      const typeCounts = {};
      entries.forEach(e => {
        const t = (e.type || 'other').toLowerCase();
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      });
      const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t);

      const typeLabels = {
        concept: 'concepts', event: 'history', person: 'people',
        people: 'people', stock: 'finance', organization: 'organizations',
        commodity: 'commodities', other: 'general'
      };
      const topicSummary = topTypes.map(t => typeLabels[t] || t).join(' & ');

      const weeklyDigest = {
        date: now,
        newTerms: newThisWeek.length,
        videoCount,
        topicSummary,
        topExpanded: expanded.map(e => e.term),
        topVideos: topVideos.map(([title, count]) => ({ title, count })),
        dismissed: false
      };

      await chrome.storage.local.set({ weeklyDigest, lastDigestDate: now });
      console.log('[BACKGROUND] Weekly digest generated:', newThisWeek.length, 'new terms from', videoCount, 'videos');
    }
  } catch (e) {
    console.error('[BACKGROUND] Digest generation error:', e.message || e);
  }

  // Small delay after closing offscreen doc before resetting state
  await new Promise(resolve => setTimeout(resolve, 500));

  capturingTabId = null;
  capturingTabTitle = null;
  pendingStreamId = null;
  sessionEntities = [];
  sessionTranscript = '';
  isPaused = false;
  stopUsageTimer();
  chrome.storage.local.remove('activeTabId');
  chrome.storage.local.set({ capturing: false, sessionHistory: [], sessionTranscript: '' });
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
  incrementUsage('transcripts');

  try {
    // Fetch user profile and engagement history for analyze request
    const storageData = await chrome.storage.local.get(['userProfile', 'likedEntities', 'ignoreList', 'extensionSettings', 'knowledgeBase']);
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
    const knownTerms = Object.values(storageData.knowledgeBase || {}).map(e => e.term);

    // Step 1: Analyze
    const analyzeController = new AbortController();
    const analyzeTimeout = setTimeout(() => analyzeController.abort(), 10000);
    let analyzeRes;
    try {
      analyzeRes = await fetch(`${API_BASE}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, pageTitle: capturingTabTitle, userProfile, tasteProfile, depth, previousEntities: sessionEntities, sessionContext: sessionTranscript.slice(-2000), knownTerms }),
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
    incrementUsage('entities', enrichedEntities.length);
    console.log('[BACKGROUND] Saved pendingEntities to storage, session total:', sessionEntities.length);
  } catch (err) {
    console.error('[BACKGROUND] Processing error:', err.message || err);
  }

  // Process next transcript in queue
  processNextTranscript();
}
