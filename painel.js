// Painel local do GoLogin: criar perfis com proxies, escolher a mãe, extensões e sincronização.
// Uso: npm run painel   ->   abre http://localhost:3333
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, exec } = require('child_process');
const AdmZip = require('adm-zip');
const emails = require('./emails');

const PORT = Number(process.env.PAINEL_PORT) || 3333;
const EXT_DIR = path.join(__dirname, 'extensions');
const PAINEL_CONFIG = path.join(__dirname, 'config.painel.json');

// Qual navegador o painel comanda. Pode trocar na hora pelo seletor (POST /api/provider), sem reiniciar.
// Decide o sync.js a rodar e de qual config.<provider>.json ler/gravar a lista, o randomizador e o masterId.
// gologin e dolphin têm a mesma interface de admin (listProfiles, createProfile, setProxy, deleteProfile...).
const ADMINS = { gologin: require('./gologin-admin'), dolphin: require('./providers/dolphin-admin') };
const { parseProxy, testProxy } = require('./gologin-admin'); // utilitários de proxy, iguais para os dois
const readProviderFile = () => {
  try { return String(JSON.parse(fs.readFileSync(PAINEL_CONFIG, 'utf8')).provider || 'gologin').toLowerCase(); }
  catch { return 'gologin'; }
};
let PROVIDER = ADMINS[readProviderFile()] ? readProviderFile() : 'gologin';
const setProvider = (p) => { PROVIDER = p; fs.writeFileSync(PAINEL_CONFIG, JSON.stringify({ provider: p }, null, 2) + '\n'); };

const configFile = () => path.join(__dirname, `config.${PROVIDER}.json`);
const readConfig = () => JSON.parse(fs.readFileSync(configFile(), 'utf8'));
const writeConfig = (c) => fs.writeFileSync(configFile(), JSON.stringify(c, null, 2) + '\n');
const gl = () => {
  const { token } = readConfig();
  if (!token || token.startsWith('COLE')) throw new Error(`configure o token do ${PROVIDER} primeiro`);
  return ADMINS[PROVIDER](token);
};

// ---------------------------------------------------------------- extensões próprias

function localExtensions() {
  if (!fs.existsSync(EXT_DIR)) return [];
  return fs.readdirSync(EXT_DIR).filter((d) => fs.existsSync(path.join(EXT_DIR, d, 'manifest.json'))).map((d) => {
    let name = d, version = '';
    try {
      const m = JSON.parse(fs.readFileSync(path.join(EXT_DIR, d, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
      if (m.name && !m.name.startsWith('__MSG_')) name = m.name;
      version = m.version || '';
    } catch {}
    return { folder: d, name, version };
  });
}

// Grava a extensão em extensions/<nome>. files: [{ path: 'pasta/sub/arquivo', data: Buffer }].
// A raiz da extensão é onde está o manifest.json menos aninhado.
function installExtensionFiles(name, files) {
  const norm = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/') }));
  const manifests = norm.filter((f) => /(^|\/)manifest\.json$/.test(f.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  if (!manifests.length) throw new Error('não achei o manifest.json. Escolha a pasta da extensão (a que tem o manifest.json dentro)');
  const prefix = manifests[0].path.slice(0, -'manifest.json'.length);

  const folder = String(name || '').replace(/[^\w.-]+/g, '_') || 'extensao';
  const dest = path.join(EXT_DIR, folder);
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of norm) {
    if (!f.path.startsWith(prefix)) continue;
    const rel = f.path.slice(prefix.length);
    if (rel.startsWith('_metadata/')) continue; // assinatura da loja, o Chrome recusa se vier junto
    const out = path.join(dest, rel);
    if (!out.startsWith(dest + path.sep)) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.data);
  }
  return folder;
}

// Também aceita .zip ou .crx (o .crx é um zip com um cabeçalho na frente)
function installExtensionArchive(filename, buf) {
  const start = buf.indexOf(Buffer.from('PK\x03\x04', 'latin1'));
  if (start < 0) throw new Error('arquivo não é .zip nem .crx válido');
  const files = new AdmZip(buf.subarray(start)).getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => ({ path: e.entryName, data: e.getData() }));
  return installExtensionFiles(path.basename(filename).replace(/\.(zip|crx)$/i, ''), files);
}

// ID de extensão da Chrome Web Store: 32 letras de a-p, sozinho ou dentro do link
function storeId(input) {
  const m = String(input).match(/(?:^|\/)([a-p]{32})(?:$|[/?#])/);
  if (!m) throw new Error('não achei o ID da extensão. Cole o link da Chrome Web Store ou o ID de 32 letras');
  return m[1];
}

// ---------------------------------------------------------------- serviço de código por email
// A extensão (no perfil, sem CDP) pede o código do seu email; o watcher acha no Gmail e devolve.
// wanted: email -> quando foi pedido (o watcher busca esses). found: email -> { code, at }.
const codeSvc = { wanted: new Map(), found: new Map() };
const normEmail = (e) => String(e || '').trim().toLowerCase();
function requestCode(email) {
  if (noEmailMode()) return { code: null }; // modo "sem email": o código é digitado no painel
  email = normEmail(email);
  if (email.includes('@')) codeSvc.wanted.set(email, Date.now());
  const f = codeSvc.found.get(email);
  return { code: f ? f.code : null };
}
function wantedEmails() { // emails pedidos nos últimos 3 min (para o watcher procurar)
  if (noEmailMode()) return [];
  const cut = Date.now() - 180000;
  return [...codeSvc.wanted.entries()].filter(([, t]) => t > cut).map(([email]) => email);
}

// ---------------------------------------------------------------- sincronização

// codes: perfis parados na tela do código de confirmação, publicados pelo sync em linhas "@@CODES [...]"
// noEmail: sincronização iniciada com "Iniciar sem email" (watcher e busca de código no email desligados;
// os códigos são digitados na aba Códigos e o espelhamento liga em cada perfil depois que ele confirma)
const sync = { proc: null, log: [], codes: [], noEmail: false };
const noEmailMode = () => !!sync.proc && sync.noEmail;
// watcher: o processo watcher.js reporta aqui o que achou no Gmail (ligado se reportou nos últimos 20s)
const watcher = { at: 0, findings: {} };
const syncPayload = () => ({
  running: !!sync.proc, noEmail: noEmailMode(), log: sync.log.slice(-200), codes: sync.codes,
  watcher: { online: Date.now() - watcher.at < 20000, at: watcher.at, findings: watcher.findings },
  confirmed: emails.confirmed(), // contas que validaram o código (aba "Criadas")
});
function syncLog(line) {
  for (const l of String(line).split(/\r?\n/)) {
    if (l.startsWith('@@CODES ')) { try { sync.codes = JSON.parse(l.slice(8)); } catch {} continue; }
    if (l.trim()) sync.log.push(l);
  }
  if (sync.log.length > 400) sync.log.splice(0, sync.log.length - 400);
}

function startSync({ noEmail = false } = {}) {
  if (sync.proc) throw new Error('a sincronização já está rodando');
  sync.log = [];
  sync.codes = [];
  sync.noEmail = noEmail;
  codeSvc.wanted.clear();
  codeSvc.found.clear();
  const env = { ...process.env, SYNC_NO_EMAIL: noEmail ? '1' : '' };
  const p = spawn(process.execPath, [path.join(__dirname, 'sync.js'), PROVIDER], { cwd: __dirname, env });
  sync.proc = p;
  p.stdout.on('data', (d) => syncLog(d));
  p.stderr.on('data', (d) => syncLog(d));
  p.on('exit', (code) => { syncLog(`--- sincronização encerrada (código ${code})`); sync.proc = null; sync.codes = []; });
}

function syncCommand(c) {
  if (!sync.proc) throw new Error('a sincronização não está rodando');
  if (!['p', 's', 'r', 'e', 'q'].includes(c)) throw new Error('comando inválido');
  sync.proc.stdin.write(c + '\n');
}

// ---------------------------------------------------------------- rotas

// O painel.html é lido a cada acesso, mas este servidor fica com o código de quando abriu.
// Se os arquivos do servidor mudarem depois disso, a página pede para reiniciar o painel.
const BOOTED_AT = Date.now();
const SERVER_FILES = ['painel.js', 'emails.js', 'gologin-admin.js'].map((f) => path.join(__dirname, f));
const panelStale = () => SERVER_FILES.some((f) => { try { return fs.statSync(f).mtimeMs > BOOTED_AT; } catch { return false; } });

async function readBody(req, limit = 200 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('arquivo grande demais');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const routes = {
  'GET /api/state': async () => {
    const config = readConfig();
    const hasToken = !!config.token && !config.token.startsWith('COLE');
    let profiles = [], error = null;
    if (hasToken) {
      try { profiles = await gl().listProfiles(); } catch (e) { error = e.message; }
    }
    return {
      provider: PROVIDER, providers: Object.keys(ADMINS), hasToken, error, profiles, stale: panelStale(),
      masterId: config.masterId || (profiles[0] && profiles[0].id) || '',
      localExtensions: localExtensions(),
      settings: {
        randomizeEmail: config.randomizeEmail !== false,
        randomizeUsername: config.randomizeUsername !== false,
        skipVerificationCodes: config.skipVerificationCodes !== false,
        autoClickAvl: config.autoClickAvl !== false,
        fillSignupEmail: config.fillSignupEmail !== false,
        autoSubmitSignup: config.autoSubmitSignup !== false,
      },
      emails: emails.stats(),
      storeExtensions: PROVIDER === 'gologin' ? [...new Set(profiles.flatMap((p) => p.chromeExtensions))] : [],
      sync: syncPayload(),
    };
  },

  'POST /api/token': async ({ body }) => {
    const token = String(body.token || '').trim();
    await ADMINS[PROVIDER](token).listProfiles(); // valida antes de salvar
    writeConfig({ ...readConfig(), token });
    return { ok: true };
  },

  'POST /api/provider': async ({ body }) => {
    const p = String(body.provider || '').toLowerCase();
    if (!ADMINS[p]) throw new Error('navegador inválido');
    if (sync.proc) throw new Error('pare a sincronização antes de trocar de navegador');
    setProvider(p);
    return { ok: true, provider: p };
  },

  'POST /api/proxies/test': async ({ body }) => {
    const lines = String(body.text || '').split(/\r?\n/).filter((l) => l.trim());
    return Promise.all(lines.map(async (line) => {
      try {
        const r = await testProxy(parseProxy(line));
        return { line, ok: true, info: `${r.ip} · ${r.city || '?'} · ${r.country || '?'}` };
      } catch (e) {
        return { line, ok: false, info: e.message };
      }
    }));
  },

  'POST /api/profiles/create': async ({ body }) => {
    const api = gl();
    const lines = String(body.text || '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) throw new Error('cole pelo menos uma proxy');
    const proxies = lines.map(parseProxy); // valida tudo antes de criar qualquer coisa
    const prefix = String(body.prefix || 'Perfil').trim() || 'Perfil';
    const existing = await api.listProfiles();
    const results = [];
    for (let i = 0; i < proxies.length; i++) {
      const name = `${prefix} ${existing.length + i + 1}`;
      try {
        if (body.test) await testProxy(proxies[i]);
        const p = await api.createProfile(name, proxies[i]);
        if (PROVIDER === 'gologin') {
          for (const ext of [...new Set(existing.flatMap((x) => x.chromeExtensions))]) await api.addStoreExtension(p.id, ext);
        }
        results.push({ line: lines[i], ok: true, info: `${name} criado` });
      } catch (e) {
        results.push({ line: lines[i], ok: false, info: e.message });
      }
    }
    return results;
  },

  'POST /api/profiles/proxy': async ({ body }) => {
    await gl().setProxy(body.id, parseProxy(String(body.proxy || '')));
    return { ok: true };
  },

  'POST /api/profiles/delete': async ({ body }) => {
    await gl().deleteProfile(body.id);
    const c = readConfig();
    if (c.masterId === body.id) writeConfig({ ...c, masterId: '' });
    return { ok: true };
  },

  'POST /api/settings': async ({ body }) => {
    const c = readConfig();
    for (const k of ['randomizeEmail', 'randomizeUsername', 'skipVerificationCodes', 'autoClickAvl', 'fillSignupEmail', 'autoSubmitSignup']) {
      if (typeof body[k] === 'boolean') c[k] = body[k];
    }
    writeConfig(c);
    return { ok: true };
  },

  'POST /api/emails': async ({ body }) => ({ ok: true, count: emails.save(body.text || ''), stats: emails.stats() }),
  'POST /api/emails/reset-used': async () => { emails.resetUsed(); return { ok: true, stats: emails.stats() }; },
  'POST /api/accounts/reset': async () => { emails.resetConfirmed(); return { ok: true }; },

  'POST /api/master': async ({ body }) => {
    writeConfig({ ...readConfig(), masterId: String(body.id || '') });
    return { ok: true };
  },

  'POST /api/extensions/store': async ({ body }) => {
    const api = gl();
    const id = storeId(body.url);
    const profiles = await api.listProfiles();
    for (const p of profiles) await api.addStoreExtension(p.id, id);
    return { ok: true, id, count: profiles.length };
  },

  'POST /api/extensions/store/remove': async ({ body }) => {
    const api = gl();
    for (const p of await api.listProfiles()) {
      if (p.chromeExtensions.includes(body.id)) await api.removeStoreExtension(p.id, body.id);
    }
    return { ok: true };
  },

  'POST /api/extensions/upload': async ({ req, raw }) => {
    const filename = decodeURIComponent(req.headers['x-filename'] || 'extensao.zip');
    return { ok: true, folder: installExtensionArchive(filename, raw) };
  },

  // pasta escolhida no navegador: { name, files: [{ path, data (base64) }] }
  'POST /api/extensions/folder': async ({ body }) => {
    const files = (body.files || []).map((f) => ({ path: String(f.path), data: Buffer.from(f.data, 'base64') }));
    return { ok: true, folder: installExtensionFiles(body.name, files) };
  },

  'POST /api/extensions/local/remove': async ({ body }) => {
    const dest = path.join(EXT_DIR, path.basename(String(body.folder || '')));
    if (dest !== EXT_DIR) fs.rmSync(dest, { recursive: true, force: true });
    return { ok: true };
  },

  'GET /api/sync': async () => syncPayload(),
  'POST /api/watcher/report': async ({ body }) => {
    watcher.at = Date.now();
    watcher.findings = (body && typeof body.findings === 'object' && body.findings) || {};
    return { ok: true };
  },

  // ---- serviço de código por email (extensão no perfil pede; watcher acha e devolve) ----
  'GET /api/code-for': async ({ req }) => {
    const email = new URL(req.url, 'http://localhost').searchParams.get('email') || '';
    return requestCode(email); // { code: "123456" | null }
  },
  'GET /api/code-requests': async () => ({ emails: wantedEmails(), noEmail: noEmailMode(), watcherOnline: Date.now() - watcher.at < 20000 }),
  'POST /api/codes-found': async ({ body }) => {
    if (noEmailMode()) return { ok: true, ignored: true };
    const email = normEmail(body && body.email);
    const code = String((body && body.code) || '').replace(/\s+/g, '');
    if (email.includes('@') && /^\d{4,8}$/.test(code)) codeSvc.found.set(email, { code, at: Date.now() });
    return { ok: true };
  },
  'POST /api/codes': async ({ body }) => {
    const code = String(body.code || '').replace(/\s+/g, '');
    if (!/^[\w-]{3,12}$/.test(code)) throw new Error('código inválido');
    if (body.from === 'watcher' && noEmailMode()) throw new Error('modo sem email: o watcher está desligado, digite o código no painel');
    if (!sync.proc || !sync.codes.some((c) => c.id === body.id)) throw new Error('esse perfil não está esperando código');
    sync.proc.stdin.write(`code ${body.id} ${code}\n`);
    return { ok: true };
  },
  'POST /api/codes/resend': async ({ body }) => {
    if (!sync.proc || !sync.codes.some((c) => c.id === body.id)) throw new Error('esse perfil não está na tela do código');
    sync.proc.stdin.write(`resend ${body.id}\n`);
    return { ok: true };
  },
  'POST /api/sync/start': async ({ body }) => { startSync({ noEmail: !!body.noEmail }); return { ok: true }; },
  'POST /api/sync/cmd': async ({ body }) => { syncCommand(body.c); return { ok: true }; },
};

const server = http.createServer(async (req, res) => {
  const send = (status, data, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      return send(200, fs.readFileSync(path.join(__dirname, 'painel.html')), 'text/html');
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(404, { error: 'função não encontrada: feche o painel (Ctrl+C no terminal) e rode npm run painel de novo' });
    // bloqueia outros sites de chamarem o painel pelo navegador
    if (req.method !== 'GET' && req.headers['x-painel'] !== '1') return send(403, { error: 'proibido' });
    const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    let body = {};
    if ((req.headers['content-type'] || '').includes('application/json') && raw.length) body = JSON.parse(raw.toString('utf8'));
    send(200, await route({ req, raw, body }));
  } catch (e) {
    send(400, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  const url = `http://localhost:${PORT}`;
  console.log(`Já existe um painel aberto em ${url}. Abrindo ele no navegador.`);
  console.log('Para reiniciar o painel, feche o outro terminal onde ele está rodando (Ctrl+C) e rode de novo.');
  if (!process.env.PAINEL_NO_OPEN) exec(`start "" "${url}"`);
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Painel rodando em ${url}  (Ctrl+C para fechar)`);
  if (!process.env.PAINEL_NO_OPEN) exec(`start "" "${url}"`);
});

process.on('SIGINT', () => {
  if (sync.proc) sync.proc.stdin.write('q\n');
  setTimeout(() => process.exit(0), sync.proc ? 15000 : 0);
  if (sync.proc) sync.proc.on('exit', () => process.exit(0));
});
