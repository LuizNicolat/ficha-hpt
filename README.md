# Ficha Hpt

App de treino (PWA) que lê o PDF exportado do MFIT e monta a ficha: treinos A–E, séries, cargas, instruções e exercícios combinados. Cada pessoa tem uma conta (nome + PIN) com a própria ficha, cargas, anotações e histórico, sincronizados entre celular e computador.

## Como funciona

- **Conta**: nome + PIN de 4 números, com "lembrar de mim". No primeiro acesso a pessoa recebe uma cópia da ficha base (`docs/treino.json`).
- **Aparelho travado**: o primeiro usuário que entra num aparelho fica dono dele; ali só ele entra. "Conta → Liberar este aparelho" desfaz.
- **Dados de cada um**: cargas usadas, anotações por exercício, histórico e treino em andamento. Ficam no Cloudflare KV, um JSON por pessoa.
- **Offline**: sem internet, tudo é salvo no aparelho e enviado quando a conexão volta. Se dois aparelhos mudarem ao mesmo tempo, o histórico dos dois é somado.
- **Carregar treino**: a pessoa pode trocar a ficha dela pelo PDF dela. A ficha base continua igual para os outros.
- **Ficha base nova**: quando `docs/treino.json` muda, quem segue a ficha base recebe um aviso e escolhe se atualiza.
- **Admin**: login separado, usuário `admin` + senha (secret `ADMIN_SENHA` no Cloudflare). Entra digitando "admin" no nome, pelo link "Entrar como admin" ou abrindo `/#admin`. Não usa a conta de treino nem trava o aparelho. Lá dá pra ver cada usuário (último treino, histórico, anotações), enviar a ficha base ou um PDF para alguém, definir novo PIN, desbloquear, desconectar dos aparelhos e excluir.
- **Vídeos**: cada exercício tem "Ver execução", que mostra um vídeo do YouTube dentro do app. A busca usa a YouTube Data API (secret `YOUTUBE_API_KEY`), primeiro nos canais escolhidos no Admin e, se não achar, no YouTube todo, e roda uma vez por exercício: o resultado fica no KV para todos. No Admin → Vídeos dá pra fixar o vídeo certo de um exercício ou mandar buscar de novo.
- **Segurança do PIN**: guardado com PBKDF2 + salt; 5 erros bloqueiam o usuário por 15 minutos.

## Estrutura

```
parser.js                  parser do PDF (usado pelo app e pelo script)
src/app.html               tela do app (HTML + CSS + JS)
build.mjs                  junta tudo em docs/index.html
gerar-json.mjs             PDF -> docs/treino.json (ficha base)
worker.js                  Cloudflare Worker: serve docs/ e a API (/api/entrar, /api/dados, /api/sair)
wrangler.jsonc             configuração do Worker (pasta do site e ID do KV)
docs/                      o site publicado
.github/workflows/         opcional: gera o treino.json sozinho ao subir treino.pdf
```

## Publicando (Cloudflare Workers + KV)

O projeto no Cloudflare é um Worker conectado a este repo: cada push na `main` publica sozinho, usando o `wrangler.jsonc`.

1. Crie um KV: Storage & Databases → KV → Create namespace (`ficha-hpt`).
2. Copie o ID do namespace e coloque em `wrangler.jsonc`, no campo `id` de `FICHA_KV`.
3. Senha do admin: no Worker → Settings → Variables and Secrets → Add → tipo **Secret**, nome `ADMIN_SENHA`. A senha nunca vai para o repositório.
4. Vídeos: crie uma chave da YouTube Data API v3 no Google Cloud (restrita a essa API) e cadastre como secret `YOUTUBE_API_KEY`.
5. Commit + push.

Para rodar local, crie um `.dev.vars` (fora do git) com `ADMIN_SENHA=alguma-senha`.

## Rodando local

```bash
npm install
npm run build                                   # gera docs/index.html
npm run gerar                                   # treino.pdf -> docs/treino.json
npx wrangler dev                                # site + API em http://localhost:8787
```

Para atualizar a ficha base: rode `npm run gerar` com o PDF novo e commite o `docs/treino.json`. Não commite o PDF (tem nome e fotos).

## Sobre o parser

O PDF do MFIT tem texto real (não é imagem), então o parser usa as posições e as fontes que o pdf.js devolve:

- uma página = um treino; o título (Sup/Inf) vem logo depois do cabeçalho
- nome do exercício = linhas na fonte de título antes de "Séries:" (junta nomes que quebram em 2 linhas)
- "Séries", "Carga" e "Instruções" juntam as linhas de continuação
- "1x 12 + 3x 6 a 8" vira 4 séries; "1x 15,12,8,6" vira 4 séries com reps diferentes
- cargas da ficha são distribuídas por série ("17.5, 22.5, 27.5, 30") ou por bloco ("22, 32.5" para "1x 12 + 3x 6 a 8")
- "Exercícios combinados" agrupa os 2 exercícios seguintes (estende para 3+ quando os cartões têm o mesmo espaçamento)
- conserta a ligadura "ff" que o PDF perde ("Sti pés afastados" → "Stiff pés afastados")

Se o MFIT mudar o layout do PDF, o ajuste fica todo em `parser.js`.
