// Ficha Hpt — Cloudflare Worker: serve o site (pasta docs/) e a API em /api/* com KV (binding FICHA_KV)
//
// POST /api/entrar   { nome, pin, lembrar, criar }  -> { token, nome, slug, rev, dados }
// GET  /api/dados                                     -> { rev, dados }
// PUT  /api/dados    { rev, dados }                   -> { rev }  (409 + versão do servidor se rev estiver velho)
// POST /api/sair
//
// Admin: login próprio (usuário "admin" + senha do secret ADMIN_SENHA no Cloudflare):
// POST   /api/admin/entrar                   { senha, lembrar } -> { token }
// GET    /api/admin/usuarios                 lista com resumo
// GET    /api/admin/usuarios/<slug>          dados completos
// POST   /api/admin/usuarios/<slug>/pin      { pin }  novo PIN (desconecta os aparelhos)
// POST   /api/admin/usuarios/<slug>/desbloquear
// POST   /api/admin/usuarios/<slug>/desconectar
// PUT    /api/admin/usuarios/<slug>/ficha    { ficha }  troca a ficha da pessoa
// DELETE /api/admin/usuarios/<slug>
//
// Vídeos (YouTube Data API, chave no secret YOUTUBE_API_KEY):
// GET    /api/video?nome=<exercício>         vídeos do exercício (busca uma vez e guarda; canais opcionais)
// GET    /api/admin/videos                   canais + tudo que já foi buscado
// PUT    /api/admin/canais     { entradas }  canais opcionais (@handle, link ou id); lista vazia = YouTube todo
// PUT    /api/admin/video      { nome, url } fixa um vídeo para o exercício (url vazia desfaz)
// DELETE /api/admin/video?nome=...           apaga a busca guardada (busca de novo na próxima vez)
//
// Chaves no KV:
//   u:<slug>   { nome, salt, hash, criadoEm }          usuário
//   d:<slug>   { rev, dados, atualizadoEm }            o "JSON" de cada pessoa
//   s:<token>  <slug>                                  sessão (expira)
//   t:<slug>   <n>                                     tentativas de PIN erradas (expira em 15 min)
//   cfg:canais [{ id, nome, handle }]                  canais do YouTube usados na busca
//   v:<nome>   { nome, videos, fixo, buscadoEm }       vídeos de cada exercício

const MAX_TENTATIVAS = 5;
const DIA = 86400;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const aleatorio = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

const slugify = (nome) =>
  nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function hashPin(pin, salt) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 },
    chave, 256);
  return hex(bits);
}

function iguais(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function lerCorpo(request) {
  try { return await request.json(); } catch { return null; }
}

// A sessão do admin é guardada como "@admin", um slug que nenhum nome de usuário consegue gerar.
const ADMIN = '@admin';
const sha = async (txt) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt)));

async function entrarAdmin(request, kv, env) {
  if (!env.ADMIN_SENHA) return json({ erro: 'config', mensagem: 'A senha do admin ainda não foi cadastrada no Cloudflare (secret ADMIN_SENHA).' }, 500);
  const corpo = await lerCorpo(request);
  const tentativas = Number(await kv.get(`t:${ADMIN}`)) || 0;
  if (tentativas >= MAX_TENTATIVAS) return json({ erro: 'bloqueado', mensagem: 'Muitas tentativas erradas. Tente de novo em 15 minutos.' }, 429);
  if (!iguais(await sha(String(corpo?.senha || '')), await sha(env.ADMIN_SENHA))) {
    const n = tentativas + 1;
    await kv.put(`t:${ADMIN}`, String(n), { expirationTtl: 15 * 60 });
    const restam = MAX_TENTATIVAS - n;
    return json({ erro: 'senha', mensagem: restam > 0 ? `Senha errada. ${restam === 1 ? 'Resta 1 tentativa' : `Restam ${restam} tentativas`}.` : 'Muitas tentativas erradas. Tente de novo em 15 minutos.' }, restam > 0 ? 401 : 429);
  }
  if (tentativas) await kv.delete(`t:${ADMIN}`);
  const token = aleatorio(32);
  await kv.put(`s:${token}`, ADMIN, { expirationTtl: corpo?.lembrar ? 30 * DIA : DIA / 2, metadata: { slug: ADMIN } });
  return json({ token });
}

async function usuarioDaSessao(request, kv) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  return kv.get(`s:${m[1]}`);
}

async function entrar(request, kv, env) {
  const corpo = await lerCorpo(request);
  const nome = String(corpo?.nome || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const pin = String(corpo?.pin || '');
  const slug = slugify(nome);
  if (!slug) return json({ erro: 'nome', mensagem: 'Digite seu nome.' }, 400);
  if (slug === 'admin') return json({ erro: 'admin', mensagem: 'Para entrar como admin, use a senha do admin.' }, 400);
  if (!/^\d{4}$/.test(pin)) return json({ erro: 'pin', mensagem: 'O PIN tem 4 números.' }, 400);

  const tentativas = Number(await kv.get(`t:${slug}`)) || 0;
  if (tentativas >= MAX_TENTATIVAS)
    return json({ erro: 'bloqueado', mensagem: 'Muitas tentativas erradas. Tente de novo em 15 minutos.' }, 429);

  let usuario = await kv.get(`u:${slug}`, 'json');
  if (!usuario) {
    if (!corpo.criar) return json({ erro: 'nao-existe', mensagem: `Ninguém se chama "${nome}" por aqui ainda.` }, 404);
    const salt = aleatorio(16);
    usuario = { nome, salt, hash: await hashPin(pin, salt), criadoEm: new Date().toISOString() };
    await kv.put(`u:${slug}`, JSON.stringify(usuario));
    await kv.put(`d:${slug}`, JSON.stringify({ rev: 0, dados: null, atualizadoEm: usuario.criadoEm }));
  } else if (!iguais(await hashPin(pin, usuario.salt), usuario.hash)) {
    const n = tentativas + 1;
    await kv.put(`t:${slug}`, String(n), { expirationTtl: 15 * 60 });
    const restam = MAX_TENTATIVAS - n;
    return json({
      erro: restam > 0 ? 'pin-errado' : 'bloqueado',
      mensagem: restam > 0 ? `PIN errado. ${restam === 1 ? 'Resta 1 tentativa' : `Restam ${restam} tentativas`}.` : 'Muitas tentativas erradas. Tente de novo em 15 minutos.',
    }, restam > 0 ? 401 : 429);
  }

  if (tentativas) await kv.delete(`t:${slug}`);
  const token = aleatorio(32);
  await kv.put(`s:${token}`, slug, { expirationTtl: corpo.lembrar ? 365 * DIA : DIA, metadata: { slug } });
  const registro = (await kv.get(`d:${slug}`, 'json')) || { rev: 0, dados: null };
  return json({ token, nome: usuario.nome, slug, rev: registro.rev, dados: registro.dados });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url.pathname.slice(5).replace(/\/+$/, ''), url);
    return env.ASSETS.fetch(request);   // arquivos de docs/
  },
};

async function api(request, env, rota, url) {
  const kv = env.FICHA_KV;
  if (!kv) return json({ erro: 'config', mensagem: 'O armazenamento FICHA_KV não está ligado ao projeto no Cloudflare.' }, 500);

  const metodo = request.method;

  if (rota === 'entrar' && metodo === 'POST') return entrar(request, kv, env);
  if (rota === 'admin/entrar' && metodo === 'POST') return entrarAdmin(request, kv, env);

  const slug = await usuarioDaSessao(request, kv);
  if (!slug) return json({ erro: 'sessao', mensagem: 'Sua sessão expirou. Entre de novo.' }, 401);

  if (rota === 'video' && metodo === 'GET') return videoDoExercicio(kv, env, url.searchParams.get('nome'));

  if (slug === ADMIN && rota !== 'sair' && !rota.startsWith('admin/')) return json({ erro: 'proibido', mensagem: 'A conta admin não tem treinos.' }, 403);

  if (rota === 'dados' && metodo === 'GET') {
    const r = (await kv.get(`d:${slug}`, 'json')) || { rev: 0, dados: null };
    return json({ rev: r.rev, dados: r.dados });
  }

  if (rota === 'dados' && metodo === 'PUT') {
    const texto = await request.text();
    if (texto.length > 2_000_000) return json({ erro: 'grande', mensagem: 'Dados grandes demais.' }, 413);
    let corpo;
    try { corpo = JSON.parse(texto); } catch { return json({ erro: 'json' }, 400); }
    const atual = (await kv.get(`d:${slug}`, 'json')) || { rev: 0, dados: null };
    if (corpo.rev !== atual.rev) return json({ erro: 'conflito', rev: atual.rev, dados: atual.dados }, 409);
    const rev = atual.rev + 1;
    await kv.put(`d:${slug}`, JSON.stringify({ rev, dados: corpo.dados, atualizadoEm: new Date().toISOString() }));
    return json({ rev });
  }

  if (rota === 'sair' && metodo === 'POST') {
    const token = request.headers.get('authorization').slice(7);
    await kv.delete(`s:${token}`);
    return json({ ok: true });
  }

  if (rota.startsWith('admin/')) {
    if (slug !== ADMIN) return json({ erro: 'proibido', mensagem: 'Só o administrador pode fazer isso.' }, 403);
    const rv = rota.slice(6);
    if (['videos', 'canais', 'video'].includes(rv)) return adminVideos(request, kv, env, rv, url);
    return admin(request, kv, rv, slug);
  }

  return json({ erro: 'rota' }, 404);
}

// ---------- admin ----------
async function listarChaves(kv, prefix) {
  const chaves = [];
  let cursor;
  do {
    const r = await kv.list({ prefix, cursor });
    chaves.push(...r.keys);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return chaves;
}

async function desconectar(kv, slug) {
  const sessoes = (await listarChaves(kv, 's:')).filter((k) => k.metadata?.slug === slug);
  await Promise.all(sessoes.map((k) => kv.delete(k.name)));
  return sessoes.length;
}

function resumo(slug, u, d, tentativas, sessoes) {
  const dados = d?.dados || {};
  const hist = dados.historico || [];
  return {
    slug, nome: u.nome, criadoEm: u.criadoEm,
    treinos: hist.length,
    ultimoTreino: hist[0] ? { treinoId: hist[0].treinoId, titulo: hist[0].titulo, fim: hist[0].fim } : null,
    atualizadoEm: d?.atualizadoEm || null,
    ficha: dados.ficha ? { origem: dados.ficha.origem || 'pdf', rotina: dados.ficha.rotina, importadoEm: dados.ficha.importadoEm, treinos: dados.ficha.treinos?.length || 0 } : null,
    emAndamento: dados.sessao?.treinoId || null,
    bloqueado: tentativas >= MAX_TENTATIVAS,
    tentativas,
    aparelhos: sessoes,
  };
}

async function admin(request, kv, rota, eu) {
  const metodo = request.method;
  const sessoesPor = async () => {
    const m = {};
    for (const k of await listarChaves(kv, 's:')) if (k.metadata?.slug) m[k.metadata.slug] = (m[k.metadata.slug] || 0) + 1;
    return m;
  };

  if (rota === 'usuarios' && metodo === 'GET') {
    const [chaves, sessoes] = await Promise.all([listarChaves(kv, 'u:'), sessoesPor()]);
    const lista = await Promise.all(chaves.map(async ({ name }) => {
      const slug = name.slice(2);
      const [u, d, t] = await Promise.all([kv.get(name, 'json'), kv.get(`d:${slug}`, 'json'), kv.get(`t:${slug}`)]);
      return u ? { ...resumo(slug, u, d, Number(t) || 0, sessoes[slug] || 0), admin: slug === eu } : null;
    }));
    return json({ usuarios: lista.filter(Boolean).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')) });
  }

  const m = rota.match(/^usuarios\/([a-z0-9-]+)(?:\/(pin|desbloquear|desconectar|ficha))?$/);
  if (!m) return json({ erro: 'rota' }, 404);
  const [, slug, acao] = m;
  const u = await kv.get(`u:${slug}`, 'json');
  if (!u) return json({ erro: 'nao-existe', mensagem: 'Usuário não encontrado.' }, 404);

  if (!acao && metodo === 'GET') {
    const [d, t, sessoes] = await Promise.all([kv.get(`d:${slug}`, 'json'), kv.get(`t:${slug}`), sessoesPor()]);
    return json({ usuario: { ...resumo(slug, u, d, Number(t) || 0, sessoes[slug] || 0), admin: slug === eu }, rev: d?.rev || 0, dados: d?.dados || null });
  }

  if (acao === 'pin' && metodo === 'POST') {
    const corpo = await lerCorpo(request);
    const pin = String(corpo?.pin || '');
    if (!/^\d{4}$/.test(pin)) return json({ erro: 'pin', mensagem: 'O PIN tem 4 números.' }, 400);
    const salt = aleatorio(16);
    await kv.put(`u:${slug}`, JSON.stringify({ ...u, salt, hash: await hashPin(pin, salt) }));
    await kv.delete(`t:${slug}`);
    const n = slug === eu ? 0 : await desconectar(kv, slug);
    return json({ ok: true, desconectados: n });
  }

  if (acao === 'desbloquear' && metodo === 'POST') {
    await kv.delete(`t:${slug}`);
    return json({ ok: true });
  }

  if (acao === 'desconectar' && metodo === 'POST') {
    if (slug === eu) return json({ erro: 'proprio', mensagem: 'Use "Sair" para desconectar a sua própria conta.' }, 400);
    return json({ ok: true, desconectados: await desconectar(kv, slug) });
  }

  if (acao === 'ficha' && metodo === 'PUT') {
    const corpo = await lerCorpo(request);
    if (!corpo?.ficha?.treinos?.length) return json({ erro: 'ficha', mensagem: 'Ficha inválida.' }, 400);
    const d = (await kv.get(`d:${slug}`, 'json')) || { rev: 0, dados: null };
    const dados = { ...(d.dados || {}), ficha: corpo.ficha, fichaEm: Date.now() };
    // treino em andamento de um treino que não existe mais na ficha nova é descartado
    if (dados.sessao && !corpo.ficha.treinos.some((t) => t.id === dados.sessao.treinoId)) { dados.sessao = null; dados.sessaoEm = Date.now(); }
    await kv.put(`d:${slug}`, JSON.stringify({ rev: d.rev + 1, dados, atualizadoEm: new Date().toISOString() }));
    return json({ ok: true, rev: d.rev + 1 });
  }

  if (!acao && metodo === 'DELETE') {
    if (slug === eu) return json({ erro: 'proprio', mensagem: 'Você não pode excluir a sua própria conta.' }, 400);
    await desconectar(kv, slug);
    await Promise.all([kv.delete(`u:${slug}`), kv.delete(`d:${slug}`), kv.delete(`t:${slug}`)]);
    return json({ ok: true });
  }

  return json({ erro: 'rota' }, 404);
}

// ---------- vídeos ----------
const YT = 'https://www.googleapis.com/youtube/v3/';
const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
const chaveVideo = (nome) => 'v:' + normalizar(nome).slice(0, 200);
const ENTIDADES = { quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', amp: '&', ccedil: 'ç', atilde: 'ã', otilde: 'õ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', acirc: 'â', ecirc: 'ê', ocirc: 'ô', agrave: 'à' };
const desfazHtml = (t) => String(t || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ENTIDADES[e.toLowerCase()] ?? m);
const IGNORAR = new Set(['com', 'sem', 'para', 'dos', 'das', 'nos', 'nas', 'pelo', 'pela', 'uma', 'como', 'fazer', 'the', 'and', 'exercicio', 'execucao', 'correta', 'tecnica']);

async function yt(env, caminho, params) {
  const u = new URL((env.YT_BASE || YT) + caminho);   // YT_BASE só existe nos testes locais
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', env.YOUTUBE_API_KEY);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || `YouTube respondeu ${r.status}`);
    e.motivo = j.error?.errors?.[0]?.reason || '';
    throw e;
  }
  return j;
}

function erroYoutube(e) {
  if (/quota/i.test(e.motivo)) return json({ erro: 'cota', mensagem: 'O limite diário de buscas no YouTube acabou. Tente de novo amanhã.' }, 503);
  if (/keyInvalid|forbidden|accessNotConfigured/i.test(e.motivo) || /API key/i.test(e.message))
    return json({ erro: 'chave', mensagem: 'A chave do YouTube foi recusada. Confira o secret YOUTUBE_API_KEY.' }, 503);
  return json({ erro: 'youtube', mensagem: 'O YouTube não respondeu agora. Tente de novo.' }, 503);
}

// Quanto do nome do exercício aparece no título do vídeo (0 a 1).
function nota(nome, titulo) {
  const palavras = (s) => new Set(normalizar(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !IGNORAR.has(w)));
  const a = palavras(nome), b = palavras(titulo);
  if (!a.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

// Sem canais definidos: busca no YouTube inteiro (vídeos em português que podem ser embutidos).
// Com canais: busca só neles, na ordem, e para no primeiro que tiver um vídeo com o nome do exercício.
async function buscarVideos(env, canais, nome) {
  const limpo = nome.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const achados = [];
  const comum = { part: 'snippet', type: 'video', relevanceLanguage: 'pt', videoEmbeddable: 'true', safeSearch: 'strict' };
  for (const c of canais.length ? canais : [null]) {
    const params = c ? { ...comum, channelId: c.id, q: limpo, maxResults: '3' }
      : { ...comum, q: `${limpo} execução`, maxResults: '6', regionCode: 'BR' };
    const j = await yt(env, 'search', params);
    (j.items || []).forEach((it, pos) => {
      if (!it.id?.videoId) return;
      const titulo = desfazHtml(it.snippet.title);
      achados.push({ id: it.id.videoId, titulo, canal: desfazHtml(it.snippet.channelTitle), nota: nota(nome, titulo) - pos * 0.01 });
    });
    if (c && achados.some((v) => v.nota >= 0.6)) break;   // achou um bom: não gasta busca nos outros canais
  }
  const vistos = new Set();
  return achados.sort((a, b) => b.nota - a.nota).filter((v) => !vistos.has(v.id) && vistos.add(v.id)).slice(0, 3)
    .map(({ id, titulo, canal }) => ({ id, titulo, canal }));
}

function respostaVideo(reg) {
  const videos = reg.fixo ? [reg.fixo, ...(reg.videos || []).filter((v) => v.id !== reg.fixo.id)] : reg.videos || [];
  return json({ videos, fixo: !!reg.fixo });
}

async function videoDoExercicio(kv, env, nome) {
  nome = String(nome || '').trim().slice(0, 150);
  if (!nome) return json({ erro: 'nome', mensagem: 'Faltou o nome do exercício.' }, 400);
  const k = chaveVideo(nome);
  const guardado = await kv.get(k, 'json');
  if (guardado) return respostaVideo(guardado);
  const canais = (await kv.get('cfg:canais', 'json')) || [];
  if (!env.YOUTUBE_API_KEY) return json({ erro: 'config', mensagem: 'A chave do YouTube ainda não foi cadastrada (secret YOUTUBE_API_KEY).' }, 500);
  let videos;
  try { videos = await buscarVideos(env, canais, nome); } catch (e) { return erroYoutube(e); }
  const reg = { nome, videos, buscadoEm: new Date().toISOString() };
  // sem resultado: guarda por 7 dias e tenta de novo depois (os canais podem ganhar vídeos novos)
  await kv.put(k, JSON.stringify(reg), videos.length ? {} : { expirationTtl: 7 * DIA });
  return respostaVideo(reg);
}

async function resolverCanal(env, entrada) {
  const s = String(entrada || '').trim();
  if (!s) return null;
  let m, j, handle = '';
  if ((m = s.match(/\b(UC[\w-]{22})\b/))) j = await yt(env, 'channels', { part: 'snippet', id: m[1] });
  else {
    m = s.match(/@([\w.\-]+)/);
    handle = '@' + (m ? m[1] : s.replace(/^https?:\/\/(www\.|m\.)?youtube\.com\//i, '').split(/[/?#]/)[0]);
    j = await yt(env, 'channels', { part: 'snippet', forHandle: handle });
  }
  const it = j.items?.[0];
  if (!it) { const e = new Error(`Não achei o canal "${s}". Use o @ do canal ou o link dele.`); e.usuario = true; throw e; }
  return { id: it.id, nome: desfazHtml(it.snippet.title), handle: it.snippet.customUrl || handle };
}

function idDoVideo(url) {
  const s = String(url || '').trim();
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

async function adminVideos(request, kv, env, rota, url) {
  const metodo = request.method;

  if (rota === 'videos' && metodo === 'GET') {
    const canais = (await kv.get('cfg:canais', 'json')) || [];
    const chaves = await listarChaves(kv, 'v:');
    const videos = (await Promise.all(chaves.map((k) => kv.get(k.name, 'json')))).filter(Boolean);
    return json({ canais, videos, temChave: !!env.YOUTUBE_API_KEY });
  }

  if (rota === 'canais' && metodo === 'PUT') {
    const corpo = await lerCorpo(request);
    const entradas = (corpo?.entradas || []).map((e) => String(e).trim()).filter(Boolean).slice(0, 10);
    if (entradas.length && !env.YOUTUBE_API_KEY) return json({ erro: 'config', mensagem: 'Cadastre a chave do YouTube (secret YOUTUBE_API_KEY) antes de escolher os canais.' }, 400);
    const canais = [];
    try {
      for (const e of entradas) {
        const c = await resolverCanal(env, e);
        if (c && !canais.some((x) => x.id === c.id)) canais.push(c);
      }
    } catch (e) {
      return e.usuario ? json({ erro: 'canal', mensagem: e.message }, 400) : erroYoutube(e);
    }
    await kv.put('cfg:canais', JSON.stringify(canais));
    // buscas feitas com os canais antigos saem; vídeos fixados ficam
    let apagadas = 0;
    for (const k of await listarChaves(kv, 'v:')) {
      const reg = await kv.get(k.name, 'json');
      if (reg?.fixo) await kv.put(k.name, JSON.stringify({ nome: reg.nome, fixo: reg.fixo, videos: [] }));
      else { await kv.delete(k.name); apagadas++; }
    }
    return json({ canais, apagadas });
  }

  if (rota === 'video' && metodo === 'PUT') {
    const corpo = await lerCorpo(request);
    const nome = String(corpo?.nome || '').trim();
    if (!nome) return json({ erro: 'nome', mensagem: 'Faltou o nome do exercício.' }, 400);
    const k = chaveVideo(nome);
    const reg = (await kv.get(k, 'json')) || { nome, videos: [] };
    if (!String(corpo?.url || '').trim()) {
      delete reg.fixo;
      if (!reg.videos?.length) await kv.delete(k); else await kv.put(k, JSON.stringify(reg));
      return json({ ok: true });
    }
    const id = idDoVideo(corpo.url);
    if (!id) return json({ erro: 'url', mensagem: 'Não reconheci esse link do YouTube.' }, 400);
    let titulo = 'Vídeo escolhido pelo admin', canal = '';
    if (env.YOUTUBE_API_KEY) {
      try {
        const j = await yt(env, 'videos', { part: 'snippet', id });
        if (!j.items?.length) return json({ erro: 'url', mensagem: 'Esse vídeo não existe ou é privado.' }, 400);
        titulo = desfazHtml(j.items[0].snippet.title); canal = desfazHtml(j.items[0].snippet.channelTitle);
      } catch {}
    }
    reg.fixo = { id, titulo, canal };
    await kv.put(k, JSON.stringify(reg));
    return json({ ok: true, fixo: reg.fixo });
  }

  if (rota === 'video' && metodo === 'DELETE') {
    const k = chaveVideo(url.searchParams.get('nome'));
    const reg = await kv.get(k, 'json');
    if (reg?.fixo) await kv.put(k, JSON.stringify({ nome: reg.nome, fixo: reg.fixo, videos: [] }));
    else await kv.delete(k);
    return json({ ok: true });
  }

  return json({ erro: 'rota' }, 404);
}
