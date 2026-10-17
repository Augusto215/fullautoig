// Preenche o código de confirmação do Instagram sozinho, SEM automação externa (sem CDP).
// Na tela do código, lê o email mostrado, busca o código no painel local (que o watcher achou
// no Gmail) e digita — exatamente o que você fazia à mão. O perfil continua "limpo" (sem CDP).
(() => {
  if (window.__itmCodeAuto) return;
  window.__itmCodeAuto = true;

  const AUTO_CLICK = true; // true: preenche e clica "Continuar" sozinho | false: só preenche, você clica

  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  function codeField() {
    return [...document.querySelectorAll('input')].find((el) => {
      if (!visible(el) || el.disabled || el.readOnly) return false;
      if (['password', 'email', 'hidden', 'checkbox', 'radio'].includes(el.type)) return false;
      const h = [el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('autocomplete'), el.id,
        ...[...(el.labels || [])].map((l) => l.textContent)].join(' ').toLowerCase();
      return el.getAttribute('autocomplete') === 'one-time-code' ||
        /confirma|verif|security.?code|c[oó]digo|\bcode\b|otp/.test(h);
    });
  }
  function pageEmail() {
    const t = (document.body && document.body.innerText) || '';
    const m = t.match(/[\w.+-]+@[\w.-]+\.\w+/);
    return m ? m[0].toLowerCase() : '';
  }
  function confirmBtn() {
    const btns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => visible(b) && !b.closest('[id^="itm-"]'));
    return btns.find((b) => b.tagName === 'BUTTON' && b.type === 'submit') ||
      btns.find((b) => /^(continuar|next|avançar|próximo|confirmar|continue|confirm)$/i.test((b.innerText || '').trim()));
  }
  async function typeSlow(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    let v = '';
    for (const ch of String(value)) {
      v += ch;
      setter.call(el, v);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      await new Promise((r) => setTimeout(r, 90 + Math.floor(Math.random() * 140)));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const getCode = (email) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: 'getCode', email }, (res) => resolve(res && res.code)); }
    catch { resolve(null); }
  });

  let busy = false;
  const done = new Set();

  setInterval(async () => {
    if (busy) return;
    const el = codeField();
    if (!el || (el.value && el.value.length >= 4)) return; // sem campo, ou já tem código
    const email = pageEmail();
    if (!email.includes('@')) return;
    busy = true;
    try {
      const code = await getCode(email); // registra o pedido no painel e pega o código quando houver
      if (code && !done.has(email + ':' + code)) {
        done.add(email + ':' + code);
        await typeSlow(el, code);
        if (AUTO_CLICK) {
          await new Promise((r) => setTimeout(r, 1000 + Math.random() * 800));
          const b = confirmBtn();
          if (b) b.click();
        }
      }
    } catch {}
    busy = false;
  }, 2500);
})();
