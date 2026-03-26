const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

const SMALL_WORDS = new Set(['of', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'by', 'as', 'with']);

const GENERIC_TERMS = new Set([
  'money', 'credit', 'debt', 'income', 'spending', 'economy', 'prices',
  'assets', 'growth', 'value', 'market', 'trade', 'cash', 'cost', 'price',
  'profit', 'loss', 'risk', 'wages', 'salary', 'food', 'water', 'land',
  'house', 'car', 'phone', 'energy', 'power', 'oil', 'gas', 'gold',
  'silver', 'time', 'work', 'people', 'business', 'tax', 'taxes',
  'loan', 'interest', 'government', 'bank', 'country', 'world'
]);

function capitalizeTerm(term) {
  if (!term) return term;
  if (term !== term.toLowerCase()) return term;
  return term.split(' ').map((word, i) => {
    if (i > 0 && SMALL_WORDS.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

let capturingTabId = null;
let capturingTabTitle = null;
let pendingStreamId = null;
let isProcessing = false;
const transcriptQueue = [];
let transcriptBuffer = '';
let bufferTimer = null;
let sessionEntities = [];
let sessionInsights = [];
let sessionTranscript = '';
let isPaused = false;
let usageTimer = null;
let lastTranscriptSave = 0;
let bufferStartTime = 0;
let firstFlush = true;
let restartAttempted = false;
let sessionId = null;
let sessionTotal = 0;

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

const SUPPORTED_PLATFORMS = ['youtube.com', 'youtu.be', 'open.spotify.com', 'udemy.com/course', 'podcasts.google.com', 'soundcloud.com', 'anchor.fm', 'buzzsprout.com'];

function isSupportedUrl(url) {
  if (!url) return false;
  return SUPPORTED_PLATFORMS.some(p => url.includes(p));
}

async function reinjectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    console.log('[BACKGROUND] Reinjected content.js into tab', tabId);
  } catch (e) {}
}

// Reinject content script on supported platform navigations (SPA won't re-trigger content_scripts)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isSupportedUrl(tab.url)) {
    reinjectContentScript(tabId);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ capturing: false });
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => { if (tab.url && isSupportedUrl(tab.url)) reinjectContentScript(tab.id); });
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ capturing: false });
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => { if (tab.url && isSupportedUrl(tab.url)) reinjectContentScript(tab.id); });
  });
});

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
          restartAttempted = false;
          return;
        }
        chrome.tabs.get(tabToRestart, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            console.log('[BACKGROUND] Tab', tabToRestart, 'no longer exists, aborting restart');
            restartAttempted = false;
            return;
          }
          // Validate tab is still on a supported page before restarting
          const url = tab.url || '';
          if (!isSupportedUrl(url)) {
            console.log('[BACKGROUND] Tab navigated away from supported platform, aborting restart. URL:', url);
            restartAttempted = false;
            return;
          }
          console.log('[BACKGROUND] Tab still on video, restarting capture');
          startCapture();
          restartAttempted = false;
        });
      }, 2000);
    })();
  } else if (message.type === 'CLEAR_SESSION') {
    console.log('[BACKGROUND] Session cleared by user');
    sessionEntities = [];
    sessionInsights = [];
    sessionTranscript = '';
    transcriptBuffer = '';
    firstFlush = true;
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
      }, firstFlush ? 3000 : 5000);
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
    }, 3000);
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

    // Force-inject content script in case it didn't autoload
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) { /* already injected or no access */ }

    capturingTabId = tab.id;
    capturingTabTitle = tab.title || '';
    console.log('[BACKGROUND] START_CAPTURE: stored capturingTabId =', capturingTabId, 'title =', capturingTabTitle, 'url =', tab.url);

    // Store activeTabId, URL, title, sessionStart, and sessionId for content script
    sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    chrome.storage.local.set({
      activeTabId: tab.id,
      activeTabUrl: tab.url,
      capturingTabTitle: capturingTabTitle,
      capturing: true,
      sessionStart: Date.now(),
      currentSessionId: sessionId
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
  capturingTabId = null;

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
  sessionId = null;
  sessionTotal = 0;
  sessionEntities = [];
  sessionInsights = [];
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
    const storageData = await chrome.storage.local.get(['userProfile', 'likedEntities', 'ignoreList', 'extensionSettings', 'knowledgeBase', 'cardReactions', 'typeCalibration', 'difficultyProfile']);
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

    // Build typeCalibration from reactions (Prompt 6)
    const typeCalibration = storageData.typeCalibration || {};
    // Build difficultyProfile from reactions (Prompt 10)
    const difficultyProfile = storageData.difficultyProfile || {};

    const depth = (storageData.extensionSettings && storageData.extensionSettings.depth) || 2;
    const knownTerms = Object.values(storageData.knowledgeBase || {}).map(e => e.term);

    // Step 1: Analyze (up to 3 attempts, handles both HTTP errors and network failures)
    const analyzeBody = JSON.stringify({ transcript, pageTitle: capturingTabTitle, userProfile, tasteProfile, reactionProfile, depth, previousEntities: sessionEntities, sessionContext: sessionTranscript.slice(-2000), knownTerms, typeCalibration, difficultyProfile });
    const retryDelays = [0, 2000, 4000];
    let analyzeRes;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = retryDelays[attempt];
        console.log(`[BACKGROUND] Analyze failed, retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        analyzeRes = await fetch(`${API_BASE}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: analyzeBody,
          signal: controller.signal
        });
      } catch (fetchErr) {
        clearTimeout(timeout);
        console.log(`[BACKGROUND] Analyze network error on attempt ${attempt + 1}/3:`, fetchErr.message);
        if (attempt === 2) {
          console.log('[BACKGROUND] Analyze failed after 3 attempts (network) — skipping');
          scheduleNext();
          return;
        }
        continue;
      }
      clearTimeout(timeout);
      if (analyzeRes.ok) {
        if (attempt > 0) console.log(`[BACKGROUND] Analyze retry succeeded on attempt ${attempt + 1}`);
        break;
      }
      if (attempt === 2) {
        console.log('[BACKGROUND] Analyze failed after 3 attempts, status:', analyzeRes.status, '— skipping');
        scheduleNext();
        return;
      }
    }
    const analyzeData = await analyzeRes.json();
    const entities = analyzeData.entities || [];
    entities.forEach(e => { if (e.term) e.term = capitalizeTerm(e.term); });
    const insights = (analyzeData.insights || []).slice(0, 1);

    // Strip em dashes from all text fields
    function stripEmDash(s) { return s ? s.replace(/\u2014/g, ' - ').replace(/\s{2,}/g, ' ').trim() : s; }
    entities.forEach(e => {
      if (e.term) e.term = stripEmDash(e.term);
      if (e.description) e.description = stripEmDash(e.description);
    });
    insights.forEach(i => {
      if (i.insight) i.insight = stripEmDash(i.insight);
      if (i.detail) i.detail = stripEmDash(i.detail);
    });

    console.log('[BACKGROUND] Analyze response:', JSON.stringify(entities), 'insights:', JSON.stringify(insights));

    if (entities.length === 0 && insights.length === 0) {
      console.log('[BACKGROUND] No entities or insights found, skipping');
      scheduleNext();
      return;
    }

    // Fuzzy dedup: filter out entities that are substring matches of previousEntities
    const normalize = (s) => s.toLowerCase().replace(/s$/, '');
    const dedupedEntities = entities.filter(entity => {
      const newTerm = normalize(entity.term || '');
      if (!newTerm) return false;
      const isIngredient = entity.type === 'ingredient';
      const isDup = sessionEntities.some(prev => {
        const prevNorm = normalize(prev);
        // Ingredients: exact match only (e.g. "olive oil" vs "extra virgin olive oil" are distinct)
        if (isIngredient) return prevNorm === newTerm;
        return prevNorm.includes(newTerm) || newTerm.includes(prevNorm);
      });
      if (isDup) {
        console.log('[BACKGROUND] Dedup filtered:', entity.term, '(already seen similar in session)');
      }
      return !isDup;
    });

    // Immediately register deduped entities so the next queued chunk sees them
    dedupedEntities.forEach(e => {
      const term = (e.term || e.name || '').toLowerCase().replace(/s$/, '');
      if (term) sessionEntities.push(term);
    });

    // Filter out generic/common single-word terms
    const filteredEntities = dedupedEntities.filter(entity => {
      const term = (entity.term || entity.name || '').trim();
      const words = term.split(/\s+/);
      if (words.length === 1 && GENERIC_TERMS.has(term.toLowerCase())) {
        console.log('[BACKGROUND] Generic term filtered:', term);
        return false;
      }
      if (/^\d{4}$/.test(term)) {
        console.log('[BACKGROUND] Year-only term filtered:', term);
        return false;
      }
      return true;
    });

    // Fuzzy dedup insights, limit to 1 per chunk
    function normalizeInsight(s) {
      return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    }

    function charSimilarity(a, b) {
      if (!a || !b) return 0;
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length > b.length ? a : b;
      let matches = 0;
      for (let i = 0; i <= shorter.length - 4; i++) {
        const chunk = shorter.slice(i, i + 4);
        if (longer.includes(chunk)) matches++;
      }
      const total = shorter.length - 3;
      return total > 0 ? matches / total : 0;
    }

    function isInsightDuplicate(newInsight, prevInsights) {
      const newNorm = normalizeInsight(newInsight);
      const newWords = newNorm.split(' ').filter(Boolean);
      for (const prev of prevInsights) {
        const prevNorm = normalizeInsight(prev);
        const prevWords = prevNorm.split(' ').filter(Boolean);
        // Character-level similarity (4-gram sliding window)
        if (charSimilarity(newNorm, prevNorm) > 0.6) return true;
        // 3-word consecutive sequences
        const prevText = prevWords.join(' ');
        for (let i = 0; i <= newWords.length - 3; i++) {
          const trigram = newWords.slice(i, i + 3).join(' ');
          if (prevText.includes(trigram)) return true;
        }
        // Shared long words (5+ chars): if 3+ match, it's a duplicate
        const newLong = newWords.filter(w => w.length >= 5);
        const prevLongSet = new Set(prevWords.filter(w => w.length >= 5));
        let shared = 0;
        for (const w of newLong) {
          if (prevLongSet.has(w)) shared++;
          if (shared >= 3) return true;
        }
      }
      return false;
    }

    let dedupedInsight = null;
    for (const insight of insights) {
      const newText = insight.insight || '';
      if (!newText) continue;
      if (isInsightDuplicate(newText, sessionInsights)) {
        console.log('[BACKGROUND] Insight dedup filtered:', insight.insight);
        continue;
      }
      dedupedInsight = insight;
      break;
    }
    const dedupedInsights = dedupedInsight ? [dedupedInsight] : [];
    if (dedupedInsight) {
      sessionInsights.push(dedupedInsight.insight || '');
    }

    if (filteredEntities.length === 0 && dedupedInsights.length === 0) {
      console.log('[BACKGROUND] All entities and insights filtered, skipping');
      scheduleNext();
      return;
    }

    // Step 2: Enrich entities — stocks get price data, others pass through as-is
    const enrichedEntities = await Promise.all(
      filteredEntities.map(async (entity) => {
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

    // Step 3: Build history entries, then save everything to storage
    // (sessionEntities and sessionInsights were already pushed synchronously after dedup)
    const sessionStartData = await chrome.storage.local.get('sessionStart');
    const elapsedSeconds = sessionStartData.sessionStart ? Math.floor((Date.now() - sessionStartData.sessionStart) / 1000) : 0;

    const newHistoryEntries = [];
    enrichedEntities.forEach(e => {
      const term = e.term || e.name || '';
      if (term) {
        newHistoryEntries.push({ term, type: e.type || 'other', timestamp: Date.now(), description: e.description || '', elapsedSeconds });
      }
    });
    dedupedInsights.forEach(i => {
      newHistoryEntries.push({ term: i.insight, type: 'insight', timestamp: Date.now(), description: i.detail, category: i.category, elapsedSeconds });
    });

    // Save pending entities/insights for content script (onChanged) and append to sessionHistory
    console.log('[BACKGROUND] Saving', enrichedEntities.length, 'entities and', dedupedInsights.length, 'insights to storage');
    const histData = await chrome.storage.local.get('sessionHistory');
    const history = histData.sessionHistory || [];
    history.push(...newHistoryEntries);
    await chrome.storage.local.set({ pendingEntities: enrichedEntities, pendingInsights: dedupedInsights, pendingTimestamp: Date.now(), pendingSessionId: sessionId, sessionHistory: history });
    incrementUsage('entities', enrichedEntities.length + dedupedInsights.length);
    sessionTotal += enrichedEntities.length + dedupedInsights.length;
    console.log('[BACKGROUND] Saved to storage, session total:', sessionTotal);
  } catch (err) {
    console.error('[BACKGROUND] Processing error:', err.message || err);
  }

  // Process next transcript in queue with rate limiting
  scheduleNext();
}

function scheduleNext() {
  setTimeout(() => processNextTranscript(), transcriptQueue.length > 0 ? 1000 : 0);
}

// --- Reaction-driven calibration (Prompts 6 & 10) ---
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.cardReactions) return;
  const reactions = changes.cardReactions.newValue || [];
  if (reactions.length === 0) return;

  // Build typeCalibration: { concept: { knewThis: N, tooAdvanced: N }, ... }
  const typeCal = {};
  reactions.forEach(r => {
    const type = (r.type || 'other').toLowerCase();
    if (!typeCal[type]) typeCal[type] = { knewThis: 0, tooAdvanced: 0, newToMe: 0 };
    if (r.reaction === 'known') typeCal[type].knewThis++;
    else if (r.reaction === 'advanced') typeCal[type].tooAdvanced++;
    else if (r.reaction === 'new') typeCal[type].newToMe++;
  });

  // Build difficultyProfile: { tooEasy: [...], tooHard: [...], balanced: [...] }
  const diffProfile = { tooEasy: [], tooHard: [], balanced: [] };
  for (const [type, counts] of Object.entries(typeCal)) {
    const total = counts.knewThis + counts.tooAdvanced + counts.newToMe;
    if (total < 5) continue;
    if (counts.knewThis > 0 && counts.tooAdvanced > 0) {
      const knewRatio = counts.knewThis / counts.tooAdvanced;
      const advRatio = counts.tooAdvanced / counts.knewThis;
      if (knewRatio > 3) diffProfile.tooEasy.push(type);
      else if (advRatio > 2) diffProfile.tooHard.push(type);
      else diffProfile.balanced.push(type);
    } else if (counts.knewThis >= 5) {
      diffProfile.tooEasy.push(type);
    } else if (counts.tooAdvanced >= 5) {
      diffProfile.tooHard.push(type);
    } else {
      diffProfile.balanced.push(type);
    }
  }

  chrome.storage.local.set({ typeCalibration: typeCal, difficultyProfile: diffProfile });
});
