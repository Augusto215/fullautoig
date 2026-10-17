// Núcleo do espelhamento: recebe os navegadores já conectados (o primeiro é a MÃE)
// e repete nos demais tudo o que é feito na mãe. Não depende de Dolphin ou AdsPower.
const readline = require('readline');
const puppeteer = require('puppeteer-core');
const buildCapture = require('./capture');
const emails = require('./emails');

const BINDING = '__ds_' + Math.random().toString(36).slice(2, 10);
const CAPTURE = buildCapture(BINDING);

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error(`não foi possível acessar ${new URL(url).origin} (o app está aberto e logado?) - ${e.cause?.code || e.message}`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}: ${text.slice(0, 300)}`);
  return body;
}

// Conecta no navegador pelo endpoint de DevTools, tentando de novo enquanto ele termina de abrir
async function connectWs(ws) {
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      return await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 120000 });
    } catch (e) {
      lastErr = e;
      await sleep(1000);
    }
  }
  throw lastErr;
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} demorou mais de ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

let NAV_DELAY = 1000;
let paused = false;
let master = null;
let followers = [];
const masterPages = [];

// ---------------------------------------------------------------- randomizador

// Cada seguidor recebe um sufixo próprio, para email e usuário não ficarem iguais aos da mãe
let VARY = { email: true, username: true, skipCodes: true };
const randChars = (n) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');

function newRandom(f) {
  f.rand = { email: randChars(5), user: '_' + randChars(4) };
  const parts = [];
  if (VARY.email) parts.push(`email: nome+${f.rand.email}@...`);
  if (VARY.username) parts.push(`usuário: nome${f.rand.user}`);
  if (parts.length) log(`[${f.name}] ${parts.join(' | ')}`);
}

function vary(f, ev) {
  const v = ev.value || '';
  if (ev.ftype === 'password' || !v) return v;
  const at = v.indexOf('@');
  if (VARY.email && at > 0) return `${v.slice(0, at)}+${f.rand.email}${v.slice(at)}`;
  if (VARY.username && ev.kind === 'username') return v + f.rand.user;
  return v;
}

// ---------------------------------------------------------------- cadastro automático

// Roda dentro de todas as abas de todos os perfis. No cadastro do Instagram, a cada visita:
//   1. clica no botão "⚡ AVL" da extensão (nome, senha, usuário e data);
//   2. preenche o email com um da lista do painel (único por perfil, ou alias quando a lista acaba);
//   3. clica no botão de enviar o formulário.
// Os cliques e o preenchimento são feitos pela página (não são "isTrusted"), então a mãe não os replica.
function signupAgent(opt, binding) {
  if (window.top !== window || window.__dsAvl || !/(^|\.)instagram\.com$/.test(location.hostname)) return;
  Object.defineProperty(window, '__dsAvl', { value: true, enumerable: false });

  const call = (type, data = {}) => {
    const f = window[binding];
    return typeof f === 'function' ? f(JSON.stringify({ type, ...data })).catch(() => null) : Promise.resolve(null);
  };
  const isSignup = () => /^\/(?:accounts\/(?:emailsignup|signup)|signup)\/?$/.test(location.pathname);
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const ours = (el) => !!el.closest('#itm-story-toolbar, [id^="itm-"]');
  const hints = (el) => [el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('placeholder'),
    el.getAttribute('autocomplete'), ...[...(el.labels || [])].map((l) => l.textContent)].join(' ').toLowerCase();

  function emailField() {
    return [...document.querySelectorAll('input')].find((el) => visible(el) && !el.disabled && !el.readOnly &&
      ['email', 'text', 'tel', ''].includes(el.type) && (el.type === 'email' || /e-?mail|celular|phone|telefone/.test(hints(el))));
  }
  const field = (re) => [...document.querySelectorAll('input')].find((el) => visible(el) && re.test(hints(el)));

  function submitButton() {
    const pwd = document.querySelector('input[type="password"]');
    const scope = (pwd && pwd.closest('form')) || document;
    const btns = [...scope.querySelectorAll('button, [role="button"]')].filter((b) => visible(b) && !ours(b));
    return btns.find((b) => b.tagName === 'BUTTON' && b.type === 'submit') ||
      btns.find((b) => /^(sign up|cadastre-se|cadastrar|enviar|submit|next|avançar|próximo)$/i.test((b.innerText || '').trim()));
  }
  const enabled = (b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true';

  function setValue(el, value) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }
  // Coordenadas do centro de um elemento (para o Node clicar/digitar com input REAL, isTrusted).
  function boxOf(el) {
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // digita caractere por caractere, com pausas, para não parecer "colado de uma vez" (menos robótico)
  async function typeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    let v = '';
    for (const ch of String(value)) {
      v += ch;
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch }));
      setter.call(el, v);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch }));
      await new Promise((r) => setTimeout(r, 90 + Math.floor(Math.random() * 150))); // ~90–240ms por dígito
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  // ---- tela do código de confirmação: avisa o painel e recebe o código digitado lá
  function codeField() {
    return [...document.querySelectorAll('input')].find((el) => visible(el) && !el.disabled && !el.readOnly &&
      !['password', 'email', 'hidden', 'checkbox', 'radio'].includes(el.type) &&
      (el.getAttribute('autocomplete') === 'one-time-code' ||
        /confirmation|verification|security_?code|c[oó]digo|\bcode\b|confirma/.test(hints(el))));
  }
  function confirmButton(el) {
    const scope = el.closest('form') || document;
    const btns = [...scope.querySelectorAll('button, [role="button"]')].filter((b) => visible(b) && !ours(b) && enabled(b));
    return btns.find((b) => b.tagName === 'BUTTON' && b.type === 'submit') ||
      btns.find((b) => /^(next|avançar|próximo|confirm|confirmar|continuar|continue|enviar|submit)$/i.test((b.innerText || '').trim()));
  }
  // detecta a mensagem de erro do Instagram na tela do código (código incorreto/inválido/expirado)
  function codeError() {
    const el = codeField();
    const scope = (el && el.closest('form')) || document;
    const t = (scope.innerText || '').toLowerCase();
    return /(c[oó]digo|code)[^.]{0,40}(incorret|inv[aá]lid|errad|expir)|(incorret|inv[aá]lid|wrong|expir)[^.]{0,40}(c[oó]digo|code)|esse c[oó]digo n[ãa]o|that code (is|was)|check the code|tente outro c[oó]digo/.test(t);
  }

  // Reenviar é em 2 passos no Instagram: "Não recebi o código" abre um menu com
  // "Reenviar código de confirmação". Clicamos o primeiro e, se abrir o menu, o segundo.
  // NUNCA clicamos em "Alterar número/email" (mudaria o email da conta).
  const resendCandidates = () => [...document.querySelectorAll('button, [role="button"], a')]
    .filter((b) => visible(b) && !ours(b))
    .map((b) => ({ b, t: (b.innerText || '').trim() }))
    .filter(({ t }) => t.length > 0 && t.length < 60 && !/alterar|change|celular|phone|email|e-mail/i.test(t));
  const resendTrigger = () => (resendCandidates().find(({ t }) =>
    /n[ãa]o recebi|n[ãa]o recebeu|reenviar|solicitar.{0,12}novo|enviar.{0,12}novamente|enviar novo c[oó]digo|resend|request a new|didn'?t (get|receive)|send a new|get a new code/i.test(t)) || {}).b;
  const resendConfirm = () => (resendCandidates().find(({ t }) =>
    /reenviar|resend|enviar.{0,12}novamente|send.{0,12}new code/i.test(t) && !/n[ãa]o recebi|n[ãa]o recebeu/i.test(t)) || {}).b;
  async function doResend() {
    const trigger = resendTrigger();
    if (!trigger) return 'não achei o botão de reenviar';
    await call('realClick', { box: boxOf(trigger) }); // clique REAL
    await new Promise((r) => setTimeout(r, 1500)); // espera abrir o menu "Não recebeu o código?"
    const confirm = resendConfirm();
    if (confirm && confirm !== trigger) await call('realClick', { box: boxOf(confirm) });
    return 'ok';
  }
  let codeWaiting = false, lastTry = 0, triedCode = '', resends = 0, lastResend = 0, resending = false;
  setInterval(async () => {
    const el = codeField();
    if (!el) { if (codeWaiting) { codeWaiting = false; lastTry = 0; resends = 0; lastResend = 0; call('codeGone'); } return; }
    if (!codeWaiting) { codeWaiting = true; call('codeWaiting'); }
    // janela de carência: logo após enviar um código, espera a próxima página do Instagram carregar
    // antes de reagir a erro (senão um erro ANTIGO ainda na tela faz reenviar à toa = "reset brusco").
    const grace = lastTry && Date.now() - lastTry < 7000;
    // código ruim: o Instagram acusou erro na tela (inválido/expirou), OU ficou sem resposta 18s
    // depois do envio. Pede um código NOVO (no máx. 1 a cada 20s, até 3x) para o watcher pegar o novo.
    const erro = !grace && codeError();
    const semResposta = lastTry && Date.now() - lastTry > 18000;
    if ((erro || semResposta) && resends < 3 && !resending && Date.now() - lastResend > 20000) {
      resending = true;
      const c = triedCode; lastTry = 0; triedCode = '';
      call('codeRejected', { code: c });
      const r = await doResend();
      if (r === 'ok') { resends++; lastResend = Date.now(); call('log', { msg: `código ${c || ''} recusado${erro ? ' (Instagram acusou erro)' : ' (sem resposta)'} — pedi código novo (${resends}/3)` }); }
      else call('log', { msg: `código recusado — ${r}` });
      resending = false;
    }
  }, 1000);
  Object.defineProperty(window, binding + '_code', {
    enumerable: false,
    value: async (code) => {
      const el = codeField();
      if (!el) return 'o campo do código não está na tela';
      await typeValue(el, code); // digita devagar, dígito por dígito
      await new Promise((r) => setTimeout(r, 500));
      const b = confirmButton(el);
      if (!b) return 'código preenchido, mas não achei o botão de confirmar: clique nele no perfil';
      b.click();
      lastTry = Date.now(); triedCode = code; // se continuar na tela, vira "codeRejected"
      return 'ok';
    },
  });
  // pedir um código novo ao Instagram (chamado pelo painel: "Novo código") — faz os 2 passos
  Object.defineProperty(window, binding + '_resend', {
    enumerable: false,
    value: () => doResend(),
  });
  // coordenadas para o Node digitar/clicar com INPUT REAL (isTrusted) no passo do código e no reenvio
  const def = (name, fn) => Object.defineProperty(window, binding + name, { enumerable: false, value: fn });
  def('_codeBox', () => boxOf(codeField()));
  def('_confirmBox', () => { const el = codeField(); return boxOf(el ? confirmButton(el) : null); });
  def('_markTried', (code) => { lastTry = Date.now(); triedCode = code; return 'ok'; });
  def('_resendTriggerBox', () => boxOf(resendTrigger()));
  def('_resendConfirmBox', () => boxOf(resendConfirm()));

  // st: estado desta visita à página de cadastro; zera ao sair dela
  let st = null;
  const go = (phase) => { st.phase = phase; st.since = Date.now(); };
  setInterval(async () => {
    if (!isSignup()) { st = null; return; }
    if (!st) st = { phase: 'avl', since: Date.now(), tries: 0, readySince: 0, lastClick: 0, email: null };
    if (st.busy || st.phase === 'done') return;
    const avl = document.getElementById('itm-avl-signup');
    const pwd = document.querySelector('input[type="password"]');

    if (st.phase === 'avl') {
      if (pwd && pwd.value) return go('email');
      if (!opt.avl) return; // espera a senha ser preenchida de outro jeito
      if (!avl || avl.disabled || !visible(avl) || !pwd) { st.readySince = 0; return; }
      if (!st.readySince) st.readySince = Date.now();
      // espera os campos assentarem e não insiste mais de 3 vezes na mesma visita
      if (Date.now() - st.readySince < 800 || Date.now() - st.lastClick < 8000 || st.tries >= 3) return;
      st.tries++; st.lastClick = Date.now();
      st.busy = true;
      await call('realClick', { box: boxOf(avl) }); // clique REAL (isTrusted) pelo Node
      st.busy = false;
      return;
    }
    if (avl && avl.disabled) return; // o AVL ainda está preenchendo (a data demora)

    if (st.phase === 'email') {
      if (Date.now() - st.since < 1000) return;
      const el = emailField();
      if (!el) { if (Date.now() - st.since > 6000) go('submit'); return; }
      if (el.value) return go('submit');
      if (!opt.email) return; // espera o email ser digitado (na mãe, ele é espelhado)
      // lista vazia: tenta de novo a cada 5s, para valer assim que a lista for salva no painel
      if (!st.email && Date.now() - (st.askedAt || 0) < 5000) return;
      st.busy = true;
      st.askedAt = Date.now();
      if (!st.email) st.email = await call('email');
      if (!st.email) { st.busy = false; return; }
      await call('realType', { box: boxOf(el), text: st.email }); // digitação REAL pelo Node
      st.busy = false;
      return go('submit');
    }

    if (st.phase === 'submit') {
      if (!opt.submit) return go('done');
      if (Date.now() - st.since < 1500) return; // deixa o Instagram validar o usuário
      const em = emailField();
      if (em && !em.value) return go('email'); // o React limpou o campo: preenche de novo (mesmo email)
      const b = submitButton();
      if (!b || !enabled(b)) {
        if (Date.now() - st.since > 20000) {
          call('log', { msg: 'o botão de enviar não liberou, confira os campos deste perfil' });
          go('done');
        }
        return;
      }
      const val = (re) => (field(re) || {}).value || '';
      const pwdEl = document.querySelector('input[type="password"]');
      call('submitted', { email: em ? em.value : '', username: val(/user|usu[aá]rio/), fullName: val(/full ?name|fullname|nome completo/), password: pwdEl ? pwdEl.value : '' });
      go('done');
      st.busy = true;
      await call('realClick', { box: boxOf(b) }); // clique REAL (isTrusted) no "Cadastre-se"
      st.busy = false;
    }
  }, 500);
}

let SIGNUP = { avl: true, email: true, submit: true };
const SIGNUP_BINDING = '__ds_su_' + Math.random().toString(36).slice(2, 10);
const signupPages = new WeakMap();

// Perfis parados na tela do código. O painel lê a lista pelas linhas "@@CODES" do stdout
// e manda o código de volta pelo comando "code <id do perfil> <código>".
const codes = new Map();
const lastEmail = new Map();
const lastAccount = new Map(); // prof.id -> { email, username, fullName } do último cadastro enviado
function publishCodes() {
  const list = [...codes.values()].map(({ page, ...c }) => c);
  console.log('@@CODES ' + JSON.stringify(list));
}

// clique e digitação com INPUT REAL (CDP), que o Instagram vê como isTrusted (igual a um humano)
// humanClick: move o cursor ATÉ o alvo em passos (como um macro/pessoa), com pausas, e clica.
async function humanClick(page, x, y, opts = {}) {
  try { await page.mouse.move(x, y, { steps: 10 + Math.floor(Math.random() * 15) }); } catch {}
  await sleep(60 + Math.floor(Math.random() * 140));
  await page.mouse.click(x, y, opts);
}
async function doRealClick(page, box) {
  if (!box) return 'sem elemento';
  try { await humanClick(page, box.x + (Math.random() * 6 - 3), box.y + (Math.random() * 4 - 2)); return 'ok'; }
  catch (e) { return e.message.split('\n')[0]; }
}
async function doRealType(page, box, text) {
  try {
    if (box) { await humanClick(page, box.x, box.y, { clickCount: 3 }); await sleep(150); } // foca/seleciona com clique real
    await page.keyboard.type(String(text), { delay: 90 + Math.floor(Math.random() * 90) }); // tecla por tecla, devagar
    return 'ok';
  } catch (e) { return e.message.split('\n')[0]; }
}
const evalBox = (page, suffix) => page.evaluate((fn, s) => (window[fn + s] ? window[fn + s]() : null), SIGNUP_BINDING, suffix);

async function submitCode(id, code) {
  const c = codes.get(id);
  if (!c) return log(`código ignorado: nenhum perfil com id ${id} esperando código`);
  const page = c.page;
  try {
    const box = await evalBox(page, '_codeBox');
    if (!box) { c.state = 'error'; c.info = 'o campo do código não está na tela'; log(`[${c.name}] código: ${c.info}`); return publishCodes(); }
    await humanClick(page, box.x, box.y, { clickCount: 3 }); // clique REAL; seleciona o que tiver no campo
    await sleep(200);
    await page.keyboard.type(String(code), { delay: 110 + Math.floor(Math.random() * 80) }); // digitação REAL, devagar
    await sleep(400 + Math.floor(Math.random() * 500));
    const btn = await evalBox(page, '_confirmBox');
    if (!btn) { c.state = 'error'; c.info = 'código preenchido, mas não achei o botão de confirmar'; log(`[${c.name}] ${c.info}`); return publishCodes(); }
    await humanClick(page, btn.x + (Math.random() * 6 - 3), btn.y + (Math.random() * 3 - 1.5)); // clique REAL no "Continuar"
    await page.evaluate((fn, code) => window[fn + '_markTried'] && window[fn + '_markTried'](code), SIGNUP_BINDING, code);
    c.state = 'sent'; c.info = `enviado: ${code}`;
    log(`[${c.name}] código ${code}: enviado (input real)`);
  } catch (e) {
    c.state = 'error'; c.info = e.message.split('\n')[0];
    log(`[${c.name}] não foi possível enviar o código:`, c.info);
  }
  publishCodes();
}

// Pede um código novo ao Instagram no perfil certo (clica em "Não recebi o código" → "Reenviar"), com clique real.
async function resendCode(id) {
  const c = codes.get(id);
  if (!c) return log(`reenvio ignorado: nenhum perfil com id ${id} na tela do código`);
  const page = c.page;
  try {
    const trig = await evalBox(page, '_resendTriggerBox');
    if (!trig) { c.state = 'error'; c.info = 'não achei o botão de reenviar'; log(`[${c.name}] ${c.info}`); return publishCodes(); }
    await humanClick(page, trig.x, trig.y); // clique REAL
    await sleep(1500);
    const conf = await evalBox(page, '_resendConfirmBox');
    if (conf) await humanClick(page, conf.x, conf.y); // clique REAL (passo 2 do menu)
    c.state = 'waiting'; c.info = 'pedi um código novo';
    log(`[${c.name}] reenvio de código: ok (input real)`);
  } catch (e) {
    c.info = e.message.split('\n')[0];
    log(`[${c.name}] não foi possível pedir código novo:`, c.info);
  }
  publishCodes();
}

function onSignupEvent(prof, page, json) {
  let ev;
  try { ev = JSON.parse(json); } catch { return null; }
  // input REAL pedido pelo agente (cliques/digitação do cadastro) — isTrusted, como um humano
  if (ev.type === 'realClick') return doRealClick(page, ev.box);
  if (ev.type === 'realType') return doRealType(page, ev.box, ev.text);
  if (ev.type === 'email') {
    const r = emails.next();
    if (!r) {
      warnOnce(prof, 'noemails', 'nenhum email na lista do painel: salve a lista lá (ou digite o email neste perfil)');
      return null;
    }
    log(`[${prof.name}] email: ${r.email}${r.alias ? ' (alias, a lista acabou)' : ''}`);
    lastEmail.set(prof.id, r.email);
    return r.email;
  }
  if (ev.type === 'codeWaiting') {
    codes.set(prof.id, { id: prof.id, name: prof.name, email: lastEmail.get(prof.id) || '', state: 'waiting', info: '', at: Date.now(), page });
    log(`[${prof.name}] esperando o código de confirmação (digite no painel, aba Códigos)`);
    publishCodes();
  }
  if (ev.type === 'codeGone' && codes.has(prof.id)) {
    codes.delete(prof.id);
    log(`[${prof.name}] passou da tela do código`);
    publishCodes();
    setConfirmed(prof, 'confirmou o código');
    // código validado (OK): grava a conta como confirmada, para a aba "Criadas"
    const acc = lastAccount.get(prof.id);
    if (acc) { try { emails.recordConfirmed(prof.name, acc); } catch (e) { log('não foi possível gravar contas-confirmadas.csv:', e.message); } lastAccount.delete(prof.id); }
  }
  if (ev.type === 'codeRejected' && codes.has(prof.id)) {
    const c = codes.get(prof.id);
    c.state = 'waiting';
    c.info = `código ${ev.code || ''} recusado, tentando de novo`;
    c.at = Date.now();
    log(`[${prof.name}] código ${ev.code || ''} recusado — voltou para a fila`);
    publishCodes();
  }
  if (ev.type === 'submitted') {
    if (ev.email) lastEmail.set(prof.id, ev.email);
    lastAccount.set(prof.id, { email: ev.email, username: ev.username, fullName: ev.fullName, password: ev.password }); // p/ gravar na confirmação
    log(`[${prof.name}] cadastro enviado: ${ev.email || '?'} / ${ev.username || '?'}`);
    try { emails.recordAccount(prof.name, ev); } catch (e) { log('não foi possível gravar contas-criadas.csv:', e.message); }
  }
  if (ev.type === 'log') log(`[${prof.name}] ${ev.msg}`);
  return null;
}

// Devolve sempre a mesma promessa por aba, para quem precisar esperar a injeção terminar
function injectSignupAgent(p, prof) {
  if (!signupPages.has(p)) signupPages.set(p, doInjectSignupAgent(p, prof));
  return signupPages.get(p);
}

// Mascaramento defensivo de sinais de automação (roda antes dos scripts da página).
const STEALTH = `(() => {
  try { Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => undefined, configurable: true }); } catch (e) {}
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch (e) {}
})();`;

async function doInjectSignupAgent(p, prof) {
  const src = `(${signupAgent})(${JSON.stringify(SIGNUP)}, ${JSON.stringify(SIGNUP_BINDING)})`;
  p.on('close', () => {
    const c = codes.get(prof.id);
    if (c && c.page === p) { codes.delete(prof.id); publishCodes(); }
  });
  try {
    await p.evaluateOnNewDocument(STEALTH);
    await p.evaluate(STEALTH).catch(() => {});
    await p.exposeFunction(SIGNUP_BINDING, (json) => onSignupEvent(prof, p, json));
    await p.evaluateOnNewDocument(src);
    await p.evaluate(src).catch(() => {});
  } catch {}
}

// ---------------------------------------------------------------- abas

const isUserPage = (p) => !p.url().startsWith('chrome-extension://') && !p.url().startsWith('devtools://');
const syncable = (url) => /^https?:\/\//i.test(url);
const sameUrl = (a, b) => a.replace(/\/+(?=$|[?#])/, '') === b.replace(/\/+(?=$|[?#])/, '');

// Guarda quando cada aba do seguidor começou uma navegação que ainda não terminou,
// para não carregar a mesma URL duas vezes quando o clique replicado já está navegando.
const navStarted = new WeakMap();
function trackNav(p, prof) {
  if (navStarted.has(p)) return p;
  navStarted.set(p, 0);
  p.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === p.mainFrame()) navStarted.set(p, Date.now());
  });
  p.on('framenavigated', (fr) => { if (fr === p.mainFrame()) navStarted.set(p, 0); });
  // faz a aba se comportar como se estivesse em foco, mesmo com a janela atrás de outra
  p.createCDPSession()
    .then((s) => s.send('Emulation.setFocusEmulationEnabled', { enabled: true }))
    .catch(() => {});
  injectSignupAgent(p, prof);
  return p;
}

// Aba do seguidor que corresponde à aba de índice idx da mãe. Se não existir,
// reaproveita uma aba que o próprio seguidor abriu (ex.: link com target=_blank) ou cria uma nova.
async function followerPage(f, idx) {
  let p = f.pages[idx];
  if (p && !p.isClosed()) return p;
  p = null;
  while (f.unclaimed.length) {
    const c = f.unclaimed.shift();
    if (!c.isClosed() && !f.pages.includes(c)) { p = c; break; }
  }
  if (!p) p = await f.browser.newPage();
  f.pages[idx] = trackNav(p, f);
  return p;
}

// Espelhamento travado até o código de confirmação: um seguidor só recebe as ações da mãe
// depois que a mãe e ele mesmo passaram da tela do código (ou com o comando "e").
let GATED = false;
const mirrors = (p) => !GATED || p.confirmed;

function setConfirmed(prof, why) {
  if (!GATED || prof.confirmed) return;
  prof.confirmed = true;
  const ready = followers.filter((f) => f.confirmed);
  if (prof === master) log(`mãe ${why}: espelhamento ligado para ${ready.length} de ${followers.length} perfis`);
  else if (master.confirmed) log(`[${prof.name}] ${why}: voltou para o espelhamento`);
  else log(`[${prof.name}] ${why}: entra no espelhamento quando a mãe confirmar o código`);
  if (master.confirmed && ready.length) masterPages.forEach(syncUrl);
}

// fn roda só nos seguidores que estão no espelhamento
function forEachMirror(fn) {
  if (!mirrors(master)) return;
  forEachFollower(fn, followers.filter(mirrors));
}

function forEachFollower(fn, list = followers) {
  for (const f of list) {
    f.queue = f.queue.then(() => fn(f)).catch((e) => log(`[${f.name}]`, process.env.SYNC_DEBUG ? e.stack : e.message.split('\n')[0]));
  }
}

async function syncUrl(masterPage) {
  const url = masterPage.url();
  const idx = masterPages.indexOf(masterPage);
  if (idx < 0 || !syncable(url)) return;
  forEachMirror(async (f) => {
    const fp = await followerPage(f, idx);
    // se o seguidor já está navegando (pelo clique replicado), espera essa navegação terminar
    for (let i = 0; i < 40 && !sameUrl(fp.url(), url) && Date.now() - navStarted.get(fp) < 10000; i++) await sleep(250);
    if (sameUrl(fp.url(), url)) return;
    log(`[${f.name}] aba ${idx + 1} -> ${url}`);
    await fp.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  });
}

const navTimers = new Map();
function scheduleNavSync(page) {
  if (paused) return;
  clearTimeout(navTimers.get(page));
  navTimers.set(page, setTimeout(() => syncUrl(page), NAV_DELAY));
}

async function hookMasterPage(page) {
  if (masterPages.includes(page) || !isUserPage(page)) return;
  masterPages.push(page);
  injectSignupAgent(page, master);
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) scheduleNavSync(page); });
  page.on('close', () => {
    const idx = masterPages.indexOf(page);
    if (idx < 0) return;
    masterPages.splice(idx, 1);
    for (const f of followers) {
      const [fp] = f.pages.splice(idx, 1);
      if (fp && !fp.isClosed()) fp.close().catch(() => {});
    }
  });
  try {
    await page.exposeFunction(BINDING, (json) => onMasterEvent(page, json));
    await page.evaluateOnNewDocument(CAPTURE);
    await page.evaluate(CAPTURE).catch(() => {});
  } catch (e) {
    log('não foi possível monitorar uma aba da mãe:', e.message.split('\n')[0]);
  }
}

// ---------------------------------------------------------------- replay

function onMasterEvent(page, json) {
  if (paused) return;
  let ev;
  try { ev = JSON.parse(json); } catch { return; }
  const idx = masterPages.indexOf(page);
  if (idx < 0) return;
  forEachMirror(async (f) => withTimeout(replay(f, await followerPage(f, idx), ev), 15000, ev.type));
}

// Roda dentro da página do seguidor: acha o elemento equivalente ao da mãe.
// Ordem: seletor CSS -> name -> aria-label -> rótulo (<label>) -> placeholder -> texto -> posição entre os iguais.
function locateInPage(ev) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const labelOf = (el) => {
    const l = (el.labels && el.labels[0]) || el.closest('label');
    return l ? l.innerText.split('\n')[0].trim().slice(0, 80) : '';
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; };
  let el = null;
  try { el = ev.sel ? document.querySelector(ev.sel) : null; } catch (_) {}
  if (el && el.tagName.toLowerCase() !== ev.tag) el = null;
  if (el && ev.label && labelOf(el) && norm(labelOf(el)) !== norm(ev.label)) el = null;
  const cands = Array.from(document.getElementsByTagName(ev.tag)).filter(visible);
  const by = (fn) => { if (!el) el = cands.find(fn) || null; };
  if (ev.name) by((e) => e.getAttribute('name') === ev.name);
  if (ev.aria) by((e) => e.getAttribute('aria-label') === ev.aria);
  if (ev.label) by((e) => norm(labelOf(e)) === norm(ev.label));
  if (ev.ph) by((e) => e.getAttribute('placeholder') === ev.ph);
  if (ev.text) by((e) => (e.innerText || '').trim().slice(0, 80) === ev.text);
  if (!el && ['input', 'textarea', 'select', 'button'].includes(ev.tag)) el = document.getElementsByTagName(ev.tag)[ev.idx] || null;
  return el;
}

// Espera até 3s o elemento aparecer (a página do seguidor pode estar um pouco atrasada)
async function locate(page, ev) {
  for (let i = 0; i < 12; i++) {
    const h = await page.evaluateHandle(locateInPage, ev).catch(() => null);
    const el = h && h.asElement();
    if (el) return el;
    if (h) await h.dispose().catch(() => {});
    await sleep(250);
  }
  return null;
}

const describe = (ev) => ev.label || ev.aria || ev.ph || ev.text || ev.name || ev.tag;
const warned = new Set();
function warnOnce(f, key, msg) {
  if (warned.has(f.name + key)) return;
  warned.add(f.name + key);
  log(`[${f.name}] ${msg}`);
}

async function replay(f, page, ev) {
  switch (ev.type) {
    case 'click': {
      const el = await locate(page, ev);
      let pt = null;
      if (el) {
        pt = await el.evaluate((el, ev) => {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = el.getBoundingClientRect();
          return r.width || r.height ? { x: r.left + r.width * ev.rx, y: r.top + r.height * ev.ry } : null;
        }, ev);
      }
      if (!pt) {
        log(`[${f.name}] "${describe(ev)}" não encontrado, clicando pela posição na tela`);
        pt = await page.evaluate((ev) => ({ x: innerWidth * ev.vx, y: innerHeight * ev.vy }), ev);
      }
      try {
        await withTimeout(page.mouse.click(pt.x, pt.y, { button: ev.button, clickCount: ev.count }), 4000, 'clique');
      } catch (e) {
        // janela sem resposta para o mouse (ex.: encoberta): clica pelo JavaScript
        if (!el) throw e;
        warnOnce(f, 'jsclick', 'a janela não respondeu ao mouse, usando clique via página');
        await el.evaluate((el) => { if (el.focus) el.focus(); el.click(); });
      }
      break;
    }
    case 'input': {
      if (ev.kind === 'code' && VARY.skipCodes) {
        warnOnce(f, 'code:' + describe(ev), `campo "${describe(ev)}" é de código de verificação: não copiado, preencha neste perfil`);
        return;
      }
      const el = await locate(page, ev);
      if (!el) return log(`[${f.name}] campo "${describe(ev)}" não encontrado`);
      await el.evaluate((el, ev, value) => {
        el.focus();
        if (ev.ce) {
          document.execCommand('selectAll');
          document.execCommand('insertText', false, value);
          return;
        }
        // usa o setter nativo para funcionar com React/Vue
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, ev, vary(f, ev));
      break;
    }
    case 'select': {
      const el = await locate(page, ev);
      if (!el) return log(`[${f.name}] lista "${describe(ev)}" não encontrada`);
      await el.evaluate((el, ev) => {
        for (const o of el.options) o.selected = ev.values.includes(o.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, ev);
      break;
    }
    case 'key':
      try {
        await withTimeout((async () => {
          if (ev.shift) await page.keyboard.down('Shift');
          await page.keyboard.press(ev.key);
          if (ev.shift) await page.keyboard.up('Shift');
        })(), 4000, 'tecla');
      } catch (e) {
        if (ev.key !== 'Enter') throw e;
        // Enter sem resposta: envia o formulário do campo em foco
        await page.evaluate(() => {
          const a = document.activeElement;
          if (a && a.form) a.form.requestSubmit ? a.form.requestSubmit() : a.form.submit();
        });
      }
      break;
    case 'scroll':
      await page.evaluate((ev) => {
        const el = ev.sel ? document.querySelector(ev.sel) : document.scrollingElement;
        if (!el) return;
        el.scrollTo(ev.rx * (el.scrollWidth - el.clientWidth), ev.ry * (el.scrollHeight - el.clientHeight));
      }, ev);
      break;
    case 'activate':
      await page.bringToFront();
      break;
  }
}

// ---------------------------------------------------------------- main

// opened: [{ id, name, browser }], o primeiro é a mãe.
// onExit(perfis): chamado ao sair, para o provedor fechar os perfis se configurado.
// onClosed(perfil): chamado quando um seguidor é fechado pelo usuário no meio da sessão.
// vary: { email, username, skipCodes } liga/desliga o randomizador e o bloqueio de campos de código.
// signup: { avl, email, submit } liga/desliga o cadastro automático do Instagram em todos os perfis.
// startUrl: página que todos os perfis abrem assim que a sincronização começa (vazio = não navega).
// mirrorAfterCode: só espelha num perfil depois que ele (e a mãe) confirmarem o código do cadastro.
async function run(opened, { navDelayMs, onExit, onClosed, vary: varyOpts, signup, startUrl, mirrorAfterCode } = {}) {
  GATED = !!mirrorAfterCode;
  if (navDelayMs != null) NAV_DELAY = navDelayMs;
  if (signup) SIGNUP = { ...SIGNUP, ...signup };
  if (varyOpts) VARY = { ...VARY, ...varyOpts };
  if (!opened.length) throw new Error('nenhum perfil foi aberto');
  [master, ...followers] = opened; // com 1 perfil, followers fica vazio (sem espelhamento, mas cadastro roda normal)
  const all = [...opened];

  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    log('encerrando...');
    if (onExit) await onExit(all).catch((e) => log('erro ao fechar perfis:', e.message));
    for (const p of all) { try { p.browser.disconnect(); } catch {} }
    process.exit(0);
  };

  for (const f of followers) {
    f.queue = Promise.resolve();
    f.unclaimed = [];
    f.pages = [];
    newRandom(f);
    f.browser.on('targetcreated', async (t) => {
      if (t.type() !== 'page') return;
      const p = await t.page().catch(() => null);
      if (p) f.unclaimed.push(p);
    });
    f.browser.on('disconnected', () => {
      if (exiting) return;
      log(`[${f.name}] desconectado, removido da sincronização`);
      followers = followers.filter((x) => x !== f);
      if (onClosed) onClosed(f).catch((e) => log(`[${f.name}] erro ao fechar:`, e.message));
    });
  }
  master.browser.on('disconnected', () => { log('perfil mãe fechado'); shutdown(); });

  // alinha as abas já abertas
  const mPages = (await master.browser.pages()).filter(isUserPage);
  if (startUrl && !mPages.length) mPages.push(await master.browser.newPage());
  for (const p of mPages) await hookMasterPage(p);
  for (const f of followers) f.pages = (await f.browser.pages()).filter(isUserPage).slice(0, mPages.length).map((p) => trackNav(p, f));

  if (startUrl) {
    // todos os perfis abrem a página inicial ao mesmo tempo, sem esperar o espelhamento da mãe
    log(`abrindo ${startUrl} em todos os perfis`);
    const open = (prof, p) => injectSignupAgent(p, prof)
      .then(() => p.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }))
      .catch((e) => log(`[${prof.name}] não abriu a página inicial:`, e.message.split('\n')[0]));
    open(master, mPages[0]);
    forEachFollower(async (f) => open(f, await followerPage(f, 0)));
    for (const p of mPages.slice(1)) syncUrl(p);
  } else {
    for (const p of mPages) syncUrl(p);
  }

  master.browser.on('targetcreated', async (t) => {
    if (t.type() !== 'page') return;
    const p = await t.page().catch(() => null);
    if (!p) return;
    await hookMasterPage(p);
    // espera o seguidor abrir a própria aba (se o clique abriu uma) antes de criar outra
    setTimeout(() => syncUrl(p), NAV_DELAY);
  });

  log(`mãe: ${master.name}. sincronizando ${followers.length} perfis.`);
  if (GATED) log('espelhamento desligado até cada perfil confirmar o código (comando [e] liga agora)');
  log('comandos: [p] pausar/retomar  [s] forçar URLs iguais  [r] novos valores aleatórios  [e] espelhar já  [q] sair');

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const m = line.trim().match(/^code\s+(\S+)\s+(\S+)$/i);
    if (m) return void submitCode(m[1], m[2]);
    const mr = line.trim().match(/^resend\s+(\S+)$/i);
    if (mr) return void resendCode(mr[1]);
    const c = line.trim().toLowerCase();
    if (c === 'p') { paused = !paused; log(paused ? 'PAUSADO' : 'RETOMADO'); }
    else if (c === 's') masterPages.forEach(syncUrl);
    else if (c === 'r') followers.forEach(newRandom);
    else if (c === 'e') {
      if (!GATED) return log('o espelhamento já está ligado para todos');
      [master, ...followers].forEach((p) => setConfirmed(p, 'liberado manualmente'));
    }
    else if (c === 'q') shutdown();
  });
  process.on('SIGINT', shutdown);
}

module.exports = { run, api, connectWs, log, sleep };
