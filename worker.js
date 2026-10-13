// Ficha Hpt — Cloudflare Worker: serve o site (pasta docs/) e a API em /api/* com KV (binding FICHA_KV)
//
// POST /api/entrar   { nome, pin, lembrar, criar }  -> { token, nome, slug, rev, dados }
// GET  /api/dados                                     -> { rev, dados }
// PUT  /api/dados    { rev, dados }                   -> { rev }  (409 + versão do servidor se rev estiver velho)
// POST /api/sair
//
// Admin (slugs listados em ADMINS no wrangler.jsonc):
// GET    /api/admin/usuarios                 lista com resumo
// GET    /api/admin/usuarios/<slug>          dados completos
// POST   /api/admin/usuarios/<slug>/pin      { pin }  novo PIN (desconecta os aparelhos)
// POST   /api/admin/usuarios/<slug>/desbloquear
// POST   /api/admin/usuarios/<slug>/desconectar
// PUT    /api/admin/usuarios/<slug>/ficha    { ficha }  troca a ficha da pessoa
// DELETE /api/admin/usuarios/<slug>
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

const ehAdmin = (env, slug) => String(env.ADMINS || '').split(',').map((x) => x.trim()).filter(Boolean).includes(slug);

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
  return json({ token, nome: usuario.nome, slug, admin: ehAdmin(env, slug), rev: registro.rev, dados: registro.dados });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url.pathname.slice(5).replace(/\/+$/, ''));
    return env.ASSETS.fetch(request);   // arquivos de docs/
  },
};

async function api(request, env, rota) {
  const kv = env.FICHA_KV;
  if (!kv) return json({ erro: 'config', mensagem: 'O armazenamento FICHA_KV não está ligado ao projeto no Cloudflare.' }, 500);

  const metodo = request.method;

  if (rota === 'entrar' && metodo === 'POST') return entrar(request, kv, env);

  const slug = await usuarioDaSessao(request, kv);
  if (!slug) return json({ erro: 'sessao', mensagem: 'Sua sessão expirou. Entre de novo.' }, 401);

  if (rota === 'dados' && metodo === 'GET') {
    const r = (await kv.get(`d:${slug}`, 'json')) || { rev: 0, dados: null };
    return json({ rev: r.rev, dados: r.dados, admin: ehAdmin(env, slug) });
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
    if (!ehAdmin(env, slug)) return json({ erro: 'proibido', mensagem: 'Só o administrador pode fazer isso.' }, 403);
    return admin(request, kv, rota.slice(6), slug);
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
