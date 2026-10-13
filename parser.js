// Parser do PDF exportado pelo MFIT.
// Funciona no navegador e no Node: recebe o objeto `pdfjs` (pdfjs-dist) e os bytes do PDF.
//
// Layout do PDF (uma página por treino):
//   cabeçalho: Nome / "Rotina: X" / objetivo / nível
//   título do treino (fonte grande): "Sup", "Inf"...
//   cartões: nome do exercício (fonte de título) + "Séries: ..." + "Carga: ..." [+ "Instruções: ..."]
//   "Exercícios combinados" / "Alterne esses exercícios" abre um bloco de bi-set.

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Ligaduras que alguns PDFs perdem (glifo vira \u0000) ou mandam como caractere especial.
const LIGADURAS = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', '\u0000': 'ff' };

function limpa(s) {
  return s.replace(/[ﬀ-ﬄ\u0000]/g, (c) => LIGADURAS[c] || '')
    .replace(/[-]/g, '') // ícones (área de uso privado)
    .replace(/\s+/g, ' ')
    .trim();
}

// Agrupa os itens de texto em linhas (mesmo y), ordenados por x, inserindo espaço só onde há folga.
function montaLinhas(items) {
  const linhas = [];
  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5], x = it.transform[4];
    let l = linhas.find((l) => Math.abs(l.y - y) < 2);
    if (!l) linhas.push((l = { y, partes: [] }));
    l.partes.push({ x, w: it.width, s: it.str, fonte: it.fontName, h: it.height });
  }
  linhas.sort((a, b) => b.y - a.y);
  for (const l of linhas) {
    l.partes.sort((a, b) => a.x - b.x);
    let txt = '', fim = null;
    for (const p of l.partes) {
      if (fim !== null && p.x - fim > 1.5 && !txt.endsWith(' ') && !p.s.startsWith(' ')) txt += ' ';
      txt += p.s;
      fim = p.x + p.w;
    }
    l.texto = limpa(txt);
    l.x = l.partes[0].x;
    l.fontes = new Set(l.partes.filter((p) => limpa(p.s)).map((p) => p.fonte));
    l.altura = Math.max(...l.partes.map((p) => p.h));
  }
  return linhas.filter((l) => l.texto);
}

const ROTULO = /^(Séries|Series|Carga|Instruções|Instrucoes)\s*:\s*(.*)$/i;

function parsePagina(linhas) {
  const iRotina = linhas.findIndex((l) => /^Rotina\s*:/i.test(l.texto));
  const cab = {
    aluno: iRotina > 0 ? linhas[iRotina - 1].texto : '',
    rotina: iRotina >= 0 ? linhas[iRotina].texto.replace(/^Rotina\s*:\s*/i, '') : '',
    objetivo: linhas[iRotina + 1]?.texto || '',
    nivel: linhas[iRotina + 2]?.texto || '',
  };
  let corpo = linhas.slice(iRotina + 3);
  const titulo = corpo.shift()?.texto || 'Treino';

  // A fonte dos nomes de exercício é a da linha imediatamente acima do primeiro "Séries:".
  const iSeries = corpo.findIndex((l) => /^S[ée]ries\s*:/i.test(l.texto));
  const fonteNome = iSeries > 0 ? [...corpo[iSeries - 1].fontes][0] : null;
  // Ligaduras ("fi", "ff") às vezes vêm em outra fonte, então basta a primeira parte da linha estar na fonte de nome.
  const ehNome = (l) => fonteNome && l.partes.find((p) => limpa(p.s))?.fonte === fonteNome && !ROTULO.test(l.texto);

  const exercicios = [];
  let atual = null, campo = null;

  const fecha = () => { if (atual) exercicios.push(atual); atual = null; campo = null; };

  for (const l of corpo) {
    if (/^Exerc[íi]cios combinados$/i.test(l.texto)) {
      fecha();
      continue;
    }
    if (/^Alterne esses exerc[íi]cios$/i.test(l.texto)) continue;

    const m = l.texto.match(ROTULO);
    if (m && atual) {
      const k = m[1].toLowerCase();
      campo = k.startsWith('s') ? 'series' : k.startsWith('c') ? 'carga' : 'instrucoes';
      atual[campo] = m[2];
      continue;
    }
    if (ehNome(l)) {
      // Nome que quebrou em duas linhas: ainda não tem "Séries".
      if (atual && !atual.series && campo === null) { atual.nome += ' ' + l.texto; continue; }
      fecha();
      atual = { nome: l.texto, series: '', carga: '', instrucoes: '', y: l.y };
      continue;
    }
    if (atual && campo) atual[campo] = (atual[campo] + ' ' + l.texto).trim(); // continuação de linha
  }
  fecha();
  return { cab, titulo, exercicios };
}

// Bloco "Exercícios combinados": pega os 2 exercícios seguintes e estende enquanto a
// distância entre nomes for a mesma de dentro do bloco (cartões colados no mesmo quadro).
function parsePaginaComGrupos(linhas) {
  const iCombo = linhas.filter((l) => /^Exerc[íi]cios combinados$/i.test(l.texto)).map((l) => l.y);
  const r = parsePagina(linhas);
  iCombo.forEach((yCombo, gi) => {
    const id = 'g' + (gi + 1);
    const depois = r.exercicios.filter((e) => e.y < yCombo);
    if (depois.length < 2) { depois.forEach((e) => (e.grupo = id)); return; }
    const passo = depois[0].y - depois[1].y;
    const membros = [depois[0], depois[1]];
    for (let i = 2; i < depois.length; i++) {
      const p = depois[i - 1].y - depois[i].y;
      if (Math.abs(p - passo) < 0.8) membros.push(depois[i]); else break;
    }
    membros.forEach((e) => (e.grupo = id));
  });
  return r;
}

// "1x 12 + 3x 6 a 8" -> [{reps:'12'}, {reps:'6 a 8'} x3]; "1x 15,12,8,6" -> 4 séries
export function expandeSeries(series, carga) {
  const partes = series.split(/\+|,(?=\s*\d+\s*x)/i).map((s) => s.trim()).filter(Boolean);
  const sets = [];
  const porParte = [];
  for (const p of partes) {
    const m = p.match(/^(\d+)\s*x\s*(.*)$/i);
    const ini = sets.length;
    if (!m) sets.push({ reps: p });
    else {
      const n = +m[1];
      // "12 com 2 segundos de pico de contração" -> "12" (o texto completo continua em `series`)
      const resto = m[2].trim().replace(/\s+com\s.*$/i, '');
      const lista = resto.match(/^(\d+(?:\s*,\s*\d+)+)(.*)$/);
      if (n === 1 && lista) lista[1].split(',').forEach((r) => sets.push({ reps: r.trim() }));
      else for (let i = 0; i < Math.min(n, 12); i++) sets.push({ reps: resto || '—' });
    }
    porParte.push([ini, sets.length]);
  }
  if (!sets.length) sets.push({ reps: series || '—' });

  // Cargas sugeridas: uma por série, ou uma por parte ("22, 32.5" para "1x 12 + 3x 6 a 8").
  const cargas = carga.replace(/kg/gi, '').split(',').map((c) => c.trim()).filter(Boolean);
  const num = (c) => (/^\d+(\.\d+)?$/.test(c) && +c > 0 ? c : '');
  if (cargas.length === sets.length) sets.forEach((s, i) => (s.carga = num(cargas[i])));
  else if (cargas.length === porParte.length) porParte.forEach(([a, b], i) => { for (let k = a; k < b; k++) sets[k].carga = num(cargas[i]); });
  else if (cargas.length === 1) sets.forEach((s) => (s.carga = num(cargas[0])));
  // Menos cargas que séries ("45,50" em 3 séries): segue em ordem e repete a última.
  else sets.forEach((s, i) => (s.carga = num(cargas[Math.min(i, cargas.length - 1)] || '')));
  return sets;
}

export async function parseMfitPdf(pdfjs, bytes) {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const treinos = [];
  let cab = null;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const linhas = montaLinhas(tc.items);
    if (!linhas.some((l) => /^S[ée]ries\s*:/i.test(l.texto))) continue;
    const r = parsePaginaComGrupos(linhas);
    cab = cab || r.cab;
    const letra = LETRAS[treinos.length] || String(treinos.length + 1);
    treinos.push({
      id: letra,
      titulo: r.titulo.charAt(0).toUpperCase() + r.titulo.slice(1),
      exercicios: r.exercicios.map((e, i) => ({
        id: `${letra}${i + 1}`,
        nome: e.nome,
        series: e.series,
        carga: e.carga,
        instrucoes: e.instrucoes || '',
        grupo: e.grupo ? `${letra}-${e.grupo}` : null,
        sets: expandeSeries(e.series, e.carga),
      })),
    });
  }
  if (!treinos.length) throw new Error('Não encontrei exercícios nesse PDF. É o PDF exportado do MFIT?');
  return { versao: 1, importadoEm: new Date().toISOString(), ...cab, treinos };
}
