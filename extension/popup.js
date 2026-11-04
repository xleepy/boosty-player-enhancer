'use strict';
const toggle = document.getElementById('enabled');
chrome.storage.local.get({ enabled: false }).then(settings => {
  toggle.checked = settings.enabled === true;
  toggle.disabled = false;
}).catch(() => {
  document.querySelector('label').textContent = 'Закройте и откройте меню расширения ещё раз.';
});
toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked }).catch(() => {
    toggle.checked = !toggle.checked;
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) toggle.checked = changes.enabled.newValue === true;
});
