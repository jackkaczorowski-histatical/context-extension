// --- Onboarding check ---
const onboardingEl = document.getElementById('onboarding');
const mainPopupEl = document.getElementById('mainPopup');

chrome.storage.local.get('onboardingComplete', (data) => {
  if (data.onboardingComplete) {
    showMainPopup();
  } else {
    showOnboarding(false);
  }
});

function showOnboarding(isOverlay) {
  onboardingEl.style.display = 'block';

  if (isOverlay) {
    onboardingEl.classList.add('overlay');
  } else {
    onboardingEl.classList.remove('overlay');
    mainPopupEl.style.display = 'none';
  }

  let selectedLevel = null;
  const levelButtons = onboardingEl.querySelectorAll('.ob-level-btn');
  const getStartedBtn = document.getElementById('getStartedBtn');
  const checkboxes = onboardingEl.querySelectorAll('#interestCheckboxes input');

  // Pre-fill from existing profile if editing
  chrome.storage.local.get('userProfile', (data) => {
    if (data.userProfile) {
      // Pre-select knowledge level
      levelButtons.forEach(btn => {
        if (btn.dataset.level === data.userProfile.knowledgeLevel) {
          btn.classList.add('selected');
          selectedLevel = data.userProfile.knowledgeLevel;
          getStartedBtn.disabled = false;
        }
      });
      // Pre-check interests
      const saved = data.userProfile.interests || [];
      checkboxes.forEach(cb => {
        cb.checked = saved.includes(cb.value);
      });
    }
  });

  if (!selectedLevel) {
    getStartedBtn.disabled = true;
  }

  // Clone and replace to remove old event listeners
  levelButtons.forEach(btn => {
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
  });

  const freshLevelButtons = onboardingEl.querySelectorAll('.ob-level-btn');
  freshLevelButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      freshLevelButtons.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedLevel = btn.dataset.level;
      getStartedBtn.disabled = false;
    });
  });

  const freshGetStarted = getStartedBtn.cloneNode(true);
  getStartedBtn.parentNode.replaceChild(freshGetStarted, getStartedBtn);

  freshGetStarted.addEventListener('click', () => {
    const interests = Array.from(
      onboardingEl.querySelectorAll('#interestCheckboxes input:checked')
    ).map(cb => cb.value);

    const userProfile = { knowledgeLevel: selectedLevel, interests };
    chrome.storage.local.set({ userProfile, onboardingComplete: true }, () => {
      onboardingEl.style.display = 'none';
      onboardingEl.classList.remove('overlay');
      if (!isOverlay) {
        showMainPopup();
      }
    });
  });
}

function showMainPopup() {
  onboardingEl.style.display = 'none';
  mainPopupEl.style.display = 'block';
  initMainPopup();
}

function initMainPopup() {
  const toggleBtn = document.getElementById('toggleBtn');
  const statusText = document.getElementById('statusText');

  let isActive = false;

  chrome.storage.local.get('capturing', (data) => {
    if (data.capturing) {
      setActiveState(true);
    }
  });

  toggleBtn.addEventListener('click', () => {
    isActive = !isActive;
    setActiveState(isActive);

    const message = isActive ? 'START_CAPTURE' : 'STOP_CAPTURE';
    chrome.runtime.sendMessage({ type: message });
    chrome.storage.local.set({ capturing: isActive });
  });

  function setActiveState(active) {
    isActive = active;
    if (active) {
      toggleBtn.textContent = 'Stop listening';
      toggleBtn.classList.add('active');
      statusText.textContent = 'Listening to tab audio...';
    } else {
      toggleBtn.textContent = 'Start listening';
      toggleBtn.classList.remove('active');
      statusText.textContent = 'Ready';
    }
  }

  // --- Edit preferences ---
  const editPrefsBtn = document.getElementById('editPrefsBtn');
  editPrefsBtn.addEventListener('click', () => {
    showOnboarding(true);
  });

  // --- Settings panel ---
  const settingsGearBtn = document.getElementById('settingsGearBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const cardsPerChunkSlider = document.getElementById('cardsPerChunk');
  const cardsPerChunkVal = document.getElementById('cardsPerChunkVal');
  const positionToggle = document.getElementById('positionToggle');
  const autoHideToggle = document.getElementById('autoHideToggle');

  let currentSettings = {
    cardsPerChunk: 3,
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
}
