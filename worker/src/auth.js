// Autenticação e blindagem do Worker:
// - Verificação criptográfica RS256 do Firebase ID Token (Google JWKS) + checagem em equipe/{uid}.
// - Cookie HttpOnly assinado com HMAC-SHA256 para identificar o aparelho do cliente sem forjar.
// - Verificação server-side do Cloudflare Turnstile contra bots.

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const COOKIE_NOME = 'rb_jukebox_id';

let jwksCache = { keys: null, expiraEm: 0 };

function base64UrlParaBytes(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesParaBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesParaHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function idAleatorio(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesParaBase64Url(buf);
}

export async function hmacHex(segredo, texto) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(texto));
  return bytesParaHex(new Uint8Array(sig));
}

function igualTempoConstante(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ─────────────── Cookie HttpOnly assinado (identidade do aparelho) ─────────────── */

function lerCookies(request) {
  const raw = request.headers.get('Cookie') || '';
  const mapa = {};
  for (const parte of raw.split(';')) {
    const idx = parte.indexOf('=');
    if (idx <= 0) continue;
    const k = parte.slice(0, idx).trim();
    const v = parte.slice(idx + 1).trim();
    if (k) mapa[k] = v;
  }
  return mapa;
}

function segredoCookie(env) {
  return env.COOKIE_SECRET || env.SPOTIFY_CLIENT_SECRET || 'dev-local-inseguro';
}

export async function obterOuCriarCliente(request, env) {
  const segredo = segredoCookie(env);
  const cookies = lerCookies(request);
  // Aceita token assinado via header X-Cliente-Token (funciona cross-origin em iOS Safari) ou cookie HttpOnly.
  const bruto = (request.headers.get('X-Cliente-Token') || '').trim() || cookies[COOKIE_NOME] || '';

  if (bruto && bruto.includes('.')) {
    const [cid, mac] = bruto.split('.');
    if (cid && mac && cid.length >= 16 && cid.length <= 64) {
      const esperado = (await hmacHex(segredo, `cid:${cid}`)).slice(0, 32);
      if (igualTempoConstante(mac, esperado)) {
        return {
          clienteId: cid,
          clienteToken: bruto,
          clienteHash: (await hmacHex(segredo, `hash:${cid}`)).slice(0, 32),
          novo: false,
          setCookie: null,
        };
      }
    }
  }

  const novoId = idAleatorio(18);
  const mac = (await hmacHex(segredo, `cid:${novoId}`)).slice(0, 32);
  const clienteToken = `${novoId}.${mac}`;
  const seguro = new URL(request.url).protocol === 'https:';
  const partes = [
    `${COOKIE_NOME}=${clienteToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000', // 30 dias
  ];
  if (seguro) partes.push('Secure');

  return {
    clienteId: novoId,
    clienteToken,
    clienteHash: (await hmacHex(segredo, `hash:${novoId}`)).slice(0, 32),
    novo: true,
    setCookie: partes.join('; '),
  };
}

export async function hashIp(request, env) {
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '127.0.0.1';
  return (await hmacHex(segredoCookie(env), `ip:${ip}`)).slice(0, 32);
}

/* ─────────────── Cloudflare Turnstile ─────────────── */

export async function verificarTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY) {
    // Se ainda não configurou o secret (ex.: ambiente local), passa avisando no log.
    return { ok: true, ignorado: true };
  }
  if (!token || typeof token !== 'string' || token.length < 10) {
    return { ok: false, erro: 'Confirme que você não é um robô e tente novamente.' };
  }

  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const dados = await res.json();
    if (!dados.success) {
      return { ok: false, erro: 'Verificação anti-robô falhou. Recarregue e tente de novo.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, erro: 'Não foi possível validar a verificação anti-robô agora.' };
  }
}

/* ─────────────── Firebase Auth (Equipe do Bar) ─────────────── */

async function obterJwksGoogle() {
  const agora = Date.now();
  if (jwksCache.keys && agora < jwksCache.expiraEm) {
    return jwksCache.keys;
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('Falha ao buscar chaves públicas do Firebase');
  const cc = res.headers.get('Cache-Control') || '';
  const match = cc.match(/max-age=(\d+)/i);
  const ttl = match ? Math.min(Number(match[1]) * 1000, 6 * 3600_000) : 3600_000;
  const json = await res.json();
  jwksCache = { keys: json.keys || [], expiraEm: agora + ttl };
  return jwksCache.keys;
}

export async function verificarFirebaseToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlParaBytes(partes[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlParaBytes(partes[1])));
  } catch {
    return null;
  }

  const projectId = env.FIREBASE_PROJECT_ID || 'rainbowpub-ecd71';
  const agoraSeg = Math.floor(Date.now() / 1000);

  if (header.alg !== 'RS256' || !header.kid) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!payload.sub || typeof payload.sub !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= agoraSeg) return null;
  if (typeof payload.iat !== 'number' || payload.iat > agoraSeg + 300) return null;

  const keys = await obterJwksGoogle();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const dadosAssinados = new TextEncoder().encode(`${partes[0]}.${partes[1]}`);
  const assinatura = base64UrlParaBytes(partes[2]);
  const valido = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, assinatura, dadosAssinados);
  if (!valido) return null;

  return {
    uid: payload.sub,
    email: payload.email || '',
  };
}

// Exige conta logada no Firebase E documento existente em equipe/{uid}.
export async function exigirEquipe(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, status: 401, erro: 'Faça login no painel da equipe.' };
  }
  const token = match[1].trim();

  // Atalho exclusivo de desenvolvimento local com Wrangler + emulador (nunca ativo em produção).
  if (env.DEV_BYPASS_AUTH === '1' && new URL(request.url).hostname === '127.0.0.1') {
    return { ok: true, uid: 'dev-local', email: 'dev@rainbowpub.local' };
  }

  let usuario;
  try {
    usuario = await verificarFirebaseToken(token, env);
  } catch {
    return { ok: false, status: 503, erro: 'Falha ao validar sessão com o Firebase.' };
  }
  if (!usuario) {
    return { ok: false, status: 401, erro: 'Sessão inválida ou expirada. Entre novamente no painel.' };
  }

  // Confere se o UID existe em equipe/{uid} no Firestore usando o próprio token do operador.
  const projectId = env.FIREBASE_PROJECT_ID || 'rainbowpub-ecd71';
  const urlDoc = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/equipe/${encodeURIComponent(usuario.uid)}`;
  const res = await fetch(urlDoc, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { ok: false, status: 403, erro: 'Esta conta não tem permissão de equipe.' };
  }

  return { ok: true, uid: usuario.uid, email: usuario.email };
}
