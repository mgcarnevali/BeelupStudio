'use strict';
// Sólo en /v14-test/: muestra en el pie si el navegador permite compartir archivos MP4.
(() => {
  let ok = false;
  try { ok = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'prueba.mp4', { type: 'video/mp4' })] })); } catch { ok = false; }
  const el = document.getElementById('build-share');
  if (el) el.textContent = ok ? 'sí' : 'no';
})();
