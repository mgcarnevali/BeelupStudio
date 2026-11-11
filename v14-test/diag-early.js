'use strict';
// Sólo en /v14-test/: registra errores de JavaScript desde el inicio de la carga.
window.__diagErrors = [];
window.addEventListener('error', e => { window.__diagErrors.push((e.message || 'error') + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : '')); });
window.addEventListener('unhandledrejection', e => { window.__diagErrors.push('promesa: ' + (e.reason && e.reason.message || e.reason)); });
