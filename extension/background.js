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
let bufferStartTime = 0;
let firstFlush = true;
let restartAttempted = false;

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
        /* ignore — offscreen doc may not be ready */
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
      }, 8000);
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
  } else if (message.type === 'STREAM_DIED') {
    if (restartAttempted) {
      console.log('[BACKGROUND] STREAM_DIED received again, already attempted restart — ignoring');
      return;
    }
    restartAttempted = true;
    const tabToRestart = capturingTabId;
    console.log('[BACKGROUND] STREAM_DIED received, attempting restart for tab:', tabToRestart);
    (async () => {
      await stopCapture();
      setTimeout(() => {
        if (!tabToRestart) {
          console.log('[BACKGROUND] No tab to restart, aborting');
          return;
        }
        chrome.tabs.get(tabToRestart, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            console.log('[BACKGROUND] Tab', tabToRestart, 'no longer exists, aborting restart');
            return;
          }
          console.log('[BACKGROUND] Tab still exists, restarting capture');
          startCapture();
        });
      }, 2000);
    })();
  } else if (message.type === 'TRANSCRIPT') {
    if (isPaused) return;
    console.log('[BACKGROUND] Received TRANSCRIPT:', message.transcript);
    if (!transcriptBuffer) bufferStartTime = Date.now();
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
      }, firstFlush ? 5000 : 8000);
    }
  }
});

function flushTranscriptBuffer() {
  if (bufferTimer) {
    clearTimeout(bufferTimer);
    bufferTimer = null;
  }
  const text = transcriptBuffer.trim();
  if (text.length > 0 && text.length < 80 && Date.now() - bufferStartTime < 20000) {
    console.log('[BACKGROUND] Buffer too short (' + text.length + ' chars), deferring flush');
    bufferTimer = setTimeout(() => {
      flushTranscriptBuffer();
    }, 5000);
    return;
  }
  transcriptBuffer = '';
  bufferStartTime = 0;
  if (text.length > 0) {
    console.log('[BACKGROUND] Flushing buffer:', text.length, 'chars');
    firstFlush = false;
    transcriptQueue.push(text);
    if (!isProcessing) processNextTranscript();
  }
}

async function startCapture() {
  if (capturingTabId !== null) {
    console.log('[BACKGROUND] Already capturing, ignoring duplicate START_CAPTURE');
    return;
  }
  restartAttempted = false;
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
            /* ignore — offscreen doc may not be ready */
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
    const histData = await chrome.storage.local.get(['sessionHistory', 'knowledgeBase', 'capturingTabTitle']);
    const sessionHist = histData.sessionHistory || [];
    const kb = histData.knowledgeBase || {};
    const title = capturingTabTitle || histData.capturingTabTitle || '';
    console.log('[BACKGROUND] Saving to KB with source:', title, '| sessionHistory entries:', sessionHist.length);
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
  firstFlush = true;
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
  let transcript = transcriptQueue.shift();

  // Deepgram corrections for commonly misheard historical terms
  transcript = transcript
    .replace(/\b(Aztec\s?Nats|Aztec\sgnats|Azeknats|ASIC\snets|acid\s?nets|ethnic\snets|Assignettes?|Assignets?|esignett?es?|Signats|acidnets)\b/gi, 'Assignats')
    .replace(/dextine/gi, 'XVI');

  console.log('[BACKGROUND] Processing transcript:', transcript);
  incrementUsage('transcripts');

  try {
    // Fetch user profile and engagement history for analyze request
    const storageData = await chrome.storage.local.get(['userProfile', 'likedEntities', 'ignoreList', 'extensionSettings', 'knowledgeBase', 'cardReactions']);
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

    // Build reaction profile from card reactions
    const reactionCounts = { known: 0, new: 0, advanced: 0 };
    (storageData.cardReactions || []).forEach(r => {
      if (reactionCounts[r.reaction] !== undefined) reactionCounts[r.reaction]++;
    });
    const reactionProfile = reactionCounts;

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
        body: JSON.stringify({ transcript, pageTitle: capturingTabTitle, userProfile, tasteProfile, reactionProfile, depth, previousEntities: sessionEntities, sessionContext: sessionTranscript.slice(-2000), knownTerms }),
        signal: analyzeController.signal
      });
    } finally {
      clearTimeout(analyzeTimeout);
    }

    if (!analyzeRes.ok) {
      console.log('[BACKGROUND] Analyze failed, status:', analyzeRes.status, '— retrying in 2s...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      const retryController = new AbortController();
      const retryTimeout = setTimeout(() => retryController.abort(), 10000);
      try {
        analyzeRes = await fetch(`${API_BASE}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript, pageTitle: capturingTabTitle, userProfile, tasteProfile, reactionProfile, depth, previousEntities: sessionEntities, sessionContext: sessionTranscript.slice(-2000), knownTerms }),
          signal: retryController.signal
        });
      } finally {
        clearTimeout(retryTimeout);
      }
      if (!analyzeRes.ok) {
        console.log('[BACKGROUND] Analyze retry also failed, status:', analyzeRes.status, '— skipping');
        processNextTranscript();
        return;
      }
      console.log('[BACKGROUND] Analyze retry succeeded');
    }
    const analyzeData = await analyzeRes.json();
    const entities = analyzeData.entities || [];

    console.log('[BACKGROUND] Analyze response:', JSON.stringify(entities));

    if (entities.length === 0) {
      console.log('[BACKGROUND] No entities found, skipping');
      processNextTranscript();
      return;
    }

    // Fuzzy dedup: filter out entities that are substring matches of previousEntities
    const normalize = (s) => s.toLowerCase().replace(/s$/, '');
    const dedupedEntities = entities.filter(entity => {
      const newTerm = normalize(entity.term || '');
      if (!newTerm) return false;
      const isDup = sessionEntities.some(prev => {
        const prevNorm = normalize(prev);
        return prevNorm.includes(newTerm) || newTerm.includes(prevNorm);
      });
      if (isDup) {
        console.log('[BACKGROUND] Dedup filtered:', entity.term, '(already seen similar in session)');
      }
      return !isDup;
    });

    if (dedupedEntities.length === 0) {
      console.log('[BACKGROUND] All entities filtered by dedup, skipping');
      processNextTranscript();
      return;
    }

    // Step 2: Enrich entities — stocks get price data, others pass through as-is
    const enrichedEntities = await Promise.all(
      dedupedEntities.map(async (entity) => {
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
        sessionEntities.push(term.toLowerCase().replace(/s$/, ''));
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
