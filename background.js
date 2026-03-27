const API_BASE = 'https://context-extension-zv8d.vercel.app/api';

let mediaRecorder = null;
let captureStream = null;
let capturingTabTitle = '';
let sessionTotal = 0;
let sessionEntities = [];
let sessionTranscript = '';

// Item 2: Extension icon toggles sidebar
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 200));
  }
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
});

// Item 9: Keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-sidebar') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        try {
          await chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' });
        } catch (e) {
          await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
          await new Promise(r => setTimeout(r, 200));
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' });
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CAPTURE') {
    startCapture(sender.tab?.id);
  } else if (message.type === 'STOP_CAPTURE') {
    stopCapture();
  } else if (message.type === 'CLEAR_SESSION') {
    clearSession();
    sendResponse({ ok: true });
    return;
  } else if (message.type === 'TOGGLE_CAPTURE') {
    // Item 5: Handle TOGGLE_CAPTURE
    (async () => {
      const data = await chrome.storage.local.get('capturing');
      if (data.capturing) {
        stopCapture();
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, { type: 'CAPTURE_STATE', capturing: false });
        }
      } else {
        if (sender.tab) {
          startCapture(sender.tab.id);
          chrome.tabs.sendMessage(sender.tab.id, { type: 'CAPTURE_STATE', capturing: true });
        }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});

async function startCapture(tabId) {
  try {
    const stream = await chrome.tabCapture.capture({
      audio: true,
      video: false
    });

    if (!stream) {
      console.error('Failed to capture tab audio');
      return;
    }

    captureStream = stream;
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        await processAudioChunk(event.data);
      }
    };

    mediaRecorder.start(4000); // 4-second chunks
    chrome.storage.local.set({ capturing: true });
    // Store tab title for interviewer filtering
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        capturingTabTitle = tab.title || '';
      } catch (e) {}
    }
    console.log('Capture started');
  } catch (err) {
    console.error('Capture error:', err);
  }
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (captureStream) {
    captureStream.getTracks().forEach(track => track.stop());
    captureStream = null;
  }
  mediaRecorder = null;
  chrome.storage.local.set({ capturing: false });
  console.log('Capture stopped');
}

function clearSession() {
  sessionTotal = 0;
  sessionEntities = [];
  sessionTranscript = '';
  chrome.storage.local.set({
    sessionHistory: [],
    pendingEntities: [],
    pendingInsights: [],
    pendingTimestamp: null
  });
  console.log('Session cleared');
}

async function processAudioChunk(blob) {
  try {
    const base64 = await blobToBase64(blob);

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
    let entities = analyzeData.entities || [];

    // Filter out interviewer/host entities client-side
    const hostPatterns = ['sean ryan', 'shawn ryan', 'joe rogan', 'lex fridman', 'tucker carlson', 'jordan peterson'];
    const pageTitle = capturingTabTitle?.toLowerCase() || '';

    entities = entities.filter(e => {
      const termLower = (e.term || '').toLowerCase();
      // Filter exact host name matches
      if (hostPatterns.includes(termLower)) {
        console.log('[BACKGROUND] Filtered interviewer:', e.term);
        return false;
      }
      // Filter if the person's name appears in the video title (likely the host)
      if (e.type === 'person' && termLower.length > 2 && pageTitle.includes(termLower)) {
        console.log('[BACKGROUND] Filtered title-mentioned person:', e.term);
        return false;
      }
      return true;
    });

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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'CONTEXT_DATA',
        entities: enrichedEntities
      });
    }
  } catch (err) {
    console.error('Processing error:', err);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
