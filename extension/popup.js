// --- Preferences overlay ---
const onboardingEl = document.getElementById('onboarding');
const mainPopupEl = document.getElementById('mainPopup');
const getStartedBtn = document.getElementById('getStartedBtn');
const levelButtons = document.querySelectorAll('.ob-level-btn');
const interestCheckboxes = document.querySelectorAll('#interestCheckboxes input');

let selectedLevel = null;

// Wire up preference controls
levelButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    levelButtons.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedLevel = btn.dataset.level;
    getStartedBtn.disabled = false;
  });
});

getStartedBtn.addEventListener('click', () => {
  if (!selectedLevel) return;

  const interests = Array.from(
    document.querySelectorAll('#interestCheckboxes input:checked')
  ).map(cb => cb.value);

  const userProfile = { knowledgeLevel: selectedLevel, interests };
  chrome.storage.local.set({ userProfile }, () => {
    onboardingEl.style.display = 'none';
    onboardingEl.classList.remove('overlay');
  });
});

function showPreferences() {
  selectedLevel = null;
  getStartedBtn.disabled = true;
  levelButtons.forEach(b => b.classList.remove('selected'));
  interestCheckboxes.forEach(cb => { cb.checked = false; });

  onboardingEl.style.display = 'block';
  onboardingEl.classList.add('overlay');

  // Pre-fill from saved profile
  chrome.storage.local.get('userProfile', (data) => {
    if (data.userProfile) {
      levelButtons.forEach(btn => {
        if (btn.dataset.level === data.userProfile.knowledgeLevel) {
          btn.classList.add('selected');
          selectedLevel = data.userProfile.knowledgeLevel;
          getStartedBtn.disabled = false;
        }
      });
      const saved = data.userProfile.interests || [];
      interestCheckboxes.forEach(cb => {
        cb.checked = saved.includes(cb.value);
      });
    }
  });
}

// Always show main popup directly
mainPopupEl.style.display = 'block';
initMainPopup();

let mainPopupInitialized = false;

function initMainPopup() {
  if (mainPopupInitialized) return;
  mainPopupInitialized = true;

  const toggleBtn = document.getElementById('toggleBtn');
  const statusText = document.getElementById('statusText');
  const statusBadge = document.getElementById('statusBadge');

  let isActive = false;

  chrome.storage.local.get('capturing', (data) => {
    if (data.capturing) {
      setActiveState(true);
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.capturing) {
      setActiveState(!!changes.capturing.newValue);
    }
  });

  toggleBtn.addEventListener('click', () => {
    if (!isActive) {
      // Starting: check if already capturing before sending
      chrome.storage.local.get('capturing', (data) => {
        if (data.capturing) {
          setActiveState(true);
        } else {
          setActiveState(true);
          chrome.runtime.sendMessage({ type: 'START_CAPTURE' });
          chrome.storage.local.set({ capturing: true });
        }
      });
    } else {
      // Stopping: always send
      setActiveState(false);
      chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
      chrome.storage.local.set({ capturing: false });
    }
  });

  function setActiveState(active) {
    isActive = active;
    if (active) {
      toggleBtn.textContent = 'Stop listening';
      toggleBtn.classList.add('active');
      statusText.textContent = 'Live';
      statusBadge.classList.add('active');
    } else {
      toggleBtn.textContent = 'Start listening';
      toggleBtn.classList.remove('active');
      statusText.textContent = 'Ready';
      statusBadge.classList.remove('active');
    }
  }

  // --- Weekly digest ---
  const digestCard = document.getElementById('digestCard');
  const digestText = document.getElementById('digestText');
  const digestDismiss = document.getElementById('digestDismiss');

  function updateDigest() {
    chrome.storage.local.get('weeklyDigest', (data) => {
      const digest = data.weeklyDigest;
      if (!digest || digest.dismissed) {
        digestCard.classList.remove('visible');
        return;
      }
      digestText.textContent = `This week: ${digest.newTerms} new term${digest.newTerms !== 1 ? 's' : ''} from ${digest.videoCount} video${digest.videoCount !== 1 ? 's' : ''}. Mostly ${digest.topicSummary}.`;
      digestCard.classList.add('visible');
    });
  }

  updateDigest();

  digestDismiss.addEventListener('click', () => {
    chrome.storage.local.get('weeklyDigest', (data) => {
      if (data.weeklyDigest) {
        data.weeklyDigest.dismissed = true;
        chrome.storage.local.set({ weeklyDigest: data.weeklyDigest });
      }
    });
    digestCard.classList.remove('visible');
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.weeklyDigest) updateDigest();
  });

  // --- Learning stats ---
  const learningStatsEl = document.getElementById('learningStats');

  function updateLearningStats() {
    chrome.storage.local.get(['knowledgeBase', 'sessionCount'], (data) => {
      const kb = data.knowledgeBase || {};
      const entries = Object.values(kb);
      if (entries.length === 0) {
        learningStatsEl.classList.remove('visible');
        return;
      }
      const termCount = entries.length;
      const sessions = data.sessionCount || 0;

      // Find top topic by counting entity types
      const typeCounts = {};
      entries.forEach(e => {
        const t = (e.type || 'other').toLowerCase();
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      });
      const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];
      const typeLabels = {
        concept: 'concepts', event: 'history', person: 'people',
        people: 'people', stock: 'finance', organization: 'organizations',
        commodity: 'commodities', other: 'general'
      };
      const topLabel = typeLabels[topType] || topType;

      let parts = [`${termCount} term${termCount !== 1 ? 's' : ''}`];
      if (sessions > 0) parts.push(`${sessions} session${sessions !== 1 ? 's' : ''}`);
      parts.push(`mostly ${topLabel}`);
      learningStatsEl.textContent = parts.join(' · ');
      learningStatsEl.classList.add('visible');
    });
  }

  updateLearningStats();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.knowledgeBase || changes.sessionCount) {
      updateLearningStats();
    }
  });

  // --- Edit preferences ---
  document.getElementById('editPrefsBtn').addEventListener('click', () => {
    showPreferences();
  });

  // --- Settings panel ---
  const settingsGearBtn = document.getElementById('settingsGearBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const cardsPerChunkSlider = document.getElementById('cardsPerChunk');
  const cardsPerChunkVal = document.getElementById('cardsPerChunkVal');
  const depthSlider = document.getElementById('depthSlider');
  const depthVal = document.getElementById('depthVal');
  const positionToggle = document.getElementById('positionToggle');
  const autoHideToggle = document.getElementById('autoHideToggle');

  const depthLabels = { 1: 'Surface', 2: 'Balanced', 3: 'Deep cuts' };

  let currentSettings = {
    cardsPerChunk: 3,
    depth: 2,
    sidebarPosition: 'right',
    autoHide: false
  };

  chrome.storage.local.get('extensionSettings', (data) => {
    if (data.extensionSettings) {
      currentSettings = { ...currentSettings, ...data.extensionSettings };
    }
    applySettingsToUI();
  });

  function applySettingsToUI() {
    cardsPerChunkSlider.value = currentSettings.cardsPerChunk;
    cardsPerChunkVal.textContent = currentSettings.cardsPerChunk;

    depthSlider.value = currentSettings.depth;
    depthVal.textContent = depthLabels[currentSettings.depth] || 'Balanced';

    positionToggle.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.pos === currentSettings.sidebarPosition);
    });

    autoHideToggle.classList.toggle('on', currentSettings.autoHide);
  }

  function saveSettings() {
    chrome.storage.local.set({ extensionSettings: currentSettings });
  }

  settingsGearBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
  });

  cardsPerChunkSlider.addEventListener('input', () => {
    currentSettings.cardsPerChunk = parseInt(cardsPerChunkSlider.value, 10);
    cardsPerChunkVal.textContent = currentSettings.cardsPerChunk;
    saveSettings();
  });

  depthSlider.addEventListener('input', () => {
    currentSettings.depth = parseInt(depthSlider.value, 10);
    depthVal.textContent = depthLabels[currentSettings.depth] || 'Balanced';
    saveSettings();
  });

  positionToggle.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSettings.sidebarPosition = btn.dataset.pos;
      positionToggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings();
    });
  });

  autoHideToggle.addEventListener('click', () => {
    currentSettings.autoHide = !currentSettings.autoHide;
    autoHideToggle.classList.toggle('on', currentSettings.autoHide);
    saveSettings();
  });

  // --- Session recap ---
  const recapSection = document.getElementById('recapSection');
  const recapCount = document.getElementById('recapCount');
  const viewRecapBtn = document.getElementById('viewRecapBtn');
  const recapOverlay = document.getElementById('recapOverlay');
  const recapCloseBtn = document.getElementById('recapCloseBtn');
  const recapList = document.getElementById('recapList');
  const copyRecapBtn = document.getElementById('copyRecapBtn');
  const exportGuideBtn = document.getElementById('exportGuideBtn');

  const TYPE_COLORS = {
    event: '#ff9500', concept: '#7070ff', person: '#00d4aa',
    people: '#00d4aa', stock: '#00e676', organization: '#4d9fff',
    commodity: '#ff9500'
  };

  function updateRecapSection() {
    chrome.storage.local.get(['sessionHistory', 'capturing'], (data) => {
      const history = data.sessionHistory || [];
      if (history.length > 0 || data.capturing) {
        recapSection.classList.add('visible');
        recapCount.textContent = history.length;
      } else {
        recapSection.classList.remove('visible');
      }
    });
  }

  updateRecapSection();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sessionHistory || changes.capturing) {
      updateRecapSection();
    }
  });

  viewRecapBtn.addEventListener('click', () => {
    chrome.storage.local.get('sessionHistory', (data) => {
      const history = data.sessionHistory || [];
      renderRecapList(history);
      recapOverlay.classList.add('open');
    });
  });

  recapCloseBtn.addEventListener('click', () => {
    recapOverlay.classList.remove('open');
  });

  function renderRecapList(history) {
    recapList.innerHTML = '';
    if (history.length === 0) {
      recapList.innerHTML = '<div style="font-size:11px;color:#3a3a5a;text-align:center;padding:20px 0;">No terms yet</div>';
      return;
    }

    const grouped = {};
    history.forEach(entry => {
      const t = (entry.type || 'other').toLowerCase();
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(entry);
    });

    Object.keys(grouped).sort().forEach(type => {
      const label = document.createElement('div');
      label.className = 'recap-group-label';
      label.style.color = TYPE_COLORS[type] || '#4a4a6a';
      label.textContent = type.toUpperCase();
      recapList.appendChild(label);

      grouped[type].forEach(entry => {
        const el = document.createElement('div');
        el.className = 'recap-term';
        el.textContent = entry.term;
        if (entry.description) {
          const desc = document.createElement('div');
          desc.className = 'recap-term-desc';
          desc.textContent = entry.description;
          el.appendChild(desc);
        }
        recapList.appendChild(el);
      });
    });
  }

  function buildRecapText(history) {
    const grouped = {};
    history.forEach(entry => {
      const t = (entry.type || 'other').toUpperCase();
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(entry);
    });
    let text = '';
    Object.keys(grouped).sort().forEach(type => {
      text += `${type}\n`;
      grouped[type].forEach(e => {
        text += `  ${e.term}${e.description ? ' — ' + e.description : ''}\n`;
      });
      text += '\n';
    });
    return text.trim();
  }

  copyRecapBtn.addEventListener('click', () => {
    chrome.storage.local.get('sessionHistory', (data) => {
      const text = buildRecapText(data.sessionHistory || []);
      navigator.clipboard.writeText(text).then(() => {
        copyRecapBtn.textContent = 'Copied!';
        copyRecapBtn.classList.add('copied');
        setTimeout(() => {
          copyRecapBtn.textContent = 'Copy to clipboard';
          copyRecapBtn.classList.remove('copied');
        }, 1500);
      });
    });
  });

  exportGuideBtn.addEventListener('click', () => {
    chrome.storage.local.get(['sessionHistory', 'capturingTabTitle'], (data) => {
      const history = data.sessionHistory || [];
      const title = data.capturingTabTitle || 'Untitled Video';
      let guide = `STUDY GUIDE: ${title}\n${'='.repeat(40)}\n\n`;
      guide += buildRecapText(history);
      navigator.clipboard.writeText(guide).then(() => {
        exportGuideBtn.textContent = 'Copied!';
        exportGuideBtn.classList.add('copied');
        setTimeout(() => {
          exportGuideBtn.textContent = 'Export study guide';
          exportGuideBtn.classList.remove('copied');
        }, 1500);
      });
    });
  });
}
