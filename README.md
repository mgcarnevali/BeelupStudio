# Beelup Studio v1.0 — Reproductor responsive y exportación MP4

Reemplazar en GitHub Pages: `index.html`, `style.css`, `studio.js`, `sw.js`.

- Controles propios adaptados a móviles; reproducción y búsqueda con una sola barra.
- Inicio/fin editables y botones para marcar desde la posición actual.
- Nombre de archivo editable, sugerido a partir del partido.
- TS: mismo procedimiento de descarga comprobado en v0.8.
- MP4: FFmpeg WebAssembly convierte TS a MP4 con `-c copy -movflags +faststart`; necesita descargar el motor al primer uso, consume memoria, limita tamaño (90 MiB móvil / 220 MiB escritorio). No se garantiza compatibilidad de todos los navegadores/códecs. La selección sigue alineada a segmentos HLS.
- Cloudflare Worker: **sin cambios**.

Probar MP4 en Chrome y VLC y probar descarga en Android/iOS antes de considerarlo validado. La conversión de partidos completos no está habilitada en MP4.
