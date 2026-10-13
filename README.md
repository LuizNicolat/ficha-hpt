# Ficha Hpt

App de treino (PWA) que lê o PDF exportado do MFIT e monta a ficha: treinos A–E, séries, cargas, instruções e exercícios combinados. Tudo fica salvo no aparelho (localStorage), sem servidor.

## Como funciona

- **Carregar treino**: escolhe o PDF do MFIT, o app lê no próprio navegador (pdf.js) e mostra um resumo antes de substituir a ficha.
- **Durante o treino**: cada série tem o alvo de reps, a carga (pré-preenchida com a última que você usou, ou a da ficha) e um botão de concluir. Concluir dispara o descanso (60/90/120/180 s).
- **Histórico**: cada treino finalizado fica salvo com as cargas por série.
- **Ficha compartilhada**: se existir `docs/treino.json` no repo, quem abrir o app sem ficha recebe essa automaticamente. Quando o JSON muda, o app avisa e pergunta se quer atualizar. Histórico e cargas de cada pessoa ficam no celular dela.

## Estrutura

```
parser.js              parser do PDF (usado pelo app e pelo script)
src/app.html           tela do app (HTML + CSS + JS)
build.mjs              junta tudo em docs/index.html
gerar-json.mjs         PDF -> docs/treino.json (linha de comando)
docs/                  o que vai pro GitHub Pages
.github/workflows/     opcional: gera o treino.json sozinho ao subir treino.pdf
```

## Rodando

```bash
npm install
npm run build                      # gera docs/index.html
npm run gerar                      # treino.pdf -> docs/treino.json
npx serve docs                     # testar local
```

## Publicando no GitHub Pages

1. Suba o repo.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, pasta `/docs`.
3. Mande o link pros amigos e peça pra "Adicionar à tela inicial".

Para atualizar a ficha: rode `npm run gerar` com o PDF novo e commite o `docs/treino.json`.
Ou suba o `treino.pdf` na raiz e deixe a Action gerar o JSON. Atenção: com repo público, o PDF (com nome e fotos) fica visível. Se preferir, gere o JSON local e não commite o PDF.

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
