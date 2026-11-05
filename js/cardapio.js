// Rainbow Pub — cardápio público e pedido com conferência de GPS.
// Pensado para quem está no bar: uma categoria por vez, botões grandes, pedido em 2 passos.
import { db } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, addDoc, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
  brl, esc, distancia, situacao, noiteDe, codigo, STATUS,
  LOJA_INICIAL, CATEGORIAS_INICIAIS, ITENS_INICIAIS,
} from './base.js';
import { desenharArco, acender } from './letreiro.js';

const $ = (s, el = document) => el.querySelector(s);
const calmo = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CACHE = 'rainbow:cardapio:v2';
const MEUS = 'rainbow:pedidos';
const NOME = 'rainbow:nome';

const estado = {
  loja: LOJA_INICIAL,
  categorias: [],
  itens: [],
  online: false,
  pedido: new Map(),   // id do item → quantidade
  local: '',
  numero: '',
  obs: '',
  passo: 1,
};

const ICONE = {
  mais: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  menos: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  pino: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-7.2 7-12a7 7 0 1 0-14 0c0 4.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.6"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

/* ─────────────── Dados ─────────────── */
const ordenar = (a, b) => (a.ordem ?? 0) - (b.ordem ?? 0);
function aplicar({ loja, categorias, itens }) {
  estado.loja = { ...LOJA_INICIAL, ...loja };
  estado.categorias = categorias.slice().sort(ordenar);
  estado.itens = itens.filter((i) => i.ativo !== false).sort(ordenar);
}

async function carregar() {
  try {
    const salvo = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (salvo) { aplicar(salvo); montar(); }
  } catch { /* cache estragado */ }
  try {
    const [lojaSnap, catSnap, itemSnap] = await Promise.race([
      Promise.all([getDoc(doc(db, 'config', 'loja')), getDocs(collection(db, 'categorias')), getDocs(collection(db, 'itens'))]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('demorou')), 9000)),
    ]);
    const dados = {
      loja: lojaSnap.exists() ? lojaSnap.data() : LOJA_INICIAL,
      categorias: catSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      itens: itemSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    };
    if (!dados.categorias.length) throw new Error('vazio');
    estado.online = true;
    aplicar(dados);
    try { localStorage.setItem(CACHE, JSON.stringify(dados)); } catch { /* sem espaço */ }
  } catch {
    if (!estado.categorias.length) aplicar({ loja: LOJA_INICIAL, categorias: CATEGORIAS_INICIAIS, itens: ITENS_INICIAIS });
    estado.online = false;
  }
  montar();
}

const itemPorId = (id) => estado.itens.find((i) => i.id === id);
const catPorId = (id) => estado.categorias.find((c) => c.id === id);
const itensDa = (catId) => estado.itens.filter((i) => i.categoria === catId);

/* ─────────────── Topo e rodapé ─────────────── */
function montarCasa() {
  const l = estado.loja;
  const s = situacao(l.semana || LOJA_INICIAL.semana);
  $('#situacao').classList.toggle('aberto', s.aberto);
  $('#situacaoTexto').textContent = s.texto;
  $('#horarios').innerHTML = (l.horariosTexto || []).map((h) => `<li>${esc(h)}</li>`).join('');
  $('#endereco').textContent = l.endereco || '';
  $('#aviso').hidden = !l.aviso;
  $('#aviso').textContent = l.aviso || '';
}

/* ─────────────── Tela 1: blocos ─────────────── */
function montarBlocos() {
  const html = estado.categorias.filter((c) => itensDa(c.id).length).map((c) => {
    const itens = itensDa(c.id);
    const menor = Math.min(...itens.map((i) => Number(i.preco) || 0));
    return `<button class="bloco" type="button" data-cat="${esc(c.id)}" style="--c:${esc(c.cor || '#f6cfdb')}">
      <span class="bloco__nome">${esc(c.nome)}</span>
      <span class="bloco__info">${itens.length} opções · a partir de ${brl(menor)}</span>
    </button>`;
  }).join('');
  $('#blocos').innerHTML = html || '<p class="carregando">Cardápio vazio por enquanto.</p>';
}

/* ─────────────── Tela 2: uma categoria ─────────────── */
function copo(cores = ['#d9a1b5', '#f3d9e2']) {
  const [base, topo] = cores;
  const id = 'g' + Math.random().toString(36).slice(2, 7);
  return `<svg class="prod__copo" viewBox="0 0 74 96" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="${esc(base)}"/><stop offset=".62" stop-color="${esc(base)}"/><stop offset=".9" stop-color="${esc(topo)}"/>
      </linearGradient>
      <clipPath id="${id}c"><path d="M14 26 L60 26 L55 86 Q54 90 50 90 L24 90 Q20 90 19 86 Z"/></clipPath>
    </defs>
    <g clip-path="url(#${id}c)">
      <rect x="0" y="34" width="74" height="60" fill="url(#${id})"/>
      <rect x="22" y="38" width="13" height="12" rx="2" fill="#fff" opacity=".35" transform="rotate(-12 28 44)"/>
      <rect x="38" y="44" width="12" height="11" rx="2" fill="#fff" opacity=".3" transform="rotate(14 44 49)"/>
    </g>
    <path d="M14 26 L60 26 L55 86 Q54 90 50 90 L24 90 Q20 90 19 86 Z" fill="none" stroke="rgba(246,207,219,.55)" stroke-width="1.6"/>
    <path d="M50 26 L58 6" stroke="rgba(246,207,219,.7)" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="20" cy="27" r="7" fill="none" stroke="${esc(topo)}" stroke-width="2.4"/>
  </svg>`;
}

function acao(item) {
  if (item.esgotado) return '<span class="esgotou">Acabou por hoje</span>';
  const n = estado.pedido.get(item.id) || 0;
  if (!n) {
    return `<button class="add" type="button" data-add="${esc(item.id)}" aria-label="Adicionar ${esc(item.nome)}">${ICONE.mais}Adicionar</button>`;
  }
  return `<div class="qtd" data-id="${esc(item.id)}">
    <button type="button" class="menos" data-delta="-1" aria-label="Tirar um ${esc(item.nome)}">${ICONE.menos}</button>
    <span class="qtd__n" aria-live="polite">${n}</span>
    <button type="button" class="mais" data-delta="1" aria-label="Mais um ${esc(item.nome)}">${ICONE.mais}</button>
  </div>`;
}

function htmlProd(item) {
  // com foto: a foto vai grande no topo do cartão; sem foto, drinks da casa ganham o copo desenhado
  const visual = item.foto
    ? `<img class="prod__capa" src="${esc(item.foto)}" alt="${esc(item.nome)}" loading="lazy">`
    : (item.cor ? copo(item.cor) : '');
  return `<li class="prod ${item.foto ? 'prod--foto' : ''} ${item.esgotado ? 'esgotado' : ''}" data-prod="${esc(item.id)}">
    ${visual}
    <div>
      <h3 class="prod__nome">${esc(item.nome)}</h3>
      ${item.desc ? `<p class="prod__desc">${esc(item.desc)}</p>` : ''}
    </div>
    <span class="prod__preco">${brl(item.preco)}</span>
    <div class="prod__acao">${acao(item)}</div>
  </li>`;
}

function montarCategoria(catId) {
  const cat = catPorId(catId);
  if (!cat) return irPara('');
  const sec = $('#categoria');
  sec.style.setProperty('--c', cat.cor || '#f6cfdb');
  $('#catTitulo').textContent = cat.nome;
  const itens = itensDa(catId);
  const grupos = [...new Set(itens.map((i) => i.grupo || ''))];
  $('#catLista').innerHTML = grupos.map((g) => `
    ${g ? `<h3 class="grupo">${esc(g)}</h3>` : ''}
    <ul class="produtos">${itens.filter((i) => (i.grupo || '') === g).map(htmlProd).join('')}</ul>`).join('');
}

function atualizarProd(id) {
  const it = itemPorId(id);
  document.querySelectorAll(`[data-prod="${CSS.escape(id)}"] .prod__acao`).forEach((el) => { el.innerHTML = acao(it); });
}

/* ─────────────── Navegação (hash: #drinks, #cervejas…) ─────────────── */
function irPara(catId) {
  const alvo = catId ? '#' + catId : '#cardapio';
  if (location.hash !== alvo) location.hash = alvo; else rota();
}
function rota() {
  const id = decodeURIComponent(location.hash.slice(1));
  const cat = id && id !== 'cardapio' ? catPorId(id) : null;
  $('#escolha').hidden = !!cat;
  $('#categoria').hidden = !cat;
  // dentro de uma categoria a tela mostra só ela (sem letreiro nem rodapé)
  document.body.classList.toggle('modo-categoria', !!cat);
  if (cat) {
    montarCategoria(cat.id);
    scrollTo(0, 0);
  } else if (id === 'cardapio') {
    $('#cardapio').scrollIntoView({ behavior: calmo ? 'auto' : 'smooth', block: 'start' });
  }
}
addEventListener('hashchange', rota);
$('#voltar').addEventListener('click', () => irPara(''));
$('#voltarFim').addEventListener('click', () => irPara(''));

/* ─────────────── Pedido (quantidades) ─────────────── */
function totais() {
  let qtd = 0, total = 0;
  for (const [id, n] of estado.pedido) {
    const it = itemPorId(id);
    if (!it) continue;
    qtd += n; total += n * Number(it.preco || 0);
  }
  return { qtd, total: Math.round(total * 100) / 100 };
}

function mudar(id, delta) {
  const it = itemPorId(id);
  if (!it || (delta > 0 && it.esgotado)) return;
  const n = Math.max(0, Math.min(30, (estado.pedido.get(id) || 0) + delta));
  if (n) estado.pedido.set(id, n); else estado.pedido.delete(id);
  atualizarProd(id);
  atualizarBarra(delta > 0);
  if (!$('#folha').hidden && estado.passo === 1) passoRevisar();
  if (navigator.vibrate && delta > 0) navigator.vibrate(12);
}

document.addEventListener('click', (e) => {
  const bloco = e.target.closest('[data-cat]');
  if (bloco) return irPara(bloco.dataset.cat);
  const add = e.target.closest('[data-add]');
  if (add) return mudar(add.dataset.add, 1);
  const b = e.target.closest('.qtd button');
  if (b) mudar(b.closest('.qtd').dataset.id, Number(b.dataset.delta));
});

/* ─────────────── Barra de baixo ─────────────── */
const ETAPAS = ['novo', 'preparo', 'pronto', 'entregue'];
const COR_ETAPA = { novo: '#3B82E0', preparo: '#F5CB3B', pronto: '#3DBE6A', entregue: '#9157E0', cancelado: '#E5484D' };
let statusAcompanhado = 'novo';

function atualizarBarra(pular = false) {
  const barra = $('#barra');
  const { qtd, total } = totais();
  const acompanhando = pedidoAberto();
  barra.classList.remove('barra--acompanha');
  if (qtd) {
    barra.hidden = false;
    $('#barraQtd').textContent = qtd;
    $('#barraTexto').innerHTML = 'Ver meu pedido';
    $('#barraTotal').textContent = brl(total);
  } else if (acompanhando) {
    barra.hidden = false;
    barra.classList.add('barra--acompanha');
    barra.style.setProperty('--c', COR_ETAPA[statusAcompanhado] || COR_ETAPA.novo);
    $('#barraQtd').textContent = '';
    $('#barraTexto').innerHTML = `Pedido Nº ${esc(codigo(acompanhando))}<small>${esc(STATUS[statusAcompanhado] || 'Recebido')} · toque para ver</small>`;
    $('#barraTotal').textContent = '';
  } else {
    barra.hidden = true;
  }
  if (pular && !calmo) { barra.classList.remove('pulou'); void barra.offsetWidth; barra.classList.add('pulou'); }
}

/* ─────────────── Folha do pedido ─────────────── */
function abrirFolha() {
  $('#folha').hidden = false;
  document.body.classList.add('travado');
  const { qtd } = totais();
  if (!qtd && pedidoAberto()) acompanhar(pedidoAberto());
  else passoRevisar();
}
function fecharFolha() {
  $('#folha').hidden = true;
  document.body.classList.remove('travado');
  pararAcompanhamento?.();
  atualizarBarra();
}
$('#barra').addEventListener('click', abrirFolha);
$('#folhaFechar').addEventListener('click', fecharFolha);
$('#folha').addEventListener('click', (e) => { if (e.target.id === 'folha') fecharFolha(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#folha').hidden) fecharFolha(); });
$('#folhaVoltar').addEventListener('click', () => passoRevisar());

function cabecalho(passo, titulo) {
  estado.passo = passo;
  $('#folhaTitulo').textContent = titulo;
  $('#folhaVoltar').hidden = passo !== 2;
  document.querySelectorAll('#passos li').forEach((li, i) => li.classList.toggle('feito', i < passo));
  $('#folhaCorpo').scrollTop = 0;
}

// Passo 1: conferir o que vai pedir
function passoRevisar() {
  cabecalho(1, 'Seu pedido');
  const { total } = totais();
  const linhas = [...estado.pedido].map(([id, n]) => {
    const it = itemPorId(id);
    if (!it) return '';
    const grupo = it.grupo && !/autora/i.test(it.grupo) && it.grupo !== it.nome ? `<small>${esc(it.grupo)}</small>` : '';
    return `<li class="linha">
      <span class="linha__nome">${esc(it.nome)}${grupo}</span>
      <span class="linha__valor">${brl(n * it.preco)}</span>
      <div class="qtd" data-id="${esc(id)}">
        <button type="button" class="menos" data-delta="-1" aria-label="Tirar um">${ICONE.menos}</button>
        <span class="qtd__n">${n}</span>
        <button type="button" class="mais" data-delta="1" aria-label="Mais um">${ICONE.mais}</button>
      </div>
    </li>`;
  }).join('');

  if (!linhas) {
    $('#folhaCorpo').innerHTML = `<p class="nota" style="font-size:18px">Seu pedido está vazio.</p>
      <button class="botao botao--largo" type="button" id="fVer">Ver o cardápio</button>`;
    $('#fVer').addEventListener('click', () => { fecharFolha(); irPara(''); });
    return;
  }
  $('#folhaCorpo').innerHTML = `
    <ul class="linhas">${linhas}</ul>
    <div class="total"><span>Total</span><strong>${brl(total)}</strong></div>
    <p class="nota">Você paga no balcão, como sempre.</p>
    <button class="botao botao--grande botao--largo" type="button" id="fContinuar">Continuar</button>
    <button class="botao botao--contorno botao--largo" type="button" id="fMais" style="margin-top:10px">Pedir mais coisas</button>`;
  $('#fContinuar').addEventListener('click', () => passoDados());
  $('#fMais').addEventListener('click', fecharFolha);
}

// Passo 2: nome e onde está
function passoDados(recado = '') {
  cabecalho(2, 'Quem e onde?');
  const l = estado.loja;
  const locais = l.locais?.length ? l.locais : LOJA_INICIAL.locais;
  if (!locais.includes(estado.local)) estado.local = locais[0];
  const pedeNumero = /mesa|sinuca/i.test(estado.local);
  const pode = estado.online && l.aceitandoPedidos !== false;
  const { total } = totais();

  $('#folhaCorpo').innerHTML = `
    ${recado}
    <label class="campo"><span class="campo__rotulo">Seu nome</span>
      <input id="fNome" maxlength="40" autocomplete="given-name" enterkeyhint="done" placeholder="Como te chamam?" value="${esc(localStorage.getItem(NOME) || '')}">
    </label>
    <div class="campo"><span class="campo__rotulo">Onde você está?</span>
      <div class="locais" role="group" aria-label="Onde você está">
        ${locais.map((x) => `<button type="button" data-local="${esc(x)}" aria-pressed="${x === estado.local}">${esc(x)}</button>`).join('')}
      </div>
    </div>
    ${pedeNumero ? `<label class="campo campo--numero"><span class="campo__rotulo">Número da ${esc(estado.local.toLowerCase())}</span>
      <input id="fNumero" inputmode="numeric" maxlength="3" placeholder="—" value="${esc(estado.numero)}"></label>` : ''}
    ${estado.obs
      ? `<label class="campo"><span class="campo__rotulo">Observação</span><textarea id="fObs" maxlength="240" rows="2">${esc(estado.obs)}</textarea></label>`
      : '<button class="link-obs" type="button" id="fObsAbrir">+ Escrever uma observação</button>'}
    ${l.gps?.ativo ? `<div class="aviso-gps">${ICONE.pino}<span><strong>O celular vai pedir sua localização.</strong> Toque em <strong>Permitir</strong>: é só para confirmar que você está no Rainbow.</span></div>` : ''}
    ${pode ? '' : `<p class="recado">${!estado.online ? 'Sem internet agora. Peça no balcão.' : 'Os pedidos pelo celular estão pausados. Peça no balcão.'}</p>`}
    <button class="botao botao--grande botao--largo" type="button" id="fEnviar" ${pode ? '' : 'disabled'}>Enviar pedido · ${brl(total)}</button>`;

  const guardar = () => {
    const n = $('#fNome')?.value.trim(); if (n) localStorage.setItem(NOME, n);
    if ($('#fObs')) estado.obs = $('#fObs').value;
  };
  document.querySelectorAll('[data-local]').forEach((b) => b.addEventListener('click', () => { guardar(); estado.local = b.dataset.local; passoDados(); }));
  $('#fNumero')?.addEventListener('input', (e) => { estado.numero = e.target.value.replace(/\D/g, ''); e.target.value = estado.numero; });
  $('#fObsAbrir')?.addEventListener('click', () => { guardar(); estado.obs = ' '; passoDados(); $('#fObs').value = ''; estado.obs = ''; $('#fObs').focus(); });
  $('#fEnviar').addEventListener('click', () => { guardar(); enviar(); });
}

/* ─────────────── GPS e envio ─────────────── */
function posicao() {
  return new Promise((ok, falha) => {
    if (!('geolocation' in navigator)) return falha({ code: 'sem' });
    navigator.geolocation.getCurrentPosition(ok, falha, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}
const recado = (t) => `<p class="recado">${t}</p>`;

async function enviar() {
  const nome = ($('#fNome').value || '').trim().replace(/\s+/g, ' ');
  if (nome.length < 2) { $('#fNome').focus(); $('#fNome').placeholder = 'Escreva seu nome aqui'; return; }
  const pedeNumero = /mesa|sinuca/i.test(estado.local);
  if (pedeNumero && !estado.numero) { $('#fNumero').focus(); return; }
  localStorage.setItem(NOME, nome);
  const local = pedeNumero ? `${estado.local} ${estado.numero}` : estado.local;
  const obs = (estado.obs || '').trim();

  const gps = estado.loja.gps || {};
  let geo = null;
  if (gps.ativo) {
    $('#folhaVoltar').hidden = true;
    $('#folhaCorpo').innerHTML = `<div class="gps" role="status">
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle class="onda" cx="40" cy="66" r="14"/><circle class="onda" cx="40" cy="66" r="14"/>
        <path class="pino" d="M40 66s18-18.5 18-33a18 18 0 1 0-36 0c0 14.5 18 33 18 33z"/><circle class="pino" cx="40" cy="33" r="6.5"/>
      </svg>
      <h3>Conferindo se você está no Rainbow…</h3>
      <p>Se o celular perguntar, toque em <strong>Permitir</strong>.</p>
    </div>`;
    try {
      const p = await posicao();
      geo = { lat: p.coords.latitude, lng: p.coords.longitude, precisao: Math.round(p.coords.accuracy) };
    } catch (err) {
      return passoDados(recado(err.code === 1
        ? '<strong>A localização está bloqueada.</strong> Toque no cadeado ao lado do endereço do site, libere a <strong>Localização</strong> e tente de novo.'
        : err.code === 'sem'
          ? '<strong>Este celular não mostrou a localização.</strong> Peça no balcão.'
          : '<strong>Não achamos sua localização.</strong> Ligue o GPS (localização) do celular e tente de novo.'));
    }
    const dist = distancia(geo, gps);
    const c = gps.caixa;
    const dentro = dist <= gps.raio && (!c || (geo.lat >= c.latMin && geo.lat <= c.latMax && geo.lng >= c.lngMin && geo.lng <= c.lngMax));
    if (!dentro) {
      const longe = dist >= 1000 ? (dist / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(dist) + ' m';
      const fraco = geo.precisao > 120 ? ' O sinal está fraco: chegue perto da porta e tente de novo.' : '';
      return passoDados(recado(`<strong>Você parece estar a ${longe} do Rainbow.</strong> Pedido pelo celular só vale aqui dentro.${fraco}`));
    }
  }

  const itens = [...estado.pedido].map(([id, qtd]) => {
    const it = itemPorId(id);
    return { id, nome: it.nome, grupo: it.grupo || '', cat: it.categoria, preco: Number(it.preco), qtd };
  });
  const pedido = { nome, local, itens, total: totais().total, status: 'novo', pago: false, criadoEm: serverTimestamp(), noite: noiteDe(new Date()) };
  if (obs) pedido.obs = obs;
  if (geo) pedido.geo = geo;

  const btn = $('#fEnviar'); if (btn) btn.disabled = true;
  try {
    const ref = await addDoc(collection(db, 'pedidos'), pedido);
    const meus = JSON.parse(localStorage.getItem(MEUS) || '[]').filter((p) => Date.now() - p.t < 12 * 3600e3);
    meus.unshift({ id: ref.id, t: Date.now() });
    localStorage.setItem(MEUS, JSON.stringify(meus.slice(0, 10)));
    const ids = [...estado.pedido.keys()];
    estado.pedido.clear();
    estado.obs = '';
    ids.forEach(atualizarProd);
    statusAcompanhado = 'novo';
    acompanhar(ref.id);
  } catch (e) {
    passoDados(recado(String(e?.code || '').includes('permission')
      ? '<strong>O bar não aceitou o pedido agora.</strong> Os pedidos podem estar pausados. Peça no balcão.'
      : '<strong>Não conseguimos enviar.</strong> Confira a internet e tente de novo.'));
  }
}

/* ─────────────── Acompanhar ─────────────── */
function pedidoAberto() {
  try {
    const p = JSON.parse(localStorage.getItem(MEUS) || '[]').find((x) => Date.now() - x.t < 6 * 3600e3 && !x.fim);
    return p?.id || null;
  } catch { return null; }
}
function marcarFim(id) {
  const meus = JSON.parse(localStorage.getItem(MEUS) || '[]');
  meus.forEach((p) => { if (p.id === id) p.fim = true; });
  localStorage.setItem(MEUS, JSON.stringify(meus));
}

let pararAcompanhamento = null;
function acompanhar(id) {
  pararAcompanhamento?.();
  cabecalho(3, 'Pedido enviado');
  $('#folhaVoltar').hidden = true;
  if ($('#folha').hidden) { $('#folha').hidden = false; document.body.classList.add('travado'); }
  const corpo = $('#folhaCorpo');
  pararAcompanhamento = onSnapshot(doc(db, 'pedidos', id), (snap) => {
    if (!snap.exists()) { corpo.innerHTML = '<p class="nota">Pedido não encontrado.</p>'; marcarFim(id); return; }
    const p = snap.data();
    statusAcompanhado = p.status;
    const idx = ETAPAS.indexOf(p.status);
    if (p.status === 'entregue' || p.status === 'cancelado') marcarFim(id);
    corpo.innerHTML = `<div class="pronto">
      ${p.status === 'cancelado' ? '' : `<div class="pronto__icone">${ICONE.ok}</div><h3>A gente recebeu!</h3>`}
      <div class="numero"><small>Seu pedido</small><b>Nº ${esc(codigo(id))}</b><span>${esc(p.nome)} · ${esc(p.local)}</span></div>
      ${p.status === 'cancelado'
        ? '<p class="cancelado">Esse pedido foi cancelado. Fale com a gente no balcão.</p>'
        : `<p class="agora" style="--c:${COR_ETAPA[p.status]}"><i aria-hidden="true"></i>Agora: ${esc(STATUS[p.status])}</p>
           <ol class="andamento">${ETAPAS.map((s, i) => `<li class="${i <= idx ? 'feito' : ''}" style="--c:${COR_ETAPA[ETAPAS[idx]] || '#f6cfdb'}">${STATUS[s]}</li>`).join('')}</ol>`}
      <ul class="linhas">${(p.itens || []).map((it) => `<li class="linha"><span class="linha__nome">${it.qtd}× ${esc(it.nome)}</span><span class="linha__valor">${brl(it.qtd * it.preco)}</span></li>`).join('')}</ul>
      <div class="total"><span>Total</span><strong>${brl(p.total)}</strong></div>
      <p class="nota">${p.pago ? 'Pago. Obrigado!' : 'Pague no balcão quando quiser.'} Esta tela atualiza sozinha.</p>
      <button class="botao botao--largo" type="button" id="fOutro">Pedir mais alguma coisa</button>
    </div>`;
    $('#fOutro').addEventListener('click', () => { fecharFolha(); irPara(''); });
  }, () => { corpo.innerHTML = '<p class="nota">Seu pedido foi enviado. Não deu para acompanhar agora.</p>'; });
}

/* ─────────────── Boas-vindas de quem já pediu ─────────────── */
// O nome fica guardado no celular depois do primeiro pedido; na volta o letreiro cumprimenta.
const FRASES = [
  'Mais cor, mais vibes, mais Rainbow!',
  'Vem pro Rainbow, vem ser feliz!',
  'Seja você. Seja livre.',
  'Somos todas as cores.',
  'Aqui ninguém precisa se explicar. Chegou, é de casa.',
  'O drink é feito na hora e o atendimento é de coração.',
  'Bora brindar, colocar o papo em dia e rir com a galera.',
  'A sinuca está te esperando.',
];
function boasVindas() {
  let jaPediu = false;
  try { jaPediu = JSON.parse(localStorage.getItem(MEUS) || '[]').length > 0; } catch { /* nada */ }
  const nome = (localStorage.getItem(NOME) || '').trim().split(' ')[0];
  if (!jaPediu || !nome) return;
  const quinta = new Date().getDay() === 4;
  const frases = quinta ? [...FRASES, 'Hoje é quinta: caipirinha em dobro até a meia-noite!'] : FRASES;
  const bordao = $('.bordao').textContent.trim();
  const opcoes = frases.filter((f) => f !== bordao);
  $('#voltaNome').textContent = `Que bom te ver de volta, ${nome}!`;
  $('#voltaFrase').textContent = quinta ? frases[frases.length - 1] : opcoes[Math.floor(Math.random() * opcoes.length)];
  $('#volta').hidden = false;
}

/* ─────────────── Início ─────────────── */
function montar() {
  montarCasa();
  montarBlocos();
  for (const id of [...estado.pedido.keys()]) {
    const it = itemPorId(id);
    if (!it || it.esgotado) estado.pedido.delete(id);
  }
  rota();
  atualizarBarra();
}

desenharArco($('#arco'));
boasVindas();
acender($('#topo'), [$('.bordao'), $('#volta'), $('#situacao'), $('#acoes')]);
carregar();
setInterval(montarCasa, 60_000);
