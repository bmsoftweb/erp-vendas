import { Router } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { dataIso, falha, idOuNull, rota } from './http.js';
import { conferirModelo, DFE_DE, hojeSql, inserirNumerado, lerDav, modeloExigido, naturezaDeVenda, transacao } from './davs.js';
import { totais, totalItem } from '../lib/totais.js';
import { gerarParcelas, somaParcelas, TPAG } from '../lib/parcelas.js';
import { ehVenda } from '../lib/modelo.js';
import { documentoValido } from '../lib/documento.js';
import { conferirCredito } from './financ.js';

/**
 * Vendas (ven_vendas): o faturamento que vira nota. Nasce de pedidos (Faturar pedidos, pode juntar
 * vários do mesmo cliente e faturar parte) ou direto na tela. Só a venda "aberta" (sem nota) muda.
 * O pedido fica parcial/faturado conforme o que já está em vendas não canceladas.
 */

/** Quantidade já faturada por item de pedido (vendas não canceladas) */
export const FATURADO = `SELECT vi.dav_item_id, SUM(vi.quantidade) AS q FROM ven_venda_itens vi
                   JOIN ven_vendas v ON v.id = vi.venda_id WHERE v.status <> 'cancelada' GROUP BY vi.dav_item_id`;

/** DAV (alias) emitido há mais de 180 dias; pedido que veio de orçamento conta desde o orçamento */
export const EMITIDO_HA_180 = (d: string) => `(${d}.data_emissao < CURDATE() - INTERVAL 180 DAY
  OR EXISTS(SELECT 1 FROM ven_davs o180 WHERE o180.id = ${d}.orcamento_id AND o180.data_emissao < CURDATE() - INTERVAL 180 DAY))`;

/**
 * Venda (alias) com item de pedido emitido há mais de 180 dias. Sem nota (aberta, faturando, rejeitada), o pedido
 * fica "faturado" mas sem DF-e: a rotina dos 180 dias emite a venda e a tela avisa enquanto ela não sair.
 */
export const DAV_VENCIDO = (v: string) => `EXISTS(SELECT 1 FROM ven_venda_itens vi JOIN ven_dav_itens di ON di.id = vi.dav_item_id
  JOIN ven_davs d ON d.id = di.dav_id WHERE vi.venda_id = ${v}.id AND ${EMITIDO_HA_180('d')})`;

/** Em décimos de milésimo, para comparar quantidades DECIMAL(15,4) sem erro de ponto flutuante */
const q4 = (v: unknown) => Math.round(Number(v) * 10000);

/**
 * Recalcula a situação dos pedidos: todos os itens faturados → faturado; algum → parcial; nenhum → aberto.
 * Pedido que já teve DF-e (nota cancelada) não volta a aberto: fica baixado, sem alteração nem reimpressão, e o saldo
 * vai num DAV novo (PAF-NFC-e, Requisito V, § 1º, III, a e b).
 */
export async function atualizarPedidos(c: PoolConnection, davIds: number[]) {
  if (!davIds.length) return;
  const [linhas]: any = await c.query(
    `SELECT i.dav_id, COUNT(*) AS itens, SUM(COALESCE(f.q, 0) >= i.quantidade) AS completos, SUM(COALESCE(f.q, 0) > 0) AS com_venda, ${DFE_DE('i.dav_id')} AS com_dfe
       FROM ven_dav_itens i LEFT JOIN (${FATURADO}) f ON f.dav_item_id = i.id
      WHERE i.dav_id IN (?) AND i.cancelado = 0 GROUP BY i.dav_id`,
    [davIds],
  );
  for (const l of linhas) {
    const status = Number(l.completos) === Number(l.itens) ? 'faturado' : Number(l.com_venda) ? 'parcial' : 'aberto';
    if (status === 'aberto' && Number(l.com_dfe))
      await c.query("UPDATE ven_davs SET status = 'baixado', baixado_em = NOW(), baixa_motivo = 'DF-e cancelado: o saldo vai em DAV novo' WHERE id = ? AND status <> 'baixado'", [l.dav_id]);
    else await c.query("UPDATE ven_davs SET status = ? WHERE id = ? AND status <> 'baixado'", [status, l.dav_id]);
  }
}

/** Intermediador ativo da empresa do tipo pedido (P pagamento, T transação), cadastrado no erp-pdv */
async function intermediador(c: PoolConnection, empresa: number, id: unknown, tipo: 'P' | 'T', rotulo: string) {
  if (!id) return null;
  const [[i]]: any = await c.query('SELECT id FROM cad_intermediadores WHERE id = ? AND empresa_id = ? AND tipo = ? AND ativo = 1', [id, empresa, tipo]);
  if (!i) falha(`${rotulo}: intermediador inválido.`);
  return i.id as number;
}

/**
 * Parcelas da venda com os dados do pagamento da NFC-e/NF-e (PAF-NFC-e, Requisito XI): intermediador, CNPJ
 * transacional com a UF e, no cartão, bandeira e autorização. `extras[n]` é a parcela n como veio da tela (lerDav só
 * devolve vencimento, forma e valor). Da tela, o intermediador é obrigatório, sem padrão (Teste 7, vii), menos no
 * "Sem pagamento" (tPag 90); o Faturar grava sem ele, e a emissão recusa até informarem na venda.
 */
async function gravarParcelas(c: PoolConnection, empresa: number, vendaId: number, parcelas: any[], extras?: any[]) {
  const [[v]]: any = await c.query('SELECT pessoa_id, data_emissao FROM ven_vendas WHERE id = ?', [vendaId]);
  await conferirCredito(empresa, v.pessoa_id, String(v.data_emissao).slice(0, 10), parcelas);
  await c.query('DELETE FROM ven_venda_parcelas WHERE venda_id = ?', [vendaId]);
  for (const [n, p] of parcelas.entries()) {
    const e = extras?.[n] ?? {};
    const rotulo = `Pagamento ${n + 1}`;
    const cnpj_pag = String(e.cnpj_pag ?? '').replace(/\D/g, '') || null;
    const uf_pag = String(e.uf_pag ?? '').trim().toUpperCase() || null;
    if (cnpj_pag && (cnpj_pag.length !== 14 || !documentoValido(cnpj_pag))) falha(`${rotulo}: CNPJ transacional inválido.`);
    if (!cnpj_pag !== !uf_pag || (uf_pag && !/^[A-Z]{2}$/.test(uf_pag))) falha(`${rotulo}: informe o CNPJ transacional junto com a UF.`);
    const bandeira = String(e.bandeira ?? '').trim() || null;
    if (bandeira && !/^\d{2}$/.test(bandeira)) falha(`${rotulo}: bandeira inválida.`);
    const intermediador_id = await intermediador(c, empresa, e.intermediador_id ?? p.intermediador_id, 'P', rotulo);
    if (extras && !intermediador_id && TPAG[p.forma_pagamento] !== '90') falha(`${rotulo}: informe o intermediador do pagamento (PAF-NFC-e, Requisito XI).`);
    await c.query('INSERT INTO ven_venda_parcelas SET ?', [{
      ...p, venda_id: vendaId, cnpj_pag, uf_pag, bandeira, intermediador_id,
      autorizacao: String(e.autorizacao ?? '').trim().slice(0, 128) || null,
    }]);
  }
}

async function vendaAberta(c: PoolConnection, id: unknown, empresa: number, alterar = false) {
  const [[v]]: any = await c.query('SELECT * FROM ven_vendas WHERE id = ? AND empresa_id = ? FOR UPDATE', [id, empresa]);
  if (!v) falha('Venda não encontrada.', 404);
  // Rejeitada: corrige e emite de novo com a mesma referência (o número da nota fica)
  if (v.status !== 'aberta' && !(alterar && v.status === 'rejeitada')) falha(`Venda ${v.numero} está ${v.status}: não pode ser ${alterar ? 'alterada' : 'cancelada'}.`, 409);
  return v;
}

/**
 * Fatura itens de pedido numa venda nova (Faturar pedidos e a NFC-e dos 180 dias). `qtd` = dav_item_id → quantidade.
 * opc: natureza e cliente no lugar dos do pedido (pessoa_id null = consumidor), pagamento "Sem pagamento" (tPag 90) e texto a mais nas informações complementares.
 */
export async function faturarItens(c: PoolConnection, empresa: number, uid: number | null, qtd: Map<number, number>,
  opc: { natureza_id?: number; pessoa_id?: number | null; semPagamento?: boolean; info?: string } = {}) {
  const [itens]: any = await c.query(
    `SELECT i.*, (SELECT iat FROM cad_produtos WHERE id = i.produto_id) AS iat, LPAD(d.numero, 10, '0') AS pedido, d.status AS status_pedido, d.natureza_id, d.pessoa_id, d.vendedor_id, d.condicao_pagamento_id,
            d.modalidade_frete, d.transportadora_id, d.valor_frete AS frete_pedido, d.valor_total AS total_pedido,
            d.observacoes, d.informacoes_complementares
       FROM ven_dav_itens i JOIN ven_davs d ON d.id = i.dav_id
      WHERE i.id IN (?) AND d.empresa_id = ? AND d.tipo = 'pedido' AND i.cancelado = 0
      ORDER BY d.numero, i.item
        FOR UPDATE`,
    [[...qtd.keys()], empresa],
  );
  if (itens.length !== qtd.size) falha('Item de pedido não encontrado.');
  const [fat]: any = await c.query(`SELECT * FROM (${FATURADO}) f WHERE f.dav_item_id IN (?)`, [[...qtd.keys()]]);
  const jaFaturado = new Map<number, number>(fat.map((f: any) => [f.dav_item_id, Number(f.q)]));

  const p0 = itens[0];
  let natureza_id = opc.natureza_id ?? p0.natureza_id;
  const pessoa_id = opc.pessoa_id !== undefined ? opc.pessoa_id : p0.pessoa_id;
  if (itens.some((i: any) => i.pessoa_id !== p0.pessoa_id || i.natureza_id !== p0.natureza_id))
    falha('Os pedidos de uma venda precisam ser do mesmo cliente e da mesma natureza de operação.');

  const linhas = itens.map((i: any, n: number) => {
    if (!['aberto', 'parcial'].includes(i.status_pedido)) falha(`Pedido ${i.pedido} está ${i.status_pedido}: não pode ser faturado.`, 409);
    const quantidade = qtd.get(i.id)!;
    const saldo = (q4(i.quantidade) - q4(jaFaturado.get(i.id) ?? 0)) / 10000;
    if (q4(quantidade) > q4(saldo)) falha(`Pedido ${i.pedido}, item ${i.item}: a faturar ${quantidade.toLocaleString('pt-BR')} passa do saldo ${saldo.toLocaleString('pt-BR')}.`);
    const inteiro = q4(quantidade) === q4(i.quantidade);
    const desconto = inteiro ? Number(i.valor_desconto) : Math.round((Number(i.valor_desconto) * quantidade) / Number(i.quantidade) * 100) / 100;
    const base = { quantidade, preco_unitario: Number(i.preco_unitario), valor_desconto: desconto };
    return {
      item: n + 1, dav_item_id: i.id, produto_id: i.produto_id, variante_id: i.variante_id,
      descricao: i.descricao, unidade: i.unidade, ...base, valor_total: totalItem({ ...base, iat: i.iat }),
    };
  });

  const davIds = [...new Set<number>(itens.map((i: any) => i.dav_id))];
  const cabPedido = (id: number) => itens.find((i: any) => i.dav_id === id);
  const frete = davIds.reduce((s, id) => s + (cabPedido(id).status_pedido === 'aberto' ? Math.round(Number(cabPedido(id).frete_pedido) * 100) : 0), 0) / 100;
  const t = totais(linhas.map((l: any) => ({ ...l, iat: itens.find((x: any) => x.id === l.dav_item_id)?.iat })), frete);
  // Faturar: natureza de venda do pedido com o modelo errado para o cliente ou o total → a de venda do modelo certo (como a rotina dos 180 dias)
  if (opc.natureza_id === undefined) {
    const [[n]]: any = await c.query('SELECT documento, cfop_estadual FROM ven_naturezas_operacao WHERE id = ?', [natureza_id]);
    const m = await modeloExigido(c, empresa, pessoa_id, t.valor_total);
    if (n && n.documento !== 'nfse' && ehVenda(n.cfop_estadual) && n.documento !== m) natureza_id = await naturezaDeVenda(c, empresa, m, natureza_id);
  }
  await conferirModelo(c, empresa, natureza_id, pessoa_id, t.valor_total); // R$ 200 mil ou mais: NF-e (Anexo 11, art. 96, § 7º)
  const juntar = (campo: string) => [...new Set(davIds.map((id) => String(cabPedido(id)[campo] ?? '').trim()).filter(Boolean))].join('\n') || null;

  // Data e vencimentos pelo relógio do MySQL (sessão em -03:00)
  const [[{ hoje }]]: any = await c.query('SELECT CURDATE() AS hoje');
  let parcelas: any[] = opc.semPagamento ? [{ numero: 1, vencimento: hoje, forma_pagamento: 'Sem pagamento', valor: t.valor_total }] : [];
  if (!opc.semPagamento && davIds.length === 1 && t.valor_total === Number(p0.total_pedido)) {
    const [pp]: any = await c.query('SELECT numero, vencimento, forma_pagamento, valor FROM ven_dav_parcelas WHERE dav_id = ? ORDER BY numero', [p0.dav_id]);
    if (pp.length && somaParcelas(pp.map((p: any) => p.valor)) === t.valor_total) parcelas = pp;
  }
  if (!opc.semPagamento && !parcelas.length && p0.condicao_pagamento_id) {
    const [[cp]]: any = await c.query('SELECT prazos, forma_pagamento FROM crm_condicoes_pagamento WHERE id = ?', [p0.condicao_pagamento_id]);
    if (cp && t.valor_total > 0) parcelas = gerarParcelas(cp.prazos, t.valor_total, hoje, cp.forma_pagamento || 'Boleto');
  }

  const venda = await inserirNumerado(c, 'ven_vendas', {
    natureza_id, pessoa_id, vendedor_id: p0.vendedor_id, condicao_pagamento_id: p0.condicao_pagamento_id,
    data_emissao: hoje, origem: 'pedido', modalidade_frete: p0.modalidade_frete, transportadora_id: p0.transportadora_id,
    ...t, observacoes: juntar('observacoes'), informacoes_complementares: [juntar('informacoes_complementares'), opc.info].filter(Boolean).join('\n') || null, usuario_id: uid,
  }, empresa);
  for (const l of linhas) await c.query('INSERT INTO ven_venda_itens SET ?', [{ ...l, venda_id: venda.id }]);
  await gravarParcelas(c, empresa, venda.id, parcelas);
  await atualizarPedidos(c, davIds);
  return venda;
}

/**
 * Caixa da pré-venda: a senha do consumidor abre a venda com o saldo do pedido. O operador pode trocar a natureza
 * (NFC-e ↔ NF-e) e o cliente aqui; a NF-e exige cliente.
 */
export async function caixaPrevenda(empresa: number, uid: number | null, b: any) {
  const senha = String(b?.senha ?? '').replace(/\D/g, '');
  if (senha.length !== 6) falha('Informe a senha da pré-venda (6 dígitos).');
  const [[d]]: any = await pool.query(
    "SELECT id, natureza_id, pessoa_id FROM ven_davs WHERE empresa_id = ? AND tipo = 'pedido' AND prevenda_senha = ? AND status IN ('aberto', 'parcial')",
    [empresa, senha],
  );
  if (!d) falha(`Nenhuma pré-venda em aberto com a senha ${senha}.`, 404);
  const natureza_id = idOuNull(b?.natureza_id) ?? d.natureza_id;
  const [[nat]]: any = await pool.query("SELECT documento FROM ven_naturezas_operacao WHERE id = ? AND empresa_id = ? AND ativo = 1 AND documento IN ('nfe', 'nfce')", [natureza_id, empresa]);
  if (!nat) falha('Natureza de operação inválida: escolha uma de NF-e ou NFC-e ativa.');
  const pessoa_id = b && 'pessoa_id' in b ? idOuNull(b.pessoa_id) : d.pessoa_id;
  if (pessoa_id) {
    const [[ok]]: any = await pool.query(
      'SELECT 1 FROM cad_pessoas WHERE id = ? AND date_delete IS NULL AND grupo_id = (SELECT grupo_id FROM sys_empresas WHERE id = ?)', [pessoa_id, empresa]);
    if (!ok) falha('Cliente não encontrado nesta empresa.');
  } else if (nat.documento !== 'nfce') falha('Para NF-e, informe o cliente.');
  const [saldos]: any = await pool.query(
    `SELECT i.id, i.quantidade - COALESCE(f.q, 0) AS saldo FROM ven_dav_itens i LEFT JOIN (${FATURADO}) f ON f.dav_item_id = i.id
      WHERE i.dav_id = ? AND i.cancelado = 0 HAVING saldo > 0`,
    [d.id],
  );
  if (!saldos.length) falha('A pré-venda não tem saldo a faturar.', 409);
  const qtd = new Map<number, number>(saldos.map((x: any) => [x.id, Number(x.saldo)]));
  return transacao((c) => faturarItens(c, empresa, uid, qtd, { natureza_id, pessoa_id }));
}

export function createVendasRouter() {
  const r = Router();

  r.get('/vendas', rota(async (req, _res, s) => {
    const filtros: string[] = [];
    const args: unknown[] = [empresaDa(s)];
    if (req.query.de) (filtros.push('v.data_emissao >= ?'), args.push(dataIso(req.query.de, 'De')));
    if (req.query.ate) (filtros.push('v.data_emissao <= ?'), args.push(dataIso(req.query.ate, 'Até')));
    if (req.query.status) (filtros.push('v.status = ?'), args.push(String(req.query.status)));
    const [linhas] = await pool.query(
      `SELECT v.id, v.numero, v.data_emissao, v.status, v.valor_total, v.origem,
              p.nome AS cliente, p.cpf_cnpj, n.descricao AS natureza, n.documento,
              nd.situacao AS situacao_nota, nd.serie AS serie_nota, COALESCE(nd.numero, ns.numero_nfse) AS numero_nota,
              SUBSTRING(nd.chave, 35, 1) = '9' AS contingencia,
              u.nome AS vendedor, op.nome AS operador,
              (SELECT GROUP_CONCAT(DISTINCT LPAD(d.numero, 10, '0') ORDER BY d.numero SEPARATOR ', ')
                 FROM ven_venda_itens vi JOIN ven_dav_itens di ON di.id = vi.dav_item_id JOIN ven_davs d ON d.id = di.dav_id
                WHERE vi.venda_id = v.id) AS pedidos
         FROM ven_vendas v
         JOIN ven_naturezas_operacao n ON n.id = v.natureza_id
         LEFT JOIN cad_pessoas p ON p.id = v.pessoa_id
         LEFT JOIN cad_vendedores u ON u.id = v.vendedor_id
         LEFT JOIN nfe_documentos nd ON nd.id = v.nfe_documento_id
         LEFT JOIN nfs_notas ns ON ns.id = v.nfs_nota_id
         LEFT JOIN sys_usuarios op ON op.id = v.usuario_id
        WHERE v.empresa_id = ? ${filtros.map((f) => `AND ${f}`).join(' ')}
        ORDER BY v.numero DESC
        LIMIT 1000`,
      args,
    );
    return linhas;
  }));

  /** Itens de pedidos abertos/parciais com saldo a faturar */
  /** Vendas sem nota com pedido de mais de 180 dias (aviso da lista de vendas) */
  r.get('/vendas/dav-vencido', rota(async (_req, _res, s) => {
    const [linhas] = await pool.query(
      `SELECT v.id, v.numero, v.status FROM ven_vendas v
        WHERE v.empresa_id = ? AND v.status IN ('aberta', 'faturando', 'rejeitada') AND ${DAV_VENCIDO('v')} ORDER BY v.numero`,
      [empresaDa(s)],
    );
    return linhas;
  }));

  r.get('/vendas/pendentes', rota(async (req, _res, s) => {
    const args: unknown[] = [empresaDa(s)];
    const pessoa = idOuNull(req.query.pessoa_id);
    if (pessoa) args.push(pessoa);
    const [linhas] = await pool.query(
      `SELECT d.id AS dav_id, d.numero, d.prevenda_senha, d.data_emissao, d.status, d.valor_frete, d.pessoa_id, p.nome AS cliente, p.cpf_cnpj,
              d.natureza_id, n.descricao AS natureza, i.id AS item_id, i.item, i.descricao, i.unidade,
              i.quantidade, i.preco_unitario, i.valor_desconto, COALESCE(f.q, 0) AS faturado,
              (SELECT iat FROM cad_produtos WHERE id = i.produto_id) AS iat
         FROM ven_davs d
         JOIN ven_dav_itens i ON i.dav_id = d.id
         JOIN ven_naturezas_operacao n ON n.id = d.natureza_id
         LEFT JOIN cad_pessoas p ON p.id = d.pessoa_id
         LEFT JOIN (${FATURADO}) f ON f.dav_item_id = i.id
        WHERE d.empresa_id = ? AND d.tipo = 'pedido' AND d.status IN ('aberto', 'parcial')
          ${pessoa ? 'AND d.pessoa_id = ?' : ''} AND i.cancelado = 0 AND i.quantidade > COALESCE(f.q, 0)
        ORDER BY d.numero, i.item
        LIMIT 2000`,
      args,
    );
    return linhas;
  }));

  r.get('/vendas/:id', rota(async (req, _res, s) => {
    const [[v]]: any = await pool.query(
      `SELECT v.*, p.nome AS cliente, p.cpf_cnpj, t.nome AS transportadora,
              SUBSTRING(nd.chave, 35, 1) = '9' AS contingencia
         FROM ven_vendas v LEFT JOIN cad_pessoas p ON p.id = v.pessoa_id LEFT JOIN cad_pessoas t ON t.id = v.transportadora_id
         LEFT JOIN nfe_documentos nd ON nd.id = v.nfe_documento_id
        WHERE v.id = ? AND v.empresa_id = ?`,
      [req.params.id, empresaDa(s)],
    );
    if (!v) falha('Venda não encontrada.', 404);
    const [itens] = await pool.query(
      `SELECT vi.*, (SELECT iat FROM cad_produtos WHERE id = vi.produto_id) AS iat, LPAD(d.numero, 10, '0') AS pedido FROM ven_venda_itens vi
         LEFT JOIN ven_dav_itens di ON di.id = vi.dav_item_id LEFT JOIN ven_davs d ON d.id = di.dav_id
        WHERE vi.venda_id = ? ORDER BY vi.item`,
      [v.id],
    );
    const [parcelas] = await pool.query('SELECT * FROM ven_venda_parcelas WHERE venda_id = ? ORDER BY numero', [v.id]);
    return { ...v, itens, parcelas };
  }));

  /** Venda direta, sem pedido */
  r.post('/vendas', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    return transacao(async (c) => {
      const { cabecalho, linhas, linhasParcelas } = await lerDav(c, req.body, empresa, true);
      const { validade: _v, ...cab } = cabecalho;
      cab.data_emissao = await hojeSql(c); // data pelo servidor: conta os 180 dias (Requisito V, § 2º)
      const intermediador_transacao_id = await intermediador(c, empresa, req.body?.intermediador_transacao_id, 'T', 'Transação');
      const venda = await inserirNumerado(c, 'ven_vendas', { ...cab, intermediador_transacao_id, origem: 'tela', usuario_id: s.userId ?? null }, empresa);
      for (const l of linhas) await c.query('INSERT INTO ven_venda_itens SET ?', [{ ...l, venda_id: venda.id }]);
      await gravarParcelas(c, empresa, venda.id, linhasParcelas, req.body?.parcelas);
      return venda;
    });
  }));

  /** Venda de pedido: itens, cliente e natureza ficam como faturados; muda o resto */
  r.put('/vendas/:id', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    await transacao(async (c) => {
      const v = await vendaAberta(c, req.params.id, empresa, true);
      // Contingência recusada: o DANFE já foi entregue; gera de novo sem mudar o que define o imposto (art. 104, § 4º, I)
      const [[nc]]: any = v.nfe_documento_id ? await c.query('SELECT chave FROM nfe_documentos WHERE id = ?', [v.nfe_documento_id]) : [[null]];
      const contingencia = String(nc?.chave ?? '').charAt(34) === '9';
      const dePedido = v.origem === 'pedido' || contingencia;
      const corpo = { ...req.body };
      if (contingencia) Object.assign(corpo, { valor_frete: v.valor_frete });
      if (dePedido) {
        const [itens] = await c.query('SELECT * FROM ven_venda_itens WHERE venda_id = ? ORDER BY item', [v.id]);
        Object.assign(corpo, { itens, natureza_id: v.natureza_id, pessoa_id: v.pessoa_id });
      }
      const { cabecalho, linhas, linhasParcelas } = await lerDav(c, corpo, empresa, true, !dePedido); // produto inativo: só recusa o item incluído aqui
      const { validade: _v, data_emissao: _d, ...cab } = cabecalho; // a data da venda não muda depois de gravada
      const intermediador_transacao_id = await intermediador(c, empresa, req.body?.intermediador_transacao_id, 'T', 'Transação');
      await c.query('UPDATE ven_vendas SET ? WHERE id = ?', [{ ...cab, intermediador_transacao_id }, v.id]);
      if (!dePedido) {
        await c.query('DELETE FROM ven_venda_itens WHERE venda_id = ?', [v.id]);
        for (const l of linhas) await c.query('INSERT INTO ven_venda_itens SET ?', [{ ...l, venda_id: v.id }]);
      }
      await gravarParcelas(c, empresa, v.id, linhasParcelas, req.body?.parcelas);
    });
  }));

  /**
   * Faturar: { itens: [{ dav_item_id, quantidade }] } de um ou mais pedidos do mesmo cliente e natureza.
   * Desconto proporcional na parte faturada; o frete do pedido entra na primeira venda dele.
   * Parcelas: as do pedido quando é um só, inteiro e elas fecham o total; senão, geradas pela condição.
   */
  r.post('/vendas/faturar', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    const pedidos: any[] = (Array.isArray(req.body?.itens) ? req.body.itens : []).filter((i: any) => Number(i?.quantidade) > 0);
    if (!pedidos.length) falha('Informe a quantidade a faturar de pelo menos um item.');
    const qtd = new Map<number, number>(pedidos.map((i) => [idOuNull(i.dav_item_id) ?? falha('Item inválido.'), Number(i.quantidade)]));
    return transacao((c) => faturarItens(c, empresa, s.userId ?? null, qtd));
  }));

  r.post('/vendas/prevenda', rota(async (req, _res, s) => caixaPrevenda(empresaDa(s), s.userId ?? null, req.body)));

  /** Venda sem nota: cancela e devolve o saldo aos pedidos. Com nota, o cancelamento passa pelo erp-nfe/erp-nfs (próxima etapa). */
  r.post('/vendas/:id/cancelar', rota(async (req, _res, s) => {
    await transacao(async (c) => {
      const v = await vendaAberta(c, req.params.id, empresaDa(s));
      await c.query("UPDATE ven_vendas SET status = 'cancelada', cancelado_em = NOW() WHERE id = ?", [v.id]);
      const [davs]: any = await c.query('SELECT DISTINCT di.dav_id FROM ven_venda_itens vi JOIN ven_dav_itens di ON di.id = vi.dav_item_id WHERE vi.venda_id = ?', [v.id]);
      await atualizarPedidos(c, davs.map((d: any) => d.dav_id));
    });
  }));

  return r;
}
