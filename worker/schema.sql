-- Rainbow Pub Música — esquema D1 (SQLite)
-- Aplicar local:  npx wrangler d1 execute rainbowpub-musica --local --file=./schema.sql
-- Aplicar remoto: npx wrangler d1 execute rainbowpub-musica --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ativo INTEGER NOT NULL DEFAULT 1,
  controle TEXT NOT NULL DEFAULT 'liberado', -- 'liberado' | 'aprovacao' | 'desativado'
  modo TEXT NOT NULL DEFAULT 'aberto', -- 'aberto' | 'playlists'
  cooldown_min INTEGER NOT NULL DEFAULT 5,
  max_fila INTEGER NOT NULL DEFAULT 15,
  max_mesmo_artista INTEGER NOT NULL DEFAULT 1,
  min_duracao_seg INTEGER NOT NULL DEFAULT 90,
  max_duracao_seg INTEGER NOT NULL DEFAULT 240,
  limitar_duracao INTEGER NOT NULL DEFAULT 1,
  repeticao_horas INTEGER NOT NULL DEFAULT 3,
  exigir_gps INTEGER NOT NULL DEFAULT 1,
  bloquear_explicito INTEGER NOT NULL DEFAULT 0,
  playlists_json TEXT NOT NULL DEFAULT '[]',
  noite_atual TEXT NOT NULL DEFAULT '',
  ultimo_reset_em INTEGER NOT NULL DEFAULT 0,
  atualizado_em INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO config (id, ativo, modo) VALUES (1, 1, 'aberto');

-- Credenciais OAuth da conta Spotify Premium da Carol (nunca expostas ao navegador).
CREATE TABLE IF NOT EXISTS spotify_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  user_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  conectado_em INTEGER NOT NULL DEFAULT 0
);

-- Fila controlada da noite. Status: pendente -> enviada -> tocando -> tocada | removida
CREATE TABLE IF NOT EXISTS fila (
  id TEXT PRIMARY KEY,
  noite TEXT NOT NULL,
  track_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  nome TEXT NOT NULL,
  artistas TEXT NOT NULL,
  artista_principal_id TEXT NOT NULL,
  album TEXT NOT NULL DEFAULT '',
  capa TEXT NOT NULL DEFAULT '',
  duracao_ms INTEGER NOT NULL DEFAULT 0,
  pedido_por TEXT NOT NULL DEFAULT '',
  cliente_hash TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  dispositivo TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pendente',
  criado_em INTEGER NOT NULL,
  enviada_em INTEGER,
  tocada_em INTEGER
);

CREATE INDEX IF NOT EXISTS idx_fila_noite_status ON fila (noite, status, criado_em);
CREATE INDEX IF NOT EXISTS idx_fila_track_noite ON fila (noite, track_id);
CREATE INDEX IF NOT EXISTS idx_fila_cliente ON fila (noite, cliente_hash, criado_em);
-- Garante no banco que a mesma música não entra 2x ativa mesmo com 2 cliques no mesmo milissegundo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fila_ativa_track
  ON fila (noite, track_id)
  WHERE status IN ('aguardando', 'pendente', 'enviando', 'enviada', 'tocando');

-- Bloqueios gerenciados no /adm (faixa específica ou artista inteiro).
CREATE TABLE IF NOT EXISTS bloqueios (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('track', 'artist')),
  spotify_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  motivo TEXT NOT NULL DEFAULT '',
  criado_em INTEGER NOT NULL,
  UNIQUE (tipo, spotify_id)
);

-- Catálogo sincronizado das playlists escolhidas pela Carol (modo 'playlists').
CREATE TABLE IF NOT EXISTS catalogo_faixas (
  track_id TEXT PRIMARY KEY,
  uri TEXT NOT NULL,
  nome TEXT NOT NULL,
  artistas TEXT NOT NULL,
  artista_principal_id TEXT NOT NULL,
  album TEXT NOT NULL DEFAULT '',
  capa TEXT NOT NULL DEFAULT '',
  duracao_ms INTEGER NOT NULL DEFAULT 0,
  explicito INTEGER NOT NULL DEFAULT 0,
  playlist_id TEXT NOT NULL DEFAULT '',
  playlist_nome TEXT NOT NULL DEFAULT '',
  busca_norm TEXT NOT NULL DEFAULT '',
  atualizado_em INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalogo_playlist ON catalogo_faixas (playlist_id);
CREATE INDEX IF NOT EXISTS idx_catalogo_busca ON catalogo_faixas (busca_norm);

-- Controle de rate limit, estados OAuth descartáveis e proteções anti-flood.
CREATE TABLE IF NOT EXISTS rate_limits (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  expira_em INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_exp ON rate_limits (expira_em);

-- Cache leve (now_playing, busca Spotify, config/loja do Firestore) para respeitar cotas.
CREATE TABLE IF NOT EXISTS cache_estado (
  chave TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  expira_em INTEGER NOT NULL
);
