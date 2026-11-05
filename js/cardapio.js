// Rainbow Pub — cardápio público, comanda e pedido com conferência de GPS.
import { db } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, addDoc, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
  brl, esc, distancia, situacao, noiteDe, codigo, STATUS,
  LOJA_INICIAL, CATEGORIAS_INICIAIS, ITENS_INICIAIS,
} from './base.js';

const $ = (s, el = document) => el.querySelector(s);
const calmo = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CACHE = 'rainbow:cardapio:v1';
const MEUS = 'rainbow:pedidos';
const NOME = 'rainbow:nome';

const estado = {
  loja: LOJA_INICIAL,
  categorias: [],
  itens: [],
  online: false,          // dados vieram do Firestore (pode pedir)
  comanda: new Map(),     // id → qtd
  local: '',
  localNumero: '',
};

/* ─────────────── Letreiro ─────────────── */
// Arco em "A" como no logo: 6 tubos concêntricos com pernas retas, do vermelho (fora) ao violeta (dentro).
function desenharArco(cores) {
  const svg = $('#arco');
  const cx = 50, base = 110, topo = 50;   // centro do semicírculo em y=topo
  const passo = 8.2;
  let html = '';
  cores.forEach((c, i) => {
    const r = 45 - i * passo;
    const d = `M ${cx - r} ${base} V ${topo} A ${r} ${r} 0 0 1 ${cx + r} ${topo} V ${base}`;
    html += `<g class="tubo" data-i="${i}" style="--c:${c}">
      <path class="tubo__vidro" d="${d}" stroke="${c}"/>
      <path class="tubo__luz" d="${d}" stroke="${c}"/>
      <path class="tubo__miolo" d="${d}"/>
    </g>`;
  });
  // presilhas que seguram os tubos na parede
  [[cx - 45, 92], [cx + 45, 92], [cx, 50 - 45]].forEach(([x, y]) => {
    html += `<rect class="presilha" x="${x - 2.5}" y="${y - 4}" width="5" height="8" rx="1.2" ${y < 20 ? 'transform="rotate(90 ' + x + ' ' + y + ')"' : ''}/>`;
  });
  svg.innerHTML = html;
}

function acenderLetreiro() {
  const topo = $('#topo');
  const tubos = [...document.querySelectorAll('#arco .tubo')];
  const depois = [$('.bordao'), $('#situacao'), $('#legenda'), $('.como')];
  depois.forEach((el) => el.classList.add('depois'));

  if (calmo) {
    tubos.forEach((t) => t.classList.add('aceso'));
    topo.classList.add('pintado', 'ligado', 'pub-aceso', 'mostrar');
    return;
  }
  requestAnimationFrame(() => topo.classList.add('pintado'));
  // cada tubo "pega" no reator com o tremido do neon, de fora para dentro
  tubos.forEach((t, i) => setTimeout(() => {
    t.classList.add('aceso', 'acendendo');
    if (i === 0) topo.classList.add('ligado');
  }, 450 + i * 190));
  const fim = 450 + tubos.length * 190;
  setTimeout(() => topo.classList.add('pub-aceso'), fim + 150);
  setTimeout(() => topo.classList.add('mostrar'), fim + 450);

  // de vez em quando um tubo falha, como neon de verdade (só com a página visível e o topo na tela)
  let visivel = true;
  new IntersectionObserver(([e]) => { visivel = e.isIntersecting; }).observe(topo);
  setInterval(() => {
    if (!visivel || document.hidden) return;
    const t = tubos[Math.floor(Math.random() * tubos.length)];
    t.classList.remove('acendendo', 'falhando');
    void t.getBBox();
    t.classList.add('falhando');
    setTimeout(() => t.classList.remove('falhando'), 600);
  }, 9000);
}

/* ─────────────── Dados ─────────────── */
const ordenar = (a, b) => (a.ordem ?? 0) - (b.ordem ?? 0);

function aplicarDados({ loja, categorias, itens }) {
  estado.loja = { ...LOJA_INICIAL, ...loja };
  estado.categorias = categorias.slice().sort(ordenar);
  estado.itens = itens.filter((i) => i.ativo !== false).sort(ordenar);
}

async function carregar() {
  // 1) último cardápio visto (abre instantâneo na 2ª visita)
  try {
    const salvo = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (salvo) { aplicarDados(salvo); montarTudo(); }
  } catch { /* cache estragado: ignora */ }

  // 2) Firestore (fonte da verdade)
  try {
    const [lojaSnap, catSnap, itemSnap] = await Promise.race([
      Promise.all([
        getDoc(doc(db, 'config', 'loja')),
        getDocs(collection(db, 'categorias')),
        getDocs(collection(db, 'itens')),
      ]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('demorou')), 9000)),
    ]);
    const dados = {
      loja: lojaSnap.exists() ? lojaSnap.data() : LOJA_INICIAL,
      categorias: catSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      itens: itemSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    };
    if (!dados.categorias.length) throw new Error('vazio');
    estado.online = true;
    aplicarDados(dados);
    try { localStorage.setItem(CACHE, JSON.stringify(dados)); } catch { /* sem espaço: tudo bem */ }
  } catch {
    // sem rede: mostra o cardápio que tiver, sem aceitar pedido
    if (!estado.categorias.length) aplicarDados({ loja: LOJA_INICIAL, categorias: CATEGORIAS_INICIAIS, itens: ITENS_INICIAIS });
    estado.online = false;
  }
  montarTudo();
}

/* ─────────────── Montagem ─────────────── */
const icone = {
  mais: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  menos: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
};

function controleQtd(item) {
  const n = estado.comanda.get(item.id) || 0;
  const bloqueado = item.esgotado ? 'disabled' : '';
  return `<div class="qtd ${n ? 'tem' : ''}" data-id="${esc(item.id)}">
    <button type="button" class="menos" data-acao="menos" aria-label="Tirar um ${esc(item.nome)}">${icone.menos}</button>
    <span class="qtd__n" aria-live="polite">${n}</span>
    <button type="button" class="mais" data-acao="mais" ${bloqueado} aria-label="Pôr ${esc(item.nome)} na comanda">${icone.mais}</button>
  </div>`;
}

// Copo do drink: duas camadas com as cores do próprio drink + gelo
function copo(cores = ['#d9a1b5', '#f3d9e2']) {
  const [base, topo] = cores;
  const id = 'g' + Math.random().toString(36).slice(2, 7);
  return `<svg class="drink__copo" viewBox="0 0 74 96" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="${esc(base)}"/><stop offset=".62" stop-color="${esc(base)}"/>
        <stop offset=".9" stop-color="${esc(topo)}"/>
      </linearGradient>
      <clipPath id="${id}c"><path d="M14 26 L60 26 L55 86 Q54 90 50 90 L24 90 Q20 90 19 86 Z"/></clipPath>
    </defs>
    <g clip-path="url(#${id}c)">
      <rect x="0" y="34" width="74" height="60" fill="url(#${id})"/>
      <rect x="22" y="38" width="13" height="12" rx="2" fill="#fff" opacity=".35" transform="rotate(-12 28 44)"/>
      <rect x="38" y="44" width="12" height="11" rx="2" fill="#fff" opacity=".3" transform="rotate(14 44 49)"/>
      <rect x="27" y="56" width="11" height="10" rx="2" fill="#fff" opacity=".22" transform="rotate(6 32 61)"/>
    </g>
    <path d="M14 26 L60 26 L55 86 Q54 90 50 90 L24 90 Q20 90 19 86 Z" fill="none" stroke="rgba(246,207,219,.55)" stroke-width="1.6"/>
    <path d="M50 26 L58 6" stroke="rgba(246,207,219,.7)" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="20" cy="27" r="7" fill="none" stroke="${esc(topo)}" stroke-width="2.4" opacity=".9"/>
  </svg>`;
}

function htmlItem(item) {
  const esg = item.esgotado;
  const foto = item.foto ? `<img class="item__foto" src="${esc(item.foto)}" alt="" loading="lazy">` : '';
  return `<li class="item ${esg ? 'esgotado' : ''}">
    ${foto}
    <div class="item__texto">
      <div class="item__linha">
        <span class="item__nome">${esc(item.nome)}</span>
        <span class="item__pontos" aria-hidden="true"></span>
        <span class="item__preco">${brl(item.preco)}</span>
      </div>
      ${item.desc ? `<p class="item__desc">${esc(item.desc)}</p>` : ''}
    </div>
    ${esg ? '<span class="selo-esgotou">esgotou</span>' : controleQtd(item)}
  </li>`;
}

function htmlDrink(item) {
  const esg = item.esgotado;
  return `<article class="drink ${esg ? 'esgotado' : ''}">
    ${item.foto ? `<img class="drink__copo" src="${esc(item.foto)}" alt="" style="object-fit:cover;border-radius:12px" loading="lazy">` : copo(item.cor)}
    <div>
      <h4 class="drink__nome">${esc(item.nome)}</h4>
      ${item.desc ? `<p class="drink__desc">${esc(item.desc)}</p>` : ''}
    </div>
    <div class="drink__pe">
      <span class="item__preco">${brl(item.preco)}</span>
      ${esg ? '<span class="selo-esgotou">esgotou</span>' : controleQtd(item)}
    </div>
  </article>`;
}

function montarCardapio() {
  const main = $('#cardapio');
  let html = '';
  for (const cat of estado.categorias) {
    const itens = estado.itens.filter((i) => i.categoria === cat.id);
    if (!itens.length) continue;
    html += `<section class="secao" id="cat-${esc(cat.id)}" style="--c:${esc(cat.cor || '#f6cfdb')}" aria-labelledby="t-${esc(cat.id)}">
      <h2 class="titulo" id="t-${esc(cat.id)}"><span class="titulo__tubo" aria-hidden="true"></span>${esc(cat.nome)}<span class="titulo__fio"></span></h2>`;
    const grupos = [...new Set(itens.map((i) => i.grupo || ''))];
    for (const g of grupos) {
      const doGrupo = itens.filter((i) => (i.grupo || '') === g);
      if (g) html += `<h3 class="grupo"><span>${esc(g)}</span></h3>`;
      if (cat.id === 'drinks' && /autora/i.test(g)) {
        html += `<div class="autorais">${doGrupo.map(htmlDrink).join('')}</div>`;
      } else {
        html += `<ul class="itens">${doGrupo.map(htmlItem).join('')}</ul>`;
      }
    }
    html += '</section>';
  }
  main.innerHTML = html || '<p class="carregando">Cardápio vazio por enquanto.</p>';
}

function montarNavegacao() {
  const visiveis = estado.categorias.filter((c) => estado.itens.some((i) => i.categoria === c.id));
  $('#faixas').innerHTML = visiveis.map((c) =>
    `<a href="#cat-${esc(c.id)}" style="--c:${esc(c.cor)}" data-cat="${esc(c.id)}">${esc(c.nome)}</a>`).join('');
  $('#legenda').innerHTML = visiveis.map((c) =>
    `<li><a href="#cat-${esc(c.id)}" style="--c:${esc(c.cor)}"><i aria-hidden="true"></i>${esc(c.nome)}</a></li>`).join('');
  observarSecoes();
}

let observador;
function observarSecoes() {
  observador?.disconnect();
  const links = [...document.querySelectorAll('#faixas a')];
  observador = new IntersectionObserver((entradas) => {
    entradas.forEach((e) => {
      if (!e.isIntersecting) return;
      const id = e.target.id.replace('cat-', '');
      links.forEach((a) => {
        const ativa = a.dataset.cat === id;
        a.classList.toggle('ativa', ativa);
        if (ativa) a.scrollIntoView({ block: 'nearest', inline: 'center', behavior: calmo ? 'auto' : 'smooth' });
      });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('.secao').forEach((s) => observador.observe(s));
}

function montarCasa() {
  const l = estado.loja;
  const s = situacao(l.semana || LOJA_INICIAL.semana);
  const sit = $('#situacao');
  sit.classList.toggle('aberto', s.aberto);
  $('#situacaoTexto').textContent = s.texto;
  $('#horarios').innerHTML = (l.horariosTexto || []).map((h) => `<li>${esc(h)}</li>`).join('');
  $('#endereco').textContent = l.endereco || '';
  $('#mapa').href = l.mapsUrl || '#';
  if (l.instagram) {
    $('#insta').href = `https://www.instagram.com/${encodeURIComponent(l.instagram)}/`;
    $('#insta').textContent = '@' + l.instagram;
  }
  const aviso = $('#aviso');
  aviso.hidden = !l.aviso;
  aviso.textContent = l.aviso || '';
}

function montarTudo() {
  montarCasa();
  montarNavegacao();
  montarCardapio();
  // limpa da comanda o que saiu do cardápio ou esgotou
  for (const id of [...estado.comanda.keys()]) {
    const it = estado.itens.find((i) => i.id === id);
    if (!it || it.esgotado) estado.comanda.delete(id);
  }
  atualizarAba();
}

/* ─────────────── Comanda ─────────────── */
const itemPorId = (id) => estado.itens.find((i) => i.id === id);
function totais() {
  let qtd = 0, total = 0;
  for (const [id, n] of estado.comanda) {
    const it = itemPorId(id);
    if (!it) continue;
    qtd += n; total += n * Number(it.preco || 0);
  }
  return { qtd, total: Math.round(total * 100) / 100 };
}

function mudar(id, delta) {
  const it = itemPorId(id);
  if (!it || (delta > 0 && it.esgotado)) return;
  const n = Math.max(0, Math.min(30, (estado.comanda.get(id) || 0) + delta));
  if (n) estado.comanda.set(id, n); else estado.comanda.delete(id);
  document.querySelectorAll(`.qtd[data-id="${CSS.escape(id)}"]`).forEach((q) => {
    q.classList.toggle('tem', n > 0);
    q.querySelector('.qtd__n').textContent = n;
  });
  atualizarAba(delta > 0);
  if (!$('#comanda').hidden) desenharComanda();
}

function atualizarAba(pular = false) {
  const aba = $('#aba');
  const { qtd, total } = totais();
  const acompanhando = pedidoAberto();
  if (!qtd && !acompanhando) { aba.hidden = true; return; }
  aba.hidden = false;
  if (qtd) {
    $('#abaRotulo').textContent = `Comanda · ${qtd} ${qtd === 1 ? 'item' : 'itens'}`;
    $('#abaTotal').textContent = brl(total);
  } else {
    $('#abaRotulo').textContent = 'Acompanhar pedido';
    $('#abaTotal').textContent = 'Nº ' + codigo(acompanhando);
  }
  if (pular && !calmo) { aba.classList.remove('pulou'); void aba.offsetWidth; aba.classList.add('pulou'); }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('.qtd button');
  if (!b) return;
  mudar(b.closest('.qtd').dataset.id, b.dataset.acao === 'mais' ? 1 : -1);
});

function abrirComanda() {
  $('#veu').hidden = false;
  $('#comanda').hidden = false;
  document.body.classList.add('travado');
  const agora = new Date();
  $('#comandaData').textContent = agora.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' }) +
    ' · ' + agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const { qtd } = totais();
  if (!qtd && pedidoAberto()) acompanhar(pedidoAberto());
  else desenharComanda();
}
function fecharComanda() {
  $('#veu').hidden = true;
  $('#comanda').hidden = true;
  document.body.classList.remove('travado');
  pararAcompanhamento?.();
}
$('#aba').addEventListener('click', abrirComanda);
$('#fechar').addEventListener('click', fecharComanda);
$('#veu').addEventListener('click', fecharComanda);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#comanda').hidden) fecharComanda(); });

function desenharComanda(recado = '') {
  const corpo = $('#comandaCorpo');
  const { total } = totais();
  const linhas = [...estado.comanda].map(([id, n]) => {
    const it = itemPorId(id);
    if (!it) return '';
    return `<li class="linha">
      <span class="linha__nome">${esc(it.nome)}${it.grupo && !/autora/i.test(it.grupo) && it.grupo !== it.nome ? `<small>${esc(it.grupo)}</small>` : ''}</span>
      <span class="linha__valor">${brl(n * it.preco)}</span>
      ${controleQtd(it)}
    </li>`;
  }).join('');

  if (!linhas) {
    corpo.innerHTML = '<p class="recado">Sua comanda está vazia. Toque no <strong>+</strong> ao lado do que quiser.</p>';
    return;
  }

  const l = estado.loja;
  const podePedir = estado.online && l.aceitandoPedidos !== false;
  const locais = (l.locais && l.locais.length ? l.locais : LOJA_INICIAL.locais);
  if (!estado.local) estado.local = locais[0];
  const nome = localStorage.getItem(NOME) || '';
  const pedeNumero = /mesa|sinuca/i.test(estado.local);

  corpo.innerHTML = `
    <ul class="linhas">${linhas}</ul>
    <div class="soma"><span>Total</span><strong>${brl(total)}</strong></div>
    <p class="paga">Você paga no balcão, como sempre.</p>

    <label class="campo"><span>Seu nome</span>
      <input id="fNome" maxlength="40" autocomplete="given-name" placeholder="Como te chamam?" value="${esc(nome)}">
    </label>
    <div class="campo"><span>Onde você está</span>
      <div class="locais" role="group" aria-label="Onde você está">
        ${locais.map((x) => `<button type="button" data-local="${esc(x)}" aria-pressed="${x === estado.local}">${esc(x)}</button>`).join('')}
      </div>
      ${pedeNumero ? `<div class="local-numero"><label for="fNumero">Número</label><input id="fNumero" class="campo-num" inputmode="numeric" maxlength="4" value="${esc(estado.localNumero)}" placeholder="—" style="border:0;border-bottom:2px solid rgba(42,29,35,.4);background:transparent;font-family:var(--mao);font-weight:700;color:var(--tinta);outline:none"></div>` : ''}
    </div>
    <label class="campo"><span>Observação</span>
      <textarea id="fObs" maxlength="240" rows="2" placeholder="Sem gelo, jantinha com tropeiro…"></textarea>
    </label>

    ${recado}
    ${podePedir ? '' : `<p class="recado erro">${!estado.online
      ? 'Sem conexão com o bar agora. Mostre esta comanda no balcão.'
      : 'Os pedidos pelo cardápio estão pausados agora. Chama a gente no balcão.'}</p>`}
    <button class="enviar" id="enviar" type="button" ${podePedir ? '' : 'disabled'}>
      Mandar pro balcão
      ${l.gps?.ativo ? '<span class="enviar__sub">Vamos conferir pelo GPS que você está no Rainbow</span>' : ''}
    </button>`;

  corpo.querySelectorAll('[data-local]').forEach((b) => b.addEventListener('click', () => {
    estado.local = b.dataset.local;
    guardarCampos();
    desenharComanda();
  }));
  $('#fNumero')?.addEventListener('input', (e) => { estado.localNumero = e.target.value.replace(/\D/g, ''); e.target.value = estado.localNumero; });
  $('#enviar')?.addEventListener('click', enviar);
}

function guardarCampos() {
  const nome = $('#fNome')?.value.trim();
  if (nome) localStorage.setItem(NOME, nome);
}

/* ─────────────── GPS ─────────────── */
function posicao() {
  return new Promise((ok, falha) => {
    if (!('geolocation' in navigator)) return falha({ code: 'sem' });
    navigator.geolocation.getCurrentPosition(ok, falha, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}

function telaGps() {
  $('#comandaCorpo').innerHTML = `<div class="gps" role="status">
    <svg viewBox="0 0 52 52" aria-hidden="true">
      <circle class="onda" cx="26" cy="44" r="10"/><circle class="onda" cx="26" cy="44" r="10"/>
      <path class="pino" d="M26 44s12-12.5 12-22a12 12 0 1 0-24 0c0 9.5 12 22 12 22z"/><circle class="pino" cx="26" cy="22" r="4.5"/>
    </svg>
    <p>Conferindo se você está no Rainbow…</p>
  </div>`;
}

const recadoErro = (t) => `<p class="recado erro">${t}</p>`;

async function enviar() {
  const nome = $('#fNome').value.trim().replace(/\s+/g, ' ');
  const obs = $('#fObs').value.trim();
  if (nome.length < 2) { $('#fNome').focus(); $('#fNome').placeholder = 'Seu nome, pra gente te achar'; return; }
  if (/mesa|sinuca/i.test(estado.local) && !estado.localNumero) { $('#fNumero')?.focus(); return; }
  localStorage.setItem(NOME, nome);
  const local = estado.localNumero && /mesa|sinuca/i.test(estado.local) ? `${estado.local} ${estado.localNumero}` : estado.local;
  const obsGuardada = obs;

  const gps = estado.loja.gps || {};
  let geo = null;
  if (gps.ativo) {
    telaGps();
    try {
      const p = await posicao();
      geo = { lat: p.coords.latitude, lng: p.coords.longitude, precisao: Math.round(p.coords.accuracy) };
    } catch (err) {
      const msg = err.code === 1
        ? '<strong>A localização está bloqueada.</strong> Libere a localização para este site (no cadeado ao lado do endereço) e tente de novo. É só para confirmar que o pedido sai de dentro do bar.'
        : err.code === 'sem'
          ? 'Este navegador não tem localização. Peça no balcão.'
          : '<strong>Não deu para achar sua localização.</strong> Ligue o GPS do celular e tente de novo.';
      desenharComanda(recadoErro(msg));
      $('#fObs').value = obsGuardada;
      return;
    }
    const dist = distancia(geo, gps);
    const c = gps.caixa;
    const dentro = dist <= gps.raio && (!c || (geo.lat >= c.latMin && geo.lat <= c.latMax && geo.lng >= c.lngMin && geo.lng <= c.lngMax));
    if (!dentro) {
      const longe = dist >= 1000 ? (dist / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(dist) + ' m';
      const fraco = geo.precisao > 120 ? ` O sinal do GPS está fraco (±${geo.precisao} m): chegue perto da porta ou ative a localização precisa.` : '';
      desenharComanda(recadoErro(`<strong>Parece que você está a ${longe} do Rainbow.</strong> Os pedidos pelo cardápio só valem aqui dentro.${fraco}`));
      $('#fObs').value = obsGuardada;
      return;
    }
  }

  const itens = [...estado.comanda].map(([id, qtd]) => {
    const it = itemPorId(id);
    return { id, nome: it.nome, grupo: it.grupo || '', cat: it.categoria, preco: Number(it.preco), qtd };
  });
  const pedido = {
    nome, local, itens,
    total: totais().total,
    status: 'novo',
    pago: false,
    criadoEm: serverTimestamp(),
    noite: noiteDe(new Date()),
  };
  if (obs) pedido.obs = obs;
  if (geo) pedido.geo = geo;

  try {
    const ref = await addDoc(collection(db, 'pedidos'), pedido);
    const meus = JSON.parse(localStorage.getItem(MEUS) || '[]').filter((p) => Date.now() - p.t < 12 * 3600e3);
    meus.unshift({ id: ref.id, t: Date.now() });
    localStorage.setItem(MEUS, JSON.stringify(meus.slice(0, 10)));
    estado.comanda.clear();
    document.querySelectorAll('.qtd').forEach((q) => { q.classList.remove('tem'); q.querySelector('.qtd__n').textContent = '0'; });
    estado.localNumero = estado.localNumero; // mantém a mesa para o próximo pedido
    atualizarAba();
    acompanhar(ref.id, true);
  } catch (e) {
    const negado = String(e?.code || '').includes('permission');
    desenharComanda(recadoErro(negado
      ? 'O bar não aceitou o pedido agora (pedidos pausados ou localização fora do Rainbow). Fale com a gente no balcão.'
      : 'Não conseguimos mandar o pedido. Confira a internet e tente de novo.'));
    $('#fObs').value = obsGuardada;
  }
}

/* ─────────────── Acompanhar pedido ─────────────── */
function pedidoAberto() {
  try {
    const meus = JSON.parse(localStorage.getItem(MEUS) || '[]');
    const p = meus.find((x) => Date.now() - x.t < 6 * 3600e3 && !x.fim);
    return p?.id || null;
  } catch { return null; }
}
function marcarFim(id) {
  const meus = JSON.parse(localStorage.getItem(MEUS) || '[]');
  meus.forEach((p) => { if (p.id === id) p.fim = true; });
  localStorage.setItem(MEUS, JSON.stringify(meus));
}

let pararAcompanhamento = null;
const ETAPAS = ['novo', 'preparo', 'pronto', 'entregue'];
const CORES_ETAPA = ['#3B82E0', '#F5CB3B', '#3DBE6A', '#9157E0'];

function acompanhar(id, recem = false) {
  pararAcompanhamento?.();
  const corpo = $('#comandaCorpo');
  pararAcompanhamento = onSnapshot(doc(db, 'pedidos', id), (snap) => {
    if (!snap.exists()) { corpo.innerHTML = '<p class="recado">Pedido não encontrado.</p>'; marcarFim(id); atualizarAba(); return; }
    const p = snap.data();
    const idx = ETAPAS.indexOf(p.status);
    if (p.status === 'entregue' || p.status === 'cancelado') { marcarFim(id); atualizarAba(); }
    corpo.innerHTML = `
      <span class="carimbo" style="${recem ? '' : 'animation:none;opacity:.92'}">Pedido<b>Nº ${esc(codigo(id))}</b>${esc(p.nome)}</span>
      ${p.status === 'cancelado'
        ? '<p class="cancelado-aviso">Esse pedido foi cancelado. Chama a gente no balcão.</p>'
        : `<ol class="andamento">${ETAPAS.map((s, i) => `<li class="${i <= idx ? 'feito' : ''} ${i === idx && s !== 'entregue' ? 'agora' : ''}" style="--c:${CORES_ETAPA[i]}">${STATUS[s]}</li>`).join('')}</ol>`}
      <ul class="linhas" style="margin-top:18px">${(p.itens || []).map((it) => `<li class="linha"><span class="linha__nome">${it.qtd}× ${esc(it.nome)}</span><span class="linha__valor">${brl(it.qtd * it.preco)}</span></li>`).join('')}</ul>
      <div class="soma"><span>Total</span><strong>${brl(p.total)}</strong></div>
      <p class="paga">${esc(p.local)} · ${p.pago ? 'pago' : 'pague no balcão quando quiser'}</p>
      <button class="secundario" id="outro" type="button">Fazer outro pedido</button>`;
    $('#outro').addEventListener('click', () => { recem = false; fecharComanda(); $('#cardapio').scrollIntoView({ behavior: calmo ? 'auto' : 'smooth' }); });
    recem = false;
  }, () => { corpo.innerHTML = '<p class="recado">Não deu para acompanhar agora. Seu pedido foi enviado.</p>'; });
}

/* ─────────────── Início ─────────────── */
desenharArco(CATEGORIAS_INICIAIS.map((c) => c.cor));
acenderLetreiro();
carregar();
setInterval(montarCasa, 60_000); // "aberto agora" muda de madrugada
