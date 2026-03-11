(() => {
  const DEDUP_WINDOW_MS = 60000;
  const recentTerms = new Map();

  let sidebar = null;
  let cardContainer = null;

  // Audio capture state
  let mediaRecorder = null;
  let captureStream = null;

  function createSidebar() {
    if (sidebar) return;

    sidebar = document.createElement('div');
    sidebar.id = 'context-sidebar';

    const style = document.createElement('style');
    style.textContent = `
      #context-sidebar {
        position: fixed;
        top: 0;
        right: 0;
        width: 320px;
        height: 100vh;
        background: #12121a;
        border-left: 1px solid #2a2a3e;
        z-index: 2147483647;
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #e0e0e0;
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
      }

      #context-sidebar.open {
        transform: translateX(0);
      }

      #context-sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px;
        border-bottom: 1px solid #2a2a3e;
        flex-shrink: 0;
      }

      #context-sidebar-header h2 {
        font-size: 14px;
        font-weight: 600;
        color: #fff;
        margin: 0;
        letter-spacing: 0.5px;
      }

      #context-sidebar-close {
        background: none;
        border: none;
        color: #666;
        font-size: 18px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        line-height: 1;
      }

      #context-sidebar-close:hover {
        background: #2a2a3e;
        color: #fff;
      }

      #context-sidebar-cards {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
      }

      #context-sidebar-cards::-webkit-scrollbar {
        width: 6px;
      }

      #context-sidebar-cards::-webkit-scrollbar-track {
        background: transparent;
      }

      #context-sidebar-cards::-webkit-scrollbar-thumb {
        background: #333;
        border-radius: 3px;
      }

      .context-card {
        background: #1e1e2e;
        border: 1px solid #2a2a3e;
        border-radius: 10px;
        padding: 14px;
        margin-bottom: 10px;
        animation: context-card-in 0.3s ease-out;
      }

      @keyframes context-card-in {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .context-card-stock {
        border-left: 3px solid #7c4dff;
      }

      .context-card-other {
        border-left: 3px solid #29b6f6;
      }

      .context-card .ticker {
        font-size: 16px;
        font-weight: 700;
        color: #fff;
        margin-bottom: 2px;
      }

      .context-card .company-name {
        font-size: 11px;
        color: #888;
        margin-bottom: 10px;
      }

      .context-card .price-row {
        display: flex;
        align-items: baseline;
        gap: 10px;
      }

      .context-card .price {
        font-size: 20px;
        font-weight: 600;
        color: #fff;
      }

      .context-card .change {
        font-size: 13px;
        font-weight: 600;
      }

      .context-card .change.positive {
        color: #00e676;
      }

      .context-card .change.negative {
        color: #ff5252;
      }

      .context-card .term {
        font-size: 14px;
        font-weight: 600;
        color: #fff;
        margin-bottom: 6px;
      }

      .context-card .description {
        font-size: 12px;
        color: #aaa;
        line-height: 1.5;
      }
    `;

    document.head.appendChild(style);

    const header = document.createElement('div');
    header.id = 'context-sidebar-header';
    header.innerHTML = `
      <h2>CONTEXT</h2>
      <button id="context-sidebar-close">&times;</button>
    `;

    cardContainer = document.createElement('div');
    cardContainer.id = 'context-sidebar-cards';

    sidebar.appendChild(header);
    sidebar.appendChild(cardContainer);
    document.body.appendChild(sidebar);

    document.getElementById('context-sidebar-close').addEventListener('click', () => {
      sidebar.classList.remove('open');
    });
  }

  // --- Audio capture (runs in content script for MV3 compatibility) ---

  async function startRecording(streamId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });

      captureStream = stream;
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          const base64 = await blobToBase64(event.data);
          chrome.runtime.sendMessage({ type: 'AUDIO_CHUNK', audio: base64 });
        }
      };

      mediaRecorder.start(4000); // 4-second chunks
      console.log('Content script: recording started');
    } catch (err) {
      console.error('Content script: recording error:', err);
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (captureStream) {
      captureStream.getTracks().forEach(track => track.stop());
      captureStream = null;
    }
    mediaRecorder = null;
    console.log('Content script: recording stopped');
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

  // --- Sidebar rendering ---

  function isDuplicate(term) {
    const now = Date.now();
    const lastSeen = recentTerms.get(term);
    if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
      return true;
    }
    recentTerms.set(term, now);
    return false;
  }

  function createStockCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card context-card-stock';

    const changeVal = parseFloat(entity.change) || 0;
    const changeClass = changeVal >= 0 ? 'positive' : 'negative';
    const changePrefix = changeVal >= 0 ? '+' : '';
    const changePercent = entity.changePercent != null
      ? ` (${changePrefix}${parseFloat(entity.changePercent).toFixed(2)}%)`
      : '';

    card.innerHTML = `
      <div class="ticker">${escapeHtml(entity.ticker || '')}</div>
      <div class="company-name">${escapeHtml(entity.companyName || entity.name || '')}</div>
      <div class="price-row">
        <span class="price">$${parseFloat(entity.price || 0).toFixed(2)}</span>
        <span class="change ${changeClass}">${changePrefix}${changeVal.toFixed(2)}${changePercent}</span>
      </div>
    `;

    return card;
  }

  function createGenericCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card context-card-other';

    card.innerHTML = `
      <div class="term">${escapeHtml(entity.term || entity.name || '')}</div>
      <div class="description">${escapeHtml(entity.description || '')}</div>
    `;

    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Message listener ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_RECORDING') {
      startRecording(message.streamId);
    } else if (message.type === 'STOP_RECORDING') {
      stopRecording();
    } else if (message.type === 'CONTEXT_DATA') {
      createSidebar();

      const entities = message.entities || [];
      let addedAny = false;

      entities.forEach(entity => {
        const key = entity.ticker || entity.term || entity.name || '';
        if (!key || isDuplicate(key)) return;

        const card = entity.type === 'stock'
          ? createStockCard(entity)
          : createGenericCard(entity);

        cardContainer.prepend(card);
        addedAny = true;
      });

      if (addedAny) {
        sidebar.classList.add('open');
      }
    }
  });
})();
