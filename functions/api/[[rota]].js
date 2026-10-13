// API da Ficha Hpt — Cloudflare Pages Functions + KV (binding: FICHA_KV)
//
// POST /api/entrar   { nome, pin, lembrar, criar }  -> { token, nome, slug, rev, dados }
// GET  /api/dados                                     -> { rev, dados }
// PUT  /api/dados    { rev, dados }                   -> { rev }  (409 + versão do servidor se rev estiver velho)
// POST /api/sair
//
// Chaves no KV:
//   u:<slug>   { nome, salt, hash, criadoEm }          usuário
//   d:<slug>   { rev, dados, atualizadoEm }            o "JSON" de cada pessoa
//   s:<token>  <slug>                                  sessão (expira)
//   t:<slug>   <n>                                     tentativas de PIN erradas (expira em 15 min)

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

async function usuarioDaSessao(request, kv) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  return kv.get(`s:${m[1]}`);
}

async function entrar(request, kv) {
  const corpo = await lerCorpo(request);
  const nome = String(corpo?.nome || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const pin = String(corpo?.pin || '');
  const slug = slugify(nome);
  if (!slug) return json({ erro: 'nome', mensagem: 'Digite seu nome.' }, 400);
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
  await kv.put(`s:${token}`, slug, { expirationTtl: corpo.lembrar ? 365 * DIA : DIA });
  const registro = (await kv.get(`d:${slug}`, 'json')) || { rev: 0, dados: null };
  return json({ token, nome: usuario.nome, slug, rev: registro.rev, dados: registro.dados });
}

export async function onRequest({ request, env, params }) {
  const kv = env.FICHA_KV;
  if (!kv) return json({ erro: 'config', mensagem: 'O armazenamento FICHA_KV não está ligado ao projeto no Cloudflare.' }, 500);

  const rota = (params.rota || []).join('/');
  const metodo = request.method;

  if (rota === 'entrar' && metodo === 'POST') return entrar(request, kv);

  const slug = await usuarioDaSessao(request, kv);
  if (!slug) return json({ erro: 'sessao', mensagem: 'Sua sessão expirou. Entre de novo.' }, 401);

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

  return json({ erro: 'rota' }, 404);
}
