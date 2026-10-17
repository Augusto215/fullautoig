// Watcher de códigos: lê os códigos de confirmação que chegam no Gmail (já logado no seu
// Chrome) e preenche sozinho o perfil que está esperando, pelo painel.
//
// Como funciona:
//   - conecta num Chrome aberto em modo depuração (--remote-debugging-port). Use o
//     atalho "abrir-chrome-watcher.bat" para abrir esse Chrome com as suas sessões.
//   - a cada pollMs pergunta ao painel quais perfis estão parados na tela do código
//     (GET /api/sync -> codes[] = { id, name, email, at }).
//   - para cada perfil, busca no Gmail da conta base o email do Instagram endereçado
//     àquele alias (to:nome+alias@gmail.com), tira o código de 6 dígitos e manda para o
//     painel (POST /api/codes { id, code }) — o mesmo caminho de quando você digita à mão.
//
// Uma caixa só atende todos os perfis: os aliases (nome+abc123@gmail.com) caem todos na
// inbox de nome@gmail.com, e cada email é casado com o perfil certo pelo campo "Para:".
//
// Uso: npm run watcher   (com o painel e a sincronização rodando, e o Chrome do .bat aberto)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.watcher.json'), 'utf8'));
const PANEL = (CONFIG.panelUrl || 'http://localhost:3333').replace(/\/$/, '');
const POLL = Number(CONFIG.pollMs) || 5000;
const WINDOW = CONFIG.searchWindow || '1d';

const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseOf = (email) => String(email || '').toLowerCase().replace(/\+[^@]*(?=@)/, ''); // tira o +alias

// ---------------------------------------------------------------- painel (localhost)

function panel(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(PANEL + route);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { 'Content-Type': 'application/json', 'x-painel': '1', ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(raw); } catch {}
        if (res.statusCode >= 400) reject(new Error(json.error || `HTTP ${res.statusCode}`));
        else resolve(json);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------- abrir o Chrome depurável

// Abre o Chrome com a porta de depuração ligada, reaproveitando as sessões já logadas.
// userDataDir em branco = uma pasta própria do watcher (coexiste com o seu Chrome do dia a dia;
// basta logar a conta base uma única vez e ela fica salva). Apontando para a sua pasta real do
// Chrome, ele reaproveita TODOS os logins, mas aí o seu Chrome normal precisa estar fechado.
function openChrome() {
  const port = CONFIG.chromePort || 9222;
  const chrome = CONFIG.chromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const dir = CONFIG.userDataDir || path.join(__dirname, 'chrome-watcher-data');
  if (!fs.existsSync(chrome)) throw new Error(`não achei o Chrome em ${chrome}. Ajuste "chromePath" em config.watcher.json.`);
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check'];
  if (CONFIG.profileDirectory) args.push(`--profile-directory=${CONFIG.profileDirectory}`);
  // aba identificadora (título e ícone próprios) + o Gmail
  const tabFile = 'file:///' + path.join(__dirname, 'watcher-tab.html').replace(/\\/g, '/');
  args.push(tabFile, 'https://mail.google.com/');
  log(`abrindo o Chrome (porta ${port}, perfil em ${dir}).`);
  if (!CONFIG.userDataDir) log('primeira vez: faça login na conta base do Gmail nesta janela. Depois é só deixá-la aberta.');
  spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------- Chrome / Gmail

async function connectChrome() {
  const url = `http://127.0.0.1:${CONFIG.chromePort || 9222}`;
  try {
    return await puppeteer.connect({ browserURL: url, defaultViewport: null, protocolTimeout: 120000 });
  } catch (_) {
    throw new Error(
      `não achei o Chrome em ${url}.\n` +
      `Abra o Chrome em modo depuração com o atalho "abrir-chrome-watcher.bat" (duplo clique) e deixe-o aberto.`);
  }
}

// Abre uma aba PRÓPRIA do watcher (não mexe nas abas que você está usando).
async function gmailTab(browser) {
  return browser.newPage();
}

// Lista TODAS as contas logadas (/u/0 … /u/9). Não para no primeiro buraco: um índice pode
// estar vazio (conta removida) ou falhar na hora, e as contas seguintes ainda existem.
async function listAccounts(page) {
  const accts = [], seen = new Set();
  let signedOut = 0;
  for (let u = 0; u < 10; u++) {
    try { await page.goto(`https://mail.google.com/mail/u/${u}/`, { waitUntil: 'networkidle2', timeout: 30000 }); }
    catch { /* mesmo com timeout, tenta ler o que carregou */ }
    if (/accounts\.google\.com/.test(page.url())) { signedOut++; continue; } // esse slot caiu no login
    const landed = (page.url().match(/\/mail\/u\/(\d+)\//) || [])[1];
    if (landed !== undefined && landed !== String(u)) continue; // índice vazio (redirecionou): pula
    const email = await accountEmail(page);
    if (!email || seen.has(email)) continue; // sem email ou repetido: pula
    seen.add(email); accts.push({ u, email });
  }
  if (signedOut) log(`atenção: ${signedOut} conta(s) do Gmail estão DESLOGADAS — reentre nelas na janela do watcher (o seletor de contas mostra "Sair"/"Fazer login").`);
  return accts;
}

// O email da conta aparece no título da aba ("Caixa de entrada - nome@gmail.com - Gmail").
// Enquete o título por alguns segundos (o Gmail demora a preencher depois de carregar).
async function accountEmail(page) {
  for (let i = 0; i < 20; i++) {
    const t = await page.title().catch(() => '');
    const m = t.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (m) return m[0].toLowerCase();
    if (/accounts\.google\.com/.test(page.url())) return '';
    await sleep(500);
  }
  return '';
}

// Procura o código em TODAS as contas logadas, começando pela que casa com o alias (nome@...).
// Devolve { code, email } ou null se não achou em nenhuma.
async function findCodeAnywhere(page, accounts, alias) {
  const base = baseOf(alias);
  const ordered = [...accounts].sort((a, b) => (a.email === base ? -1 : 0) - (b.email === base ? -1 : 0));
  for (const acct of ordered) {
    const code = await searchAccount(page, acct.u, alias);
    if (code) return { code, email: acct.email };
  }
  return null;
}

// Busca dirigida numa conta: email do Instagram endereçado àquele alias. Devolve o código ou ''.
async function searchAccount(page, u, alias) {
  const q = `to:${alias} (from:instagram OR from:mail.instagram.com) newer_than:${WINDOW}`;
  // goto completo recarrega a busca de forma confiável; a espera garante que a lista renderizou
  await page.goto(`https://mail.google.com/mail/u/${u}/#search/${encodeURIComponent(q)}`, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  try {
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('tr.zA');
      const t = (document.querySelector('[role="main"]') || document.body).innerText || '';
      return rows.length > 0 || /Nenhuma conversa|No conversations|no messages matched|não corresponde/i.test(t);
    }, { timeout: 12000 });
  } catch {}
  await sleep(800);
  return page.evaluate(() => {
    for (const row of document.querySelectorAll('tr.zA, tr[role="row"]')) {
      const t = row.innerText || '';
      if (!/instagram|c[oó]digo|code/i.test(t)) continue;
      const m = t.match(/\b(\d{6})\b/);
      if (m) return m[1];
    }
    return '';
  });
}

// ---------------------------------------------------------------- laço principal

const report = (findings) => panel('POST', '/api/watcher/report', { online: true, findings }).catch(() => {});

async function main() {
  const browser = await connectChrome();
  log('conectado ao Chrome.');
  const page = await gmailTab(browser);
  const sent = new Set(); // id:código já mandados, para não repetir (inclusive código errado)
  let accounts = [], listedAt = 0, pausedLogged = false;

  for (;;) {
    let waiting = [], reqEmails = [];
    try {
      const s = await panel('GET', '/api/sync');
      // sincronização iniciada com "Iniciar sem email": os códigos são digitados no painel
      if (s.noEmail) {
        if (!pausedLogged) log('modo "sem email" no painel: watcher em espera (os códigos são digitados no painel).');
        pausedLogged = true;
        await report({});
        await sleep(POLL);
        continue;
      }
      if (pausedLogged) log('modo "sem email" terminou: voltando a buscar os códigos.');
      pausedLogged = false;
      waiting = (s.codes || []).filter((c) => c.state !== 'sent'); // 'sent' já recebeu o código e está confirmando
    }
    catch (e) { log('painel indisponível:', e.message, '(o painel está rodando?)'); await sleep(POLL); continue; }
    // emails que a extensão (fluxo sem CDP) está pedindo o código
    try { reqEmails = (await panel('GET', '/api/code-requests')).emails || []; } catch {}

    // (re)lista as contas logadas. Além do periódico, re-escaneia (no máx. a cada 30s) quando um
    // perfil/pedido espera código de uma conta que ainda não apareceu — logou a conta, acha rápido.
    const bases = new Set(accounts.map((a) => a.email));
    const temPendencia = waiting.length || reqEmails.length;
    const faltaConta = [...waiting.map((c) => c.email), ...reqEmails].some((e) => e && !bases.has(baseOf(String(e).toLowerCase())));
    const idade = Date.now() - listedAt;
    if ((temPendencia && !accounts.length) || idade > 60000 || (faltaConta && idade > 30000)) {
      try { accounts = await listAccounts(page); listedAt = Date.now(); log('contas logadas:', accounts.map((a) => a.email).join(', ') || 'nenhuma'); }
      catch (e) { log('não consegui ler as contas do Gmail:', e.message.split('\n')[0]); }
    }

    const findings = {};
    if (waiting.length && !accounts.length) {
      for (const c of waiting) findings[c.id] = { state: 'sem-conta', info: 'nenhum Gmail logado na aba' };
    }
    for (const c of waiting) {
      const alias = String(c.email || '').toLowerCase();
      if (!alias.includes('@')) { findings[c.id] = { state: 'naoachou', info: 'sem email' }; continue; }
      if (!accounts.length) continue;
      // a conta base desse perfil não está logada no watcher?
      if (!new Set(accounts.map((a) => a.email)).has(baseOf(alias))) {
        findings[c.id] = { state: 'sem-conta', info: `${baseOf(alias)} deslogada no watcher — faça login` };
        continue;
      }
      try {
        const hit = await findCodeAnywhere(page, accounts, alias);
        if (!hit) { findings[c.id] = { state: 'naoachou', info: 'não encontrei o código ainda' }; continue; }
        findings[c.id] = { state: 'achou', code: hit.code, info: hit.email };
        const key = `${c.id}:${hit.code}`;
        if (sent.has(key)) continue;
        sent.add(key);
        await panel('POST', '/api/codes', { id: c.id, code: hit.code, from: 'watcher' });
        log(`[${c.name}] código ${hit.code} enviado ao painel (${alias} em ${hit.email}).`);
      } catch (e) {
        findings[c.id] = { state: 'naoachou', info: 'erro ao buscar' };
        log(`[${c.name || c.id}]`, e.message.split('\n')[0]);
        accounts = []; // força reler as contas na próxima volta
      }
    }

    // pedidos da extensão (perfil sem CDP): acha o código no Gmail e devolve pro painel
    for (const email of reqEmails) {
      const alias = String(email).toLowerCase();
      if (!alias.includes('@') || !accounts.length) continue;
      if (!new Set(accounts.map((a) => a.email)).has(baseOf(alias))) continue; // conta não logada aqui
      try {
        const hit = await findCodeAnywhere(page, accounts, alias);
        if (!hit) continue;
        const key = `req:${alias}:${hit.code}`;
        if (sent.has(key)) continue;
        sent.add(key);
        await panel('POST', '/api/codes-found', { email: alias, code: hit.code });
        log(`código ${hit.code} achado para ${alias} (pedido da extensão).`);
      } catch (e) { log(`busca ${alias}:`, e.message.split('\n')[0]); }
    }

    await report(findings); // também serve de "estou vivo" para o painel mostrar o watcher ligado
    await sleep(POLL);
  }
}

if ((process.argv[2] || '').toLowerCase() === 'chrome') {
  try { openChrome(); } catch (e) { console.error('ERRO:', e.message); process.exit(1); }
} else {
  main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
