// Página O Rainbow: textos (config/sobre), fotos (coleção fotos) e dados do bar (config/loja).
import { db } from './firebase.js';
import { collection, doc, getDoc, getDocs } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { esc, situacao, LOJA_INICIAL, SOBRE_INICIAL } from './base.js';
import { desenharArco, acender, CORES_ARCO } from './letreiro.js';

const $ = (s) => document.querySelector(s);

function montarTextos(s) {
  $('#chamada').textContent = s.chamada || SOBRE_INICIAL.chamada;
  $('#texto').textContent = s.texto || '';
  const valores = (s.valores || []).filter((v) => v && v.titulo);
  $('#valores').innerHTML = valores.map((v, i) => `<article class="valor" style="--c:${CORES_ARCO[i % CORES_ARCO.length]}">
    <h3>${esc(v.titulo)}</h3><p>${esc(v.texto)}</p></article>`).join('');
  const prog = (s.programacao || []).filter((p) => p && p.titulo);
  $('#secProg').hidden = !prog.length;
  $('#programa').innerHTML = prog.map((p) => `<article class="prog">
    ${p.quando ? `<span class="prog__quando">${esc(p.quando)}</span>` : ''}
    <h3>${esc(p.titulo)}</h3>${p.texto ? `<p>${esc(p.texto)}</p>` : ''}</article>`).join('');
  $('#maioridade').textContent = s.maioridade || '';
}

function montarLoja(l) {
  const s = situacao(l.semana || LOJA_INICIAL.semana);
  $('#situacao').classList.toggle('aberto', s.aberto);
  $('#situacaoTexto').textContent = s.texto;
  $('#horarios').innerHTML = (l.horariosTexto || []).map((h) => `<li>${esc(h)}</li>`).join('');
  $('#endereco').textContent = l.endereco || '';
  $('#mapa').href = l.mapsUrl || '#';
  if (l.instagram) $('#insta').href = `https://www.instagram.com/${encodeURIComponent(l.instagram)}/`;
}

function montarFotos(fotos) {
  $('#secFotos').hidden = !fotos.length;
  $('#galeria').innerHTML = fotos.map((f, i) => `<button type="button" data-i="${i}" aria-label="Ver foto${f.legenda ? ': ' + esc(f.legenda) : ''}">
    <img src="${esc(f.img)}" alt="${esc(f.legenda || 'Foto do Rainbow Pub')}" loading="lazy">
    ${f.legenda ? `<span>${esc(f.legenda)}</span>` : ''}</button>`).join('');
  $('#galeria').onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const f = fotos[Number(b.dataset.i)];
    $('#fotoImg').src = f.img;
    $('#fotoImg').alt = f.legenda || 'Foto do Rainbow Pub';
    $('#fotoLegenda').textContent = f.legenda || '';
    $('#fotoAberta').hidden = false;
  };
}
const fecharFoto = () => { $('#fotoAberta').hidden = true; };
$('#fotoFechar').addEventListener('click', fecharFoto);
$('#fotoAberta').addEventListener('click', (e) => { if (e.target.id === 'fotoAberta') fecharFoto(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharFoto(); });

async function carregar() {
  montarTextos(SOBRE_INICIAL);
  montarLoja(LOJA_INICIAL);
  try {
    const [sobre, loja, fotos] = await Promise.all([
      getDoc(doc(db, 'config', 'sobre')),
      getDoc(doc(db, 'config', 'loja')),
      getDocs(collection(db, 'fotos')),
    ]);
    if (sobre.exists()) montarTextos({ ...SOBRE_INICIAL, ...sobre.data() });
    if (loja.exists()) montarLoja({ ...LOJA_INICIAL, ...loja.data() });
    montarFotos(fotos.docs.map((d) => d.data()).filter((f) => f.ativo !== false && f.img).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)));
  } catch { /* sem rede: fica com os textos padrão */ }
}

desenharArco($('#arco'));
acender($('#topo'));
carregar();
