// Gerenciamento de perfis do Dolphin pela API de nuvem: listar, criar com proxy, trocar proxy, apagar.
// Mesma interface do gologin-admin, para o painel usar os dois do mesmo jeito.
const { api } = require('../core');
const { parseProxy, testProxy } = require('../gologin-admin');

const CLOUD = 'https://dolphin-anty-api.com';
// useragent precisa ser manual no Dolphin; um Chrome de Windows recente serve de base.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// proxy do nosso formato { mode, host, port, username, password } -> formato do Dolphin
const toDolphinProxy = (p) => ({
  type: p.mode === 'socks5' ? 'socks5' : p.mode === 'socks4' ? 'socks4' : 'http',
  host: p.host, port: Number(p.port), login: p.username || '', password: p.password || '',
});

module.exports = (token) => {
  const auth = { Authorization: `Bearer ${token}` };
  const authJson = { ...auth, 'Content-Type': 'application/json' };

  async function listProfiles() {
    const all = [];
    for (let page = 1; ; page++) {
      const r = await api(`${CLOUD}/browser_profiles?limit=50&page=${page}`, { headers: auth });
      all.push(...(r.data || []));
      if (!r.last_page || page >= r.last_page) break;
    }
    return all.map((p) => ({
      id: String(p.id),
      name: p.name || String(p.id),
      proxy: p.proxy && p.proxy.host
        ? { mode: p.proxy.type || 'http', host: p.proxy.host, port: p.proxy.port, username: p.proxy.login || '' }
        : null,
      chromeExtensions: [], // o Dolphin não usa a lista de extensões por API como o GoLogin
    }));
  }

  // Cria um perfil de Windows com fingerprint coerente e, se houver, já com a proxy embutida
  async function createProfile(name, proxy) {
    const body = {
      name, tags: [], platform: 'windows', platformVersion: '10.0.0', browserType: 'anty',
      useragent: { mode: 'manual', value: UA },
      webrtc: { mode: 'altered' }, canvas: { mode: 'real' }, webgl: { mode: 'real' },
      webglInfo: { mode: 'off' },
      timezone: { mode: 'auto' }, locale: { mode: 'auto' }, geolocation: { mode: 'auto' },
      cpu: { mode: 'manual', value: 4 }, memory: { mode: 'manual', value: 8 }, screen: { mode: 'real' },
    };
    if (proxy) body.proxy = toDolphinProxy(proxy);
    const r = await api(`${CLOUD}/browser_profiles`, { method: 'POST', headers: authJson, body: JSON.stringify(body) });
    const id = r && (r.browserProfileId || (r.data && r.data.id) || r.id);
    if (!id) throw new Error(`Dolphin não devolveu o id do perfil: ${JSON.stringify(r).slice(0, 300)}`);
    return { id: String(id), name };
  }

  const deleteProfile = (id) => api(`${CLOUD}/browser_profiles/${id}`, { method: 'DELETE', headers: auth });

  const setProxy = (id, proxy) => api(`${CLOUD}/browser_profiles/${id}`, {
    method: 'PATCH', headers: authJson, body: JSON.stringify({ proxy: toDolphinProxy(proxy) }),
  });

  // o painel também chama estes para as extensões; no Dolphin são no-op
  const addStoreExtension = async () => {};
  const removeStoreExtension = async () => {};

  return { listProfiles, createProfile, deleteProfile, setProxy, addStoreExtension, removeStoreExtension };
};

module.exports.parseProxy = parseProxy;
module.exports.testProxy = testProxy;
