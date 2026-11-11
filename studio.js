'use strict';
/* Beelup Studio v1.2 — reproductor, recorte y exportación (TS / MP4). */
(() => {
  const $ = id => document.getElementById(id);
  const BASE = 'https://beelup-studio-api.mgcarnevali.workers.dev';
  const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Límite de datos para MP4. Los datos se guardan en Blobs (no en el heap de JS).
  const MP4_LIMIT_MB = IS_MOBILE ? 600 : 2000;
  const PARALLEL = 3;          // descargas simultáneas de segmentos
  const START_PREROLL = 0.4;   // s: margen para que el recorte nunca empiece tarde

  let selection = null, segments = [], duration = 0, hls = null, busy = false;
  let playlistBlob = null, playlistId = null, loadVersion = 0, previewing = false;
  let exportAbort = null, seekDragging = false, hideControlsTimer = null, nativeFallbackTried = false;

  const video = $('native-video');
  const stage = $('video-stage');

  /* ---------------- Iconos ---------------- */
  const shapes = {
    play: '<path d="m8 5 12 7-12 7z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    back: '<path d="M11 5 4 12l7 7V5Zm9 0-7 7 7 7V5Z"/>',
    forward: '<path d="m13 5 7 7-7 7V5ZM4 5l7 7-7 7V5Z"/>',
    volume: '<path d="M11 5 6 9H3v6h3l5 4V5ZM15 9a5 5 0 0 1 0 6M18 6a9 9 0 0 1 0 12"/>',
    mute: '<path d="M11 5 6 9H3v6h3l5 4V5ZM16 9l5 6m0-6-5 6"/>',
    full: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    exitfull: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
    in: '<path d="M5 5v14M19 6l-7 6 7 6"/>',
    out: '<path d="M19 5v14M5 6l7 6-7 6"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
  const setIcon = (id, name) => { const el = $(id); if (el.dataset.icon !== name) { el.innerHTML = icon(name); el.dataset.icon = name; } };
  setIcon('skip-back', 'back'); setIcon('skip-forward', 'forward'); setIcon('fullscreen', 'full');
  setIcon('mark-in', 'in'); setIcon('mark-out', 'out'); setIcon('preview-clip', 'play');
  setIcon('mute', 'volume'); setIcon('play-toggle', 'play');

  /* ---------------- Utilidades ---------------- */
  const message = s => { $('studio-message').textContent = s; };
  const progress = s => { $('export-status').textContent = s; };
  const fmt = value => {
    const s = Math.max(0, Math.floor(Number(value) || 0));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, '0')).join(':');
  };
  const seconds = text => {
    const parts = String(text).trim().split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(x => !Number.isInteger(x) || x < 0) || parts.slice(1).some(x => x > 59)) return NaN;
    return parts.reduce((a, b) => a * 60 + b, 0);
  };
  const mb = bytes => (bytes / 1048576).toFixed(1);

  async function api(path, params, signal) {
    const timeout = AbortSignal.timeout(path === '/api/segment' ? 60000 : 25000);
    const sig = signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : (signal || timeout);
    const r = await fetch(BASE + path + '?' + new URLSearchParams(params), { cache: 'no-store', signal: sig });
    if (!r.ok) {
      let m = `HTTP ${r.status}`;
      try { m = (await r.json()).error || m; } catch { /* sin cuerpo JSON */ }
      const err = Error(m); err.status = r.status; throw err;
    }
    return r;
  }

  function parsePlaylist(txt) {
    const rows = txt.split(/\r?\n/);
    let time = 0, pending = null;
    const items = [];
    for (const raw of rows) {
      const row = raw.trim();
      if (row.startsWith('#EXT-X-KEY') || row.startsWith('#EXT-X-MAP')) throw Error('Formato HLS no compatible con este exportador.');
      if (row.startsWith('#EXTINF:')) pending = Number(row.slice(8).split(',')[0]);
      else if (row && !row.startsWith('#')) {
        if (!Number.isFinite(pending) || pending <= 0) throw Error('Playlist HLS no compatible.');
        items.push({ url: row, start: time, end: time + pending });
        time += pending; pending = null;
      }
    }
    if (!items.length) throw Error('No hay segmentos de video.');
    return { items, time };
  }

  /* ---------------- Recorte ---------------- */
  function update() {
    const a = seconds($('clip-start').value), b = seconds($('clip-end').value);
    const valid = Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b <= Math.ceil(duration) && a < b;
    for (const id of ['clip-start', 'clip-end']) $(id).toggleAttribute('aria-invalid', !valid);
    $('clip-summary').textContent = valid ? `${fmt(a)} → ${fmt(b)}` : 'Ingresá un rango válido';
    $('clip-length').textContent = valid ? fmt(b - a) : '—';
    if (valid && duration > 0) {
      $('trim-in').value = a; $('trim-out').value = b;
      const track = $('trim-highlight');
      track.style.left = `${a / duration * 100}%`;
      track.style.width = `${Math.min(b - a, duration - a) / duration * 100}%`;
    }
    return valid ? { a, b } : null;
  }

  function suggestedName() {
    const clean = v => String(v || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
    const courtLabel = $('court')?.selectedOptions?.[0]?.textContent?.trim();
    const courtName = courtLabel && !/^elegí|^seleccion/i.test(courtLabel) ? courtLabel : selection?.court;
    return [selection?.club, courtName, selection?.date, selection?.time?.replace(':', '-')].map(clean).filter(Boolean).join(' - ') || 'Mi partido';
  }
  function downloadName(full, a, b, ext) {
    let base = ($('export-name').value || suggestedName()).replace(/\.(mp4|ts)$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().replace(/[. ]+$/, '');
    if (!base) base = 'Mi partido';
    return (base + (full ? ' - completo' : ` - ${fmt(a).replaceAll(':', '-')} a ${fmt(b).replaceAll(':', '-')}`)).slice(0, 195) + '.' + ext;
  }

  /* ---------------- Reproductor ---------------- */
  function showControls() {
    stage.classList.remove('controls-idle');
    clearTimeout(hideControlsTimer);
    if (!video.paused && !seekDragging) hideControlsTimer = setTimeout(() => stage.classList.add('controls-idle'), 3200);
  }

  function syncPlayer() {
    setIcon('play-toggle', video.paused ? 'play' : 'pause');
    $('play-toggle').setAttribute('aria-label', video.paused ? 'Reproducir' : 'Pausar');
    const total = duration || video.duration || 0;
    const shown = seekDragging ? Number($('seek').value) : (video.currentTime || 0);
    $('play-clock').textContent = `${fmt(shown)} / ${fmt(total)}`;
    if (!seekDragging) $('seek').value = video.currentTime || 0;
    const pct = total ? Math.min(100, shown / total * 100) : 0;
    $('seek').style.setProperty('--progress', pct + '%');
    setIcon('mute', video.muted || video.volume === 0 ? 'mute' : 'volume');
    $('volume').value = video.muted ? 0 : video.volume;
    const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    setIcon('fullscreen', fs ? 'exitfull' : 'full');
    $('fullscreen').setAttribute('aria-label', fs ? 'Salir de pantalla completa' : 'Pantalla completa');
  }

  function stopPreview() {
    if (!previewing) return;
    previewing = false;
    setIcon('preview-clip', 'play');
    $('preview-clip').setAttribute('aria-label', 'Reproducir recorte');
  }

  function clear() {
    stopPreview();
    $('player-controls').classList.add('hidden');
    stage.classList.remove('buffering', 'controls-idle');
    if (hls) { hls.destroy(); hls = null; }
    if (playlistBlob) { URL.revokeObjectURL(playlistBlob); playlistBlob = null; }
    video.removeAttribute('src');
    video.load();
    segments = []; duration = 0; nativeFallbackTried = false;
    $('studio-editor').classList.add('hidden');
  }

  function makePlayer(txt) {
    const proxied = txt.split(/\r?\n/).map(line => line && !line.startsWith('#') ? BASE + '/api/segment?' + new URLSearchParams({ url: line.trim() }) : line).join('\n');
    playlistBlob = URL.createObjectURL(new Blob([proxied], { type: 'application/vnd.apple.mpegurl' }));
    if (window.Hls && Hls.isSupported()) {
      // Tiempos de espera más cortos que los predeterminados (120 s) para que un
      // segmento trabado se reintente rápido en redes móviles inestables.
      const fragPolicy = { default: { maxTimeToFirstByteMs: 8000, maxLoadTimeMs: 30000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } };
      hls = new Hls({ enableWorker: true, maxBufferLength: 30, backBufferLength: 60, fragLoadPolicy: fragPolicy });
      let mediaRecoveries = 0;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          message('Conexión inestable: reintentando la carga del video…');
          setTimeout(() => hls && hls.startLoad(), 1500);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 3) {
          mediaRecoveries++;
          hls.recoverMediaError();
        } else {
          message('Error del reproductor: ' + data.details + '. Podés reintentar o descargar el video.');
          $('player-error').classList.remove('hidden');
        }
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { if (/reintentando/.test($('studio-message').textContent)) message('Video listo. Elegí el fragmento o descargá el partido completo.'); });
      hls.loadSource(playlistBlob);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlistBlob;
    } else {
      message('Este navegador no admite HLS; la exportación puede seguir disponible.');
    }
  }

  // Safari sin MSE: si la playlist en blob: falla, usar la playlist del Worker directamente.
  video.addEventListener('error', () => {
    if (hls || !playlistId || nativeFallbackTried || !video.getAttribute('src')) return;
    nativeFallbackTried = true;
    video.src = BASE + '/api/playlist?' + new URLSearchParams({ id: playlistId, camara: 'central' });
  });

  async function loadVideo() {
    if (!selection) return;
    const version = loadVersion;
    clear();
    message('Buscando grabación y playlist HLS…');
    try {
      const resolved = await (await api('/api/resolve', { code: selection.code, complejo: selection.club, cancha: selection.court, fecha: selection.date, hora: selection.time })).json();
      if (version !== loadVersion) return;
      const r = await api('/api/playlist', { id: resolved.id, camara: 'central' });
      const txt = await r.text();
      if (version !== loadVersion) return;
      if (!txt.startsWith('#EXTM3U')) throw Error('No se recibió una playlist HLS.');
      const parsed = parsePlaylist(txt);
      playlistId = resolved.id;
      segments = parsed.items; duration = parsed.time;
      makePlayer(txt);
      $('video-duration').textContent = 'Duración: ' + fmt(duration);
      $('player-controls').classList.remove('hidden');
      $('seek').max = duration;
      $('clip-start').value = '00:00:00';
      $('clip-end').value = fmt(Math.min(300, duration));
      $('studio-editor').classList.remove('hidden');
      $('trim-in').max = Math.floor(duration); $('trim-out').max = Math.floor(duration);
      $('trim-in').value = 0; $('trim-out').value = Math.floor(Math.min(300, duration));
      $('export-name').value = suggestedName();
      $('video-placeholder').classList.add('hidden');
      $('player-error').classList.add('hidden');
      progress('');
      showControls();
      message('Video listo. Elegí el fragmento o descargá el partido completo.');
      update(); syncPlayer();
    } catch (e) {
      if (version !== loadVersion) return;
      const text = e.status === 403 ? 'Este partido requiere acceso en Beelup.' : e.message;
      message('No se pudo cargar el video: ' + text);
      $('player-error').classList.remove('hidden');
      console.warn(e);
    }
  }

  window.addEventListener('beelup:selection', e => {
    if (exportAbort) exportAbort.abort();
    selection = e.detail; loadVersion++;
    clear();
    $('video-placeholder').classList.remove('hidden');
    $('player-error').classList.add('hidden');
    message('Cargando video…');
    loadVideo();
  });
  $('retry-video').addEventListener('click', () => { loadVersion++; loadVideo(); });

  /* ---------------- Controles ---------------- */
  const togglePlay = () => (video.paused || video.ended ? video.play().catch(() => {}) : video.pause());
  const seekTo = t => {
    if (!duration) return;
    const target = Math.max(0, Math.min(duration - 0.1, t));
    if (previewing) {
      const a = seconds($('clip-start').value), b = seconds($('clip-end').value);
      if (target < a - 1 || target > b) stopPreview();
    }
    video.currentTime = target;
    syncPlayer();
  };

  stage.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') showControls(); });
  stage.addEventListener('pointerdown', showControls);
  video.addEventListener('pause', showControls);
  video.addEventListener('play', showControls);

  // Clic/tap sobre la imagen: con mouse alterna reproducción; con el dedo,
  // si los controles están ocultos primero los muestra.
  let pointerTypeDown = 'mouse', idleAtDown = false;
  video.addEventListener('pointerdown', e => { pointerTypeDown = e.pointerType; idleAtDown = stage.classList.contains('controls-idle'); }, { capture: true });
  video.addEventListener('click', () => {
    if (!duration) return;
    if (pointerTypeDown !== 'mouse' && idleAtDown) { showControls(); return; }
    togglePlay();
  });
  video.addEventListener('dblclick', () => { if (pointerTypeDown === 'mouse') toggleFullscreen(); });

  $('play-toggle').addEventListener('click', togglePlay);
  $('skip-back').addEventListener('click', () => seekTo(video.currentTime - 10));
  $('skip-forward').addEventListener('click', () => seekTo(video.currentTime + 10));

  // Barra de posición: durante el arrastre sólo se actualiza el reloj; se busca al soltar.
  const seek = $('seek');
  const endDrag = () => { if (!seekDragging) return; seekDragging = false; seekTo(Number(seek.value)); showControls(); };
  seek.addEventListener('pointerdown', () => { seekDragging = true; showControls(); });
  seek.addEventListener('input', () => {
    if (!seekDragging) { seekTo(Number(seek.value)); return; } // teclado
    syncPlayer();
  });
  seek.addEventListener('change', endDrag);
  seek.addEventListener('pointerup', endDrag);
  seek.addEventListener('pointercancel', endDrag);

  $('volume').addEventListener('input', () => { video.volume = Number($('volume').value); video.muted = video.volume === 0; syncPlayer(); });
  $('mute').addEventListener('click', () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 1; syncPlayer(); });
  $('speed').addEventListener('change', () => { video.playbackRate = Number($('speed').value); });
  video.addEventListener('loadedmetadata', () => { video.playbackRate = Number($('speed').value); });

  function toggleFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  }
  $('fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', syncPlayer);
  document.addEventListener('webkitfullscreenchange', syncPlayer);

  // Atajos de teclado cuando el reproductor tiene el foco.
  stage.tabIndex = 0;
  stage.addEventListener('keydown', e => {
    if (!duration || e.target.matches('input[type=text], select')) return;
    const keys = { ' ': togglePlay, k: togglePlay, ArrowLeft: () => seekTo(video.currentTime - 5), ArrowRight: () => seekTo(video.currentTime + 5), j: () => seekTo(video.currentTime - 10), l: () => seekTo(video.currentTime + 10), f: toggleFullscreen, m: () => { video.muted = !video.muted; syncPlayer(); } };
    if (e.target === seek && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const fn = keys[e.key];
    if (fn) { e.preventDefault(); fn(); showControls(); }
  });

  for (const ev of ['play', 'pause', 'loadedmetadata', 'seeked', 'volumechange', 'durationchange'])
    video.addEventListener(ev, syncPlayer);
  video.addEventListener('waiting', () => stage.classList.add('buffering'));
  for (const ev of ['playing', 'canplay', 'seeked', 'pause']) video.addEventListener(ev, () => stage.classList.remove('buffering'));
  video.addEventListener('timeupdate', () => {
    syncPlayer();
    if (previewing && video.currentTime >= seconds($('clip-end').value)) { stopPreview(); video.pause(); }
  });

  /* ---------------- Edición del recorte ---------------- */
  for (const id of ['clip-start', 'clip-end']) {
    $(id).addEventListener('input', update);
    $(id).addEventListener('blur', () => { const v = seconds($(id).value); if (Number.isFinite(v)) $(id).value = fmt(v); update(); });
  }
  for (const [slider, field, other] of [['trim-in', 'clip-start', 'clip-end'], ['trim-out', 'clip-end', 'clip-start']]) {
    $(slider).addEventListener('input', () => {
      let v = Number($(slider).value);
      let o = seconds($(other).value);
      if (!Number.isFinite(o)) o = slider === 'trim-in' ? Math.floor(duration) : 0;
      v = slider === 'trim-in' ? Math.min(v, o - 1) : Math.max(v, o + 1);
      $(field).value = fmt(Math.max(0, Math.min(v, Math.floor(duration))));
      update();
    });
  }
  function mark(which) {
    const now = Math.floor(video.currentTime);
    if (which === 'start') {
      const end = seconds($('clip-end').value);
      if (Number.isFinite(end) && now >= end) $('clip-end').value = fmt(Math.min(Math.floor(duration), now + 60));
      $('clip-start').value = fmt(Math.min(now, Math.floor(duration) - 1));
    } else {
      const start = seconds($('clip-start').value);
      if (Number.isFinite(start) && now <= start) $('clip-start').value = fmt(Math.max(0, now - 60));
      $('clip-end').value = fmt(Math.max(now, 1));
    }
    update();
  }
  $('mark-in').addEventListener('click', () => mark('start'));
  $('mark-out').addEventListener('click', () => mark('end'));
  $('preview-clip').addEventListener('click', () => {
    if (previewing) { stopPreview(); video.pause(); return; }
    const r = update();
    if (!r) { progress('Seleccioná un recorte válido.'); return; }
    previewing = true;
    video.currentTime = r.a;
    video.play().catch(() => {});
    setIcon('preview-clip', 'stop');
    $('preview-clip').setAttribute('aria-label', 'Detener vista previa');
  });

  /* ---------------- Exportación ---------------- */
  const exportButtons = ['download-clip', 'download-full', 'download-mp4', 'download-full-mp4'].map($).filter(Boolean);

  // Descarga los segmentos con algunas peticiones en paralelo y reintentos,
  // entregándolos en orden a `consume`.
  async function fetchSegments(list, signal, consume) {
    let next = 0, done = 0;
    const results = new Map();
    let deliver = 0;
    const fetchOne = async index => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api('/api/segment', { url: list[index].url }, signal);
          return await r.arrayBuffer();
        } catch (e) {
          if (signal.aborted || attempt >= 3 || (e.status && e.status < 500 && e.status !== 429)) throw e;
          await new Promise(res => setTimeout(res, 800 * 2 ** attempt));
        }
      }
    };
    let failure = null;
    const workers = Array.from({ length: Math.min(PARALLEL, list.length) }, async () => {
      while (next < list.length && !failure) {
        const index = next++;
        try { results.set(index, await fetchOne(index)); } catch (e) { failure = failure || e; return; }
        while (results.has(deliver) && !failure) {
          const buf = results.get(deliver); results.delete(deliver);
          try { await consume(buf, list[deliver], deliver); } catch (e) { failure = failure || e; return; }
          deliver++; done++;
        }
      }
    });
    await Promise.all(workers);
    if (failure) throw failure;
    if (done !== list.length) throw Error('Descarga incompleta.');
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name; link.rel = 'noopener';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60000);
  }

  async function exportVideo(full, mp4 = false) {
    if (busy || !segments.length) return;
    const a = full ? 0 : seconds($('clip-start').value);
    const b = full ? duration : seconds($('clip-end').value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > Math.ceil(duration) + 0.1 || a >= b) { progress('Inicio y fin inválidos.'); return; }
    // Para MP4 se toma un segmento extra antes del inicio (margen de cuadro clave).
    const from = mp4 && !full ? Math.max(0, a - START_PREROLL) : a;
    const chosen = segments.filter(s => s.end > from && s.start < b);
    if (!chosen.length) { progress('El rango elegido no contiene video.'); return; }
    const approx = chosen.at(-1).end - chosen[0].start;
    if (!full && approx > 600 && !confirm('El fragmento supera 10 minutos y puede consumir muchos datos y memoria. ¿Continuar?')) return;
    if (full && !confirm('Un partido completo puede superar la memoria del navegador y consumir muchos datos. ¿Continuar?')) return;

    busy = true;
    exportAbort = new AbortController();
    const signal = exportAbort.signal;
    for (const btn of exportButtons) btn.disabled = true;
    $('cancel-export').classList.remove('hidden');
    $('export-progress').classList.remove('hidden');
    $('export-progress').value = 0;
    const details = $('download-clip').closest('details'); if (details) details.open = false;
    try {
      let bytes = 0, blob;
      const remuxer = mp4 ? new BeelupMp4.Mp4Remuxer() : null;
      const pieces = [];
      progress(`Descargando segmentos 0/${chosen.length}…`);
      await fetchSegments(chosen, signal, async (buf, seg, i) => {
        bytes += buf.byteLength;
        if (mp4) {
          if (bytes > MP4_LIMIT_MB * 1048576) throw Error(`El video supera ${MP4_LIMIT_MB} MB, demasiado para convertirlo en este dispositivo. Usá TS o un recorte más corto.`);
          remuxer.addSegment(new Uint8Array(buf), seg.start);
        } else {
          pieces.push(new Blob([buf], { type: 'video/mp2t' }));
        }
        $('export-progress').value = Math.round((i + 1) / chosen.length * 100);
        progress(`Descargando segmentos ${i + 1}/${chosen.length} · ${mb(bytes)} MB…`);
      });
      if (mp4) {
        progress('Armando MP4 (sin recodificar)…');
        await new Promise(r => setTimeout(r, 0));
        const result = remuxer.finalize(full ? {} : { start: a - START_PREROLL, end: b });
        blob = result.blob;
        if (blob.size < 1024) throw Error('MP4 vacío.');
        saveBlob(blob, downloadName(full, a, b, 'mp4'));
        const note = full ? '' : ' Empieza en el cuadro clave anterior al inicio elegido.';
        progress(`Archivo MP4 generado (${mb(blob.size)} MB, ${fmt(Math.round(result.duration))}). Video H.264 y audio AAC originales, con índice para adelantar y retroceder.${note}`);
      } else {
        blob = new Blob(pieces, { type: 'video/mp2t' });
        saveBlob(blob, downloadName(full, a, b, 'ts'));
        progress(`Archivo TS generado (${mb(blob.size)} MB). El recorte se ajusta a segmentos HLS.`);
      }
    } catch (e) {
      if (signal.aborted) progress('Descarga cancelada.');
      else { progress('Error en descarga: ' + e.message); console.warn(e); }
    } finally {
      busy = false; exportAbort = null;
      for (const btn of exportButtons) btn.disabled = false;
      $('cancel-export').classList.add('hidden');
      $('export-progress').classList.add('hidden');
    }
  }

  $('cancel-export').addEventListener('click', () => exportAbort && exportAbort.abort());
  $('download-mp4').addEventListener('click', () => exportVideo(false, true));
  $('download-full-mp4')?.addEventListener('click', () => exportVideo(true, true));
  $('download-clip').addEventListener('click', () => exportVideo(false));
  $('download-full').addEventListener('click', () => exportVideo(true));

  // Exponer para pruebas automatizadas.
  window.__beelupStudio = { get segments() { return segments; }, get duration() { return duration; } };
})();
