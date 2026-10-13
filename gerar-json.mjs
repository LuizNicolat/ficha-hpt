// Uso: node gerar-json.mjs treino.pdf [saida.json]
// Gera o treino.json que o app carrega automaticamente quando hospedado no GitHub Pages.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import { parseMfitPdf } from './parser.js';

const [, , entrada, saida = 'treino.json'] = process.argv;
if (!entrada) {
  console.error('Uso: node gerar-json.mjs treino.pdf [saida.json]');
  process.exit(1);
}
const dados = await parseMfitPdf(pdfjs, new Uint8Array(fs.readFileSync(entrada)));
fs.writeFileSync(saida, JSON.stringify(dados, null, 2));
for (const t of dados.treinos) console.log(`Treino ${t.id} (${t.titulo}): ${t.exercicios.length} exercícios`);
