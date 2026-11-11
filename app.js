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
function resetAfter(level) {
  const fields = ['club','court','date','time'];
  const hints = ['Seleccionar club','Elegí un club primero','Elegí una cancha primero','Elegí una fecha primero'];
  for (let i = level + 1; i < fields.length; i++) options(fields[i], [], hints[i]);
  $('find').disabled = true; $('result').classList.add('hidden');
}
async function load(action, club = '', court = '', date = '') {
  const params = new URLSearchParams({ accion: action, pais: currentCountry(), complejo: club, cancha: court, fecha: date, hora: '', invisibles: '' });
  const response = await fetch(`${API}?${params}`, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`API intermedia respondió HTTP ${response.status}.`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Beelup devolvió un formato inesperado.');
  return data.map(item => ({
    Nombre: item.nombre ?? item.Nombre ?? '',
    Valor: item.valor ?? item.Valor ?? '',
    Tipo: item.tipo ?? item.Tipo ?? null,
    Atc: item.atc ?? false
  }));
}
function failure(error) {
  $('connection').textContent = 'No disponible';
  status('No se pudo conectar con la API intermedia de Cloudflare. Revisá el estado del Worker y la consola del navegador.');
  console.warn('Conexión Beelup Worker:', error);
}
function filterClubs() {
  const selected = $('club').value;
  const query = $('search').value.trim().toLocaleLowerCase();
  const filtered = clubs.filter(x => x.Nombre.toLocaleLowerCase().includes(query));
  options('club', filtered, `${filtered.length} clubes · Seleccionar`);
  if (filtered.some(x => x.Valor === selected)) $('club').value = selected;
  resetAfter(0);
}
$('search').addEventListener('input', filterClubs);
async function loadCountry() {
  const id = ++requestId;
  clubs = [];
  $('search').value = '';
  options('club', [], 'Cargando clubes…');
  resetAfter(-1);
  $('connection').textContent = 'Comprobando…';
  status(`Cargando clubes de ${$('country').selectedOptions[0].text}…`);
  try {
    const data = await load('complejos');
    if (id !== requestId) return;
    clubs = data;
    $('connection').textContent = 'API accesible';
    filterClubs();
    status(`${clubs.length} clubes disponibles en ${$('country').selectedOptions[0].text}.`);
  } catch (error) { if (id === requestId) failure(error); }
}
$('country').addEventListener('change', loadCountry);
$('club').addEventListener('change', async () => {
  resetAfter(0); if (!$('club').value) return;
  const id = ++requestId, club = $('club').value;
  try { status('Cargando canchas…'); const data = await load('canchas', club); if (id !== requestId) return; options('court', data, 'Seleccionar cancha'); status('Seleccioná una cancha.'); }
  catch (error) { if (id === requestId) failure(error); }
});
$('court').addEventListener('change', async () => {
  resetAfter(1); if (!$('court').value) return;
  const id = ++requestId, club = $('club').value, court = $('court').value;
  try { status('Cargando fechas…'); const data = await load('fechas', club, court); if (id !== requestId) return; options('date', data, 'Seleccionar fecha'); status('Seleccioná una fecha.'); }
  catch (error) { if (id === requestId) failure(error); }
});
$('date').addEventListener('change', async () => {
  resetAfter(2); if (!$('date').value) return;
  const id = ++requestId, club = $('club').value, court = $('court').value, date = $('date').value;
  try { status('Cargando horarios…'); const data = await load('horas', club, court, date); if (id !== requestId) return; options('time', data.filter(x => !x.Tipo || x.Tipo.toUpperCase() === 'OK'), 'Seleccionar horario'); status('Seleccioná un horario disponible.'); }
  catch (error) { if (id === requestId) failure(error); }
});
$('time').addEventListener('change', () => { $('find').disabled = !$('time').value; });
$('find').addEventListener('click', () => {
  const club = $('club').value, court = $('court').value, date = $('date').value, time = $('time').value;
  if (!club || !court || !date || !time) return;
  const params = new URLSearchParams({ complejo: club, cancha: court, fecha: date, hora: time });
  const url = `https://beelup.com/${countryCode()}/pedir-partido?${params}`;
  $('matchname').textContent = `${$('club').selectedOptions[0].text} · ${$('court').selectedOptions[0].text} · ${date} ${time}`;
  $('watch').href = url;
  closePlayer();
  $('result').classList.remove('hidden');
  $('result').scrollIntoView({ behavior: 'smooth' });
  status('Selección lista. Abrí el partido en el sitio oficial.');
});
function closePlayer() {
  $('beelup-frame').removeAttribute('src');
  $('player-wrap').classList.add('hidden');
}
$('embed').addEventListener('click', () => {
  const officialUrl = $('watch').href;
  if (!officialUrl || !officialUrl.startsWith('https://beelup.com/')) return;
  $('beelup-frame').src = officialUrl;
  $('player-wrap').classList.remove('hidden');
  $('player-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('close-player').addEventListener('click', closePlayer);
loadCountry();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
