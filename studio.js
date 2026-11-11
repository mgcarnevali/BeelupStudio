 'use strict';
(() => {
const $ = id => document.getElementById(id);
const BASE = 'https://beelup-studio-api.mgcarnevali.workers.dev';
let selection=null, segments=[], duration=0, hls=null, busy=false, playlistBlob=null, loadVersion=0, previewing=false;
const shapes={play:'<path d="m8 5 12 7-12 7z"/>',pause:'<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',back:'<path d="M11 5 4 12l7 7V5Zm9 0-7 7 7 7V5Z"/>',forward:'<path d="m13 5 7 7-7 7V5ZM4 5l7 7-7 7V5Z"/>',volume:'<path d="M11 5 6 9H3v6h3l5 4V5ZM15 9a5 5 0 0 1 0 6M18 6a9 9 0 0 1 0 12"/>',mute:'<path d="M11 5 6 9H3v6h3l5 4V5ZM16 9l5 6m0-6-5 6"/>',full:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',in:'<path d="M5 5v14M19 6l-7 6 7 6"/>',out:'<path d="M19 5v14M5 6l7 6-7 6"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
$('skip-back').innerHTML=icon('back');$('skip-forward').innerHTML=icon('forward');$('fullscreen').innerHTML=icon('full');$('mark-in').innerHTML=icon('in');$('mark-out').innerHTML=icon('out');$('preview-clip').innerHTML=icon('play');$('mute').innerHTML=icon('volume');$('play-toggle').innerHTML=icon('play');
const message = s => $('studio-message').textContent=s;
const progress = s => $('export-status').textContent=s;
const fmt = seconds => {seconds=Math.floor(seconds);return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(x=>String(x).padStart(2,'0')).join(':')};
const seconds = s => {const parts=s.trim().split(':').map(Number);if(parts.some(x=>!Number.isInteger(x)||x<0)||parts.length<2||parts.length>3||parts.slice(1).some(x=>x>59))return NaN;return parts.reduce((a,b)=>a*60+b,0)};
function clear(){previewing=false;$('player-controls').classList.add('hidden');if(hls){hls.destroy();hls=null}if(playlistBlob){URL.revokeObjectURL(playlistBlob);playlistBlob=null}$('native-video').removeAttribute('src');$('native-video').load();segments=[];duration=0;$('studio-editor').classList.add('hidden');}
window.addEventListener('beelup:selection',e=>{selection=e.detail;loadVersion++;clear();$('video-placeholder').classList.remove('hidden');$('player-error').classList.add('hidden');message('Cargando video…');loadVideo();});
async function api(path,params){const r=await fetch(BASE+path+'?'+new URLSearchParams(params),{cache:'no-store',signal:AbortSignal.timeout(25000)});if(!r.ok){let m=`HTTP ${r.status}`;try{m=(await r.json()).error||m}catch{}throw Error(m)}return r;}
function parsePlaylist(txt){const rows=txt.split(/\r?\n/);let time=0,pending=null,items=[];for(const row of rows){if(row.startsWith('#EXT-X-KEY')||row.startsWith('#EXT-X-MAP'))throw Error('Formato HLS no compatible con este exportador.');if(row.startsWith('#EXTINF:'))pending=Number(row.slice(8).split(',')[0]);else if(row&&!row.startsWith('#')){if(!Number.isFinite(pending)||pending<=0)throw Error('Playlist HLS no compatible.');items.push({url:row.trim(),start:time,end:time+pending});time+=pending;pending=null;}}if(!items.length)throw Error('No hay segmentos de video.');return {items,time};}
function update(){const a=seconds($('clip-start').value),b=seconds($('clip-end').value),valid=Number.isFinite(a)&&Number.isFinite(b)&&a>=0&&b<=duration&&a<b;const track=$('trim-highlight');$('clip-summary').textContent=valid?`${fmt(a)} → ${fmt(b)}`:'Ingresá un rango válido';$('clip-length').textContent=valid?fmt(b-a):'—';if(valid){$('trim-in').value=a;$('trim-out').value=b;track.style.left=`${a/duration*100}%`;track.style.width=`${(b-a)/duration*100}%`;} }
function syncPlayer(){const v=$('native-video');$('play-toggle').innerHTML=icon(v.paused?'play':'pause');$('play-clock').textContent=`${fmt(v.currentTime||0)} / ${fmt(duration||v.duration||0)}`;if(!v.seeking)$('seek').value=v.currentTime||0;$('mute').innerHTML=icon(v.muted||v.volume===0?'mute':'volume');}

function suggestedName(){const clean=v=>String(v||'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'-').replace(/\s+/g,' ').trim();const courtLabel=$('court')?.selectedOptions?.[0]?.textContent?.trim();const courtName=courtLabel&&!/^elegí|^seleccion/i.test(courtLabel)?courtLabel:selection?.court;return [selection?.club,courtName,selection?.date,selection?.time?.replace(':','-')].map(clean).filter(Boolean).join(' - ')||'Mi partido'}
function downloadName(full,a,b,ext){let base=($('export-name').value||suggestedName()).replace(/\.(mp4|ts)$/i,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'-').trim().replace(/[. ]+$/,'');if(!base)base='Mi partido';return (base+(full?' - completo':` - ${fmt(a).replaceAll(':','-')} a ${fmt(b).replaceAll(':','-')}`)).slice(0,195)+'.'+ext}
function makePlayer(txt){const proxied=txt.split(/\r?\n/).map(line=>line&&!line.startsWith('#')?BASE+'/api/segment?'+new URLSearchParams({url:line}):line).join('\n');playlistBlob=URL.createObjectURL(new Blob([proxied],{type:'application/vnd.apple.mpegurl'}));const video=$('native-video');
if(window.Hls&&Hls.isSupported()){hls=new Hls({enableWorker:true});hls.loadSource(playlistBlob);hls.attachMedia(video);hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)message('Error del reproductor: '+data.details)})}else if(video.canPlayType('application/vnd.apple.mpegurl'))video.src=playlistBlob;else message('Este navegador no admite HLS; la exportación puede seguir disponible.');}
async function loadVideo(){if(!selection)return;const version=loadVersion;clear();message('Buscando grabación y playlist HLS…');try{const resolved=await (await api('/api/resolve',{code:selection.code,complejo:selection.club,cancha:selection.court,fecha:selection.date,hora:selection.time})).json();if(version!==loadVersion)return;const r=await api('/api/playlist',{id:resolved.id,camara:'central'});const txt=await r.text();if(version!==loadVersion)return;if(!txt.startsWith('#EXTM3U'))throw Error('No se recibió una playlist HLS.');const parsed=parsePlaylist(txt);segments=parsed.items;duration=parsed.time;makePlayer(txt);$('video-duration').textContent='Duración: '+fmt(duration);$('player-controls').classList.remove('hidden');$('seek').max=duration;$('clip-start').value='00:00:00';$('clip-end').value=fmt(Math.min(300,duration));$('studio-editor').classList.remove('hidden');$('trim-in').max=Math.floor(duration);$('trim-out').max=Math.floor(duration);$('trim-in').value=0;$('trim-out').value=Math.floor(Math.min(300,duration));$('export-name').value=suggestedName();$('video-placeholder').classList.add('hidden');showControls();$('player-error').classList.add('hidden');message('Video listo. Elegí el fragmento o descargá el partido completo.');update();syncPlayer();}catch(e){if(version!==loadVersion)return;message('No se pudo cargar el video: '+e.message);$('player-error').classList.remove('hidden');console.warn(e)}}
$('retry-video').addEventListener('click',()=>{loadVersion++;loadVideo()});
for(const id of ['clip-start','clip-end'])$(id).addEventListener('input',update);
for(const [slider,field,other] of [['trim-in','clip-start','clip-end'],['trim-out','clip-end','clip-start']])$(slider).addEventListener('input',()=>{let v=Number($(slider).value),o=seconds($(other).value);if(slider==='trim-in')v=Math.min(v,o-1);else v=Math.max(v,o+1);$(field).value=fmt(Math.max(0,v));update()});
function mark(which){const now=Math.floor($('native-video').currentTime);if(which==='start'){$('clip-start').value=fmt(Math.min(now,Math.max(0,seconds($('clip-end').value)-1)));}else{$('clip-end').value=fmt(Math.max(now,seconds($('clip-start').value)+1));}update()}
$('mark-in').addEventListener('click',()=>mark('start'));
$('mark-out').addEventListener('click',()=>mark('end'));
$('preview-clip').addEventListener('click',()=>{if(previewing){previewing=false;$('native-video').pause();$('preview-clip').innerHTML=icon('play');$('preview-clip').setAttribute('aria-label','Reproducir recorte');return;}const a=seconds($('clip-start').value),b=seconds($('clip-end').value);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b||b>duration){progress('Seleccioná un recorte válido.');return;}previewing=true;const v=$('native-video');v.currentTime=a;v.play().catch(()=>{});$('preview-clip').innerHTML=icon('stop');$('preview-clip').setAttribute('aria-label','Detener vista previa');});

const video=$('native-video');
const stage=$('video-stage');let hideControlsTimer;function showControls(){stage.classList.remove('controls-idle');clearTimeout(hideControlsTimer);if(!video.paused)hideControlsTimer=setTimeout(()=>stage.classList.add('controls-idle'),3200)}stage.addEventListener('pointermove',showControls);stage.addEventListener('pointerdown',showControls);video.addEventListener('pause',showControls);video.addEventListener('play',showControls);

$('play-toggle').addEventListener('click',()=>video.paused?video.play().catch(()=>{}):video.pause());
video.addEventListener('click',()=>video.paused?video.play().catch(()=>{}):video.pause());
$('skip-back').addEventListener('click',()=>video.currentTime=Math.max(0,video.currentTime-10));
$('skip-forward').addEventListener('click',()=>video.currentTime=Math.min(duration,video.currentTime+10));
$('seek').addEventListener('input',()=>{video.currentTime=+$('seek').value;syncPlayer()});
$('volume').addEventListener('input',()=>{video.volume=+$('volume').value;video.muted=false;syncPlayer()});
$('mute').addEventListener('click',()=>{video.muted=!video.muted;syncPlayer()});
$('speed').addEventListener('change',()=>video.playbackRate=+$('speed').value);
$('fullscreen').addEventListener('click',()=>{const stage=document.querySelector('.video-stage');if(document.fullscreenElement)document.exitFullscreen();else if(stage.requestFullscreen)stage.requestFullscreen();else if(video.webkitEnterFullscreen)video.webkitEnterFullscreen()});
for(const event of ['play','pause','loadedmetadata','seeking','seeked'])video.addEventListener(event,syncPlayer);
video.addEventListener('timeupdate',()=>{syncPlayer();if(previewing&&video.currentTime>=seconds($('clip-end').value)){previewing=false;video.pause();$('preview-clip').innerHTML=icon('play');$('preview-clip').setAttribute('aria-label','Reproducir recorte')}});

async function exportVideo(full,mp4=false){if(busy||!segments.length)return;const a=full?0:seconds($('clip-start').value),b=full?duration:seconds($('clip-end').value);if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b>duration+0.1||a>=b){progress('Inicio y fin inválidos.');return;}const chosen=segments.filter(s=>s.end>a&&s.start<b);if(!chosen.length)return;const approx=(chosen.at(-1).end-chosen[0].start);if(!full&&approx>600&&!confirm('El fragmento supera 10 minutos y puede consumir mucha memoria. ¿Continuar?'))return;if(full&&!confirm('Un partido completo puede superar la memoria del navegador y consumir muchos datos. ¿Continuar?'))return;
 busy=true;$('download-clip').disabled=$('download-full').disabled=$('download-mp4').disabled=true;$('export-progress').classList.remove('hidden');$('export-progress').value=0;
 try{const pieces=[];let bytes=0;for(let i=0;i<chosen.length;i++){const r=await api('/api/segment',{url:chosen[i].url});const piece=await r.blob();bytes+=piece.size;if(mp4&&bytes>(/Android|iPhone|iPad/i.test(navigator.userAgent)?90:220)*1048576)throw Error('El recorte es demasiado grande para convertirlo en este dispositivo. Usá TS o un recorte más corto.');pieces.push(piece);$('export-progress').value=Math.round((i+1)/chosen.length*100);progress(`Descargando segmentos ${i+1}/${chosen.length}…`)}let blob;if(mp4){progress('Empaquetando MP4 sin recodificar…');blob=await transmuxMp4(pieces)}else blob=new Blob(pieces,{type:'video/mp2t'});const link=document.createElement('a');const url=URL.createObjectURL(blob);link.href=url;link.download=downloadName(full,a,b,mp4?'mp4':'ts');document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);progress(`Archivo ${mp4?'MP4':'TS'} generado (${(blob.size/1048576).toFixed(1)} MB). El recorte se ajusta a segmentos HLS.`)}catch(e){console.error('[Beelup MP4] Export failed:',e);progress('Error en descarga: '+(e?.message||String(e)||'Fallo desconocido del motor MP4'))}finally{busy=false;$('download-clip').disabled=$('download-full').disabled=$('download-mp4').disabled=false}}
// FFmpeg 0.12 single-thread: no SharedArrayBuffer / cross-origin isolation required.
// Load UMD bundles via blob URLs to keep the Worker and WASM same-origin to their loader.
let ffmpegPromise;
const ffmpegObjectUrls=[];
async function ffmpegBlobURL(url, mime){
  const response=await fetch(url,{mode:'cors'});
  if(!response.ok)throw Error(`No se pudo descargar FFmpeg (${response.status}).`);
  const blob=new Blob([await response.arrayBuffer()],{type:mime});
  const objectURL=URL.createObjectURL(blob);
  ffmpegObjectUrls.push(objectURL);
  return objectURL;
}
function loadScript(url){return new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src=url;
  script.onload=resolve;script.onerror=()=>reject(Error('No se pudo cargar FFmpeg.'));
  document.head.append(script);
})}
async function getFFmpeg(){
  if(!ffmpegPromise)ffmpegPromise=(async()=>{
    // Pin both packages to the documented single-thread configuration.
    // @ffmpeg/core-mt must NOT be used on GitHub Pages without COOP/COEP.
    const ffmpegBase='https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd';
    const coreBase='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
    if(!window.FFmpegWASM?.FFmpeg)await loadScript(ffmpegBase+'/ffmpeg.js');
    if(!window.FFmpegWASM?.FFmpeg)throw Error('No se pudo inicializar FFmpeg 0.12.');
    const ff=new window.FFmpegWASM.FFmpeg();
    // ffmpeg.js UMD 0.12.10 uses the 814 worker chunk.
    // Only the class worker must be same-origin; FFmpeg core is explicitly ST.
    const classWorkerURL=URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(ffmpegBase+'/814.ffmpeg.js')});`],{type:'text/javascript'}));
    ffmpegObjectUrls.push(classWorkerURL);
    const coreURL=await ffmpegBlobURL(coreBase+'/ffmpeg-core.js','text/javascript');
    const wasmURL=await ffmpegBlobURL(coreBase+'/ffmpeg-core.wasm','application/wasm');
    try{
      await Promise.race([ff.load({classWorkerURL,coreURL,wasmURL}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Tiempo agotado iniciando FFmpeg. Revisá el acceso a cdn.jsdelivr.net.')),45000))]);
    }catch(e){
      if(/SharedArrayBuffer/.test(String(e)))throw Error('El motor FFmpeg cargó una compilación incompatible con este navegador (SharedArrayBuffer).');
      throw Error('No se pudo iniciar el motor MP4: '+(e?.message||String(e)||'error interno del Worker'));
    }
    return ff;
  })().catch(e=>{ffmpegPromise=null;throw e});
  return ffmpegPromise;
}
async function transmuxMp4(pieces){
  progress('Cargando motor MP4 (primera vez puede tardar)…');
  const ff=await getFFmpeg();
  const total=pieces.reduce((n,p)=>n+p.size,0);
  const data=new Uint8Array(total);
  let offset=0;
  for(const piece of pieces){const arr=new Uint8Array(await piece.arrayBuffer());data.set(arr,offset);offset+=arr.length}
  progress('Generando MP4 sin recodificar…');
  await ff.writeFile('input.ts',data);
  try{
    const exit=await ff.exec(['-fflags','+genpts','-i','input.ts','-map','0:v:0','-map','0:a?','-c','copy','-movflags','+faststart','output.mp4']);
    if(exit!==0)throw Error(`FFmpeg terminó con código ${exit}.`);
    const result=await ff.readFile('output.mp4');
    if(result.length<1024)throw Error('MP4 vacío.');
    // A successful remux must have MP4 file type and movie metadata boxes.
    const ascii=(from,n)=>String.fromCharCode(...result.subarray(from,from+n));
    if(ascii(4,4)!=='ftyp'){throw Error('Archivo MP4 inválido (sin ftyp).')}
    let hasMoov=false;for(let i=0;i<Math.min(result.length,1048576)-3;i++){if(result[i]===109&&result[i+1]===111&&result[i+2]===111&&result[i+3]===118){hasMoov=true;break}}
    if(!hasMoov)throw Error('Archivo MP4 inválido (sin moov).');
    return new Blob([result.slice()],{type:'video/mp4'});
  }finally{
    try{await ff.deleteFile('input.ts')}catch{}
    try{await ff.deleteFile('output.mp4')}catch{}
  }
}
$('download-mp4').addEventListener('click',()=>exportVideo(false,true));
$('download-clip').addEventListener('click',()=>exportVideo(false));$('download-full').addEventListener('click',()=>exportVideo(true));
})();
