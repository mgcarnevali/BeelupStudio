'use strict';
// Selectores de País y Club con búsqueda integrada.
// El <select> original sigue siendo la fuente de verdad: app.js arma sus opciones y escucha su
// evento «change», así que los valores enviados a la API y la lógica de selección no cambian.
(() => {
  const mobile = matchMedia('(max-width:1099px)');
  const coarse = matchMedia('(pointer:coarse)');
  const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Resalta la coincidencia respetando acentos y mayúsculas del texto original.
  function highlight(text, query) {
    if (!query) return esc(text);
    let folded = '', map = [];
    for (let i = 0; i < text.length; i++) { const f = fold(text[i]); for (let k = 0; k < f.length; k++) map.push(i); folded += f; }
    const at = folded.indexOf(query);
    if (at < 0) return esc(text);
    const a = map[at], b = map[at + query.length - 1] + 1;
    return esc(text.slice(0, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>' + esc(text.slice(b));
  }

  let openPicker = null;

  function enhance(id, { title, placeholder, noun }) {
    const select = document.getElementById(id);
    const pk = select.closest('.pk');
    const listId = id + '-list';
    select.classList.add('pk-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = id + '-btn'; btn.className = 'pk-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', title);
    select.after(btn);

    const pop = document.createElement('div');
    pop.className = 'pk-pop hidden'; pop.id = id + '-pop';
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', title);
    pop.innerHTML = `<div class="pk-pop-h"><b>${esc(title)}</b><button type="button" class="pk-close" aria-label="Cerrar"><svg class="i"><use href="#i-x"/></svg></button></div>
<label class="pk-search"><svg class="i"><use href="#i-search"/></svg><input type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="${listId}" placeholder="${esc(placeholder)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"></label>
<div class="pk-count" aria-live="polite"></div>
<div class="pk-list" id="${listId}" role="listbox" aria-label="${esc(title)}"></div>`;
    pk.append(pop);
    const input = pop.querySelector('input'), list = pop.querySelector('.pk-list'), count = pop.querySelector('.pk-count');

    let items = [], shown = [], active = -1;
    const api = { pop, pk };

    function refreshButton() {
      const opt = select.selectedOptions[0];
      btn.textContent = opt ? opt.text : '';
      btn.classList.toggle('ph', !select.value);
      btn.disabled = select.disabled;
      pk.classList.toggle('pk-off', select.disabled);
      if (select.disabled && openPicker === api) close(false);
    }
    function readItems() {
      items = [...select.options].filter(o => o.value !== '').map(o => ({ value: o.value, text: o.text, key: fold(o.text) }));
    }
    function render() {
      const q = fold(input.value.trim());
      shown = q ? items.filter(x => x.key.includes(q)) : items;
      // Primero los que empiezan con lo escrito, sin alterar el orden original dentro de cada grupo.
      if (q) shown = [...shown.filter(x => x.key.startsWith(q)), ...shown.filter(x => !x.key.startsWith(q))];
      const frag = document.createDocumentFragment();
      shown.forEach((x, i) => {
        const el = document.createElement('div');
        el.className = 'pk-opt'; el.id = `${id}-o${i}`; el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', String(x.value === select.value));
        el.dataset.i = i; el.innerHTML = highlight(x.text, q);
        frag.append(el);
      });
      list.replaceChildren(frag);
      if (!items.length) count.textContent = select.options[0]?.text || 'Sin opciones';
      else if (!shown.length) count.textContent = `Sin resultados para «${input.value.trim()}»`;
      else count.textContent = q ? `${shown.length} de ${items.length} ${noun}` : `${items.length} ${noun}`;
      const sel = shown.findIndex(x => x.value === select.value);
      setActive(q ? 0 : Math.max(sel, 0), !q);
    }
    function setActive(i, center) {
      if (!shown.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
      active = Math.max(0, Math.min(i, shown.length - 1));
      list.querySelector('.pk-opt.pk-act')?.classList.remove('pk-act');
      const el = list.children[active];
      el.classList.add('pk-act');
      input.setAttribute('aria-activedescendant', el.id);
      if (center) list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
      else el.scrollIntoView({ block: 'nearest' });
    }
    function choose(i) {
      const x = shown[i]; if (!x) return;
      close(true);
      if (select.value !== x.value) {
        select.value = x.value;
        refreshButton();
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function fitViewport() {
      if (!mobile.matches || !window.visualViewport) { pop.style.removeProperty('--vv-h'); pop.style.removeProperty('--vv-top'); return; }
      pop.style.setProperty('--vv-h', visualViewport.height + 'px');
      pop.style.setProperty('--vv-top', visualViewport.offsetTop + 'px');
    }
    function open() {
      if (select.disabled || openPicker === api) return;
      openPicker?.close(false);
      openPicker = api;
      readItems(); input.value = '';
      pop.classList.remove('hidden'); pk.classList.add('pk-open'); btn.setAttribute('aria-expanded', 'true');
      document.documentElement.classList.toggle('pk-lock', mobile.matches);
      fitViewport();
      render();
      input.focus({ preventScroll: true });
    }
    function close(focusButton) {
      if (openPicker !== api) return;
      openPicker = null;
      pop.classList.add('hidden'); pk.classList.remove('pk-open'); btn.setAttribute('aria-expanded', 'false');
      document.documentElement.classList.remove('pk-lock');
      if (focusButton) btn.focus({ preventScroll: true });
    }

    pk.addEventListener('click', e => {
      if (pop.contains(e.target)) return;
      openPicker === api ? close(true) : open();
    });
    pop.querySelector('.pk-close').addEventListener('click', () => close(true));
    input.addEventListener('input', render);
    input.addEventListener('keydown', e => {
      const page = Math.max(1, Math.floor(list.clientHeight / 40));
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); setActive(active + 1); break;
        case 'ArrowUp': e.preventDefault(); setActive(active - 1); break;
        case 'PageDown': e.preventDefault(); setActive(active + page); break;
        case 'PageUp': e.preventDefault(); setActive(active - page); break;
        case 'Enter': e.preventDefault(); if (active >= 0) choose(active); else if (coarse.matches) input.blur(); break;
        case 'Escape': e.preventDefault(); close(true); break;
        case 'Tab': close(false); break;
      }
    });
    btn.addEventListener('keydown', e => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
    });
    list.addEventListener('mousemove', e => { const o = e.target.closest('.pk-opt'); if (o && +o.dataset.i !== active) setActive(+o.dataset.i); });
    list.addEventListener('click', e => { const o = e.target.closest('.pk-opt'); if (o) choose(+o.dataset.i); });
    // Evita que el campo pierda el foco (y el teclado táctil se cierre y abra) al tocar una opción.
    list.addEventListener('mousedown', e => e.preventDefault());

    new MutationObserver(() => { refreshButton(); if (openPicker === api) { readItems(); render(); } })
      .observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    select.addEventListener('change', refreshButton);
    refreshButton();

    Object.assign(api, { close, fitViewport });
    return api;
  }

  enhance('country', { title: 'País', placeholder: 'Buscar país', noun: 'países' });
  enhance('club', { title: 'Club', placeholder: 'Buscar club', noun: 'clubes' });

  document.addEventListener('pointerdown', e => {
    if (openPicker && !openPicker.pk.contains(e.target)) openPicker.close(false);
  });
  window.visualViewport?.addEventListener('resize', () => openPicker?.fitViewport());
  window.visualViewport?.addEventListener('scroll', () => openPicker?.fitViewport());
  mobile.addEventListener('change', () => openPicker?.close(false));
})();
