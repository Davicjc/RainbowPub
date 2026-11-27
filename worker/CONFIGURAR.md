# Rainbow Pub Música — Configuração do Worker (100% na conta Cloudflare grátis da Carol)

O site estático continua no Cloudflare Pages (`https://rainbowpub.cjc.pics`), e este serviço roda **100% na conta Cloudflare grátis da Carol** em `https://rainbowpub-musica.<subdominio-dela>.workers.dev` (sem cartão, sem mexer no DNS do `cjc.pics` e sem usar a conta do Davi).

Usa **1 Worker + 1 banco D1 + 1 Cron Trigger** (plano Free).

## 1. Criar conta Cloudflare grátis da Carol + banco D1
```bash
cd worker
wrangler login   # entrar na conta Cloudflare da Carol
wrangler d1 create rainbowpub-musica
# Cole o database_id retornado em worker/wrangler.jsonc
wrangler d1 execute rainbowpub-musica --remote --file=./schema.sql
```

## 2. Publicar a primeira vez para pegar a URL `*.workers.dev`
```bash
wrangler deploy -c worker/wrangler.jsonc
```
O Wrangler mostra a URL gerada (ex.: `https://rainbowpub-musica.rainbowpub.workers.dev`).

## 3. Criar App no Spotify (conta Premium da Carol)
1. Acesse https://developer.spotify.com/dashboard com a conta **Spotify Premium** da Carol.
2. Crie um App (**Web API** marcada) e adicione o Redirect URI:
   `https://rainbowpub-musica.<subdominio-dela>.workers.dev/api/musica/oauth/callback`
3. Coloque essa mesma URL em `SPOTIFY_REDIRECT_URI` no `worker/wrangler.jsonc` e rode `wrangler deploy -c worker/wrangler.jsonc` novamente.

## 4. Gravar secrets na conta dela (nunca no código)
```bash
wrangler secret put SPOTIFY_CLIENT_ID -c worker/wrangler.jsonc
wrangler secret put SPOTIFY_CLIENT_SECRET -c worker/wrangler.jsonc
wrangler secret put COOKIE_SECRET -c worker/wrangler.jsonc   # ex: openssl rand -hex 32
```
Opcional (Turnstile invisível contra bots): crie um widget Turnstile para `rainbowpub.cjc.pics`, coloque o **Site Key** em `TURNSTILE_SITE_KEY` no `worker/wrangler.jsonc` e grave:
```bash
wrangler secret put TURNSTILE_SECRET_KEY -c worker/wrangler.jsonc
```

## 5. Ligar o site ao Worker e conectar o Spotify
1. Confira no build do Cloudflare Pages que `musica/` e `js/musica-api.js` vão para `_site_publico` e `worker/` fica de fora.
2. Abra `https://rainbowpub.cjc.pics/adm/` → aba **Música** → cole a URL `https://rainbowpub-musica.<subdominio-dela>.workers.dev` em **Servidor de música** e clique em **Salvar endereço**.
3. Clique em **Conectar Spotify da Carol**.
