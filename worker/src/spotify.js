// Cliente Spotify Web API (compatível com as mudanças de 2026: limit=10 na busca,
// /playlists/{id}/items com fallback para /tracks, refresh automático de token).

const SPOTIFY_API = 'https://api.spotify.com/v1';
const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';

export const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

export function normalizarTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatarFaixa(t) {
  if (!t || t.type !== 'track' || !t.id) return null;
  const artistasArr = Array.isArray(t.artists) ? t.artists : [];
  const imagens = Array.isArray(t.album?.images) ? t.album.images : [];
  // Pega imagem média (~300px) para carregar rápido no 4G do bar.
  const capa = imagens[1]?.url || imagens[0]?.url || imagens[imagens.length - 1]?.url || '';
  return {
    trackId: t.id,
    uri: t.uri || `spotify:track:${t.id}`,
    nome: String(t.name || ''),
    artistas: artistasArr.map((a) => a.name).filter(Boolean).join(', ') || 'Artista desconhecido',
    artistaIds: artistasArr.map((a) => a.id).filter(Boolean),
    artistaPrincipalId: artistasArr[0]?.id || '',
    album: String(t.album?.name || ''),
    capa,
    duracaoMs: Number(t.duration_ms || 0),
    explicito: Boolean(t.explicit),
  };
}

export function montarUrlOAuth(env, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.SPOTIFY_CLIENT_ID || '',
    scope: SPOTIFY_SCOPES,
    redirect_uri: env.SPOTIFY_REDIRECT_URI || `${env.SITE_ORIGIN}/api/musica/oauth/callback`,
    state,
    show_dialog: 'true',
  });
  return `${SPOTIFY_ACCOUNTS}/authorize?${params.toString()}`;
}

async function pedirTokenSpotify(env, bodyParams) {
  const cred = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${cred}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: bodyParams.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `Spotify token HTTP ${res.status}`);
  }
  return json;
}

export async function trocarCodigoPorTokens(env, code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.SPOTIFY_REDIRECT_URI || `${env.SITE_ORIGIN}/api/musica/oauth/callback`,
  });
  return pedirTokenSpotify(env, params);
}

export async function obterAuthSalva(db) {
  return db.prepare('SELECT * FROM spotify_auth WHERE id = 1').first();
}

export async function salvarAuthSpotify(db, dados) {
  await db
    .prepare(
      `INSERT INTO spotify_auth (id, access_token, refresh_token, expires_at, user_id, display_name, email, product, conectado_em)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = CASE WHEN excluded.refresh_token != '' THEN excluded.refresh_token ELSE spotify_auth.refresh_token END,
         expires_at = excluded.expires_at,
         user_id = excluded.user_id,
         display_name = excluded.display_name,
         email = excluded.email,
         product = excluded.product,
         conectado_em = excluded.conectado_em`
    )
    .bind(
      dados.accessToken || '',
      dados.refreshToken || '',
      dados.expiresAt || 0,
      dados.userId || '',
      dados.displayName || '',
      dados.email || '',
      dados.product || '',
      dados.conectadoEm || Date.now()
    )
    .run();
}

export async function desconectarSpotify(db) {
  await db.prepare('DELETE FROM spotify_auth WHERE id = 1').run();
  await db.prepare("DELETE FROM cache_estado WHERE chave = 'now_playing'").run();
}

export async function obterAccessTokenValido(env) {
  const auth = await obterAuthSalva(env.DB);
  if (!auth || !auth.refresh_token) return null;

  const agora = Date.now();
  if (auth.access_token && auth.expires_at > agora + 60_000) {
    return auth.access_token;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
  });
  const novo = await pedirTokenSpotify(env, params);
  const expiresAt = agora + Number(novo.expires_in || 3600) * 1000;

  await env.DB
    .prepare(
      `UPDATE spotify_auth
       SET access_token = ?,
           refresh_token = CASE WHEN ? != '' THEN ? ELSE refresh_token END,
           expires_at = ?
       WHERE id = 1`
    )
    .bind(novo.access_token, novo.refresh_token || '', novo.refresh_token || '', expiresAt)
    .run();

  return novo.access_token;
}

export async function spotifyFetch(env, path, opts = {}, tokenExplicito = null) {
  const token = tokenExplicito || (await obterAccessTokenValido(env));
  if (!token) {
    const err = new Error('Spotify não está conectado.');
    err.codigo = 'SPOTIFY_DESCONECTADO';
    throw err;
  }

  const url = path.startsWith('http') ? path : `${SPOTIFY_API}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });

  if (res.status === 204) return { ok: true, status: 204, data: null };
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

export async function buscarPerfil(env, tokenExplicito = null) {
  const r = await spotifyFetch(env, '/me', {}, tokenExplicito);
  if (!r.ok) throw new Error(r.data?.error?.message || `Erro /me (${r.status})`);
  return r.data;
}

export async function buscarTocandoAgora(env) {
  const [rNow, rQueue] = await Promise.all([
    spotifyFetch(env, '/me/player/currently-playing?market=BR&additional_types=track'),
    spotifyFetch(env, '/me/player/queue').catch(() => ({ ok: false, data: null })),
  ]);

  const proximas = [];
  if (rQueue?.ok && Array.isArray(rQueue.data?.queue)) {
    const vistos = new Set();
    for (const item of rQueue.data.queue) {
      const f = formatarFaixa(item);
      if (!f || vistos.has(f.trackId)) continue;
      vistos.add(f.trackId);
      proximas.push(f);
      if (proximas.length >= 6) break;
    }
  }

  if (rNow.status === 204 || !rNow.data) {
    return { ativo: false, tocando: false, faixa: null, progressoMs: 0, proximas };
  }
  if (!rNow.ok) {
    if (rNow.status === 401 || rNow.status === 403) {
      return { ativo: false, tocando: false, faixa: null, progressoMs: 0, proximas, erro: rNow.data?.error?.message || `HTTP ${rNow.status}` };
    }
    return { ativo: false, tocando: false, faixa: null, progressoMs: 0, proximas };
  }
  const faixa = rNow.data.item?.type === 'track' ? formatarFaixa(rNow.data.item) : null;
  return {
    ativo: true,
    tocando: Boolean(rNow.data.is_playing),
    faixa,
    progressoMs: Number(rNow.data.progress_ms || 0),
    proximas,
    consultadoEm: Date.now(),
  };
}

export async function adicionarNaFilaSpotify(env, uri) {
  const r = await spotifyFetch(env, `/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST' });
  if (!r.ok) {
    const motivo = r.data?.error?.reason || r.data?.error?.message || `HTTP ${r.status}`;
    return { ok: false, status: r.status, motivo };
  }
  return { ok: true };
}

export async function pularMusicaSpotify(env) {
  const r = await spotifyFetch(env, '/me/player/next', { method: 'POST' });
  if (!r.ok) {
    return { ok: false, status: r.status, erro: r.data?.error?.message || `Erro ao pular (${r.status})` };
  }
  return { ok: true };
}

export async function buscarFaixaSpotify(env, trackId) {
  const r = await spotifyFetch(env, `/tracks/${encodeURIComponent(trackId)}?market=BR`);
  if (!r.ok || !r.data) return null;
  return formatarFaixa(r.data);
}

// Spotify Dev Mode 2026: máximo de 10 resultados por requisição em /v1/search.
export async function pesquisarFaixasSpotify(env, termo) {
  const q = String(termo || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  const url = `/search?type=track&market=BR&limit=10&q=${encodeURIComponent(q)}`;
  const r = await spotifyFetch(env, url);
  if (!r.ok) {
    throw new Error(r.data?.error?.message || `Erro na busca do Spotify (${r.status})`);
  }
  const items = r.data?.tracks?.items || [];
  return items.map(formatarFaixa).filter(Boolean);
}

export async function listarPlaylistsUsuario(env) {
  const auth = await obterAuthSalva(env.DB);
  const out = [];
  let url = '/me/playlists?limit=50';
  let paginas = 0;

  while (url && paginas < 4) {
    const r = await spotifyFetch(env, url);
    if (!r.ok) throw new Error(r.data?.error?.message || `Erro ao listar playlists (${r.status})`);
    const items = r.data?.items || [];
    for (const pl of items) {
      if (!pl || !pl.id) continue;
      // Em 2026 o Spotify só libera os itens de playlists próprias ou colaborativas.
      const propriaOuColab = !auth?.user_id || pl.owner?.id === auth.user_id || pl.collaborative;
      if (!propriaOuColab) continue;
      out.push({
        id: pl.id,
        nome: String(pl.name || 'Sem nome'),
        imagem: pl.images?.[0]?.url || '',
        total: Number(pl.items?.total ?? pl.tracks?.total ?? 0),
        colaborativa: Boolean(pl.collaborative),
      });
    }
    url = r.data?.next || null;
    paginas++;
  }
  return out;
}

export async function buscarFaixasDePlaylist(env, playlistId) {
  const faixas = [];
  // Endpoint 2026: /playlists/{id}/items (com fallback para /tracks se necessário).
  let url = `/playlists/${encodeURIComponent(playlistId)}/items?market=BR&limit=100`;
  let tentouFallback = false;
  let paginas = 0;

  while (url && paginas < 10) {
    let r = await spotifyFetch(env, url);
    if (!r.ok && r.status === 404 && !tentouFallback && url.includes('/items')) {
      tentouFallback = true;
      url = `/playlists/${encodeURIComponent(playlistId)}/tracks?market=BR&limit=100`;
      r = await spotifyFetch(env, url);
    }
    if (!r.ok) {
      throw new Error(r.data?.error?.message || `Erro ao ler playlist (${r.status})`);
    }
    const items = r.data?.items || [];
    for (const entry of items) {
      const bruto = entry?.item || entry?.track;
      const f = formatarFaixa(bruto);
      if (f) faixas.push(f);
    }
    url = r.data?.next || null;
    paginas++;
  }
  return faixas;
}
