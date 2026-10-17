// Gerenciamento de perfis do GoLogin pela API: criar com proxy, listar, apagar,
// adicionar extensões da Chrome Web Store e testar proxies.
const net = require('net');
const tls = require('tls');
const { api } = require('./core');

const API = 'https://api.gologin.com';

module.exports = (token) => {
  const auth = { Authorization: `Bearer ${token}` };
  const json = (method, body) => ({ method, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function listProfiles() {
    const all = [];
    for (let page = 1; page < 100; page++) {
      const r = await api(`${API}/browser/v2?page=${page}`, { headers: auth });
      const list = r.profiles || [];
      all.push(...list);
      if (!list.length || all.length >= (r.allProfilesCount || 0)) break;
    }
    return all
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .map((p) => ({
        id: String(p.id),
        name: p.name || String(p.id),
        proxy: p.proxy && p.proxy.mode !== 'none' && p.proxy.host
          ? { mode: p.proxy.mode, host: p.proxy.host, port: p.proxy.port, username: p.proxy.username || '' }
          : null,
        chromeExtensions: p.chromeExtensions || [],
      }));
  }

  const getProfile = (id) => api(`${API}/browser/${id}`, { headers: auth });

  // Cria um perfil com fingerprint aleatório de Windows e, se houver, já com a proxy
  async function createProfile(name, proxy) {
    const r = await api(`${API}/browser/quick`, json('POST', { os: 'win', osSpec: '', name }));
    const id = r && (r.id || r._id);
    if (!id) throw new Error(`GoLogin não devolveu o id do perfil: ${JSON.stringify(r).slice(0, 300)}`);
    if (proxy) await setProxy(id, proxy);
    return { id: String(id), name };
  }

  const setProxy = (id, proxy) => api(`${API}/browser/${id}/proxy`, json('PATCH', {
    mode: proxy.mode || 'http',
    host: proxy.host,
    port: Number(proxy.port),
    username: proxy.username || '',
    password: proxy.password || '',
  }));

  const deleteProfile = (id) => api(`${API}/browser/${id}`, { method: 'DELETE', headers: auth });

  // Edita o perfil completo (mesmo jeito que o pacote oficial faz em update())
  async function patchProfile(id, change) {
    const p = await getProfile(id);
    change(p);
    return api(`${API}/browser/${id}`, json('PUT', p));
  }

  const addStoreExtension = (id, extId) => patchProfile(id, (p) => {
    p.chromeExtensions = [...new Set([...(p.chromeExtensions || []), extId])];
  });

  const removeStoreExtension = (id, extId) => patchProfile(id, (p) => {
    p.chromeExtensions = (p.chromeExtensions || []).filter((e) => e !== extId);
  });

  return { listProfiles, getProfile, createProfile, setProxy, deleteProfile, addStoreExtension, removeStoreExtension };
};

// Aceita host:porta:usuario:senha, usuario:senha@host:porta e com prefixo http:// ou socks5://
function parseProxy(line) {
  let s = line.trim();
  if (!s) return null;
  let mode = 'http';
  const m = s.match(/^(https?|socks5|socks4):\/\//i);
  if (m) {
    mode = m[1].toLowerCase() === 'https' ? 'http' : m[1].toLowerCase();
    s = s.slice(m[0].length);
  }
  let host, port, username = '', password = '';
  if (s.includes('@')) {
    const [cred, addr] = [s.slice(0, s.lastIndexOf('@')), s.slice(s.lastIndexOf('@') + 1)];
    [host, port] = addr.split(':');
    const i = cred.indexOf(':');
    username = i < 0 ? cred : cred.slice(0, i);
    password = i < 0 ? '' : cred.slice(i + 1);
  } else {
    const parts = s.split(':');
    if (parts.length < 2) throw new Error(`proxy inválida: ${line}`);
    [host, port] = parts;
    username = parts[2] || '';
    password = parts.slice(3).join(':');
  }
  if (!host || !/^\d+$/.test(port || '')) throw new Error(`proxy inválida: ${line}`);
  return { mode, host, port: Number(port), username, password };
}

// Testa uma proxy HTTP abrindo um túnel até o ipinfo.io. Devolve { ip, city, country } ou lança erro.
function testProxy(proxy, timeoutMs = 20000) {
  if (proxy.mode !== 'http') return Promise.reject(new Error(`teste só suporta proxy http (esta é ${proxy.mode})`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('tempo esgotado')); }, timeoutMs);
    const fail = (e) => { clearTimeout(timer); reject(e); };
    const sock = net.connect(proxy.port, proxy.host);
    sock.once('error', fail);
    sock.once('connect', () => {
      const authHeader = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
        : '';
      sock.write(`CONNECT ipinfo.io:443 HTTP/1.1\r\nHost: ipinfo.io:443\r\n${authHeader}\r\n`);
    });
    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      if (!/^HTTP\/1\.\d 200/.test(head)) return fail(new Error(head.split('\r\n')[0] || 'proxy recusou a conexão'));
      const t = tls.connect({ socket: sock, servername: 'ipinfo.io' }, () => {
        t.write('GET /json HTTP/1.1\r\nHost: ipinfo.io\r\nConnection: close\r\nUser-Agent: curl/8\r\n\r\n');
      });
      let body = '';
      t.on('data', (c) => { body += c; });
      t.on('error', fail);
      t.on('end', () => {
        clearTimeout(timer);
        try {
          const r = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
          resolve({ ip: r.ip, city: r.city, country: r.country });
        } catch { reject(new Error('resposta inválida do teste')); }
      });
    };
    sock.on('data', onData);
  });
}

module.exports.parseProxy = parseProxy;
module.exports.testProxy = testProxy;
