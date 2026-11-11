# Beelup Studio v0.7 — Editor experimental

## Instalación

1. **Cloudflare:** reemplazar el código del Worker `beelup-studio-api` por el contenido de `worker.js` y desplegar.
2. **GitHub Pages:** subir `index.html`, `app.js`, `studio.js`, `style.css`, `sw.js`, `icon.svg` y `manifest.webmanifest` a la raíz. **No subir `worker.js` a GitHub Pages**: es código del Worker.
3. Abrir en incógnito, elegir partido, pulsar **Preparar video**.

## Alcance real

- Mantiene la búsqueda multipaís y el reproductor oficial.
- Añade reproductor HLS propio usando hls.js y un proxy restringido de segmentos en el Worker.
- Exporta partido completo o fragmento en **MPEG-TS (.ts)**, no MP4. Los recortes se aproximan a límites de segmentos de unos 2 segundos.
- No probado contra el servidor real en esta entrega: el flujo de resolución, la sesión, los permisos de origen o el CDN pueden impedir la reproducción o descarga.
- El Worker solo permite la API conocida y segmentos bajo `*.do.revivitupartido.com/hls/videoscloud/`. No es un proxy abierto.
- El procesamiento se hace en memoria del navegador: los partidos grandes pueden agotar RAM. No hay conversión MP4 ni procesamiento de video en Cloudflare.
- Usar únicamente grabaciones que se tenga autorización para reproducir y descargar. No intenta eludir pagos o restricciones.
