/**
 * Parcelas da proposta a partir da condição de pagamento (Cadastros › Condições de Pagamento).
 * Usado no editor (gera as parcelas) e no servidor (confere a soma). Teste: npx tsx src/utils/parcelas.test.ts
 */

/**
 * Forma de pagamento → tPag, a tabela de meios de pagamento do Portal Nacional da NF-e (PAF-NFC-e, Requisito XI, § 1º).
 * O nome é o que fica gravado na parcela (até 30 caracteres); os 7 primeiros são os de antes, para as parcelas antigas.
 * A mesma tabela está no server/menuFiscal.ts do erp-pdv (TPAG_VENDAS, registro A2): mudar lá também.
 */
export const TPAG: Record<string, string> = {
  Boleto: '15', PIX: '17', 'Cartão de crédito': '03', 'Cartão de débito': '04', Transferência: '18', Dinheiro: '01', Cheque: '02',
  'Cartão da loja': '05', 'Vale alimentação': '10', 'Vale refeição': '11', 'Vale presente': '12', 'Vale combustível': '13',
  'Depósito bancário': '16', 'Fidelidade / cashback': '19', 'PIX estático': '20', 'Crédito em loja': '21',
  'Pagamento eletrônico': '22', Outros: '99',
  // Só a NFC-e automática dos 180 dias (vendas.ts); não aparece na escolha da tela
  'Sem pagamento': '90',
};
export const FORMAS_PAGAMENTO = Object.keys(TPAG).filter((f) => f !== 'Sem pagamento');

export interface Parcela {
  numero: number;
  /** "aaaa-mm-dd" */
  vencimento: string;
  forma_pagamento: string;
  valor: number;
}

/** "0/30/60" (ou separado por vírgula, ponto e vírgula ou espaço) → [0, 30, 60]; vazio = à vista */
export function prazosDe(texto: string | null | undefined): number[] {
  const dias = String(texto ?? '')
    .split(/[\/,; ]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0);
  return dias.length ? dias : [0];
}

/** Data local + dias, em "aaaa-mm-dd" (sem passar por UTC) */
export function somarDias(iso: string, dias: number): string {
  const [a, m, d] = iso.slice(0, 10).split('-').map(Number);
  const r = new Date(a, m - 1, d + dias);
  return `${r.getFullYear()}-${String(r.getMonth() + 1).padStart(2, '0')}-${String(r.getDate()).padStart(2, '0')}`;
}

/** Divide o total em partes iguais (em centavos); a diferença do arredondamento vai na última */
export function dividirValor(total: number, partes: number): number[] {
  const cent = Math.round(total * 100);
  const cada = Math.floor(cent / partes);
  return Array.from({ length: partes }, (_, i) => (i === partes - 1 ? cent - cada * (partes - 1) : cada) / 100);
}

/** Uma parcela por prazo, vencendo em base + prazo, com a forma padrão da condição */
export function gerarParcelas(prazos: string | null | undefined, total: number, baseIso: string, forma: string): Parcela[] {
  const dias = prazosDe(prazos);
  const valores = dividirValor(total, dias.length);
  return dias.map((d, i) => ({ numero: i + 1, vencimento: somarDias(baseIso, d), forma_pagamento: forma, valor: valores[i] }));
}

/** Soma em centavos (evita 0,1 + 0,2) */
export const somaParcelas = (valores: (number | string)[]) => valores.reduce<number>((s, v) => s + Math.round((Number(v) || 0) * 100), 0) / 100;

/**
 * Recalcular: as parcelas ajustadas à mão ficam como estão; o que falta para o total é dividido entre as outras.
 * Sem parcela livre, ou com as ajustadas já passando do total, devolve a lista sem mudar (a tela mostra a diferença).
 */
export function redistribuir<T extends { valor: number; ajustada: boolean }>(lista: T[], total: number): T[] {
  const livres = lista.filter((p) => !p.ajustada).length;
  const resto = Math.round((total - somaParcelas(lista.filter((p) => p.ajustada).map((p) => p.valor))) * 100) / 100;
  if (!livres || resto <= 0) return lista;
  const valores = dividirValor(resto, livres);
  let k = 0;
  return lista.map((p) => (p.ajustada ? p : { ...p, valor: valores[k++] }));
}
