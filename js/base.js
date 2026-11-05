// Rainbow Pub — utilidades e dados compartilhados entre o cardápio (index.html) e o painel (adm/).
// Sem dependências. Tudo em ES module.

export const brl = (v) =>
  Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Escapa texto para innerHTML (nunca colocar dado do cliente cru no HTML).
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Distância em metros entre dois pontos (Haversine).
export function distancia(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Caixa (lat/lng mín/máx) usada pelas regras do Firestore: elas não têm seno/cosseno,
// então o painel calcula a caixa quando salva o ponto do bar e o raio.
export function caixaDe(lat, lng, raio) {
  const dLat = raio / 111320;
  const dLng = raio / (111320 * Math.cos((lat * Math.PI) / 180));
  return { latMin: lat - dLat, latMax: lat + dLat, lngMin: lng - dLng, lngMax: lng + dLng };
}

// "Noite" do bar: um pedido às 2h de sábado pertence à noite de sexta.
// Corte ao meio-dia: data de (instante − 12 h).
export function noiteDe(data) {
  const d = new Date(data.getTime() - 12 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const fmtH = (t) => { const [h, m] = String(t).split(':'); return Number(m) ? `${Number(h)}h${m}` : `${Number(h)}h`; };

// semana[0..6] (0 = domingo) = { abre: '19:00', fecha: '03:00' } ou null (fechado).
export function situacao(semana, agora = new Date()) {
  const dia = agora.getDay(), min = agora.getHours() * 60 + agora.getMinutes();
  const ontem = semana[(dia + 6) % 7], hoje = semana[dia];
  if (ontem && hm(ontem.fecha) < hm(ontem.abre) && min < hm(ontem.fecha))
    return { aberto: true, texto: `Aberto agora · até ${fmtH(ontem.fecha)}` };
  if (hoje) {
    const a = hm(hoje.abre), f = hm(hoje.fecha);
    const virada = f < a;
    if (min >= a && (virada || min < f)) return { aberto: true, texto: `Aberto agora · até ${fmtH(hoje.fecha)}` };
    if (min < a) return { aberto: false, texto: `Abre hoje às ${fmtH(hoje.abre)}` };
  }
  for (let i = 1; i <= 7; i++) {
    const d = semana[(dia + i) % 7];
    if (d) return { aberto: false, texto: `Abre ${i === 1 ? 'amanhã' : DIAS[(dia + i) % 7]} às ${fmtH(d.abre)}` };
  }
  return { aberto: false, texto: 'Fechado' };
}

export const STATUS = {
  novo: 'Recebido',
  preparo: 'Preparando',
  pronto: 'Pronto',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};

// Código curto do pedido mostrado ao cliente e no painel.
export const codigo = (id) => String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();

// ─── Conteúdo inicial (transcrito do cardápio impresso de 04/11/2026) ───
// Usado como semente do Firestore e como reserva se a internet/Firestore falhar.
export const LOJA_INICIAL = {
  nome: 'Rainbow Pub',
  aceitandoPedidos: true,
  endereco: 'Rua Professor Pedro Bernardo, 20 · Centro · Uberlândia-MG',
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Rainbow+Pub+Rua+Professor+Pedro+Bernardo+20+Uberl%C3%A2ndia',
  instagram: 'rainbowpubudi',
  whatsapp: '',
  aviso: '',
  locais: ['Mesa', 'Balcão', 'Sinuca', 'Calçada'],
  semana: [
    { abre: '19:00', fecha: '03:00' }, // domingo
    null,                               // segunda
    { abre: '19:00', fecha: '03:00' }, // terça
    { abre: '19:00', fecha: '03:00' }, // quarta
    { abre: '19:00', fecha: '03:00' }, // quinta
    { abre: '20:00', fecha: '05:00' }, // sexta
    { abre: '20:00', fecha: '05:00' }, // sábado
  ],
  horariosTexto: [
    'Terça a quinta, domingos e feriados · 19h às 3h',
    'Sexta, sábado e vésperas de feriado · 20h às 5h',
  ],
  // Centro da Rua Prof. Pedro Bernardo (OSM). Calibrar no painel com "usar minha localização" dentro do bar.
  gps: { ativo: true, lat: -18.9225574, lng: -48.2766035, raio: 150 },
};
LOJA_INICIAL.gps.caixa = caixaDe(LOJA_INICIAL.gps.lat, LOJA_INICIAL.gps.lng, LOJA_INICIAL.gps.raio);

// As seis faixas do arco-íris do letreiro, uma por categoria, na ordem do cardápio.
export const CATEGORIAS_INICIAIS = [
  { id: 'drinks',     nome: 'Drinks',              ordem: 1, cor: '#E5484D' },
  { id: 'cervejas',   nome: 'Cervejas',            ordem: 2, cor: '#F2892B' },
  { id: 'doses',      nome: 'Doses',               ordem: 3, cor: '#F5CB3B' },
  { id: 'porcoes',    nome: 'Porções',             ordem: 4, cor: '#3DBE6A' },
  { id: 'espetinhos', nome: 'Espetinhos',          ordem: 5, cor: '#3B82E0' },
  { id: 'sem-alcool', nome: 'Sem álcool', ordem: 6, cor: '#9157E0' },
];

let n = 0;
const i = (categoria, grupo, nome, preco, extra = {}) => ({ categoria, grupo, nome, preco, ordem: ++n, ativo: true, esgotado: false, desc: '', ...extra });

export const ITENS_INICIAIS = [
  // Drinks autorais — "cor" pinta o copo desenhado no cardápio (base, topo)
  i('drinks', 'Autorais', 'Caipirinha', 20, { desc: 'Limão', cor: ['#C9E26B', '#F3F7C8'] }),
  i('drinks', 'Autorais', 'Caipivodka', 23, { desc: 'Limão', cor: ['#B8DC5A', '#EEF6D2'] }),
  i('drinks', 'Autorais', 'Perereca Picante', 27, { desc: 'Catuaba de açaí, vinho tinto, leite condensado e pimenta', cor: ['#5E1530', '#A8335A'], destaque: true }),
  i('drinks', 'Autorais', 'Que show da Xuxa é esse?', 27, { desc: 'Morango, vodka de frutas vermelhas e leite condensado', cor: ['#E86A8C', '#F8C9D4'], destaque: true }),
  i('drinks', 'Autorais', 'Não sufoque o artista!', 30, { desc: 'Maçã verde, vodka e leite condensado', cor: ['#9BC56B', '#E4F0CF'], destaque: true }),
  i('drinks', 'Prontos · long neck', 'Skol Beats', 16),
  i('drinks', 'Prontos · long neck', 'Ice Smirnoff', 16),

  i('cervejas', 'Litrão', 'Brahma', 17),
  i('cervejas', 'Litrão', 'Budweiser', 18),
  i('cervejas', 'Litrão', 'Original', 20),
  i('cervejas', '600 ml', 'Brahma', 14),
  i('cervejas', '600 ml', 'Spaten', 18),
  i('cervejas', '600 ml', 'Heineken', 20),
  i('cervejas', 'Long neck 330 ml', 'Heineken', 12, { desc: 'Shot 250 ml' }),
  i('cervejas', 'Long neck 330 ml', 'Budweiser', 14),
  i('cervejas', 'Long neck 330 ml', 'Corona', 15),
  i('cervejas', 'Long neck 330 ml', 'Corona Zero', 15),

  i('doses', '', 'Campari', 18),
  i('doses', '', 'Canelinha', 7),
  i('doses', '', 'Tekila', 12),
  i('doses', '', 'Ypióca Ouro', 7),
  i('doses', '', 'Whisky Red Label', 25),
  i('doses', '', 'Gin', 13),
  i('doses', '', 'Vodka Absolut', 25),

  i('porcoes', '', 'Bolinho de arroz com muçarela', 38, { desc: '20 unidades' }),
  i('porcoes', '', 'Mini maia com muçarela', 43, { desc: '15 unidades' }),
  i('porcoes', '', 'Batata frita M', 27, { desc: '300 g' }),
  i('porcoes', '', 'Batata frita G', 37, { desc: '500 g' }),
  i('porcoes', '', 'Adicional de bacon e cheddar', 12, { desc: 'Para a batata' }),
  i('porcoes', '', 'Iscas de tilápia', 69, { desc: '500 g' }),
  i('porcoes', '', 'Mini quibe com queijo', 37, { desc: '20 unidades' }),
  i('porcoes', '', 'Bolinha de queijo', 35, { desc: '20 unidades' }),
  i('porcoes', '', 'Bolinho de mandioca com carne seca', 43, { desc: '20 unidades' }),

  i('espetinhos', 'Espetinhos', 'Fraldinha', 13),
  i('espetinhos', 'Espetinhos', 'Franbacon', 13),
  i('espetinhos', 'Espetinhos', 'Kafta', 13),
  i('espetinhos', 'Espetinhos', 'Almôndega com bacon', 13),
  i('espetinhos', 'Espetinhos', 'Cupim', 15),
  i('espetinhos', 'Acompanhamentos', 'Farofa, vinagrete e mandioca', 15),
  i('espetinhos', 'Jantinha', 'Jantinha', 35, { desc: '1 espetinho + arroz, feijão de caldo ou tropeiro, mandioca ou fritas e vinagrete. Diga nas observações o que prefere.', destaque: true }),

  i('sem-alcool', 'Refrigerantes lata · R$ 7', 'Coca-Cola', 7),
  i('sem-alcool', 'Refrigerantes lata · R$ 7', 'Coca-Cola Zero', 7),
  i('sem-alcool', 'Refrigerantes lata · R$ 7', 'Fanta Laranja', 7),
  i('sem-alcool', 'Refrigerantes lata · R$ 7', 'Fanta Guaraná', 7),
  i('sem-alcool', 'Refrigerantes lata · R$ 7', 'Guaraná Mineiro', 7),
  i('sem-alcool', 'Refrigerantes lata · R$ 7', 'Guaraná Mineiro Zero', 7),
  i('sem-alcool', 'Refrigerantes lata · R$ 7', 'Schweppes Citrus', 7),
  i('sem-alcool', 'Refrigerantes lata · R$ 7', 'Schweppes Tônica', 7),
  i('sem-alcool', 'Águas e energéticos', 'Água com gás', 6),
  i('sem-alcool', 'Águas e energéticos', 'Água sem gás', 6),
  i('sem-alcool', 'Águas e energéticos', 'Energético Red Bull', 20),
  i('sem-alcool', 'Águas e energéticos', 'CDB', 10),
  i('sem-alcool', 'Balcão', 'Ficha de sinuca', 4),
  i('sem-alcool', 'Balcão', 'Halls', 3.5),
  i('sem-alcool', 'Balcão', 'Trident', 4),
  i('sem-alcool', 'Balcão', 'Pirulito', 2),
  i('sem-alcool', 'Balcão', 'Cigarro avulso', 2),
  i('sem-alcool', 'Balcão', 'Palheiro J&L', 3),
  i('sem-alcool', 'Balcão', 'Palheiro Santropês', 4),
  i('sem-alcool', 'Balcão', 'Seda', 8),
  i('sem-alcool', 'Balcão', 'Isqueiro P', 8),
  i('sem-alcool', 'Balcão', 'Isqueiro G', 10),
];

// id estável para cada item da semente (slug da categoria + nome + grupo)
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
ITENS_INICIAIS.forEach((it) => { it.id = slug(`${it.categoria}-${it.grupo}-${it.nome}`).slice(0, 60); });
