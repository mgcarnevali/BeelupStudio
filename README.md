# Beelup Studio v1.3 — Padel Studio Premium

Publicar en GitHub Pages: `index.html`, `style.css`, `app.js`, `studio.js`, `remux.js`, `sw.js`, `icon.svg`, `manifest.webmanifest` y la carpeta **`fonts/` (nueva)**.
No requiere cambios en el Cloudflare Worker. `app.js` y `remux.js` son idénticos a la v1.2.

## Rediseño visual (v1.3)

- Identidad "Padel Studio Premium": negro con verde lima, tipografía condensada de marcador (Barlow Condensed), Inter para textos y JetBrains Mono para tiempos. Fuentes alojadas en el propio sitio (`fonts/`, licencia OFL), sin servicios externos.
- Escritorio: buscador en una barra horizontal, marcador del partido (club, cancha, fecha, horario, duración), reproductor protagonista con controles superpuestos, panel "Tu jugada" con inicio y fin en números grandes, exportación con Formato (MP4/TS) y Alcance (recorte/partido completo), y línea de tiempo a todo el ancho con tiradores grandes de inicio y fin.
- Móvil: buscador en pasos numerados con los horarios como botones; con el partido cargado, el buscador se pliega (botón de búsqueda arriba). Controles centrales sobre el video, línea de tiempo táctil, nombre de archivo en hasta tres líneas y barra de descarga fija abajo.
- Botón de descarga con progreso: texto en dos capas recortadas por el avance, legible del 0 % al 100 % (contraste ≥ 5,4:1 en todos los estados).
- Iconos SVG propios (sprite en `index.html`), sin dependencias nuevas.
- Mismas funciones que la v1.2: los cuatro tipos de descarga se eligen con Formato + Alcance (o el selector compacto en móvil).

## Versiones anteriores

### v1.2 — MP4 nativo en el navegador

Publicar en GitHub Pages: `index.html`, `style.css`, `app.js`, `studio.js`, **`remux.js` (nuevo)**, `sw.js`, `icon.svg`, `manifest.webmanifest`.
No hace falta modificar el Cloudflare Worker (se usan los mismos endpoints `/api/beelup`, `/api/resolve`, `/api/playlist` y `/api/segment`).

## Exportación MP4 (nueva arquitectura)

Se eliminó FFmpeg.wasm. `remux.js` es un remuxer MPEG-TS → MP4 escrito en JavaScript puro:

- **Sin `SharedArrayBuffer`, WebAssembly, COOP/COEP ni CDN externo**: funciona en GitHub Pages tal cual.
- **Sin recodificar**: copia el H.264 y el AAC originales (igual que `ffmpeg -c copy`).
- MP4 **progresivo** (`moov` antes de `mdat`, "faststart") con tablas completas (`stts/ctts/stss/stsc/stsz/stco|co64`): duración correcta y navegación precisa en navegadores, VLC y móviles.
- Une los archivos de 5 minutos de Beelup (`#EXT-X-DISCONTINUITY`, timestamps que se reinician) en una línea de tiempo continua y mantiene la sincronía audio/video (error máximo medido: 32 ms).
- Ignora la pista ID3 y los segmentos vacíos; respeta la frecuencia de cuadro variable.
- Recorte más preciso que el TS: empieza en el cuadro clave anterior al inicio elegido y termina en el cuadro exacto del fin.
- Bajo consumo de memoria: cada segmento se procesa al llegar y sus datos pasan a un `Blob`. Límite: 600 MB en móviles y 2 GB en escritorio.
- Nueva opción: **partido completo en MP4** (en "Otras descargas").

## Reproductor e interfaz

- La barra de posición ya no "pelea" con el video al arrastrar: muestra la hora y busca al soltar. Además tiene relleno de progreso verde lima.
- La vista previa del recorte ya no rompe el ícono del botón al terminar.
- Se eliminaron los listeners duplicados que se acumulaban con cada partido cargado.
- En pantallas táctiles, el primer toque con los controles ocultos sólo los muestra (no pausa).
- Indicador de carga (spinner), recuperación automática de errores de red y de medios de hls.js, y tiempos de reintento más cortos.
- Pantalla completa con soporte para Safari/iPhone (`webkitRequestFullscreen` / `webkitEnterFullscreen`) y el ícono cambia al entrar y salir.
- Atajos de teclado con el reproductor enfocado: espacio/K, ←/→ (5 s), J/L (10 s), F y M.
- La velocidad elegida se mantiene al cambiar de partido; el volumen queda sincronizado con el silencio.
- Validación visible de rangos inválidos (sin `NaN`); marcar inicio o fin reacomoda el otro extremo si hace falta.
- Descargas con 3 segmentos en paralelo, reintentos automáticos y botón **Cancelar**.
- Responsive: menú "Otras descargas" en el flujo de la página en móvil, controles de recorte reacomodados por debajo de 380 px y objetivos táctiles más grandes.
- Safari sin MSE: si la playlist `blob:` falla, se reintenta con la playlist del Worker.

La búsqueda de partidos (`app.js`) y la descarga TS no se modificaron en su comportamiento.
