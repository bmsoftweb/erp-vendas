/**
 * Totais de orçamento, pedido e venda, iguais na tela e no servidor (o servidor recalcula e é o que vale).
 * Tudo em centavos inteiros para não acumular erro de ponto flutuante.
 */
export interface ItemValor {
  quantidade: number | string;
  preco_unitario: number | string;
  valor_desconto?: number | string | null;
}

const centavos = (v: number) => Math.round(v * 100 + (v >= 0 ? 1e-7 : -1e-7));

/** Bruto do item (quantidade × preço) em centavos; quantidade e preço têm até 4 casas */
export const brutoItem = (i: ItemValor) => centavos(Number(i.quantidade || 0) * Number(i.preco_unitario || 0));

/** Total do item em reais: bruto − desconto */
export const totalItem = (i: ItemValor) => (brutoItem(i) - centavos(Number(i.valor_desconto || 0))) / 100;

export function totais(itens: ItemValor[], frete: number | string = 0) {
  const produtos = itens.reduce((s, i) => s + brutoItem(i), 0);
  const desconto = itens.reduce((s, i) => s + centavos(Number(i.valor_desconto || 0)), 0);
  const fr = centavos(Number(frete || 0));
  return { valor_produtos: produtos / 100, valor_desconto: desconto / 100, valor_frete: fr / 100, valor_total: (produtos - desconto + fr) / 100 };
}

// Conferência: npx tsx lib/totais.ts
if (typeof process !== 'undefined' && process.argv[1]?.replace(/\\/g, '/').endsWith('lib/totais.ts')) {
  const ok = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  };
  ok(totalItem({ quantidade: 3, preco_unitario: 0.1 }), 0.3, '3 × 0,10');
  ok(totalItem({ quantidade: 1.5, preco_unitario: 33.3333, valor_desconto: 0.5 }), 49.5, '1,5 × 33,3333 − 0,50');
  ok(totais([{ quantidade: 2, preco_unitario: 10.005 }, { quantidade: 1, preco_unitario: 5, valor_desconto: 1 }], 7.5),
    { valor_produtos: 25.01, valor_desconto: 1, valor_frete: 7.5, valor_total: 31.51 }, 'pedido com frete');
  console.log('totais: ok');
}
