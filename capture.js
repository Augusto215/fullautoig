// Script injetado no perfil MÃE. Captura cliques, digitação, teclas especiais,
// scroll e troca de aba, e envia para o Node através da função exposta (binding).
module.exports = (binding) => `(() => {
  if (window.top !== window || window.__dsCap) return;
  Object.defineProperty(window, '__dsCap', { value: true, enumerable: false });

  const send = (ev) => {
    const f = window['${binding}'];
    if (typeof f === 'function') { try { f(JSON.stringify(ev)); } catch (_) {} }
  };

  // IDs que parecem gerados automaticamente (React, etc.) mudam de perfil para perfil
  const stableId = (id) => /^[A-Za-z][\\w-]*$/.test(id) && !/\\d{3,}/.test(id);

  function cssPath(el) {
    if (!(el instanceof Element)) return null;
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && stableId(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        parts.unshift('#' + CSS.escape(el.id));
        break;
      }
      let sel = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(sel);
      el = parent;
    }
    return parts.length ? parts.join(' > ') : 'html';
  }

  const textOf = (el) => (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : (el.innerText || '')).trim().slice(0, 80);
  const labelOf = (el) => {
    const l = (el.labels && el.labels[0]) || el.closest('label');
    return l ? l.innerText.split('\\n')[0].trim().slice(0, 80) : '';
  };

  // Tudo o que ajuda a achar o mesmo elemento no outro perfil, mesmo se o seletor mudar
  function meta(el) {
    const tag = el.tagName.toLowerCase();
    return {
      sel: cssPath(el),
      tag,
      ftype: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      aria: el.getAttribute('aria-label') || '',
      ph: el.getAttribute('placeholder') || '',
      label: labelOf(el),
      text: textOf(el),
      idx: Array.prototype.indexOf.call(document.getElementsByTagName(tag), el),
    };
  }

  // Tipo do campo, para o randomizador: código de verificação, nome de usuário ou comum
  function kindOf(el) {
    const h = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'),
      el.id, el.getAttribute('autocomplete'), labelOf(el)].join(' ').toLowerCase();
    if (el.getAttribute('autocomplete') === 'one-time-code' || /c[oó]digo|\\bcode\\b|otp|verifica/.test(h)) return 'code';
    if (/usu[aá]rio|username|user name/.test(h) && !/e-?mail|celular|telefone|phone/.test(h)) return 'username';
    return '';
  }

  const NO_TEXT_TYPES = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'];
  const isEditable = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !NO_TEXT_TYPES.includes(el.type)));

  // ---- cliques (esquerdo e do meio) ----
  function onClick(e) {
    if (!e.isTrusted) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    // <select> e input de arquivo abrem janelas nativas que travariam os outros perfis
    if (t.closest('select, option') || (t.tagName === 'INPUT' && t.type === 'file')) return;
    const r = t.getBoundingClientRect();
    send({
      type: 'click',
      ...meta(t),
      rx: r.width ? (e.clientX - r.left) / r.width : 0.5,
      ry: r.height ? (e.clientY - r.top) / r.height : 0.5,
      vx: e.clientX / innerWidth,
      vy: e.clientY / innerHeight,
      button: e.button === 1 ? 'middle' : 'left',
      count: e.detail || 1,
    });
  }
  addEventListener('click', onClick, true);
  addEventListener('auxclick', (e) => { if (e.button === 1) onClick(e); }, true);

  // ---- digitação ----
  addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    const t = e.target;
    if (!(t instanceof Element) || t.tagName === 'SELECT') return;
    if (t.isContentEditable) send({ type: 'input', ...meta(t), kind: kindOf(t), value: t.innerText, ce: true });
    else if (isEditable(t)) send({ type: 'input', ...meta(t), kind: kindOf(t), value: t.value });
  }, true);

  addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const t = e.target;
    if (t instanceof HTMLSelectElement) {
      send({ type: 'select', ...meta(t), values: Array.from(t.selectedOptions).map((o) => o.value) });
    }
  }, true);

  // ---- teclas especiais (o texto em si já vai pelo evento "input") ----
  const KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || !KEYS.has(e.key)) return;
    send({ type: 'key', key: e.key, shift: e.shiftKey });
  }, true);

  // ---- scroll (página e elementos roláveis), em proporção para funcionar com tamanhos de janela diferentes ----
  const pending = new Map();
  addEventListener('scroll', (e) => {
    const t = e.target;
    if (pending.has(t)) return;
    pending.set(t, setTimeout(() => {
      pending.delete(t);
      const isDoc = t === document || t === document.documentElement || t === document.body;
      const s = isDoc ? document.scrollingElement : t;
      if (!s) return;
      send({
        type: 'scroll',
        sel: isDoc ? null : cssPath(t),
        rx: s.scrollLeft / Math.max(1, s.scrollWidth - s.clientWidth),
        ry: s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight),
      });
    }, 120));
  }, true);

  // ---- troca de aba ----
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') send({ type: 'activate' });
  });
})();`;
