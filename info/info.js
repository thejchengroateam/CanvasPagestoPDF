document.addEventListener('DOMContentLoaded', () => {
  const btnClose = document.getElementById('btn-close-window');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      window.close();
    });
  }
});
