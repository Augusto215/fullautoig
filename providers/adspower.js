// Conexão com o AdsPower (API local, roda junto com o app do AdsPower).
const { api, connectWs, log, sleep } = require('../core');
const { pickProfiles, openSequential } = require('./common');

module.exports = (config) => {
  const BASE = (config.localApi || 'http://local.adspower.net:50325').replace(/\/$/, '');
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};

  // A API local do AdsPower aceita ~1 requisição por segundo
  let lastCall = 0;
  async function ads(pathAndQuery) {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await api(BASE + pathAndQuery, { headers });
    if (process.env.SYNC_DEBUG) log('AdsPower', pathAndQuery, JSON.stringify(r).slice(0, 500));
    if (r.code !== 0) throw new Error(`AdsPower ${pathAndQuery.split('?')[0]}: ${r.msg}`);
    return r.data;
  }

  // Todos os perfis, do mais antigo para o mais novo (o "primeiro" é o de menor número)
  async function listProfiles() {
    const all = [];
    const group = config.groupId ? `&group_id=${encodeURIComponent(config.groupId)}` : '';
    for (let page = 1; ; page++) {
      const d = await ads(`/api/v1/user/list?page=${page}&page_size=100${group}`);
      const list = d.list || [];
      all.push(...list);
      if (list.length < 100) break;
    }
    return all
      .map((p) => ({ id: String(p.user_id), name: p.name || `#${p.serial_number}`, serial: Number(p.serial_number) || 0 }))
      .sort((a, b) => a.serial - b.serial);
  }

  async function start(id) {
    const d = await ads(`/api/v1/browser/start?user_id=${encodeURIComponent(id)}`);
    if (!d.ws || !d.ws.puppeteer) throw new Error(`resposta sem ws: ${JSON.stringify(d).slice(0, 300)}`);
    return d.ws.puppeteer;
  }

  // Conecta nos perfis que já estão abertos no AdsPower
  async function attachActive() {
    const active = (await ads('/api/v1/browser/local-active')).list || [];
    const wsById = new Map(active.filter((a) => a.ws && a.ws.puppeteer).map((a) => [String(a.user_id), a.ws.puppeteer]));
    if (wsById.size < 2) throw new Error(`são necessários pelo menos 2 perfis abertos no AdsPower, encontrados: ${wsById.size}`);

    // no plano grátis a listagem de perfis é bloqueada; nesse caso a ordem é a do AdsPower
    // e a mãe deve ser definida em masterId
    const known = await listProfiles().catch((e) => {
      log(`não foi possível listar os perfis (${e.message}). Use "masterId" no config para escolher a mãe.`);
      return active
        .map((a) => ({ id: String(a.user_id), name: a.name || String(a.user_id), serial: Number(a.serial_number) || 0 }))
        .sort((a, b) => a.serial - b.serial);
    });
    const ordered = [
      ...known.filter((p) => wsById.has(p.id)),
      ...[...wsById.keys()].filter((id) => !known.some((p) => p.id === id)).map((id) => ({ id, name: id })),
    ];
    const profiles = pickProfiles(ordered, config).filter((p) => wsById.has(p.id));
    if (profiles.length < 2) throw new Error('menos de 2 perfis abertos depois dos filtros do config');
    log(`${profiles.length} perfis abertos. Mãe: ${profiles[0].name} (${profiles[0].id})`);

    const opened = [];
    for (const p of profiles) {
      try {
        opened.push({ ...p, browser: await connectWs(wsById.get(p.id)) });
      } catch (e) {
        log(`falha ao conectar em ${p.name}: ${e.message.split('\n')[0]}`);
        if (p === profiles[0]) throw new Error('não foi possível conectar no perfil mãe');
      }
    }
    return opened;
  }

  return {
    async openAll() {
      if (config.useActive !== false) return attachActive();
      const profiles = pickProfiles(await listProfiles(), config);
      return openSequential(profiles, start, config.startDelayMs ?? 1500);
    },

    async stop(p) {
      await ads(`/api/v1/browser/stop?user_id=${encodeURIComponent(p.id)}`).catch(() => {});
    },
  };
};
