// Resolução da URL do serviço de música (Worker na conta Cloudflare da Carol em *.workers.dev).
// Em desenvolvimento local usa 127.0.0.1:8787; em produção lê config/loja.musicaApi do Firestore.

import { db } from './firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const CACHE_URL_KEY = 'rainbow:musica_api_url';
const PADRAO_PROD = 'https://rainbowpub-musica.rainbowpub.workers.dev/api/musica';

export function normalizarBaseApi(urlBruta) {
  const s = String(urlBruta || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https:\/\/[a-z0-9.-]+/i.test(s) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(s)) {
    return '';
  }
  return s.endsWith('/api/musica') ? s : `${s}/api/musica`;
}

export function obterApiBaseSincrona() {
  const param = new URLSearchParams(location.search).get('api');
  if (param && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(param)) {
    return param.replace(/\/+$/, '');
  }
  if (['127.0.0.1', 'localhost'].includes(location.hostname) && location.port !== '8787') {
    return 'http://127.0.0.1:8787/api/musica';
  }
  const salva = normalizarBaseApi(localStorage.getItem(CACHE_URL_KEY) || '');
  return salva || PADRAO_PROD;
}

export async function resolverApiBase() {
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
    return obterApiBaseSincrona();
  }
  try {
    const snap = await getDoc(doc(db, 'config', 'loja'));
    const raw = snap.exists() ? snap.data()?.musicaApi : '';
    const norm = normalizarBaseApi(raw);
    if (norm) {
      try { localStorage.setItem(CACHE_URL_KEY, norm); } catch {}
      return norm;
    }
  } catch {
    // Segue com cache local ou fallback
  }
  return obterApiBaseSincrona();
}

export function atualizarCacheApiBase(urlBruta) {
  const norm = normalizarBaseApi(urlBruta);
  try {
    if (norm) localStorage.setItem(CACHE_URL_KEY, norm);
    else localStorage.removeItem(CACHE_URL_KEY);
  } catch {}
  return norm || PADRAO_PROD;
}
