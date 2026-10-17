// Lista de emails para o cadastro, compartilhada entre o painel e a sincronização.
// emails.txt: um por linha (o painel grava). emails-usados.txt: os que já foram para algum perfil,
// inclusive aliases, para nunca repetir entre sessões. contas-criadas.csv: o que cada perfil enviou.
const fs = require('fs');
const path = require('path');

const LIST = path.join(__dirname, 'emails.txt');
const USED = path.join(__dirname, 'emails-usados.txt');
const ACCOUNTS = path.join(__dirname, 'contas-criadas.csv');
const CONFIRMED = path.join(__dirname, 'contas-confirmadas.csv'); // só as que validaram o código (OK)

const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [])
  .map((l) => l.trim().toLowerCase()).filter(Boolean);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const randChars = (n) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');

function list() { return [...new Set(readLines(LIST).filter(isEmail))]; }
function used() { return new Set(readLines(USED)); }

// Aceita texto colado ou arquivo: pega tudo que parece email, uma vez cada
function save(text) {
  const emails = [...new Set((String(text).match(/[^\s,;:<>"']+@[^\s,;:<>"']+\.[^\s,;:<>"']+/g) || []).map((e) => e.toLowerCase()))];
  fs.writeFileSync(LIST, emails.join('\n') + (emails.length ? '\n' : ''));
  return emails.length;
}

function stats() {
  const all = list(), u = used();
  const available = all.filter((e) => !u.has(e)).length;
  return { total: all.length, used: all.length - available, available, text: all.join('\n') };
}

function resetUsed() { fs.rmSync(USED, { force: true }); }

// Sempre gera um alias único (nome+abc123@dominio), alternando entre os emails da lista.
// Nunca usa o email base cru: cada perfil recebe um endereço único, para o watcher achar o
// código sem ambiguidade (o Gmail não consegue isolar o base dos aliases numa busca).
// Devolve null se a lista estiver vazia.
let aliasTurn = 0;
function next() {
  const all = list();
  if (!all.length) return null;
  const u = used();
  const [local, domain] = all[aliasTurn++ % all.length].split('@');
  let email;
  do email = `${local.split('+')[0]}+${randChars(6)}@${domain}`; while (u.has(email));
  fs.appendFileSync(USED, email + '\n');
  return { email, alias: true };
}

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const appendRow = (file, profile, data) => {
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'data,perfil,email,usuario,nome,senha\n');
  fs.appendFileSync(file, [new Date().toLocaleString('pt-BR'), profile, data.email, data.username, data.fullName, data.password].map(csv).join(',') + '\n');
};
// contas-criadas.csv: o que cada perfil enviou. contas-confirmadas.csv: as que validaram o código.
function recordAccount(profile, data) { appendRow(ACCOUNTS, profile, data); }
function recordConfirmed(profile, data) { appendRow(CONFIRMED, profile, data); }

// Lê um csv de contas (data,perfil,email,usuario,nome) para o painel, mais novas primeiro.
function readAccounts(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  lines.shift(); // cabeçalho
  return lines.map((l) => {
    const cols = (l.match(/"((?:[^"]|"")*)"/g) || []).map((x) => x.slice(1, -1).replace(/""/g, '"'));
    const [data, perfil, email, usuario, nome, senha] = cols;
    return { data, perfil, email, usuario, nome, senha };
  }).reverse();
}
const confirmed = () => readAccounts(CONFIRMED);
function resetConfirmed() { fs.rmSync(CONFIRMED, { force: true }); }

module.exports = { list, save, stats, resetUsed, next, recordAccount, recordConfirmed, confirmed, resetConfirmed };
