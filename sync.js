// Espelha tudo o que é feito no perfil MÃE para os demais perfis.
// Uso: node sync.js dolphin    (usa config.dolphin.json)
//      node sync.js adspower   (usa config.adspower.json)
//      node sync.js gologin    (usa config.gologin.json)
const fs = require('fs');
const path = require('path');
const { run, connectWs } = require('./core');

const PROVIDERS = {
  dolphin: require('./providers/dolphin'),
  adspower: require('./providers/adspower'),
  gologin: require('./providers/gologin'),
};

async function main() {
  const name = (process.argv[2] || '').toLowerCase();
  if (!PROVIDERS[name]) throw new Error(`informe o navegador: node sync.js ${Object.keys(PROVIDERS).join(' | ')}`);

  const configPath = process.env.SYNC_CONFIG || path.join(__dirname, `config.${name}.json`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const provider = PROVIDERS[name](config);
  const noEmail = process.env.SYNC_NO_EMAIL === '1';
  if (noEmail) console.log('modo sem email: cadastro automático em todos os perfis, sem espelhamento; digite os códigos no painel (aba Códigos). O espelhamento liga em cada perfil depois que ele confirma o código.');
  const stopAll = (all) => Promise.all(all.map((p) => provider.stop(p)));

  // modo de teste: conecta direto em navegadores abertos com --remote-debugging-port
  const opened = config.wsEndpoints && config.wsEndpoints.length
    ? await Promise.all(config.wsEndpoints.map(async (ws, i) => ({ id: `ws${i}`, name: `navegador ${i + 1}`, browser: await connectWs(ws) })))
    : await provider.openAll();

  await run(opened, {
    navDelayMs: config.navSyncDelayMs,
    onExit: config.stopProfilesOnExit || provider.alwaysStopOnExit ? stopAll : null,
    onClosed: provider.alwaysStopOnExit ? (p) => provider.stop(p) : null,
    startUrl: config.startUrl ?? 'https://www.instagram.com/accounts/emailsignup/',
    // "Iniciar sem email" (painel): sempre trava o espelhamento até cada perfil confirmar o código
    mirrorAfterCode: noEmail || config.mirrorAfterCode !== false,
    signup: {
      avl: config.autoClickAvl !== false,
      email: config.fillSignupEmail !== false,
      submit: config.autoSubmitSignup !== false,
    },
    vary: {
      email: config.randomizeEmail !== false,
      username: config.randomizeUsername !== false,
      skipCodes: config.skipVerificationCodes !== false,
    },
  });
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
