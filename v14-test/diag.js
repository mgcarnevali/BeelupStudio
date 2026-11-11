'use strict';
// Sólo en /v14-test/: diagnóstico visible del botón «Bardealo por WhatsApp».
(() => {
  let ok = false;
  try { ok = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'prueba.mp4', { type: 'video/mp4' })] })); } catch { ok = false; }
  const el = document.getElementById('build-share');
  if (el) el.textContent = ok ? 'sí' : 'no';
  const out = document.getElementById('diag');
  const $ = id => document.getElementById(id);
  function report() {
    const L = [];
    const w = $('bardo-wrap'), g = $('bardo-go');
    if (!w || !g) L.push('bardo-wrap: NO EXISTE en el HTML');
    else {
      const cs = getComputedStyle(w), r = g.getBoundingClientRect(), rw = w.getBoundingClientRect();
      L.push('bardo-wrap: clase="' + w.className + '" display=' + cs.display + ' alto=' + Math.round(rw.height) + ' top=' + Math.round(rw.top + scrollY));
      L.push('botón: ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' disabled=' + g.disabled);
      let top = '—';
      if (r.height && r.bottom > 0 && r.top < innerHeight) {
        const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        top = !e ? 'nada' : e.closest('#bardo-go') ? 'el botón' : (e.closest('.dl-bar') ? 'BARRA INFERIOR' : (e.id || e.className || e.tagName));
      }
      L.push('encima del botón: ' + top);
      const b = document.querySelector('.dl-bar');
      if (b) { const rb = b.getBoundingClientRect(); L.push('barra: top=' + Math.round(rb.top + scrollY) + ' pos=' + getComputedStyle(b).position); }
    }
    const f = document.querySelector('input[name=format]:checked'), s = document.querySelector('input[name=scope]:checked');
    L.push('modo: select=' + ($('export-mode') && $('export-mode').value) + ' formato=' + (f && f.value) + ' alcance=' + (s && s.value));
    const vv = window.visualViewport;
    L.push('viewport: ' + innerWidth + 'x' + innerHeight + ' visual=' + (vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) : '—') + ' dpr=' + devicePixelRatio + ' scroll=' + Math.round(scrollY) + '/' + document.documentElement.scrollHeight);
    L.push('estudio cargado: ' + !document.getElementById('result').classList.contains('hidden') + ' · exportar visible: ' + !(document.getElementById('export') || {classList:{contains:()=>true}}).classList.contains('hidden'));
    L.push('errores JS: ' + ((window.__diagErrors || []).join(' | ') || 'ninguno'));
    L.push('navegador: ' + navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''));
    if (out) out.textContent = L.join('\n');
  }
  report();
  setInterval(report, 1500);
  addEventListener('scroll', report, { passive: true });
})();
