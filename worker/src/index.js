// Rainbow Pub — Worker da Jukebox Inteligente (Spotify API + D1 + Cron 12h BRT)

import {
  obterOuCriarCliente,
  hashIp,
  verificarTurnstile,
  exigirEquipe,
  idAleatorio,
} from './auth.js';
import {
  montarUrlOAuth,
  trocarCodigoPorTokens,
  buscarPerfil,
  salvarAuthSpotify,
  obterAuthSalva,
  desconectarSpotify,
  pularMusicaSpotify,
  listarPlaylistsUsuario,
} from './spotify.js';
import {
  obterConfig,
  garantirNoiteAtual,
  zerarFila,
  sincronizarPlayer,
  montarEstadoPublico,
  buscarMusicas,
  processarPedidoMusica,
  verificarRateLimitBusca,
  sincronizarPlaylistsPermitidas,
  invalidarCache,
} from './regras.js';

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const permitidos = new Set([
    env.SITE_ORIGIN || 'https://rainbowpub.cjc.pics',
    'http://127.0.0.1:8000',
    'http://localhost:8000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
  ]);
  const h = {
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (permitidos.has(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Cliente-Token';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  }
  return h;
}

function jsonResp(dados, status, request, env, extraHeaders = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

function clampInt(val, min, max, fallback) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function lerJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/* ─────────────── Roteador HTTP ─────────────── */

async function atenderRequisicao(request, env, ctx) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  // Normaliza prefixo /api/musica para funcionar tanto em rota dedicada quanto local.
  const path = url.pathname.replace(/^\/api\/musica/, '') || '/';

  /* ── ROTAS PÚBLICAS (Clientes) ── */

  if (method === 'GET' && path === '/status') {
    const cliente = await obterOuCriarCliente(request, env);
    const estado = await montarEstadoPublico(env, cliente.clienteHash);
    estado.clienteToken = cliente.clienteToken;
    const headers = cliente.setCookie ? { 'Set-Cookie': cliente.setCookie } : {};
    return jsonResp(estado, 200, request, env, headers);
  }

  if (method === 'GET' && path === '/buscar') {
    const ipHash = await hashIp(request, env);
    const rl = await verificarRateLimitBusca(env.DB, ipHash);
    if (!rl.ok) {
      return jsonResp({ erro: 'Muitas buscas seguidas. Aguarde uns segundos.' }, 429, request, env);
    }
    const q = url.searchParams.get('q') || '';
    const playlistId = url.searchParams.get('playlist') || '';
    try {
      const cfg = await garantirNoiteAtual(env.DB);
      const auth = await obterAuthSalva(env.DB);
      if (!auth?.refresh_token) {
        return jsonResp({ erro: 'Spotify do bar ainda não está conectado.', resultados: [] }, 503, request, env);
      }
      const resultados = await buscarMusicas(env, q, playlistId);
      return jsonResp({ modo: cfg.modo, resultados }, 200, request, env);
    } catch (err) {
      return jsonResp({ erro: err.message || 'Não foi possível buscar agora.', resultados: [] }, 502, request, env);
    }
  }

  if (method === 'POST' && path === '/pedir') {
    const cliente = await obterOuCriarCliente(request, env);
    const ipHash = await hashIp(request, env);
    const body = await lerJson(request);
    const extra = cliente.setCookie ? { 'Set-Cookie': cliente.setCookie } : {};

    const ts = await verificarTurnstile(body.turnstileToken, request, env);
    if (!ts.ok) {
      return jsonResp({ erro: ts.erro }, 403, request, env, extra);
    }

    try {
      const res = await processarPedidoMusica(env, {
        trackId: body.trackId,
        pedidoPor: body.nome,
        geo: body.geo,
        cliente,
        ipHash,
        userAgent: request.headers.get('User-Agent') || '',
        cf: request.cf || null,
      });
      if (!res.ok) {
        return jsonResp(
          { erro: res.erro, cooldownRestanteSeg: res.cooldownRestanteSeg, clienteToken: cliente.clienteToken },
          res.status || 400,
          request,
          env,
          extra
        );
      }
      return jsonResp({ ok: true, item: res.item, clienteToken: cliente.clienteToken }, 201, request, env, extra);
    } catch (err) {
      return jsonResp({ erro: err.message || 'Erro ao enviar o pedido.' }, 500, request, env, extra);
    }
  }

  /* ── OAuth Callback do Spotify (redireciona de volta ao /adm) ── */

  if (method === 'GET' && path === '/oauth/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const erroSpotify = url.searchParams.get('error');
    const siteOrigin = env.SITE_ORIGIN || 'https://rainbowpub.cjc.pics';

    const redirecionarAdm = (status, msg = '') => {
      const destino = new URL('/adm/', siteOrigin);
      destino.searchParams.set('spotify', status);
      if (msg) destino.searchParams.set('msg', msg);
      return Response.redirect(destino.toString(), 302);
    };

    if (erroSpotify) {
      return redirecionarAdm('erro', erroSpotify === 'access_denied' ? 'Autorização cancelada.' : erroSpotify);
    }
    if (!code || !state) {
      return redirecionarAdm('erro', 'Retorno incompleto do Spotify.');
    }

    const chaveState = `oauth:${state}`;
    const reg = await env.DB.prepare('SELECT valor, expira_em FROM rate_limits WHERE chave = ?').bind(chaveState).first();
    await env.DB.prepare('DELETE FROM rate_limits WHERE chave = ?').bind(chaveState).run();

    if (!reg || reg.expira_em < Date.now()) {
      return redirecionarAdm('erro', 'Link de conexão expirado. Tente conectar novamente no painel.');
    }

    try {
      const tokens = await trocarCodigoPorTokens(env, code);
      const perfil = await buscarPerfil(env, tokens.access_token);
      if (perfil.product && perfil.product !== 'premium') {
        return redirecionarAdm('erro', 'A conta do Spotify precisa ser Premium para controlar a fila.');
      }
      await salvarAuthSpotify(env.DB, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        userId: perfil.id || '',
        displayName: perfil.display_name || perfil.id || 'Spotify',
        email: perfil.email || '',
        product: perfil.product || '',
        conectadoEm: Date.now(),
      });
      await invalidarCache(env.DB, 'now_playing');
      return redirecionarAdm('ok');
    } catch (err) {
      return redirecionarAdm('erro', err.message || 'Falha ao finalizar conexão com o Spotify.');
    }
  }

  /* ── ROTAS ADMINISTRATIVAS (/adm — exigem Firebase Auth + equipe/{uid}) ── */

  if (path.startsWith('/adm/')) {
    const authAdm = await exigirEquipe(request, env);
    if (!authAdm.ok) {
      return jsonResp({ erro: authAdm.erro }, authAdm.status, request, env);
    }

    // GET /adm/estado — painel completo (conexão, config, fila, tocando agora, bloqueios, histórico)
    if (method === 'GET' && path === '/adm/estado') {
      const forcar = url.searchParams.get('forcar') === '1';
      const cfg = await garantirNoiteAtual(env.DB);
      const authSp = await obterAuthSalva(env.DB);
      const sync = await sincronizarPlayer(env, { forcar, tentarInjetar: true });
      const pub = await montarEstadoPublico(env, null, { forcar: false });

      const bloqueios = await env.DB
        .prepare('SELECT id, tipo, spotify_id, nome, motivo, criado_em FROM bloqueios ORDER BY criado_em DESC LIMIT 200')
        .all();

      const clientesBloqRes = await env.DB
        .prepare('SELECT id, aparelho_id, nome, dispositivo, musica_motivo, criado_em FROM clientes_bloqueados ORDER BY criado_em DESC LIMIT 100')
        .all();

      const aguardando = await env.DB
        .prepare(
          `SELECT id, track_id, nome, artistas, artista_principal_id, album, capa, duracao_ms, pedido_por, criado_em
           FROM fila
           WHERE noite = ? AND status = 'aguardando'
           ORDER BY criado_em ASC`
        )
        .bind(cfg.noiteAtual)
        .all();

      const logsRes = await env.DB
        .prepare(
          `SELECT id, noite, track_id, nome, artistas, artista_principal_id, capa, duracao_ms,
                  pedido_por, cliente_hash, dispositivo, meta_json, status, criado_em, enviada_em, tocada_em
           FROM fila
           ORDER BY criado_em DESC
           LIMIT 150`
        )
        .all();

      const parseMeta = (s, ch) => {
        let m = {};
        try { m = JSON.parse(s || '{}') || {}; } catch {}
        return {
          aparelhoId: m.aparelhoId || String(ch || '').slice(0, 6).toUpperCase(),
          distanciaM: typeof m.distanciaM === 'number' ? m.distanciaM : null,
          precisaoGps: typeof m.precisaoGps === 'number' ? m.precisaoGps : null,
          operadora: m.operadora || '',
          cidade: m.cidade || '',
        };
      };

      const logs = (logsRes.results || []).map((r) => ({
        id: r.id,
        noite: r.noite,
        trackId: r.track_id,
        nome: r.nome,
        artistas: r.artistas,
        artistaPrincipalId: r.artista_principal_id,
        capa: r.capa,
        duracaoMs: r.duracao_ms,
        pedidoPor: r.pedido_por || 'Anônimo',
        dispositivo: r.dispositivo || '',
        ...parseMeta(r.meta_json, r.cliente_hash),
        status: r.status,
        criadoEm: r.criado_em,
        enviadaEm: r.enviada_em || null,
        tocadaEm: r.tocada_em || null,
      }));

      const totalCatalogo = Number(
        (await env.DB.prepare('SELECT COUNT(*) AS n FROM catalogo_faixas').first())?.n || 0
      );

      return jsonResp(
        {
          ...pub,
          config: cfg,
          totalCatalogo,
          spotifyConfigurado: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
          contaSpotify: authSp
            ? {
                displayName: authSp.display_name,
                email: authSp.email,
                product: authSp.product,
                conectadoEm: authSp.conectado_em,
              }
            : null,
          tocandoAgora: sync.nowPlaying,
          aguardandoAprovacao: (aguardando.results || []).map((r) => ({
            id: r.id,
            trackId: r.track_id,
            nome: r.nome,
            artistas: r.artistas,
            artistaPrincipalId: r.artista_principal_id,
            album: r.album,
            capa: r.capa,
            duracaoMs: r.duracao_ms,
            pedidoPor: r.pedido_por,
            criadoEm: r.criado_em,
          })),
          bloqueios: (bloqueios.results || []).map((b) => ({
            id: b.id,
            tipo: b.tipo,
            spotifyId: b.spotify_id,
            nome: b.nome,
            motivo: b.motivo,
            criadoEm: b.criado_em,
          })),
          clientesBloqueados: (clientesBloqRes.results || []).map((c) => ({
            id: c.id,
            aparelhoId: c.aparelho_id,
            nome: c.nome,
            dispositivo: c.dispositivo,
            musicaMotivo: c.musica_motivo,
            criadoEm: c.criado_em,
          })),
          logs,
          historico: logs.filter((h) => h.noite === cfg.noiteAtual && (h.status === 'tocando' || h.status === 'tocada')).slice(0, 15),
        },
        200,
        request,
        env
      );
    }

    // POST /adm/oauth/iniciar — gera URL segura do Spotify OAuth com state descartável
    if (method === 'POST' && path === '/adm/oauth/iniciar') {
      if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
        return jsonResp(
          { erro: 'Configure os secrets SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET no Cloudflare Worker.' },
          400,
          request,
          env
        );
      }
      const state = idAleatorio(24);
      await env.DB
        .prepare('INSERT INTO rate_limits (chave, valor, expira_em) VALUES (?, ?, ?)')
        .bind(`oauth:${state}`, authAdm.uid, Date.now() + 10 * 60_000)
        .run();
      return jsonResp({ url: montarUrlOAuth(env, state) }, 200, request, env);
    }

    // POST /adm/desconectar — remove tokens do Spotify
    if (method === 'POST' && path === '/adm/desconectar') {
      await desconectarSpotify(env.DB);
      return jsonResp({ ok: true }, 200, request, env);
    }

    // PUT /adm/config — liga/desliga/aprovação, muda modo (aberto/playlists) e ajusta travas anti-zoeira
    if (method === 'PUT' && path === '/adm/config') {
      const atual = await obterConfig(env.DB);
      const b = await lerJson(request);

      let controle = atual.controle;
      if (['liberado', 'aprovacao', 'desativado'].includes(b.controle)) {
        controle = b.controle;
      } else if (b.ativo !== undefined) {
        controle = b.ativo ? 'liberado' : 'desativado';
      }
      const ativo = controle !== 'desativado';
      const modo = b.modo === 'playlists' || b.modo === 'aberto' ? b.modo : atual.modo;
      const cooldownMin = clampInt(b.cooldownMin, 0, 120, atual.cooldownMin);
      const maxFila = clampInt(b.maxFila, 3, 50, atual.maxFila);
      const maxMesmoArtista = clampInt(b.maxMesmoArtista, 1, 5, atual.maxMesmoArtista);
      const minDuracaoSeg = clampInt(b.minDuracaoSeg, 30, 300, atual.minDuracaoSeg);
      const maxDuracaoSeg = clampInt(b.maxDuracaoSeg, Math.max(minDuracaoSeg + 30, 120), 1200, atual.maxDuracaoSeg);
      const limitarDuracao = b.limitarDuracao === undefined ? atual.limitarDuracao : Boolean(b.limitarDuracao);
      const repeticaoHoras = clampInt(b.repeticaoHoras, 1, 12, atual.repeticaoHoras);
      const exigirGps = b.exigirGps === undefined ? atual.exigirGps : Boolean(b.exigirGps);
      const bloquearExplicito =
        b.bloquearExplicito === undefined ? atual.bloquearExplicito : Boolean(b.bloquearExplicito);

      await env.DB
        .prepare(
          `UPDATE config SET
             ativo = ?, controle = ?, modo = ?, cooldown_min = ?, max_fila = ?, max_mesmo_artista = ?,
             min_duracao_seg = ?, max_duracao_seg = ?, limitar_duracao = ?, repeticao_horas = ?,
             exigir_gps = ?, bloquear_explicito = ?, atualizado_em = ?
           WHERE id = 1`
        )
        .bind(
          ativo ? 1 : 0,
          controle,
          modo,
          cooldownMin,
          maxFila,
          maxMesmoArtista,
          minDuracaoSeg,
          maxDuracaoSeg,
          limitarDuracao ? 1 : 0,
          repeticaoHoras,
          exigirGps ? 1 : 0,
          bloquearExplicito ? 1 : 0,
          Date.now()
        )
        .run();

      return jsonResp({ ok: true, config: await obterConfig(env.DB) }, 200, request, env);
    }

    // POST /adm/fila/:id/aprovar — aprova música sugerida no modo 'aprovacao' e já injeta se for a #1
    const matchAprovar = path.match(/^\/adm\/fila\/([A-Za-z0-9_-]+)\/aprovar$/);
    if (method === 'POST' && matchAprovar) {
      const id = matchAprovar[1];
      const item = await env.DB.prepare('SELECT * FROM fila WHERE id = ?').bind(id).first();
      if (!item || item.status !== 'aguardando') {
        return jsonResp({ erro: 'Sugestão não encontrada ou já processada.' }, 404, request, env);
      }
      await env.DB.prepare("UPDATE fila SET status = 'pendente' WHERE id = ?").bind(id).run();
      await sincronizarPlayer(env, { forcar: true, tentarInjetar: true });
      return jsonResp({ ok: true }, 200, request, env);
    }

    // DELETE /adm/fila/:id — remove uma música da fila (opcionalmente bloqueia faixa ou artista)
    const matchFila = path.match(/^\/adm\/fila\/([A-Za-z0-9_-]+)$/);
    if (method === 'DELETE' && matchFila) {
      const id = matchFila[1];
      const bloquear = url.searchParams.get('bloquear') || ''; // 'track' | 'artist' | ''
      const item = await env.DB.prepare('SELECT * FROM fila WHERE id = ?').bind(id).first();
      if (!item) return jsonResp({ erro: 'Item não encontrado na fila.' }, 404, request, env);

      await env.DB.prepare("UPDATE fila SET status = 'removida' WHERE id = ?").bind(id).run();

      if (bloquear === 'track') {
        await env.DB
          .prepare(
            `INSERT OR IGNORE INTO bloqueios (id, tipo, spotify_id, nome, motivo, criado_em)
             VALUES (?, 'track', ?, ?, 'Removida da fila', ?)`
          )
          .bind(idAleatorio(8), item.track_id, `${item.nome} — ${item.artistas}`, Date.now())
          .run();
      } else if (bloquear === 'artist' && item.artista_principal_id) {
        const nomeArtista = String(item.artistas || '').split(',')[0].trim() || item.artistas;
        await env.DB
          .prepare(
            `INSERT OR IGNORE INTO bloqueios (id, tipo, spotify_id, nome, motivo, criado_em)
             VALUES (?, 'artist', ?, ?, 'Artista bloqueado pela equipe', ?)`
          )
          .bind(idAleatorio(8), item.artista_principal_id, nomeArtista, Date.now())
          .run();
        // Também remove outras pendentes do mesmo artista na fila.
        await env.DB
          .prepare("UPDATE fila SET status = 'removida' WHERE status = 'pendente' AND artista_principal_id = ?")
          .bind(item.artista_principal_id)
          .run();
      }

      return jsonResp({ ok: true }, 200, request, env);
    }

    // POST /adm/fila/zerar — zera toda a fila agora
    if (method === 'POST' && path === '/adm/fila/zerar') {
      const r = await zerarFila(env.DB, 'manual');
      return jsonResp({ ok: true, ...r }, 200, request, env);
    }

    // POST /adm/pular — pula a música atual no Spotify
    if (method === 'POST' && path === '/adm/pular') {
      const r = await pularMusicaSpotify(env);
      if (!r.ok) return jsonResp({ erro: r.erro }, r.status || 400, request, env);
      await invalidarCache(env.DB, 'now_playing');
      return jsonResp({ ok: true }, 200, request, env);
    }

    // GET /adm/playlists — lista playlists próprias/colaborativas da conta Spotify conectada
    if (method === 'GET' && path === '/adm/playlists') {
      try {
        const playlists = await listarPlaylistsUsuario(env);
        return jsonResp({ playlists }, 200, request, env);
      } catch (err) {
        return jsonResp({ erro: err.message || 'Erro ao buscar playlists.' }, 502, request, env);
      }
    }

    // PUT /adm/playlists — salva playlists permitidas e sincroniza catálogo de faixas
    if (method === 'PUT' && path === '/adm/playlists') {
      const b = await lerJson(request);
      try {
        const res = await sincronizarPlaylistsPermitidas(env, b.playlists);
        return jsonResp({ ok: true, ...res }, 200, request, env);
      } catch (err) {
        return jsonResp({ erro: err.message || 'Erro ao sincronizar playlists.' }, 502, request, env);
      }
    }

    // POST /adm/bloqueios — bloqueia música ou artista direto do log/histórico
    if (method === 'POST' && path === '/adm/bloqueios') {
      const b = await lerJson(request);
      const tipo = b.tipo === 'artist' ? 'artist' : b.tipo === 'track' ? 'track' : '';
      const spotifyId = String(b.spotifyId || '').trim();
      const nome = String(b.nome || '').trim().slice(0, 120);
      if (!tipo || !spotifyId || !nome) {
        return jsonResp({ erro: 'Informe tipo, spotifyId e nome para bloquear.' }, 400, request, env);
      }
      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO bloqueios (id, tipo, spotify_id, nome, motivo, criado_em)
           VALUES (?, ?, ?, ?, 'Bloqueado pelo histórico', ?)`
        )
        .bind(idAleatorio(8), tipo, spotifyId, nome, Date.now())
        .run();
      if (tipo === 'artist') {
        await env.DB
          .prepare("UPDATE fila SET status = 'removida' WHERE status IN ('pendente', 'aguardando') AND artista_principal_id = ?")
          .bind(spotifyId)
          .run();
      } else {
        await env.DB
          .prepare("UPDATE fila SET status = 'removida' WHERE status IN ('pendente', 'aguardando') AND track_id = ?")
          .bind(spotifyId)
          .run();
      }
      return jsonResp({ ok: true }, 200, request, env);
    }

    // POST /adm/bloquear-cliente — bloqueia o aparelho que pediu uma música (via id da tabela fila)
    if (method === 'POST' && path === '/adm/bloquear-cliente') {
      const b = await lerJson(request);
      const filaId = String(b.filaId || '').trim();
      if (!filaId) return jsonResp({ erro: 'Pedido não informado.' }, 400, request, env);

      const item = await env.DB
        .prepare('SELECT id, cliente_hash, pedido_por, dispositivo, nome, artistas FROM fila WHERE id = ?')
        .bind(filaId)
        .first();
      if (!item || !item.cliente_hash) {
        return jsonResp({ erro: 'Não foi possível identificar o aparelho desse pedido.' }, 404, request, env);
      }

      const aparelhoId = String(item.cliente_hash).slice(0, 6).toUpperCase();
      const musicaMotivo = `${item.nome} — ${item.artistas}`.slice(0, 120);
      await env.DB
        .prepare(
          `INSERT INTO clientes_bloqueados (id, cliente_hash, aparelho_id, nome, dispositivo, musica_motivo, criado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(cliente_hash) DO UPDATE SET
             nome = excluded.nome,
             dispositivo = excluded.dispositivo,
             musica_motivo = excluded.musica_motivo,
             criado_em = excluded.criado_em`
        )
        .bind(idAleatorio(8), item.cliente_hash, aparelhoId, item.pedido_por || 'Anônimo', item.dispositivo || '', musicaMotivo, Date.now())
        .run();

      // Remove pedidos pendentes/aguardando desse aparelho da fila atual.
      await env.DB
        .prepare("UPDATE fila SET status = 'removida' WHERE status IN ('pendente', 'aguardando') AND cliente_hash = ?")
        .bind(item.cliente_hash)
        .run();

      return jsonResp({ ok: true, aparelhoId }, 200, request, env);
    }

    // DELETE /adm/clientes-bloqueados/:id — desbloqueia um aparelho
    const matchCliBloq = path.match(/^\/adm\/clientes-bloqueados\/([A-Za-z0-9_-]+)$/);
    if (method === 'DELETE' && matchCliBloq) {
      await env.DB.prepare('DELETE FROM clientes_bloqueados WHERE id = ?').bind(matchCliBloq[1]).run();
      return jsonResp({ ok: true }, 200, request, env);
    }

    // DELETE /adm/bloqueios/:id — remove um bloqueio
    const matchBloq = path.match(/^\/adm\/bloqueios\/([A-Za-z0-9_-]+)$/);
    if (method === 'DELETE' && matchBloq) {
      await env.DB.prepare('DELETE FROM bloqueios WHERE id = ?').bind(matchBloq[1]).run();
      return jsonResp({ ok: true }, 200, request, env);
    }

    return jsonResp({ erro: 'Rota administrativa não encontrada.' }, 404, request, env);
  }

  return jsonResp({ erro: 'Rota não encontrada.' }, 404, request, env);
}

/* ─────────────── Cron único (a cada 1 min — cuida da virada das 12:00 BRT e do feeder) ─────────────── */

async function executarCron(_event, env) {
  // garantirNoiteAtual() detecta automaticamente a virada das 12:00 BRT (15:00 UTC) e zera a fila.
  const cfg = await garantirNoiteAtual(env.DB);

  // Só chama o Spotify se houver fila pendente/enviada/tocando (economiza cota do Spotify e do Worker!).
  if (!cfg.ativo) return;
  const temFila = await env.DB
    .prepare("SELECT 1 FROM fila WHERE noite = ? AND status IN ('pendente', 'enviando', 'enviada', 'tocando') LIMIT 1")
    .bind(cfg.noiteAtual)
    .first();

  if (!temFila) return;

  await sincronizarPlayer(env, { forcar: true, tentarInjetar: true });
}

export default {
  async fetch(request, env, ctx) {
    return atenderRequisicao(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(executarCron(event, env));
  },
};
