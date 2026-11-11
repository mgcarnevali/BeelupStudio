# Beelup Studio — GitHub Pages v0.3

Aplicación estática (HTML/CSS/JavaScript), sin backend, compatible con GitHub Pages tanto en dominio propio como en rutas `/usuario/repositorio/`.

## Publicación

Subir **el contenido de esta carpeta** a la raíz de un repositorio GitHub. En Settings → Pages, seleccionar Deploy from a branch, rama `main`, carpeta `/(root)`.

## Alcance y limitaciones

- Consulta `https://beelup-studio-api.mgcarnevali.workers.dev/api/beelup` a través del Worker para listar clubes, canchas, fechas y horarios.
- **No se ha verificado que Beelup permita CORS**. Si lo bloquea, la aplicación muestra una advertencia y no puede buscar. GitHub Pages no puede actuar como backend/proxy. El prototipo .NET sigue funcionando por separado.
- Abre la selección en el sitio oficial de Beelup, sin intentar resolver automáticamente el player ni saltar controles de acceso.
- **No hay reproducción integrada ni descarga de MP4 en esta versión**. Son funcionalidades pendientes de resolver con permisos, CORS y/o backend.
- PWA instalable con HTTPS, service worker y manifest; SVG icon puede no ofrecer experiencia de instalación completa en todos los sistemas (especialmente iOS), para producción conviene agregar PNG de 192 y 512 px.
- Proyecto independiente, no afiliado a Beelup.

## Prueba local

Servir la carpeta por HTTP (por ejemplo `python -m http.server 8080`), no abrir `index.html` como `file://`.

## Multipaís

Selector de 18 países presentes en el menú del sitio oficial Beelup (captura de referencia). La lista es estática porque no se ha confirmado un endpoint para descubrir países. Cada cambio de país vuelve a consultar clubes, y reinicia cancha, fecha y horario. El enlace al partido usa la ruta correspondiente al país. La conectividad desde GitHub Pages depende de CORS.


## v0.4
La búsqueda utiliza Cloudflare Worker. Requiere que el Worker esté desplegado y permita CORS desde https://mgcarnevali.github.io. El JSON de Beelup usa campos en minúsculas y se normaliza en la interfaz.
