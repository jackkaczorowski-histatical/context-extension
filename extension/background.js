importScripts('config.js');

self.addEventListener('error', (event) => {
  fetch(`${CONFIG.API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
    body: JSON.stringify({
      type: 'extension_error',
      error: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      timestamp: new Date().toISOString()
    })
  }).catch(() => {});
});

self.addEventListener('unhandledrejection', (event) => {
  fetch(`${CONFIG.API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
    body: JSON.stringify({
      type: 'extension_error',
      error: event.reason?.message || String(event.reason),
      timestamp: new Date().toISOString()
    })
  }).catch(() => {});
});

async function checkServerStatus(tabId) {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/status`);
    if (!res.ok) return true; // fail open
    const data = await res.json();
    if (data.enabled === false || data.maintenance === true) {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: 'MAINTENANCE_MODE',
          message: data.message || 'Context is temporarily offline for maintenance. We\'ll be back shortly.'
        }).catch(() => {});
      }
      return false;
    }
    if (data.minVersion) {
      const currentVersion = chrome.runtime.getManifest().version;
      if (compareVersions(currentVersion, data.minVersion) < 0) {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'FORCE_UPDATE',
            message: 'Please update Context to the latest version.'
          }).catch(() => {});
        }
        return false;
      }
    }
    return true;
  } catch {
    return true; // fail open
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

const SMALL_WORDS = new Set(['of', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'by', 'as', 'with']);

const GENERIC_TERMS = new Set([
  'money', 'credit', 'debt', 'income', 'spending', 'economy', 'prices',
  'assets', 'growth', 'value', 'market', 'trade', 'cash', 'cost', 'price',
  'profit', 'loss', 'risk', 'wages', 'salary', 'food', 'water', 'land',
  'house', 'car', 'phone', 'energy', 'power', 'oil', 'gas', 'gold',
  'silver', 'time', 'work', 'people', 'business', 'tax', 'taxes',
  'loan', 'interest', 'government', 'bank', 'country', 'world',
  'europe', 'asia', 'africa', 'america'
]);

const INDEX_TO_ETF = {
  's&p': { ticker: 'SPY', name: 'SPDR S&P 500 ETF' },
  's&p 500': { ticker: 'SPY', name: 'SPDR S&P 500 ETF' },
  'nasdaq': { ticker: 'QQQ', name: 'Invesco QQQ Trust' },
  'dow': { ticker: 'DIA', name: 'SPDR Dow Jones ETF' },
  'dow jones': { ticker: 'DIA', name: 'SPDR Dow Jones ETF' },
  'russell 2000': { ticker: 'IWM', name: 'iShares Russell 2000 ETF' },
  'russell': { ticker: 'IWM', name: 'iShares Russell 2000 ETF' }
};

async function resolveTickerFromName(name) {
  try {
    const resp = await fetch(`${CONFIG.API_BASE}/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
      body: JSON.stringify({ ticker: name })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.ticker) {
      console.log('[BACKGROUND] Resolved ticker:', name, '→', data.ticker);
      return data.ticker;
    }
    return null;
  } catch (e) {
    console.log('[BACKGROUND] Ticker resolution failed for:', name);
    return null;
  }
}

async function fetchWikiThumbnail(term) {
  try {
    const encoded = encodeURIComponent(term.replace(/ /g, '_'));
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.thumbnail && data.thumbnail.source && data.thumbnail.width >= 200 && !data.thumbnail.source.includes('/Flag_of')) {
      return data.thumbnail.source;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function isLikelyAd(text) {
  const lower = text.toLowerCase();
  const adPatterns = [
    /use code \w+/i,
    /percent off/i,
    /\d+% off/i,
    /\.com\/\w+/i,
    /promo code/i,
    /check them out at/i,
    /head to \w+\.com/i,
    /free shipping/i,
    /limited time only/i,
    /click the link/i,
    /use my link/i,
    /sponsor/i,
    /discount code/i
  ];
  let matches = 0;
  for (const pattern of adPatterns) {
    if (pattern.test(lower)) matches++;
  }
  return matches >= 2;
}

function capitalizeTerm(term) {
  if (!term) return term;
  if (term !== term.toLowerCase()) return term;
  return term.split(' ').map((word, i) => {
    if (i > 0 && SMALL_WORDS.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function extractYouTubeId(url) {
  if (!url) return null;
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
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
let lastTranscriptSave = 0;
let bufferStartTime = 0;
let firstFlush = true;
let restartAttempted = false;
let sessionId = null;
let sessionTotal = 0;
let sidebarOpen = false;
let isStoppingCapture = false;
let isStartingCapture = false;
let lastAnalyzeFailed = false;
let captureStartTime = null;
let eventQueue = [];
let eventFlushTimer = null;
let knowledgeState = {};
let topicAffinities = {};
let entityPackCache = {}; // { normalizedTerm: entityObject } — loaded from pack
let dismissedTerms = new Set(); // terms dismissed by user this session
let lastSessionCardsExpanded = 0; // updated by SESSION_METRICS from content.js

function trackEvent(eventName, properties = {}) {
  chrome.storage.local.get(['installId', 'user'], (data) => {
    eventQueue.push({
      event: eventName,
      properties,
      installId: data.installId || null,
      userId: data.user?.id || null,
      timestamp: Date.now()
    });
    if (eventQueue.length >= 20) {
      flushEvents();
    } else if (!eventFlushTimer) {
      eventFlushTimer = setTimeout(() => flushEvents(), 30000);
    }
  });
}

function flushEvents() {
  if (eventFlushTimer) {
    clearTimeout(eventFlushTimer);
    eventFlushTimer = null;
  }
  if (eventQueue.length === 0) return;
  const batch = eventQueue.splice(0);
  fetch(`${CONFIG.API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
    body: JSON.stringify({ events: batch })
  }).catch(err => {
    console.error('[BACKGROUND] Event flush failed:', err.message);
  });
}

function recalcFamiliarity(key) {
  const e = knowledgeState[key];
  if (!e) return;

  let score = 0;
  if (e.timesKnewThis > 0) score += 0.4;
  if (e.timesNewToMe > 0) score -= 0.1;
  score += Math.min(e.timesSeen * 0.05, 0.2);
  if (e.timesExpanded > 0) {
    const avgDwell = e.totalDwellMs / e.timesExpanded;
    if (avgDwell > 10000) score += 0.15;
    else if (avgDwell > 3000) score += 0.1;
    else score += 0.05;
  }
  if (e.timesTellMeMore > 0) score += 0.1;
  const daysSinceLastSeen = (Date.now() - e.lastSeen) / (1000 * 60 * 60 * 24);
  if (daysSinceLastSeen > 30) score -= 0.15;
  else if (daysSinceLastSeen > 14) score -= 0.08;
  else if (daysSinceLastSeen > 7) score -= 0.03;
  e.familiarity = Math.max(0, Math.min(1, score));
}

function debounceSaveKnowledgeState() {
  clearTimeout(knowledgeState._saveTimer);
  knowledgeState._saveTimer = setTimeout(() => {
    const toSave = { ...knowledgeState };
    delete toSave._saveTimer;
    chrome.storage.local.set({ knowledgeState: toSave });
  }, 5000);
}

function updateKnowledgeState(entities) {
  const now = Date.now();
  entities.forEach(e => {
    const key = (e.term || e.name || '').toLowerCase().trim();
    if (!key) return;
    if (!knowledgeState[key]) {
      knowledgeState[key] = {
        term: e.term || e.name,
        type: e.type,
        timesSeen: 0,
        timesExpanded: 0,
        timesNewToMe: 0,
        timesKnewThis: 0,
        timesTellMeMore: 0,
        totalDwellMs: 0,
        familiarity: 0.0,
        firstSeen: now,
        lastSeen: now
      };
    }
    const entry = knowledgeState[key];
    entry.timesSeen++;
    entry.lastSeen = now;
  });
  debounceSaveKnowledgeState();
}

function classifyTopic(entity) {
  const term = (entity.term || '').toLowerCase();
  const desc = (entity.description || '').toLowerCase();
  const type = (entity.type || '').toLowerCase();

  if (type === 'stock') return 'finance';
  if (type === 'legislation') return 'politics';
  if (type === 'metric') return 'economics';

  const text = term + ' ' + desc;
  const topicKeywords = {
    finance: ['bank', 'stock', 'market', 'trading', 'investment', 'gdp', 'inflation', 'federal reserve', 'interest rate', 'bond', 'currency', 'fiscal', 'monetary', 'wall street', 'hedge fund', 'etf', 'dividend'],
    history: ['century', 'empire', 'dynasty', 'war', 'treaty', 'revolution', 'kingdom', 'colonial', 'medieval', 'ancient', 'monarch', 'reign', 'conquest', 'republic', 'civilization'],
    science: ['theory', 'experiment', 'research', 'molecule', 'atom', 'gene', 'evolution', 'species', 'quantum', 'gravity', 'cell', 'dna', 'protein', 'climate', 'physics', 'biology', 'chemistry'],
    technology: ['algorithm', 'software', 'hardware', 'ai', 'machine learning', 'blockchain', 'crypto', 'internet', 'computing', 'data', 'startup', 'silicon valley', 'programming'],
    politics: ['president', 'congress', 'senate', 'legislation', 'policy', 'election', 'democrat', 'republican', 'parliament', 'prime minister', 'diplomat', 'sanction', 'nato', 'united nations'],
    culture: ['film', 'music', 'art', 'literature', 'novel', 'album', 'director', 'artist', 'museum', 'fashion', 'architecture', 'philosophy', 'religion'],
    economics: ['trade', 'tariff', 'supply', 'demand', 'labor', 'wage', 'tax', 'debt', 'deficit', 'surplus', 'recession', 'depression', 'boom', 'bust', 'inequality']
  };

  let bestTopic = 'general';
  let bestScore = 0;
  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }
  return bestTopic;
}

function computeSessionStats() {
  const typeCounts = {};
  const topicCounts = {};

  sessionEntities.forEach(termStr => {
    const ks = knowledgeState[termStr];
    const type = ks ? (ks.type || 'unknown') : 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;

    const entity = ks ? { term: ks.term, type: ks.type, description: '' } : { term: termStr, type: '', description: '' };
    const topic = classifyTopic(entity);
    topicCounts[topic] = (topicCounts[topic] || 0) + 1;
  });

  const dominantTopic = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])[0];

  return {
    totalEntities: sessionEntities.length,
    totalInsights: sessionInsights.length,
    dominantTopic: dominantTopic ? dominantTopic[0] : 'general',
    topicBreakdown: topicCounts,
    typeBreakdown: typeCounts,
    knowledgeBaseSize: Object.keys(knowledgeState).filter(k => k !== '_saveTimer').length
  };
}

function updateTopicAffinities() {
  const sessionTopics = {};
  sessionEntities.forEach(termStr => {
    const ks = knowledgeState[termStr];
    const entity = ks ? { term: ks.term, type: ks.type, description: '' } : { term: termStr, type: '', description: '' };
    const topic = classifyTopic(entity);
    sessionTopics[topic] = (sessionTopics[topic] || 0) + 1;
  });

  const totalEntities = Object.values(sessionTopics).reduce((a, b) => a + b, 0);
  if (totalEntities === 0) return;

  for (const [topic, count] of Object.entries(sessionTopics)) {
    const sessionWeight = count / totalEntities;
    if (!topicAffinities[topic]) {
      topicAffinities[topic] = { score: 0, sessions: 0, lastSession: Date.now() };
    }
    const ta = topicAffinities[topic];
    ta.score = ta.score * 0.7 + sessionWeight * 0.3;
    ta.sessions++;
    ta.lastSession = Date.now();
  }

  for (const [topic, ta] of Object.entries(topicAffinities)) {
    if (!sessionTopics[topic]) {
      ta.score *= 0.95;
    }
  }

  chrome.storage.local.set({ topicAffinities });
  console.log('[BACKGROUND] Topic affinities updated:', JSON.stringify(topicAffinities));
}

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

  // Piggyback usage cap on transcript processing (survives service worker restarts)
  if (field === 'transcripts') {
    chrome.storage.local.get([key, 'user', 'analytics'], (capData) => {
      const user = capData.user;
      if (user && user.plan === 'pro') return;
      const installDate = (capData.analytics || {}).installDate || 0;
      if ((Date.now() - installDate) / (1000 * 60 * 60 * 24) < 3) return;

      const minutes = (capData[key] || {}).minutes || 0;

      if (minutes === 25 && capturingTabId) {
        chrome.tabs.sendMessage(capturingTabId, { type: 'USAGE_WARNING', minutesLeft: 5 }).catch(() => {});
      }
      if (minutes >= 30) {
        const tabToNotify = capturingTabId;
        if (tabToNotify) {
          chrome.tabs.sendMessage(tabToNotify, { type: 'USAGE_LIMIT_REACHED', minutes }).catch(() => {});
          chrome.tabs.sendMessage(tabToNotify, {
            type: 'SHOW_UPGRADE',
            message: 'You\'ve used your 30 free minutes today. Upgrade to Pro for unlimited listening.'
          }).catch(() => {});
        }
        stopCapture();
      }
    });
  }
}

function startUsageTimer() {
  chrome.alarms.create('usageCapCheck', { periodInMinutes: 1 });
  console.log('[BACKGROUND] Usage cap alarm started');
}

function stopUsageTimer() {
  chrome.alarms.clear('usageCapCheck');
  console.log('[BACKGROUND] Usage cap alarm stopped');
}

const SUPPORTED_PLATFORMS = ['youtube.com', 'youtu.be', 'open.spotify.com', 'udemy.com/course', 'podcasts.google.com', 'soundcloud.com', 'anchor.fm', 'buzzsprout.com'];

function isSupportedUrl(url) {
  if (!url) return false;
  return SUPPORTED_PLATFORMS.some(p => url.includes(p));
}

async function reinjectContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    // Content script already running, skip
  } catch (e) {
    // Content script not running, inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      console.log('[BACKGROUND] Reinjected content.js into tab', tabId);
    } catch (e2) {}
  }
}

// Reinject content script on supported platform navigations (SPA won't re-trigger content_scripts)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isSupportedUrl(tab.url)) {
    reinjectContentScript(tabId);
  }

  // Reopen sidebar / auto-start capture after suggested video navigation
  if (changeInfo.status === 'complete') {
    chrome.storage.local.get(['reopenSidebar', 'autoStartCapture'], (data) => {
      if (data.reopenSidebar) {
        chrome.storage.local.remove('reopenSidebar');
        chrome.tabs.sendMessage(tabId, { type: 'OPEN_SIDEBAR' }).catch(() => {});
      }
      if (data.autoStartCapture) {
        chrome.storage.local.remove('autoStartCapture');
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: 'OPEN_SIDEBAR' }).catch(() => {});
          setTimeout(() => startCapture(), 1500);
        }, 500);
      }
    });
  }

  // Show ready badge on supported pages when not capturing
  if (changeInfo.status === 'complete' && tab.url && !capturingTabId) {
    if (isSupportedUrl(tab.url)) {
      chrome.action.setBadgeText({ text: '●', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#14b8a6', tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
    }
  }

  // Detect video switch via URL change (not title — titles are too noisy)
  if (tabId === capturingTabId && changeInfo.url) {
    const newUrl = changeInfo.url;
    chrome.storage.local.get('activeTabUrl', (data) => {
      const oldUrl = data.activeTabUrl || '';
      const getVideoId = (url) => {
        try {
          const u = new URL(url);
          return u.hostname + u.pathname + (u.searchParams.get('v') || '');
        } catch (e) { return url; }
      };
      if (oldUrl && getVideoId(newUrl) !== getVideoId(oldUrl)) {
        // Read sessionHistory and capturingTabTitle from storage for reliability
        chrome.storage.local.get(['sessionHistory', 'capturingTabTitle'], (histData) => {
          const history = histData.sessionHistory || [];
          const previousTitle = histData.capturingTabTitle || capturingTabTitle || '';

          history.push({
            type: 'video-divider',
            term: previousTitle,
            description: '',
            url: oldUrl,
            timestamp: Date.now()
          });

          capturingTabTitle = tab?.title || '';

          chrome.storage.local.set({
            sessionHistory: history,
            previousVideoTitle: previousTitle,
            previousVideoUrl: oldUrl,
            videoSwitched: Date.now(),
            capturingTabTitle: capturingTabTitle,
            activeTabUrl: newUrl
          });

          console.log('[BACKGROUND] Video switched:', oldUrl, '->', newUrl);
        });
      }
    });
  }
});

// Save session and stop capture when capturing tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturingTabId) {
    console.log('[BACKGROUND] Capturing tab closed, saving session and stopping capture');
    stopCapture();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'usageCapCheck') {
    const capData = await chrome.storage.local.get('capturingTabId');
    const activeTabId = capturingTabId || capData.capturingTabId;
    if (!activeTabId) return;
    await incrementUsage('minutes');
    const usageKey = getUsageKey();
    chrome.storage.local.get([usageKey, 'user', 'analytics'], (data) => {
      const user = data.user;
      if (user && user.plan === 'pro') return;
      const installDate = (data.analytics || {}).installDate || 0;
      if ((Date.now() - installDate) / (1000 * 60 * 60 * 24) < 3) return;

      const usage = data[usageKey] || { minutes: 0 };
      const minutes = usage.minutes || 0;
      console.log('[BACKGROUND] Usage cap check: ' + minutes + ' minutes today');

      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: 'USAGE_UPDATE', minutes: minutes, limit: 30 }).catch(() => {});
      }
      if (minutes >= 25 && activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: 'USAGE_WARNING', minutesLeft: 30 - minutes }).catch(() => {});
      }
      if (minutes >= 30) {
        console.log('[BACKGROUND] Daily usage limit reached:', minutes, 'minutes');
        const tabToNotify = activeTabId;
        if (tabToNotify) {
          chrome.tabs.sendMessage(tabToNotify, { type: 'USAGE_LIMIT_REACHED', minutes: minutes }).catch(() => {});
          chrome.tabs.sendMessage(tabToNotify, {
            type: 'SHOW_UPGRADE',
            message: 'You\'ve used your 30 free minutes today. Upgrade to Pro for unlimited listening.'
          }).catch(() => {});
        }
        stopCapture();
      }
    });
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.set({ capturing: false });
  // Show NEW badge on first install
  if (details.reason === 'install') {
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#14b8a6' });
  }
  // Generate anonymous install ID if not present
  chrome.storage.local.get('installId', (data) => {
    if (!data.installId) {
      const installId = 'ctx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      chrome.storage.local.set({ installId });
      console.log('[BACKGROUND] Generated installId:', installId);
    }
  });
  chrome.storage.local.get(['knowledgeState', 'topicAffinities', 'sessionEntities'], (data) => {
    knowledgeState = data.knowledgeState || {};
    topicAffinities = data.topicAffinities || {};
    sessionEntities = data.sessionEntities || [];
  });
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => { if (tab.url && isSupportedUrl(tab.url)) reinjectContentScript(tab.id); });
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ capturing: false });
  chrome.storage.local.get(['knowledgeState', 'topicAffinities', 'sessionEntities'], (data) => {
    knowledgeState = data.knowledgeState || {};
    topicAffinities = data.topicAffinities || {};
    sessionEntities = data.sessionEntities || [];
  });
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => { if (tab.url && isSupportedUrl(tab.url)) reinjectContentScript(tab.id); });
  });
  checkServerStatus();
});

// Extension icon click toggles sidebar (no popup)
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
});

// Keyboard shortcut: Ctrl+Shift+L toggles sidebar
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-sidebar') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' });
      }
    });
  }
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
    // Re-inject content script after seek to ensure sidebar connection
    if (capturingTabId) {
      chrome.tabs.sendMessage(capturingTabId, { type: 'PING' }).catch(() => {
        console.log('[BACKGROUND] Content script disconnected after seek, reinjecting');
        chrome.scripting.executeScript({ target: { tabId: capturingTabId }, files: ['content.js'] });
      });
    }
  } else if (message.type === 'DG_ERROR' || message.type === 'DG_RECONNECTING') {
    if (capturingTabId) {
      chrome.tabs.sendMessage(capturingTabId, { type: 'CONNECTION_ERROR', service: 'transcription', retrying: true }).catch(() => {});
    }
  } else if (message.type === 'DG_CONNECTED') {
    // Only send restored if we previously sent an error (first connect is not a restore)
    if (capturingTabId) {
      chrome.tabs.sendMessage(capturingTabId, { type: 'CONNECTION_RESTORED', service: 'transcription' }).catch(() => {});
    }
  } else if (message.type === 'CONTEXT_FETCH') {
    incrementUsage('contextFetches');
    trackEvent('tell_me_more', { term: message.term || '' });
    // Track tell-me-more in local analytics
    chrome.storage.local.get('analytics', (data) => {
      const analytics = data.analytics || {};
      analytics.totalTellMeMore = (analytics.totalTellMeMore || 0) + 1;
      chrome.storage.local.set({ analytics });
    });
    const tmKey = (message.term || '').toLowerCase().trim();
    if (knowledgeState[tmKey]) {
      knowledgeState[tmKey].timesTellMeMore++;
      recalcFamiliarity(tmKey);
      debounceSaveKnowledgeState();
    }
  } else if (message.type === 'STREAM_DIED') {
    if (restartAttempted) {
      console.log('[BACKGROUND] STREAM_DIED received again, already attempted restart — ignoring');
      return;
    }
    restartAttempted = true;
    const tabToRestart = capturingTabId;
    console.log('[BACKGROUND] STREAM_DIED received, attempting restart for tab:', tabToRestart);
    if (tabToRestart) {
      chrome.tabs.sendMessage(tabToRestart, { type: 'CONNECTION_ERROR', service: 'audio', retrying: true }).catch(() => {});
    }
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
          chrome.tabs.sendMessage(tabToRestart, { type: 'CONNECTION_RESTORED', service: 'audio' }).catch(() => {});
          restartAttempted = false;
        });
      }, 2000);
    })();
  } else if (message.type === 'CLEAR_SESSION') {
    console.log('[BACKGROUND] Session cleared by user');
    trackEvent('session_clear', { entities_count: sessionEntities.length });
    chrome.storage.local.get(['sessionHistory', 'knowledgeBase', 'pastSessions', 'dataConsent', 'installId', 'user', 'activeTabUrl', 'capturingTabTitle'], (data) => {
      const sessionHist = data.sessionHistory || [];
      const kb = data.knowledgeBase || {};

      // 1. Save session entities to KB
      if (sessionHist.length > 0) {
        sessionHist.forEach(item => {
          if (item.term && item.type !== 'video-divider' && item.type !== 'insight') {
            const key = item.term.toLowerCase();
            if (!kb[key]) {
              kb[key] = { term: item.term, type: item.type, description: item.description, firstSeen: item.timestamp || Date.now(), sessionCount: 1 };
            } else {
              kb[key].sessionCount = (kb[key].sessionCount || 0) + 1;
            }
          }
        });
        console.log('[BACKGROUND] KB saved before clear, total terms:', Object.keys(kb).length);
      }

      // 2. Save session snapshot to pastSessions (skip if stopCapture already saved it)
      const pastSessions = data.pastSessions || [];
      const recentlySaved = pastSessions.length > 0 &&
        (Date.now() - new Date(pastSessions[0].date).getTime()) < 60000;
      if (sessionHist.length > 0 && !recentlySaved) {
        pastSessions.unshift({
          id: Date.now(),
          title: data.capturingTabTitle || capturingTabTitle || 'Untitled',
          url: data.activeTabUrl || '',
          date: new Date().toISOString(),
          entityCount: sessionHist.filter(i => i.term && i.type !== 'video-divider' && i.type !== 'insight').length,
          insightCount: sessionHist.filter(i => i.type === 'insight').length,
          entities: sessionHist.filter(i => i.term && i.type !== 'video-divider' && i.type !== 'insight').slice(0, 50),
          insights: sessionHist.filter(i => i.type === 'insight').slice(0, 30),
          timestamp: Date.now()
        });
        if (pastSessions.length > 20) pastSessions.length = 20;
        console.log('[BACKGROUND] Session snapshot saved on clear, total past sessions:', pastSessions.length);
      }

      // 2b. Send session data to Supabase if user consented
      if (data.dataConsent && sessionHist.length > 0) {
        const filteredEntities = sessionHist.filter(i => i.term && i.type !== 'insight' && i.type !== 'video-divider');
        fetch(`${CONFIG.API_BASE}/session-data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
          body: JSON.stringify({
            installId: data.installId || null,
            userId: data.user?.id || null,
            videoTitle: data.capturingTabTitle || capturingTabTitle || 'Untitled',
            videoUrl: data.activeTabUrl || '',
            transcript: sessionTranscript,
            durationSeconds: captureStartTime ? Math.round((Date.now() - captureStartTime) / 1000) : 0,
            entities: filteredEntities.map(e => ({
              term: e.term,
              type: e.type,
              description: e.description || ''
            })),
            entityCount: filteredEntities.length
          })
        }).catch(err => {
          console.error('[BACKGROUND] Session data upload failed:', err.message);
        });
      }

      // 3. Save KB and pastSessions, then clear session data
      chrome.storage.local.set({ knowledgeBase: kb, pastSessions }, () => {
        chrome.storage.local.remove(['sessionHistory', 'pendingEntities', 'pendingInsights', 'sessionTranscript', 'sessionEntities']);
        sessionTotal = 0;
        chrome.action.setBadgeText({ text: '' });
      });
    });
    sessionEntities = [];
    sessionInsights = [];
    sessionTranscript = '';
    transcriptBuffer = '';
    dismissedTerms.clear();
    firstFlush = true;
  } else if (message.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id });
    return true;
  } else if (message.type === 'TOGGLE_CAPTURE') {
    const toggleUsageKey = getUsageKey();
    chrome.storage.local.get(['capturing', toggleUsageKey, 'user', 'analytics'], async (data) => {
      if (data.capturing) {
        await stopCapture();
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'CAPTURE_STATE', capturing: false });
      } else {
        // Check server status before starting
        const statusOk = await checkServerStatus(sender.tab?.id);
        if (!statusOk) return;
        // Check daily cap before starting — exempt pro users and trial users
        const user = data.user;
        const isPro = user && user.plan === 'pro';
        const installDate = (data.analytics || {}).installDate || 0;
        const inTrial = (Date.now() - installDate) / (1000 * 60 * 60 * 24) < 3;
        if (!isPro && !inTrial) {
          const minutes = (data[toggleUsageKey] || {}).minutes || 0;
          if (minutes >= 30) {
            if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'USAGE_LIMIT_REACHED', minutes });
            return;
          }
        }
        await startCapture();
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'CAPTURE_STATE', capturing: true });
      }
    });
  } else if (message.type === 'GOOGLE_SIGN_IN') {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        console.error('[BACKGROUND] Google sign-in failed:', chrome.runtime.lastError.message);
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'SIGN_IN_ERROR', error: chrome.runtime.lastError.message }).catch(() => {});
        return;
      }
      fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + token }
      })
      .then(r => r.json())
      .then(async (userInfo) => {
        const user = {
          id: userInfo.sub,
          email: userInfo.email,
          name: userInfo.name,
          picture: userInfo.picture,
          token: token,
          signedInAt: Date.now(),
          plan: 'free',
          minutesLimit: 30
        };
        // Sync with backend before notifying content script
        try {
          const installData = await chrome.storage.local.get('installId');
          const syncRes = await fetch(`${CONFIG.API_BASE}/auth-sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
            body: JSON.stringify({
              googleId: userInfo.sub,
              email: userInfo.email,
              name: userInfo.name,
              picture: userInfo.picture,
              installId: installData.installId || null
            })
          });
          if (syncRes.ok) {
            const syncData = await syncRes.json();
            user.plan = syncData.plan || 'free';
            user.minutesLimit = syncData.minutesLimit || 30;
            user.subscriptionStatus = syncData.subscriptionStatus || null;
            user.planExpiresAt = syncData.planExpiresAt || null;
            user.stripeCustomerId = syncData.stripeCustomerId || null;
          }
        } catch (e) {
          console.error('[BACKGROUND] Auth sync failed:', e.message);
        }
        chrome.storage.local.set({ user });
        console.log('[BACKGROUND] Google sign-in success:', user.email, 'plan:', user.plan);
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'SIGN_IN_SUCCESS', user }).catch(() => {});
      })
      .catch(err => {
        console.error('[BACKGROUND] Google userinfo fetch failed:', err.message);
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'SIGN_IN_ERROR', error: err.message }).catch(() => {});
      });
    });
  } else if (message.type === 'GOOGLE_SIGN_OUT') {
    chrome.storage.local.get('user', (data) => {
      if (data.user?.token) {
        chrome.identity.removeCachedAuthToken({ token: data.user.token }, () => {});
      }
      chrome.storage.local.remove('user');
      console.log('[BACKGROUND] User signed out');
      if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'SIGN_OUT_SUCCESS' }).catch(() => {});
    });
  } else if (message.type === 'CARD_DWELL') {
    console.log(`[BACKGROUND] Card dwell: ${message.term} — ${message.dwellMs}ms`);
    trackEvent('card_dwell', { term: message.term, dwellMs: message.dwellMs, entityType: message.entityType });
    const dwellKey = (message.term || '').toLowerCase().trim();
    if (knowledgeState[dwellKey]) {
      knowledgeState[dwellKey].timesExpanded++;
      knowledgeState[dwellKey].totalDwellMs += (message.dwellMs || 0);
      recalcFamiliarity(dwellKey);
      debounceSaveKnowledgeState();
    }
  } else if (message.type === 'CARD_COPY') {
    console.log(`[BACKGROUND] Card copied: ${message.term}`);
    trackEvent('card_copy', { term: message.term, entityType: message.entityType });
  } else if (message.type === 'SESSION_METRICS') {
    console.log(`[BACKGROUND] Session metrics — rendered: ${message.cardsRendered}, expanded: ${message.cardsExpanded}, rate: ${message.expansionRate}`);
    trackEvent('session_metrics', { cardsRendered: message.cardsRendered, cardsExpanded: message.cardsExpanded, expansionRate: message.expansionRate });
    lastSessionCardsExpanded = message.cardsExpanded || 0;
    updateTopicAffinities();
  } else if (message.type === 'TRACK_EVENT') {
    trackEvent(message.eventName, message.properties || {});
    // Track exports in local analytics
    if (message.eventName === 'export') {
      chrome.storage.local.get('analytics', (data) => {
        const analytics = data.analytics || {};
        analytics.totalExports = (analytics.totalExports || 0) + 1;
        // Mark latest session as exported
        if (analytics.sessionHistory && analytics.sessionHistory.length > 0) {
          analytics.sessionHistory[analytics.sessionHistory.length - 1].exported = true;
        }
        chrome.storage.local.set({ analytics });
      });
    }
    // Update knowledge state for card reactions and tell-me-more
    if (message.eventName === 'card_reaction' && message.properties) {
      const rKey = (message.properties.term || '').toLowerCase().trim();
      if (knowledgeState[rKey]) {
        if (message.properties.reaction === 'known') {
          knowledgeState[rKey].timesKnewThis++;
        } else if (message.properties.reaction === 'new') {
          knowledgeState[rKey].timesNewToMe++;
        }
        recalcFamiliarity(rKey);
        debounceSaveKnowledgeState();
      }
    }
  } else if (message.type === 'TRANSCRIPT') {
    if (isPaused) return;
    console.log('[BACKGROUND] Received TRANSCRIPT:', message.transcript);
    if (!transcriptBuffer) bufferStartTime = Date.now();
    transcriptBuffer += (transcriptBuffer ? ' ' : '') + message.transcript;
    sessionTranscript += (sessionTranscript ? ' ' : '') + message.transcript;
    // Forward raw transcript text to content script for live transcript view
    if (capturingTabId) {
      chrome.tabs.sendMessage(capturingTabId, { type: 'TRANSCRIPT_TEXT', text: message.transcript, timestamp: Date.now() }).catch(() => {});
    }
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
  } else if (message.type === 'SIDEBAR_OPENED') {
    sidebarOpen = true;
    // When sidebar opens during capture, show recording dot instead of count
    if (capturingTabId) {
      chrome.action.setBadgeText({ text: '●' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } else if (message.type === 'SIDEBAR_CLOSED') {
    sidebarOpen = false;
    // When sidebar closes during capture, show card count if any
    if (capturingTabId && sessionTotal > 0) {
      chrome.action.setBadgeText({ text: String(sessionTotal) });
      chrome.action.setBadgeBackgroundColor({ color: '#14b8a6' });
    }
  } else if (message.type === 'SIDEBAR_FIRST_OPEN') {
    // Clear the NEW badge on first sidebar open
    chrome.storage.local.get('newBadgeCleared', (data) => {
      if (!data.newBadgeCleared) {
        chrome.action.setBadgeText({ text: '' });
        chrome.storage.local.set({ newBadgeCleared: true });
      }
    });
  } else if (message.type === 'CARD_DISMISS') {
    // Add term to dismissed set so it won't be re-extracted this session
    const term = (message.term || '').toLowerCase().replace(/s$/, '');
    if (term) dismissedTerms.add(term);
  } else if (message.type === 'VIDEO_PAUSED_LONG') {
    if (!capturingTabId) return;
    console.log('[BACKGROUND] Video paused for 30s, saving session snapshot');
    chrome.storage.local.get(['sessionHistory', 'pastSessions', 'activeTabUrl', 'capturingTabTitle', 'knowledgeBase'], (data) => {
      const sessionHist = data.sessionHistory || [];
      if (sessionHist.length === 0) return;

      // Save KB snapshot
      const kb = data.knowledgeBase || {};
      sessionHist.forEach(item => {
        if (!item.term || item.type === 'insight' || item.type === 'video-divider') return;
        const key = item.term.toLowerCase().trim();
        if (kb[key]) {
          kb[key].lastSeen = Date.now();
          kb[key].timesSeen = (kb[key].timesSeen || 0) + 1;
        } else {
          kb[key] = { term: item.term, type: item.type, description: item.description || '', firstSeen: Date.now(), lastSeen: Date.now(), timesSeen: 1 };
        }
      });
      chrome.storage.local.set({ knowledgeBase: kb });

      // Save pastSessions snapshot (with dedup check)
      const pastSessions = data.pastSessions || [];
      const recentlySaved = pastSessions.length > 0 && (Date.now() - new Date(pastSessions[0].date).getTime()) < 60000;
      if (!recentlySaved) {
        const title = data.capturingTabTitle || capturingTabTitle || 'Untitled';
        pastSessions.unshift({
          id: Date.now(),
          title: title,
          url: data.activeTabUrl || '',
          date: new Date().toISOString(),
          entityCount: sessionHist.filter(i => i.term && i.type !== 'video-divider' && i.type !== 'insight').length,
          insightCount: sessionHist.filter(i => i.type === 'insight').length,
          entities: sessionHist.filter(i => i.term && i.type !== 'video-divider' && i.type !== 'insight').slice(0, 50),
          insights: sessionHist.filter(i => i.type === 'insight').slice(0, 30),
          timestamp: Date.now()
        });
        if (pastSessions.length > 20) pastSessions.length = 20;
        chrome.storage.local.set({ pastSessions });
        console.log('[BACKGROUND] Session snapshot saved on pause');
      }
    });
  } else if (message.type === 'OPEN_CHECKOUT') {
    chrome.storage.local.get(['user', 'installId'], async (data) => {
      const user = data.user;
      if (!user || !user.id || !user.email) {
        console.error('[BACKGROUND] OPEN_CHECKOUT: no signed-in user');
        return;
      }
      try {
        const resp = await fetch(`${CONFIG.API_BASE}/create-checkout-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
          body: JSON.stringify({ googleId: user.id, email: user.email, plan: message.plan || 'monthly', installId: data.installId || null })
        });
        const result = await resp.json();
        if (result.url) {
          chrome.tabs.create({ url: result.url });
          // Poll auth-sync for plan upgrade (every 5s, up to 2 min)
          let pollCount = 0;
          const pollInterval = setInterval(async () => {
            pollCount++;
            if (pollCount > 24) { clearInterval(pollInterval); return; }
            try {
              const pollRes = await fetch(`${CONFIG.API_BASE}/auth-sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
                body: JSON.stringify({ googleId: user.id, email: user.email, installId: data.installId || null })
              });
              if (!pollRes.ok) return;
              const pollData = await pollRes.json();
              if (pollData.plan === 'pro') {
                clearInterval(pollInterval);
                chrome.storage.local.get('user', (stored) => {
                  const updatedUser = stored.user || {};
                  updatedUser.plan = 'pro';
                  updatedUser.minutesLimit = pollData.minutesLimit || 999999;
                  updatedUser.subscriptionStatus = pollData.subscriptionStatus || 'active';
                  updatedUser.planExpiresAt = pollData.planExpiresAt || null;
                  updatedUser.stripeCustomerId = pollData.stripeCustomerId || null;
                  chrome.storage.local.set({ user: updatedUser });
                  console.log('[BACKGROUND] Plan upgraded to pro via checkout polling');
                  // Notify active tab
                  if (capturingTabId) {
                    chrome.tabs.sendMessage(capturingTabId, { type: 'PLAN_UPGRADED', user: updatedUser }).catch(() => {});
                  } else {
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'PLAN_UPGRADED', user: updatedUser }).catch(() => {});
                    });
                  }
                });
              }
            } catch (e) {
              console.error('[BACKGROUND] Checkout poll error:', e.message);
            }
          }, 5000);
        } else {
          console.error('[BACKGROUND] Checkout session error:', result.error);
        }
      } catch (err) {
        console.error('[BACKGROUND] OPEN_CHECKOUT failed:', err.message);
      }
    });
  } else if (message.type === 'OPEN_PORTAL') {
    chrome.storage.local.get(['user', 'installId'], async (data) => {
      const user = data.user;
      if (!user || !user.id) {
        console.error('[BACKGROUND] OPEN_PORTAL: no signed-in user');
        return;
      }
      try {
        const resp = await fetch(`${CONFIG.API_BASE}/create-portal-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
          body: JSON.stringify({ googleId: user.id, installId: data.installId || null })
        });
        const result = await resp.json();
        if (result.url) {
          chrome.tabs.create({ url: result.url });
        } else {
          console.error('[BACKGROUND] Portal session error:', result.error);
        }
      } catch (err) {
        console.error('[BACKGROUND] OPEN_PORTAL failed:', err.message);
      }
    });
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

async function checkEntityPack(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;
  try {
    const res = await fetch(`${CONFIG.API_BASE}/entity-pack?videoId=${videoId}`, {
      headers: { 'x-extension-token': CONFIG.API_SECRET }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.entities ? data : null;
  } catch (e) {
    return null;
  }
}

async function startCapture() {
  if (isStartingCapture) return;
  isStartingCapture = true;
  if (capturingTabId !== null) {
    console.log('[BACKGROUND] Already capturing, ignoring duplicate START_CAPTURE');
    isStartingCapture = false;
    return;
  }
  restartAttempted = false;
  captureStartTime = Date.now();
  chrome.storage.local.set({ captureStartTime });
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

    // Inject content script only if not already running
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch (e2) { /* no access */ }
    }

    capturingTabId = tab.id;
    chrome.storage.local.set({ capturingTabId: capturingTabId });
    capturingTabTitle = tab.title || '';
    console.log('[BACKGROUND] START_CAPTURE: stored capturingTabId =', capturingTabId, 'title =', capturingTabTitle, 'url =', tab.url);
    trackEvent('capture_start', { url: tab.url || '', title: capturingTabTitle });

    // Store activeTabId, URL, title, and sessionId for content script
    // Only set sessionStart on fresh sessions (no existing cards), not on resume
    sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const existingSession = await chrome.storage.local.get('sessionHistory');
    const isResume = existingSession.sessionHistory && existingSession.sessionHistory.length > 0;
    const storageUpdate = {
      activeTabId: tab.id,
      activeTabUrl: tab.url,
      capturingTabTitle: capturingTabTitle,
      capturing: true,
      currentSessionId: sessionId
    };
    if (!isResume) {
      storageUpdate.sessionStart = Date.now();
    }
    chrome.storage.local.set(storageUpdate);

    // Show recording badge
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

    // Check for pre-computed entity pack (non-blocking)
    if (!isResume) {
      checkEntityPack(tab.url).then(pack => {
        if (pack && pack.entities && pack.entities.length > 0) {
          entityPackCache = {};
          pack.entities.forEach(e => {
            const key = (e.term || '').toLowerCase().trim();
            if (key) entityPackCache[key] = e;
          });
          console.log('[BACKGROUND] Entity pack cached:', Object.keys(entityPackCache).length, 'entities');
        }
      }).catch(err => {
        console.error('[BACKGROUND] Entity pack check failed:', err.message || err);
      });
    }

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
  } finally {
    isStartingCapture = false;
  }
}

async function stopCapture() {
  if (isStoppingCapture) return;
  isStoppingCapture = true;

  let durationSec = captureStartTime ? Math.round((Date.now() - captureStartTime) / 1000) : 0;

  // Fallback: if service worker restarted and lost in-memory captureStartTime, read from storage
  if (durationSec === 0) {
    const fallbackData = await chrome.storage.local.get(['captureStartTime', 'sessionStart']);
    const startTs = fallbackData.captureStartTime || fallbackData.sessionStart;
    if (startTs) {
      durationSec = Math.round((Date.now() - startTs) / 1000);
    }
  }

  trackEvent('capture_stop', { duration_seconds: durationSec, entities_count: sessionEntities.length });
  captureStartTime = null;
  chrome.storage.local.remove('captureStartTime');

  capturingTabId = null;
  chrome.storage.local.remove('capturingTabId');

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

  // Snapshot values for analytics before they're cleared
  const analyticsEntityCount = sessionTotal;
  const analyticsInsightCount = sessionInsights.length;

  // Save to knowledge base on stop (not just on clear)
  chrome.storage.local.get(['sessionHistory', 'knowledgeBase'], (data) => {
    const history = data.sessionHistory || [];
    const kb = data.knowledgeBase || {};

    history.forEach(item => {
      if (!item.term || item.type === 'insight' || item.type === 'video-divider') return;
      const key = item.term.toLowerCase().trim();
      if (!kb[key]) {
        kb[key] = {
          term: item.term,
          type: item.type,
          description: item.description || '',
          firstSeen: item.timestamp || Date.now(),
          lastSeen: item.timestamp || Date.now(),
          timesSeen: 1
        };
      } else {
        kb[key].lastSeen = item.timestamp || Date.now();
        kb[key].timesSeen = (kb[key].timesSeen || 0) + 1;
        if ((item.description || '').length > (kb[key].description || '').length) {
          kb[key].description = item.description;
        }
      }
    });

    chrome.storage.local.set({ knowledgeBase: kb });
    console.log('[BACKGROUND] Knowledge base updated on stop, total:', Object.keys(kb).length);
  });

  // Save session snapshot to pastSessions on stop (not just on clear)
  chrome.storage.local.get(['sessionHistory', 'pastSessions', 'activeTabUrl', 'capturingTabTitle'], (data) => {
    const sessionHist = data.sessionHistory || [];
    if (sessionHist.length === 0) return;

    const pastSessions = data.pastSessions || [];
    const title = data.capturingTabTitle || capturingTabTitle || 'Untitled';

    pastSessions.unshift({
      id: Date.now(),
      title: title,
      url: data.activeTabUrl || '',
      date: new Date().toISOString(),
      entityCount: sessionHist.filter(i => i.term && i.type !== 'video-divider' && i.type !== 'insight').length,
      insightCount: sessionHist.filter(i => i.type === 'insight').length,
      entities: sessionHist.filter(i => i.term && i.type !== 'video-divider' && i.type !== 'insight').slice(0, 50),
      insights: sessionHist.filter(i => i.type === 'insight').slice(0, 30),
      timestamp: Date.now()
    });

    if (pastSessions.length > 20) pastSessions.length = 20;

    chrome.storage.local.set({ pastSessions });
    console.log('[BACKGROUND] Session saved to history on stop, total:', pastSessions.length);
  });

  // Compute session stats before clearing in-memory data
  const sessionStats = computeSessionStats();

  // Upload entity pack for YouTube videos (fire and forget)
  if (sessionEntities.length >= 5) {
    chrome.storage.local.get(['activeTabUrl', 'sessionHistory'], (data) => {
      const url = data.activeTabUrl || '';
      const videoId = extractYouTubeId(url);
      if (videoId) {
        const history = data.sessionHistory || [];
        const entities = history
          .filter(h => h.term && h.type !== 'insight' && h.type !== 'video-divider')
          .map(h => ({ term: h.term, type: h.type || 'other', description: h.description || '', ticker: h.ticker || null, salience: 'highlight', thumbnail: h.thumbnail || null }))
          .slice(0, 50);
        const insights = history
          .filter(h => h.type === 'insight')
          .map(h => ({ insight: h.term, detail: h.description || '', category: h.category || 'tip' }))
          .slice(0, 20);
        fetch(`${CONFIG.API_BASE}/entity-pack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
          body: JSON.stringify({ videoId, title: capturingTabTitle || '', entities, insights })
        }).catch(() => {});
        console.log('[BACKGROUND] Entity pack uploaded for', videoId, '- entities:', entities.length);
      }
    });
  }

  // Small delay after closing offscreen doc before resetting state
  await new Promise(resolve => setTimeout(resolve, 500));

  capturingTabId = null;
  chrome.storage.local.remove('capturingTabId');
  capturingTabTitle = null;
  pendingStreamId = null;
  sessionId = null;
  sessionTotal = 0;
  updateTopicAffinities();
  sessionEntities = [];
  sessionInsights = [];
  entityPackCache = {};
  dismissedTerms.clear();
  sessionTranscript = '';
  isPaused = false;
  firstFlush = true;
  stopUsageTimer();
  flushEvents();
  chrome.storage.local.remove(['activeTabId', 'sessionEntities']);
  chrome.storage.local.set({ capturing: false, sessionStats });
  chrome.action.setBadgeText({ text: '' });
  console.log('[BACKGROUND] Capture stopped');
  isStoppingCapture = false;

  // Update local analytics after a short delay so content.js SESSION_METRICS arrives first
  setTimeout(() => {
    chrome.storage.local.get('analytics', (data) => {
      const analytics = data.analytics || {
        installDate: Date.now(),
        totalSessions: 0,
        totalEntities: 0,
        totalInsights: 0,
        activated: false,
        activationDate: null,
        sessionsOver5Min: 0,
        totalExports: 0,
        totalTellMeMore: 0,
        sessionHistory: []
      };

      analytics.totalSessions++;
      analytics.totalEntities += analyticsEntityCount;
      analytics.totalInsights += analyticsInsightCount;

      if (durationSec >= 300) {
        analytics.sessionsOver5Min++;
      }

      // Activation: 5+ minute session with 2+ cards expanded
      if (!analytics.activated && durationSec >= 300 && lastSessionCardsExpanded >= 2) {
        analytics.activated = true;
        analytics.activationDate = Date.now();
        console.log('[BACKGROUND] User ACTIVATED!');
      }

      // Session log (keep last 30)
      analytics.sessionHistory.push({
        date: Date.now(),
        duration: durationSec,
        entities: analyticsEntityCount,
        cardsExpanded: lastSessionCardsExpanded,
        exported: false
      });
      if (analytics.sessionHistory.length > 30) {
        analytics.sessionHistory = analytics.sessionHistory.slice(-30);
      }

      chrome.storage.local.set({ analytics });
      lastSessionCardsExpanded = 0;
    });
  }, 1000);
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
    const storageData = await chrome.storage.local.get(['userProfile', 'userSettings', 'likedEntities', 'ignoreList', 'extensionSettings', 'knowledgeBase', 'cardReactions', 'typeCalibration', 'difficultyProfile', 'installId']);
    const savedSettings = storageData.userSettings || {};
    const userProfile = {
      ...(storageData.userProfile || {}),
      knowledgeLevel: savedSettings.knowledgeLevel || (storageData.userProfile && storageData.userProfile.knowledgeLevel) || 'intermediate',
      interests: savedSettings.interests || (storageData.userProfile && storageData.userProfile.interests) || undefined,
    };

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
    Object.values(storageData.cardReactions || {}).forEach(r => {
      if (reactionCounts[r.reaction] !== undefined) reactionCounts[r.reaction]++;
    });
    const reactionProfile = reactionCounts;

    // Build typeCalibration from reactions (Prompt 6)
    const typeCalibration = storageData.typeCalibration || {};
    // Build difficultyProfile from reactions (Prompt 10)
    const difficultyProfile = storageData.difficultyProfile || {};

    const depth = (storageData.extensionSettings && storageData.extensionSettings.depth) || 2;
    const knownTerms = Object.values(storageData.knowledgeBase || {}).map(e => e.term);

    // Build familiarity-filtered terms from knowledge state
    const familiarTerms = Object.values(knowledgeState)
      .filter(e => e.familiarity > 0.6)
      .map(e => e.term)
      .slice(0, 30);

    // Build top topic affinities
    const topTopics = Object.entries(topicAffinities)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3)
      .map(([topic, data]) => `${topic} (${(data.score * 100).toFixed(0)}%)`)
      .join(', ');

    // Check entity pack cache for instant matches
    const packMatches = [];
    const transcriptLower = transcript.toLowerCase();
    const packRementions = [];
    for (const [key, entity] of Object.entries(entityPackCache)) {
      const normalized = key.replace(/s$/, '');
      if (transcriptLower.includes(key)) {
        if (dismissedTerms.has(normalized)) continue;
        if (!sessionEntities.includes(normalized)) {
          packMatches.push({ ...entity, fromPack: true });
          // Register in sessionEntities for dedup
          sessionEntities.push(normalized);
        } else {
          // Already seen — track as re-mention
          packRementions.push(entity.term || key);
        }
      }
    }
    // Notify content script of re-mentions from pack cache
    if (packRementions.length > 0 && capturingTabId) {
      packRementions.forEach(term => {
        chrome.tabs.sendMessage(capturingTabId, { type: 'ENTITY_REMENTION', term: term.toLowerCase() }).catch(() => {});
      });
    }

    if (packMatches.length > 0) {
      console.log('[BACKGROUND] Pack cache hits:', packMatches.map(e => e.term).join(', '));
      // Save pack matches to storage — enrich stock entities with live price data first
      // Add familiarity data
      let enrichedPackMatches = packMatches.map(e => {
        const ks = knowledgeState[(e.term || '').toLowerCase().trim()];
        return {
          ...e,
          familiarity: ks ? ks.familiarity : 0,
          timesSeen: ks ? ks.timesSeen : 0,
          timestamp: Date.now()
        };
      });

      // Convert index/ETF entities to stock type for price enrichment
      enrichedPackMatches.forEach(entity => {
        const etfMatch = INDEX_TO_ETF[(entity.term || '').toLowerCase()];
        if (etfMatch) {
          entity.type = 'stock';
          entity.ticker = etfMatch.ticker;
          entity.companyName = etfMatch.name;
        }
      });

      // Resolve tickers for stock entities that don't have one
      for (const entity of enrichedPackMatches) {
        if (entity.type === 'stock' && !entity.ticker) {
          const resolved = await resolveTickerFromName(entity.term || entity.name);
          if (resolved) {
            entity.ticker = resolved;
          }
        }
      }

      // Enrich stock entities from pack cache with live price data
      enrichedPackMatches = await Promise.all(enrichedPackMatches.map(async (entity) => {
        if (entity.type === 'stock') {
          if (!entity.ticker) return entity;
          try {
            const stockRes = await fetch(`${CONFIG.API_BASE}/stock`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
              body: JSON.stringify({ ticker: entity.ticker })
            });
            if (stockRes.ok) {
              const stockData = await stockRes.json();
              console.log('[BACKGROUND] Pack stock enrichment for', entity.ticker, ':', JSON.stringify(stockData));
              if (stockData.price != null) {
                return { ...entity, ...stockData, companyName: stockData.name || entity.name || '' };
              }
            }
          } catch (e) {
            console.error('[BACKGROUND] Pack stock fetch error for', entity.ticker, ':', e.message || e);
          }
        }
        return entity;
      }));

      updateKnowledgeState(enrichedPackMatches);

      chrome.storage.local.get('sessionHistory', (histData) => {
        const history = histData.sessionHistory || [];
        enrichedPackMatches.forEach(entity => {
          history.push({
            term: entity.term,
            type: entity.type,
            description: entity.description,
            ticker: entity.ticker || null,
            salience: entity.salience || 'highlight',
            followUps: entity.followUps || [],
            familiarity: entity.familiarity,
            timesSeen: entity.timesSeen,
            timestamp: Date.now(),
            fromPack: true
          });
        });
        chrome.storage.local.set({
          sessionHistory: history,
          pendingEntities: enrichedPackMatches,
          pendingTimestamp: Date.now()
        });
        // Show card count badge for pack entities when sidebar closed
        sessionTotal += enrichedPackMatches.length;
        if (!sidebarOpen) {
          chrome.action.setBadgeText({ text: String(sessionTotal) });
          chrome.action.setBadgeBackgroundColor({ color: '#14b8a6' });
        }
      });
      chrome.storage.local.set({ sessionEntities });

      // Fetch thumbnails for pack cache hits
      enrichedPackMatches.forEach(async (entity) => {
        const type = (entity.type || '').toLowerCase();
        if (type === 'insight' || type === 'metric' || type === 'ingredient' || type === 'concept') return;
        if (entity.thumbnail) return;
        const term = entity.term || '';
        if (!term) return;
        const thumb = await fetchWikiThumbnail(term);
        if (thumb && capturingTabId) {
          chrome.storage.local.get('sessionHistory', (data) => {
            const hist = data.sessionHistory || [];
            const match = hist.find(h => h.term === term && !h.thumbnail);
            if (match) {
              match.thumbnail = thumb;
              chrome.storage.local.set({ sessionHistory: hist });
            }
          });
          chrome.tabs.sendMessage(capturingTabId, { type: 'THUMBNAIL_UPDATE', term, thumbnail: thumb }).catch(() => {});
        }
      });
    }

    // Skip sponsor/ad segments
    if (isLikelyAd(transcript)) {
      console.log('[BACKGROUND] Ad segment detected, skipping analyze:', transcript.slice(0, 60) + '...');
      isProcessing = false;
      scheduleNext();
      return;
    }

    // Step 1: Analyze (up to 3 attempts, handles both HTTP errors and network failures)
    const installId = storageData.installId || null;
    const analyzeBody = JSON.stringify({ transcript, pageTitle: capturingTabTitle, userProfile, tasteProfile, reactionProfile, depth, previousEntities: sessionEntities, sessionContext: sessionTranscript.slice(-2000), knownTerms, familiarTerms, topTopics, typeCalibration, difficultyProfile, installId });
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
        analyzeRes = await fetch(`${CONFIG.API_BASE}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
          body: analyzeBody,
          signal: controller.signal
        });
      } catch (fetchErr) {
        clearTimeout(timeout);
        console.log(`[BACKGROUND] Analyze network error on attempt ${attempt + 1}/3:`, fetchErr.message);
        if (capturingTabId) chrome.tabs.sendMessage(capturingTabId, { type: 'CONNECTION_ERROR', service: 'analysis', retrying: attempt < 2 }).catch(() => {});
        if (attempt === 2) {
          console.log('[BACKGROUND] Analyze failed after 3 attempts (network) — skipping');
          lastAnalyzeFailed = true;
          scheduleNext();
          return;
        }
        continue;
      }
      clearTimeout(timeout);
      if (analyzeRes.ok) {
        if (attempt > 0 || lastAnalyzeFailed) {
          console.log(`[BACKGROUND] Analyze succeeded on attempt ${attempt + 1}${lastAnalyzeFailed ? ' (recovering from previous failure)' : ''}`);
          if (capturingTabId) chrome.tabs.sendMessage(capturingTabId, { type: 'CONNECTION_RESTORED', service: 'analysis' }).catch(() => {});
        }
        lastAnalyzeFailed = false;
        break;
      }
      // Notify on HTTP errors (503, 529, etc.)
      if (!analyzeRes.ok && capturingTabId) {
        chrome.tabs.sendMessage(capturingTabId, { type: 'CONNECTION_ERROR', service: 'analysis', retrying: attempt < 2 }).catch(() => {});
      }
      if (attempt === 2) {
        console.log('[BACKGROUND] Analyze failed after 3 attempts, status:', analyzeRes.status, '— skipping');
        lastAnalyzeFailed = true;
        scheduleNext();
        return;
      }
    }
    const analyzeData = await analyzeRes.json();

    // Budget circuit breaker — skip chunk but keep capturing
    if (analyzeData.error === 'high_demand') {
      console.log('[BACKGROUND] High demand, skipping chunk');
      if (capturingTabId) {
        chrome.tabs.sendMessage(capturingTabId, {
          type: 'SHOW_TOAST',
          message: 'Context is experiencing high demand. Please try again later.'
        }).catch(() => {});
      }
      scheduleNext();
      return;
    }

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
        if (prevNorm === newTerm) return true;
        if (prevNorm.includes(newTerm) || newTerm.includes(prevNorm)) {
          // Length ratio check: only count as dupe if shorter is ≥80% of longer
          const shorter = prevNorm.length <= newTerm.length ? prevNorm : newTerm;
          const longer = prevNorm.length > newTerm.length ? prevNorm : newTerm;
          return shorter.length / longer.length >= 0.80;
        }
        return false;
      });
      if (isDup) {
        console.log('[BACKGROUND] Dedup filtered:', entity.term, '(already seen similar in session)');
        // Notify content script of re-mention
        if (capturingTabId) {
          chrome.tabs.sendMessage(capturingTabId, { type: 'ENTITY_REMENTION', term: (entity.term || '').toLowerCase() }).catch(() => {});
        }
      }
      return !isDup;
    });

    // Immediately register deduped entities so the next queued chunk sees them
    dedupedEntities.forEach(e => {
      const term = (e.term || e.name || '').toLowerCase().replace(/s$/, '');
      if (term) sessionEntities.push(term);
    });
    // Persist to survive service worker restarts
    chrome.storage.local.set({ sessionEntities });

    // Filter out generic/common single-word terms and dismissed terms
    const filteredEntities = dedupedEntities.filter(entity => {
      const term = (entity.term || entity.name || '').trim();
      const termLower = term.toLowerCase().replace(/s$/, '');
      if (dismissedTerms.has(termLower)) {
        console.log('[BACKGROUND] Dismissed term filtered:', term);
        return false;
      }
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

    // Fuzzy dedup insights, limit to 2 per chunk
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

    const dedupedInsights = [];
    for (const insight of insights) {
      if (dedupedInsights.length >= 2) break;
      const newText = insight.insight || '';
      if (!newText) continue;
      if (isInsightDuplicate(newText, sessionInsights)) {
        console.log('[BACKGROUND] Insight dedup filtered:', insight.insight);
        continue;
      }
      dedupedInsights.push(insight);
      sessionInsights.push(newText);
    }

    if (filteredEntities.length === 0 && dedupedInsights.length === 0) {
      console.log('[BACKGROUND] All entities and insights filtered, skipping');
      scheduleNext();
      return;
    }

    // Step 2: Convert index/ETF entities to stock type for price enrichment
    filteredEntities.forEach(entity => {
      const etfMatch = INDEX_TO_ETF[(entity.term || '').toLowerCase()];
      if (etfMatch) {
        entity.type = 'stock';
        entity.ticker = etfMatch.ticker;
        entity.companyName = etfMatch.name;
      }
    });

    // Resolve tickers for stock entities that don't have one
    for (const entity of filteredEntities) {
      if (entity.type === 'stock' && !entity.ticker) {
        const resolved = await resolveTickerFromName(entity.term || entity.name);
        if (resolved) {
          entity.ticker = resolved;
        }
      }
    }

    // Enrich entities — stocks get price data, others pass through as-is
    const enrichedEntities = await Promise.all(
      filteredEntities.map(async (entity) => {
        if (entity.type === 'stock') {
          if (!entity.ticker) return entity;
          try {
            const stockController = new AbortController();
            const stockTimeout = setTimeout(() => stockController.abort(), 15000);
            let stockRes;
            try {
              stockRes = await fetch(`${CONFIG.API_BASE}/stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
                body: JSON.stringify({ ticker: entity.ticker }),
                signal: stockController.signal
              });
            } finally {
              clearTimeout(stockTimeout);
            }
            if (stockRes.ok) {
              let stockData = await stockRes.json();
              console.log('[BACKGROUND] Stock lookup FULL result:', JSON.stringify(stockData));
              // Retry once after 2s if price is null
              if (stockData.price == null) {
                console.warn('[BACKGROUND] Stock API returned no price for', entity.ticker, '— retrying in 2s');
                await new Promise(r => setTimeout(r, 2000));
                try {
                  const retryController = new AbortController();
                  const retryTimeout = setTimeout(() => retryController.abort(), 15000);
                  let retryRes;
                  try {
                    retryRes = await fetch(`${CONFIG.API_BASE}/stock`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'x-extension-token': CONFIG.API_SECRET },
                      body: JSON.stringify({ ticker: entity.ticker }),
                      signal: retryController.signal
                    });
                  } finally {
                    clearTimeout(retryTimeout);
                  }
                  if (retryRes.ok) {
                    const retryData = await retryRes.json();
                    console.log('[BACKGROUND] Stock retry result:', JSON.stringify(retryData));
                    if (retryData.price != null) {
                      stockData = retryData;
                    }
                  }
                } catch (retryErr) {
                  console.error('[BACKGROUND] Stock retry error for', entity.ticker, ':', retryErr.message || retryErr);
                }
              }
              // If still no price after retry, check cache before falling back
              if (stockData.price == null) {
                const cacheGet = await chrome.storage.local.get('stockCache');
                const cached = (cacheGet.stockCache || {})[entity.ticker];
                if (cached && (Date.now() - cached.cachedAt) < 24 * 60 * 60 * 1000) {
                  console.log('[BACKGROUND] Using cached stock data for', entity.ticker);
                  const { cachedAt, ...cachedStockData } = cached;
                  return { ...entity, ...cachedStockData, companyName: cachedStockData.name || entity.name || '' };
                }
                console.warn('[BACKGROUND] Stock API returned no price for', entity.ticker, 'after retry, no valid cache — rendering as organization card');
                const fallback = { ...entity, description: entity.description || stockData.description || '' };
                delete fallback.ticker;
                delete fallback.stockData;
                fallback.type = 'organization';
                return fallback;
              }
              // Cache successful stock lookup
              const cacheGet = await chrome.storage.local.get('stockCache');
              const stockCache = cacheGet.stockCache || {};
              stockCache[entity.ticker] = { ...stockData, cachedAt: Date.now() };
              chrome.storage.local.set({ stockCache: stockCache });
              const enriched = { ...entity, ...stockData, companyName: stockData.name || entity.name || '' };
              console.log('[BACKGROUND] Enriched stock entity:', entity.ticker, 'price:', enriched.price, 'change:', enriched.change, 'changePercent:', enriched.changePercent);
              return enriched;
            } else {
              console.error('[BACKGROUND] Stock API HTTP error for', entity.ticker, ':', stockRes.status);
            }
          } catch (e) {
            console.error('[BACKGROUND] Stock fetch error for', entity.ticker, ':', e.message || e);
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
        newHistoryEntries.push({ term, type: e.type || 'other', timestamp: Date.now(), description: e.description || '', ticker: e.ticker || null, elapsedSeconds });
      }
    });
    dedupedInsights.forEach(i => {
      newHistoryEntries.push({ term: i.insight, type: 'insight', timestamp: Date.now(), description: i.detail, category: i.category, elapsedSeconds });
    });

    // Flag entities previously seen in knowledge base
    const kbData = await chrome.storage.local.get('knowledgeBase');
    const kb = kbData.knowledgeBase || {};
    enrichedEntities.forEach(e => {
      const key = (e.term || e.name || '').toLowerCase();
      if (key && kb[key] && kb[key].timesSeen > 1) {
        e.previouslyKnown = true;
        e.kbSource = kb[key].source || '';
        console.log('[BACKGROUND] KB match:', key, 'timesSeen:', kb[key].timesSeen);
      }
      // Attach familiarity data from knowledge state
      const ks = knowledgeState[key];
      e.familiarity = ks ? ks.familiarity : 0;
      e.timesSeen = ks ? ks.timesSeen : 0;
    });

    // Update knowledge state with new entities
    updateKnowledgeState(enrichedEntities);

    // Save pending entities/insights for content script (onChanged) and append to sessionHistory
    console.log('[BACKGROUND] Saving', enrichedEntities.length, 'entities and', dedupedInsights.length, 'insights to storage');
    const histData = await chrome.storage.local.get('sessionHistory');
    let history = histData.sessionHistory || [];
    history.push(...newHistoryEntries);
    // Cap session history at 500 entries to prevent storage bloat
    const MAX_SESSION_HISTORY = 500;
    if (history.length > MAX_SESSION_HISTORY) {
      history = history.slice(history.length - MAX_SESSION_HISTORY);
    }
    await chrome.storage.local.set({ pendingEntities: enrichedEntities, pendingInsights: dedupedInsights, pendingTimestamp: Date.now(), pendingSessionId: sessionId, sessionHistory: history });
    // Send extracted entity terms to content script for transcript highlighting
    if (capturingTabId && enrichedEntities.length > 0) {
      const highlightTerms = enrichedEntities.map(e => ({ term: e.term || e.name || '', type: e.type || 'concept' })).filter(e => e.term);
      chrome.tabs.sendMessage(capturingTabId, { type: 'TRANSCRIPT_HIGHLIGHT', terms: highlightTerms }).catch(() => {});
    }
    // Fetch Wikipedia thumbnails in parallel (don't block card rendering)
    enrichedEntities.forEach(async (entity) => {
      const type = (entity.type || '').toLowerCase();
      if (type === 'insight' || type === 'metric' || type === 'ingredient' || type === 'concept') return;
      const term = entity.term || entity.name || '';
      if (!term) return;
      const thumb = await fetchWikiThumbnail(term);
      if (thumb && capturingTabId) {
        // Update sessionHistory with thumbnail
        chrome.storage.local.get('sessionHistory', (data) => {
          const hist = data.sessionHistory || [];
          const match = hist.find(h => h.term === term && !h.thumbnail);
          if (match) {
            match.thumbnail = thumb;
            chrome.storage.local.set({ sessionHistory: hist });
          }
        });
        // Notify content script to patch existing card
        chrome.tabs.sendMessage(capturingTabId, { type: 'THUMBNAIL_UPDATE', term, thumbnail: thumb }).catch(() => {});
      }
    });

    incrementUsage('entities', enrichedEntities.length + dedupedInsights.length);
    sessionTotal += enrichedEntities.length + dedupedInsights.length;
    // Show card count badge when sidebar is closed
    if (!sidebarOpen) {
      chrome.action.setBadgeText({ text: String(sessionTotal) });
      chrome.action.setBadgeBackgroundColor({ color: '#14b8a6' });
    }
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
  const reactions = changes.cardReactions.newValue || {};
  const reactionValues = Object.values(reactions);
  if (reactionValues.length === 0) return;

  // Build typeCalibration: { concept: { knewThis: N, tooAdvanced: N }, ... }
  const typeCal = {};
  reactionValues.forEach(r => {
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
