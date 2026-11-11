# Beelup Studio v0.5 — prueba de reproductor integrado

La búsqueda multipaís sigue usando el Worker existente `https://beelup-studio-api.mgcarnevali.workers.dev/api/beelup`. No se requieren cambios en Cloudflare.

Tras seleccionar un partido, «Probar reproductor integrado» inserta la URL oficial `https://beelup.com/{pais}/pedir-partido?...` en un iframe. El acceso, la autenticación y los permisos siguen siendo gestionados por Beelup. **No está comprobado que Beelup permita mostrarse en un iframe**: encabezados `X-Frame-Options` o CSP `frame-ancestors` pueden bloquearlo, y algunos flujos requieren cookies de terceros. Si falla, usar «Abrir en Beelup».

Esta versión no reproduce directamente HLS, no consulta códigos privados, no descarga videos y no cambia el Worker. Para una reproducción HLS nativa dentro de la PWA haría falta verificar el flujo autorizado de obtención del ID y las restricciones CORS de playlists y segmentos.

## Publicación
Subir los archivos a la raíz de `BeelupStudio` en GitHub, reemplazando los anteriores. Commit sugerido: `Add official player embed test with fallback`. Si persiste la versión vieja, probar en incógnito o borrar datos del sitio para actualizar el service worker.
