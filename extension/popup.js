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
