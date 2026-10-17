// Conexão com o GoLogin, usando o pacote oficial "gologin": ele baixa o perfil da nuvem,
// abre o navegador Orbita localmente e, ao parar, envia o perfil (cookies, logins) de volta.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { api, log } = require('../core');
const { pickProfiles, openSequential } = require('./common');

const API = 'https://api.gologin.com';

module.exports = (config) => {
  const sessions = new Map(); // id do perfil -> instância GoLogin

  async function listProfiles() {
    const all = [];
    for (let page = 1; page < 100; page++) {
      const r = await api(`${API}/browser/v2?page=${page}`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      const list = r.profiles || [];
      all.push(...list);
      if (!list.length || all.length >= (r.allProfilesCount || 0)) break;
    }
    // do mais antigo para o mais novo, para o "primeiro" ser o primeiro criado
    return all
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .map((p) => ({ id: String(p.id), name: p.name || String(p.id) }));
  }

  // Extensões próprias: cada subpasta de extensions/ com manifest.json é carregada em todos os perfis
  function localExtensionArgs() {
    const dir = path.resolve(__dirname, '..', config.extensionsDir || 'extensions');
    if (!fs.existsSync(dir)) return [];
    const exts = fs.readdirSync(dir)
      .map((d) => path.join(dir, d))
      .filter((d) => fs.existsSync(path.join(d, 'manifest.json')));
    return exts.length ? [`--load-extension=${exts.join(',')}`] : [];
  }

  // Impede o navegador de "congelar" janelas que estão atrás de outras (sem isso os
  // cliques nos seguidores podem nunca ser processados)
  const NO_THROTTLE = [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ];

  // Divide a tela em colunas, uma janela por perfil, em vez de todas empilhadas em 0,0
  let screen = null;
  function screenSize() {
    if (screen) return screen;
    screen = { width: 1920, height: 1040 };
    if (process.platform !== 'win32') return screen;
    try {
      const out = execSync('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; Write-Output ($a.Width.ToString() + \'x\' + $a.Height)"', { encoding: 'utf8', timeout: 15000 });
      const m = out.trim().match(/(\d+)x(\d+)/);
      if (m) screen = { width: Number(m[1]), height: Number(m[2]) };
    } catch {}
    return screen;
  }

  let windowIndex = 0;
  function windowArgs() {
    if (config.tileWindows === false) return [];
    const total = Math.max(1, config.windowColumns || plannedCount || 1);
    const { width, height } = screenSize();
    const w = Math.floor(width / total);
    const i = windowIndex++ % total;
    return [`--window-position=${i * w},0`, `--window-size=${w},${height}`];
  }
  let plannedCount = 0;

  async function start(id) {
    const { GoLogin } = await import('gologin');
    const gl = new GoLogin({
      token: config.token,
      profile_id: id,
      extra_params: [...localExtensionArgs(), ...NO_THROTTLE, ...windowArgs()],
      ...(config.tmpdir ? { tmpdir: config.tmpdir } : {}),
    });
    const r = await gl.start();
    if (!r || !r.wsUrl) throw new Error(`GoLogin não devolveu o endereço do navegador: ${JSON.stringify(r).slice(0, 300)}`);
    sessions.set(id, gl);
    return r.wsUrl;
  }

  // Fecha o navegador de forma limpa e salva o perfil na nuvem do GoLogin
  async function stop(p) {
    const gl = sessions.get(p.id);
    if (!gl) return;
    sessions.delete(p.id);
    log(`salvando ${p.name}...`);
    try { await p.browser.close(); } catch {}
    await gl.stop();
  }

  return {
    // sem isso o GoLogin não salva cookies e logins feitos durante a sessão
    alwaysStopOnExit: true,

    async openAll() {
      if (!config.token || config.token.startsWith('COLE')) throw new Error('coloque seu token da API do GoLogin no config.gologin.json');
      const profiles = pickProfiles(await listProfiles(), config);
      plannedCount = profiles.length;
      return openSequential(profiles, start, config.startDelayMs ?? 1500);
    },

    stop,
  };
};
