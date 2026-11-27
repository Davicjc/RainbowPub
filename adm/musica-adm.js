// Rainbow Pub — Controle da Jukebox / Spotify no painel /adm/ (adm/musica-adm.js)

import { esc } from '../js/base.js';
import { db } from '../js/firebase.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
  obterApiBaseSincrona,
  resolverApiBase,
  normalizarBaseApi,
  atualizarCacheApiBase,
} from '../js/musica-api.js';

let API_BASE = obterApiBaseSincrona();
let apiPronta = resolverApiBase().then((u) => { API_BASE = u; return u; });

let ctxAdm = null;
let dadosEstado = null;
let playlistsConta = null;
let timerAtualizacao = null;
let timerRelogio = null;
let timerFundo = null;
let progBaseMs = 0;
let progBaseTs = 0;
let fimDisparadoParaId = '';
let carregandoEstado = false;
let ultimaCargaTs = 0;
let telaAberta = false;
let eventosLigados = false;
let subAbaMusica = 'aovivo';
let filtroLogPeriodo = 'noite';
let buscaLogTexto = '';

export function irParaSubAbaMusica(sub) {
  subAbaMusica = ['aovivo', 'log', 'ajustes'].includes(sub) ? sub : 'aovivo';
  document.querySelectorAll('[data-musica-sub]').forEach((b) => {
    const on = b.dataset.musicaSub === subAbaMusica;
    b.classList.toggle('ativa', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('[data-musica-painel]').forEach((p) => {
    p.hidden = p.dataset.musicaPainel !== subAbaMusica;
  });
}

const STATUS_LOG = {
  tocando: { txt: 'Tocando agora', cls: 'musica-chip--ok' },
  enviada: { txt: 'No Spotify', cls: 'musica-chip--ok' },
  enviando: { txt: 'Enviando', cls: 'musica-chip--ok' },
  pendente: { txt: 'Na fila', cls: '' },
  aguardando: { txt: 'Aguardando', cls: 'musica-chip--aviso' },
  tocada: { txt: 'Tocada', cls: '' },
  removida: { txt: 'Removida', cls: 'musica-chip--erro' },
};

const normBusca = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const $ = (id) => document.getElementById(id);

function fmtDuracao(ms) {
  const s = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDataHora(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function apiAdm(caminho, opts = {}) {
  await apiPronta;
  const usuario = ctxAdm?.obterUsuario?.();
  if (!usuario) throw new Error('Faça login no painel.');
  const token = await usuario.getIdToken();
  const res = await fetch(`${API_BASE}${caminho}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.erro || `Erro (${res.status})`);
  }
  return json;
}

function atualizarBadges(qtdFila, qtdLogsNoite = 0) {
  const n = Number(qtdFila || 0);
  for (const id of ['badge-menu-musica', 'badge-mobile-musica', 'badge-sub-fila']) {
    const el = $(id);
    if (!el) continue;
    el.hidden = n <= 0;
    el.textContent = String(n);
  }
  const bLog = $('badge-sub-log');
  if (bLog) {
    const nl = Number(qtdLogsNoite || 0);
    bLog.hidden = nl <= 0;
    bLog.textContent = String(nl);
  }
}

export async function carregarEstadoMusica({ forcar = false, silencioso = false } = {}) {
  if (!ctxAdm?.obterUsuario?.()) return;
  const agora = Date.now();
  if (carregandoEstado) return;
  if (!forcar && agora - ultimaCargaTs < 2500) return;
  carregandoEstado = true;
  ultimaCargaTs = agora;
  try {
    const d = await apiAdm(`/adm/estado${forcar ? '?forcar=1' : ''}`);
    const mudouTrack = dadosEstado?.tocandoAgora?.faixa?.trackId !== d.tocandoAgora?.faixa?.trackId;
    dadosEstado = d;
    if (d.tocandoAgora?.faixa) {
      progBaseMs = Number(d.tocandoAgora.progressoMs || 0);
      progBaseTs = Date.now();
      if (mudouTrack) fimDisparadoParaId = '';
    }
    const noiteAtual = d.noiteAtual || '';
    const logsNoite = (d.logs || []).filter((x) => !noiteAtual || x.noite === noiteAtual).length;
    atualizarBadges((d.fila?.length || 0) + (d.aguardandoAprovacao?.length || 0), logsNoite);
    renderizarTelaMusica();
  } catch (err) {
    if (!silencioso) {
      ctxAdm?.mostrarToast?.(err.message || 'Não foi possível carregar o controle de música.', 'erro');
    }
    const statusEl = $('musica-status-conexao');
    if (statusEl && !dadosEstado) {
      statusEl.innerHTML = `<span class="musica-chip musica-chip--erro">API offline</span>
        <span class="texto-apoio">${esc(err.message || 'Worker de música ainda não configurado.')}</span>`;
    }
  } finally {
    carregandoEstado = false;
  }
}

function renderizarTelaMusica() {
  const d = dadosEstado;
  if (!d) return;
  const cfg = d.config || {};

  // 1. Conexão Spotify
  const statusEl = $('musica-status-conexao');
  const btnConectar = $('btn-spotify-conectar');
  const btnDesconectar = $('btn-spotify-desconectar');
  const avisoCred = $('musica-aviso-credenciais');

  if (d.conectado && d.contaSpotify) {
    const plano = d.contaSpotify.product ? ` · ${d.contaSpotify.product}` : '';
    statusEl.innerHTML = `<span class="musica-chip musica-chip--ok">Conectado</span>
      <strong>${esc(d.contaSpotify.displayName || 'Spotify')}</strong>
      <span class="texto-apoio">${esc(d.contaSpotify.email || '')}${esc(plano)}</span>`;
    btnConectar.textContent = 'Trocar conta Spotify';
    btnDesconectar.hidden = false;
  } else {
    statusEl.innerHTML = `<span class="musica-chip musica-chip--aviso">Desconectado</span>
      <span class="texto-apoio">Conecte a conta Spotify Premium da casa para liberar os pedidos.</span>`;
    btnConectar.textContent = 'Conectar Spotify da Carol';
    btnDesconectar.hidden = true;
  }
  avisoCred.hidden = d.spotifyConfigurado !== false;
  const faixaDesc = $('musica-faixa-desconectado');
  if (faixaDesc) faixaDesc.hidden = Boolean(d.conectado);
  const subTopo = $('musica-sub-topo');
  if (subTopo && d.conectado && d.contaSpotify?.displayName) {
    subTopo.textContent = `Conectado: ${d.contaSpotify.displayName} · reset todo dia às 12h.`;
  }

  // 2. Controle dos clientes (Liberado / Com aprovação / Desativado) + Modo (Aberto / Playlists)
  const controleAtual = cfg.controle || (cfg.ativo ? 'liberado' : 'desativado');
  document.querySelectorAll('[data-musica-controle]').forEach((b) => {
    const ativo = b.dataset.musicaControle === controleAtual;
    b.classList.toggle('ativo', ativo);
    b.setAttribute('aria-checked', String(ativo));
  });

  document.querySelectorAll('[data-musica-modo]').forEach((b) => {
    const ativo = b.dataset.musicaModo === cfg.modo;
    b.classList.toggle('ativo', ativo);
    b.setAttribute('aria-checked', String(ativo));
  });

  $('musica-bloco-playlists').hidden = !d.conectado;
  $('musica-info-reset').textContent = `Noite atual: ${d.noiteAtual || '—'} · Reset automático todo dia às 12h · Último reset: ${fmtDataHora(cfg.ultimoResetEm)}`;

  // 3. Tocando agora
  const np = d.tocandoAgora;
  const boxAgora = $('musica-tocando-agora');
  if (!d.conectado) {
    boxAgora.innerHTML = '<p class="estado-vazio">Conecte o Spotify para ver o que está tocando.</p>';
  } else if (!np?.faixa) {
    boxAgora.innerHTML = '<p class="estado-vazio">Nenhuma música tocando no Spotify agora.</p>';
  } else {
    const f = np.faixa;
    boxAgora.innerHTML = `<div class="musica-now">
      ${f.capa ? `<img class="musica-capa" src="${esc(f.capa)}" alt="">` : '<div class="musica-capa"></div>'}
      <div class="musica-now__txt">
        <span class="musica-etiqueta">${np.tocando ? 'Tocando agora' : 'Pausado'}</span>
        <strong>${esc(f.nome)}</strong>
        <small>${esc(f.artistas)}</small>
        <div class="musica-now__prog">
          <div class="musica-now__trilho"><span id="adm-now-barra" class="musica-now__barra"></span></div>
          <span id="adm-now-tempo" class="musica-now__tempo"></span>
        </div>
      </div>
    </div>`;
  }
  $('btn-musica-pular').disabled = !d.conectado || !np?.faixa;

  // 3.5 Aguardando aprovação (modo 'aprovacao')
  const aguardando = d.aguardandoAprovacao || [];
  const blocoAprov = $('musica-bloco-aprovacao');
  const listaAprov = $('musica-lista-aprovacao');
  blocoAprov.hidden = aguardando.length === 0;
  $('musica-cont-aprovacao').textContent = String(aguardando.length);
  if (aguardando.length) {
    listaAprov.innerHTML = aguardando
      .map(
        (item) => `<div class="musica-item-fila">
          <span class="musica-pos">?</span>
          ${item.capa ? `<img class="musica-capa-mini" src="${esc(item.capa)}" alt="">` : '<span class="musica-capa-mini"></span>'}
          <div class="musica-item-txt">
            <strong>${esc(item.nome)}</strong>
            <small>${esc(item.artistas)}${item.pedidoPor ? ` · Sugerida por ${esc(item.pedidoPor)}` : ''} · ${fmtDuracao(item.duracaoMs)}</small>
          </div>
          <div class="musica-item-acoes">
            <button type="button" class="btn btn-principal btn-compacto" data-aprovar-fila="${esc(item.id)}">Aprovar</button>
            <button type="button" class="btn btn-secundario btn-compacto" data-rem-fila="${esc(item.id)}" data-bloq="">Recusar</button>
            <button type="button" class="btn btn-perigo btn-compacto" data-rem-fila="${esc(item.id)}" data-bloq="track">Bloquear</button>
          </div>
        </div>`
      )
      .join('');
    listaAprov.querySelectorAll('[data-aprovar-fila]').forEach((btn) => {
      btn.addEventListener('click', () => aprovarSugestao(btn.dataset.aprovarFila));
    });
    listaAprov.querySelectorAll('[data-rem-fila]').forEach((btn) => {
      btn.addEventListener('click', () => removerDaFila(btn.dataset.remFila, btn.dataset.bloq));
    });
  } else {
    listaAprov.innerHTML = '';
  }

  // 4. Fila atual
  const fila = d.fila || [];
  $('musica-cont-fila').textContent = `${fila.length} de ${cfg.maxFila || 15}`;
  const listaFila = $('musica-lista-fila');

  if (!fila.length) {
    listaFila.innerHTML = '<p class="estado-vazio">Nenhuma música aguardando na fila.</p>';
  } else {
    listaFila.innerHTML = fila
      .map((item, idx) => {
        const enviada = item.status === 'enviada';
        return `<div class="musica-item-fila ${enviada ? 'musica-item-fila--enviada' : ''}">
          <span class="musica-pos">#${item.posicao}</span>
          ${item.capa ? `<img class="musica-capa-mini" src="${esc(item.capa)}" alt="">` : '<span class="musica-capa-mini"></span>'}
          <div class="musica-item-txt">
            <strong>${esc(item.nome)}</strong>
            <small>${esc(item.artistas)}${item.pedidoPor ? ` · Pedida por ${esc(item.pedidoPor)}` : ''} · ${fmtDuracao(item.duracaoMs)}</small>
            <div class="musica-badges-linha">
              ${enviada ? '<span class="musica-chip musica-chip--ok">Já enviada ao Spotify</span>' : '<span class="musica-chip">Na fila do bar</span>'}
              <span class="musica-crono" data-crono-fila="${idx}"></span>
            </div>
          </div>
          <div class="musica-item-acoes">
            <button type="button" class="btn btn-secundario btn-compacto" data-rem-fila="${esc(item.id)}" data-bloq="">Remover</button>
            <button type="button" class="btn btn-perigo btn-compacto" data-rem-fila="${esc(item.id)}" data-bloq="track" title="Remover e bloquear esta música">Bloq. música</button>
            <button type="button" class="btn btn-perigo btn-compacto" data-rem-fila="${esc(item.id)}" data-bloq="artist" title="Remover e bloquear este artista">Bloq. artista</button>
          </div>
        </div>`;
      })
      .join('');

    listaFila.querySelectorAll('[data-rem-fila]').forEach((btn) => {
      btn.addEventListener('click', () => removerDaFila(btn.dataset.remFila, btn.dataset.bloq));
    });
  }
  atualizarCronometros();

  // 5. Resumo das playlists selecionadas
  const pls = cfg.playlists || [];
  const resumoPl = $('musica-resumo-playlists');
  if (pls.length) {
    resumoPl.textContent = `${pls.length} playlist(s) ativa(s) · ${d.totalCatalogo || 0} músicas sincronizadas (${pls.map((p) => p.nome).join(', ')}).`;
  } else {
    resumoPl.textContent =
      cfg.modo === 'playlists'
        ? 'Atenção: modo "Somente playlists da casa" ativo, mas nenhuma playlist foi selecionada ainda.'
        : 'Nenhuma playlist sincronizada. Clique em "Carregar playlists do Spotify" para escolher.';
  }

  // 6. Formulário de regras anti-zoeira (só preenche se nenhum campo estiver focado)
  const formRegras = $('form-musica-regras');
  if (formRegras && !formRegras.contains(document.activeElement)) {
    $('mus-cooldown').value = cfg.cooldownMin ?? 15;
    $('mus-max-fila').value = cfg.maxFila ?? 15;
    $('mus-max-artista').value = cfg.maxMesmoArtista ?? 1;
    $('mus-rep-horas').value = cfg.repeticaoHoras ?? 3;
    $('mus-limitar-duracao').checked = cfg.limitarDuracao !== false;
    $('mus-min-dur').value = cfg.minDuracaoSeg ?? 90;
    const maxMin = Number(((cfg.maxDuracaoSeg ?? 240) / 60).toFixed(1));
    $('mus-max-dur-min').value = maxMin;
    $('mus-bloco-duracao').hidden = cfg.limitarDuracao === false;
    $('mus-exigir-gps').checked = cfg.exigirGps !== false;
    $('mus-bloq-explicito').checked = Boolean(cfg.bloquearExplicito);
    destacarAtalhoDuracao(cfg.maxDuracaoSeg ?? 240);
  }

  // 7. Lista de bloqueios
  const bloqs = d.bloqueios || [];
  const listaBloq = $('musica-lista-bloqueios');
  if (!bloqs.length) {
    listaBloq.innerHTML = '<p class="estado-vazio">Nenhuma música ou artista bloqueado.</p>';
  } else {
    listaBloq.innerHTML = bloqs
      .map(
        (b) => `<div class="musica-bloq-item">
          <div>
            <span class="musica-chip">${b.tipo === 'artist' ? 'Artista' : 'Música'}</span>
            <strong>${esc(b.nome)}</strong>
          </div>
          <button type="button" class="btn btn-fantasma btn-compacto" data-desbloq="${esc(b.id)}">Desbloquear</button>
        </div>`
      )
      .join('');

    listaBloq.querySelectorAll('[data-desbloq]').forEach((btn) => {
      btn.addEventListener('click', () => desbloquearItem(btn.dataset.desbloq));
    });
  }

  // 8. Log completo de pedidos de música (com nome + aparelho + distância + rede)
  renderizarLogsMusica();
}

function fmtHoraLog(ts, mostrarData) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (mostrarData) {
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function renderizarLogsMusica() {
  const el = $('musica-lista-logs');
  const cont = $('musica-cont-logs');
  if (!el || !dadosEstado) return;

  const noiteAtual = dadosEstado.noiteAtual || '';
  const todos = Array.isArray(dadosEstado.logs) ? dadosEstado.logs : [];
  const q = normBusca(buscaLogTexto);

  const filtrados = todos.filter((item) => {
    if (filtroLogPeriodo === 'noite' && noiteAtual && item.noite !== noiteAtual) return false;
    if (!q) return true;
    const alvo = normBusca(
      `${item.pedidoPor} ${item.nome} ${item.artistas} ${item.dispositivo} ${item.aparelhoId} ${item.operadora} ${item.status}`
    );
    return alvo.includes(q);
  });

  if (cont) {
    cont.textContent = `${filtrados.length} ${filtrados.length === 1 ? 'registro' : 'registros'}`;
  }

  if (!filtrados.length) {
    el.innerHTML = `<p class="estado-vazio">${
      q ? 'Nenhum pedido encontrado com esse filtro.' : 'Nenhum pedido de música registrado neste período.'
    }</p>`;
    return;
  }

  const mostrarData = filtroLogPeriodo === 'todos';
  el.innerHTML = filtrados
    .map((item) => {
      const st = STATUS_LOG[item.status] || { txt: item.status || '—', cls: '' };
      const detalhes = [];
      if (item.dispositivo) detalhes.push(item.dispositivo);
      if (item.aparelhoId) detalhes.push(`Aparelho #${item.aparelhoId}`);
      if (typeof item.distanciaM === 'number') detalhes.push(`a ${item.distanciaM} m do bar`);
      if (item.operadora) detalhes.push(item.operadora);

      const primeiroArtista = String(item.artistas || '').split(',')[0].trim() || item.artistas;

      return `<article class="musica-log-item">
        <div class="musica-log-topo">
          ${item.capa ? `<img class="musica-capa-mini" src="${esc(item.capa)}" alt="" loading="lazy">` : '<span class="musica-capa-mini"></span>'}
          <div class="musica-item-txt">
            <div class="musica-log-cab">
              <strong>${esc(item.nome)}</strong>
              <span class="musica-log-hora">${esc(fmtHoraLog(item.criadoEm, mostrarData))}</span>
            </div>
            <small>${esc(item.artistas)} · ${fmtDuracao(item.duracaoMs)}</small>
            <div class="musica-badges-linha">
              <span class="musica-chip ${st.cls}">${esc(st.txt)}</span>
              <span class="musica-log-quem">Pedida por <strong>${esc(item.pedidoPor || 'Anônimo')}</strong></span>
            </div>
            ${detalhes.length ? `<span class="musica-log-device">${esc(detalhes.join(' · '))}</span>` : ''}
          </div>
        </div>
        <div class="musica-item-acoes musica-item-acoes--2">
          <button type="button" class="btn btn-fantasma btn-compacto" data-bloq-log-tipo="track" data-bloq-log-id="${esc(item.trackId)}" data-bloq-log-nome="${esc(`${item.nome} — ${item.artistas}`)}">Bloq. música</button>
          ${item.artistaPrincipalId ? `<button type="button" class="btn btn-fantasma btn-compacto" data-bloq-log-tipo="artist" data-bloq-log-id="${esc(item.artistaPrincipalId)}" data-bloq-log-nome="${esc(primeiroArtista)}">Bloq. artista</button>` : ''}
        </div>
      </article>`;
    })
    .join('');

  el.querySelectorAll('[data-bloq-log-tipo]').forEach((btn) => {
    btn.addEventListener('click', () =>
      bloquearDoLog(btn.dataset.bloqLogTipo, btn.dataset.bloqLogId, btn.dataset.bloqLogNome)
    );
  });
}

async function bloquearDoLog(tipo, spotifyId, nome) {
  const ok = await ctxAdm.confirmarAcao({
    titulo: tipo === 'artist' ? 'Bloquear artista' : 'Bloquear música',
    mensagem:
      tipo === 'artist'
        ? `Bloquear o artista "${nome}"? Nenhuma música desse artista poderá ser pedida na fila.`
        : `Bloquear a música "${nome}"? Ela não poderá mais ser pedida.`,
    textoConfirmar: 'Bloquear',
    perigo: true,
  });
  if (!ok) return;
  try {
    await apiAdm('/adm/bloqueios', {
      method: 'POST',
      body: JSON.stringify({ tipo, spotifyId, nome }),
    });
    ctxAdm?.mostrarToast?.(tipo === 'artist' ? 'Artista bloqueado.' : 'Música bloqueada.', 'sucesso');
    await carregarEstadoMusica({ silencioso: true });
  } catch (err) {
    ctxAdm?.mostrarToast?.(err.message || 'Erro ao bloquear.', 'erro');
  }
}

function destacarAtalhoDuracao(seg) {
  document.querySelectorAll('[data-dur-max]').forEach((b) => {
    const ativo = Number(b.dataset.durMax) === Math.round(Number(seg));
    b.classList.toggle('btn-principal', ativo);
    b.classList.toggle('btn-secundario', !ativo);
  });
}

function atualizarCronometros() {
  const d = dadosEstado;
  if (!d) return;
  const np = d.tocandoAgora;
  let restanteAtualMs = 0;

  if (np?.faixa?.duracaoMs) {
    const decorrido = np.tocando ? Date.now() - progBaseTs : 0;
    const atualMs = Math.min(np.faixa.duracaoMs, progBaseMs + decorrido);
    restanteAtualMs = Math.max(0, np.faixa.duracaoMs - atualMs);
    const pct = (atualMs / np.faixa.duracaoMs) * 100;
    const barra = $('adm-now-barra');
    const tempo = $('adm-now-tempo');
    if (barra) barra.style.width = `${pct.toFixed(1)}%`;
    if (tempo) {
      tempo.textContent = `${fmtDuracao(atualMs)} / ${fmtDuracao(np.faixa.duracaoMs)} · falta ${fmtDuracao(restanteAtualMs)}`;
    }
    if (np.tocando && restanteAtualMs <= 0 && fimDisparadoParaId !== np.faixa.trackId) {
      fimDisparadoParaId = np.faixa.trackId;
      setTimeout(() => carregarEstadoMusica({ forcar: true, silencioso: true }), 1500);
    }
  }

  // Calcula previsão ao vivo de entrada no Spotify e de reprodução para cada item da fila
  const fila = d.fila || [];
  let acumuladoMs = restanteAtualMs;
  fila.forEach((item, idx) => {
    const el = document.querySelector(`[data-crono-fila="${idx}"]`);
    if (el) {
      if (!np?.faixa) {
        el.textContent = 'Aguardando som tocar';
      } else if (item.status === 'enviada') {
        el.textContent = `Toca em ~${fmtDuracao(acumuladoMs)}`;
      } else {
        // #2 entra no Spotify assim que a #1 começar a tocar (acumulado anterior)
        const entraEmMs = idx === 0 ? 0 : acumuladoMs - Number(fila[idx - 1]?.duracaoMs || 0);
        el.textContent = `Vai pro Spotify em ~${fmtDuracao(Math.max(0, entraEmMs))} · toca em ~${fmtDuracao(acumuladoMs)}`;
      }
    }
    acumuladoMs += Number(item.duracaoMs || 0);
  });
}

async function alterarConfigRapida(patch, msgOk) {
  try {
    await apiAdm('/adm/config', { method: 'PUT', body: JSON.stringify(patch) });
    ctxAdm?.mostrarToast?.(msgOk, 'sucesso');
    await carregarEstadoMusica({ silencioso: true });
  } catch (err) {
    ctxAdm?.mostrarToast?.(err.message || 'Erro ao salvar ajuste.', 'erro');
  }
}

async function aprovarSugestao(id) {
  try {
    await apiAdm(`/adm/fila/${encodeURIComponent(id)}/aprovar`, { method: 'POST' });
    ctxAdm?.mostrarToast?.('Música aprovada e enviada para a fila!', 'sucesso');
    await carregarEstadoMusica({ forcar: true, silencioso: true });
  } catch (err) {
    ctxAdm?.mostrarToast?.(err.message || 'Erro ao aprovar sugestão.', 'erro');
  }
}

async function removerDaFila(id, bloquear) {
  const item = (dadosEstado?.fila || []).find((x) => x.id === id);
  if (bloquear) {
    const texto =
      bloquear === 'artist'
        ? `Remover e bloquear o artista "${item?.artistas || ''}"? Nenhuma música desse artista poderá ser pedida.`
        : `Remover e bloquear a música "${item?.nome || ''}"? Ela não poderá mais ser pedida.`;
    const ok = await ctxAdm.confirmarAcao({
      titulo: bloquear === 'artist' ? 'Bloquear artista' : 'Bloquear música',
      mensagem: texto,
      textoConfirmar: 'Remover e bloquear',
      perigo: true,
    });
    if (!ok) return;
  }

  try {
    const q = bloquear ? `?bloquear=${encodeURIComponent(bloquear)}` : '';
    await apiAdm(`/adm/fila/${encodeURIComponent(id)}${q}`, { method: 'DELETE' });
    ctxAdm?.mostrarToast?.(
      bloquear === 'artist'
        ? 'Artista bloqueado e removido da fila.'
        : bloquear === 'track'
          ? 'Música bloqueada e removida da fila.'
          : 'Música removida da fila.',
      'sucesso'
    );
    await carregarEstadoMusica({ silencioso: true });
  } catch (err) {
    ctxAdm?.mostrarToast?.(err.message || 'Erro ao remover música.', 'erro');
  }
}

async function desbloquearItem(id) {
  try {
    await apiAdm(`/adm/bloqueios/${encodeURIComponent(id)}`, { method: 'DELETE' });
    ctxAdm?.mostrarToast?.('Bloqueio removido.', 'sucesso');
    await carregarEstadoMusica({ silencioso: true });
  } catch (err) {
    ctxAdm?.mostrarToast?.(err.message || 'Erro ao desbloquear.', 'erro');
  }
}

async function carregarPlaylistsSpotify() {
  const btn = $('btn-carregar-playlists');
  const box = $('musica-seletor-playlists');
  btn.disabled = true;
  btn.textContent = 'Buscando playlists…';
  try {
    const res = await apiAdm('/adm/playlists');
    playlistsConta = res.playlists || [];
    const selecionadas = new Set((dadosEstado?.config?.playlists || []).map((p) => p.id));

    if (!playlistsConta.length) {
      box.innerHTML = '<p class="estado-vazio">Nenhuma playlist própria encontrada na conta conectada.</p>';
    } else {
      box.innerHTML = `
        <div class="musica-grade-playlists">
          ${playlistsConta
            .map(
              (pl) => `<label class="musica-check-pl">
                <input type="checkbox" value="${esc(pl.id)}" ${selecionadas.has(pl.id) ? 'checked' : ''}>
                ${pl.imagem ? `<img src="${esc(pl.imagem)}" alt="">` : '<span class="musica-capa-mini"></span>'}
                <span>
                  <strong>${esc(pl.nome)}</strong>
                  <small>${pl.total} músicas</small>
                </span>
              </label>`
            )
            .join('')}
        </div>
        <div class="acoes-formulario" style="margin-top: 12px;">
          <button type="button" id="btn-salvar-playlists" class="btn btn-principal">Salvar e sincronizar músicas</button>
        </div>`;

      $('btn-salvar-playlists').addEventListener('click', salvarPlaylistsSelecionadas);
    }
    box.hidden = false;
  } catch (err) {
    ctxAdm?.mostrarToast?.(err.message || 'Não foi possível listar playlists.', 'erro');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Carregar playlists do Spotify';
  }
}

async function salvarPlaylistsSelecionadas() {
  const btn = $('btn-salvar-playlists');
  const ids = [...document.querySelectorAll('#musica-seletor-playlists input[type="checkbox"]:checked')].map(
    (el) => el.value
  );
  const escolhidas = (playlistsConta || []).filter((pl) => ids.includes(pl.id));

  btn.disabled = true;
  btn.textContent = 'Sincronizando faixas…';
  try {
    const res = await apiAdm('/adm/playlists', {
      method: 'PUT',
      body: JSON.stringify({ playlists: escolhidas }),
    });
    ctxAdm?.mostrarToast?.(`Sincronizado: ${res.totalFaixas} músicas disponíveis.`, 'sucesso');
    await carregarEstadoMusica({ silencioso: true });
  } catch (err) {
    ctxAdm?.mostrarToast?.(err.message || 'Erro ao sincronizar playlists.', 'erro');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar e sincronizar músicas';
  }
}

function ligarEventos() {
  if (eventosLigados) return;
  eventosLigados = true;

  document.querySelectorAll('[data-musica-sub]').forEach((btn) => {
    btn.addEventListener('click', () => irParaSubAbaMusica(btn.dataset.musicaSub));
  });

  $('btn-spotify-conectar').addEventListener('click', async () => {
    try {
      const res = await apiAdm('/adm/oauth/iniciar', { method: 'POST' });
      if (res.url) location.href = res.url;
    } catch (err) {
      ctxAdm?.mostrarToast?.(err.message || 'Erro ao iniciar conexão com o Spotify.', 'erro');
    }
  });

  $('btn-spotify-desconectar').addEventListener('click', async () => {
    const ok = await ctxAdm.confirmarAcao({
      titulo: 'Desconectar Spotify',
      mensagem: 'Os clientes não poderão mais pedir música até você conectar novamente.',
      textoConfirmar: 'Desconectar',
      perigo: true,
    });
    if (!ok) return;
    try {
      await apiAdm('/adm/desconectar', { method: 'POST' });
      ctxAdm?.mostrarToast?.('Spotify desconectado.', 'sucesso');
      await carregarEstadoMusica({ silencioso: true });
    } catch (err) {
      ctxAdm?.mostrarToast?.(err.message || 'Erro ao desconectar.', 'erro');
    }
  });

  document.querySelectorAll('[data-musica-controle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const controle = btn.dataset.musicaControle;
      const msgs = {
        liberado: 'Controle liberado: pedidos entram direto no Spotify.',
        aprovacao: 'Modo aprovação: sugestões passam pela equipe antes de tocar.',
        desativado: 'Pedidos de música desativados (som só da casa).',
      };
      alterarConfigRapida({ controle }, msgs[controle] || 'Modo atualizado.');
    });
  });

  document.querySelectorAll('[data-musica-modo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modo = btn.dataset.musicaModo;
      alterarConfigRapida(
        { modo },
        modo === 'playlists'
          ? 'Modo alterado: somente playlists da casa.'
          : 'Modo alterado: Spotify aberto com filtros.'
      );
    });
  });

  $('btn-musica-atualizar').addEventListener('click', () => carregarEstadoMusica({ forcar: true }));

  $('btn-musica-pular').addEventListener('click', async () => {
    try {
      await apiAdm('/adm/pular', { method: 'POST' });
      ctxAdm?.mostrarToast?.('Faixa pulada no Spotify.', 'sucesso');
      setTimeout(() => carregarEstadoMusica({ forcar: true, silencioso: true }), 900);
    } catch (err) {
      ctxAdm?.mostrarToast?.(err.message || 'Não foi possível pular agora.', 'erro');
    }
  });

  $('btn-musica-zerar').addEventListener('click', async () => {
    const ok = await ctxAdm.confirmarAcao({
      titulo: 'Zerar fila de música',
      mensagem: 'Todas as músicas aguardando na fila de hoje serão removidas.',
      textoConfirmar: 'Zerar fila',
      perigo: true,
    });
    if (!ok) return;
    try {
      const r = await apiAdm('/adm/fila/zerar', { method: 'POST' });
      ctxAdm?.mostrarToast?.(`Fila zerada (${r.removidas || 0} removida(s)).`, 'sucesso');
      await carregarEstadoMusica({ silencioso: true });
    } catch (err) {
      ctxAdm?.mostrarToast?.(err.message || 'Erro ao zerar fila.', 'erro');
    }
  });

  $('btn-carregar-playlists').addEventListener('click', carregarPlaylistsSpotify);

  $('mus-limitar-duracao').addEventListener('change', (e) => {
    $('mus-bloco-duracao').hidden = !e.target.checked;
  });

  document.querySelectorAll('[data-dur-max]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const seg = Number(btn.dataset.durMax);
      $('mus-max-dur-min').value = Number((seg / 60).toFixed(1));
      destacarAtalhoDuracao(seg);
    });
  });

  $('mus-max-dur-min').addEventListener('input', (e) => {
    destacarAtalhoDuracao(Math.round(Number(e.target.value || 0) * 60));
  });

  $('form-musica-regras').addEventListener('submit', async (e) => {
    e.preventDefault();
    const maxSeg = Math.round(Number($('mus-max-dur-min').value || 4) * 60);
    const patch = {
      cooldownMin: Number($('mus-cooldown').value),
      maxFila: Number($('mus-max-fila').value),
      maxMesmoArtista: Number($('mus-max-artista').value),
      repeticaoHoras: Number($('mus-rep-horas').value),
      limitarDuracao: $('mus-limitar-duracao').checked,
      minDuracaoSeg: Number($('mus-min-dur').value),
      maxDuracaoSeg: maxSeg,
      exigirGps: $('mus-exigir-gps').checked,
      bloquearExplicito: $('mus-bloq-explicito').checked,
    };
    await alterarConfigRapida(patch, 'Regras de proteção salvas.');
  });
  document.querySelectorAll('[data-log-periodo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filtroLogPeriodo = btn.dataset.logPeriodo;
      document.querySelectorAll('[data-log-periodo]').forEach((b) => {
        b.classList.toggle('ativo', b.dataset.logPeriodo === filtroLogPeriodo);
      });
      renderizarLogsMusica();
    });
  });

  $('busca-musica-logs')?.addEventListener('input', (e) => {
    buscaLogTexto = e.target.value || '';
    renderizarLogsMusica();
  });

  $('form-musica-servidor')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const bruto = ($('mus-api-url')?.value || '').trim();
    const norm = normalizarBaseApi(bruto);
    if (bruto && !norm) {
      ctxAdm?.mostrarToast?.('Digite uma URL https:// válida do Cloudflare Worker.', 'erro');
      return;
    }
    try {
      await setDoc(doc(db, 'config', 'loja'), { musicaApi: bruto ? bruto.replace(/\/+$/, '') : '' }, { merge: true });
      API_BASE = atualizarCacheApiBase(bruto);
      apiPronta = Promise.resolve(API_BASE);
      ctxAdm?.mostrarToast?.('Endereço do servidor de música salvo.', 'sucesso');
      await carregarEstadoMusica({ forcar: true });
    } catch (err) {
      ctxAdm?.mostrarToast?.(err.message || 'Erro ao salvar endereço.', 'erro');
    }
  });

  // Retorno à aba / reconexão atualiza na hora (sem precisar dar F5)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctxAdm?.obterUsuario?.()) {
      carregarEstadoMusica({ forcar: telaAberta, silencioso: true });
    }
  });
  window.addEventListener('focus', () => {
    if (telaAberta && ctxAdm?.obterUsuario?.()) {
      carregarEstadoMusica({ silencioso: true });
    }
  });
  window.addEventListener('online', () => {
    if (ctxAdm?.obterUsuario?.()) {
      carregarEstadoMusica({ forcar: true, silencioso: true });
    }
  });
}

export function iniciarMusicaAdm(contexto) {
  ctxAdm = contexto;
  ligarEventos();

  // Retorno do OAuth do Spotify (?spotify=ok ou ?spotify=erro&msg=...)
  const params = new URLSearchParams(location.search);
  const sp = params.get('spotify');
  if (sp) {
    const msg = params.get('msg') || '';
    ctxAdm.navegarParaTela?.('musica');
    if (sp === 'ok') {
      ctxAdm.mostrarToast?.('Spotify da casa conectado com sucesso!', 'sucesso');
    } else {
      ctxAdm.mostrarToast?.(msg || 'Não foi possível conectar o Spotify.', 'erro');
    }
    params.delete('spotify');
    params.delete('msg');
    const novaUrl = `${location.pathname}${params.toString() ? `?${params.toString()}` : ''}${location.hash}`;
    history.replaceState(null, '', novaUrl);
  }

  // Carga inicial + vigia leve (30s) mesmo em outra aba para manter o badge ao vivo
  apiPronta.then((base) => {
    const campoUrl = $('mus-api-url');
    if (campoUrl && !campoUrl.value && base.startsWith('https://')) {
      campoUrl.value = base.replace(/\/api\/musica$/, '');
    }
  });
  carregarEstadoMusica({ silencioso: true });
  clearInterval(timerFundo);
  timerFundo = setInterval(() => {
    if (!telaAberta && document.visibilityState === 'visible' && ctxAdm?.obterUsuario?.()) {
      carregarEstadoMusica({ silencioso: true });
    }
  }, 30_000);
}

export function aoAbrirTelaMusica() {
  telaAberta = true;
  carregarEstadoMusica({ forcar: true });
  clearInterval(timerAtualizacao);
  timerAtualizacao = setInterval(() => {
    if (telaAberta && document.visibilityState === 'visible') {
      carregarEstadoMusica({ silencioso: true });
    }
  }, 8_000);
  clearInterval(timerRelogio);
  timerRelogio = setInterval(() => {
    if (telaAberta && document.visibilityState === 'visible') {
      atualizarCronometros();
    }
  }, 1000);
}

export function aoSairTelaMusica() {
  telaAberta = false;
  clearInterval(timerAtualizacao);
  timerAtualizacao = null;
  clearInterval(timerRelogio);
  timerRelogio = null;
}

export function encerrarMusicaAdm() {
  aoSairTelaMusica();
  clearInterval(timerFundo);
  timerFundo = null;
  dadosEstado = null;
  playlistsConta = null;
  atualizarBadges(0);
}
