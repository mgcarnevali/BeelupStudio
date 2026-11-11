# Beelup Studio v0.8 — Reproductor único

- Reemplaza completamente el iframe del reproductor oficial por un reproductor HTML5/HLS propio.
- Al seleccionar partido se carga automáticamente; sin botón Preparar video.
- Un solo enlace externo: **Ver en Beelup**.
- Editor de inicio/fin y descarga de fragmento o partido completo en MPEG-TS.
- Los videos deben ser accesibles y estar autorizados para descarga.

## Publicación
1. Cloudflare Worker: pegar `worker.js` en el editor y desplegar.
2. GitHub Pages: subir `index.html`, `app.js`, `studio.js`, `style.css`, `sw.js`, `icon.svg`, `manifest.webmanifest`. **No subir worker.js** a GitHub Pages.
3. Probar en incógnito.

**Limitación conocida:** el flujo de resolución HLS y la exportación no pudieron probarse en vivo. Si falla, el mensaje del Worker ahora distingue parámetros faltantes. Los videos completos pueden consumir demasiada memoria del navegador. No se promete MP4 ni recorte a fotograma exacto.
