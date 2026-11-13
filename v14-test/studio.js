'use strict';
/* Beelup Studio v1.3 — reproductor, recorte y exportación (TS / MP4).
   La lógica de reproducción, recorte y descarga es la de la v1.2; esta versión
   cambia la interfaz ("Padel Studio Premium"). El MP4 sigue en remux.js. */
(() => {
  const $ = id => document.getElementById(id);
  const BASE = 'https://beelup-studio-api-test.mgcarnevali.workers.dev'; // /v14-test/: Worker de prueba v0.9
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
  const studioParts = ['studio-editor', 'timeline', 'clip-actions', 'export'];

  /* ---------------- Iconos (sprite SVG de index.html) ---------------- */
  const setIcon = (id, name) => {
    const el = $(id);
    if (el.dataset.icon === name) return;
    const use = el.querySelector('svg use');
    if (use) use.setAttribute('href', '#i-' + name);
    el.dataset.icon = name;
  };

  /* ---------------- Utilidades ---------------- */
  const message = (s, kind = '') => { const el = $('studio-message'); el.textContent = s; el.dataset.kind = kind; };
  // Mensaje de exportación. kind: '' (sólo lectores de pantalla), 'ok', 'err', 'info'.
  const progress = (s, kind = '', title = '') => {
    const p = $('export-status');
    p.replaceChildren();
    if (title) { const b = document.createElement('b'); b.textContent = title; p.append(b); }
    p.append(document.createTextNode(s));
    const card = $('export-card');
    card.classList.remove('ok', 'err', 'info');
    if (kind && s) card.classList.add(kind);
    card.classList.toggle('hidden', !kind || !s);
  };
  const fmt = value => {
    const s = Math.max(0, Math.floor(Number(value) || 0));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, '0')).join(':');
  };
  // Formato corto para etiquetas: MM:SS en partidos de menos de una hora.
  const short = value => { const t = fmt(value); return duration < 3600 && t.startsWith('00:') ? t.slice(3) : t; };
  const seconds = text => {
    const parts = String(text).trim().split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(x => !Number.isInteger(x) || x < 0) || parts.slice(1).some(x => x > 59)) return NaN;
    return parts.reduce((a, b) => a * 60 + b, 0);
  };
  const mb = bytes => (bytes / 1048576).toFixed(1).replace('.', ',');

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

  /* ---------------- Marcador del partido ---------------- */
  const optionText = id => { const o = $(id)?.selectedOptions?.[0]; return o && o.value ? o.textContent.trim() : ''; };
  function fillScoreboard() {
    if (!selection) return;
    $('score-club').textContent = optionText('club') || selection.club;
    $('score-court').textContent = optionText('court') || selection.court;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(selection.date || '');
    $('score-date').textContent = m ? `${m[3]}.${m[2]}.${m[1]}` : (selection.date || '—');
    const hm = /(\d{1,2}:\d{2})\D+(\d{1,2}:\d{2})/.exec(optionText('time'));
    $('score-time').textContent = hm ? `${hm[1]} – ${hm[2]}` : selection.time;
    $('score-duration').textContent = '—';
    $('watch-m').href = $('watch').href;
  }

  /* ---------------- Recorte ---------------- */
  function renderTc(id) {
    const value = $(id).value;
    const view = $(id + '-view');
    const m = /^(00:)(\d{2}:\d{2})$/.exec(value);
    if (m) { view.replaceChildren(Object.assign(document.createElement('i'), { textContent: m[1] }), m[2]); }
    else view.textContent = value || '—';
  }
  function update() {
    const a = seconds($('clip-start').value), b = seconds($('clip-end').value);
    const valid = Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b <= Math.ceil(duration) && a < b;
    for (const id of ['clip-start', 'clip-end']) { $(id).toggleAttribute('aria-invalid', !valid); renderTc(id); }
    $('clip-summary').textContent = valid ? `${fmt(a)} → ${fmt(b)}` : 'Ingresá un rango válido';
    $('clip-length').textContent = valid ? short(b - a) : '—';
    $('scope-clip').textContent = valid ? `${fmt(a)} → ${fmt(b)}` : 'Rango inválido';
    if (valid && duration > 0) {
      $('trim-in').value = a; $('trim-out').value = b;
      const left = a / duration * 100, width = Math.min(b - a, duration - a) / duration * 100;
      const hl = $('trim-highlight');
      hl.style.left = `${left}%`;
      hl.style.width = `${width}%`;
      $('seek-range').style.left = `${left}%`;
      $('seek-range').style.width = `${width}%`;
      $('fl-in').textContent = short(a); $('fl-out').textContent = short(b);
      // Etiquetas de inicio y fin: se separan cuando el recorte es corto.
      const narrow = $('trim-track').clientWidth * width / 100 < 150;
      hl.querySelector('.fl-a').classList.toggle('near-a', narrow);
      hl.querySelector('.fl-b').classList.toggle('near-b', narrow);
      placeLabels(); requestAnimationFrame(placeLabels);
    }
    return valid ? { a, b } : null;
  }

  // Etiquetas INICIO/FIN: no se cortan en los bordes de la línea de tiempo ni se pisan entre sí.
  // Sólo mueve los textos; los marcadores, sus valores y su comportamiento no cambian.
  function placeLabels() {
    const track = $('trim-track'), a = track.querySelector('.fl-a'), b = track.querySelector('.fl-b');
    a.style.marginLeft = b.style.marginLeft = '';
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), t = track.getBoundingClientRect();
    if (!ra.width || !rb.width || !t.width) return;   // ocultas (móvil) o editor sin mostrar
    const fit = r => Math.max(t.left - r.left, Math.min(0, t.right - r.right));
    let da = fit(ra), db = fit(rb);
    const overlap = ra.right + da + 10 - (rb.left + db);
    if (overlap > 0) {
      const push = Math.min(overlap, Math.max(0, t.right - (rb.right + db)));
      db += push; da -= overlap - push;
    }
    a.style.marginLeft = da + 'px'; b.style.marginLeft = db + 'px';
  }

  function renderRuler() {
    const ruler = $('tl-ruler');
    ruler.replaceChildren();
    if (!duration) return;
    const min = duration / 60;
    const minor = min <= 70 ? 1 : min <= 150 ? 5 : 10;
    const major = min <= 12 ? 2 : min <= 70 ? 5 : min <= 150 ? 15 : 30;
    const frag = document.createDocumentFragment();
    for (let m = 0; m * 60 <= duration; m += minor) {
      const x = m * 60 / duration * 100;
      const tick = document.createElement('span');
      tick.className = 'tick' + (m % major === 0 ? ' major' : '');
      tick.style.left = x + '%';
      frag.append(tick);
      if (m % major === 0 && x < 97) {
        const label = document.createElement('span');
        label.className = 'tlabel' + (m === 0 ? ' first' : '');
        label.style.left = x + '%';
        label.textContent = short(m * 60);
        frag.append(label);
      }
    }
    ruler.append(frag);
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
  // Vista del nombre en móvil: hasta tres líneas, sin cortar fechas ni horas en el guion.
  function renderName() {
    const view = $('export-name-view');
    const text = $('export-name').value || $('export-name').placeholder;
    const parts = text.split(' - ');
    view.replaceChildren();
    parts.forEach((part, i) => {
      const span = document.createElement('span');
      span.textContent = part + (i < parts.length - 1 ? ' -' : '');
      if (!/\s/.test(part)) span.className = 'w';
      view.append(span, i < parts.length - 1 ? ' ' : '');
    });
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
    const clock = $('play-clock');
    clock.replaceChildren(fmt(shown) + ' ', Object.assign(document.createElement('span'), { className: 'tot', textContent: '/ ' + fmt(total) }));
    if (!seekDragging) $('seek').value = video.currentTime || 0;
    const pct = total ? Math.min(100, shown / total * 100) : 0;
    $('seek').style.setProperty('--progress', pct + '%');
    $('tl-cursor').style.left = pct + '%';
    $('tl-played').style.width = pct + '%';
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
    $('preview-clip').classList.remove('on');
    $('preview-clip').querySelector('.pv-label').textContent = 'Vista previa';
    $('preview-clip').setAttribute('aria-label', 'Reproducir recorte');
  }

  function showStudio(on) {
    $('player-controls').classList.toggle('hidden', !on);
    for (const id of studioParts) $(id).classList.toggle('hidden', !on);
  }

  function clear() {
    stopPreview();
    showStudio(false);
    stage.classList.remove('buffering', 'controls-idle');
    if (hls) { hls.destroy(); hls = null; }
    if (playlistBlob) { URL.revokeObjectURL(playlistBlob); playlistBlob = null; }
    video.removeAttribute('src');
    video.load();
    segments = []; duration = 0; nativeFallbackTried = false;
  }

  /* Playlist para el reproductor (no para exportar).
     Beelup cierra cada archivo de 5 min con un segmento de 0,0x s sin audio ni video, justo antes de
     #EXT-X-DISCONTINUITY. Al saltar al borde de un archivo, hls.js marca ese segmento como hueco y puede
     dejar de pedir el siguiente, y el video queda «buscando». Aquí se quitan sólo los segmentos que se
     verifican vacíos (sin ningún paquete de audio ni de video) y su duración se suma al segmento
     anterior, de modo que los tiempos de todos los demás segmentos y la duración total no cambian.
     La exportación sigue usando la playlist original. */
  const EMPTY_SEG_MAX = 0.2; // s: sólo se analizan segmentos así de cortos
  let playerPlaylistInfo = null;
  async function playerPlaylist(txt) {
    const rows = txt.split(/\r?\n/);
    const segs = []; // {inf, uri, d, url}
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].startsWith('#EXTINF:')) continue;
      let u = i + 1;
      while (u < rows.length && (!rows[u].trim() || rows[u].startsWith('#'))) u++;
      if (u >= rows.length) break;
      segs.push({ inf: i, uri: u, d: Number(rows[i].slice(8).split(',')[0]), url: rows[u].trim() });
      i = u;
    }
    const nextTag = s => { for (let k = s.uri + 1; k < rows.length; k++) if (rows[k].trim()) return rows[k]; return '#EXT-X-ENDLIST'; };
    const candidates = segs.filter((s, k) => k > 0 && s.d > 0 && s.d <= EMPTY_SEG_MAX && /^#EXT-X-(DISCONTINUITY|ENDLIST)\b/.test(nextTag(s)));
    // Verificación real del contenido (cada uno pesa unos cientos de bytes).
    const isEmpty = async seg => {
      try {
        const buf = await (await api('/api/segment', { url: seg.url }, AbortSignal.timeout(6000))).arrayBuffer();
        const st = { pmtPid: null, videoPid: null, audioPid: null, unsupported: null };
        const pes = BeelupMp4._internal.demuxTs(new Uint8Array(buf), st);
        return pes.video.length === 0 && pes.audio.length === 0;
      } catch { return false; } // ante cualquier duda, se conserva
    };
    const checks = candidates.length <= 60 ? await Promise.all(candidates.map(isEmpty)) : candidates.map(() => false);
    const drop = new Set(candidates.filter((_, k) => checks[k]));
    const removeRows = new Set();
    let lastKept = null;
    const durations = new Map(segs.map(s => [s, s.d]));
    for (const s of segs) {
      if (drop.has(s) && lastKept) {
        durations.set(lastKept, durations.get(lastKept) + s.d);
        removeRows.add(s.inf); removeRows.add(s.uri);
      } else lastKept = s;
    }
    const out = rows.map((row, i) => {
      if (removeRows.has(i)) return null;
      const s = segs.find(x => x.inf === i);
      if (s && durations.get(s) !== s.d) return '#EXTINF:' + Number(durations.get(s).toFixed(6)) + row.slice(8).replace(/^[^,]*/, '');
      return row;
    }).filter(r => r !== null);
    playerPlaylistInfo = { candidates: candidates.map(s => ({ url: s.url, d: s.d })), removed: [...drop].map(s => ({ url: s.url, d: s.d })) };
    return out.join('\n');
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
          message('Conexión inestable: reintentando la carga del video…', 'warn');
          setTimeout(() => hls && hls.startLoad(), 1500);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 3) {
          mediaRecoveries++;
          hls.recoverMediaError();
        } else {
          message('Error del reproductor: ' + data.details + '. Podés reintentar o descargar el video.', 'err');
          $('player-error').classList.remove('hidden');
        }
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { if (/reintentando/.test($('studio-message').textContent)) message('Video listo. Elegí el fragmento o descargá el partido completo.'); });
      hls.loadSource(playlistBlob);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlistBlob;
    } else {
      message('Este navegador no admite HLS; la exportación puede seguir disponible.', 'warn');
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
      const playerTxt = await playerPlaylist(txt);
      if (version !== loadVersion) return;
      playlistId = resolved.id;
      segments = parsed.items; duration = parsed.time;
      makePlayer(playerTxt);
      $('video-duration').textContent = 'Duración: ' + fmt(duration);
      $('score-duration').textContent = short(duration);
      $('scope-full').textContent = fmt(duration);
      $('seek').max = duration;
      $('clip-start').value = '00:00:00';
      $('clip-end').value = fmt(Math.min(300, duration));
      showStudio(true);
      $('trim-in').max = Math.floor(duration); $('trim-out').max = Math.floor(duration);
      $('trim-in').value = 0; $('trim-out').value = Math.floor(Math.min(300, duration));
      $('export-name').value = suggestedName();
      renderName();
      $('video-placeholder').classList.add('hidden');
      $('player-error').classList.add('hidden');
      progress('');
      showControls();
      message('Video listo. Elegí el fragmento o descargá el partido completo.');
      renderRuler(); update(); syncPlayer();
    } catch (e) {
      if (version !== loadVersion) return;
      const text = e.status === 403 ? 'Este partido requiere acceso en Beelup.' : e.message;
      message('No se pudo cargar el video: ' + text, 'err');
      $('video-placeholder').textContent = 'No se pudo cargar el video';
      $('player-error').classList.remove('hidden');
      console.warn(e);
    }
  }

  window.addEventListener('beelup:selection', e => {
    if (exportAbort) exportAbort.abort();
    setShareClip(null);
    selection = e.detail; loadVersion++;
    clear();
    fillScoreboard();
    document.body.classList.remove('finder-open');
    $('open-finder').setAttribute('aria-expanded', 'false');
    $('video-placeholder').textContent = 'Cargando video…';
    $('video-placeholder').classList.remove('hidden');
    $('player-error').classList.add('hidden');
    message('Cargando video…');
    loadVideo();
  });
  $('retry-video').addEventListener('click', () => { loadVersion++; $('video-placeholder').textContent = 'Cargando video…'; loadVideo(); });

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
  let swallowClick = false;
  stage.addEventListener('pointerdown', e => {
    pointerTypeDown = e.pointerType; idleAtDown = stage.classList.contains('controls-idle');
    // Con el dedo y los controles ocultos, el toque sólo los muestra: el clic que
    // le sigue no debe activar el botón que aparece debajo del dedo.
    swallowClick = e.pointerType !== 'mouse' && idleAtDown;
  }, { capture: true });
  stage.addEventListener('click', e => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault(); e.stopPropagation();
    showControls();
  }, { capture: true });
  const onSurfaceClick = e => {
    if (!duration) return;
    if (e.target.closest('button, input, select')) return;
    if (pointerTypeDown !== 'mouse' && idleAtDown) { showControls(); return; }
    // En móvil, tocar la imagen con los controles visibles los oculta (como un reproductor nativo).
    if (pointerTypeDown !== 'mouse' && e.target !== video) { if (!video.paused) stage.classList.add('controls-idle'); return; }
    togglePlay();
  };
  video.addEventListener('click', onSurfaceClick);
  $('player-controls').addEventListener('click', e => { if (e.target === $('player-controls') || e.target.classList.contains('ctl-center') || e.target.classList.contains('ctl-bottom')) onSurfaceClick(e); });
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
  // defaultPlaybackRate se conserva al recargar el video (video.load()).
  $('speed').addEventListener('change', () => { video.defaultPlaybackRate = video.playbackRate = Number($('speed').value); });
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
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  }
  // Aplica un valor al inicio o al fin respetando un segundo de separación (como la v1.2).
  function setTrim(which, value) {
    const field = which === 'in' ? 'clip-start' : 'clip-end';
    const other = which === 'in' ? 'clip-end' : 'clip-start';
    let v = Math.round(value);
    let o = seconds($(other).value);
    if (!Number.isFinite(o)) o = which === 'in' ? Math.floor(duration) : 0;
    v = which === 'in' ? Math.min(v, o - 1) : Math.max(v, o + 1);
    $(field).value = fmt(Math.max(0, Math.min(v, Math.floor(duration))));
    update();
  }
  for (const [slider, which] of [['trim-in', 'in'], ['trim-out', 'out']]) {
    $(slider).addEventListener('input', () => setTrim(which, Number($(slider).value)));
    const hd = $(which === 'in' ? 'hd-in' : 'hd-out');
    $(slider).addEventListener('focus', () => hd.classList.add('kfocus'));
    $(slider).addEventListener('blur', () => hd.classList.remove('kfocus'));
  }
  // Tiradores de la línea de tiempo: arrastre con mouse o dedo.
  for (const [id, which] of [['hd-in', 'in'], ['hd-out', 'out']]) {
    const hd = $(id);
    hd.addEventListener('pointerdown', e => {
      if (!duration) return;
      e.preventDefault(); e.stopPropagation();
      hd.setPointerCapture(e.pointerId);
      hd.classList.add('active');
      const rect = $('trim-track').getBoundingClientRect();
      const move = ev => setTrim(which, (ev.clientX - rect.left) / rect.width * duration);
      const up = () => { hd.classList.remove('active'); hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up); };
      hd.addEventListener('pointermove', move);
      hd.addEventListener('pointerup', up);
      hd.addEventListener('pointercancel', up);
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
    if (!r) { progress('Seleccioná un recorte válido.', 'err'); return; }
    previewing = true;
    video.currentTime = r.a;
    video.play().catch(() => {});
    setIcon('preview-clip', 'stop');
    $('preview-clip').classList.add('on');
    $('preview-clip').querySelector('.pv-label').textContent = 'Detener';
    $('preview-clip').setAttribute('aria-label', 'Detener vista previa');
  });

  /* ---------------- Formato, alcance y botón de descarga ---------------- */
  const mode = () => ({
    mp4: document.querySelector('input[name=format]:checked').value === 'mp4',
    full: document.querySelector('input[name=scope]:checked').value === 'full'
  });
  // Botón que muestra el progreso de la exportación en curso: 'download' o 'bardo-go'.
  let activeBtn = 'download';
  function setDownloadLabel(title, sub = '', id = 'download') {
    for (const layer of document.querySelectorAll(`#${id} .dl-layer`)) {
      layer.querySelector('.dl-title').textContent = title;
      layer.querySelector('.dl-sub').textContent = sub;
    }
    $(id).setAttribute('aria-label', sub ? `${title}, ${sub}` : title);
  }
  function syncMode(fromSelect = false) {
    if (fromSelect) {
      const [f, s] = $('export-mode').value.split('-');
      document.querySelector(`input[name=format][value=${f}]`).checked = true;
      document.querySelector(`input[name=scope][value=${s === 'full' ? 'full' : 'clip'}]`).checked = true;
    }
    const m = mode();
    $('export-mode').value = `${m.mp4 ? 'mp4' : 'ts'}-${m.full ? 'full' : 'clip'}`;
    $('mode-format').textContent = m.mp4 ? 'MP4' : 'TS';
    $('mode-scope').textContent = m.full ? 'Completo' : 'Recorte';
    $('export-ext').textContent = m.mp4 ? '.mp4' : '.ts';
    if (!busy) setDownloadLabel(`Descargar ${m.full ? 'partido completo' : 'recorte'} ${m.mp4 ? 'MP4' : '.ts'}`);
    updateShareUI();
  }
  for (const input of document.querySelectorAll('input[name=format], input[name=scope]')) input.addEventListener('change', () => syncMode());
  $('export-mode').addEventListener('change', () => syncMode(true));
  $('export-name').addEventListener('input', renderName);
  $('export-name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  function setBusy(on, which = 'download') {
    busy = on;
    if (on) activeBtn = which;
    const share = activeBtn === 'bardo-go';
    $('dl').classList.toggle('busy', on && !share);
    $('dl-bardo').classList.toggle('busy', on && share);
    $('download').disabled = on;
    $('bardo-go').disabled = on || !SHARE_SUPPORTED;
    $('cancel-export').classList.toggle('hidden', !(on && !share));
    $('bardo-cancel').classList.toggle('hidden', !(on && share));
    for (const el of document.querySelectorAll('input[name=format], input[name=scope], #export-mode')) el.disabled = on;
    $(activeBtn).style.setProperty('--p', '0%');
    if (!on) { activeBtn = 'download'; syncMode(); }
  }
  function setDownloadProgress(fraction, title, sub) {
    const pct = Math.max(0, Math.min(100, fraction * 100));
    $(activeBtn).style.setProperty('--p', pct.toFixed(1) + '%');
    $('export-progress').value = Math.round(pct);
    setDownloadLabel(title, sub, activeBtn);
  }

  /* ---------------- Exportación ---------------- */
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

  async function exportVideo(full, mp4 = false, intent = 'download') {
    if (busy || !segments.length) return;
    const sharing = intent === 'share';
    const a = full ? 0 : seconds($('clip-start').value);
    const b = full ? duration : seconds($('clip-end').value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > Math.ceil(duration) + 0.1 || a >= b) { progress('Inicio y fin inválidos.', 'err'); return; }
    // Para MP4 se toma un segmento extra antes del inicio (margen de cuadro clave).
    const from = mp4 && !full ? Math.max(0, a - START_PREROLL) : a;
    const chosen = segments.filter(s => s.end > from && s.start < b);
    if (!chosen.length) { progress('El rango elegido no contiene video.', 'err'); return; }
    const approx = chosen.at(-1).end - chosen[0].start;
    // Compartir: si el mismo recorte ya está en memoria, se reutiliza sin bajar ni procesar nada.
    const clipKey = `${loadVersion}|${a}|${b}`;
    if (sharing && shareClip && shareClip.key === clipKey) { openBardo(); return; }
    if (!full && approx > 600 && !confirm('El fragmento supera 10 minutos y puede consumir muchos datos y memoria. ¿Continuar?')) return;
    if (full && !confirm('Un partido completo puede superar la memoria del navegador y consumir muchos datos. ¿Continuar?')) return;

    setShareClip(null);
    exportAbort = new AbortController();
    const signal = exportAbort.signal;
    setBusy(true, sharing ? 'bardo-go' : 'download');
    progress('');
    const stepTitle = sharing ? 'Preparando' : 'Descargando';
    setDownloadProgress(0, stepTitle, `0/${chosen.length} · 0%`);
    try {
      let bytes = 0, blob;
      const remuxer = mp4 ? new BeelupMp4.Mp4Remuxer() : null;
      const pieces = [];
      progress(`Descargando segmentos 0/${chosen.length}…`);
      await fetchSegments(chosen, signal, async (buf, seg, i) => {
        bytes += buf.byteLength;
        // Compartir: cortar apenas se sabe que el MP4 superaría el límite.
        if (sharing && bytes > SHARE_ABORT_BYTES) throw Object.assign(Error(`El recorte supera ${SHARE_LIMIT_MB} MB y no se puede compartir. Elegí uno de hasta unos 3 minutos o descargalo.`), { tooLarge: true });
        if (mp4) {
          if (bytes > MP4_LIMIT_MB * 1048576) throw Error(`El video supera ${MP4_LIMIT_MB} MB, demasiado para convertirlo en este dispositivo. Usá TS o un recorte más corto.`);
          remuxer.addSegment(new Uint8Array(buf), seg.start);
        } else {
          pieces.push(new Blob([buf], { type: 'video/mp2t' }));
        }
        const frac = (i + 1) / chosen.length;
        setDownloadProgress(frac, stepTitle, `${i + 1}/${chosen.length} · ${Math.round(frac * 100)}%`);
        progress(`Descargando segmentos ${i + 1}/${chosen.length} · ${mb(bytes)} MB…`);
      });
      if (mp4) {
        setDownloadProgress(1, 'Armando MP4', 'sin recodificar');
        progress('Armando MP4 (sin recodificar)…');
        await new Promise(r => setTimeout(r, 0));
        const result = remuxer.finalize(full ? {} : { start: a - START_PREROLL, end: b });
        blob = result.blob;
        if (blob.size < 1024) throw Error('MP4 vacío.');
        const fileName = downloadName(full, a, b, 'mp4');
        if (sharing) {
          // Sin descarga: el MP4 queda en memoria y se abre el diálogo para compartir.
          if (blob.size > SHARE_LIMIT) throw Object.assign(Error(`El MP4 pesa ${mb(blob.size)} MB y supera el límite de ${SHARE_LIMIT_MB} MB para compartir. Elegí un recorte más corto o descargalo.`), { tooLarge: true });
          setShareClip({ blob, name: fileName, key: clipKey });
          progress('Tocá «Compartir video» para enviarlo por WhatsApp u otra app. No se descargó ningún archivo.', 'ok', `MP4 listo para compartir · ${mb(blob.size)} MB · ${fmt(Math.round(result.duration))}`);
          openBardo();
          return;
        }
        saveBlob(blob, fileName);
        if (!full && blob.size <= SHARE_LIMIT) setShareClip({ blob, name: fileName, key: clipKey });
        const note = full ? '' : ' Empieza en el cuadro clave anterior al inicio elegido.';
        progress(`Video H.264 y audio AAC originales, con índice para adelantar y retroceder.${note}`, 'ok', `MP4 generado · ${mb(blob.size)} MB · ${fmt(Math.round(result.duration))}`);
      } else {
        blob = new Blob(pieces, { type: 'video/mp2t' });
        saveBlob(blob, downloadName(full, a, b, 'ts'));
        progress('El recorte se ajusta a segmentos HLS.', 'ok', `Archivo TS generado · ${mb(blob.size)} MB`);
      }
    } catch (e) {
      if (signal.aborted) progress(sharing ? 'El video no se preparó.' : 'La descarga se detuvo antes de terminar.', 'info', sharing ? 'Preparación cancelada' : 'Descarga cancelada');
      else if (e.tooLarge) progress(e.message, 'err', 'Demasiado grande para compartir');
      else { progress(e.message, 'err', sharing ? 'No se pudo preparar el video' : 'Error en descarga'); console.warn(e); }
    } finally {
      exportAbort = null;
      setBusy(false);
    }
  }

  $('cancel-export').addEventListener('click', () => exportAbort && exportAbort.abort());
  $('bardo-cancel').addEventListener('click', () => exportAbort && exportAbort.abort());
  $('bardo-go').addEventListener('click', () => { const m = mode(); if (m.mp4 && !m.full) exportVideo(false, true, 'share'); });
  $('download').addEventListener('click', () => { const m = mode(); exportVideo(m.full, m.mp4); });

  /* ---------------- Buscador (presentación) ---------------- */
  // app.js maneja la búsqueda; aquí sólo se adapta la presentación.
  const result = $('result');
  const syncHasMatch = () => {
    const has = !result.classList.contains('hidden');
    document.body.classList.toggle('has-match', has);
    $('open-finder').classList.toggle('hidden', !has);
    $('watch-m').classList.toggle('hidden', !has);
    if (!has) document.body.classList.remove('finder-open');
  };
  new MutationObserver(syncHasMatch).observe(result, { attributes: true, attributeFilter: ['class'] });
  $('open-finder').addEventListener('click', () => {
    const open = document.body.classList.toggle('finder-open');
    $('open-finder').setAttribute('aria-expanded', String(open));
    if (open) $('explorar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  /* ---------------- Fechas y horarios en el idioma del navegador ---------------- */
  // Beelup devuelve las etiquetas en el idioma que elige su servidor (en general inglés, a veces
  // portugués). Sólo se reescribe el texto visible; el valor (fecha AAAA-MM-DD u hora) no cambia.
  const UI_LOCALE = (() => {
    for (const tag of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''])) {
      const base = String(tag).toLowerCase().split('-')[0];
      if (base === 'es' || base === 'en' || base === 'pt') return { tag, base };
    }
    return { tag: 'es-AR', base: 'es' };
  })();
  const DATE_WORDS = {
    es: { today: 'Hoy', yesterday: 'Ayer', tomorrow: 'Mañana', to: 'a' },
    en: { today: 'Today', yesterday: 'Yesterday', tomorrow: 'Tomorrow', to: 'to' },
    pt: { today: 'Hoje', yesterday: 'Ontem', tomorrow: 'Amanhã', to: 'às' }
  }[UI_LOCALE.base];
  // Palabras relativas que puede mandar Beelup (las calcula con el huso horario del club).
  const RELATIVE = { TODAY: 'today', HOY: 'today', HOJE: 'today', OGGI: 'today', YESTERDAY: 'yesterday', AYER: 'yesterday', ONTEM: 'yesterday', IERI: 'yesterday', TOMORROW: 'tomorrow', MANANA: 'tomorrow', AMANHA: 'tomorrow', DOMANI: 'tomorrow' };
  let dayFormat = null;
  try { dayFormat = new Intl.DateTimeFormat(UI_LOCALE.tag, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch { dayFormat = null; }
  const splitSuffix = text => { const i = text.indexOf(' · '); return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i)]; };
  function dateLabel(value, apiText) {
    const [label, suffix] = splitSuffix(apiText);
    const word = label.trim().split(/\s+/)[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    if (RELATIVE[word]) return DATE_WORDS[RELATIVE[word]] + suffix;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m || !dayFormat) return apiText;
    const text = dayFormat.format(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return text.charAt(0).toLocaleUpperCase(UI_LOCALE.tag) + text.slice(1) + suffix;
  }
  function timeLabel(apiText) {
    const [label, suffix] = splitSuffix(apiText);
    const hm = /(\d{1,2}:\d{2})\D+(\d{1,2}:\d{2})/.exec(label);
    return hm ? `${hm[1]} ${DATE_WORDS.to} ${hm[2]}${suffix}` : apiText;
  }
  function localizeOptions(select, make) {
    for (const o of select.options) {
      if (!o.value) continue; // los textos guía («Elegí…») no vienen de la API
      if (o.dataset.apiLabel === undefined) o.dataset.apiLabel = o.textContent;
      const text = make(o.value, o.dataset.apiLabel);
      if (o.textContent !== text) o.textContent = text;
    }
  }
  const dateSel = $('date');
  const localizeDates = () => localizeOptions(dateSel, dateLabel);
  new MutationObserver(localizeDates).observe(dateSel, { childList: true });
  localizeDates();

  // Horarios como botones en móvil (reflejan el <select id="time">).
  const timeSel = $('time');
  function renderTimeChips() {
    localizeOptions(timeSel, (value, apiText) => timeLabel(apiText));
    const box = $('time-chips');
    const opts = [...timeSel.options].filter(o => o.value);
    box.replaceChildren();
    const wrap = timeSel.closest('.pk-time');
    wrap.classList.toggle('has-chips', opts.length > 0 && !timeSel.disabled);
    wrap.querySelector('.pk-body').dataset.label = timeSel.value ? timeSel.selectedOptions[0].textContent : 'Elegí un horario';
    for (const o of opts) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip-t';
      b.textContent = o.value;
      b.setAttribute('aria-label', o.textContent);
      b.setAttribute('aria-pressed', String(o.value === timeSel.value));
      b.addEventListener('click', () => { timeSel.value = o.value; timeSel.dispatchEvent(new Event('change', { bubbles: true })); renderTimeChips(); });
      box.append(b);
    }
    const on = box.querySelector('[aria-pressed="true"]');
    if (on) box.scrollTop = on.offsetTop - box.clientHeight / 2 + on.offsetHeight / 2;
  }
  new MutationObserver(renderTimeChips).observe(timeSel, { childList: true, attributes: true, attributeFilter: ['disabled'] });
  timeSel.addEventListener('change', renderTimeChips);

  window.addEventListener('resize', () => { if (duration) update(); });

  /* ---------------- Bardealo (compartir el clip MP4) ---------------- */
  // Se comparte el mismo Blob que se acaba de descargar: no se vuelve a bajar
  // ni a procesar nada. Límite conservador: Chromium no comparte más de 50 MB.
  const SHARE_LIMIT_MB = 45;
  const SHARE_LIMIT = SHARE_LIMIT_MB * 1048576;
  // El TS que llega pesa un poco más que el MP4 resultante: margen del 3 %.
  const SHARE_ABORT_BYTES = SHARE_LIMIT * 1.03;
  const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const PHRASES = [
    'Te dejo el video porque sé que no viste pasar la pelota 😂🎾',
    'Esto no fue un partido, fue una clase gratuita 😎',
    'Guardalo, que no todos los días te hacen un punto así 😂',
    'Para que lo veas en cámara lenta y entiendas qué pasó 🐢🎾',
    'Mirá bien, que la pelota pasó por acá 👉🎾',
    'Te lo mando para que lo pongas de fondo de pantalla 🖼️😏',
    'Esto queda en el archivo histórico del club 📼😂',
    'Te mando el video, el próximo cobro entrada 🎟️😎',
    'Para que tengas pruebas cuando cuentes el partido 🙃',
    'Tranqui, a todos nos pasa. Bueno, a vos más seguido 😂',
    'Revisá el VAR: fue punto limpio 📺✅',
    'La red te esperaba, la pelota no 🥲🎾',
    'Clínica de pádel gratis, de nada 🧑‍🏫😎',
    'Se te escapó la pelota y también la dignidad 😂',
    'Ni el VAR lo puede salvar a esto 📺😂',
    'Corriste mucho, eso hay que reconocerlo 🏃‍♂️😂',
    'Video exclusivo, no lo compartas… o sí 😈',
    'Para que no digas después que no fue para tanto 🙃🎾'
  ];
  let shareClip = null, shareFile = null, lastPhrase = -1;
  // ¿El navegador permite compartir archivos MP4? (Web Share con archivos)
  const SHARE_SUPPORTED = (() => {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'prueba.mp4', { type: 'video/mp4' })] })); }
    catch { return false; }
  })();
  function updateShareUI() {
    const m = mode();
    const show = m.mp4 && !m.full;
    $('bardo-wrap').classList.toggle('hidden', !show);
    if (!busy) { $('bardo-go').disabled = !SHARE_SUPPORTED; setDownloadLabel('Bardealo por WhatsApp 😈', '', 'bardo-go'); }
    $('bardo-hint').textContent = SHARE_SUPPORTED ? '' : 'Este navegador no permite compartir archivos. Usá «Descargar recorte MP4» y adjuntalo en WhatsApp.';
  }
  const mbShort = bytes => (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB';
  function setShareClip(clip) {
    shareClip = clip; shareFile = null;
    if (!clip && $('bardo').open) $('bardo').close();
  }
  function randomPhrase() {
    let i;
    do { i = Math.floor(Math.random() * PHRASES.length); } while (PHRASES.length > 1 && i === lastPhrase);
    lastPhrase = i;
    return PHRASES[i];
  }
  const bardoNote = (text, kind = '') => { $('bardo-note').textContent = text; $('bardo-note').dataset.kind = kind; };
  // Qué impide compartir el archivo, o '' si se puede.
  function shareBlocker() {
    if (!shareClip) return 'Generá un recorte MP4 para compartirlo.';
    if (shareClip.blob.size > SHARE_LIMIT) return `El clip pesa ${mbShort(shareClip.blob.size)}. Para compartirlo, elegí un recorte de hasta 45 MB (unos 3 minutos).`;
    if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [shareFile] })) return 'Este navegador no permite compartir archivos. El MP4 ya se descargó: adjuntalo en WhatsApp y pegá la frase.';
    return '';
  }
  function openBardo() {
    if (!shareClip) return;
    // El archivo se arma al abrir, para que el toque en «Compartir» no espere nada.
    shareFile = new File([shareClip.blob], shareClip.name, { type: 'video/mp4' });
    $('bardo-file').textContent = shareClip.name;
    $('bardo-size').textContent = mbShort(shareClip.blob.size);
    if (!$('bardo-text').value.trim()) $('bardo-text').value = randomPhrase();
    const blocker = shareBlocker();
    $('bardo-share').disabled = !!blocker;
    bardoNote(blocker || (IS_IOS ? 'En iPhone, WhatsApp puede descartar el texto: copiá la frase y pegala en el chat.' : ''), blocker ? 'warn' : '');
    $('bardo-copy').querySelector('span').textContent = 'Copiar frase';
    if (!$('bardo').open) $('bardo').showModal();
  }
  $('bardo-shuffle').addEventListener('click', () => { $('bardo-text').value = randomPhrase(); $('bardo-copy').querySelector('span').textContent = 'Copiar frase'; });
  $('bardo-copy').addEventListener('click', async () => {
    const text = $('bardo-text').value.trim();
    const label = $('bardo-copy').querySelector('span');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Alternativa sin Clipboard API: copiar desde el propio cuadro de texto.
      const t = $('bardo-text'); t.focus(); t.select();
      if (!document.execCommand || !document.execCommand('copy')) { label.textContent = 'No se pudo copiar'; return; }
      t.setSelectionRange(t.value.length, t.value.length);
    }
    label.textContent = 'Frase copiada';
  });
  $('bardo-share').addEventListener('click', () => {
    if (!shareFile || shareBlocker()) return;
    const text = $('bardo-text').value.trim();
    // En iPhone se comparte sólo el video: con texto, WhatsApp a veces descarta el archivo.
    const data = { files: [shareFile] };
    if (text && !IS_IOS) data.text = text;
    // navigator.share se llama directamente en el toque (sin esperas previas).
    navigator.share(data).then(() => {
      bardoNote('Listo. Si la frase no apareció en el chat, usá «Copiar frase» y pegala.', 'ok');
    }).catch(err => {
      if (err && err.name === 'AbortError') return; // el usuario cerró la hoja de compartir
      if (err && err.name === 'NotAllowedError') bardoNote('El navegador bloqueó la acción. Tocá «Compartir video» de nuevo.', 'warn');
      else bardoNote('No se pudo compartir el video: ' + (err && err.message || 'error desconocido'), 'warn');
    });
  });
  $('bardo').addEventListener('click', e => { if (e.target === $('bardo')) $('bardo').close(); }); // tocar fuera cierra

  syncMode();

  // Exponer para pruebas automatizadas.
  window.__beelupStudio = { get segments() { return segments; }, get duration() { return duration; }, get shareClip() { return shareClip; }, get playerPlaylistInfo() { return playerPlaylistInfo; }, locale: UI_LOCALE, phrases: PHRASES };
})();
