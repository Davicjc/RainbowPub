// Rainbow Pub — Painel Administrativo da Equipe (adm/adm.js)
// ES Module puro, sem dependências externas além do Firebase 10.13.0.

import { app, db, SDK, emu } from '../js/firebase.js';
import {
  brl,
  esc,
  distancia,
  caixaDe,
  noiteDe,
  STATUS,
  codigo,
  LOJA_INICIAL,
  SOBRE_INICIAL,
  CATEGORIAS_INICIAIS,
  ITENS_INICIAIS,
} from '../js/base.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  doc,
  collection,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  onSnapshot,
  query,
  where,
  orderBy,
  writeBatch,
  Timestamp,
  serverTimestamp,
  increment,
  runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
  UNIDADES,
  formatarQtd,
  paraBase,
  unidadesDeEntrada,
  atalhosDeEntrada,
  situacaoInsumo,
  receitaDe,
  porcoesPossiveis,
  baixaDoPedido,
} from '../js/estoque.js';

const DIAS_SEMANA = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];

const auth = getAuth(app);
if (emu) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

// ─── Estado Central do Painel ───
const estado = {
  usuario: null,
  telaAtiva: 'pedidos',
  abaStatusPedidos: 'novo',
  somSilenciado: localStorage.getItem('rainbow_adm_mudo') === '1',
  tipoSom: localStorage.getItem('rainbow_adm_tipo_som') || 'campainha',
  modoNotificacao: localStorage.getItem('rainbow_adm_modo_notif') || 'todos',
  idsPedidosConhecidos: new Set(),
  audioDesbloqueado: false,
  primeiraCargaPedidos: true,
  loja: structuredClone(LOJA_INICIAL),
  sobre: structuredClone(SOBRE_INICIAL),
  sobreProgramacao: structuredClone(SOBRE_INICIAL.programacao),
  sobreEditando: false,
  fotos: [],
  categorias: [...CATEGORIAS_INICIAIS],
  itens: [...ITENS_INICIAIS],
  mapaItens: new Map(),
  pedidosAoVivo: [],
  categoriasAbertasEdicao: new Set(),
  itensAbertosEdicao: new Set(),
  novoItemAbertoPorCat: new Set(),
  fotosTemporarias: new Map(),
  barEditando: false,
  periodoRelatorio: 'esta-noite',
  pedidosRelatorio: [],
  descricaoPeriodoRelatorio: '',
  cancelarEscutas: [],
  intervaloRelogio: null,
  balcaoLancados: [], // vendas lançadas nesta sessão (para o "Voltar")
  // Estoque
  estoque: [],
  mapaEstoque: new Map(),
  estoqueCarregado: false,
  itensCarregados: false,
  qtdVistaEstoque: new Map(), // última quantidade vista de cada item de estoque
  receitasVistas: new Map(), // última receita vista de cada produto (para notar mudanças)
  filtroEstoque: 'todos',
  buscaEstoque: '',
  buscaCardapio: '',
};

// Atualiza o mapa rápido de itens por ID
function atualizarMapaItens() {
  estado.mapaItens.clear();
  for (const it of estado.itens) {
    if (it && it.id) estado.mapaItens.set(it.id, it);
  }
}
atualizarMapaItens();

// ─── Utilitários de UI: Toasts e Confirmação ───
const containerToasts = document.getElementById('container-toasts');

function mostrarToast(mensagem, tipo = 'info') {
  if (!containerToasts) return;
  const el = document.createElement('div');
  el.className = `toast ${tipo === 'erro' ? 'erro' : tipo === 'sucesso' ? 'sucesso' : ''}`;
  el.textContent = mensagem;
  containerToasts.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3400);
}

const modalConfirmacao = document.getElementById('modal-confirmacao');
const modalTitulo = document.getElementById('modal-titulo');
const modalMensagem = document.getElementById('modal-mensagem');
const btnModalCancelar = document.getElementById('btn-modal-cancelar');
const btnModalConfirmar = document.getElementById('btn-modal-confirmar');
let resolverConfirmacao = null;

function confirmarAcao({ titulo = 'Confirmar ação', mensagem = '', textoConfirmar = 'Confirmar', perigo = true }) {
  return new Promise((resolve) => {
    resolverConfirmacao = resolve;
    modalTitulo.textContent = titulo;
    modalMensagem.textContent = mensagem;
    btnModalConfirmar.textContent = textoConfirmar;
    btnModalConfirmar.className = `btn ${perigo ? 'btn-perigo' : 'btn-principal'}`;
    modalConfirmacao.hidden = false;
    btnModalConfirmar.focus();
  });
}

function fecharModalConfirmacao(resposta) {
  modalConfirmacao.hidden = true;
  if (resolverConfirmacao) {
    const fn = resolverConfirmacao;
    resolverConfirmacao = null;
    fn(Boolean(resposta));
  }
}

btnModalCancelar.addEventListener('click', () => fecharModalConfirmacao(false));
btnModalConfirmar.addEventListener('click', () => fecharModalConfirmacao(true));
modalConfirmacao.addEventListener('click', (e) => {
  if (e.target === modalConfirmacao) fecharModalConfirmacao(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!modalConfirmacao.hidden) fecharModalConfirmacao(false);
    if (modalNotificacao && !modalNotificacao.hidden) fecharModalNotificacoes();
  }
});

// ─── WebAudio & Notificações de Novos Pedidos ───
let contextoAudio = null;

function obterContextoAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!contextoAudio) contextoAudio = new Ctx();
  if (contextoAudio.state === 'suspended') {
    contextoAudio.resume().catch(() => {});
  }
  return contextoAudio;
}

// Desbloqueia o contexto de áudio em qualquer interação do usuário
function desbloquearAudioContexto() {
  try {
    const ctx = obterContextoAudio();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch {}
}
['click', 'touchstart', 'keydown', 'pointerdown'].forEach((evt) => {
  window.addEventListener(evt, desbloquearAudioContexto, { passive: true });
});

// Síntese de toques sonoros
function sintetizarCampainha(ctx, agora) {
  // Campainha de balcão (desk service bell) - tom cristalino metálico
  const osc1 = ctx.createOscillator();
  const ganho1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(1760, agora); // A6
  ganho1.gain.setValueAtTime(0.0001, agora);
  ganho1.gain.exponentialRampToValueAtTime(0.35, agora + 0.005);
  ganho1.gain.exponentialRampToValueAtTime(0.0001, agora + 1.2);
  osc1.connect(ganho1);
  ganho1.connect(ctx.destination);
  osc1.start(agora);
  osc1.stop(agora + 1.25);

  const osc2 = ctx.createOscillator();
  const ganho2 = ctx.createGain();
  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(3520, agora); // A7
  ganho2.gain.setValueAtTime(0.0001, agora);
  ganho2.gain.exponentialRampToValueAtTime(0.14, agora + 0.003);
  ganho2.gain.exponentialRampToValueAtTime(0.0001, agora + 0.5);
  osc2.connect(ganho2);
  ganho2.connect(ctx.destination);
  osc2.start(agora);
  osc2.stop(agora + 0.55);
}

function sintetizarDingDong(ctx, agora) {
  // Ding: D5 (587.33 Hz)
  const osc1 = ctx.createOscillator();
  const ganho1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(587.33, agora);
  ganho1.gain.setValueAtTime(0.0001, agora);
  ganho1.gain.exponentialRampToValueAtTime(0.32, agora + 0.01);
  ganho1.gain.exponentialRampToValueAtTime(0.0001, agora + 0.45);
  osc1.connect(ganho1);
  ganho1.connect(ctx.destination);
  osc1.start(agora);
  osc1.stop(agora + 0.5);

  // Dong: A4 (440 Hz)
  const inicioDong = agora + 0.28;
  const osc2 = ctx.createOscillator();
  const ganho2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(440, inicioDong);
  ganho2.gain.setValueAtTime(0.0001, inicioDong);
  ganho2.gain.exponentialRampToValueAtTime(0.38, inicioDong + 0.015);
  ganho2.gain.exponentialRampToValueAtTime(0.0001, inicioDong + 0.8);
  osc2.connect(ganho2);
  ganho2.connect(ctx.destination);
  osc2.start(inicioDong);
  osc2.stop(inicioDong + 0.85);
}

function sintetizarBeepDuplo(ctx, agora) {
  const tocarPulso = (freq, inicio, duracao) => {
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, inicio);
    ganho.gain.setValueAtTime(0.0001, inicio);
    ganho.gain.exponentialRampToValueAtTime(0.28, inicio + 0.01);
    ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + duracao);
    osc.connect(ganho);
    ganho.connect(ctx.destination);
    osc.start(inicio);
    osc.stop(inicio + duracao + 0.01);
  };
  tocarPulso(880.0, agora, 0.09); // A5
  tocarPulso(1318.5, agora + 0.12, 0.14); // E6
}

function sintetizarMarimba(ctx, agora) {
  const tocarNota = (freq, inicio, duracao) => {
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, inicio);
    ganho.gain.setValueAtTime(0.0001, inicio);
    ganho.gain.exponentialRampToValueAtTime(0.30, inicio + 0.005);
    ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + duracao);
    osc.connect(ganho);
    ganho.connect(ctx.destination);
    osc.start(inicio);
    osc.stop(inicio + duracao + 0.01);
  };
  tocarNota(523.25, agora, 0.22); // C5
  tocarNota(659.25, agora + 0.10, 0.22); // E5
  tocarNota(783.99, agora + 0.20, 0.45); // G5
}

function sintetizarAlertaIntenso(ctx, agora) {
  const tocarBeep = (freq, inicio, duracao) => {
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, inicio);
    ganho.gain.setValueAtTime(0.0001, inicio);
    ganho.gain.exponentialRampToValueAtTime(0.24, inicio + 0.01);
    ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + duracao);
    osc.connect(ganho);
    ganho.connect(ctx.destination);
    osc.start(inicio);
    osc.stop(inicio + duracao + 0.01);
  };
  tocarBeep(987.77, agora, 0.10); // B5
  tocarBeep(1318.51, agora + 0.12, 0.10); // E6
  tocarBeep(987.77, agora + 0.26, 0.10); // B5
  tocarBeep(1318.51, agora + 0.38, 0.22); // E6
}

async function tocarSom(tipo = estado.tipoSom) {
  if (estado.somSilenciado || estado.modoNotificacao === 'tela' || estado.modoNotificacao === 'mudo') {
    return;
  }
  try {
    const ctx = obterContextoAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    const agora = ctx.currentTime;
    switch (tipo) {
      case 'dingdong':
        sintetizarDingDong(ctx, agora);
        break;
      case 'beep':
        sintetizarBeepDuplo(ctx, agora);
        break;
      case 'marimba':
        sintetizarMarimba(ctx, agora);
        break;
      case 'alerta':
        sintetizarAlertaIntenso(ctx, agora);
        break;
      case 'campainha':
      default:
        sintetizarCampainha(ctx, agora);
        break;
    }
  } catch (err) {
    console.warn('Erro ao reproduzir alerta sonoro:', err);
  }
}

// Disparo unificado do alerta de novo pedido
function dispararAlertaNovoPedido(pedido = {}) {
  // 1. Vibração em dispositivos móveis
  if (navigator.vibrate) {
    try {
      navigator.vibrate([180, 80, 180]);
    } catch {}
  }

  // 2. Alerta sonoro
  tocarSom(estado.tipoSom);

  // 3. Notificação nativa do navegador (Desktop / Mobile)
  const querTela = estado.modoNotificacao === 'todos' || estado.modoNotificacao === 'tela';
  if (querTela && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const cod = pedido.id ? codigo(pedido.id) : 'Novo';
      const nome = pedido.nome || 'Cliente';
      const local = pedido.local || 'Mesa';
      const totalTxt = pedido.total ? ` · ${brl(pedido.total)}` : '';
      const notif = new Notification(`Rainbow Pub · Pedido Nº ${cod}`, {
        body: `${nome} (${local})${totalTxt}\nClique para ver no painel`,
        icon: '../img/og.png',
        tag: `pedido-${pedido.id || Date.now()}`,
      });
      notif.onclick = () => {
        window.focus();
        notif.close();
      };
    } catch (err) {
      console.warn('Erro ao disparar notificação nativa:', err);
    }
  }
}

function tocarAlertaNovoPedido() {
  dispararAlertaNovoPedido();
}

// ─── Modal de Notificações e Botão de Som ───
const NOMES_SOM = {
  campainha: 'Campainha',
  dingdong: 'Ding-Dong',
  beep: 'Beep',
  marimba: 'Marimba',
  alerta: 'Alerta',
};

const modalNotificacao = document.getElementById('modal-notificacao');
const btnConfigNotificacao = document.getElementById('btn-config-notificacao');
const btnFecharModalNotif = document.getElementById('btn-fechar-modal-notif');
const selTipoSom = document.getElementById('sel-tipo-som');
const btnOuvirSom = document.getElementById('btn-ouvir-som');
const btnPedirPermissao = document.getElementById('btn-pedir-permissao');
const statusPermissaoTexto = document.getElementById('status-permissao-texto');
const btnTestarAlertaCompleto = document.getElementById('btn-testar-alerta-completo');
const radiosModoNotif = document.querySelectorAll('input[name="modo-notificacao"]');

function atualizarBotaoNotificacao() {
  const rotulo = document.getElementById('texto-btn-notificacao');
  if (rotulo) {
    const nome = NOMES_SOM[estado.tipoSom] || 'Campainha';
    rotulo.innerHTML = `<span class="so-pc">Alerta: </span>${esc(nome)}`;
  }
}

function atualizarBotaoSom() {
  const btn = document.getElementById('btn-silenciar');
  const iconeAtivo = document.getElementById('icone-som-ativo');
  const iconeMudo = document.getElementById('icone-som-mudo');
  const texto = document.getElementById('texto-btn-som');
  if (!btn) return;

  btn.setAttribute('aria-pressed', estado.somSilenciado ? 'true' : 'false');
  if (iconeAtivo) iconeAtivo.hidden = estado.somSilenciado;
  if (iconeMudo) iconeMudo.hidden = !estado.somSilenciado;
  if (texto) texto.textContent = estado.somSilenciado ? 'Silenciado' : 'Som ativo';
}

function atualizarStatusPermissaoNotificacao() {
  if (!statusPermissaoTexto) return;
  if (!('Notification' in window)) {
    statusPermissaoTexto.innerHTML = '<strong>Aviso:</strong> Este navegador não suporta notificações de área de trabalho.';
    if (btnPedirPermissao) btnPedirPermissao.hidden = true;
    return;
  }
  const perm = Notification.permission;
  if (perm === 'granted') {
    statusPermissaoTexto.innerHTML = '<span class="status-permissao-badge status-permissao-badge--ok">✓ Notificações do navegador ativadas</span><small style="display:block; margin-top:2px; color:var(--texto-2);">Você receberá avisos na tela mesmo com o navegador em segundo plano ou em outra aba.</small>';
    if (btnPedirPermissao) btnPedirPermissao.hidden = true;
  } else if (perm === 'denied') {
    statusPermissaoTexto.innerHTML = '<span class="status-permissao-badge status-permissao-badge--bloqueado">✕ Notificações bloqueadas pelo navegador</span><small style="display:block; margin-top:2px; color:var(--texto-2);">Clique no ícone de cadeado ou configurações do site no navegador e permita as Notificações.</small>';
    if (btnPedirPermissao) btnPedirPermissao.hidden = true;
  } else {
    statusPermissaoTexto.innerHTML = '<span class="status-permissao-badge status-permissao-badge--aviso">! Notificações em segundo plano não ativadas</span><small style="display:block; margin-top:2px; color:var(--texto-2);">Ative para receber avisos visuais de pedidos mesmo fora do painel.</small>';
    if (btnPedirPermissao) btnPedirPermissao.hidden = false;
  }
}

function abrirModalNotificacoes() {
  if (!modalNotificacao) return;
  desbloquearAudioContexto();

  if (selTipoSom) {
    selTipoSom.value = estado.tipoSom;
  }
  radiosModoNotif.forEach((r) => {
    r.checked = r.value === estado.modoNotificacao;
    const card = r.closest('.opcao-radio-card');
    if (card) card.classList.toggle('ativa', r.checked);
  });
  atualizarStatusPermissaoNotificacao();
  modalNotificacao.hidden = false;
}

function fecharModalNotificacoes() {
  if (modalNotificacao) modalNotificacao.hidden = true;
}

if (btnConfigNotificacao) {
  btnConfigNotificacao.addEventListener('click', abrirModalNotificacoes);
}
if (btnFecharModalNotif) {
  btnFecharModalNotif.addEventListener('click', fecharModalNotificacoes);
}
if (modalNotificacao) {
  modalNotificacao.addEventListener('click', (e) => {
    if (e.target === modalNotificacao) fecharModalNotificacoes();
  });
}

radiosModoNotif.forEach((r) => {
  r.addEventListener('change', () => {
    if (r.checked) {
      estado.modoNotificacao = r.value;
      localStorage.setItem('rainbow_adm_modo_notif', estado.modoNotificacao);
      if (estado.modoNotificacao === 'mudo') {
        estado.somSilenciado = true;
      } else if (estado.modoNotificacao === 'som' || estado.modoNotificacao === 'todos') {
        estado.somSilenciado = false;
      }
      localStorage.setItem('rainbow_adm_mudo', estado.somSilenciado ? '1' : '0');
      atualizarBotaoSom();
      radiosModoNotif.forEach((el) => {
        const card = el.closest('.opcao-radio-card');
        if (card) card.classList.toggle('ativa', el.checked);
      });
    }
  });
});

if (selTipoSom) {
  selTipoSom.addEventListener('change', () => {
    estado.tipoSom = selTipoSom.value;
    localStorage.setItem('rainbow_adm_tipo_som', estado.tipoSom);
    atualizarBotaoNotificacao();
    tocarSom(estado.tipoSom);
  });
}

if (btnOuvirSom) {
  btnOuvirSom.addEventListener('click', () => {
    const tipo = selTipoSom ? selTipoSom.value : estado.tipoSom;
    tocarSom(tipo);
  });
}

if (btnPedirPermissao) {
  btnPedirPermissao.addEventListener('click', async () => {
    if (!('Notification' in window)) {
      mostrarToast('Navegador não suporta notificações nativas.', 'erro');
      return;
    }
    try {
      const resp = await Notification.requestPermission();
      atualizarStatusPermissaoNotificacao();
      if (resp === 'granted') {
        mostrarToast('Notificações no navegador ativadas!', 'sucesso');
        tocarSom(estado.tipoSom);
      } else {
        mostrarToast('Permissão não concedida pelo navegador.', 'erro');
      }
    } catch {
      mostrarToast('Não foi possível ativar permissão.', 'erro');
    }
  });
}

if (btnTestarAlertaCompleto) {
  btnTestarAlertaCompleto.addEventListener('click', () => {
    dispararAlertaNovoPedido({
      id: 'teste999',
      nome: 'Mesa de Teste',
      local: 'Mesa 1',
      total: 42.0,
    });
    mostrarToast('Alerta de teste disparado!', 'sucesso');
  });
}

const btnSilenciar = document.getElementById('btn-silenciar');
if (btnSilenciar) {
  btnSilenciar.addEventListener('click', () => {
    estado.somSilenciado = !estado.somSilenciado;
    localStorage.setItem('rainbow_adm_mudo', estado.somSilenciado ? '1' : '0');
    if (!estado.somSilenciado) {
      if (estado.modoNotificacao === 'mudo') {
        estado.modoNotificacao = 'todos';
        localStorage.setItem('rainbow_adm_modo_notif', 'todos');
        radiosModoNotif.forEach((r) => {
          r.checked = r.value === 'todos';
          const card = r.closest('.opcao-radio-card');
          if (card) card.classList.toggle('ativa', r.checked);
        });
      }
      obterContextoAudio();
      tocarSom(estado.tipoSom);
      mostrarToast('Alerta sonoro ativado.', 'sucesso');
    } else {
      mostrarToast('Alerta sonoro silenciado.');
    }
    atualizarBotaoSom();
  });
}
atualizarBotaoSom();
atualizarBotaoNotificacao();

// ─── Formatação de Data e Tempo ───
function extrairData(ts) {
  if (!ts) return new Date();
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000);
  return new Date(ts);
}

function formatarHoraHM(data) {
  return `${String(data.getHours()).padStart(2, '0')}:${String(data.getMinutes()).padStart(2, '0')}`;
}

function formatarTempoDecorrido(data) {
  const seg = Math.max(0, Math.floor((Date.now() - data.getTime()) / 1000));
  if (seg < 60) return 'agora';
  const min = Math.floor(seg / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  const mRest = min % 60;
  return mRest > 0 ? `há ${h}h ${mRest}m` : `há ${h}h`;
}

function formatarNoiteBR(noiteStr) {
  if (!noiteStr || typeof noiteStr !== 'string') return '';
  const partes = noiteStr.split('-');
  if (partes.length !== 3) return noiteStr;
  return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

// ─── 1. Autenticação (Login / Esqueci Senha / Sair) ───
const telaLogin = document.getElementById('tela-login');
const painelApp = document.getElementById('painel-app');
const formLogin = document.getElementById('form-login');
const inputEmailLogin = document.getElementById('login-email');
const inputSenhaLogin = document.getElementById('login-senha');
const msgLogin = document.getElementById('login-mensagem');
const btnEntrar = document.getElementById('btn-entrar');
const btnEsqueciSenha = document.getElementById('btn-esqueci-senha');

function exibirMensagemLogin(texto, sucesso = false) {
  msgLogin.textContent = texto;
  msgLogin.className = `mensagem-login ${sucesso ? 'sucesso' : ''}`;
  msgLogin.hidden = false;
}

function traduzirErroAuth(cod) {
  switch (cod) {
    case 'auth/invalid-email':
      return 'O endereço de e-mail informado não é válido.';
    case 'auth/user-disabled':
      return 'Este usuário foi desativado.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'E-mail ou senha incorretos.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas seguidas. Aguarde alguns instantes e tente novamente.';
    case 'auth/network-request-failed':
      return 'Sem conexão com a internet. Verifique sua rede.';
    case 'auth/missing-email':
      return 'Digite seu e-mail para continuar.';
    default:
      return 'Não foi possível autenticar. Confira seus dados e tente novamente.';
  }
}

formLogin.addEventListener('submit', async (e) => {
  e.preventDefault();
  msgLogin.hidden = true;
  const email = inputEmailLogin.value.trim();
  const senha = inputSenhaLogin.value;

  if (!email || !senha) {
    exibirMensagemLogin('Preencha o e-mail e a senha.');
    return;
  }

  btnEntrar.disabled = true;
  btnEntrar.textContent = 'Entrando...';
  try {
    await signInWithEmailAndPassword(auth, email, senha);
    inputSenhaLogin.value = '';
  } catch (err) {
    exibirMensagemLogin(traduzirErroAuth(err?.code));
  } finally {
    btnEntrar.disabled = false;
    btnEntrar.textContent = 'Entrar';
  }
});

btnEsqueciSenha.addEventListener('click', async () => {
  msgLogin.hidden = true;
  const email = inputEmailLogin.value.trim();
  if (!email) {
    exibirMensagemLogin('Digite seu e-mail no campo acima para redefinir a senha.');
    inputEmailLogin.focus();
    return;
  }

  btnEsqueciSenha.disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    exibirMensagemLogin('E-mail de redefinição enviado. Confira sua caixa de entrada.', true);
  } catch (err) {
    exibirMensagemLogin(traduzirErroAuth(err?.code));
  } finally {
    btnEsqueciSenha.disabled = false;
  }
});

async function sairDaConta() {
  try {
    await signOut(auth);
  } catch {
    mostrarToast('Erro ao encerrar a sessão.', 'erro');
  }
}

document.getElementById('btn-sair-desktop').addEventListener('click', sairDaConta);
document.getElementById('btn-sair-mobile').addEventListener('click', sairDaConta);

onAuthStateChanged(auth, (usuario) => {
  estado.usuario = usuario;
  if (usuario) {
    telaLogin.hidden = true;
    painelApp.hidden = false;
    document.getElementById('texto-usuario-logado').textContent = usuario.email || 'Equipe';
    iniciarEscutasFirestore();
    iniciarRelogioPedidos();
    carregarRelatorio();
  } else {
    encerrarEscutasFirestore();
    pararRelogioPedidos();
    painelApp.hidden = true;
    telaLogin.hidden = false;
    document.title = 'Rainbow Pub · Equipe';
  }
});

// ─── Navegação entre Telas (Pedidos, Cardápio, Página, Bar, Relatórios) ───
// "Ajustes" no menu junta duas telas: Bar (horários, GPS, locais) e Página (O Rainbow).
const GRUPO_TELA = { bar: 'ajustes', pagina: 'ajustes' };

function navegarParaTela(nomeTela) {
  const mudou = estado.telaAtiva !== nomeTela;
  estado.telaAtiva = nomeTela;
  const mapaSecoes = {
    pedidos: document.getElementById('tela-pedidos'),
    cardapio: document.getElementById('tela-cardapio'),
    estoque: document.getElementById('tela-estoque'),
    pagina: document.getElementById('tela-pagina'),
    bar: document.getElementById('tela-bar'),
    relatorios: document.getElementById('tela-relatorios'),
  };

  for (const [chave, secao] of Object.entries(mapaSecoes)) {
    if (secao) secao.hidden = chave !== nomeTela;
  }

  document.querySelectorAll('[data-ir-tela]').forEach((btn) => {
    const grupo = btn.getAttribute('data-grupo');
    const ativo = btn.getAttribute('data-ir-tela') === nomeTela || (grupo && grupo === GRUPO_TELA[nomeTela]);
    btn.classList.toggle('ativo', Boolean(ativo));
    btn.classList.toggle('ativa', Boolean(ativo));
  });

  if (nomeTela === 'relatorios') {
    carregarRelatorio();
  }
  if (nomeTela === 'estoque') renderizarEstoque();
  if (mudou) window.scrollTo(0, 0);
  aplicarModoBalcao();
}

document.querySelectorAll('[data-ir-tela]').forEach((btn) => {
  btn.addEventListener('click', () => {
    navegarParaTela(btn.getAttribute('data-ir-tela'));
  });
});

// ─── Escutas em Tempo Real do Firestore ───
function encerrarEscutasFirestore() {
  while (estado.cancelarEscutas.length > 0) {
    const unsub = estado.cancelarEscutas.pop();
    try {
      unsub();
    } catch {}
  }
  estado.primeiraCargaPedidos = true;
  estado.idsPedidosConhecidos.clear();
  estado.estoqueCarregado = false;
  estado.itensCarregados = false;
  estado.qtdVistaEstoque.clear();
  estado.receitasVistas.clear();
}

function iniciarEscutasFirestore() {
  encerrarEscutasFirestore();

  // 1. config/loja
  const unsubLoja = onSnapshot(
    doc(db, 'config', 'loja'),
    (snap) => {
      if (snap.exists()) {
        const dados = snap.data();
        estado.loja = {
          ...structuredClone(LOJA_INICIAL),
          ...dados,
          gps: {
            ...structuredClone(LOJA_INICIAL.gps),
            ...(dados.gps || {}),
          },
        };
      }
      atualizarTopoRecebendoPedidos();
      if (!estado.barEditando) {
        preencherFormularioBar();
      }
      renderizarPedidosAoVivo();
    },
    () => {
      mostrarToast('Erro ao sincronizar configurações da loja.', 'erro');
    }
  );
  estado.cancelarEscutas.push(unsubLoja);

  // 1.b config/sobre
  const unsubSobre = onSnapshot(
    doc(db, 'config', 'sobre'),
    (snap) => {
      if (snap.exists()) {
        estado.sobre = normalizarSobre(snap.data());
      } else {
        estado.sobre = structuredClone(SOBRE_INICIAL);
      }
      if (!estado.sobreEditando) {
        preencherFormularioSobre();
      }
    },
    () => {
      mostrarToast('Erro ao sincronizar textos da página.', 'erro');
    }
  );
  estado.cancelarEscutas.push(unsubSobre);

  // 1.c fotos
  const unsubFotos = onSnapshot(
    collection(db, 'fotos'),
    (snap) => {
      const lista = [];
      snap.forEach((d) => lista.push({ id: d.id, ...d.data() }));
      lista.sort(
        (a, b) =>
          Number(a.ordem || 0) - Number(b.ordem || 0) ||
          String(a.id || '').localeCompare(String(b.id || ''))
      );
      estado.fotos = lista;
      renderizarFotosBar();
    },
    () => {
      mostrarToast('Erro ao carregar fotos do bar.', 'erro');
    }
  );
  estado.cancelarEscutas.push(unsubFotos);

  // 2. categorias
  const unsubCategorias = onSnapshot(
    collection(db, 'categorias'),
    (snap) => {
      if (!snap.empty) {
        const lista = [];
        snap.forEach((d) => lista.push({ id: d.id, ...d.data() }));
        lista.sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0) || String(a.nome || '').localeCompare(String(b.nome || '')));
        estado.categorias = lista;
      }
      renderizarCardapio();
      renderizarGradeBalcao();
    },
    () => {
      mostrarToast('Erro ao carregar categorias.', 'erro');
    }
  );
  estado.cancelarEscutas.push(unsubCategorias);

  // 3. itens
  const unsubItens = onSnapshot(
    collection(db, 'itens'),
    (snap) => {
      if (!snap.empty) {
        const lista = [];
        snap.forEach((d) => lista.push({ id: d.id, ...d.data() }));
        lista.sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0) || String(a.nome || '').localeCompare(String(b.nome || '')));
        estado.itens = lista;
        atualizarMapaItens();
      }
      estado.itensCarregados = true;
      // produto com receita nova/alterada: confere se dá para vender com o estoque atual
      const receitaMudou = new Set();
      for (const it of estado.itens) {
        const chave = JSON.stringify(receitaDe(it));
        if (estado.receitasVistas.get(it.id) !== chave) receitaMudou.add(it.id);
        estado.receitasVistas.set(it.id, chave);
      }
      renderizarCardapio();
      renderizarPedidosAoVivo();
      renderizarGradeBalcao();
      renderizarEstoque();
      if (receitaMudou.size) sincronizarEsgotadosPorEstoque({ itens: receitaMudou });
    },
    () => {
      mostrarToast('Erro ao carregar itens do cardápio.', 'erro');
    }
  );
  estado.cancelarEscutas.push(unsubItens);

  // 3.b estoque (só a equipe lê)
  const unsubEstoque = onSnapshot(
    collection(db, 'estoque'),
    (snap) => {
      const lista = [];
      snap.forEach((d) => lista.push({ id: d.id, ...d.data() }));
      lista.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
      const primeira = !estado.estoqueCarregado;
      const mudaram = new Set();
      for (const ins of lista) {
        const q = Number(ins.qtd || 0);
        if (estado.qtdVistaEstoque.get(ins.id) !== q) mudaram.add(ins.id);
        estado.qtdVistaEstoque.set(ins.id, q);
      }
      estado.estoque = lista;
      estado.mapaEstoque = new Map(lista.map((x) => [x.id, x]));
      estado.estoqueCarregado = true;
      renderizarEstoque();
      if (primeira) renderizarCardapio(); else atualizarChipsEstoqueCardapio();
      atualizarRestamBalcao();
      // só mexe no "esgotado" de produto cujo estoque mudou (assim não briga com quem marcou à mão)
      sincronizarEsgotadosPorEstoque(primeira ? {} : { insumos: mudaram });
    },
    () => {
      mostrarToast('Erro ao carregar o estoque.', 'erro');
    }
  );
  estado.cancelarEscutas.push(unsubEstoque);

  // 4. pedidos (últimas 18 horas, ao vivo)
  const limite18h = Timestamp.fromDate(new Date(Date.now() - 18 * 3600 * 1000));
  const qPedidos = query(
    collection(db, 'pedidos'),
    where('criadoEm', '>=', limite18h),
    orderBy('criadoEm', 'desc')
  );

  const unsubPedidos = onSnapshot(
    qPedidos,
    (snap) => {
      if (!estado.primeiraCargaPedidos) {
        const novos = [];
        for (const change of snap.docChanges()) {
          if (change.type === 'added') {
            const d = change.doc.data();
            if (d && d.status === 'novo' && !estado.idsPedidosConhecidos.has(change.doc.id)) {
              novos.push({ id: change.doc.id, ...d });
            }
          }
        }
        // Fallback defensivo: se docChanges não listou por reconexão ou cache local
        if (novos.length === 0) {
          for (const d of snap.docs) {
            if (!estado.idsPedidosConhecidos.has(d.id)) {
              const dados = d.data();
              if (dados && dados.status === 'novo') {
                novos.push({ id: d.id, ...dados });
              }
            }
          }
        }

        if (novos.length > 0) {
          const ultimo = novos[novos.length - 1];
          dispararAlertaNovoPedido(ultimo);
          const cod = codigo(ultimo.id);
          const msg = novos.length > 1
            ? `${novos.length} novos pedidos recebidos!`
            : `Novo pedido recebido: Nº ${cod} (${ultimo.nome || 'Cliente'} · ${ultimo.local || 'Mesa'})`;
          mostrarToast(msg, 'sucesso');
        }
      }

      for (const d of snap.docs) {
        estado.idsPedidosConhecidos.add(d.id);
      }
      estado.primeiraCargaPedidos = false;

      const lista = [];
      snap.forEach((d) => lista.push({ id: d.id, ...d.data() }));
      estado.pedidosAoVivo = lista;
      renderizarPedidosAoVivo();
    },
    (erro) => {
      console.error('Erro ao acompanhar pedidos:', erro);
      mostrarToast('Erro ao acompanhar pedidos em tempo real.', 'erro');
    }
  );
  estado.cancelarEscutas.push(unsubPedidos);
}

// ─── 2. TELA DE PEDIDOS (AO VIVO) ───
const botoesModoLoja = document.querySelectorAll('[data-modo-loja]');
const faixaPedidosDesligados = document.getElementById('faixa-pedidos-desligados');
const gradeColunasPedidos = document.getElementById('grade-colunas-pedidos');

// O bar está em um destes três modos (nunca dois ao mesmo tempo):
//   recebendo → cliente pede pelo celular
//   balcao    → site só cardápio, equipe lança as vendas na grade
//   fechado   → ninguém pede pelo site
const MODOS_LOJA = {
  recebendo: { campos: { aceitandoPedidos: true, modoBalcao: false }, aviso: 'Recebendo pedidos pelo celular.', tipo: 'sucesso' },
  balcao: { campos: { aceitandoPedidos: false, modoBalcao: true }, aviso: 'Modo balcão: o site virou só cardápio.', tipo: 'sucesso' },
  fechado: { campos: { aceitandoPedidos: false, modoBalcao: false }, aviso: 'Fechado: ninguém pede pelo site.', tipo: 'info' },
};

function modoLojaAtual() {
  if (estado.loja?.modoBalcao === true) return 'balcao';
  return estado.loja?.aceitandoPedidos ? 'recebendo' : 'fechado';
}

function atualizarTopoRecebendoPedidos() {
  const modo = modoLojaAtual();
  botoesModoLoja.forEach((b) => {
    const ativo = b.getAttribute('data-modo-loja') === modo;
    b.setAttribute('aria-checked', ativo ? 'true' : 'false');
    b.classList.toggle('ativo', ativo);
  });
  faixaPedidosDesligados.hidden = modo !== 'fechado';
  aplicarModoBalcao();
}

botoesModoLoja.forEach((b) => {
  b.addEventListener('click', async () => {
    const modo = b.getAttribute('data-modo-loja');
    if (modo === modoLojaAtual()) return;
    const antes = { aceitandoPedidos: estado.loja.aceitandoPedidos, modoBalcao: estado.loja.modoBalcao };
    const { campos, aviso, tipo } = MODOS_LOJA[modo];
    Object.assign(estado.loja, campos);
    atualizarTopoRecebendoPedidos();
    try {
      await setDoc(doc(db, 'config', 'loja'), campos, { merge: true });
      mostrarToast(aviso, tipo);
    } catch {
      Object.assign(estado.loja, antes);
      atualizarTopoRecebendoPedidos();
      mostrarToast('Não foi possível trocar o modo do bar.', 'erro');
    }
  });
});

// Abas de status (Novos | Preparando | Prontos | Finalizados)
document.querySelectorAll('.aba-status').forEach((aba) => {
  aba.addEventListener('click', () => {
    const filtro = aba.getAttribute('data-aba-status');
    estado.abaStatusPedidos = filtro;
    document.querySelectorAll('.aba-status').forEach((b) => {
      const ativa = b.getAttribute('data-aba-status') === filtro;
      b.classList.toggle('ativa', ativa);
      b.setAttribute('aria-selected', ativa ? 'true' : 'false');
    });
    gradeColunasPedidos.setAttribute('data-coluna-ativa', filtro);
  });
});

function calcularTotalPeloCardapioAtual(itensPedido) {
  if (!Array.isArray(itensPedido)) return 0;
  let soma = 0;
  for (const it of itensPedido) {
    const qtd = Number(it?.qtd || 0);
    const cadastrado = it?.id ? estado.mapaItens.get(it.id) : null;
    const precoBase = cadastrado ? Number(cadastrado.preco || 0) : Number(it?.preco || 0);
    soma += qtd * precoBase;
  }
  return soma;
}

function montarHtmlCartaoPedido(p) {
  const dataCriado = extrairData(p.criadoEm);
  const horaStr = formatarHoraHM(dataCriado);
  const haQuantoStr = formatarTempoDecorrido(dataCriado);
  const cod = codigo(p.id);

  // Lista de itens
  const itensHtml = (Array.isArray(p.itens) ? p.itens : [])
    .map((it) => {
      const qtd = Number(it?.qtd || 1);
      const grupoHtml = it?.grupo && it.grupo !== it.nome
        ? `<span class="grupo-item-pedido">${esc(it.grupo)}</span>`
        : '';
      return `<li class="item-linha-pedido">
        <span class="qtd-item-pedido">${esc(qtd)}×</span>
        <span class="nome-item-pedido">${esc(it?.nome || 'Item')}${grupoHtml}</span>
      </li>`;
    })
    .join('');

  // Observação
  const obsHtml =
    p.obs && String(p.obs).trim()
      ? `<div class="obs-pedido">Obs.: ${esc(String(p.obs).trim())}</div>`
      : '';

  // Conferência de preço com o cardápio atual
  const totalCardapio = calcularTotalPeloCardapioAtual(p.itens);
  const totalPedido = Number(p.total || 0);
  const diverge = Math.abs(totalPedido - totalCardapio) > 0.01;
  const divergenciaHtml = diverge
    ? `<div class="aviso-divergencia">valor diferente do cardápio (${esc(brl(totalCardapio))})</div>`
    : '';

  // Selo de GPS
  let textoGps = p.origem === 'balcao' ? 'Venda no balcão' : 'sem GPS';
  if (
    p.geo &&
    typeof p.geo.lat === 'number' &&
    typeof p.geo.lng === 'number' &&
    estado.loja?.gps &&
    typeof estado.loja.gps.lat === 'number' &&
    typeof estado.loja.gps.lng === 'number'
  ) {
    const metros = Math.round(distancia(p.geo, estado.loja.gps));
    const precisao = Math.round(Number(p.geo.precisao || 0));
    textoGps = `${metros} m (±${precisao} m)`;
  }

  // Selo de pagamento e status finalizado
  const seloPagoHtml = p.pago
    ? `<span class="selo selo-pago">Pago</span>`
    : `<span class="selo selo-apagar">Não pago</span>`;

  let seloStatusExtra = '';
  if (p.status === 'cancelado') {
    seloStatusExtra = `<span class="selo selo-status-cancelado">${esc(STATUS.cancelado)}</span>`;
  } else if (p.status === 'entregue') {
    seloStatusExtra = `<span class="selo">${esc(STATUS.entregue)}</span>`;
  }

  // Botão de avanço de status (novo -> preparo -> pronto -> entregue)
  let btnAvancarHtml = '';
  if (p.status === 'novo') {
    btnAvancarHtml = `<button type="button" class="btn btn-principal btn-bloco" data-acao-pedido="avancar" data-id="${esc(p.id)}" data-proximo="preparo">Iniciar preparo</button>`;
  } else if (p.status === 'preparo') {
    btnAvancarHtml = `<button type="button" class="btn btn-principal btn-bloco" data-acao-pedido="avancar" data-id="${esc(p.id)}" data-proximo="pronto">Marcar pronto</button>`;
  } else if (p.status === 'pronto') {
    btnAvancarHtml = `<button type="button" class="btn btn-principal btn-bloco" data-acao-pedido="avancar" data-id="${esc(p.id)}" data-proximo="entregue">Marcar entregue</button>`;
  }

  const btnPagoHtml = `<button type="button" class="btn btn-compacto btn-status-pago ${p.pago ? 'btn-status-pago--pago' : 'btn-status-pago--nao-pago'}" data-acao-pedido="pago" data-id="${esc(p.id)}" title="${p.pago ? 'Pedido pago. Clique para marcar como não pago.' : 'Pedido não pago. Clique para marcar como pago.'}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
      ${p.pago ? '<polyline points="20 6 9 17 4 12"/>' : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'}
    </svg>
    <span>${p.pago ? 'Pago' : 'Não pago'}</span>
  </button>`;
  const btnCancelarHtml =
    p.status !== 'cancelado'
      ? `<button type="button" class="btn btn-perigo btn-compacto" data-acao-pedido="cancelar" data-id="${esc(p.id)}">Cancelar</button>`
      : '';

  return `<article class="cartao-pedido" data-status="${esc(p.status)}">
    <div class="topo-cartao-pedido">
      <strong class="codigo-pedido">Nº ${esc(cod)}</strong>
      <div class="topo-cartao-pedido__dir">
        <div class="tempo-pedido">
          <span>${esc(horaStr)}</span>
          <span data-tempo-ts="${esc(dataCriado.getTime())}" ${['novo', 'preparo', 'pronto'].includes(p.status) ? 'data-tempo-alerta' : ''} class="${classeTempo(dataCriado.getTime(), ['novo', 'preparo', 'pronto'].includes(p.status))}">${esc(haQuantoStr)}</span>
        </div>
        <button type="button" class="btn-apagar-pedido" data-acao-pedido="apagar" data-id="${esc(p.id)}" title="Apagar pedido de vez (some também dos relatórios)" aria-label="Apagar pedido Nº ${esc(cod)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18"/>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/>
            <path d="M14 11v6"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="cliente-pedido">
      <span class="nome-cliente">${esc(p.nome || 'Cliente')}</span>
      <span class="local-cliente">${esc(p.local || '-')}</span>
    </div>
    <ul class="itens-pedido">${itensHtml}</ul>
    ${obsHtml}
    ${divergenciaHtml}
    <div class="meta-pedido">
      <div class="selos-pedido">
        ${seloPagoHtml}
        <span class="selo">${esc(textoGps)}</span>
        ${seloStatusExtra}
      </div>
      <strong class="total-pedido">${esc(brl(totalPedido))}</strong>
    </div>
    <div class="acoes-cartao-pedido">
      ${btnAvancarHtml}
      <div class="acoes-secundarias-pedido">
        ${btnPagoHtml}
        ${btnCancelarHtml}
      </div>
    </div>
  </article>`;
}

function renderizarPedidosAoVivo() {
  const grupos = {
    novo: [],
    preparo: [],
    pronto: [],
    finalizados: [],
  };

  for (const p of estado.pedidosAoVivo) {
    if (p.status === 'novo') grupos.novo.push(p);
    else if (p.status === 'preparo') grupos.preparo.push(p);
    else if (p.status === 'pronto') grupos.pronto.push(p);
    else grupos.finalizados.push(p);
  }

  const qtdNovos = grupos.novo.length;
  const qtdPreparo = grupos.preparo.length;
  const qtdPronto = grupos.pronto.length;
  const qtdFinalizados = grupos.finalizados.length;

  // Atualiza contadores nas abas e cabeçalhos
  document.getElementById('cont-aba-novo').textContent = String(qtdNovos);
  document.getElementById('cont-aba-preparo').textContent = String(qtdPreparo);
  document.getElementById('cont-aba-pronto').textContent = String(qtdPronto);
  document.getElementById('cont-aba-finalizados').textContent = String(qtdFinalizados);

  document.getElementById('cont-col-novo').textContent = String(qtdNovos);
  document.getElementById('cont-col-preparo').textContent = String(qtdPreparo);
  document.getElementById('cont-col-pronto').textContent = String(qtdPronto);
  document.getElementById('cont-col-finalizados').textContent = String(qtdFinalizados);

  // Badges de novos pedidos no menu e no <title>
  const badgeDesktop = document.getElementById('badge-menu-pedidos');
  const badgeMobile = document.getElementById('badge-mobile-pedidos');
  if (qtdNovos > 0) {
    badgeDesktop.textContent = String(qtdNovos);
    badgeDesktop.hidden = false;
    badgeMobile.textContent = String(qtdNovos);
    badgeMobile.hidden = false;
    document.title = `(${qtdNovos}) Pedidos · Rainbow`;
  } else {
    badgeDesktop.hidden = true;
    badgeMobile.hidden = true;
    document.title = 'Rainbow Pub · Equipe';
  }

  const preencherColuna = (idContainer, lista, msgVazia) => {
    const el = document.getElementById(idContainer);
    if (!el) return;
    if (lista.length === 0) {
      el.innerHTML = `<div class="estado-vazio">${esc(msgVazia)}</div>`;
    } else {
      el.innerHTML = lista.map(montarHtmlCartaoPedido).join('');
    }
  };

  preencherColuna('lista-pedidos-novo', grupos.novo, 'Nenhum pedido novo.');
  preencherColuna('lista-pedidos-preparo', grupos.preparo, 'Nenhum pedido em preparo.');
  preencherColuna('lista-pedidos-pronto', grupos.pronto, 'Nenhum pedido pronto aguardando entrega.');
  preencherColuna('lista-pedidos-finalizados', grupos.finalizados, 'Nenhum pedido finalizado nas últimas 18 h.');
  atualizarResumoBalcao();
}

// Delegação de clique para ações nos cartões de pedido
gradeColunasPedidos.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-acao-pedido]');
  if (!btn) return;
  const acao = btn.getAttribute('data-acao-pedido');
  const id = btn.getAttribute('data-id');
  const pedido = estado.pedidosAoVivo.find((x) => x.id === id);
  if (!pedido) return;

  btn.disabled = true;
  try {
    if (acao === 'avancar') {
      const proximo = btn.getAttribute('data-proximo');
      await avancarPedido(id, proximo);
      mostrarToast(`Pedido Nº ${codigo(id)} → ${STATUS[proximo] || proximo}`, 'sucesso');
    } else if (acao === 'pago') {
      const novoPago = !pedido.pago;
      await updateDoc(doc(db, 'pedidos', id), { pago: novoPago });
      mostrarToast(`Pedido Nº ${codigo(id)} marcado como ${novoPago ? 'Pago' : 'Não pago'}.`, novoPago ? 'sucesso' : 'info');
    } else if (acao === 'cancelar') {
      const ok = await confirmarAcao({
        titulo: `Cancelar pedido Nº ${codigo(id)}`,
        mensagem: `Deseja realmente cancelar o pedido de ${pedido.nome} (${brl(pedido.total)})?`,
        textoConfirmar: 'Sim, cancelar pedido',
        perigo: true,
      });
      if (ok) {
        const devolveu = await cancelarPedido(id);
        mostrarToast(`Pedido Nº ${codigo(id)} cancelado.${devolveu ? ' O estoque voltou.' : ''}`);
      }
    } else if (acao === 'apagar') {
      const ok = await confirmarAcao({
        titulo: `Apagar pedido Nº ${codigo(id)}`,
        mensagem: `O pedido de ${pedido.nome} (${brl(pedido.total)}) some de tudo: painel, faturamento e relatórios. Não dá para desfazer.`,
        textoConfirmar: 'Sim, apagar de vez',
        perigo: true,
      });
      if (ok) {
        const devolveu = await apagarPedido(id);
        estado.balcaoLancados = estado.balcaoLancados.filter((x) => x.id !== id);
        mostrarToast(`Pedido Nº ${codigo(id)} apagado.${devolveu ? ' O estoque voltou.' : ''}`);
      }
    }
  } catch {
    mostrarToast('Não foi possível atualizar o pedido.', 'erro');
  } finally {
    btn.disabled = false;
  }
});

// ─── ESTOQUE NOS PEDIDOS ───
// Pedido do site: o estoque baixa quando a equipe aceita (sai de "novo"). Venda no balcão: na hora.
// Cancelar, apagar ou "Voltar" devolve exatamente o que saiu (fica gravado em pedido.baixa).
// Transação: dois celulares tocando no mesmo pedido não baixam duas vezes.
function movimentarEstoque(escritor, baixa, sinal) {
  for (const [insumo, qtd] of Object.entries(baixa || {})) {
    if (!estado.mapaEstoque.has(insumo) || !(Number(qtd) > 0)) continue;
    escritor.update(doc(db, 'estoque', insumo), { qtd: increment(sinal * Number(qtd)), atualizadoEm: serverTimestamp() });
  }
}

async function avancarPedido(id, proximo) {
  const ref = doc(db, 'pedidos', id);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('pedido sumiu');
      const p = snap.data();
      const dados = { status: proximo };
      if (!p.estoqueBaixado && p.status !== 'cancelado') {
        const baixa = baixaDoPedido(p.itens, estado.mapaItens, estado.mapaEstoque);
        movimentarEstoque(tx, baixa, -1);
        dados.estoqueBaixado = true;
        dados.baixa = baixa;
      }
      tx.update(ref, dados);
    });
  } catch (erro) {
    // item de estoque apagado no meio do caminho não pode travar o atendimento
    if (String(erro?.code || '').includes('not-found')) {
      await updateDoc(ref, { status: proximo });
      mostrarToast('Pedido andou, mas o estoque não baixou (item de estoque não existe mais).', 'erro');
      return;
    }
    throw erro;
  }
}

async function cancelarPedido(id) {
  const ref = doc(db, 'pedidos', id);
  let devolveu = false;
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const p = snap.data();
    const dados = { status: 'cancelado' };
    if (p.estoqueBaixado) {
      movimentarEstoque(tx, p.baixa, +1);
      dados.estoqueBaixado = false;
      dados.baixa = deleteField();
      devolveu = Object.keys(p.baixa || {}).length > 0;
    }
    tx.update(ref, dados);
  });
  return devolveu;
}

async function apagarPedido(id) {
  const ref = doc(db, 'pedidos', id);
  let devolveu = false;
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const p = snap.data();
    if (p.estoqueBaixado && p.status !== 'cancelado') {
      movimentarEstoque(tx, p.baixa, +1);
      devolveu = Object.keys(p.baixa || {}).length > 0;
    }
    tx.delete(ref);
  });
  return devolveu;
}

// Produto que dependia de um estoque que acabou fica "esgotado" sozinho (e volta quando repõe).
// Só mexe quando o estoque daquele produto muda: quem marcar à mão não é desfeito na hora.
const esgotadoEmEscrita = new Set();
function sincronizarEsgotadosPorEstoque({ itens = null, insumos = null } = {}) {
  if (!estado.estoqueCarregado || !estado.itensCarregados) return;
  const todos = !itens && !insumos;
  for (const it of estado.itens) {
    const receita = receitaDe(it).filter((r) => estado.mapaEstoque.has(r.insumo));
    if (!receita.length || esgotadoEmEscrita.has(it.id)) continue;
    const afetado = todos || itens?.has(it.id) || receita.some((r) => insumos?.has(r.insumo));
    if (!afetado) continue;
    const pode = porcoesPossiveis(it, estado.mapaEstoque) >= 1;
    let dados = null;
    if (!pode && !it.esgotado) dados = { esgotado: true, esgotadoAuto: true };
    else if (pode && it.esgotado && it.esgotadoAuto) dados = { esgotado: false, esgotadoAuto: deleteField() };
    if (!dados) continue;
    esgotadoEmEscrita.add(it.id);
    updateDoc(doc(db, 'itens', it.id), dados)
      .catch(() => {})
      .finally(() => esgotadoEmEscrita.delete(it.id));
  }
}

// ─── MODO BALCÃO ───
// Casa cheia / festa: o site vira só cardápio e a tela de pedidos vira uma grade com todos os
// produtos, que cabe inteira na tela sem rolar. Tocar num produto lança 1 unidade já paga e entregue.
const telaPedidos = document.getElementById('tela-pedidos');
const telaBalcao = document.getElementById('tela-balcao');
const gradeBalcao = document.getElementById('grade-balcao');
const resumoBalcao = document.getElementById('resumo-balcao');
const btnBalcaoDesfazer = document.getElementById('btn-balcao-desfazer');

const modoBalcaoLigado = () => estado.loja?.modoBalcao === true;

function aplicarModoBalcao() {
  const ligado = modoBalcaoLigado();
  telaPedidos.classList.toggle('em-balcao', ligado);
  telaBalcao.hidden = !ligado;
  resumoBalcao.hidden = !ligado;
  document.body.classList.toggle('modo-balcao-ativo', ligado && estado.telaAtiva === 'pedidos');
  if (ligado) {
    if (!gradeBalcao.childElementCount) renderizarGradeBalcao();
    requestAnimationFrame(ajustarGradeBalcao);
  }
}

function itensDoBalcao() {
  const ordemCat = new Map(estado.categorias.map((c, i) => [c.id, Number(c.ordem ?? i)]));
  return estado.itens
    .filter((it) => it && it.ativo !== false && !it.esgotado && Number(it.preco) > 0)
    .slice()
    .sort((a, b) =>
      (ordemCat.get(a.categoria) ?? 999) - (ordemCat.get(b.categoria) ?? 999) ||
      Number(a.ordem || 0) - Number(b.ordem || 0));
}

function renderizarGradeBalcao() {
  if (!modoBalcaoLigado()) { gradeBalcao.innerHTML = ''; return; }
  const itens = itensDoBalcao();
  const corCat = new Map(estado.categorias.map((c) => [c.id, c.cor || '#F28BAA']));
  // nome repetido (Brahma litrão × 600 ml): mostra o grupo para não confundir
  const vezes = new Map();
  for (const it of itens) vezes.set(it.nome, (vezes.get(it.nome) || 0) + 1);

  gradeBalcao.innerHTML = itens.length
    ? itens.map((it) => {
      const grupo = vezes.get(it.nome) > 1 && it.grupo ? ` <small class="peca-balcao__grupo">${esc(it.grupo)}</small>` : '';
      return `<button type="button" class="peca-balcao" data-lancar="${esc(it.id)}" data-nome="${esc(it.nome + (grupo ? ` (${it.grupo})` : ''))}" style="--c:${esc(corCat.get(it.categoria) || '#F28BAA')}" aria-label="Lançar ${esc(it.nome)}${grupo ? ' ' + esc(it.grupo) : ''}, ${esc(brl(it.preco))}">
        <span class="peca-balcao__nome">${esc(it.nome)}${grupo}</span>
        <span class="peca-balcao__resta" data-resta="${esc(it.id)}" hidden></span>
        <span class="peca-balcao__rodape">
          <span class="peca-balcao__preco">${esc(brl(it.preco))}</span>
          <span class="peca-balcao__lancar">Lançar</span>
        </span>
      </button>`;
    }).join('')
    : '<div class="estado-vazio">Nenhum produto disponível. Confira o cardápio (itens ativos e não esgotados).</div>';
  atualizarRestamBalcao();
  ajustarGradeBalcao();
}

// Quando o estoque de um produto está no fim, o botão avisa quantos ainda dá para vender.
function atualizarRestamBalcao() {
  gradeBalcao.querySelectorAll('[data-resta]').forEach((el) => {
    const it = estado.mapaItens.get(el.getAttribute('data-resta'));
    const n = it ? porcoesPossiveis(it, estado.mapaEstoque) : null;
    const mostrar = n !== null && n <= 5;
    el.hidden = !mostrar;
    if (mostrar) el.textContent = n === 1 ? 'último' : `restam ${n}`;
    el.closest('.peca-balcao')?.classList.toggle('peca-balcao--fim', mostrar);
  });
}

// Escolhe colunas × linhas para o maior botão possível sem rolar; a última linha estica
// (nada de buraco na grade).
function ajustarGradeBalcao() {
  if (telaBalcao.hidden || telaPedidos.hidden) return;
  const pecas = [...gradeBalcao.querySelectorAll('.peca-balcao')];
  const n = pecas.length;
  if (!n) return;

  const navInferior = document.querySelector('.barra-inferior-mobile');
  const navVisivel = navInferior && getComputedStyle(navInferior).display !== 'none';
  // no PC sobra uma faixa embaixo para a assinatura do rodapé não cobrir o último botão
  const reserva = navVisivel ? navInferior.getBoundingClientRect().height + 8 : 30;
  const topo = telaBalcao.getBoundingClientRect().top;
  const altura = Math.max(160, Math.floor(window.innerHeight - topo - reserva));
  const largura = telaBalcao.clientWidth;
  telaBalcao.style.height = altura + 'px';

  const gap = largura < 600 ? 4 : 8;
  // Escolhe a grade que deixa a maior letra possível: cada botão precisa de 2 linhas de nome
  // + a linha de preço/LANÇAR + respiro (altura ≈ 4,3 letras + borda) e de ~10 letras de
  // largura (≈ 7,4 letras).
  let melhor = { cols: 1, linhas: n, fonte: -1 };
  for (let cols = 1; cols <= n; cols++) {
    const linhas = Math.ceil(n / cols);
    const w = (largura - gap * (cols - 1)) / cols;
    const h = (altura - gap * (linhas - 1)) / linhas;
    if (w <= 0 || h <= 0) continue;
    const fonte = Math.min(24, (h - 9) / 4.3, (w - 4) / 7.4);
    if (fonte > melhor.fonte) melhor = { cols, linhas, fonte };
  }

  const { cols, linhas } = melhor;
  const fonte = Math.max(8, melhor.fonte);
  gradeBalcao.style.setProperty('--gap', gap + 'px');
  gradeBalcao.style.setProperty('--fonte', fonte.toFixed(1) + 'px');
  gradeBalcao.classList.toggle('grade-balcao--apertada', fonte < 13);

  // monta as linhas (elementos já existentes, só reagrupados)
  const frag = document.createDocumentFragment();
  for (let l = 0; l < linhas; l++) {
    const linha = document.createElement('div');
    linha.className = 'linha-balcao';
    pecas.slice(l * cols, (l + 1) * cols).forEach((p) => linha.appendChild(p));
    frag.appendChild(linha);
  }
  gradeBalcao.replaceChildren(frag);
}

let esperaAjuste = 0;
const pedirAjuste = () => { cancelAnimationFrame(esperaAjuste); esperaAjuste = requestAnimationFrame(ajustarGradeBalcao); };
window.addEventListener('resize', pedirAjuste);
if ('ResizeObserver' in window) {
  new ResizeObserver(pedirAjuste).observe(document.querySelector('.barra-topo-pedidos'));
}

gradeBalcao.addEventListener('click', (e) => {
  const peca = e.target.closest('[data-lancar]');
  if (!peca) return;
  lancarNoBalcao(peca.getAttribute('data-lancar'), peca);
});

function lancarNoBalcao(id, peca) {
  const it = estado.mapaItens.get(id);
  if (!it || !(Number(it.preco) > 0)) return;
  const preco = Number(it.preco);
  const ref = doc(collection(db, 'pedidos'));
  const venda = {
    nome: 'Balcão',
    local: 'Balcão',
    itens: [{ id: it.id, nome: it.nome, grupo: it.grupo || '', cat: it.categoria || '', preco, qtd: 1 }],
    total: preco,
    status: 'entregue',
    pago: true,
    criadoEm: serverTimestamp(),
    noite: noiteDe(new Date()),
    origem: 'balcao',
  };
  const baixa = baixaDoPedido(venda.itens, estado.mapaItens, estado.mapaEstoque);
  venda.estoqueBaixado = true;
  venda.baixa = baixa;
  const registro = { id: ref.id, nome: peca?.getAttribute('data-nome') || it.nome, preco, baixa, t: Date.now() };
  estado.balcaoLancados.push(registro);
  piscarPeca(peca, 'lancado');
  if (navigator.vibrate) navigator.vibrate(15);
  atualizarResumoBalcao();

  // não espera o servidor: o Firestore guarda e manda assim que der (internet ruim em casa cheia).
  // Venda e baixa do estoque vão juntas: ou entram as duas, ou nenhuma.
  const lote = writeBatch(db);
  lote.set(ref, venda);
  movimentarEstoque(lote, baixa, -1);
  lote.commit().catch(() => {
    estado.balcaoLancados = estado.balcaoLancados.filter((x) => x.id !== ref.id);
    atualizarResumoBalcao();
    piscarPeca(peca, 'falhou');
    mostrarToast(`Não lançou ${registro.nome}. Toque de novo.`, 'erro');
  });
}

function piscarPeca(peca, classe) {
  if (!peca) return;
  peca.classList.remove('lancado', 'falhou');
  void peca.offsetWidth;
  peca.classList.add(classe);
  clearTimeout(peca._tempo);
  peca._tempo = setTimeout(() => peca.classList.remove(classe), 900);
}

function atualizarResumoBalcao() {
  if (resumoBalcao.hidden) return;
  const noite = noiteDe(new Date());
  const vendas = estado.pedidosAoVivo.filter((p) => p.origem === 'balcao' && p.status !== 'cancelado' && p.noite === noite);
  const ids = new Set(vendas.map((p) => p.id));
  for (const x of estado.balcaoLancados) if (ids.has(x.id)) x.visto = true;
  // soma também o que já foi tocado e ainda está subindo para o servidor
  const pendentes = estado.balcaoLancados.filter((x) => !ids.has(x.id) && !x.visto);
  const qtd = vendas.reduce((s, p) => s + (p.itens || []).reduce((a, i) => a + Number(i.qtd || 0), 0), 0) + pendentes.length;
  const valor = vendas.reduce((s, p) => s + Number(p.total || 0), 0) + pendentes.reduce((s, x) => s + x.preco, 0);
  document.getElementById('balcao-total-noite').textContent = `${qtd} ${qtd === 1 ? 'item' : 'itens'} · ${brl(valor)}`;

  const ultimo = estado.balcaoLancados[estado.balcaoLancados.length - 1];
  // "Voltar" fica sempre à vista; apagado quando não há o que desfazer nesta tela
  document.getElementById('balcao-ultimo').hidden = !ultimo;
  btnBalcaoDesfazer.disabled = !ultimo;
  btnBalcaoDesfazer.title = ultimo
    ? `Voltar: desfaz ${ultimo.nome} (${brl(ultimo.preco)})`
    : 'Voltar: nada lançado ainda';
  if (ultimo) {
    document.getElementById('balcao-ultimo-texto').textContent = `${ultimo.nome} · ${brl(ultimo.preco)}`;
  }
}

btnBalcaoDesfazer.addEventListener('click', async () => {
  const ultimo = estado.balcaoLancados[estado.balcaoLancados.length - 1];
  if (!ultimo) return;
  estado.balcaoLancados.pop();
  atualizarResumoBalcao();
  // já chegou no servidor e não está mais na lista = outro aparelho apagou: só tira daqui
  if (ultimo.visto && !estado.pedidosAoVivo.some((p) => p.id === ultimo.id)) {
    mostrarToast(`${ultimo.nome} já tinha sido apagado em outro aparelho.`, 'info');
    return;
  }
  try {
    const lote = writeBatch(db);
    lote.delete(doc(db, 'pedidos', ultimo.id));
    movimentarEstoque(lote, ultimo.baixa, +1);
    await lote.commit();
    mostrarToast(`Voltou: ${ultimo.nome} saiu das vendas${Object.keys(ultimo.baixa || {}).length ? ' e o estoque voltou' : ''}.`, 'info');
  } catch {
    estado.balcaoLancados.push(ultimo);
    atualizarResumoBalcao();
    mostrarToast('Não foi possível voltar o último lançamento.', 'erro');
  }
});

// Pedido em aberto há muito tempo chama atenção: 8 min amarelo, 15 min vermelho.
function classeTempo(ts, emAberto) {
  if (!emAberto) return '';
  const min = (Date.now() - ts) / 60000;
  return min >= 15 ? 'tempo--atrasado' : min >= 8 ? 'tempo--atencao' : '';
}

// Relógio para atualizar "há X min" a cada 30s
function iniciarRelogioPedidos() {
  pararRelogioPedidos();
  estado.intervaloRelogio = setInterval(() => {
    document.querySelectorAll('[data-tempo-ts]').forEach((span) => {
      const ts = Number(span.getAttribute('data-tempo-ts'));
      if (!ts) return;
      span.textContent = formatarTempoDecorrido(new Date(ts));
      span.className = classeTempo(ts, span.hasAttribute('data-tempo-alerta'));
    });
  }, 30000);
}

function pararRelogioPedidos() {
  if (estado.intervaloRelogio) {
    clearInterval(estado.intervaloRelogio);
    estado.intervaloRelogio = null;
  }
}

// ─── 3. TELA DE CARDÁPIO (Categorias e Itens) ───
const btnAbrirNovaCategoria = document.getElementById('btn-abrir-nova-categoria');
const formNovaCategoria = document.getElementById('form-nova-categoria');
const btnCancelarNovaCategoria = document.getElementById('btn-cancelar-nova-categoria');
const inputNovaCatCor = document.getElementById('nova-cat-cor');
const spanNovaCatCorHex = document.getElementById('nova-cat-cor-hex');
const containerCategorias = document.getElementById('container-categorias');

function gerarSlugId(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56);
}

inputNovaCatCor.addEventListener('input', () => {
  spanNovaCatCorHex.textContent = inputNovaCatCor.value.toUpperCase();
});

btnAbrirNovaCategoria.addEventListener('click', () => {
  const proxOrdem =
    estado.categorias.reduce((m, c) => Math.max(m, Number(c.ordem || 0)), 0) + 1;
  document.getElementById('nova-cat-ordem').value = String(proxOrdem);
  formNovaCategoria.hidden = false;
  document.getElementById('nova-cat-nome').focus();
});

btnCancelarNovaCategoria.addEventListener('click', () => {
  formNovaCategoria.reset();
  formNovaCategoria.hidden = true;
});

formNovaCategoria.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = document.getElementById('nova-cat-nome').value.trim();
  const cor = document.getElementById('nova-cat-cor').value;
  const ordem = Number(document.getElementById('nova-cat-ordem').value || 1);
  if (!nome) {
    mostrarToast('Informe o nome da categoria.', 'erro');
    return;
  }

  let id = gerarSlugId(nome);
  if (!id || estado.categorias.some((c) => c.id === id)) {
    id = `${id || 'cat'}-${Date.now().toString(36).slice(-4)}`;
  }

  try {
    await setDoc(doc(db, 'categorias', id), { nome, cor, ordem });
    formNovaCategoria.reset();
    formNovaCategoria.hidden = true;
    mostrarToast('Categoria criada com sucesso.', 'sucesso');
  } catch {
    mostrarToast('Erro ao criar categoria.', 'erro');
  }
});

// Compressão de imagem via Canvas (máx 640px, JPEG 0.8, limite 300 KB)
function comprimirImagemParaDataURL(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error('Falha ao ler o arquivo de imagem.'));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
      img.onload = () => {
        const MAX_LADO = 640;
        let larg = img.naturalWidth || img.width;
        let alt = img.naturalHeight || img.height;
        if (larg > MAX_LADO || alt > MAX_LADO) {
          if (larg >= alt) {
            alt = Math.round((alt * MAX_LADO) / larg);
            larg = MAX_LADO;
          } else {
            larg = Math.round((larg * MAX_LADO) / alt);
            alt = MAX_LADO;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = larg;
        canvas.height = alt;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, larg, alt);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        if (dataUrl.length > 300 * 1024) {
          reject(new Error('A foto ultrapassou 300 KB após comprimir. Escolha uma imagem menor.'));
          return;
        }
        resolve(dataUrl);
      };
      img.src = String(leitor.result);
    };
    leitor.readAsDataURL(arquivo);
  });
}

function montarFormularioItemHtml(item, catId, ehNovo = false) {
  const chaveItem = ehNovo ? `novo_${catId}` : item.id;
  const fotoAtual = estado.fotosTemporarias.has(chaveItem)
    ? estado.fotosTemporarias.get(chaveItem)
    : item.foto || '';

  const ehDrinks = catId === 'drinks';
  const temCorCopo = Array.isArray(item.cor) && item.cor.length === 2;
  const corBase = temCorCopo ? item.cor[0] : '#C9E26B';
  const corTopo = temCorCopo ? item.cor[1] : '#F3F7C8';

  const blocoCoresCopoHtml = ehDrinks
    ? `<div class="bloco-extra-item">
        <label class="switch-padrao">
          <input type="checkbox" data-campo="usarCorCopo" ${temCorCopo ? 'checked' : ''}>
          <span class="trilho-switch"></span>
          <span>Colorir ilustração do copo (exclusivo de Drinks)</span>
        </label>
        <div class="grade-campos-2">
          <div class="campo">
            <label>Cor da base do copo</label>
            <div class="linha-cor">
              <input type="color" data-campo="corBase" value="${esc(corBase)}">
              <span class="codigo-hex">${esc(corBase)}</span>
            </div>
          </div>
          <div class="campo">
            <label>Cor do topo do copo</label>
            <div class="linha-cor">
              <input type="color" data-campo="corTopo" value="${esc(corTopo)}">
              <span class="codigo-hex">${esc(corTopo)}</span>
            </div>
          </div>
        </div>
      </div>`
    : '';

  const previewFotoHtml = fotoAtual
    ? `<img src="${esc(fotoAtual)}" alt="Prévia da foto" class="preview-foto-editor">`
    : '';

  const btnRemoverFotoHtml = fotoAtual
    ? `<button type="button" class="btn btn-secundario btn-compacto" data-acao-cardapio="remover-foto" data-chave-item="${esc(chaveItem)}">Remover foto</button>`
    : '';

  const receitaAtiva = receitaDe(item).filter((r) => estado.mapaEstoque.has(r.insumo));
  const blocoEstoqueHtml = ehNovo
    ? ''
    : `<div class="bloco-extra-item bloco-estoque-item">
        <span class="subtitulo-bloco">Estoque</span>
        ${receitaAtiva.length
          ? `<ul class="receita-item">${receitaAtiva.map((r) => {
            const ins = estado.mapaEstoque.get(r.insumo);
            return `<li><span>Cada venda tira <strong>${esc(formatarQtd(r.qtd, ins.unidade))}</strong> de <strong>${esc(ins.nome)}</strong> <small>(tem ${esc(formatarQtd(ins.qtd, ins.unidade))})</small></span>
              <button type="button" class="link-acao" data-acao-cardapio="editar-insumo" data-insumo="${esc(r.insumo)}">Editar estoque</button></li>`;
          }).join('')}</ul>`
          : `<div class="linha-sem-estoque"><span class="texto-apoio">Este produto não baixa estoque.</span>
              <button type="button" class="btn btn-secundario btn-compacto" data-acao-cardapio="controlar-estoque" data-id="${esc(item.id)}">Controlar estoque deste item</button></div>`}
      </div>`;

  const btnExcluirItemHtml = !ehNovo
    ? `<button type="button" class="btn btn-perigo" data-acao-cardapio="excluir-item" data-id="${esc(item.id)}">Excluir</button>`
    : '';

  return `<form class="editor-item" data-form-item="${esc(chaveItem)}" data-cat-id="${esc(catId)}" data-eh-novo="${ehNovo ? '1' : '0'}">
    <div class="grade-campos-4">
      <div class="campo">
        <label>Nome do item</label>
        <input type="text" data-campo="nome" value="${esc(item.nome || '')}" required placeholder="Ex.: Caipirinha">
      </div>
      <div class="campo">
        <label>Grupo / Subtítulo</label>
        <input type="text" data-campo="grupo" value="${esc(item.grupo || '')}" placeholder="Ex.: Autorais, Litrão, 600 ml">
      </div>
      <div class="campo">
        <label>Preço (R$)</label>
        <input type="number" data-campo="preco" step="0.01" min="0" value="${esc(item.preco ?? 0)}" required>
      </div>
      <div class="campo">
        <label>Ordem</label>
        <input type="number" data-campo="ordem" step="1" value="${esc(item.ordem ?? 1)}" required>
      </div>
      <div class="campo campo-largo">
        <label>Descrição</label>
        <input type="text" data-campo="desc" value="${esc(item.desc || '')}" placeholder="Ingredientes, peso ou observações do item">
      </div>
    </div>

    <div class="switches-item">
      <label class="switch-padrao">
        <input type="checkbox" data-campo="ativo" ${item.ativo !== false ? 'checked' : ''}>
        <span class="trilho-switch"></span>
        <span>Ativo (aparece no cardápio)</span>
      </label>

      <label class="switch-padrao switch-esgotado">
        <input type="checkbox" data-campo="esgotado" ${item.esgotado ? 'checked' : ''}>
        <span class="trilho-switch"></span>
        <span>Esgotado</span>
      </label>

      <label class="switch-padrao">
        <input type="checkbox" data-campo="destaque" ${item.destaque ? 'checked' : ''}>
        <span class="trilho-switch"></span>
        <span>Destaque</span>
      </label>
    </div>

    ${blocoEstoqueHtml}

    ${blocoCoresCopoHtml}

    <div class="bloco-extra-item">
      <label class="subtitulo-bloco">Foto do item (máx. 640 px · JPEG 0.8 · até 300 KB)</label>
      <div class="linha-foto-editor">
        ${previewFotoHtml}
        <input type="file" accept="image/*" data-upload-foto="${esc(chaveItem)}">
        ${btnRemoverFotoHtml}
      </div>
    </div>

    <div class="acoes-formulario">
      <button type="submit" class="btn btn-principal">${ehNovo ? 'Criar item' : 'Salvar item'}</button>
      <button type="button" class="btn btn-secundario" data-acao-cardapio="fechar-item" data-chave-item="${esc(chaveItem)}" data-cat-id="${esc(catId)}">Cancelar</button>
      ${btnExcluirItemHtml}
    </div>
  </form>`;
}

// Selo de estoque do produto na lista: "24 em estoque" (unidade) ou "dá p/ 8" (receita por peso)
function htmlChipEstoque(it) {
  const n = porcoesPossiveis(it, estado.mapaEstoque);
  if (n === null) return '';
  const receita = receitaDe(it).filter((r) => estado.mapaEstoque.has(r.insumo));
  const sits = receita.map((r) => situacaoInsumo(estado.mapaEstoque.get(r.insumo)));
  const sit = n === 0 || sits.includes('zerado') ? 'zerado' : sits.includes('baixo') ? 'baixo' : 'ok';
  const primeiro = estado.mapaEstoque.get(receita[0].insumo);
  const umPraUm = receita.length === 1 && primeiro.unidade === 'un' && Number(receita[0].qtd) === 1;
  return `<button type="button" class="chip-estoque chip-estoque--${sit}" data-acao-cardapio="ver-estoque" data-insumo="${esc(receita[0].insumo)}" title="Ver no estoque">${umPraUm ? `${n} em estoque` : `dá p/ ${n}`}</button>`;
}

// Estoque mudou (venda, entrada): só troca os selos, sem redesenhar a lista nem fechar formulário
function atualizarChipsEstoqueCardapio() {
  containerCategorias.querySelectorAll('[data-chip-estoque]').forEach((el) => {
    const it = estado.mapaItens.get(el.getAttribute('data-chip-estoque'));
    if (it) el.innerHTML = htmlChipEstoque(it);
  });
}

// Busca e atalhos de categoria
const buscaCardapioInput = document.getElementById('busca-cardapio');
const atalhosCategorias = document.getElementById('atalhos-categorias');
function aplicarBuscaCardapio() {
  const termo = normalizar(estado.buscaCardapio);
  let algum = false;
  containerCategorias.querySelectorAll('[data-cat-secao]').forEach((sec) => {
    let visiveis = 0;
    sec.querySelectorAll('.item-cardapio[data-busca]').forEach((linha) => {
      const mostra = !termo || linha.getAttribute('data-busca').includes(termo);
      linha.hidden = !mostra;
      if (mostra) visiveis++;
    });
    sec.hidden = Boolean(termo) && visiveis === 0;
    if (visiveis) algum = true;
  });
  document.getElementById('cardapio-sem-resultado').hidden = !termo || algum;
}
buscaCardapioInput.addEventListener('input', () => {
  estado.buscaCardapio = buscaCardapioInput.value;
  aplicarBuscaCardapio();
});
atalhosCategorias.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ir-cat]');
  if (!b) return;
  if (estado.buscaCardapio) { estado.buscaCardapio = ''; buscaCardapioInput.value = ''; aplicarBuscaCardapio(); }
  document.getElementById(`cat-${b.getAttribute('data-ir-cat')}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});

function guardarFormulariosAbertos() {
  const guardado = new Map();
  containerCategorias.querySelectorAll('form[data-form-item], form[data-form-categoria]').forEach((f) => {
    const chave = f.getAttribute('data-form-item') || `cat:${f.getAttribute('data-form-categoria')}`;
    const campos = {};
    f.querySelectorAll('[data-campo], [data-cat-campo]').forEach((el) => {
      const nome = el.getAttribute('data-campo') || el.getAttribute('data-cat-campo');
      if (el.type === 'file') return;
      campos[nome] = el.type === 'checkbox' ? el.checked : el.value;
    });
    const ativo = f.contains(document.activeElement) ? (document.activeElement.getAttribute('data-campo') || document.activeElement.getAttribute('data-cat-campo')) : null;
    guardado.set(chave, { campos, ativo });
  });
  return guardado;
}
function restaurarFormulariosAbertos(guardado) {
  for (const [chave, { campos, ativo }] of guardado) {
    const f = chave.startsWith('cat:')
      ? containerCategorias.querySelector(`form[data-form-categoria="${CSS.escape(chave.slice(4))}"]`)
      : containerCategorias.querySelector(`form[data-form-item="${CSS.escape(chave)}"]`);
    if (!f) continue;
    for (const [nome, valor] of Object.entries(campos)) {
      const el = f.querySelector(`[data-campo="${nome}"], [data-cat-campo="${nome}"]`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = valor; else el.value = valor;
    }
    if (ativo) f.querySelector(`[data-campo="${ativo}"], [data-cat-campo="${ativo}"]`)?.focus();
  }
}

function renderizarCardapio() {
  if (!containerCategorias) return;
  const guardado = guardarFormulariosAbertos();

  const htmlCategorias = estado.categorias
    .map((cat) => {
      const itensDaCat = estado.itens
        .filter((it) => it.categoria === cat.id)
        .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));

      const catAberta = estado.categoriasAbertasEdicao.has(cat.id);
      const novoItemAberto = estado.novoItemAbertoPorCat.has(cat.id);
      const podeExcluirCat = itensDaCat.length === 0;

      const editorCatHtml = catAberta
        ? `<form class="editor-categoria" data-form-categoria="${esc(cat.id)}">
            <div class="grade-campos-3">
              <div class="campo">
                <label>Nome da categoria</label>
                <input type="text" data-cat-campo="nome" value="${esc(cat.nome || '')}" required>
              </div>
              <div class="campo">
                <label>Cor</label>
                <div class="linha-cor">
                  <input type="color" data-cat-campo="cor" value="${esc(cat.cor || '#F28BAA')}">
                  <span class="codigo-hex">${esc(cat.cor || '#F28BAA')}</span>
                </div>
              </div>
              <div class="campo">
                <label>Ordem</label>
                <input type="number" data-cat-campo="ordem" step="1" value="${esc(cat.ordem ?? 1)}" required>
              </div>
            </div>
            <div class="acoes-formulario">
              <button type="submit" class="btn btn-principal">Salvar categoria</button>
              <button type="button" class="btn btn-secundario" data-acao-cardapio="toggle-edicao-cat" data-cat-id="${esc(cat.id)}">Fechar</button>
              <button type="button" class="btn btn-perigo" data-acao-cardapio="excluir-cat" data-cat-id="${esc(cat.id)}" ${podeExcluirCat ? '' : 'disabled title="Remova os itens desta categoria antes de excluí-la"'}>
                ${podeExcluirCat ? 'Excluir categoria' : `Possui ${itensDaCat.length} itens`}
              </button>
            </div>
          </form>`
        : '';

      const proxOrdemItem =
        estado.itens.reduce((m, x) => Math.max(m, Number(x.ordem || 0)), 0) + 1;

      const novoItemHtml = novoItemAberto
        ? montarFormularioItemHtml(
            {
              categoria: cat.id,
              grupo: '',
              nome: '',
              desc: '',
              preco: 15,
              ordem: proxOrdemItem,
              ativo: true,
              esgotado: false,
              destaque: false,
            },
            cat.id,
            true
          )
        : '';

      const listaItensHtml =
        itensDaCat.length === 0
          ? `<div class="estado-vazio">Nenhum item cadastrado nesta categoria.</div>`
          : itensDaCat
              .map((it, idx) => {
                const aberto = estado.itensAbertosEdicao.has(it.id);
                const miniaturaHtml = it.foto
                  ? `<img src="${esc(it.foto)}" alt="${esc(it.nome)}" class="miniatura-item">`
                  : cat.id === 'drinks' && Array.isArray(it.cor) && it.cor.length === 2
                  ? `<div class="amostra-copo" title="Cores do copo">
                      <span style="background-color:${esc(it.cor[1])}"></span>
                      <span style="background-color:${esc(it.cor[0])}"></span>
                    </div>`
                  : '';

                const seloDestaque = it.destaque
                  ? `<span class="selo">Destaque</span>`
                  : '';
                const seloInativo =
                  it.ativo === false
                    ? `<span class="selo selo-status-cancelado">Oculto</span>`
                    : '';

                const textoBusca = normalizar(`${it.nome} ${it.grupo || ''} ${it.desc || ''}`);
                return `<div class="item-cardapio ${it.ativo === false ? 'inativo' : ''} ${it.esgotado ? 'esgotado' : ''}" data-busca="${esc(textoBusca)}">
                  <div class="linha-item-cardapio">
                    <div class="esquerda-item">
                      <div class="botoes-ordem-item">
                        <button type="button" class="btn-ordem" data-acao-cardapio="subir-item" data-id="${esc(it.id)}" data-cat-id="${esc(cat.id)}" ${idx === 0 ? 'disabled' : ''} title="Subir ordem" aria-label="Subir item">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polyline points="18 15 12 9 6 15"/>
                          </svg>
                        </button>
                        <button type="button" class="btn-ordem" data-acao-cardapio="descer-item" data-id="${esc(it.id)}" data-cat-id="${esc(cat.id)}" ${idx === itensDaCat.length - 1 ? 'disabled' : ''} title="Descer ordem" aria-label="Descer item">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9"/>
                          </svg>
                        </button>
                      </div>
                      ${miniaturaHtml}
                      <div class="info-item-cardapio">
                        <div class="linha-nome-item">
                          <span class="nome-item-lista">${esc(it.nome)}</span>
                          ${it.grupo ? `<span class="grupo-item-lista">· ${esc(it.grupo)}</span>` : ''}
                          ${seloDestaque}
                          ${seloInativo}
                        </div>
                        ${it.desc ? `<span class="desc-item-lista">${esc(it.desc)}</span>` : ''}
                      </div>
                    </div>

                    <span class="preco-item-lista">${esc(brl(it.preco))}</span>
                    <div class="direita-item">
                      <label class="switch-padrao switch-esgotado" title="${it.esgotadoAuto ? 'Acabou o estoque. Volta sozinho quando repor.' : 'Marcar como esgotado'}">
                        <input type="checkbox" data-toggle-esgotado="${esc(it.id)}" ${it.esgotado ? 'checked' : ''}>
                        <span class="trilho-switch"></span>
                        <span class="rotulo-disponivel">${it.esgotado ? (it.esgotadoAuto ? 'Esgotado (estoque)' : 'Esgotado') : 'Disponível'}</span>
                      </label>
                      <span class="lugar-chip-estoque" data-chip-estoque="${esc(it.id)}">${htmlChipEstoque(it)}</span>
                      <button type="button" class="btn btn-secundario btn-compacto" data-acao-cardapio="toggle-edicao-item" data-id="${esc(it.id)}">
                        ${aberto ? 'Fechar' : 'Editar'}
                      </button>
                    </div>
                  </div>
                  ${aberto ? montarFormularioItemHtml(it, cat.id, false) : ''}
                </div>`;
              })
              .join('');

      return `<section class="bloco-categoria" id="cat-${esc(cat.id)}" data-cat-secao="${esc(cat.id)}">
        <header class="cabecalho-categoria">
          <div class="titulo-categoria-linha">
            <span class="faixa-cor-categoria" style="background-color:${esc(cat.cor || '#F28BAA')}"></span>
            <h2>${esc(cat.nome)}</h2>
            <span class="ordem-badge">Ordem ${esc(cat.ordem)} · ${itensDaCat.length} itens</span>
          </div>
          <div class="acoes-categoria">
            <button type="button" class="btn btn-secundario btn-compacto" data-acao-cardapio="toggle-edicao-cat" data-cat-id="${esc(cat.id)}">
              Editar categoria
            </button>
            <button type="button" class="btn btn-principal btn-compacto" data-acao-cardapio="abrir-novo-item" data-cat-id="${esc(cat.id)}">
              Novo item
            </button>
          </div>
        </header>
        ${editorCatHtml}
        ${novoItemHtml}
        <div class="lista-itens-categoria">${listaItensHtml}</div>
      </section>`;
    })
    .join('');

  containerCategorias.innerHTML = htmlCategorias;
  restaurarFormulariosAbertos(guardado);

  atalhosCategorias.innerHTML = estado.categorias.map((c) => {
    const n = estado.itens.filter((it) => it.categoria === c.id).length;
    return `<button type="button" class="atalho-categoria" data-ir-cat="${esc(c.id)}" style="--c:${esc(c.cor || '#F28BAA')}"><i aria-hidden="true"></i>${esc(c.nome)}<b>${n}</b></button>`;
  }).join('');
  aplicarBuscaCardapio();
}

// Interruptor rápido de esgotado na lista
containerCategorias.addEventListener('change', async (e) => {
  const chkEsgotado = e.target.closest('[data-toggle-esgotado]');
  if (chkEsgotado) {
    const id = chkEsgotado.getAttribute('data-toggle-esgotado');
    const esgotado = chkEsgotado.checked;
    const it = estado.mapaItens.get(id);
    const rotulo = chkEsgotado.closest('label')?.querySelector('.rotulo-disponivel');
    if (rotulo) rotulo.textContent = esgotado ? 'Esgotado' : 'Disponível';
    try {
      await updateDoc(doc(db, 'itens', id), { esgotado, esgotadoAuto: deleteField() });
      const n = it ? porcoesPossiveis(it, estado.mapaEstoque) : null;
      if (!esgotado && n === 0) {
        mostrarToast(`${it.nome} voltou ao cardápio, mas o estoque diz que acabou. Faça uma contagem em Estoque.`, 'erro');
      } else {
        mostrarToast(esgotado ? 'Item marcado como esgotado.' : 'Item disponível novamente.');
      }
    } catch {
      chkEsgotado.checked = !esgotado;
      mostrarToast('Erro ao atualizar disponibilidade do item.', 'erro');
    }
    return;
  }

  // Upload de foto em canvas
  const inputFoto = e.target.closest('[data-upload-foto]');
  if (inputFoto && inputFoto.files && inputFoto.files[0]) {
    const chaveItem = inputFoto.getAttribute('data-upload-foto');
    try {
      const dataUrl = await comprimirImagemParaDataURL(inputFoto.files[0]);
      estado.fotosTemporarias.set(chaveItem, dataUrl);
      renderizarCardapio();
      mostrarToast('Foto pronta. Clique em Salvar item para gravar.', 'sucesso');
    } catch (err) {
      inputFoto.value = '';
      mostrarToast(err?.message || 'Erro ao processar foto.', 'erro');
    }
    return;
  }

  // Atualiza código hex ao escolher cor
  if (e.target.type === 'color') {
    const hexSpan = e.target.parentElement?.querySelector('.codigo-hex');
    if (hexSpan) hexSpan.textContent = e.target.value.toUpperCase();
  }
});

// Clique nos botões da tela de Cardápio
containerCategorias.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-acao-cardapio]');
  if (!btn) return;
  const acao = btn.getAttribute('data-acao-cardapio');

  if (acao === 'toggle-edicao-cat') {
    const catId = btn.getAttribute('data-cat-id');
    if (estado.categoriasAbertasEdicao.has(catId)) {
      estado.categoriasAbertasEdicao.delete(catId);
    } else {
      estado.categoriasAbertasEdicao.add(catId);
    }
    renderizarCardapio();
  } else if (acao === 'excluir-cat') {
    const catId = btn.getAttribute('data-cat-id');
    const temItens = estado.itens.some((it) => it.categoria === catId);
    if (temItens) {
      mostrarToast('Não é possível excluir uma categoria que ainda possui itens.', 'erro');
      return;
    }
    const cat = estado.categorias.find((c) => c.id === catId);
    const ok = await confirmarAcao({
      titulo: 'Excluir categoria',
      mensagem: `Confirma a exclusão da categoria "${cat?.nome || catId}"?`,
      textoConfirmar: 'Excluir categoria',
    });
    if (ok) {
      try {
        await deleteDoc(doc(db, 'categorias', catId));
        estado.categoriasAbertasEdicao.delete(catId);
        mostrarToast('Categoria excluída.', 'sucesso');
      } catch {
        mostrarToast('Erro ao excluir categoria.', 'erro');
      }
    }
  } else if (acao === 'abrir-novo-item') {
    const catId = btn.getAttribute('data-cat-id');
    estado.novoItemAbertoPorCat.add(catId);
    renderizarCardapio();
  } else if (acao === 'toggle-edicao-item') {
    const id = btn.getAttribute('data-id');
    if (estado.itensAbertosEdicao.has(id)) {
      estado.itensAbertosEdicao.delete(id);
      estado.fotosTemporarias.delete(id);
    } else {
      estado.itensAbertosEdicao.add(id);
    }
    renderizarCardapio();
  } else if (acao === 'fechar-item') {
    const chave = btn.getAttribute('data-chave-item');
    const catId = btn.getAttribute('data-cat-id');
    estado.itensAbertosEdicao.delete(chave);
    estado.novoItemAbertoPorCat.delete(catId);
    estado.fotosTemporarias.delete(chave);
    renderizarCardapio();
  } else if (acao === 'remover-foto') {
    const chave = btn.getAttribute('data-chave-item');
    estado.fotosTemporarias.set(chave, '');
    renderizarCardapio();
  } else if (acao === 'excluir-item') {
    const id = btn.getAttribute('data-id');
    const item = estado.mapaItens.get(id);
    const ok = await confirmarAcao({
      titulo: 'Excluir item',
      mensagem: `Deseja realmente excluir "${item?.nome || id}" do cardápio?`,
      textoConfirmar: 'Excluir item',
    });
    if (ok) {
      try {
        await deleteDoc(doc(db, 'itens', id));
        estado.itensAbertosEdicao.delete(id);
        estado.fotosTemporarias.delete(id);
        mostrarToast('Item excluído do cardápio.', 'sucesso');
      } catch {
        mostrarToast('Erro ao excluir item.', 'erro');
      }
    }
  } else if (acao === 'ver-estoque') {
    const ins = estado.mapaEstoque.get(btn.getAttribute('data-insumo'));
    estado.filtroEstoque = 'todos';
    estado.buscaEstoque = ins?.nome || '';
    buscaEstoqueInput.value = estado.buscaEstoque;
    navegarParaTela('estoque');
  } else if (acao === 'editar-insumo') {
    abrirModalInsumo(btn.getAttribute('data-insumo'));
  } else if (acao === 'controlar-estoque') {
    const it = estado.mapaItens.get(btn.getAttribute('data-id'));
    if (it) abrirModalInsumo(null, { nome: nomeParaEstoque(it), unidade: 'un', usos: [{ itemId: it.id, qtd: 1 }] });
  } else if (acao === 'subir-item' || acao === 'descer-item') {
    const id = btn.getAttribute('data-id');
    const catId = btn.getAttribute('data-cat-id');
    const itensCat = estado.itens
      .filter((it) => it.categoria === catId)
      .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));
    const idx = itensCat.findIndex((it) => it.id === id);
    const idxAlvo = acao === 'subir-item' ? idx - 1 : idx + 1;
    if (idx < 0 || idxAlvo < 0 || idxAlvo >= itensCat.length) return;

    const atual = itensCat[idx];
    const vizinho = itensCat[idxAlvo];
    let ordemAtual = Number(atual.ordem || idx + 1);
    let ordemVizinho = Number(vizinho.ordem || idxAlvo + 1);
    if (ordemAtual === ordemVizinho) {
      ordemAtual = idx + 1;
      ordemVizinho = idxAlvo + 1;
    }

    try {
      const lote = writeBatch(db);
      lote.update(doc(db, 'itens', atual.id), { ordem: ordemVizinho });
      lote.update(doc(db, 'itens', vizinho.id), { ordem: ordemAtual });
      await lote.commit();
      mostrarToast('Ordem atualizada.');
    } catch {
      mostrarToast('Erro ao reordenar itens.', 'erro');
    }
  }
});

// Submissão dos formulários de Categoria e Item
containerCategorias.addEventListener('submit', async (e) => {
  const formCat = e.target.closest('[data-form-categoria]');
  if (formCat) {
    e.preventDefault();
    const catId = formCat.getAttribute('data-form-categoria');
    const nome = formCat.querySelector('[data-cat-campo="nome"]').value.trim();
    const cor = formCat.querySelector('[data-cat-campo="cor"]').value;
    const ordem = Number(formCat.querySelector('[data-cat-campo="ordem"]').value || 1);
    if (!nome) {
      mostrarToast('Informe o nome da categoria.', 'erro');
      return;
    }
    try {
      await setDoc(doc(db, 'categorias', catId), { nome, cor, ordem }, { merge: true });
      estado.categoriasAbertasEdicao.delete(catId);
      mostrarToast('Categoria salva.', 'sucesso');
    } catch {
      mostrarToast('Erro ao salvar categoria.', 'erro');
    }
    return;
  }

  const formItem = e.target.closest('[data-form-item]');
  if (formItem) {
    e.preventDefault();
    const chaveItem = formItem.getAttribute('data-form-item');
    const catId = formItem.getAttribute('data-cat-id');
    const ehNovo = formItem.getAttribute('data-eh-novo') === '1';

    const nome = formItem.querySelector('[data-campo="nome"]').value.trim();
    const grupo = formItem.querySelector('[data-campo="grupo"]').value.trim();
    const preco = Number(formItem.querySelector('[data-campo="preco"]').value || 0);
    const ordem = Number(formItem.querySelector('[data-campo="ordem"]').value || 1);
    const desc = formItem.querySelector('[data-campo="desc"]').value.trim();
    const ativo = formItem.querySelector('[data-campo="ativo"]').checked;
    const esgotado = formItem.querySelector('[data-campo="esgotado"]').checked;
    const destaque = formItem.querySelector('[data-campo="destaque"]').checked;

    if (!nome) {
      mostrarToast('Informe o nome do item.', 'erro');
      return;
    }

    const payload = {
      categoria: catId,
      grupo,
      nome,
      desc,
      preco,
      ordem,
      ativo,
      esgotado,
      destaque,
    };

    const anterior = ehNovo ? null : estado.mapaItens.get(chaveItem);
    if (anterior && Boolean(anterior.esgotado) !== esgotado) payload.esgotadoAuto = deleteField();

    if (catId === 'drinks') {
      const usarCor = formItem.querySelector('[data-campo="usarCorCopo"]')?.checked;
      if (usarCor) {
        const corBase = formItem.querySelector('[data-campo="corBase"]').value;
        const corTopo = formItem.querySelector('[data-campo="corTopo"]').value;
        payload.cor = [corBase, corTopo];
      } else if (!ehNovo) {
        payload.cor = deleteField();
      }
    }

    if (estado.fotosTemporarias.has(chaveItem)) {
      const novaFoto = estado.fotosTemporarias.get(chaveItem);
      if (novaFoto) {
        payload.foto = novaFoto;
      } else if (!ehNovo) {
        payload.foto = deleteField();
      }
    }

    let idItem = chaveItem;
    if (ehNovo) {
      idItem = gerarSlugId(`${catId}-${grupo}-${nome}`);
      if (!idItem || estado.mapaItens.has(idItem)) {
        idItem = `${idItem || 'item'}-${Date.now().toString(36).slice(-4)}`;
      }
    }

    try {
      await setDoc(doc(db, 'itens', idItem), payload, { merge: true });
      estado.fotosTemporarias.delete(chaveItem);
      estado.itensAbertosEdicao.delete(chaveItem);
      estado.novoItemAbertoPorCat.delete(catId);
      mostrarToast(ehNovo ? 'Item adicionado ao cardápio.' : 'Item salvo.', 'sucesso');
    } catch {
      mostrarToast('Erro ao salvar item.', 'erro');
    }
  }
});

// ─── 3.2. TELA DE ESTOQUE ───
// Cada item de estoque guarda a quantidade em un, g ou ml. Os produtos do cardápio dizem quanto
// gastam de cada um (receita). A tela mostra primeiro o que acabou e o que está acabando.
const listaEstoque = document.getElementById('lista-estoque');
const buscaEstoqueInput = document.getElementById('busca-estoque');
const normalizar = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const ORDEM_SIT = { zerado: 0, baixo: 1, ok: 2 };
const ROTULO_SIT = { zerado: 'Acabou', baixo: 'Acabando', ok: 'Ok' };
const ICONE_EDITAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

const nomeProduto = (it) => (it.grupo && it.grupo !== it.nome ? `${it.nome} (${it.grupo})` : it.nome);
// Nome curto para o estoque: "Coca-Cola", e "Brahma (600 ml)" só quando existe outra Brahma
function nomeParaEstoque(it) {
  const repetido = estado.itens.some((x) => x.id !== it.id && normalizar(x.nome) === normalizar(it.nome));
  const grupo = String(it.grupo || '').replace(/\s*·\s*R\$.*$/, '').trim();
  return repetido && grupo ? `${it.nome} (${grupo})` : it.nome;
}

function usosDoInsumo(insumoId) {
  const usos = [];
  for (const it of estado.itens) {
    for (const r of receitaDe(it)) if (r.insumo === insumoId) usos.push({ item: it, qtd: Number(r.qtd) });
  }
  return usos;
}

function idUnico(base, existe) {
  let id = gerarSlugId(base) || 'estoque';
  if (existe(id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;
  while (existe(id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
  return id;
}

function atualizarSeloEstoque() {
  const n = estado.estoque.filter((x) => situacaoInsumo(x) !== 'ok').length;
  for (const id of ['badge-menu-estoque', 'badge-mobile-estoque']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = n === 0;
    el.textContent = String(n);
  }
}

function renderizarEstoque() {
  atualizarSeloEstoque();
  if (!listaEstoque || document.getElementById('tela-estoque').hidden) return;

  const cont = { todos: estado.estoque.length, zerado: 0, baixo: 0, ok: 0 };
  for (const x of estado.estoque) cont[situacaoInsumo(x)]++;
  for (const k of Object.keys(cont)) document.getElementById(`est-n-${k}`).textContent = String(cont[k]);
  document.querySelectorAll('[data-filtro-estoque]').forEach((b) => {
    b.classList.toggle('ativo', b.getAttribute('data-filtro-estoque') === estado.filtroEstoque);
  });

  const busca = normalizar(estado.buscaEstoque);
  const lista = estado.estoque
    .filter((x) => estado.filtroEstoque === 'todos' || situacaoInsumo(x) === estado.filtroEstoque)
    .filter((x) => !busca || normalizar(x.nome).includes(busca) ||
      usosDoInsumo(x.id).some((u) => normalizar(nomeProduto(u.item)).includes(busca)))
    .sort((a, b) => ORDEM_SIT[situacaoInsumo(a)] - ORDEM_SIT[situacaoInsumo(b)] ||
      String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));

  if (!estado.estoque.length) {
    listaEstoque.innerHTML = `<div class="vazio-estoque">
      <h2>Comece pelo que se conta por unidade</h2>
      <p>Toque em <strong>Contar bebidas do cardápio</strong>: cada cerveja, refri e long neck ganha um estoque próprio. Vendeu 1, sai 1.</p>
      <p>Para o que se gasta por peso ou volume (batata, carne, gelo, xarope), use <strong>Novo item de estoque</strong> e diga quanto cada prato gasta. Ex.: Batata frita M gasta 300 g.</p>
    </div>`;
  } else if (!lista.length) {
    listaEstoque.innerHTML = '<div class="estado-vazio">Nada aqui com esse filtro.</div>';
  } else {
    listaEstoque.innerHTML = lista.map(htmlInsumo).join('');
  }

  const semControle = estado.itens.filter((it) => it.ativo !== false &&
    !receitaDe(it).some((r) => estado.mapaEstoque.has(r.insumo))).length;
  document.getElementById('estoque-sem-controle').textContent = estado.estoque.length && semControle
    ? `${semControle} ${semControle === 1 ? 'produto do cardápio ainda não desconta' : 'produtos do cardápio ainda não descontam'} estoque.`
    : '';
}

function htmlInsumo(ins) {
  const sit = situacaoInsumo(ins);
  const usos = usosDoInsumo(ins.id);
  const umPraUm = usos.length === 1 && usos[0].qtd === 1 && ins.unidade === 'un';
  const usosHtml = umPraUm
    ? `<li class="uso-simples">Vendeu 1 ${esc(nomeParaEstoque(usos[0].item))}, sai 1</li>`
    : usos.length
    ? usos.map(({ item, qtd }) => {
      const n = Math.max(0, Math.floor(Number(ins.qtd || 0) / qtd));
      return `<li><span>${esc(nomeProduto(item))}</span><small>${esc(formatarQtd(qtd, ins.unidade))} cada · dá ${n}</small></li>`;
    }).join('')
    : `<li class="sem-uso">Não está ligado a nenhum produto, então não baixa sozinho. <button type="button" class="link-acao" data-acao-estoque="editar" data-id="${esc(ins.id)}">Ligar produto</button></li>`;
  return `<article class="linha-insumo" data-situacao="${sit}">
    <div class="linha-insumo__info">
      <div class="linha-insumo__topo">
        <h3>${esc(ins.nome)}</h3>
        <span class="selo-sit selo-sit--${sit}">${ROTULO_SIT[sit]}</span>
      </div>
      <ul class="usos-insumo">${usosHtml}</ul>
    </div>
    <div class="linha-insumo__qtd">
      <strong>${esc(formatarQtd(ins.qtd, ins.unidade))}</strong>
      <small>${Number(ins.minimo) > 0 ? `aviso em ${esc(formatarQtd(ins.minimo, ins.unidade))}` : 'sem aviso'}</small>
    </div>
    <div class="linha-insumo__acoes">
      <button type="button" class="btn btn-principal btn-compacto" data-acao-estoque="entrada" data-id="${esc(ins.id)}">+ Entrada</button>
      <button type="button" class="btn btn-secundario btn-compacto" data-acao-estoque="contagem" data-id="${esc(ins.id)}">Contagem</button>
      <button type="button" class="btn btn-secundario btn-compacto btn-icone" data-acao-estoque="editar" data-id="${esc(ins.id)}" aria-label="Editar ${esc(ins.nome)}" title="Editar e ligar produtos">${ICONE_EDITAR}</button>
    </div>
  </article>`;
}

document.querySelectorAll('[data-filtro-estoque]').forEach((b) => {
  b.addEventListener('click', () => {
    estado.filtroEstoque = b.getAttribute('data-filtro-estoque');
    renderizarEstoque();
  });
});
buscaEstoqueInput.addEventListener('input', () => {
  estado.buscaEstoque = buscaEstoqueInput.value;
  renderizarEstoque();
});
listaEstoque.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-acao-estoque]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const acao = btn.getAttribute('data-acao-estoque');
  if (acao === 'entrada' || acao === 'contagem') abrirModalQtd(id, acao);
  else if (acao === 'editar') abrirModalInsumo(id);
});
document.getElementById('btn-estoque-novo').addEventListener('click', () => abrirModalInsumo());
document.getElementById('btn-estoque-importar').addEventListener('click', abrirImportar);

// Abre/fecha modais próprios (Esc e clique fora fecham)
function abrirModal(el, foco) {
  el.hidden = false;
  document.body.classList.add('com-modal');
  if (foco) setTimeout(() => foco.focus(), 30);
}
function fecharModal(el) {
  el.hidden = true;
  if (!document.querySelector('.sobreposicao-modal:not([hidden])')) document.body.classList.remove('com-modal');
}
for (const id of ['modal-estoque-qtd', 'modal-insumo', 'modal-importar']) {
  const el = document.getElementById(id);
  el.addEventListener('click', (e) => { if (e.target === el) fecharModal(el); });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !modalConfirmacao.hidden) return;
  for (const id of ['modal-estoque-qtd', 'modal-insumo', 'modal-importar']) {
    const el = document.getElementById(id);
    if (!el.hidden) { fecharModal(el); break; }
  }
});

// Botões de unidade (kg | g) dentro dos modais
function htmlSeletorUnidade(unidades, atual) {
  return unidades.map((u) => `<button type="button" class="seletor-unidade__op ${u === atual ? 'ativo' : ''}" data-un="${u}" aria-pressed="${u === atual}">${u}</button>`).join('');
}
// valor na unidade-base → número para mostrar na unidade escolhida
const naUnidade = (base, un) => (un === 'kg' || un === 'L' ? base / 1000 : base);
const arred = (v) => Math.round(Number(v) * 1000) / 1000;

// ── Entrada (chegou mercadoria) e Contagem (conferir a prateleira) ──
const modalQtd = document.getElementById('modal-estoque-qtd');
const formQtd = document.getElementById('form-estoque-qtd');
const eqValor = document.getElementById('eq-valor');
let ctxQtd = null;

function abrirModalQtd(id, modo) {
  const ins = estado.mapaEstoque.get(id);
  if (!ins) return;
  const unidades = unidadesDeEntrada(ins.unidade);
  ctxQtd = { id, modo, un: unidades[0] };
  const entrada = modo === 'entrada';
  document.getElementById('eq-titulo').textContent = `${entrada ? 'Entrada' : 'Contagem'} · ${ins.nome}`;
  document.getElementById('eq-agora').innerHTML = `Tem agora: <strong>${esc(formatarQtd(ins.qtd, ins.unidade))}</strong>`;
  document.getElementById('eq-rotulo').textContent = entrada ? 'Quanto chegou?' : 'Quanto tem agora na prateleira?';
  document.getElementById('eq-confirmar').textContent = entrada ? 'Somar ao estoque' : 'Salvar contagem';
  const atalhos = document.getElementById('eq-atalhos');
  atalhos.hidden = !entrada;
  atalhos.innerHTML = entrada
    ? atalhosDeEntrada(ins.unidade).map((v) => `<button type="button" class="atalho-entrada" data-somar="${v}">+${esc(formatarQtd(v, ins.unidade))}</button>`).join('')
    : '';
  document.getElementById('eq-unidades').innerHTML = htmlSeletorUnidade(unidades, ctxQtd.un);
  eqValor.value = '';
  atualizarResultadoQtd();
  abrirModal(modalQtd, eqValor);
}

function atualizarResultadoQtd() {
  const ins = ctxQtd && estado.mapaEstoque.get(ctxQtd.id);
  const out = document.getElementById('eq-resultado');
  if (!ins) return;
  const v = paraBase(eqValor.value, ctxQtd.un);
  if (eqValor.value === '' || !Number.isFinite(v)) { out.textContent = ''; return; }
  const atual = Number(ins.qtd || 0);
  if (ctxQtd.modo === 'entrada') {
    out.innerHTML = `Vai ficar: <strong>${esc(formatarQtd(atual + v, ins.unidade))}</strong>`;
  } else {
    const dif = v - atual;
    const txtDif = dif === 0 ? 'bateu certinho' : `${dif > 0 ? 'sobrou' : 'faltou'} ${formatarQtd(Math.abs(dif), ins.unidade)}`;
    out.innerHTML = `Era ${esc(formatarQtd(atual, ins.unidade))} → fica <strong>${esc(formatarQtd(v, ins.unidade))}</strong> (${esc(txtDif)})`;
  }
}

eqValor.addEventListener('input', atualizarResultadoQtd);
document.getElementById('eq-atalhos').addEventListener('click', (e) => {
  const b = e.target.closest('[data-somar]');
  if (!b || !ctxQtd) return;
  const atualBase = paraBase(eqValor.value || 0, ctxQtd.un) || 0;
  eqValor.value = String(arred(naUnidade(atualBase + Number(b.getAttribute('data-somar')), ctxQtd.un)));
  atualizarResultadoQtd();
});
document.getElementById('eq-unidades').addEventListener('click', (e) => {
  const b = e.target.closest('[data-un]');
  if (!b || !ctxQtd) return;
  const base = paraBase(eqValor.value, ctxQtd.un);
  ctxQtd.un = b.getAttribute('data-un');
  if (eqValor.value !== '' && Number.isFinite(base)) eqValor.value = String(arred(naUnidade(base, ctxQtd.un)));
  document.getElementById('eq-unidades').innerHTML = htmlSeletorUnidade(unidadesDeEntrada(estado.mapaEstoque.get(ctxQtd.id)?.unidade), ctxQtd.un);
  atualizarResultadoQtd();
});
document.getElementById('eq-cancelar').addEventListener('click', () => fecharModal(modalQtd));

formQtd.addEventListener('submit', (e) => {
  e.preventDefault();
  const ins = ctxQtd && estado.mapaEstoque.get(ctxQtd.id);
  if (!ins) return;
  const v = paraBase(eqValor.value, ctxQtd.un);
  const entrada = ctxQtd.modo === 'entrada';
  if (eqValor.value === '' || !Number.isFinite(v) || v < 0 || (entrada && v === 0)) {
    eqValor.focus();
    eqValor.classList.add('campo-erro');
    setTimeout(() => eqValor.classList.remove('campo-erro'), 900);
    return;
  }
  const dados = entrada
    ? { qtd: increment(v), ultimaEntrada: { qtd: v, em: serverTimestamp() }, atualizadoEm: serverTimestamp() }
    : { qtd: v, ultimaContagem: { qtd: v, em: serverTimestamp() }, atualizadoEm: serverTimestamp() };
  fecharModal(modalQtd);
  // não espera o servidor: a tela já mostra o número novo (internet ruim no bar)
  updateDoc(doc(db, 'estoque', ins.id), dados).catch(() => mostrarToast(`Não salvou ${ins.nome}. Tente de novo.`, 'erro'));
  mostrarToast(entrada
    ? `+${formatarQtd(v, ins.unidade)} em ${ins.nome}.`
    : `${ins.nome}: contagem salva (${formatarQtd(v, ins.unidade)}).`, 'sucesso');
});

// ── Criar / editar item de estoque e ligar aos produtos ──
const modalInsumo = document.getElementById('modal-insumo');
const formInsumo = document.getElementById('form-insumo');
const insNome = document.getElementById('ins-nome');
const insQtd = document.getElementById('ins-qtd');
const insMin = document.getElementById('ins-min');
const insQtdUn = document.getElementById('ins-qtd-un');
const insMinUn = document.getElementById('ins-min-un');
const insUsos = document.getElementById('ins-usos');
const insSugestoes = document.getElementById('ins-sugestoes');
let ctxInsumo = null;

const unidadeInsumoForm = () => formInsumo.querySelector('input[name="ins-unidade"]:checked')?.value || 'un';

function opcoesProdutosHtml(selecionado) {
  const ordemCat = new Map(estado.categorias.map((c, i) => [c.id, Number(c.ordem ?? i)]));
  const cats = estado.categorias.slice().sort((a, b) => (ordemCat.get(a.id) ?? 0) - (ordemCat.get(b.id) ?? 0));
  return '<option value="">Escolha o produto…</option>' + cats.map((c) => {
    const itens = estado.itens.filter((it) => it.categoria === c.id);
    if (!itens.length) return '';
    return `<optgroup label="${esc(c.nome)}">${itens.map((it) =>
      `<option value="${esc(it.id)}" ${it.id === selecionado ? 'selected' : ''}>${esc(nomeProduto(it))}</option>`).join('')}</optgroup>`;
  }).join('');
}

function linhaUsoHtml(itemId, qtd) {
  const un = UNIDADES[unidadeInsumoForm()].base;
  return `<div class="linha-uso">
    <select data-uso-item aria-label="Produto">${opcoesProdutosHtml(itemId)}</select>
    <div class="linha-uso__qtd">
      <input type="number" data-uso-qtd inputmode="decimal" step="any" min="0" value="${qtd ?? ''}" placeholder="${un === 'un' ? '1' : 'quanto?'}" aria-label="Quanto gasta">
      <span class="un-uso">${esc(un)}</span>
    </div>
    <button type="button" class="btn-remover-uso" data-remover-uso aria-label="Tirar este produto" title="Tirar">×</button>
  </div>`;
}

function preencherUnidadesInsumo(qtdBase, minBase) {
  const un = unidadeInsumoForm();
  const unidades = unidadesDeEntrada(un);
  const escolher = (v) => (unidades.length > 1 && Number(v) > 0 && Number(v) < 1000 ? unidades[1] : unidades[0]);
  const uQ = escolher(qtdBase);
  const uM = escolher(minBase);
  insQtdUn.innerHTML = unidades.map((u) => `<option ${u === uQ ? 'selected' : ''}>${u}</option>`).join('');
  insMinUn.innerHTML = unidades.map((u) => `<option ${u === uM ? 'selected' : ''}>${u}</option>`).join('');
  insQtdUn.disabled = insMinUn.disabled = unidades.length === 1;
  if (qtdBase !== undefined && qtdBase !== null && qtdBase !== '') insQtd.value = String(arred(naUnidade(Number(qtdBase), uQ)));
  if (minBase !== undefined && minBase !== null && minBase !== '') insMin.value = String(arred(naUnidade(Number(minBase), uM)));
  insUsos.querySelectorAll('.un-uso').forEach((el) => { el.textContent = UNIDADES[un].base; });
}

function abrirModalInsumo(id = null, preset = {}) {
  const ins = id ? estado.mapaEstoque.get(id) : null;
  ctxInsumo = { id: ins ? id : null, qtdInicial: ins ? Number(ins.qtd || 0) : null };
  document.getElementById('ins-titulo').textContent = ins ? 'Editar item de estoque' : 'Novo item de estoque';
  document.getElementById('ins-excluir').hidden = !ins;
  insNome.value = ins?.nome || preset.nome || '';
  const un = ins?.unidade || preset.unidade || 'un';
  formInsumo.querySelectorAll('input[name="ins-unidade"]').forEach((r) => { r.checked = r.value === un; });
  insQtd.value = '';
  insMin.value = '';
  const usos = ins ? usosDoInsumo(id).map((u) => ({ itemId: u.item.id, qtd: u.qtd })) : (preset.usos || []);
  insUsos.innerHTML = usos.map((u) => linhaUsoHtml(u.itemId, u.qtd)).join('');
  preencherUnidadesInsumo(ins ? Number(ins.qtd || 0) : '', ins ? Number(ins.minimo || 0) : (un === 'un' ? 6 : ''));
  ctxInsumo.qtdMostrada = insQtd.value;
  atualizarSugestoesInsumo();
  abrirModal(modalInsumo, ins ? null : (insNome.value ? insQtd : insNome));
}

// Sugere ligar produtos com nome parecido (ex.: "Heineken long neck" → Heineken 600 ml / long neck)
function atualizarSugestoesInsumo() {
  const nome = normalizar(insNome.value);
  const jaLigados = new Set([...insUsos.querySelectorAll('[data-uso-item]')].map((s) => s.value));
  if (nome.length < 3) { insSugestoes.innerHTML = ''; return; }
  const sugestoes = estado.itens.filter((it) => {
    if (jaLigados.has(it.id)) return false;
    const n = normalizar(it.nome);
    return n.length >= 3 && (nome.includes(n) || (nome.length >= 4 && n.includes(nome)));
  }).slice(0, 6);
  insSugestoes.innerHTML = sugestoes.length
    ? `<span class="texto-apoio">Ligar também:</span>${sugestoes.map((it) => `<button type="button" class="chip-sugestao" data-sugerir="${esc(it.id)}">+ ${esc(nomeProduto(it))}</button>`).join('')}`
    : '';
}

insNome.addEventListener('input', atualizarSugestoesInsumo);
insSugestoes.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sugerir]');
  if (!b) return;
  insUsos.insertAdjacentHTML('beforeend', linhaUsoHtml(b.getAttribute('data-sugerir'), unidadeInsumoForm() === 'un' ? 1 : ''));
  atualizarSugestoesInsumo();
  if (unidadeInsumoForm() !== 'un') insUsos.querySelector('.linha-uso:last-child [data-uso-qtd]')?.focus();
});
document.getElementById('ins-add-uso').addEventListener('click', () => {
  insUsos.insertAdjacentHTML('beforeend', linhaUsoHtml('', unidadeInsumoForm() === 'un' ? 1 : ''));
  insUsos.querySelector('.linha-uso:last-child select')?.focus();
});
insUsos.addEventListener('click', (e) => {
  if (e.target.closest('[data-remover-uso]')) {
    e.target.closest('.linha-uso').remove();
    atualizarSugestoesInsumo();
  }
});
insUsos.addEventListener('change', atualizarSugestoesInsumo);
formInsumo.querySelectorAll('input[name="ins-unidade"]').forEach((r) => {
  r.addEventListener('change', () => preencherUnidadesInsumo());
});
document.getElementById('ins-cancelar').addEventListener('click', () => fecharModal(modalInsumo));

// Monta no lote as mudanças de receita: quem passou a gastar, mudou a quantidade ou deixou de gastar
function escreverReceitas(lote, insumoId, usos /* Map itemId → qtd, ou null para tirar de todos */) {
  for (const it of estado.itens) {
    const receita = receitaDe(it);
    const tem = receita.find((r) => r.insumo === insumoId);
    const quer = usos ? usos.get(it.id) : undefined;
    if (quer && (!tem || Number(tem.qtd) !== quer)) {
      lote.update(doc(db, 'itens', it.id), { receita: [...receita.filter((r) => r.insumo !== insumoId), { insumo: insumoId, qtd: quer }] });
    } else if (!quer && tem) {
      const resto = receita.filter((r) => r.insumo !== insumoId);
      lote.update(doc(db, 'itens', it.id), { receita: resto.length ? resto : deleteField() });
    }
  }
}

formInsumo.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = insNome.value.trim().replace(/\s+/g, ' ');
  if (!nome) { insNome.focus(); insNome.classList.add('campo-erro'); setTimeout(() => insNome.classList.remove('campo-erro'), 900); return; }
  const unidade = unidadeInsumoForm();
  const qtd = paraBase(insQtd.value, insQtdUn.value || unidadesDeEntrada(unidade)[0]);
  const minimo = insMin.value === '' ? 0 : paraBase(insMin.value, insMinUn.value || unidadesDeEntrada(unidade)[0]);
  // quantidade é obrigatória no item novo (0 é aceito, mas tem que ser escolha): evita esgotar tudo sem querer
  if (!ctxInsumo.id && (insQtd.value === '' || !Number.isFinite(qtd) || qtd < 0)) {
    insQtd.focus(); insQtd.classList.add('campo-erro'); setTimeout(() => insQtd.classList.remove('campo-erro'), 900);
    mostrarToast('Diga quanto tem agora (pode ser 0).', 'erro');
    return;
  }
  const usos = new Map();
  for (const linha of insUsos.querySelectorAll('.linha-uso')) {
    const itemId = linha.querySelector('[data-uso-item]').value;
    const q = paraBase(linha.querySelector('[data-uso-qtd]').value, UNIDADES[unidade].base);
    if (itemId && Number.isFinite(q) && q > 0) usos.set(itemId, q);
  }
  const id = ctxInsumo.id || idUnico(`est-${nome}`, (x) => estado.mapaEstoque.has(x));
  const dados = { nome, unidade, minimo: Number.isFinite(minimo) && minimo > 0 ? minimo : 0, atualizadoEm: serverTimestamp() };
  // na edição só grava a quantidade se ela foi mexida (não apaga vendas que entraram enquanto o modal estava aberto)
  if (!ctxInsumo.id || (insQtd.value !== ctxInsumo.qtdMostrada && Number.isFinite(qtd) && qtd >= 0)) {
    dados.qtd = qtd;
    dados.ultimaContagem = { qtd, em: serverTimestamp() };
  }
  if (!ctxInsumo.id) dados.criadoEm = serverTimestamp();

  const lote = writeBatch(db);
  lote.set(doc(db, 'estoque', id), dados, { merge: true });
  escreverReceitas(lote, id, usos);
  fecharModal(modalInsumo);
  try {
    await lote.commit();
    mostrarToast(ctxInsumo.id ? `${nome} salvo.` : `${nome} entrou no estoque${usos.size ? ` e já baixa em ${usos.size} ${usos.size === 1 ? 'produto' : 'produtos'}` : ''}.`, 'sucesso');
  } catch {
    mostrarToast(`Não foi possível salvar ${nome}.`, 'erro');
  }
});

document.getElementById('ins-excluir').addEventListener('click', async () => {
  const id = ctxInsumo?.id;
  const ins = id && estado.mapaEstoque.get(id);
  if (!ins) return;
  const usos = usosDoInsumo(id);
  const ok = await confirmarAcao({
    titulo: `Excluir ${ins.nome} do estoque`,
    mensagem: usos.length
      ? `${usos.length} ${usos.length === 1 ? 'produto deixa' : 'produtos deixam'} de baixar estoque (${usos.map((u) => nomeProduto(u.item)).slice(0, 3).join(', ')}${usos.length > 3 ? '…' : ''}). As vendas não mudam.`
      : 'O item sai do estoque. As vendas não mudam.',
    textoConfirmar: 'Excluir do estoque',
  });
  if (!ok) return;
  const lote = writeBatch(db);
  escreverReceitas(lote, id, null);
  lote.delete(doc(db, 'estoque', id));
  fecharModal(modalInsumo);
  try {
    await lote.commit();
    mostrarToast(`${ins.nome} saiu do estoque.`);
  } catch {
    mostrarToast('Não foi possível excluir.', 'erro');
  }
});

// ── Contar bebidas de uma vez: cada produto vira um estoque próprio (1 vendido = 1 a menos) ──
const modalImportar = document.getElementById('modal-importar');
const formImportar = document.getElementById('form-importar');
const impLista = document.getElementById('imp-lista');

function abrirImportar() {
  const ordemCat = new Map(estado.categorias.map((c, i) => [c.id, Number(c.ordem ?? i)]));
  const candidatos = estado.itens.filter((it) => it.ativo !== false && !receitaDe(it).some((r) => estado.mapaEstoque.has(r.insumo)));
  if (!candidatos.length) {
    mostrarToast('Todos os produtos já baixam estoque.', 'info');
    return;
  }
  // já vem marcado o que normalmente se conta por unidade
  const marcar = (it) => ['cervejas', 'sem-alcool'].includes(it.categoria) ? !/ficha/i.test(it.nome)
    : /long ?neck|lata|garrafa|pronto/i.test(`${it.grupo} ${it.nome}`);
  const cats = estado.categorias.slice().sort((a, b) => (ordemCat.get(a.id) ?? 0) - (ordemCat.get(b.id) ?? 0));
  impLista.innerHTML = cats.map((c) => {
    const itens = candidatos.filter((it) => it.categoria === c.id);
    if (!itens.length) return '';
    return `<fieldset class="grupo-importar" style="--c:${esc(c.cor || '#F28BAA')}">
      <legend><span>${esc(c.nome)}</span><button type="button" class="link-acao" data-imp-todos="${esc(c.id)}">marcar todos</button></legend>
      ${itens.map((it) => `<div class="linha-importar">
        <label><input type="checkbox" data-imp-item="${esc(it.id)}" data-imp-cat="${esc(c.id)}" ${marcar(it) ? 'checked' : ''}>
          <span>${esc(it.nome)}${it.grupo ? ` <small>${esc(it.grupo)}</small>` : ''}</span></label>
        <input type="number" data-imp-qtd="${esc(it.id)}" inputmode="numeric" min="0" step="1" placeholder="quantos?" aria-label="Quantos tem de ${esc(nomeProduto(it))}">
      </div>`).join('')}
    </fieldset>`;
  }).join('');
  atualizarImportar();
  abrirModal(modalImportar);
}

function atualizarImportar() {
  const marcados = impLista.querySelectorAll('[data-imp-item]:checked').length;
  impLista.querySelectorAll('[data-imp-item]').forEach((chk) => {
    const q = impLista.querySelector(`[data-imp-qtd="${CSS.escape(chk.getAttribute('data-imp-item'))}"]`);
    q.disabled = !chk.checked;
    chk.closest('.linha-importar').classList.toggle('marcada', chk.checked);
  });
  const btn = document.getElementById('imp-criar');
  btn.textContent = marcados ? `Criar ${marcados} ${marcados === 1 ? 'estoque' : 'estoques'}` : 'Marque os produtos';
  btn.disabled = !marcados;
}

impLista.addEventListener('change', atualizarImportar);
impLista.addEventListener('click', (e) => {
  const b = e.target.closest('[data-imp-todos]');
  if (!b) return;
  const caixas = [...impLista.querySelectorAll(`[data-imp-cat="${CSS.escape(b.getAttribute('data-imp-todos'))}"]`)];
  const ligar = caixas.some((c) => !c.checked);
  caixas.forEach((c) => { c.checked = ligar; });
  atualizarImportar();
});
document.getElementById('imp-cancelar').addEventListener('click', () => fecharModal(modalImportar));

formImportar.addEventListener('submit', async (e) => {
  e.preventDefault();
  const marcados = [...impLista.querySelectorAll('[data-imp-item]:checked')];
  if (!marcados.length) return;
  // cada marcado precisa da quantidade (0 vale): sem isso o produto apareceria como esgotado
  const faltando = marcados.map((c) => impLista.querySelector(`[data-imp-qtd="${CSS.escape(c.getAttribute('data-imp-item'))}"]`))
    .filter((q) => q.value === '' || !(Number(q.value) >= 0));
  if (faltando.length) {
    faltando.forEach((q) => { q.classList.add('campo-erro'); setTimeout(() => q.classList.remove('campo-erro'), 1200); });
    faltando[0].focus();
    mostrarToast(`Falta a quantidade de ${faltando.length} ${faltando.length === 1 ? 'produto' : 'produtos'} (pode ser 0).`, 'erro');
    return;
  }
  const lote = writeBatch(db);
  const usados = new Set();
  for (const chk of marcados) {
    const it = estado.mapaItens.get(chk.getAttribute('data-imp-item'));
    if (!it) continue;
    const qtd = Math.max(0, Math.round(Number(impLista.querySelector(`[data-imp-qtd="${CSS.escape(it.id)}"]`).value)));
    const id = idUnico(`un-${it.id}`, (x) => estado.mapaEstoque.has(x) || usados.has(x));
    usados.add(id);
    lote.set(doc(db, 'estoque', id), { nome: nomeParaEstoque(it), unidade: 'un', qtd, minimo: 6, criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp(), ultimaContagem: { qtd, em: serverTimestamp() } });
    lote.update(doc(db, 'itens', it.id), { receita: [...receitaDe(it), { insumo: id, qtd: 1 }] });
  }
  fecharModal(modalImportar);
  try {
    await lote.commit();
    mostrarToast(`${usados.size} ${usados.size === 1 ? 'produto já baixa' : 'produtos já baixam'} estoque sozinhos.`, 'sucesso');
  } catch {
    mostrarToast('Não foi possível criar os estoques.', 'erro');
  }
});

// ─── 3.5. TELA DA PÁGINA (config/sobre + fotos) ───
const formSobrePagina = document.getElementById('form-sobre-pagina');
const inputSobreChamada = document.getElementById('sobre-chamada');
const inputSobreTexto = document.getElementById('sobre-texto');
const inputSobreMaioridade = document.getElementById('sobre-maioridade');
const gradeValoresSobre = document.getElementById('grade-valores-sobre');
const listaProgramacaoSobre = document.getElementById('lista-programacao-sobre');
const btnAdicionarProgramacao = document.getElementById('btn-adicionar-programacao');
const btnSalvarSobre = document.getElementById('btn-salvar-sobre');

const btnAdicionarFotos = document.getElementById('btn-adicionar-fotos');
const inputAdicionarFotos = document.getElementById('input-adicionar-fotos');
const progressoUploadFotos = document.getElementById('progresso-upload-fotos');
const gradeFotosBar = document.getElementById('grade-fotos-bar');

function normalizarSobre(dados) {
  const base = SOBRE_INICIAL;
  const valoresOrig = Array.isArray(dados?.valores) ? dados.valores : base.valores;
  const valores = [0, 1, 2, 3].map((idx) => ({
    titulo: String(valoresOrig[idx]?.titulo ?? base.valores[idx]?.titulo ?? ''),
    texto: String(valoresOrig[idx]?.texto ?? base.valores[idx]?.texto ?? ''),
  }));

  const progOrig = Array.isArray(dados?.programacao) ? dados.programacao : base.programacao;
  const programacao = progOrig.slice(0, 6).map((item) => ({
    quando: String(item?.quando ?? ''),
    titulo: String(item?.titulo ?? ''),
    texto: String(item?.texto ?? ''),
  }));

  return {
    chamada: String(dados?.chamada ?? base.chamada),
    texto: String(dados?.texto ?? base.texto),
    valores,
    programacao,
    maioridade: String(dados?.maioridade ?? base.maioridade),
  };
}

function renderizarValoresSobre(valores) {
  if (!gradeValoresSobre) return;
  const lista = Array.isArray(valores) && valores.length === 4 ? valores : SOBRE_INICIAL.valores;
  gradeValoresSobre.innerHTML = lista
    .map(
      (v, idx) => `<div class="cartao-valor-sobre">
        <div class="campo">
          <label for="sobre-val-titulo-${idx}">Valor ${idx + 1} · Título</label>
          <input type="text" id="sobre-val-titulo-${idx}" data-valor-titulo="${idx}" value="${esc(v.titulo || '')}" required placeholder="Ex.: Acolhimento">
        </div>
        <div class="campo">
          <label for="sobre-val-texto-${idx}">Texto</label>
          <textarea id="sobre-val-texto-${idx}" rows="2" data-valor-texto="${idx}" required placeholder="Frase curta deste valor...">${esc(v.texto || '')}</textarea>
        </div>
      </div>`
    )
    .join('');
}

function lerProgramacaoDoDom() {
  if (!listaProgramacaoSobre) return;
  const blocos = listaProgramacaoSobre.querySelectorAll('[data-prog-item]');
  if (blocos.length === 0) return;
  const novaLista = [];
  blocos.forEach((bloco) => {
    const quando = bloco.querySelector('[data-prog-campo="quando"]')?.value ?? '';
    const titulo = bloco.querySelector('[data-prog-campo="titulo"]')?.value ?? '';
    const texto = bloco.querySelector('[data-prog-campo="texto"]')?.value ?? '';
    novaLista.push({ quando, titulo, texto });
  });
  estado.sobreProgramacao = novaLista.slice(0, 6);
}

function renderizarProgramacaoSobre() {
  if (!listaProgramacaoSobre) return;
  const lista = estado.sobreProgramacao;
  if (btnAdicionarProgramacao) {
    btnAdicionarProgramacao.disabled = lista.length >= 6;
  }

  if (lista.length === 0) {
    listaProgramacaoSobre.innerHTML = `<div class="estado-vazio">Nenhum item na programação.</div>`;
    return;
  }

  listaProgramacaoSobre.innerHTML = lista
    .map(
      (item, idx) => `<div class="item-programacao-sobre" data-prog-item="${idx}">
        <div class="topo-item-programacao">
          <span class="rotulo-item-programacao">Item ${idx + 1} de ${lista.length}</span>
          <div class="acoes-item-programacao">
            <button type="button" class="btn-ordem" data-acao-prog="subir" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="Subir item" aria-label="Subir item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            </button>
            <button type="button" class="btn-ordem" data-acao-prog="descer" data-idx="${idx}" ${idx === lista.length - 1 ? 'disabled' : ''} title="Descer item" aria-label="Descer item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <button type="button" class="btn btn-perigo btn-compacto" data-acao-prog="remover" data-idx="${idx}">Remover</button>
          </div>
        </div>
        <div class="grade-campos-2">
          <div class="campo">
            <label>Quando</label>
            <input type="text" data-prog-campo="quando" value="${esc(item.quando || '')}" required placeholder="Ex.: Toda quinta">
          </div>
          <div class="campo">
            <label>Título</label>
            <input type="text" data-prog-campo="titulo" value="${esc(item.titulo || '')}" required placeholder="Ex.: Caipirinha em dobro">
          </div>
          <div class="campo campo-largo">
            <label>Texto</label>
            <textarea rows="2" data-prog-campo="texto" required placeholder="Descrição da programação...">${esc(item.texto || '')}</textarea>
          </div>
        </div>
      </div>`
    )
    .join('');
}

function preencherFormularioSobre() {
  if (!formSobrePagina) return;
  const s = normalizarSobre(estado.sobre);
  inputSobreChamada.value = s.chamada;
  inputSobreTexto.value = s.texto;
  inputSobreMaioridade.value = s.maioridade;
  renderizarValoresSobre(s.valores);
  estado.sobreProgramacao = structuredClone(s.programacao);
  renderizarProgramacaoSobre();
}

formSobrePagina.addEventListener('focusin', () => {
  estado.sobreEditando = true;
});

btnAdicionarProgramacao.addEventListener('click', () => {
  estado.sobreEditando = true;
  lerProgramacaoDoDom();
  if (estado.sobreProgramacao.length >= 6) {
    mostrarToast('A programação permite no máximo 6 itens.', 'erro');
    return;
  }
  estado.sobreProgramacao.push({ quando: '', titulo: '', texto: '' });
  renderizarProgramacaoSobre();
});

listaProgramacaoSobre.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-acao-prog]');
  if (!btn) return;
  estado.sobreEditando = true;
  lerProgramacaoDoDom();

  const acao = btn.getAttribute('data-acao-prog');
  const idx = Number(btn.getAttribute('data-idx'));
  const lista = estado.sobreProgramacao;
  if (Number.isNaN(idx) || idx < 0 || idx >= lista.length) return;

  if (acao === 'remover') {
    lista.splice(idx, 1);
  } else if (acao === 'subir' && idx > 0) {
    [lista[idx - 1], lista[idx]] = [lista[idx], lista[idx - 1]];
  } else if (acao === 'descer' && idx < lista.length - 1) {
    [lista[idx + 1], lista[idx]] = [lista[idx], lista[idx + 1]];
  }
  renderizarProgramacaoSobre();
});

formSobrePagina.addEventListener('submit', async (e) => {
  e.preventDefault();
  lerProgramacaoDoDom();

  const chamada = inputSobreChamada.value.trim();
  const texto = inputSobreTexto.value.trim();
  const maioridade = inputSobreMaioridade.value.trim();

  const valores = [0, 1, 2, 3].map((idx) => ({
    titulo: (gradeValoresSobre.querySelector(`[data-valor-titulo="${idx}"]`)?.value || '').trim(),
    texto: (gradeValoresSobre.querySelector(`[data-valor-texto="${idx}"]`)?.value || '').trim(),
  }));

  const programacao = estado.sobreProgramacao.slice(0, 6).map((p) => ({
    quando: String(p.quando || '').trim(),
    titulo: String(p.titulo || '').trim(),
    texto: String(p.texto || '').trim(),
  }));

  if (
    !chamada ||
    !texto ||
    !maioridade ||
    valores.some((v) => !v.titulo || !v.texto) ||
    programacao.some((p) => !p.quando || !p.titulo || !p.texto)
  ) {
    mostrarToast('Preencha todos os campos de textos, valores e programação.', 'erro');
    return;
  }

  btnSalvarSobre.disabled = true;
  try {
    const payload = {
      chamada,
      texto,
      valores,
      programacao,
      maioridade,
    };
    await setDoc(doc(db, 'config', 'sobre'), payload);
    estado.sobre = structuredClone(payload);
    estado.sobreEditando = false;
    mostrarToast('Textos da página salvos com sucesso.', 'sucesso');
  } catch {
    mostrarToast('Erro ao salvar os textos da página.', 'erro');
  } finally {
    btnSalvarSobre.disabled = false;
  }
});

// Processamento de foto da galeria:
// createImageBitmap com imageOrientation:'from-image', máx 1280px JPEG 0.8;
// se > 380 KB, refaz com 0.7 e depois 1100px; se ainda passar, recusa.
async function processarFotoGaleria(arquivo) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(arquivo);
  }

  try {
    const largOrig = bitmap.width;
    const altOrig = bitmap.height;
    if (!largOrig || !altOrig) {
      throw new Error('Arquivo de imagem inválido.');
    }

    const gerarJpeg = (maxLado, qualidade) => {
      let larg = largOrig;
      let alt = altOrig;
      if (larg > maxLado || alt > maxLado) {
        if (larg >= alt) {
          alt = Math.max(1, Math.round((alt * maxLado) / larg));
          larg = maxLado;
        } else {
          larg = Math.max(1, Math.round((larg * maxLado) / alt));
          alt = maxLado;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = larg;
      canvas.height = alt;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, larg, alt);
      return canvas.toDataURL('image/jpeg', qualidade);
    };

    const LIMITE_380KB = 380 * 1024;
    let dataUrl = gerarJpeg(1280, 0.8);
    if (dataUrl.length > LIMITE_380KB) {
      dataUrl = gerarJpeg(1280, 0.7);
    }
    if (dataUrl.length > LIMITE_380KB) {
      dataUrl = gerarJpeg(1100, 0.7);
    }
    if (dataUrl.length > LIMITE_380KB) {
      throw new Error(`A foto "${arquivo.name || 'selecionada'}" ultrapassou 380 KB mesmo após comprimir.`);
    }
    return dataUrl;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }
  }
}

btnAdicionarFotos.addEventListener('click', () => {
  inputAdicionarFotos.click();
});

inputAdicionarFotos.addEventListener('change', async () => {
  const arquivos = Array.from(inputAdicionarFotos.files || []);
  inputAdicionarFotos.value = '';
  if (arquivos.length === 0) return;

  btnAdicionarFotos.disabled = true;
  progressoUploadFotos.hidden = false;

  let maiorOrdem = estado.fotos.reduce((m, f) => Math.max(m, Number(f.ordem || 0)), 0);
  let enviadas = 0;

  try {
    for (let i = 0; i < arquivos.length; i++) {
      progressoUploadFotos.textContent = `Enviando ${i + 1} de ${arquivos.length}…`;
      try {
        const img = await processarFotoGaleria(arquivos[i]);
        maiorOrdem += 1;
        await addDoc(collection(db, 'fotos'), {
          img,
          legenda: '',
          ordem: maiorOrdem,
          ativo: true,
          criadoEm: serverTimestamp(),
        });
        enviadas += 1;
      } catch (err) {
        mostrarToast(err?.message || 'Erro ao enviar foto.', 'erro');
      }
    }

    if (enviadas > 0) {
      mostrarToast(
        enviadas === 1 ? '1 foto adicionada.' : `${enviadas} fotos adicionadas.`,
        'sucesso'
      );
    }
  } finally {
    progressoUploadFotos.hidden = true;
    progressoUploadFotos.textContent = '';
    btnAdicionarFotos.disabled = false;
  }
});

function renderizarFotosBar() {
  if (!gradeFotosBar) return;

  // Preserva legenda em edição caso chegue snapshot enquanto o usuário digita
  const ativoEl = document.activeElement;
  const idLegendaFocada = ativoEl?.getAttribute?.('data-legenda-foto') || null;
  const valorLegendaFocada = idLegendaFocada ? ativoEl.value : null;

  if (estado.fotos.length === 0) {
    gradeFotosBar.innerHTML = `<div class="estado-vazio">Nenhuma foto ainda. As fotos aparecem na página O Rainbow.</div>`;
    return;
  }

  gradeFotosBar.innerHTML = estado.fotos
    .map((f, idx) => {
      const ativa = f.ativo !== false;
      return `<article class="cartao-foto-bar ${ativa ? '' : 'inativa'}" data-card-foto="${esc(f.id)}">
        <div class="moldura-foto-bar">
          <img src="${esc(f.img || '')}" alt="${esc(f.legenda || 'Foto do Rainbow Pub')}" loading="lazy">
        </div>
        <div class="corpo-foto-bar">
          <div class="campo">
            <label for="legenda-foto-${esc(f.id)}">Legenda (até 80 caracteres)</label>
            <input type="text" id="legenda-foto-${esc(f.id)}" maxlength="80" data-legenda-foto="${esc(f.id)}" value="${esc(f.legenda || '')}" placeholder="Opcional...">
          </div>
          <label class="switch-padrao">
            <input type="checkbox" data-toggle-foto-ativa="${esc(f.id)}" ${ativa ? 'checked' : ''}>
            <span class="trilho-switch"></span>
            <span>Mostrar no site</span>
          </label>
          <div class="rodape-foto-bar">
            <div class="botoes-ordem-foto">
              <button type="button" class="btn-ordem" data-acao-foto="subir" data-id="${esc(f.id)}" ${idx === 0 ? 'disabled' : ''} title="Subir foto" aria-label="Subir foto">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="18 15 12 9 6 15"/>
                </svg>
              </button>
              <button type="button" class="btn-ordem" data-acao-foto="descer" data-id="${esc(f.id)}" ${idx === estado.fotos.length - 1 ? 'disabled' : ''} title="Descer foto" aria-label="Descer foto">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
            </div>
            <button type="button" class="btn btn-perigo btn-compacto" data-acao-foto="excluir" data-id="${esc(f.id)}">Excluir</button>
          </div>
        </div>
      </article>`;
    })
    .join('');

  if (idLegendaFocada) {
    const novoInput = gradeFotosBar.querySelector(`[data-legenda-foto="${CSS.escape(idLegendaFocada)}"]`);
    if (novoInput) {
      novoInput.value = valorLegendaFocada;
      novoInput.focus();
    }
  }
}

// Salva legenda ao sair do campo (focusout) ou pressionar Enter
gradeFotosBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-legenda-foto]')) {
    e.preventDefault();
    e.target.blur();
  }
});

gradeFotosBar.addEventListener('focusout', async (e) => {
  const input = e.target.closest('[data-legenda-foto]');
  if (!input) return;
  const id = input.getAttribute('data-legenda-foto');
  const foto = estado.fotos.find((f) => f.id === id);
  if (!foto) return;

  const novaLegenda = input.value.trim().slice(0, 80);
  input.value = novaLegenda;
  if (novaLegenda === String(foto.legenda || '')) return;

  try {
    await updateDoc(doc(db, 'fotos', id), { legenda: novaLegenda });
    mostrarToast('Legenda salva.', 'sucesso');
  } catch {
    mostrarToast('Erro ao salvar legenda.', 'erro');
  }
});

// Interruptor "Mostrar no site" (ativo)
gradeFotosBar.addEventListener('change', async (e) => {
  const chk = e.target.closest('[data-toggle-foto-ativa]');
  if (!chk) return;
  const id = chk.getAttribute('data-toggle-foto-ativa');
  const ativo = chk.checked;
  try {
    await updateDoc(doc(db, 'fotos', id), { ativo });
    mostrarToast(ativo ? 'Foto visível no site.' : 'Foto ocultada do site.');
  } catch {
    chk.checked = !ativo;
    mostrarToast('Erro ao atualizar visibilidade da foto.', 'erro');
  }
});

// Botões subir, descer e excluir foto
gradeFotosBar.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-acao-foto]');
  if (!btn) return;
  const acao = btn.getAttribute('data-acao-foto');
  const id = btn.getAttribute('data-id');
  const idx = estado.fotos.findIndex((f) => f.id === id);
  if (idx < 0) return;

  if (acao === 'subir' || acao === 'descer') {
    const idxAlvo = acao === 'subir' ? idx - 1 : idx + 1;
    if (idxAlvo < 0 || idxAlvo >= estado.fotos.length) return;

    const atual = estado.fotos[idx];
    const vizinha = estado.fotos[idxAlvo];
    let ordemAtual = Number(atual.ordem || idx + 1);
    let ordemVizinha = Number(vizinha.ordem || idxAlvo + 1);
    if (ordemAtual === ordemVizinha) {
      ordemAtual = idx + 1;
      ordemVizinha = idxAlvo + 1;
    }

    btn.disabled = true;
    try {
      const lote = writeBatch(db);
      lote.update(doc(db, 'fotos', atual.id), { ordem: ordemVizinha });
      lote.update(doc(db, 'fotos', vizinha.id), { ordem: ordemAtual });
      await lote.commit();
      mostrarToast('Ordem das fotos atualizada.');
    } catch {
      mostrarToast('Erro ao reordenar fotos.', 'erro');
    } finally {
      btn.disabled = false;
    }
  } else if (acao === 'excluir') {
    const ok = await confirmarAcao({
      titulo: 'Excluir foto',
      mensagem: 'Deseja realmente excluir esta foto da galeria da página O Rainbow?',
      textoConfirmar: 'Excluir foto',
      perigo: true,
    });
    if (!ok) return;

    btn.disabled = true;
    try {
      await deleteDoc(doc(db, 'fotos', id));
      mostrarToast('Foto excluída.', 'sucesso');
    } catch {
      mostrarToast('Erro ao excluir foto.', 'erro');
      btn.disabled = false;
    }
  }
});

preencherFormularioSobre();
renderizarFotosBar();

// ─── 4. TELA DO BAR (config/loja) ───
const formConfigBar = document.getElementById('form-config-bar');
const listaSemanaBar = document.getElementById('lista-semana-bar');
const inputGpsLat = document.getElementById('bar-gps-lat');
const inputGpsLng = document.getElementById('bar-gps-lng');
const inputGpsRaio = document.getElementById('bar-gps-raio');
const linkGpsMapa = document.getElementById('link-gps-mapa');
const statusPrecisaoGps = document.getElementById('status-precisao-gps');

function atualizarLinkMapaGps() {
  const lat = Number(inputGpsLat.value || 0);
  const lng = Number(inputGpsLng.value || 0);
  linkGpsMapa.href = `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

inputGpsLat.addEventListener('input', atualizarLinkMapaGps);
inputGpsLng.addEventListener('input', atualizarLinkMapaGps);

function renderizarSemanaBar(semana) {
  const arr = Array.isArray(semana) && semana.length === 7 ? semana : LOJA_INICIAL.semana;
  listaSemanaBar.innerHTML = DIAS_SEMANA.map((nomeDia, idx) => {
    const configDia = arr[idx];
    const fechado = !configDia;
    const abre = configDia?.abre || '19:00';
    const fecha = configDia?.fecha || '03:00';
    return `<div class="linha-dia-semana" data-dia-idx="${idx}">
      <span class="nome-dia-semana">${esc(nomeDia)}</span>
      <label class="switch-padrao">
        <input type="checkbox" data-sem-fechado="${idx}" ${fechado ? 'checked' : ''}>
        <span class="trilho-switch"></span>
        <span>Fechado</span>
      </label>
      <div class="campo">
        <label>Abre</label>
        <input type="time" data-sem-abre="${idx}" value="${esc(abre)}" ${fechado ? 'disabled' : ''}>
      </div>
      <div class="campo">
        <label>Fecha</label>
        <input type="time" data-sem-fecha="${idx}" value="${esc(fecha)}" ${fechado ? 'disabled' : ''}>
      </div>
    </div>`;
  }).join('');
}

listaSemanaBar.addEventListener('change', (e) => {
  const chk = e.target.closest('[data-sem-fechado]');
  if (!chk) return;
  const idx = chk.getAttribute('data-sem-fechado');
  const fechado = chk.checked;
  const inputAbre = listaSemanaBar.querySelector(`[data-sem-abre="${idx}"]`);
  const inputFecha = listaSemanaBar.querySelector(`[data-sem-fecha="${idx}"]`);
  if (inputAbre) inputAbre.disabled = fechado;
  if (inputFecha) inputFecha.disabled = fechado;
});

function preencherFormularioBar() {
  const l = estado.loja || LOJA_INICIAL;
  document.getElementById('bar-aviso').value = l.aviso || '';
  document.getElementById('bar-endereco').value = l.endereco || '';
  document.getElementById('bar-maps').value = l.mapsUrl || '';
  document.getElementById('bar-instagram').value = l.instagram || '';
  document.getElementById('bar-whatsapp').value = l.whatsapp || '';
  document.getElementById('bar-locais').value = Array.isArray(l.locais) ? l.locais.join(', ') : '';

  const horarios = Array.isArray(l.horariosTexto) ? l.horariosTexto : [];
  document.getElementById('bar-horario-1').value = horarios[0] || '';
  document.getElementById('bar-horario-2').value = horarios[1] || '';

  renderizarSemanaBar(l.semana);

  const gps = l.gps || LOJA_INICIAL.gps;
  document.getElementById('bar-gps-ativo').checked = Boolean(gps.ativo);
  inputGpsLat.value = String(gps.lat ?? LOJA_INICIAL.gps.lat);
  inputGpsLng.value = String(gps.lng ?? LOJA_INICIAL.gps.lng);
  inputGpsRaio.value = String(gps.raio ?? LOJA_INICIAL.gps.raio);
  atualizarLinkMapaGps();
}

formConfigBar.addEventListener('focusin', () => {
  estado.barEditando = true;
});

document.getElementById('btn-usar-localizacao').addEventListener('click', () => {
  if (!navigator.geolocation) {
    mostrarToast('Este navegador não suporta geolocalização.', 'erro');
    return;
  }
  statusPrecisaoGps.textContent = 'Obtendo coordenadas com alta precisão...';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = Number(pos.coords.latitude.toFixed(7));
      const lng = Number(pos.coords.longitude.toFixed(7));
      const prec = Math.round(pos.coords.accuracy || 0);
      inputGpsLat.value = String(lat);
      inputGpsLng.value = String(lng);
      atualizarLinkMapaGps();
      statusPrecisaoGps.textContent = `Capturado dentro do bar: precisão ±${prec} m`;
      mostrarToast(`Localização capturada (±${prec} m). Salve para aplicar.`, 'sucesso');
    },
    (err) => {
      statusPrecisaoGps.textContent = 'Não foi possível obter a localização.';
      mostrarToast(`Erro no GPS: ${err?.message || 'permissão negada'}`, 'erro');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
});

formConfigBar.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btnSalvar = document.getElementById('btn-salvar-bar');
  btnSalvar.disabled = true;

  const aviso = document.getElementById('bar-aviso').value.trim();
  const endereco = document.getElementById('bar-endereco').value.trim();
  const mapsUrl = document.getElementById('bar-maps').value.trim();
  const instagram = document.getElementById('bar-instagram').value.trim().replace(/^@/, '');
  const whatsapp = document.getElementById('bar-whatsapp').value.trim();
  const locais = document
    .getElementById('bar-locais')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const h1 = document.getElementById('bar-horario-1').value.trim();
  const h2 = document.getElementById('bar-horario-2').value.trim();
  const horariosTexto = [h1, h2].filter(Boolean);

  const semana = [];
  for (let i = 0; i < 7; i++) {
    const fechado = listaSemanaBar.querySelector(`[data-sem-fechado="${i}"]`)?.checked;
    if (fechado) {
      semana.push(null);
    } else {
      const abre = listaSemanaBar.querySelector(`[data-sem-abre="${i}"]`)?.value || '19:00';
      const fecha = listaSemanaBar.querySelector(`[data-sem-fecha="${i}"]`)?.value || '03:00';
      semana.push({ abre, fecha });
    }
  }

  const gpsAtivo = document.getElementById('bar-gps-ativo').checked;
  const lat = Number(inputGpsLat.value);
  const lng = Number(inputGpsLng.value);
  const raio = Number(inputGpsRaio.value || 150);

  if (Number.isNaN(lat) || Number.isNaN(lng) || raio <= 0) {
    mostrarToast('Verifique os valores de latitude, longitude e raio do GPS.', 'erro');
    btnSalvar.disabled = false;
    return;
  }

  const gps = {
    ativo: gpsAtivo,
    lat,
    lng,
    raio,
    caixa: caixaDe(lat, lng, raio),
  };

  try {
    await setDoc(
      doc(db, 'config', 'loja'),
      {
        nome: estado.loja?.nome || 'Rainbow Pub',
        aceitandoPedidos: Boolean(estado.loja?.aceitandoPedidos ?? true),
        aviso,
        endereco,
        mapsUrl,
        instagram,
        whatsapp,
        locais,
        horariosTexto,
        semana,
        gps,
      },
      { merge: true }
    );
    estado.barEditando = false;
    mostrarToast('Configurações do bar salvas com sucesso.', 'sucesso');
  } catch {
    mostrarToast('Erro ao salvar configurações do bar.', 'erro');
  } finally {
    btnSalvar.disabled = false;
  }
});

// ─── 5. TELA DE RELATÓRIOS ───
const controlesDatasRelatorio = document.getElementById('controles-datas-relatorio');
const blocoDataUnica = document.getElementById('bloco-data-unica');
const blocoDataIni = document.getElementById('bloco-data-ini');
const blocoDataFim = document.getElementById('bloco-data-fim');
const inputDataNoite = document.getElementById('rel-data-noite');
const inputDataInicio = document.getElementById('rel-data-inicio');
const inputDataFim = document.getElementById('rel-data-fim');

function somarDiasStr(dataISO, dias) {
  const [a, m, d] = dataISO.split('-').map(Number);
  const dt = new Date(a, m - 1, d + dias, 12, 0, 0);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function inicializarDatasPadraoRelatorio() {
  const hojeNoite = noiteDe(new Date());
  inputDataNoite.value = hojeNoite;
  inputDataFim.value = hojeNoite;
  inputDataInicio.value = somarDiasStr(hojeNoite, -6);
}
inicializarDatasPadraoRelatorio();

function obterIntervaloNoitesSelecionado() {
  const hojeNoite = noiteDe(new Date());
  const p = estado.periodoRelatorio;

  if (p === 'esta-noite') {
    return {
      noiteIni: hojeNoite,
      noiteFim: hojeNoite,
      rotulo: `Esta noite (${formatarNoiteBR(hojeNoite)})`,
    };
  }
  if (p === 'uma-noite') {
    const n = inputDataNoite.value || hojeNoite;
    return {
      noiteIni: n,
      noiteFim: n,
      rotulo: `Noite de ${formatarNoiteBR(n)}`,
    };
  }
  if (p === '7-noites') {
    const ini = somarDiasStr(hojeNoite, -6);
    return {
      noiteIni: ini,
      noiteFim: hojeNoite,
      rotulo: `Últimas 7 noites (${formatarNoiteBR(ini)} a ${formatarNoiteBR(hojeNoite)})`,
    };
  }
  if (p === 'este-mes') {
    const prefixoMes = hojeNoite.slice(0, 7);
    const ini = `${prefixoMes}-01`;
    return {
      noiteIni: ini,
      noiteFim: hojeNoite,
      rotulo: `Este mês (${formatarNoiteBR(ini)} a ${formatarNoiteBR(hojeNoite)})`,
    };
  }
  // intervalo
  let ini = inputDataInicio.value || hojeNoite;
  let fim = inputDataFim.value || hojeNoite;
  if (ini > fim) [ini, fim] = [fim, ini];
  return {
    noiteIni: ini,
    noiteFim: fim,
    rotulo: `Intervalo de ${formatarNoiteBR(ini)} a ${formatarNoiteBR(fim)}`,
  };
}

document.querySelectorAll('.btn-periodo').forEach((btn) => {
  btn.addEventListener('click', () => {
    const per = btn.getAttribute('data-periodo');
    estado.periodoRelatorio = per;
    document.querySelectorAll('.btn-periodo').forEach((b) => {
      b.classList.toggle('ativo', b.getAttribute('data-periodo') === per);
    });

    if (per === 'uma-noite') {
      controlesDatasRelatorio.hidden = false;
      blocoDataUnica.hidden = false;
      blocoDataIni.hidden = true;
      blocoDataFim.hidden = true;
    } else if (per === 'intervalo') {
      controlesDatasRelatorio.hidden = false;
      blocoDataUnica.hidden = true;
      blocoDataIni.hidden = false;
      blocoDataFim.hidden = false;
    } else {
      controlesDatasRelatorio.hidden = true;
    }

    carregarRelatorio();
  });
});

document.getElementById('btn-buscar-relatorio').addEventListener('click', carregarRelatorio);

async function carregarRelatorio() {
  if (!estado.usuario) return;
  const { noiteIni, noiteFim, rotulo } = obterIntervaloNoitesSelecionado();
  estado.descricaoPeriodoRelatorio = rotulo;
  document.getElementById('rel-descricao-periodo').textContent = `Consultando: ${rotulo}...`;
  document.getElementById('rel-impressao-periodo').textContent = `Período: ${rotulo}`;

  // Uma noite AAAA-MM-DD começa às 12h daquele dia e termina às 12h do dia seguinte.
  const [a1, m1, d1] = noiteIni.split('-').map(Number);
  const [a2, m2, d2] = noiteFim.split('-').map(Number);
  const dtInicio = new Date(a1, m1 - 1, d1, 6, 0, 0);
  const dtFim = new Date(a2, m2 - 1, d2 + 1, 18, 0, 0);

  try {
    const qRel = query(
      collection(db, 'pedidos'),
      where('criadoEm', '>=', Timestamp.fromDate(dtInicio)),
      where('criadoEm', '<', Timestamp.fromDate(dtFim)),
      orderBy('criadoEm', 'asc')
    );
    const snap = await getDocs(qRel);
    const lista = [];
    snap.forEach((d) => {
      const dados = d.data();
      const noiteDoc = dados.noite || noiteDe(extrairData(dados.criadoEm));
      if (noiteDoc >= noiteIni && noiteDoc <= noiteFim) {
        lista.push({ id: d.id, ...dados, noite: noiteDoc });
      }
    });

    estado.pedidosRelatorio = lista;
    document.getElementById('rel-descricao-periodo').textContent = `${rotulo} · ${lista.length} pedido(s) encontrado(s)`;
    renderizarDadosRelatorio();
  } catch {
    document.getElementById('rel-descricao-periodo').textContent = `Erro ao buscar pedidos de ${rotulo}.`;
    mostrarToast('Erro ao carregar dados do relatório.', 'erro');
  }
}

function renderizarBlocoBarras(idContainer, linhas, msgVazio = 'Sem dados no período.') {
  const el = document.getElementById(idContainer);
  if (!el) return;
  if (!linhas || linhas.length === 0) {
    el.innerHTML = `<div class="estado-vazio">${esc(msgVazio)}</div>`;
    return;
  }
  const maxRef = Math.max(...linhas.map((l) => l.metricaBase), 1);
  el.innerHTML = linhas
    .map((l) => {
      const pct = Math.max(3, Math.round((l.metricaBase / maxRef) * 100));
      return `<div class="linha-barra-relatorio">
        <div class="topo-linha-barra">
          <span class="rotulo-barra">${esc(l.rotulo)}</span>
          <span class="valores-barra">${esc(l.detalhe)}</span>
        </div>
        <div class="trilho-barra">
          <div class="preenchimento-barra" style="width:${pct}%"></div>
        </div>
      </div>`;
    })
    .join('');
}

function renderizarDadosRelatorio() {
  const todos = estado.pedidosRelatorio;
  const validos = todos.filter((p) => p.status !== 'cancelado');
  const cancelados = todos.filter((p) => p.status === 'cancelado');
  const aReceber = validos.filter((p) => !p.pago);

  const faturamento = validos.reduce((acc, p) => acc + Number(p.total || 0), 0);
  const qtdPedidosValidos = validos.length;
  const ticketMedio = qtdPedidosValidos > 0 ? faturamento / qtdPedidosValidos : 0;

  let totalItensVendidos = 0;
  for (const p of validos) {
    if (Array.isArray(p.itens)) {
      for (const it of p.itens) {
        totalItensVendidos += Number(it?.qtd || 0);
      }
    }
  }

  const valorCancelados = cancelados.reduce((acc, p) => acc + Number(p.total || 0), 0);
  const valorAReceber = aReceber.reduce((acc, p) => acc + Number(p.total || 0), 0);

  document.getElementById('met-faturamento').textContent = brl(faturamento);
  document.getElementById('met-pedidos').textContent = String(qtdPedidosValidos);
  document.getElementById('met-ticket').textContent = brl(ticketMedio);
  document.getElementById('met-itens').textContent = String(totalItensVendidos);
  document.getElementById('met-cancelados').textContent = `${cancelados.length} (${brl(valorCancelados)})`;
  document.getElementById('met-areceber').textContent = `${brl(valorAReceber)} (${aReceber.length})`;

  // 1. Mais vendidos (qtd e valor)
  const mapaMaisVendidos = new Map();
  // 2. Por categoria (campo cat)
  const mapaPorCat = new Map();
  const nomesCat = new Map(estado.categorias.map((c) => [c.id, c.nome]));

  for (const p of validos) {
    for (const it of Array.isArray(p.itens) ? p.itens : []) {
      const qtd = Number(it?.qtd || 0);
      const preco = Number(it?.preco || 0);
      const sub = qtd * preco;
      const chaveItem = it?.nome || it?.id || 'Item';
      const atualItem = mapaMaisVendidos.get(chaveItem) || { nome: chaveItem, qtd: 0, valor: 0 };
      atualItem.qtd += qtd;
      atualItem.valor += sub;
      mapaMaisVendidos.set(chaveItem, atualItem);

      const codCat = it?.cat || estado.mapaItens.get(it?.id)?.categoria || 'outros';
      const nomeCat = nomesCat.get(codCat) || codCat;
      const atualCat = mapaPorCat.get(nomeCat) || { nome: nomeCat, qtd: 0, valor: 0 };
      atualCat.qtd += qtd;
      atualCat.valor += sub;
      mapaPorCat.set(nomeCat, atualCat);
    }
  }

  const linhasItens = [...mapaMaisVendidos.values()]
    .sort((a, b) => b.qtd - a.qtd || b.valor - a.valor)
    .map((x) => ({
      rotulo: x.nome,
      detalhe: `${x.qtd} un. · ${brl(x.valor)}`,
      metricaBase: x.qtd,
    }));
  renderizarBlocoBarras('rel-lista-itens', linhasItens);

  const linhasCategorias = [...mapaPorCat.values()]
    .sort((a, b) => b.valor - a.valor)
    .map((x) => ({
      rotulo: x.nome,
      detalhe: `${x.qtd} un. · ${brl(x.valor)}`,
      metricaBase: x.valor,
    }));
  renderizarBlocoBarras('rel-lista-categorias', linhasCategorias);

  // 3. Por hora do pedido
  const mapaPorHora = new Map();
  // 4. Por local
  const mapaPorLocal = new Map();
  // 5. Por noite
  const mapaPorNoite = new Map();

  for (const p of validos) {
    const dt = extrairData(p.criadoEm);
    const horaChave = `${String(dt.getHours()).padStart(2, '0')}h`;
    const regHora = mapaPorHora.get(horaChave) || { hora: horaChave, pedidos: 0, valor: 0 };
    regHora.pedidos += 1;
    regHora.valor += Number(p.total || 0);
    mapaPorHora.set(horaChave, regHora);

    const localChave = p.local || 'Não informado';
    const regLocal = mapaPorLocal.get(localChave) || { local: localChave, pedidos: 0, valor: 0 };
    regLocal.pedidos += 1;
    regLocal.valor += Number(p.total || 0);
    mapaPorLocal.set(localChave, regLocal);

    const noiteChave = p.noite || noiteDe(dt);
    const regNoite = mapaPorNoite.get(noiteChave) || { noite: noiteChave, pedidos: 0, valor: 0 };
    regNoite.pedidos += 1;
    regNoite.valor += Number(p.total || 0);
    mapaPorNoite.set(noiteChave, regNoite);
  }

  const linhasHoras = [...mapaPorHora.values()].map((x) => ({
    rotulo: x.hora,
    detalhe: `${x.pedidos} ped. · ${brl(x.valor)}`,
    metricaBase: x.valor,
  }));
  renderizarBlocoBarras('rel-lista-horas', linhasHoras);

  const linhasLocais = [...mapaPorLocal.values()]
    .sort((a, b) => b.valor - a.valor)
    .map((x) => ({
      rotulo: x.local,
      detalhe: `${x.pedidos} ped. · ${brl(x.valor)}`,
      metricaBase: x.valor,
    }));
  renderizarBlocoBarras('rel-lista-locais', linhasLocais);

  const cartaoNoites = document.getElementById('rel-cartao-noites');
  const multiplasNoites =
    mapaPorNoite.size > 1 ||
    ['7-noites', 'este-mes', 'intervalo'].includes(estado.periodoRelatorio);
  cartaoNoites.hidden = !multiplasNoites;

  if (multiplasNoites) {
    const linhasNoites = [...mapaPorNoite.values()]
      .sort((a, b) => b.noite.localeCompare(a.noite))
      .map((x) => ({
        rotulo: formatarNoiteBR(x.noite),
        detalhe: `${x.pedidos} ped. · ${brl(x.valor)}`,
        metricaBase: x.valor,
      }));
    renderizarBlocoBarras('rel-lista-noites', linhasNoites);
  }
}

// Exportar CSV (separador ;, UTF-8 com BOM, 1 linha por item de pedido)
function escaparCelulaCsv(valor) {
  const texto = String(valor ?? '').replace(/\r?\n/g, ' ').trim();
  if (texto.includes(';') || texto.includes('"')) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

document.getElementById('btn-exportar-csv').addEventListener('click', () => {
  if (estado.pedidosRelatorio.length === 0) {
    mostrarToast('Não há pedidos no período selecionado para exportar.', 'erro');
    return;
  }

  const cabecalho = [
    'noite',
    'hora',
    'codigo',
    'nome',
    'local',
    'item',
    'qtd',
    'preco',
    'subtotal',
    'status',
    'pago',
  ].join(';');

  const linhas = [cabecalho];
  for (const p of estado.pedidosRelatorio) {
    const dt = extrairData(p.criadoEm);
    const hora = formatarHoraHM(dt);
    const cod = codigo(p.id);
    const noite = p.noite || noiteDe(dt);
    const statusTxt = STATUS[p.status] || p.status || '';
    const pagoTxt = p.pago ? 'Sim' : 'Não';

    const itens = Array.isArray(p.itens) && p.itens.length > 0 ? p.itens : [{ nome: '-', qtd: 0, preco: 0 }];
    for (const it of itens) {
      const qtd = Number(it?.qtd || 0);
      const preco = Number(it?.preco || 0);
      const subtotal = qtd * preco;
      linhas.push(
        [
          escaparCelulaCsv(noite),
          escaparCelulaCsv(hora),
          escaparCelulaCsv(cod),
          escaparCelulaCsv(p.nome),
          escaparCelulaCsv(p.local),
          escaparCelulaCsv(it?.nome),
          String(qtd),
          preco.toFixed(2).replace('.', ','),
          subtotal.toFixed(2).replace('.', ','),
          escaparCelulaCsv(statusTxt),
          escaparCelulaCsv(pagoTxt),
        ].join(';')
      );
    }
  }

  const conteudo = '\uFEFF' + linhas.join('\r\n');
  const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rainbow-pub-relatorio-${noiteDe(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  mostrarToast('Arquivo CSV exportado.', 'sucesso');
});

document.getElementById('btn-imprimir-relatorio').addEventListener('click', () => {
  window.print();
});
