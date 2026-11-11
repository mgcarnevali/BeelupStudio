# Beelup Studio v0.9 — Reproductor personalizado

## Novedades
- Controles propios: reproducir/pausar, saltos de 10 s, volumen, silencio, velocidad y pantalla completa.
- Línea de tiempo de reproducción y un único selector visual de recorte con dos extremos IN/OUT.
- Marcar IN/OUT desde el video y previsualizar el fragmento.
- Descarga MPEG-TS conservada y exportación experimental MP4 (remultiplexado en navegador con mux.js, sin recodificar). El MP4 depende de que los segmentos originales sean compatibles; si falla, utilizar TS.
- MP4 limitado a 150 MiB de entrada para evitar uso excesivo de memoria. Partido completo sigue disponible como TS, con advertencia de memoria.
- Búsqueda multipaís y Cloudflare Worker sin cambios.

## Publicación
Subir únicamente `index.html`, `style.css`, `studio.js`, `sw.js`, `app.js`, `icon.svg`, `manifest.webmanifest` a la raíz de GitHub Pages. **No es necesario modificar Cloudflare** ni publicar `worker.js`.

## Límites
No se verificó en vivo el MP4 en todos los navegadores ni se garantiza precisión de fotograma; el recorte sigue ajustado a los segmentos HLS. La exportación se realiza únicamente para grabaciones con acceso y autorización.
