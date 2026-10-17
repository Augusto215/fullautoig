// Conexão com o Dolphin Anty (API local + API em nuvem para listar perfis).
const fs = require('fs');
const path = require('path');
const { api, log } = require('../core');
const { pickProfiles, openSequential } = require('./common');

const CLOUD = 'https://dolphin-anty-api.com';

module.exports = (config) => {
  const LOCAL = (config.localApi || 'http://localhost:3001/v1.0').replace(/\/$/, '');

  // Extensões próprias: cada subpasta de extensions/ com manifest.json entra em todos os perfis.
  // O Dolphin adiciona o --load-extension dele DEPOIS do nosso e o Chrome só respeita o último,
  // então o campo "args" não resolve. Em vez disso carregamos cada extensão via CDP
  // (Extensions.loadUnpacked) logo após conectar — convive com a extensão interna do Dolphin.
  function localExtDirs() {
    const dir = path.resolve(__dirname, '..', config.extensionsDir || 'extensions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((d) => path.join(dir, d)).filter((d) => fs.existsSync(path.join(d, 'manifest.json')));
  }
  async function loadExtensions(browser) {
    if (config.loadLocalExtensions === false) return;
    const dirs = localExtDirs();
    if (!dirs.length) return;
    const sess = await browser.target().createCDPSession();
    for (const dir of dirs) {
      try { await sess.send('Extensions.loadUnpacked', { path: dir }); log(`extensão carregada: ${path.basename(dir)}`); }
      catch (e) { log(`não consegui carregar a extensão ${path.basename(dir)}: ${e.message.split('\n')[0]}`); }
    }
    await sess.detach().catch(() => {});
  }

  async function listProfiles() {
    const all = [];
    for (let page = 1; ; page++) {
      const r = await api(`${CLOUD}/browser_profiles?limit=50&page=${page}`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      all.push(...(r.data || []));
      if (!r.last_page || page >= r.last_page) break;
    }
    return all.map((p) => ({ id: String(p.id), name: p.name || String(p.id) }));
  }

  async function start(id) {
    const r = await api(`${LOCAL}/browser_profiles/${id}/start?automation=1`);
    const a = r.automation;
    if (!a || !a.wsEndpoint) throw new Error(`resposta sem automation: ${JSON.stringify(r).slice(0, 300)}`);
    return `ws://127.0.0.1:${a.port}${a.wsEndpoint.startsWith('/') ? '' : '/'}${a.wsEndpoint}`;
  }

  return {
    async openAll() {
      if (!config.token || config.token.startsWith('COLE')) throw new Error('coloque seu token da API do Dolphin no config.dolphin.json');
      await api(`${LOCAL}/auth/login-with-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: config.token }),
      });
      const profiles = pickProfiles(await listProfiles(), config);
      return openSequential(profiles, start, config.startDelayMs ?? 1500, (entry) => loadExtensions(entry.browser));
    },

    async stop(p) {
      await api(`${LOCAL}/browser_profiles/${p.id}/stop`).catch(() => {});
    },
  };
};
