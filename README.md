# Sincronizador de perfis (Dolphin Anty / AdsPower / GoLogin)

Define um **perfil mãe** e repete nos outros perfis tudo o que você faz nele.
Funciona com Dolphin Anty, AdsPower ou GoLogin; o espelhamento é o mesmo nos três.

## O que é espelhado
- Links e URLs acessados (inclusive os digitados na barra de endereço)
- Cliques (esquerdo, duplo e do meio)
- Texto digitado em campos (inputs, textareas e editores `contenteditable`)
- Seleção em `<select>`
- Teclas Enter, Tab, Esc e setas
- Scroll da página e de elementos roláveis (em proporção, então funciona com janelas de tamanhos diferentes)
- Abrir, fechar e trocar de aba

## Instalação
Node.js 18 ou mais novo, e depois `npm install`.

## Dolphin Anty — `npm run dolphin`
Requer um plano com API (o **Starter**, o mais barato, já inclui a Local API) e o app do Dolphin aberto e logado.

1. Gere um token de API no painel do Dolphin e cole em `config.dolphin.json`, no campo `token`.
2. **Feche os perfis no Dolphin** antes de rodar. O script abre todos em modo de automação.

### Painel com o Dolphin
O painel (`npm run painel`) também funciona com o Dolphin. Use o seletor **Navegador** no topo do
painel para alternar entre GoLogin e Dolphin na hora (ele grava em `config.painel.json`; não dá para
trocar com a sincronização rodando). No Dolphin dá para **criar perfis com proxies** (uma por linha,
cada uma vira um perfil novo, já com a proxy), escolher a mãe, trocar proxy, excluir, usar a aba
Códigos com o watcher, e carregar **extensões próprias** (seção "Própria": a pasta `extensions/` é
injetada em todos os perfis no start, via `--load-extension` no campo de argumentos do perfil).
A extensão da **Chrome Web Store** por API, por enquanto, é só no GoLogin; no Dolphin, adicione as da
loja pelo próprio app. Para desligar o carregamento das extensões próprias, ponha
`"loadLocalExtensions": false` em `config.dolphin.json`.

## AdsPower — `npm run adspower`
Requer o app do AdsPower aberto e logado.

Por padrão (`"useActive": true`) o script **se conecta nos perfis que já estão abertos** no AdsPower.
Abra os perfis que quiser sincronizar e rode. A mãe é o perfil aberto de menor número (coluna "No."
no AdsPower), ou o que estiver em `masterId`.

Com `"useActive": false`, o script abre ele mesmo os perfis da conta (ou os de `profileIds` / `groupId`).

Se a API local estiver com verificação de chave ligada (Configurações → API), cole a chave em `apiKey`.

## GoLogin — `npm run gologin`
Requer plano pago ou o teste de 7 dias com acesso à API. Não precisa do app do GoLogin aberto.

1. No GoLogin, gere um token em Configurações → API e cole em `config.gologin.json`, no campo `token`.
2. **Feche os perfis no app do GoLogin** antes de rodar. O script abre os perfis com o navegador
   do GoLogin (Orbita), que ele baixa sozinho na primeira vez.
3. **Para sair, use `q` ou Ctrl+C no terminal, ou feche a janela da mãe.** O GoLogin guarda os perfis
   na nuvem, e o script envia cookies e logins de volta ao fechar. Se o processo for morto à força,
   o que foi feito na sessão pode se perder.

Sem `masterId`, a mãe é o perfil criado primeiro.

### Painel do GoLogin — `npm run painel`
Abre `http://localhost:3333` no navegador. Por ele dá para:
- **Criar perfis com proxies:** cole uma proxy por linha e cada linha vira um perfil. As proxies são
  testadas antes, e o resultado mostra o IP e a cidade de cada uma.
- **Escolher a mãe**, trocar a proxy de um perfil ou excluir perfis.
- **Extensões em todos os perfis:**
  - *Chrome Web Store:* cole o link da extensão. Ela fica salva em cada perfil e também entra nos
    perfis criados depois pelo painel.
  - *Própria:* clique em "Escolher pasta…" e selecione a pasta da extensão (a que tem o `manifest.json`).
    Ela é copiada para `extensions/` e carregada em todos os perfis quando abertos pela sincronização.
    Também dá para copiar a pasta direto em `extensions/`, e `.zip`/`.crx` continuam aceitos.
- **Cadastro no Instagram:** cole ou carregue (`.txt`/`.csv`) uma lista de emails. Na página de cadastro,
  cada perfil (mãe e seguidores) clica no AVL, preenche um email da lista que ainda não foi usado e envia
  o formulário. Quando a lista acaba, usa alias dos emails dela (`nome+abc123@gmail.com`).
  - Os emails ficam em `emails.txt`; os já usados, em `emails-usados.txt` (não repetem entre sessões;
    "Zerar usados" libera de novo).
  - O que cada perfil enviou (email, usuário, nome) fica em `contas-criadas.csv`.
  - Cada etapa (AVL, email, enviar) pode ser desligada nas caixas da seção.
- **Aba Códigos:** quando um perfil chega na tela do código de confirmação, ele aparece nessa aba com o
  email usado (o número na aba e no título da página mostra quantos estão esperando). Digite o código e
  aperte Enter: o perfil preenche e confirma sozinho, e o cursor pula para o próximo perfil. O perfil sai
  da lista quando passa da tela do código; se o código estiver errado, ele continua lá para tentar de novo.
  Sem o painel, dá para mandar pelo terminal: `code <id do perfil> <código>`.
- **Iniciar, pausar e parar a sincronização** e ver o log.
- **Iniciar sem email:** faz o cadastro automático em todas as contas, sem espelhamento e sem o
  watcher/código do email. Você digita os códigos na aba **Códigos**; cada perfil entra no espelhamento
  depois que ele (e a mãe) confirmam o código.
- **Randomizador**, para criar contas sem repetir dados:
  - *Email:* cada seguidor recebe o email da mãe com um sufixo, por exemplo `joao+k3x9a@gmail.com`.
    No Gmail e no Outlook tudo cai na mesma caixa de entrada.
  - *Usuário:* campos de nome de usuário ganham um sufixo, por exemplo `joaosilva_x7k2`.
  - *Códigos de verificação* não são copiados: cada conta recebe o seu, e você digita em cada perfil.
  - O botão "Novos valores aleatórios" gera sufixos novos para a próxima leva de contas. Os valores
    usados por cada perfil aparecem no log.

### Watcher de códigos (preenche sozinho) — `npm run watcher`
Lê os códigos de confirmação que chegam no Gmail **já logado** no seu Chrome e preenche sozinho o
perfil que está esperando na aba **Códigos** — sem você digitar nada. Ele procura em **todas as
contas de Gmail logadas** naquela janela (`/u/0`, `/u/1`, …), então pode deixar várias; cada email
é casado com o perfil certo pelo endereço no campo "Para:" (inclusive aliases `nome+abc123@...`).
Se não achar o código de um perfil, mostra "não encontrei ainda" e segue tentando.

1. Ajuste `config.watcher.json` se precisar (caminho do Chrome, porta). `userDataDir` em branco
   usa uma pasta própria do watcher (`chrome-watcher-data/`), que **coexiste com o seu Chrome do
   dia a dia** — você loga as contas uma vez e elas ficam salvas. Para reaproveitar os logins do
   seu Chrome normal, aponte `userDataDir` para a sua pasta real do Chrome; nesse caso o Chrome
   normal precisa estar fechado enquanto o watcher roda.
2. Dê um duplo clique em **`abrir-chrome-watcher.bat`** (ou `npm run chrome-watcher`). Ele abre o
   Chrome em modo depuração já no Gmail. Deixe logadas as contas que recebem os códigos e mantenha
   a janela aberta (pode minimizar).
3. Com o painel (`npm run painel`) e a sincronização rodando, rode **`npm run watcher`**.
   A cada poucos segundos ele checa quais perfis esperam código e manda o que achar no Gmail.

Na aba **Códigos** aparece **● watcher ligado** quando ele está rodando, e ao lado de cada perfil o
que ele achou (ou "não encontrei ainda"). Ele só envia pelo mesmo caminho do painel: se o código
estiver errado, o perfil continua na lista e ele não repete o mesmo código. Fechar a janela do
terminal encerra o watcher.

As janelas abrem lado a lado, uma coluna por perfil (`"tileWindows": false` desliga isso).

O painel só aceita conexões do próprio computador, já que ele usa o seu token.

## Opções do config
| campo | o que faz |
|---|---|
| `masterId` | força qual perfil é a mãe |
| `profileIds` | lista de IDs a usar, na ordem; o primeiro é a mãe. Vazio = todos |
| `nameFilter` | usa só perfis cujo nome contém esse texto |
| `maxProfiles` | limita a quantidade de perfis (0 = sem limite) |
| `groupId` | (AdsPower) usa só perfis desse grupo |
| `navSyncDelayMs` | espera antes de igualar a URL dos seguidores (padrão 1000) |
| `startDelayMs` | intervalo entre abrir um perfil e outro |
| `stopProfilesOnExit` | fecha os perfis ao sair do script (no GoLogin é sempre) |
| `startUrl` | página que todos os perfis abrem ao iniciar (padrão: cadastro do Instagram; `""` não navega) |
| `mirrorAfterCode` | o espelhamento começa desligado; cada perfil entra nele depois que ele e a mãe confirmam o código do cadastro (padrão `true`; o botão "Espelhar já" / comando `e` liga para todos na hora) |
| `autoClickAvl` | no cadastro do Instagram, clica sozinho no botão "⚡ AVL" da extensão em todos os perfis (padrão `true`) |
| `fillSignupEmail` | no cadastro, preenche o email com um da lista do painel, um por perfil (padrão `true`) |
| `autoSubmitSignup` | no cadastro, clica no botão de enviar depois de preencher tudo (padrão `true`) |

No AdsPower o ID do perfil é o `user_id` (ex.: `jabc123`), que aparece na lista de perfis.

## Comandos no terminal
`p` pausa/retoma, `s` força todas as abas a ficarem na mesma URL da mãe, `q` sai.

## Limitações
- Cliques dentro de iframes (captchas, logins embutidos, alguns players) não são replicados.
- O clique é localizado pelo seletor CSS do elemento. Se a página for diferente entre os perfis
  (idioma, layout A/B, anúncios), ele tenta achar pelo texto e, em último caso, clica na mesma posição da tela.
- Upload de arquivo, menu do botão direito e janelas nativas do navegador não são replicados.
- Atalhos de teclado (Ctrl+C, Ctrl+V etc.) não são replicados, só o texto que acaba no campo.
