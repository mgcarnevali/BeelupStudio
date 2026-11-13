'use strict';
const $ = id => document.getElementById(id);
const API = 'https://beelup-studio-api.mgcarnevali.workers.dev/api/beelup';
let clubs = [], requestId = 0;
const currentCountry = () => $('country').value;
const countryCode = () => $('country').selectedOptions[0].dataset.code;
function status(message) { $('status').textContent = message; }
function options(id, items, placeholder) {
  const select = $(id); select.replaceChildren(new Option(placeholder, ''));
  for (const item of items) select.add(new Option(item.Nombre + (item.Tipo && item.Tipo !== 'OK' ? ' · ' + item.Tipo : ''), item.Valor));
  select.disabled = items.length === 0;
}

// ── Tolerancia a fallas de la búsqueda (v1.4.1) ──
// Cada paso (clubes, canchas, fechas, horarios) es una única tarea: al empezar otra, o al cambiar
// la selección, la anterior se cancela junto con sus reintentos pendientes.
const TIMEOUT_MS = 25000;          // por intento (el Worker espera hasta 18 s a Beelup)
const RETRY_DELAYS = [1500, 4000]; // hasta 2 reintentos: sólo red, tiempo agotado y HTTP 5xx
const STEP_NAMES = ['los clubes', 'las canchas', 'las fechas', 'los horarios'];
const STEP_FIELDS = ['club', 'court', 'date', 'time'];
let task = null;       // { level, controller }
let retryStep = null;  // función que repite el paso que falló

class SearchError extends Error {
  constructor(kind, httpStatus = 0) { super(kind + (httpStatus ? ' ' + httpStatus : '')); this.name = 'SearchError'; this.kind = kind; this.httpStatus = httpStatus; }
  get retryable() { return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server'; }
}
const isCancel = (error, signal) => signal.aborted && !(error instanceof SearchError);

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    function stop() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', stop, { once: true });
  });
}

// Un intento: su propio límite de tiempo, enlazado a la cancelación de la tarea.
async function attempt(url, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  const fail = error => {
    if (signal.aborted) return error;                       // cancelada por el usuario
    if (timedOut) return new SearchError('timeout');
    return error instanceof SearchError ? error : new SearchError('network');
  };
  try {
    let response;
    try { response = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal }); }
    catch (error) { throw fail(error); }
    if (!response.ok) throw new SearchError(response.status >= 500 ? 'server' : 'client', response.status);
    let data;
    try { data = await response.json(); }
    catch (error) { throw (signal.aborted || timedOut) ? fail(error) : new SearchError('format'); }
    if (!Array.isArray(data)) throw new SearchError('format');
    return data;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}

async function load(action, signal, club = '', court = '', date = '') {
  const params = new URLSearchParams({ accion: action, pais: currentCountry(), complejo: club, cancha: court, fecha: date, hora: '', invisibles: '' });
  const url = `${API}?${params}`;
  for (let n = 0; ; n++) {
    try {
      const data = await attempt(url, signal);
      return data.map(item => ({
        Nombre: item.nombre ?? item.Nombre ?? '',
        Valor: item.valor ?? item.Valor ?? '',
        Tipo: item.tipo ?? item.Tipo ?? null,
        Atc: item.atc ?? false
      }));
    } catch (error) {
      if (isCancel(error, signal) || !error.retryable || n >= RETRY_DELAYS.length) throw error;
      console.warn(`Búsqueda (${action}): intento ${n + 1} falló (${error.message}); se reintenta.`);
      $('connection').textContent = 'Reintentando…';
      await wait(RETRY_DELAYS[n], signal);
    }
  }
}

function describe(error) {
  if (!(error instanceof SearchError)) return { conn: 'No disponible', text: 'ocurrió un error inesperado. Probá de nuevo.' };
  if (error.kind === 'network' && navigator.onLine === false) return { conn: 'Sin conexión', text: 'no hay conexión a internet. Se reintentará al volver la conexión.' };
  switch (error.kind) {
    case 'network': return { conn: 'Sin acceso', text: 'no se pudo conectar con el servicio de búsqueda. Revisá tu conexión; en redes de empresa o con bloqueadores el acceso puede estar restringido.' };
    case 'timeout': return { conn: 'Sin respuesta', text: 'el servicio de búsqueda tardó demasiado en responder. Probá de nuevo en unos minutos.' };
    case 'server':  return { conn: 'No disponible', text: 'Beelup no está respondiendo en este momento. Probá de nuevo en unos minutos.' };
    case 'format':  return { conn: 'No disponible', text: 'Beelup respondió con datos inesperados. Probá de nuevo más tarde.' };
    default:
      if (error.httpStatus === 429) return { conn: 'En pausa', text: 'se hicieron demasiadas consultas seguidas. Esperá un momento y probá de nuevo.' };
      return { conn: 'Acceso rechazado', text: 'el servicio de búsqueda rechazó la consulta. Si el problema sigue, recargá la página.' };
  }
}

function setRetry(fn) {
  retryStep = fn;
  $('retry').classList.toggle('hidden', !fn);
  $('status-wrap').classList.toggle('err', !!fn);
}

function cancelTask(fromLevel = 0) {
  if (task && task.level >= fromLevel) { task.controller.abort(); task = null; }
  setRetry(null);
}

// Ejecuta un paso de la búsqueda; sólo el más reciente puede tocar la pantalla.
async function runStep(level, action, args, done) {
  cancelTask(0);
  const id = ++requestId, controller = new AbortController();
  task = { level, controller };
  const again = () => { options(STEP_FIELDS[level], [], 'Cargando…'); runStep(level, action, args, done); };
  try {
    const data = await load(action, controller.signal, ...args);
    if (id !== requestId) return;
    task = null;
    $('connection').textContent = 'API accesible';
    document.body.classList.remove('api-down');
    done(data);
  } catch (error) {
    if (id !== requestId || controller.signal.aborted) return;
    task = null;
    const info = describe(error);
    $('connection').textContent = info.conn;
    document.body.classList.add('api-down');
    options(STEP_FIELDS[level], [], 'No se pudo cargar');
    status(`No se pudieron cargar ${STEP_NAMES[level]}: ${info.text}`);
    setRetry(again);
    console.warn('Conexión Beelup Worker:', error);
  }
}

function resetAfter(level) {
  cancelTask(level + 1);
  const fields = ['club','court','date','time'];
  const hints = ['Seleccionar club','Elegí un club primero','Elegí una cancha primero','Elegí una fecha primero'];
  for (let i = level + 1; i < fields.length; i++) options(fields[i], [], hints[i]);
  $('find').disabled = true; $('result').classList.add('hidden');
}
function showClubs() {
  options('club', clubs, `${clubs.length} clubes · Seleccionar`);
  resetAfter(0);
}
function loadCountry() {
  clubs = [];
  options('club', [], 'Cargando clubes…');
  resetAfter(-1);
  $('connection').textContent = 'Comprobando…';
  const country = $('country').selectedOptions[0].text;
  status(`Cargando clubes de ${country}…`);
  return runStep(0, 'complejos', [], data => {
    clubs = data;
    showClubs();
    status(`${clubs.length} clubes disponibles en ${country}.`);
  });
}
$('country').addEventListener('change', loadCountry);
$('club').addEventListener('change', () => {
  resetAfter(0); if (!$('club').value) return;
  const club = $('club').value;
  status('Cargando canchas…');
  runStep(1, 'canchas', [club], data => { options('court', data, 'Seleccionar cancha'); status('Seleccioná una cancha.'); });
});
$('court').addEventListener('change', () => {
  resetAfter(1); if (!$('court').value) return;
  const club = $('club').value, court = $('court').value;
  status('Cargando fechas…');
  runStep(2, 'fechas', [club, court], data => { options('date', data, 'Seleccionar fecha'); status('Seleccioná una fecha.'); });
});
$('date').addEventListener('change', () => {
  resetAfter(2); if (!$('date').value) return;
  const club = $('club').value, court = $('court').value, date = $('date').value;
  status('Cargando horarios…');
  runStep(3, 'horas', [club, court, date], data => { options('time', data.filter(x => !x.Tipo || x.Tipo.toUpperCase() === 'OK'), 'Seleccionar horario'); status('Seleccioná un horario disponible.'); });
});
$('retry').addEventListener('click', () => {
  const fn = retryStep; if (!fn) return;
  setRetry(null);
  $('connection').textContent = 'Comprobando…';
  status('Reintentando…');
  fn();
});
// Al volver la conexión, se repite automáticamente el paso que había fallado.
window.addEventListener('online', () => { if (retryStep) $('retry').click(); });
$('time').addEventListener('change', () => { $('find').disabled = !$('time').value; });
$('find').addEventListener('click', () => {
  const club = $('club').value, court = $('court').value, date = $('date').value, time = $('time').value;
  if (!club || !court || !date || !time) return;
  const params = new URLSearchParams({ complejo: club, cancha: court, fecha: date, hora: time });
  const url = `https://beelup.com/${countryCode()}/pedir-partido?${params}`;
  $('matchname').textContent = `${$('club').selectedOptions[0].text} · ${$('court').selectedOptions[0].text} · ${date} ${time}`;
  $('watch').href = url;
  $('result').classList.remove('hidden');
  window.dispatchEvent(new CustomEvent('beelup:selection', {detail:{club,court,date,time,code:countryCode()}}));
  $('result').scrollIntoView({ behavior: 'smooth' });
  status('Partido seleccionado. Cargando el reproductor de Beelup Studio…');
});
loadCountry();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
