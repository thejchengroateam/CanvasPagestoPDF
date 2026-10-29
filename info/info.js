document.addEventListener('DOMContentLoaded', () => {
  const btnClose = document.getElementById('btn-close-window');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      window.close();
    });
  }

  const versionEl = document.getElementById('extension-version');
  if (versionEl && chrome?.runtime?.getManifest) {
    const manifest = chrome.runtime.getManifest();
    if (manifest && manifest.version) {
      versionEl.textContent = `v${manifest.version}`;
    }
  }
});
