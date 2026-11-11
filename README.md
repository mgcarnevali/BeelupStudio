# Beelup Studio v1.1 — Player redesign

Reemplazar en GitHub Pages únicamente: `index.html`, `style.css`, `studio.js`, `sw.js`. No modificar Cloudflare Worker ni app.js.

- Controles SVG superpuestos sobre el video, autoocultables durante reproducción; móvil y escritorio.
- Editor compacto con rango IN/OUT, campos editables y botones de marcar y previsualizar.
- Nombre de descarga editable y menú para opciones TS.
- Se mantiene la descarga TS y el mecanismo MP4 FFmpeg de v1.0 **sin cambios**. El MP4 sigue pendiente de verificación real en VLC y móviles; no se afirma que esté corregido.
- Probar en Chrome Android, Safari iOS, escritorio y VLC antes de publicar como estable.
