const { connectWs, log, sleep } = require('../core');

// Aplica profileIds / nameFilter / masterId / maxProfiles sobre a lista [{ id, name }].
// O primeiro item do resultado é a mãe.
function pickProfiles(list, config) {
  if (config.profileIds && config.profileIds.length) {
    const byId = new Map(list.map((p) => [p.id, p]));
    list = config.profileIds.map((id) => byId.get(String(id)) || { id: String(id), name: String(id) });
  }
  if (config.nameFilter) {
    const f = config.nameFilter.toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(f));
  }
  if (config.masterId) {
    const i = list.findIndex((p) => p.id === String(config.masterId));
    if (i < 0) list.unshift({ id: String(config.masterId), name: String(config.masterId) });
    else list.unshift(...list.splice(i, 1));
  }
  if (config.maxProfiles > 0) list = list.slice(0, config.maxProfiles);
  return list;
}

// Abre cada perfil com start(id) -> wsEndpoint e conecta. Falha só se a mãe não abrir.
// onOpen(entry) (opcional) roda logo após conectar cada perfil (ex.: carregar extensões via CDP).
async function openSequential(profiles, start, startDelayMs, onOpen) {
  if (profiles.length < 1) throw new Error('nenhum perfil encontrado para abrir');
  log(`${profiles.length} perfil(is). Mãe: ${profiles[0].name} (${profiles[0].id})${profiles.length < 2 ? ' (sozinha, sem espelhamento)' : ''}`);
  const opened = [];
  for (const p of profiles) {
    try {
      const entry = { ...p, browser: await connectWs(await start(p.id)) };
      if (onOpen) { try { await onOpen(entry); } catch (e) { log(`${p.name}: ${e.message.split('\n')[0]}`); } }
      opened.push(entry);
      log(`aberto: ${p.name}`);
    } catch (e) {
      log(`falha ao abrir ${p.name}: ${e.message.split('\n')[0]}`);
      if (p === profiles[0]) throw new Error('não foi possível abrir o perfil mãe');
    }
    await sleep(startDelayMs);
  }
  return opened;
}

module.exports = { pickProfiles, openSequential };
