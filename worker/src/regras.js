// Regras de negócio, GPS server-side, filtros anti-zoeira, feeder 1-a-1 e reset diário às 12h BRT.

import {
  obterAuthSalva,
  buscarTocandoAgora,
  adicionarNaFilaSpotify,
  buscarFaixaSpotify,
  pesquisarFaixasSpotify,
  buscarFaixasDePlaylist,
  normalizarTexto,
} from './spotify.js';
import { idAleatorio } from './auth.js';

const CACHE_TTL_NOW_PLAYING = 8_000; // 8s em RAM (dinâmico sem pesar na cota do Spotify nem no D1)
const CACHE_TTL_LOJA = 120_000; // 2 min para config/loja do Firestore
const CACHE_TTL_BUSCA = 10 * 60_000; // 10 min para resultados de busca

// Cache em RAM do isolate: evita leituras/escritas repetidas no D1 enquanto o Worker está quente.
const memCache = new Map();

// "Noite" do bar no fuso de Brasília (UTC-3), virando exatamente às 12:00 BRT (= 15:00 UTC).
export function noiteBRT(agoraMs = Date.now()) {
  const d = new Date(agoraMs - 15 * 3600_000);
  const ano = d.getUTCFullYear();
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dia = String(d.getUTCDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

export function proximoReset12hBRT(agoraMs = Date.now()) {
  // Próximo 15:00:00 UTC (= 12:00:00 BRT)
  const d = new Date(agoraMs);
  const alvo = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0, 0);
  return alvo > agoraMs ? alvo : alvo + 24 * 3600_000;
}

/* ─────────────── Cache leve (RAM primeiro, D1 como fallback) ─────────────── */

async function lerCache(db, chave, apenasRam = false) {
  const agora = Date.now();
  const emRam = memCache.get(chave);
  if (emRam && emRam.expiraEm > agora) return emRam.valor;
  if (apenasRam) return null;

  const row = await db.prepare('SELECT json, expira_em FROM cache_estado WHERE chave = ?').bind(chave).first();
  if (!row || row.expira_em < agora) return null;
  try {
    const valor = JSON.parse(row.json);
    memCache.set(chave, { valor, expiraEm: row.expira_em });
    return valor;
  } catch {
    return null;
  }
}

async function gravarCache(db, chave, valor, ttlMs, apenasRam = false) {
  const expiraEm = Date.now() + ttlMs;
  if (memCache.size > 200) memCache.clear();
  memCache.set(chave, { valor, expiraEm });
  if (apenasRam) return;

  await db
    .prepare(
      `INSERT INTO cache_estado (chave, json, expira_em) VALUES (?, ?, ?)
       ON CONFLICT(chave) DO UPDATE SET json = excluded.json, expira_em = excluded.expira_em`
    )
    .bind(chave, JSON.stringify(valor), expiraEm)
    .run();
}

export async function invalidarCache(db, chave) {
  memCache.delete(chave);
  await db.prepare('DELETE FROM cache_estado WHERE chave = ?').bind(chave).run();
}

/* ─────────────── Config & Reset Diário (12h BRT) ─────────────── */

export async function obterConfig(db) {
  let cfg = await db.prepare('SELECT * FROM config WHERE id = 1').first();
  if (!cfg) {
    await db.prepare("INSERT OR IGNORE INTO config (id, ativo, controle, modo) VALUES (1, 1, 'liberado', 'aberto')").run();
    cfg = await db.prepare('SELECT * FROM config WHERE id = 1').first();
  }
  const controle = ['liberado', 'aprovacao', 'desativado'].includes(cfg.controle)
    ? cfg.controle
    : cfg.ativo
      ? 'liberado'
      : 'desativado';
  return {
    ativo: controle !== 'desativado',
    controle,
    modo: cfg.modo === 'playlists' ? 'playlists' : 'aberto',
    cooldownMin: Number(cfg.cooldown_min ?? 15),
    maxFila: Number(cfg.max_fila ?? 15),
    maxMesmoArtista: Number(cfg.max_mesmo_artista ?? 1),
    minDuracaoSeg: Number(cfg.min_duracao_seg ?? 90),
    maxDuracaoSeg: Number(cfg.max_duracao_seg ?? 240),
    limitarDuracao: cfg.limitar_duracao === undefined ? true : Boolean(cfg.limitar_duracao),
    repeticaoHoras: Number(cfg.repeticao_horas ?? 3),
    exigirGps: Boolean(cfg.exigir_gps),
    bloquearExplicito: Boolean(cfg.bloquear_explicito),
    playlists: safeJsonArray(cfg.playlists_json),
    noiteAtual: cfg.noite_atual || '',
    ultimoResetEm: Number(cfg.ultimo_reset_em || 0),
  };
}

function safeJsonArray(str) {
  try {
    const x = JSON.parse(str || '[]');
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

export async function zerarFila(db, motivo = 'manual') {
  const agora = Date.now();
  const noite = noiteBRT(agora);

  const res = await db
    .prepare(
      `UPDATE fila
       SET status = 'removida'
       WHERE status IN ('aguardando', 'pendente', 'enviando', 'enviada', 'tocando')`
    )
    .run();

  // Limpa entradas antigas (> 7 dias) e rate limits expirados para manter o banco leve.
  await db.prepare('DELETE FROM fila WHERE criado_em < ?').bind(agora - 7 * 86400_000).run();
  await db.prepare('DELETE FROM rate_limits WHERE expira_em < ?').bind(agora).run();
  await db.prepare('DELETE FROM cache_estado WHERE expira_em < ?').bind(agora).run();

  await db
    .prepare('UPDATE config SET noite_atual = ?, ultimo_reset_em = ?, atualizado_em = ? WHERE id = 1')
    .bind(noite, agora, agora)
    .run();

  return {
    motivo,
    noite,
    removidas: Number(res.meta?.changes || 0),
    resetEm: agora,
  };
}

// Garante que após 12:00 BRT a fila sempre começa zerada para a nova noite.
export async function garantirNoiteAtual(db) {
  const cfg = await obterConfig(db);
  const noite = noiteBRT();
  if (cfg.noiteAtual !== noite) {
    await zerarFila(db, 'virada_12h');
    return obterConfig(db);
  }
  return cfg;
}

/* ─────────────── GPS do Bar (lê config/loja do Firestore) ─────────────── */

function parseFirestoreValor(v) {
  if (!v || typeof v !== 'object') return null;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return String(v.stringValue);
  if ('mapValue' in v) {
    const out = {};
    const fields = v.mapValue?.fields || {};
    for (const [k, val] of Object.entries(fields)) out[k] = parseFirestoreValor(val);
    return out;
  }
  if ('arrayValue' in v) {
    return (v.arrayValue?.values || []).map(parseFirestoreValor);
  }
  return null;
}

export async function obterGpsLoja(env) {
  const cached = await lerCache(env.DB, 'loja_gps', true);
  if (cached) return cached;

  const fallback = {
    ativo: true,
    lat: -18.9232877,
    lng: -48.2787283,
    raio: 150,
    caixa: null,
  };

  try {
    const projectId = env.FIREBASE_PROJECT_ID || 'rainbowpub-ecd71';
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/config/loja`;
    const res = await fetch(url);
    if (!res.ok) return fallback;
    const doc = await res.json();
    const gpsRaw = parseFirestoreValor(doc?.fields?.gps);
    if (gpsRaw && typeof gpsRaw.lat === 'number' && typeof gpsRaw.lng === 'number') {
      const gps = {
        ativo: gpsRaw.ativo !== false,
        lat: gpsRaw.lat,
        lng: gpsRaw.lng,
        raio: Number(gpsRaw.raio || 150),
        caixa: gpsRaw.caixa || null,
      };
      await gravarCache(env.DB, 'loja_gps', gps, CACHE_TTL_LOJA, true);
      return gps;
    }
  } catch {
    // Segue com fallback seguro (coordenadas oficiais do Rainbow Pub)
  }
  return fallback;
}

function distanciaMetros(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseDispositivo(uaRaw) {
  const ua = String(uaRaw || '');
  if (!ua) return 'Aparelho não identificado';

  let os = 'Outro';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) {
    const mMarca = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))/i);
    let modelo = (mMarca?.[1] || '').trim();
    if (/^K$/i.test(modelo) || modelo.length < 2) modelo = '';
    if (/SM-|Samsung/i.test(modelo)) os = 'Android (Samsung)';
    else if (/moto|motorola/i.test(modelo)) os = 'Android (Motorola)';
    else if (/Redmi|Mi\s|POCO|Xiaomi/i.test(modelo)) os = 'Android (Xiaomi)';
    else if (/Pixel/i.test(modelo)) os = 'Android (Pixel)';
    else os = modelo && modelo.length <= 20 ? `Android (${modelo})` : 'Android';
  } else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'Mac';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let nav = '';
  if (/Instagram/i.test(ua)) nav = 'Instagram';
  else if (/WhatsApp/i.test(ua)) nav = 'WhatsApp';
  else if (/FBAN|FBAV/i.test(ua)) nav = 'Facebook';
  else if (/EdgA|EdgiOS|Edg\//i.test(ua)) nav = 'Edge';
  else if (/OPR|Opera/i.test(ua)) nav = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) nav = 'Samsung Internet';
  else if (/Firefox|FxiOS/i.test(ua)) nav = 'Firefox';
  else if (/CriOS|Chrome/i.test(ua)) nav = 'Chrome';
  else if (/Safari/i.test(ua)) nav = 'Safari';

  return nav ? `${os} · ${nav}` : os;
}

export async function validarGps(geo, cfg, env) {
  if (!cfg.exigirGps) {
    // Mesmo com GPS opcional, calcula distância se o cliente enviou coordenadas válidas.
    if (geo && typeof geo.lat === 'number' && typeof geo.lng === 'number' && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
      const lojaGps = await obterGpsLoja(env);
      return { ok: true, distanciaM: Math.round(distanciaMetros(geo, lojaGps)) };
    }
    return { ok: true, distanciaM: null };
  }
  const lojaGps = await obterGpsLoja(env);
  if (!lojaGps.ativo) return { ok: true, distanciaM: null };

  if (
    !geo ||
    typeof geo.lat !== 'number' ||
    typeof geo.lng !== 'number' ||
    !Number.isFinite(geo.lat) ||
    !Number.isFinite(geo.lng)
  ) {
    return {
      ok: false,
      status: 403,
      erro: 'Precisamos confirmar sua localização para pedir música de dentro do Rainbow.',
    };
  }

  const dist = distanciaMetros(geo, lojaGps);
  const c = lojaGps.caixa;
  const dentroCaixa =
    !c ||
    (geo.lat >= c.latMin && geo.lat <= c.latMax && geo.lng >= c.lngMin && geo.lng <= c.lngMax);

  if (dist > lojaGps.raio || !dentroCaixa) {
    const longe =
      dist >= 1000 ? `${(dist / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(dist)} m`;
    return {
      ok: false,
      status: 403,
      erro: `Você parece estar a ${longe} do Rainbow. Pedir música só funciona aqui dentro.`,
    };
  }

  return { ok: true, distanciaM: Math.round(dist) };
}

/* ─────────────── Rate Limit (seguro para Wi-Fi compartilhado do bar) ─────────────── */

async function consumirContador(db, chave, limite, janelaMs) {
  const agora = Date.now();
  const row = await db.prepare('SELECT valor, expira_em FROM rate_limits WHERE chave = ?').bind(chave).first();

  let count = 0;
  let expira = agora + janelaMs;
  if (row && row.expira_em > agora) {
    count = Number(row.valor || 0);
    expira = row.expira_em;
  }

  if (count >= limite) {
    return { ok: false, restanteSeg: Math.ceil((expira - agora) / 1000) };
  }

  await db
    .prepare(
      `INSERT INTO rate_limits (chave, valor, expira_em) VALUES (?, ?, ?)
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, expira_em = excluded.expira_em`
    )
    .bind(chave, String(count + 1), expira)
    .run();

  return { ok: true };
}

export async function verificarRateLimitBusca(db, ipHash) {
  // 35 buscas por minuto por IP (comporta bem o Wi-Fi do bar + cache de 5 min)
  return consumirContador(db, `busca:${ipHash}`, 35, 60_000);
}

/* ─────────────── Sincronização com Spotify & Feeder Just-in-Time (1 música por vez) ─────────────── */

export async function sincronizarPlayer(env, { forcar = false, tentarInjetar = false } = {}) {
  const db = env.DB;
  const cfg = await garantirNoiteAtual(db);
  const auth = await obterAuthSalva(db);
  const conectado = Boolean(auth && auth.refresh_token);

  if (!conectado) {
    return {
      conectado: false,
      nowPlaying: null,
      injetou: null,
    };
  }

  let nowPlaying = forcar ? null : await lerCache(db, 'now_playing', true);
  if (!nowPlaying) {
    try {
      nowPlaying = await buscarTocandoAgora(env);
      await gravarCache(db, 'now_playing', nowPlaying, CACHE_TTL_NOW_PLAYING, true);
    } catch {
      nowPlaying = { ativo: false, tocando: false, faixa: null, progressoMs: 0 };
    }
  }

  const agora = Date.now();
  const noite = cfg.noiteAtual;
  const tocandoId = nowPlaying?.faixa?.trackId || null;

  // Libera travas presas em 'enviando' (> 30s) caso uma requisição anterior tenha caído no meio.
  await db
    .prepare(
      `UPDATE fila
       SET status = 'pendente', enviada_em = NULL
       WHERE noite = ? AND status = 'enviando' AND COALESCE(enviada_em, 0) < ?`
    )
    .bind(noite, agora - 30_000)
    .run();

  // 1. Atualiza estado de faixas 'tocando' e 'enviada'
  const emAndamento = await db
    .prepare(
      `SELECT id, track_id, status, enviada_em, duracao_ms
       FROM fila
       WHERE noite = ? AND status IN ('enviando', 'enviada', 'tocando')
       ORDER BY criado_em ASC`
    )
    .bind(noite)
    .all();

  let temEnviada = false;
  for (const item of emAndamento.results || []) {
    if (item.status === 'tocando') {
      if (!tocandoId || tocandoId !== item.track_id) {
        await db
          .prepare("UPDATE fila SET status = 'tocada', tocada_em = ? WHERE id = ?")
          .bind(agora, item.id)
          .run();
      }
    } else if (item.status === 'enviando') {
      temEnviada = true;
    } else if (item.status === 'enviada') {
      if (tocandoId && tocandoId === item.track_id) {
        await db
          .prepare("UPDATE fila SET status = 'tocando', tocada_em = ? WHERE id = ?")
          .bind(agora, item.id)
          .run();
      } else if (item.enviada_em && agora - item.enviada_em > 12 * 60_000) {
        // Evita travar a fila caso o DJ tenha trocado de playlist/pulado manualmente no app do Spotify.
        await db
          .prepare("UPDATE fila SET status = 'tocada', tocada_em = ? WHERE id = ?")
          .bind(agora, item.id)
          .run();
      } else {
        temEnviada = true;
      }
    }
  }

  // 2. Reserva ATÔMICA no SQLite: mesmo com 2+ clientes clicando no mesmo milissegundo,
  //    apenas 1 consegue mudar a próxima faixa para 'enviando' e chamar a API do Spotify.
  let injetou = null;
  if (tentarInjetar && cfg.ativo && !temEnviada && nowPlaying?.tocando && nowPlaying?.faixa) {
    const reservada = await db
      .prepare(
        `UPDATE fila
         SET status = 'enviando', enviada_em = ?
         WHERE id = (
           SELECT id FROM fila
           WHERE noite = ? AND status = 'pendente'
             AND NOT EXISTS (
               SELECT 1 FROM fila
               WHERE noite = ? AND status IN ('enviada', 'enviando')
             )
           ORDER BY criado_em ASC
           LIMIT 1
         )
         RETURNING id, uri, nome, artistas, track_id`
      )
      .bind(agora, noite, noite)
      .first();

    if (reservada) {
      const res = await adicionarNaFilaSpotify(env, reservada.uri);
      if (res.ok) {
        await db
          .prepare("UPDATE fila SET status = 'enviada', enviada_em = ? WHERE id = ? AND status = 'enviando'")
          .bind(Date.now(), reservada.id)
          .run();
        await invalidarCache(db, 'now_playing');
        injetou = { id: reservada.id, nome: reservada.nome, artistas: reservada.artistas };
      } else {
        // Falhou no Spotify (ex.: player pausado/sem dispositivo) -> devolve para 'pendente'.
        await db
          .prepare("UPDATE fila SET status = 'pendente', enviada_em = NULL WHERE id = ? AND status = 'enviando'")
          .bind(reservada.id)
          .run();
      }
    }
  }

  return {
    conectado: true,
    nowPlaying,
    injetou,
  };
}

/* ─────────────── Consulta da Fila + Estado Público ─────────────── */

export async function montarEstadoPublico(env, clienteHash, { forcar = false } = {}) {
  const db = env.DB;
  const cfg = await garantirNoiteAtual(db);
  const auth = await obterAuthSalva(db);
  const sync = await sincronizarPlayer(env, { forcar, tentarInjetar: true });

  const filaRes = await db
    .prepare(
      `SELECT id, track_id, nome, artistas, artista_principal_id, album, capa, duracao_ms, pedido_por, status, criado_em, enviada_em
       FROM fila
       WHERE noite = ? AND status IN ('enviada', 'enviando', 'pendente')
       ORDER BY CASE status WHEN 'enviada' THEN 0 WHEN 'enviando' THEN 0 ELSE 1 END, criado_em ASC`
    )
    .bind(cfg.noiteAtual)
    .all();

  // Cooldown restante e verificação se este aparelho foi bloqueado pela equipe
  let cooldownRestanteSeg = 0;
  let clienteBloqueado = false;
  if (clienteHash) {
    const bloqCli = await db
      .prepare('SELECT 1 FROM clientes_bloqueados WHERE cliente_hash = ? LIMIT 1')
      .bind(clienteHash)
      .first();
    clienteBloqueado = Boolean(bloqCli);
  }
  if (!clienteBloqueado && clienteHash && cfg.cooldownMin > 0) {
    const ultimo = await db
      .prepare(
        `SELECT criado_em FROM fila
         WHERE noite = ? AND cliente_hash = ? AND status != 'removida'
         ORDER BY criado_em DESC LIMIT 1`
      )
      .bind(cfg.noiteAtual, clienteHash)
      .first();
    if (ultimo) {
      const liberaEm = Number(ultimo.criado_em) + cfg.cooldownMin * 60_000;
      cooldownRestanteSeg = Math.max(0, Math.ceil((liberaEm - Date.now()) / 1000));
    }
  }

  const totalCatalogo =
    cfg.modo === 'playlists'
      ? Number((await db.prepare('SELECT COUNT(*) AS n FROM catalogo_faixas').first())?.n || 0)
      : 0;

  const filaFormatada = (filaRes.results || []).map((r, idx) => ({
    id: r.id,
    posicao: idx + 1,
    trackId: r.track_id,
    nome: r.nome,
    artistas: r.artistas,
    artistaPrincipalId: r.artista_principal_id,
    album: r.album,
    capa: r.capa,
    duracaoMs: r.duracao_ms,
    pedidoPor: r.pedido_por,
    status: r.status, // 'enviada' (próxima no som) | 'pendente' (aguardando)
    criadoEm: r.criado_em,
  }));

  const idsNaFila = new Set(filaFormatada.map((x) => x.trackId));
  const proximasSpotify = (sync.nowPlaying?.proximas || [])
    .filter((f) => f && !idsNaFila.has(f.trackId))
    .slice(0, 5)
    .map((f) => ({
      trackId: f.trackId,
      nome: f.nome,
      artistas: f.artistas,
      capa: f.capa,
      duracaoMs: f.duracaoMs,
    }));

  return {
    conectado: Boolean(auth && auth.refresh_token),
    ativo: cfg.ativo,
    controle: cfg.controle,
    modo: cfg.modo,
    exigirGps: cfg.exigirGps,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
    regras: {
      cooldownMin: cfg.cooldownMin,
      maxFila: cfg.maxFila,
      minDuracaoSeg: cfg.minDuracaoSeg,
      maxDuracaoSeg: cfg.maxDuracaoSeg,
      limitarDuracao: cfg.limitarDuracao,
      repeticaoHoras: cfg.repeticaoHoras,
      maxMesmoArtista: cfg.maxMesmoArtista,
    },
    playlists: cfg.modo === 'playlists' ? cfg.playlists : [],
    totalCatalogo,
    noiteAtual: cfg.noiteAtual,
    proximoResetEm: proximoReset12hBRT(),
    cooldownRestanteSeg,
    clienteBloqueado,
    tocandoAgora: sync.nowPlaying,
    fila: filaFormatada,
    proximasSpotify,
  };
}

/* ─────────────── Busca (Spotify aberto OU Catálogo das Playlists) ─────────────── */

export async function buscarMusicas(env, termo, playlistId = '') {
  const db = env.DB;
  const cfg = await garantirNoiteAtual(db);

  // Carrega bloqueios para já ocultar/marcar resultados bloqueados.
  const bloqRes = await db.prepare('SELECT tipo, spotify_id FROM bloqueios').all();
  const tracksBloq = new Set();
  const artistasBloq = new Set();
  for (const b of bloqRes.results || []) {
    if (b.tipo === 'track') tracksBloq.add(b.spotify_id);
    if (b.tipo === 'artist') artistasBloq.add(b.spotify_id);
  }

  const norm = normalizarTexto(termo);

  if (cfg.modo === 'playlists') {
    let rows;
    if (playlistId) {
      if (norm.length >= 1) {
        rows = await db
          .prepare(
            `SELECT * FROM catalogo_faixas
             WHERE playlist_id = ? AND busca_norm LIKE ?
             ORDER BY nome ASC LIMIT 40`
          )
          .bind(playlistId, `%${norm}%`)
          .all();
      } else {
        rows = await db
          .prepare('SELECT * FROM catalogo_faixas WHERE playlist_id = ? ORDER BY nome ASC LIMIT 40')
          .bind(playlistId)
          .all();
      }
    } else if (norm.length >= 1) {
      rows = await db
        .prepare('SELECT * FROM catalogo_faixas WHERE busca_norm LIKE ? ORDER BY nome ASC LIMIT 40')
        .bind(`%${norm}%`)
        .all();
    } else {
      rows = await db.prepare('SELECT * FROM catalogo_faixas ORDER BY playlist_nome ASC, nome ASC LIMIT 40').all();
    }

    const minMs = cfg.minDuracaoSeg * 1000;
    const maxMs = cfg.maxDuracaoSeg * 1000;
    return (rows.results || [])
      .filter((r) => {
        if (tracksBloq.has(r.track_id) || artistasBloq.has(r.artista_principal_id)) return false;
        if (cfg.limitarDuracao && (r.duracao_ms < minMs || r.duracao_ms > maxMs)) return false;
        return true;
      })
      .map((r) => ({
        trackId: r.track_id,
        uri: r.uri,
        nome: r.nome,
        artistas: r.artistas,
        artistaPrincipalId: r.artista_principal_id,
        album: r.album,
        capa: r.capa,
        duracaoMs: r.duracao_ms,
        playlistId: r.playlist_id,
        playlistNome: r.playlist_nome,
      }));
  }

  // Modo 'aberto' — busca no Spotify com cache de 5 minutos e filtro imediato de duração/blocklist.
  if (norm.length < 2) return [];

  const chaveCache = `search:${norm}`;
  let brutos = await lerCache(db, chaveCache, true);
  if (!brutos) {
    brutos = await pesquisarFaixasSpotify(env, termo);
    await gravarCache(db, chaveCache, brutos, CACHE_TTL_BUSCA, true);
  }

  const minMs = cfg.minDuracaoSeg * 1000;
  const maxMs = cfg.maxDuracaoSeg * 1000;

  return brutos.filter((f) => {
    if (tracksBloq.has(f.trackId)) return false;
    if ((f.artistaIds || [f.artistaPrincipalId]).some((aid) => artistasBloq.has(aid))) return false;
    if (cfg.bloquearExplicito && f.explicito) return false;
    if (cfg.limitarDuracao && (f.duracaoMs < minMs || f.duracaoMs > maxMs)) return false;
    return true;
  });
}

/* ─────────────── Pedir Música (todas as travas server-side) ─────────────── */

export async function processarPedidoMusica(env, { trackId, pedidoPor, geo, cliente, ipHash, userAgent = '', cf = null }) {
  const db = env.DB;
  const cfg = await garantirNoiteAtual(db);

  if (!cfg.ativo) {
    return { ok: false, status: 403, erro: 'Os pedidos de música estão pausados agora.' };
  }

  // Verifica se este aparelho foi bloqueado pela equipe
  if (cliente?.clienteHash) {
    const bloqCli = await db
      .prepare('SELECT 1 FROM clientes_bloqueados WHERE cliente_hash = ? LIMIT 1')
      .bind(cliente.clienteHash)
      .first();
    if (bloqCli) {
      return {
        ok: false,
        status: 403,
        erro: 'Você foi bloqueado de escolher músicas. Entenda o motivo no balcão.',
      };
    }
  }

  const auth = await obterAuthSalva(db);
  if (!auth || !auth.refresh_token) {
    return { ok: false, status: 503, erro: 'O Spotify do bar ainda não está conectado.' };
  }

  if (!trackId || !/^[A-Za-z0-9]{10,40}$/.test(trackId)) {
    return { ok: false, status: 400, erro: 'Música inválida.' };
  }

  // Nome obrigatório (aparece na fila pública para todos e no log do /adm)
  const nomeLimpo = String(pedidoPor || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  if (nomeLimpo.length < 2) {
    return { ok: false, status: 400, erro: 'Informe seu nome (mínimo 2 letras) para pedir uma música.' };
  }

  // 1. GPS no servidor
  const gpsOk = await validarGps(geo, cfg, env);
  if (!gpsOk.ok) return gpsOk;

  // 2. Rate limit anti-flood / anti-aba-anônima (seguro para Wi-Fi do bar)
  if (cliente.novo) {
    const rlNovo = await consumirContador(db, `novo_ip:${ipHash}`, 3, 5 * 60_000);
    if (!rlNovo.ok) {
      return {
        ok: false,
        status: 429,
        erro: 'Muitos pedidos novos vindos desta rede. Aguarde alguns minutos para pedir.',
      };
    }
  }
  const rlIp = await consumirContador(db, `pedir_ip:${ipHash}`, 15, 10 * 60_000);
  if (!rlIp.ok) {
    return {
      ok: false,
      status: 429,
      erro: 'A fila está bem movimentada agora. Tente novamente em instantes.',
    };
  }

  const agora = Date.now();
  const noite = cfg.noiteAtual;

  // 3. Cooldown por cliente (cookie HttpOnly assinado)
  if (cfg.cooldownMin > 0) {
    const ultimo = await db
      .prepare(
        `SELECT criado_em FROM fila
         WHERE noite = ? AND cliente_hash = ? AND status != 'removida'
         ORDER BY criado_em DESC LIMIT 1`
      )
      .bind(noite, cliente.clienteHash)
      .first();

    if (ultimo) {
      const faltaMs = Number(ultimo.criado_em) + cfg.cooldownMin * 60_000 - agora;
      if (faltaMs > 0) {
        const min = Math.ceil(faltaMs / 60_000);
        return {
          ok: false,
          status: 429,
          erro: `Você já pediu uma música há pouco. Aguarde ${min} min para pedir outra.`,
          cooldownRestanteSeg: Math.ceil(faltaMs / 1000),
        };
      }
    }
  }

  // 4. Limite da fila ativa (inclui pendentes, enviando, enviadas e aguardando aprovação)
  const filaAtivaRes = await db
    .prepare(
      `SELECT id, track_id, artista_principal_id, status
       FROM fila
       WHERE noite = ? AND status IN ('enviada', 'enviando', 'pendente', 'aguardando')
       ORDER BY CASE status WHEN 'enviada' THEN 0 WHEN 'enviando' THEN 0 WHEN 'pendente' THEN 1 ELSE 2 END, criado_em ASC`
    )
    .bind(noite)
    .all();
  const filaAtiva = filaAtivaRes.results || [];

  if (filaAtiva.length >= cfg.maxFila) {
    return {
      ok: false,
      status: 409,
      erro: `A fila atingiu o limite de ${cfg.maxFila} músicas. Tente de novo daqui a pouco.`,
    };
  }

  // 5. Busca metadados REAIS da faixa no servidor (nunca confia em dados do cliente)
  let faixa = null;
  if (cfg.modo === 'playlists') {
    const cat = await db.prepare('SELECT * FROM catalogo_faixas WHERE track_id = ?').bind(trackId).first();
    if (!cat) {
      return {
        ok: false,
        status: 403,
        erro: 'Hoje só estão liberadas as músicas das playlists da casa.',
      };
    }
    faixa = {
      trackId: cat.track_id,
      uri: cat.uri,
      nome: cat.nome,
      artistas: cat.artistas,
      artistaIds: [cat.artista_principal_id],
      artistaPrincipalId: cat.artista_principal_id,
      album: cat.album,
      capa: cat.capa,
      duracaoMs: Number(cat.duracao_ms || 0),
      explicito: Boolean(cat.explicito),
    };
  } else {
    faixa = await buscarFaixaSpotify(env, trackId);
    if (!faixa) {
      return { ok: false, status: 404, erro: 'Música não encontrada no Spotify.' };
    }
  }

  // 6. Filtros anti-zoeira (blocklist, duração, explícito)
  const artistasCheck = (faixa.artistaIds?.length ? faixa.artistaIds : [faixa.artistaPrincipalId]).filter(Boolean);
  const bloq = await db
    .prepare(
      `SELECT tipo, nome FROM bloqueios
       WHERE (tipo = 'track' AND spotify_id = ?)
          OR (tipo = 'artist' AND spotify_id IN (${artistasCheck.map(() => '?').join(',') || "''"}))
       LIMIT 1`
    )
    .bind(faixa.trackId, ...artistasCheck)
    .first();

  if (bloq) {
    return {
      ok: false,
      status: 403,
      erro: 'Essa música ou artista não está liberada no som do Rainbow.',
    };
  }

  if (cfg.limitarDuracao) {
    if (faixa.duracaoMs < cfg.minDuracaoSeg * 1000) {
      return { ok: false, status: 400, erro: 'Essa faixa é curta demais para entrar na fila.' };
    }
    if (faixa.duracaoMs > cfg.maxDuracaoSeg * 1000) {
      const m = Math.floor(cfg.maxDuracaoSeg / 60);
      const s = cfg.maxDuracaoSeg % 60;
      const txt = s ? `${m}m${String(s).padStart(2, '0')}s` : `${m} min`;
      return {
        ok: false,
        status: 400,
        erro: `Músicas maiores que ${txt} estão bloqueadas na fila do bar.`,
      };
    }
  }
  if (cfg.modo === 'aberto' && cfg.bloquearExplicito && faixa.explicito) {
    return { ok: false, status: 403, erro: 'Faixas com selo explícito estão bloqueadas agora.' };
  }

  // 7. Anti-repetição (já está tocando, na fila ou tocou nas últimas N horas)
  const nowPlaying = await lerCache(db, 'now_playing');
  if (nowPlaying?.faixa?.trackId === faixa.trackId) {
    return { ok: false, status: 409, erro: 'Essa música já está tocando agora!' };
  }
  if (filaAtiva.some((x) => x.track_id === faixa.trackId)) {
    return { ok: false, status: 409, erro: 'Essa música já está na fila.' };
  }

  const corteRep = agora - cfg.repeticaoHoras * 3600_000;
  const repetida = await db
    .prepare(
      `SELECT id FROM fila
       WHERE noite = ? AND track_id = ? AND status IN ('tocando', 'tocada') AND criado_em >= ?
       LIMIT 1`
    )
    .bind(noite, faixa.trackId, corteRep)
    .first();
  if (repetida) {
    return {
      ok: false,
      status: 409,
      erro: `Essa música já tocou recentemente. Escolha outra para variar o som!`,
    };
  }

  // 8. Limite do mesmo artista na fila + evita empilhar 2 seguidas do mesmo artista
  if (faixa.artistaPrincipalId) {
    const qtdMesmoArtista = filaAtiva.filter((x) => x.artista_principal_id === faixa.artistaPrincipalId).length;
    if (qtdMesmoArtista >= cfg.maxMesmoArtista) {
      return {
        ok: false,
        status: 409,
        erro: 'Já tem música desse artista na fila. Escolha outro artista para variar!',
      };
    }
    const ultimaNaFila = filaAtiva[filaAtiva.length - 1];
    if (ultimaNaFila && ultimaNaFila.artista_principal_id === faixa.artistaPrincipalId) {
      return {
        ok: false,
        status: 409,
        erro: 'A última música pedida já é desse artista. Escolha outro para misturar!',
      };
    }
  }

  // 9. Inserção ATÔMICA no SQLite: valida max_fila, max_mesmo_artista, cooldown e duplicata no momento do INSERT.
  const id = idAleatorio(10);
  const statusInicial = cfg.controle === 'aprovacao' ? 'aguardando' : 'pendente';
  const corteCooldown = cfg.cooldownMin > 0 ? agora - cfg.cooldownMin * 60_000 : 0;
  const dispositivo = parseDispositivo(userAgent);
  const metaJson = JSON.stringify({
    aparelhoId: String(cliente.clienteHash || '').slice(0, 6).toUpperCase(),
    distanciaM: typeof gpsOk.distanciaM === 'number' ? gpsOk.distanciaM : null,
    precisaoGps: typeof geo?.precisao === 'number' && Number.isFinite(geo.precisao) ? Math.round(geo.precisao) : null,
    operadora: String(cf?.asOrganization || '').slice(0, 48),
    cidade: String(cf?.city || '').slice(0, 40),
  });

  let inserido;
  try {
    inserido = await db
      .prepare(
        `INSERT INTO fila (
           id, noite, track_id, uri, nome, artistas, artista_principal_id,
           album, capa, duracao_ms, pedido_por, cliente_hash, ip_hash,
           dispositivo, meta_json, status, criado_em
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM fila WHERE noite = ? AND status IN ('enviada', 'enviando', 'pendente', 'aguardando')) < ?
           AND (? = '' OR (SELECT COUNT(*) FROM fila WHERE noite = ? AND status IN ('enviada', 'enviando', 'pendente', 'aguardando') AND artista_principal_id = ?) < ?)
           AND (? = 0 OR NOT EXISTS (SELECT 1 FROM fila WHERE noite = ? AND cliente_hash = ? AND status != 'removida' AND criado_em > ?))`
      )
      .bind(
        id,
        noite,
        faixa.trackId,
        faixa.uri,
        faixa.nome,
        faixa.artistas,
        faixa.artistaPrincipalId || '',
        faixa.album || '',
        faixa.capa || '',
        faixa.duracaoMs || 0,
        nomeLimpo,
        cliente.clienteHash,
        ipHash,
        dispositivo,
        metaJson,
        statusInicial,
        agora,
        // Condições atômicas:
        noite,
        cfg.maxFila,
        faixa.artistaPrincipalId || '',
        noite,
        faixa.artistaPrincipalId || '',
        cfg.maxMesmoArtista,
        corteCooldown,
        noite,
        cliente.clienteHash,
        corteCooldown
      )
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || ''))) {
      return { ok: false, status: 409, erro: 'Essa música já acabou de entrar na fila.' };
    }
    throw err;
  }

  if (!inserido?.meta?.changes) {
    return {
      ok: false,
      status: 409,
      erro: 'Alguém pediu no mesmo instante e atingiu um limite da fila. Tente outra música!',
    };
  }

  let enviadaAgora = false;
  if (statusInicial === 'pendente') {
    const sync = await sincronizarPlayer(env, { forcar: true, tentarInjetar: true });
    enviadaAgora = sync.injetou?.id === id;
  }

  const posRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM fila
       WHERE noite = ? AND status IN ('enviada', 'enviando', 'pendente') AND criado_em <= ?`
    )
    .bind(noite, agora)
    .first();

  return {
    ok: true,
    item: {
      id,
      posicao: Math.max(1, Number(posRow?.n || 1)),
      status: enviadaAgora ? 'enviada' : statusInicial,
      aguardandoAprovacao: statusInicial === 'aguardando',
      trackId: faixa.trackId,
      nome: faixa.nome,
      artistas: faixa.artistas,
      capa: faixa.capa,
      pedidoPor: nomeLimpo,
      cooldownRestanteSeg: cfg.cooldownMin * 60,
    },
  };
}

/* ─────────────── Sincronização do Catálogo de Playlists (Modo Playlists) ─────────────── */

export async function sincronizarPlaylistsPermitidas(env, playlistsSelecionadas) {
  const db = env.DB;
  const lista = Array.isArray(playlistsSelecionadas) ? playlistsSelecionadas.slice(0, 12) : [];
  const agora = Date.now();

  const faixasUnicas = new Map();
  const resumo = [];

  for (const pl of lista) {
    if (!pl?.id) continue;
    const itens = await buscarFaixasDePlaylist(env, pl.id);
    resumo.push({
      id: String(pl.id),
      nome: String(pl.nome || 'Playlist'),
      imagem: String(pl.imagem || ''),
      total: itens.length,
    });
    for (const f of itens) {
      if (!faixasUnicas.has(f.trackId)) {
        faixasUnicas.set(f.trackId, {
          ...f,
          playlistId: String(pl.id),
          playlistNome: String(pl.nome || 'Playlist'),
        });
      }
    }
  }

  // Substitui o catálogo de forma limpa em lotes pequenos (limite D1 batch)
  await db.prepare('DELETE FROM catalogo_faixas').run();

  const todas = [...faixasUnicas.values()];
  const stmts = [];
  for (const f of todas) {
    const buscaNorm = normalizarTexto(`${f.nome} ${f.artistas} ${f.album} ${f.playlistNome}`);
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO catalogo_faixas (
             track_id, uri, nome, artistas, artista_principal_id, album, capa,
             duracao_ms, explicito, playlist_id, playlist_nome, busca_norm, atualizado_em
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          f.trackId,
          f.uri,
          f.nome,
          f.artistas,
          f.artistaPrincipalId || '',
          f.album || '',
          f.capa || '',
          f.duracaoMs || 0,
          f.explicito ? 1 : 0,
          f.playlistId,
          f.playlistNome,
          buscaNorm,
          agora
        )
    );
  }

  // Executa em blocos de 80 statements
  for (let i = 0; i < stmts.length; i += 80) {
    await db.batch(stmts.slice(i, i + 80));
  }

  await db
    .prepare('UPDATE config SET playlists_json = ?, atualizado_em = ? WHERE id = 1')
    .bind(JSON.stringify(resumo), agora)
    .run();

  return {
    playlists: resumo,
    totalFaixas: todas.length,
  };
}
