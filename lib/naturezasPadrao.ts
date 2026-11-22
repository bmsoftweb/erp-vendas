/**
 * Naturezas de operação prontas (botão "Naturezas padrão" da tela Naturezas), combinadas com o usuário.
 * CFOPs conferidos na fis_cfop (tabela oficial do Portal da NF-e, vigentes e com ind_nfe = 1).
 * Todas NF-e; o servidor inclui só as que ainda não existem com o mesmo nome na empresa.
 */
export interface NaturezaPadrao {
  descricao: string;
  /** finNFe: 1 normal, 4 devolução */
  finalidade: 1 | 4;
  /** tpNF: 0 entrada, 1 saída */
  tipo_operacao: 0 | 1;
  cfop_estadual: string;
  cfop_interestadual: string;
  consumidor_final: 0 | 1;
  movimenta_estoque: 0 | 1;
}

const n = (descricao: string, cfop_estadual: string, cfop_interestadual: string, extra: Partial<NaturezaPadrao> = {}): NaturezaPadrao => ({
  descricao, finalidade: 1, tipo_operacao: 1, cfop_estadual, cfop_interestadual, consumidor_final: 0, movimenta_estoque: 1, ...extra,
});

// Remessas que voltam (demonstração, conserto), retorno de bem de terceiro e outras saídas não mexem no estoque
const semEstoque = { movimenta_estoque: 0 } as const;

export const NATUREZAS_PADRAO: NaturezaPadrao[] = [
  n('Venda de mercadoria', '5102', '6102'),
  n('Venda de produção', '5101', '6101'),
  n('Venda de mercadoria com ST', '5405', '6404'),
  n('Venda a não contribuinte', '5102', '6108', { consumidor_final: 1 }),
  n('Devolução de compra', '5202', '6202', { finalidade: 4 }),
  n('Remessa em bonificação, doação ou brinde', '5910', '6910'),
  n('Remessa de amostra grátis', '5911', '6911'),
  n('Remessa para demonstração', '5912', '6912', semEstoque),
  n('Remessa para conserto', '5915', '6915', semEstoque),
  n('Retorno de conserto', '5916', '6916', semEstoque),
  n('Outras saídas', '5949', '6949', semEstoque),
  n('Devolução de venda', '1202', '2202', { finalidade: 4, tipo_operacao: 0 }),
];
