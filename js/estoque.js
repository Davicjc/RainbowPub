// Rainbow Pub — contas do controle de estoque (sem DOM, sem Firebase).
// Cada item de estoque (estoque/{id}) guarda a quantidade na unidade-base: un, g ou ml.
// Cada produto do cardápio (itens/{id}) pode ter uma "receita": o que sai do estoque a cada
// unidade vendida. Ex.: Heineken long neck → [{ insumo: 'heineken-ln', qtd: 1 }];
// Batata frita M → [{ insumo: 'batata', qtd: 300 }] (300 g).

export const UNIDADES = {
  un: { rotulo: 'Unidade', dica: 'garrafa, lata, espeto, maço', base: 'un', grande: null },
  g: { rotulo: 'Peso', dica: 'gramas e quilos', base: 'g', grande: 'kg' },
  ml: { rotulo: 'Volume', dica: 'mililitros e litros', base: 'ml', grande: 'L' },
};

const num = (v, casas = 2) =>
  Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: casas });

// 2400 g → "2,4 kg"; 800 g → "800 g"; 24 un → "24 un"; 1500 ml → "1,5 L"
export function formatarQtd(qtd, unidade = 'un') {
  const v = Number(qtd || 0);
  const u = UNIDADES[unidade] || UNIDADES.un;
  if (u.grande && Math.abs(v) >= 1000) return `${num(v / 1000)} ${u.grande}`;
  return `${num(v, unidade === 'un' ? 2 : 0)} ${u.base}`;
}

// Valor digitado numa unidade (kg, g, L, ml, un) → unidade-base do item de estoque.
export function paraBase(valor, unidadeDigitada) {
  const v = Number(String(valor ?? '').replace(',', '.'));
  if (!Number.isFinite(v)) return NaN;
  return unidadeDigitada === 'kg' || unidadeDigitada === 'L' ? v * 1000 : v;
}

// Unidades que dá para digitar para um item de estoque (a primeira é a mais usada).
export function unidadesDeEntrada(unidade) {
  if (unidade === 'g') return ['kg', 'g'];
  if (unidade === 'ml') return ['L', 'ml'];
  return ['un'];
}

// Atalhos de entrada (reposição) por tipo de medida, já na unidade-base.
export function atalhosDeEntrada(unidade) {
  if (unidade === 'g') return [500, 1000, 2000, 5000];
  if (unidade === 'ml') return [1000, 2000, 5000];
  return [1, 6, 12, 24];
}

// Situação do item de estoque para pintar a tela: zerado, baixo (no aviso) ou ok.
export function situacaoInsumo(ins) {
  const q = Number(ins?.qtd || 0);
  if (q <= 0) return 'zerado';
  if (q <= Number(ins?.minimo || 0)) return 'baixo';
  return 'ok';
}

export const receitaDe = (item) =>
  (Array.isArray(item?.receita) ? item.receita : []).filter((r) => r && r.insumo && Number(r.qtd) > 0);

// Quantas unidades do produto ainda dá para vender com o estoque atual (null = sem controle).
export function porcoesPossiveis(item, mapaEstoque) {
  const receita = receitaDe(item).filter((r) => mapaEstoque.has(r.insumo));
  if (!receita.length) return null;
  return Math.max(0, Math.min(...receita.map((r) => Math.floor(Number(mapaEstoque.get(r.insumo).qtd || 0) / Number(r.qtd)))));
}

// O que um pedido tira do estoque: { insumoId: quantidade }. Só conta itens de estoque que
// existem (um item apagado não pode travar a venda).
export function baixaDoPedido(itensPedido, mapaItens, mapaEstoque) {
  const baixa = {};
  for (const linha of Array.isArray(itensPedido) ? itensPedido : []) {
    const produto = mapaItens.get(linha?.id);
    const qtd = Number(linha?.qtd || 0);
    if (!produto || !(qtd > 0)) continue;
    for (const r of receitaDe(produto)) {
      if (!mapaEstoque.has(r.insumo)) continue;
      baixa[r.insumo] = (baixa[r.insumo] || 0) + Number(r.qtd) * qtd;
    }
  }
  return baixa;
}
