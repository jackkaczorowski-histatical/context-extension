const toggleBtn = document.getElementById('toggleBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

let isActive = false;

// Load saved state
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
    toggleBtn.textContent = 'Stop Listening';
    toggleBtn.classList.add('active');
    statusDot.classList.add('active');
    statusText.textContent = 'Listening to tab audio...';
  } else {
    toggleBtn.textContent = 'Start Listening';
    toggleBtn.classList.remove('active');
    statusDot.classList.remove('active');
    statusText.textContent = 'Ready';
  }
}

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

// Load saved settings
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
