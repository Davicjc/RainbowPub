// Rainbow Pub — Jukebox do cliente (/musica/)
// Fala exclusivamente com o Cloudflare Worker (/api/musica), que guarda o token da Carol,
// valida GPS, Turnstile, cooldown e filtros anti-zoeira no servidor.

import { esc } from '../js/base.js';
import { obterApiBaseSincrona, resolverApiBase } from '../js/musica-api.js';

const $ = (s, el = document) => el.querySelector(s);
const NOME_KEY = 'rainbow:nome';
const TOKEN_CLIENTE_KEY = 'rainbow:musica_cliente_token';
const GUIA_NOITE_KEY = 'rainbow:musica_guia_noite';

let API_BASE = obterApiBaseSincrona();
let apiPronta = resolverApiBase().then((u) => { API_BASE = u; return u; });

const estado = {
  dados: null,
  resultados: [],
  playlistAtiva: '',
  buscando: false,
  erroBusca: '',
  cooldownRestante: 0,
  faixaSelecionada: null,
  turnstileToken: '',
  turnstileWidgetId: null,
  turnstileCarregado: false,
  progBaseMs: 0,
  progBaseTs: 0,
  ultimaCargaTs: 0,
  carregandoStatus: false,
  fimDisparadoParaId: '',
};

function fmtDuracao(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtCooldown(seg) {
  const sTot = Math.max(0, Math.floor(Number(seg || 0)));
  const m = Math.floor(sTot / 60);
  const s = sTot % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function api(caminho, opts = {}) {
  await apiPronta;
  const clienteToken = localStorage.getItem(TOKEN_CLIENTE_KEY) || '';
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (clienteToken) headers['X-Cliente-Token'] = clienteToken;

  const res = await fetch(`${API_BASE}${caminho}`, {
    credentials: 'include',
    ...opts,
    headers,
  });
  const json = await res.json().catch(() => ({}));
  if (json.clienteToken) {
    try { localStorage.setItem(TOKEN_CLIENTE_KEY, json.clienteToken); } catch {}
  }
  if (!res.ok) {
    const err = new Error(json.erro || `Erro (${res.status})`);
    err.status = res.status;
    err.dados = json;
    throw err;
  }
  return json;
}

/* ─────────────── Turnstile sob demanda ─────────────── */

function carregarTurnstile(siteKey) {
  if (!siteKey || estado.turnstileCarregado) return;
  estado.turnstileCarregado = true;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.defer = true;
  document.head.appendChild(s);
}

function montarWidgetTurnstile(el) {
  const siteKey = estado.dados?.turnstileSiteKey;
  if (!siteKey || !el) return;
  carregarTurnstile(siteKey);
  estado.turnstileToken = '';

  const tentar = (vezes = 0) => {
    if (window.turnstile) {
      el.innerHTML = '';
      estado.turnstileWidgetId = window.turnstile.render(el, {
        sitekey: siteKey,
        theme: 'dark',
        language: 'pt-br',
        callback: (token) => {
          estado.turnstileToken = token;
        },
        'expired-callback': () => {
          estado.turnstileToken = '';
        },
      });
    } else if (vezes < 25) {
      setTimeout(() => tentar(vezes + 1), 200);
    }
  };
  tentar();
}

/* ─────────────── Carregar status + fila ─────────────── */

async function carregarStatus({ forcar = false } = {}) {
  const agora = Date.now();
  if (estado.carregandoStatus) return;
  if (!forcar && agora - estado.ultimaCargaTs < 3000) return;
  estado.carregandoStatus = true;
  estado.ultimaCargaTs = agora;
  try {
    const d = await api('/status');
    const mudouModo = estado.dados?.modo !== d.modo;
    const mudouTrack = estado.dados?.tocandoAgora?.faixa?.trackId !== d.tocandoAgora?.faixa?.trackId;
    estado.dados = d;
    estado.cooldownRestante = Number(d.cooldownRestanteSeg || 0);
    if (d.turnstileSiteKey) carregarTurnstile(d.turnstileSiteKey);

    if (d.tocandoAgora?.faixa) {
      estado.progBaseMs = Number(d.tocandoAgora.progressoMs || 0);
      estado.progBaseTs = Date.now();
      if (mudouTrack) estado.fimDisparadoParaId = '';
    }

    renderizarStatus();
    renderizarTocandoAgora();
    renderizarFila();
    renderizarCooldown();
    mostrarGuiaSePreciso(d.noiteAtual);
    if (estado.resultados.length) renderizarResultados();

    if (d.conectado && d.ativo && d.modo === 'playlists' && (mudouModo || !estado.resultados.length)) {
      renderizarAbasPlaylists();
      executarBusca($('#campoBusca').value.trim());
    } else if (mudouModo) {
      renderizarAbasPlaylists();
    }
  } catch {
    $('#statusSom').classList.remove('ligado');
    $('#statusSomTexto').textContent = 'Sem conexão';
    if (!estado.dados) {
      $('#agoraNome').textContent = 'Não foi possível conectar ao som agora';
      $('#listaFila').innerHTML = '<p class="vazio-musica">Verifique sua internet e recarregue a página.</p>';
    }
  } finally {
    estado.carregandoStatus = false;
  }
}

function renderizarStatus() {
  const d = estado.dados;
  if (!d) return;

  const ligado = d.conectado && d.ativo;
  $('#statusSom').classList.toggle('ligado', ligado);
  $('#statusSomTexto').textContent = !d.conectado
    ? 'Desconectado'
    : !d.ativo
      ? 'Pausado'
      : d.controle === 'aprovacao'
        ? 'Com aprovação'
        : 'Liberado';

  const aviso = $('#avisoMusica');
  if (!d.conectado) {
    aviso.hidden = false;
    $('#avisoMusicaTitulo').textContent = 'Jukebox desligada';
    $('#avisoMusicaTexto').textContent = 'O som ainda não está conectado ao site hoje.';
  } else if (!d.ativo) {
    aviso.hidden = false;
    $('#avisoMusicaTitulo').textContent = 'Pedidos de música pausados';
    $('#avisoMusicaTexto').textContent = 'Agora o som está no comando da casa. Aproveite a noite!';
  } else {
    aviso.hidden = true;
  }

  $('#blocoEscolha').hidden = !ligado;
  $('#blocoModo').textContent = d.modo === 'playlists' ? 'Playlists da casa' : 'Spotify';
  $('#campoBusca').placeholder =
    d.modo === 'playlists' ? 'Filtrar música ou artista das playlists…' : 'Digite música ou artista…';

  if (d.regras) {
    const partes = [];
    if (d.regras.cooldownMin > 0) partes.push(`1 pedido a cada ${d.regras.cooldownMin} min`);
    if (d.regras.limitarDuracao && d.regras.maxDuracaoSeg) {
      const m = Math.floor(d.regras.maxDuracaoSeg / 60);
      const s = d.regras.maxDuracaoSeg % 60;
      partes.push(`máx. ${s ? `${m}m${String(s).padStart(2, '0')}s` : `${m} min`}`);
    }
    partes.push(`fila até ${d.regras.maxFila} músicas`);
    if (d.exigirGps) partes.push('só dentro do bar');
    $('#regrasResumo').textContent = partes.join(' · ');
  }
}

function renderizarTocandoAgora() {
  const d = estado.dados;
  const np = d?.tocandoAgora;
  const capaEl = $('#agoraCapa');
  const progEl = $('#agoraProg');

  if (!d?.conectado) {
    capaEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    $('#agoraEtiqueta').textContent = 'Som do bar';
    $('#agoraNome').textContent = 'Aguardando conexão';
    $('#agoraArtista').textContent = '';
    progEl.hidden = true;
    return;
  }

  if (!np?.faixa) {
    capaEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    $('#agoraEtiqueta').textContent = 'Som do bar';
    $('#agoraNome').textContent = 'Nenhuma música tocando agora';
    $('#agoraArtista').textContent = 'Quando o som começar, aparece aqui.';
    progEl.hidden = true;
    return;
  }

  const f = np.faixa;
  capaEl.innerHTML = f.capa
    ? `<img src="${esc(f.capa)}" alt="" loading="lazy">`
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  $('#agoraEtiqueta').textContent = np.tocando ? 'Tocando agora' : 'Pausado no bar';
  $('#agoraNome').textContent = f.nome;
  $('#agoraArtista').textContent = f.artistas;
  progEl.hidden = !f.duracaoMs;
  atualizarBarraProgresso();
}

function atualizarBarraProgresso() {
  const np = estado.dados?.tocandoAgora;
  if (!np?.faixa?.duracaoMs) return;
  const decorrido = np.tocando ? Date.now() - estado.progBaseTs : 0;
  const atual = Math.min(np.faixa.duracaoMs, estado.progBaseMs + decorrido);
  const pct = (atual / np.faixa.duracaoMs) * 100;
  $('#agoraBarra').style.width = `${pct.toFixed(1)}%`;
  $('#agoraAtual').textContent = fmtDuracao(atual);
  $('#agoraTotal').textContent = fmtDuracao(np.faixa.duracaoMs);

  // Virada de faixa: assim que a música termina, atualiza sozinho (sem F5).
  if (np.tocando && atual >= np.faixa.duracaoMs && estado.fimDisparadoParaId !== np.faixa.trackId) {
    estado.fimDisparadoParaId = np.faixa.trackId;
    setTimeout(() => carregarStatus({ forcar: true }), 1500);
  }
}

function renderizarCooldown() {
  const el = $('#avisoCooldown');
  const rel = $('#avisoCooldownRelogio');
  const sub = $('#avisoCooldownSub');
  const minCfg = estado.dados?.regras?.cooldownMin || 5;
  if (estado.cooldownRestante > 0 && estado.dados?.ativo) {
    el.hidden = false;
    if (rel) rel.textContent = fmtCooldown(estado.cooldownRestante);
    if (sub) sub.textContent = `Espere o tempo acabar (${minCfg} min entre pedidos) para escolher a próxima.`;
  } else {
    el.hidden = true;
  }
  const sucRel = $('#sucessoCooldownRelogio');
  if (sucRel) {
    sucRel.textContent =
      estado.cooldownRestante > 0
        ? `Próximo pedido liberado em ${fmtCooldown(estado.cooldownRestante)}`
        : 'Você já pode escolher outra música!';
  }
}

function renderizarAbasPlaylists() {
  const nav = $('#abasPlaylists');
  const d = estado.dados;
  if (!d || d.modo !== 'playlists' || !d.playlists?.length) {
    nav.hidden = true;
    nav.innerHTML = '';
    estado.playlistAtiva = '';
    return;
  }
  nav.hidden = false;
  const opcoes = [{ id: '', nome: 'Todas' }, ...d.playlists];
  nav.innerHTML = opcoes
    .map(
      (pl) =>
        `<button type="button" class="aba-pl" data-pl="${esc(pl.id)}" aria-pressed="${pl.id === estado.playlistAtiva}">${esc(pl.nome)}</button>`
    )
    .join('');

  nav.querySelectorAll('[data-pl]').forEach((btn) => {
    btn.addEventListener('click', () => {
      estado.playlistAtiva = btn.dataset.pl;
      renderizarAbasPlaylists();
      executarBusca($('#campoBusca').value.trim());
    });
  });
}

function renderizarFila() {
  const d = estado.dados;
  const fila = d?.fila || [];
  const max = d?.regras?.maxFila || 15;
  $('#filaContagem').textContent = `${fila.length} de ${max}`;

  const el = $('#listaFila');
  if (!fila.length) {
    el.innerHTML = '<p class="vazio-musica">Nenhum pedido da galera ainda. Escolha a próxima música!</p>';
  } else {
    el.innerHTML = fila
      .map((item) => {
        const proxima = item.status === 'enviada';
        return `<article class="fila-item ${proxima ? 'fila-item--proxima' : ''}">
          <span class="fila-pos">${item.posicao}</span>
          ${item.capa ? `<img class="fila-capa" src="${esc(item.capa)}" alt="" loading="lazy">` : '<span class="fila-capa"></span>'}
          <div class="faixa-txt">
            <strong class="faixa-nome">${esc(item.nome)}</strong>
            <span class="faixa-sub">${esc(item.artistas)} · ${fmtDuracao(item.duracaoMs)}</span>
            ${item.pedidoPor ? `<span class="fila-quem">Escolhida por <strong>${esc(item.pedidoPor)}</strong></span>` : ''}
            ${proxima ? '<span class="fila-badge">Próxima no som</span>' : ''}
          </div>
        </article>`;
      })
      .join('');
  }

  const spBloco = $('#blocoSpotifyFila');
  const spLista = $('#listaSpotifyFila');
  const proximas = d?.proximasSpotify || [];
  if (!proximas.length) {
    spBloco.hidden = true;
    spLista.innerHTML = '';
  } else {
    spBloco.hidden = false;
    spLista.innerHTML = proximas
      .map(
        (f, i) => `<article class="fila-item">
          <span class="fila-pos" style="color:var(--apagado)">${i + 1}</span>
          ${f.capa ? `<img class="fila-capa" src="${esc(f.capa)}" alt="" loading="lazy">` : '<span class="fila-capa"></span>'}
          <div class="faixa-txt">
            <strong class="faixa-nome">${esc(f.nome)}</strong>
            <span class="faixa-sub">${esc(f.artistas)}</span>
            <span class="faixa-meta">${fmtDuracao(f.duracaoMs)}</span>
          </div>
        </article>`
      )
      .join('');
  }
}

/* ─────────────── Busca ─────────────── */

let timerBusca = null;
const campoBusca = $('#campoBusca');
const btnLimparBusca = $('#btnLimparBusca');

campoBusca.addEventListener('input', () => {
  const q = campoBusca.value.trim();
  btnLimparBusca.hidden = !q;
  clearTimeout(timerBusca);
  timerBusca = setTimeout(() => executarBusca(q), 360);
});

btnLimparBusca.addEventListener('click', () => {
  campoBusca.value = '';
  btnLimparBusca.hidden = true;
  campoBusca.focus();
  executarBusca('');
});

async function executarBusca(q) {
  const d = estado.dados;
  if (!d || !d.conectado || !d.ativo) return;

  if (d.modo === 'aberto' && q.length < 2) {
    estado.resultados = [];
    estado.erroBusca = '';
    renderizarResultados();
    return;
  }

  estado.buscando = true;
  estado.erroBusca = '';
  renderizarResultados();

  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (d.modo === 'playlists' && estado.playlistAtiva) params.set('playlist', estado.playlistAtiva);
    const res = await api(`/buscar?${params.toString()}`);
    estado.resultados = res.resultados || [];
  } catch (err) {
    estado.resultados = [];
    estado.erroBusca = err.message || 'Erro ao buscar músicas.';
  } finally {
    estado.buscando = false;
    renderizarResultados();
  }
}

function renderizarResultados() {
  const el = $('#listaResultados');
  const d = estado.dados;

  if (estado.buscando) {
    el.innerHTML = '<p class="vazio-musica">Buscando músicas…</p>';
    return;
  }
  if (estado.erroBusca) {
    el.innerHTML = `<p class="vazio-musica">${esc(estado.erroBusca)}</p>`;
    return;
  }
  if (!estado.resultados.length) {
    const q = campoBusca.value.trim();
    if (d?.modo === 'playlists') {
      el.innerHTML = '<p class="vazio-musica">Nenhuma música encontrada nas playlists liberadas.</p>';
    } else if (q.length >= 2) {
      el.innerHTML = '<p class="vazio-musica">Nenhuma música liberada encontrada com esse nome.</p>';
    } else {
      el.innerHTML = '';
    }
    return;
  }

  const naFilaIds = new Set((d?.fila || []).map((x) => x.trackId));
  const tocandoId = d?.tocandoAgora?.faixa?.trackId;
  const emCooldown = estado.cooldownRestante > 0;

  el.innerHTML = estado.resultados
    .map((f) => {
      const jaEsta = f.trackId === tocandoId || naFilaIds.has(f.trackId);
      const labelBtn = f.trackId === tocandoId ? 'Tocando' : naFilaIds.has(f.trackId) ? 'Na fila' : 'Pedir';
      return `<article class="faixa-item">
        ${f.capa ? `<img class="faixa-capa" src="${esc(f.capa)}" alt="" loading="lazy">` : '<span class="faixa-capa"></span>'}
        <div class="faixa-txt">
          <strong class="faixa-nome">${esc(f.nome)}</strong>
          <span class="faixa-sub">${esc(f.artistas)}</span>
          <span class="faixa-meta">${fmtDuracao(f.duracaoMs)}${f.playlistNome ? ` · ${esc(f.playlistNome)}` : ''}</span>
        </div>
        <button type="button" class="btn-pedir-faixa" data-pedir="${esc(f.trackId)}" ${jaEsta || emCooldown ? 'disabled' : ''}>${labelBtn}</button>
      </article>`;
    })
    .join('');

  el.querySelectorAll('[data-pedir]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = estado.resultados.find((x) => x.trackId === btn.dataset.pedir);
      if (f) abrirFolhaPedido(f);
    });
  });
}

/* ─────────────── Guia de boas-vindas e respeito (1x por noite) ─────────────── */

const guiaEl = $('#guiaMusica');
let guiaVerificada = false;

function mostrarGuiaSePreciso(noite) {
  if (!guiaEl || guiaVerificada) return;
  guiaVerificada = true;
  const chaveNoite = noite || new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem(GUIA_NOITE_KEY) === chaveNoite) return;
  } catch {}
  guiaEl.hidden = false;
  document.body.classList.add('travado');

  const btn = $('#btnAceitarGuia');
  if (!btn) return;
  let falta = 5;
  btn.disabled = true;
  btn.textContent = `Leia rapidinho (${falta}s)`;

  const timerGuia = setInterval(() => {
    falta -= 1;
    if (falta > 0) {
      btn.textContent = `Leia rapidinho (${falta}s)`;
    } else {
      clearInterval(timerGuia);
      btn.disabled = false;
      btn.textContent = 'Entendi, bora escolher';
    }
  }, 1000);

  btn.addEventListener(
    'click',
    () => {
      if (btn.disabled) return;
      clearInterval(timerGuia);
      guiaEl.hidden = true;
      document.body.classList.remove('travado');
      try { localStorage.setItem(GUIA_NOITE_KEY, chaveNoite); } catch {}
    },
    { once: true }
  );
}

/* ─────────────── Folha de confirmação + GPS ─────────────── */

const folha = $('#folhaMusica');
const folhaCorpo = $('#folhaMusicaCorpo');

function fecharFolha() {
  folha.hidden = true;
  document.body.classList.remove('travado');
  estado.faixaSelecionada = null;
  estado.turnstileToken = '';
}

$('#folhaMusicaFechar').addEventListener('click', fecharFolha);
folha.addEventListener('click', (e) => {
  if (e.target === folha) fecharFolha();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !folha.hidden) fecharFolha();
});

function obterNomeSalvo() {
  return (localStorage.getItem(NOME_KEY) || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function atualizarSaudacaoNome() {
  const nome = obterNomeSalvo();
  const sub = $('#musicaSub');
  if (!sub) return;
  sub.textContent = nome
    ? `Pedindo como ${nome} · escolha a próxima música do bar.`
    : 'Escolha a próxima música direto da sua mesa.';
}

function abrirFolhaPedido(faixa, recadoHtml = '', editarNome = false) {
  estado.faixaSelecionada = faixa;
  folha.hidden = false;
  document.body.classList.add('travado');
  $('#folhaMusicaTitulo').textContent = estado.dados?.controle === 'aprovacao' ? 'Sugerir música' : 'Colocar na fila';

  const exigeGps = estado.dados?.exigirGps !== false;
  const nomeSalvo = obterNomeSalvo();
  const mostrarCampoNome = !nomeSalvo || editarNome;
  const temTurnstile = Boolean(estado.dados?.turnstileSiteKey);
  const textoBotao = estado.dados?.controle === 'aprovacao' ? 'Enviar sugestão' : 'Colocar na fila';

  folhaCorpo.innerHTML = `
    ${recadoHtml}
    <div class="faixa-resumo">
      ${faixa.capa ? `<img src="${esc(faixa.capa)}" alt="">` : '<span></span>'}
      <div>
        <strong>${esc(faixa.nome)}</strong>
        <span>${esc(faixa.artistas)} · ${fmtDuracao(faixa.duracaoMs)}</span>
      </div>
    </div>
    ${mostrarCampoNome
      ? `<label class="campo">
          <span class="campo__rotulo">Seu nome <small style="font-weight:500;color:var(--texto-2)">(obrigatório)</small></span>
          <input id="mNome" required minlength="2" maxlength="24" autocomplete="given-name" placeholder="Seu nome de verdade (aparece na fila)" value="${esc(nomeSalvo)}">
        </label>
        <p class="aviso-nome-real"><strong>Use seu nome real:</strong> nomes falsos ou de zoeira serão removidos de poder escolher músicas.</p>`
      : `<div class="nome-auto">
          <span>Pedindo como <strong>${esc(nomeSalvo)}</strong></span>
          <button type="button" class="nome-auto__trocar" id="btnTrocarNome">Trocar</button>
        </div>`}
    ${exigeGps ? `<div class="aviso-gps">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-7.2 7-12a7 7 0 1 0-14 0c0 4.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.6"/></svg>
      <span><strong>O celular vai pedir sua localização.</strong> Toque em <strong>Permitir</strong>: é só para confirmar que você está dentro do Rainbow.</span>
    </div>` : ''}
    ${temTurnstile ? '<div class="turnstile-box" id="turnstileBox"></div>' : ''}
    <button type="button" class="botao botao--grande botao--arco botao--largo" id="btnConfirmarMusica">${textoBotao}</button>
  `;

  $('#btnTrocarNome')?.addEventListener('click', () => {
    abrirFolhaPedido(faixa, recadoHtml, true);
    $('#mNome')?.focus();
  });

  if (temTurnstile) montarWidgetTurnstile($('#turnstileBox'));

  $('#btnConfirmarMusica').addEventListener('click', confirmarPedidoMusica);
}

function pegarGps() {
  return new Promise((ok, falha) => {
    if (!('geolocation' in navigator)) return falha({ code: 'sem' });
    navigator.geolocation.getCurrentPosition(ok, falha, {
      enableHighAccuracy: true,
      timeout: 18000,
      maximumAge: 15000,
    });
  });
}

async function confirmarPedidoMusica() {
  const faixa = estado.faixaSelecionada;
  if (!faixa) return;

  const campoNome = $('#mNome');
  const nome = (campoNome ? campoNome.value : obterNomeSalvo()).trim().replace(/\s+/g, ' ').slice(0, 24);
  if (nome.length < 2) {
    abrirFolhaPedido(faixa, '<p class="recado"><strong>Escreva seu nome</strong> (pelo menos 2 letras) para colocar a música na fila.</p>', true);
    $('#mNome')?.focus();
    return;
  }
  localStorage.setItem(NOME_KEY, nome);
  atualizarSaudacaoNome();

  if (estado.dados?.turnstileSiteKey && !estado.turnstileToken) {
    return abrirFolhaPedido(faixa, '<p class="recado">Aguarde a verificação anti-robô concluir e tente de novo.</p>');
  }

  const exigeGps = estado.dados?.exigirGps !== false;
  let geo = null;

  if (exigeGps) {
    folhaCorpo.innerHTML = `<div class="gps" role="status">
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle class="onda" cx="40" cy="66" r="14"/><circle class="onda" cx="40" cy="66" r="14"/>
        <path class="pino" d="M40 66s18-18.5 18-33a18 18 0 1 0-36 0c0 14.5 18 33 18 33z"/><circle class="pino" cx="40" cy="33" r="6.5"/>
      </svg>
      <h3>Conferindo se você está no Rainbow…</h3>
      <p>Se o celular perguntar, toque em <strong>Permitir</strong>.</p>
    </div>`;

    try {
      const p = await pegarGps();
      geo = {
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        precisao: Math.round(p.coords.accuracy),
      };
    } catch (err) {
      const msg =
        err.code === 1
          ? '<strong>A localização está bloqueada.</strong> Toque no cadeado ao lado do endereço do site, libere a <strong>Localização</strong> e tente de novo.'
          : err.code === 'sem'
            ? '<strong>Este celular não mostrou a localização.</strong>'
            : '<strong>Não achamos sua localização.</strong> Ligue o GPS do celular e tente de novo.';
      return abrirFolhaPedido(faixa, `<p class="recado">${msg}</p>`);
    }
  } else {
    $('#btnConfirmarMusica').disabled = true;
    $('#btnConfirmarMusica').textContent = 'Enviando…';
  }

  try {
    const res = await api('/pedir', {
      method: 'POST',
      body: JSON.stringify({
        trackId: faixa.trackId,
        nome,
        geo,
        turnstileToken: estado.turnstileToken || '',
      }),
    });

    const item = res.item;
    estado.cooldownRestante = Number(item?.cooldownRestanteSeg || 0);
    if (item.aguardandoAprovacao) {
      $('#folhaMusicaTitulo').textContent = 'Sugestão enviada!';
      folhaCorpo.innerHTML = `<div class="pronto">
        <div class="pronto__icone"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        <h3>Enviada para a casa!</h3>
        <div class="numero">
          <small>Aguardando aprovação</small>
          <b>OK</b>
          <span>${esc(item.nome)} · ${esc(item.artistas)}</span>
        </div>
        <p class="nota">Assim que a equipe aprovar, ela entra na fila do som do bar.</p>
        ${estado.cooldownRestante > 0 ? `<p class="sucesso-cooldown" id="sucessoCooldownRelogio">Próximo pedido liberado em ${fmtCooldown(estado.cooldownRestante)}</p>` : ''}
        <button type="button" class="botao botao--largo" id="btnFecharSucesso">Voltar</button>
      </div>`;
    } else {
      $('#folhaMusicaTitulo').textContent = 'Na fila!';
      folhaCorpo.innerHTML = `<div class="pronto">
        <div class="pronto__icone"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        <h3>${item.status === 'enviada' ? 'Já entrou no som!' : 'Sua música entrou na fila!'}</h3>
        <div class="numero">
          <small>${item.status === 'enviada' ? 'Próxima no Spotify' : 'Posição atual'}</small>
          <b>#${item.posicao}</b>
          <span>${esc(item.nome)} · ${esc(item.artistas)}</span>
        </div>
        <p class="nota">${item.status === 'enviada' ? 'Ela já foi enviada para a fila do Spotify do bar.' : 'Ela vai entrar automaticamente no som do bar na vez dela.'}</p>
        ${estado.cooldownRestante > 0 ? `<p class="sucesso-cooldown" id="sucessoCooldownRelogio">Próximo pedido liberado em ${fmtCooldown(estado.cooldownRestante)}</p>` : ''}
        <button type="button" class="botao botao--largo" id="btnFecharSucesso">Ver a fila</button>
      </div>`;
    }
    $('#btnFecharSucesso').addEventListener('click', fecharFolha);

    carregarStatus({ forcar: true });
  } catch (err) {
    if (err.dados?.cooldownRestanteSeg) {
      estado.cooldownRestante = Number(err.dados.cooldownRestanteSeg);
      renderizarCooldown();
    }
    abrirFolhaPedido(faixa, `<p class="recado">${esc(err.message || 'Não foi possível adicionar a música agora.')}</p>`);
  }
}

/* ─────────────── Loop ao vivo (dinâmico com aba visível, pausado em segundo plano) ─────────────── */

atualizarSaudacaoNome();
carregarStatus({ forcar: true });
setInterval(() => {
  if (document.visibilityState === 'visible') carregarStatus();
}, 10_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') carregarStatus({ forcar: true });
});
window.addEventListener('focus', () => carregarStatus());
window.addEventListener('online', () => carregarStatus({ forcar: true }));
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  atualizarBarraProgresso();
  if (estado.cooldownRestante > 0) {
    estado.cooldownRestante = Math.max(0, estado.cooldownRestante - 1);
    renderizarCooldown();
    if (estado.cooldownRestante === 0) renderizarResultados();
  }
}, 1000);
