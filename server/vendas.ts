import { Router } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { dataIso, falha, idOuNull, rota } from './http.js';
import { inserirNumerado, lerDav, transacao } from './davs.js';
import { totais, totalItem } from '../lib/totais.js';
import { gerarParcelas, somaParcelas } from '../lib/parcelas.js';

/**
 * Vendas (ven_vendas): o faturamento que vira nota. Nasce de pedidos (Faturar pedidos, pode juntar
 * vários do mesmo cliente e faturar parte) ou direto na tela. Só a venda "aberta" (sem nota) muda.
 * O pedido fica parcial/faturado conforme o que já está em vendas não canceladas.
 */

/** Quantidade já faturada por item de pedido (vendas não canceladas) */
const FATURADO = `SELECT vi.dav_item_id, SUM(vi.quantidade) AS q FROM ven_venda_itens vi
                   JOIN ven_vendas v ON v.id = vi.venda_id WHERE v.status <> 'cancelada' GROUP BY vi.dav_item_id`;

/** Em décimos de milésimo, para comparar quantidades DECIMAL(15,4) sem erro de ponto flutuante */
const q4 = (v: unknown) => Math.round(Number(v) * 10000);

/** Recalcula a situação dos pedidos: todos os itens faturados → faturado; algum → parcial; nenhum → aberto */
async function atualizarPedidos(c: PoolConnection, davIds: number[]) {
  if (!davIds.length) return;
  const [linhas]: any = await c.query(
    `SELECT i.dav_id, COUNT(*) AS itens, SUM(COALESCE(f.q, 0) >= i.quantidade) AS completos, SUM(COALESCE(f.q, 0) > 0) AS com_venda
       FROM ven_dav_itens i LEFT JOIN (${FATURADO}) f ON f.dav_item_id = i.id
      WHERE i.dav_id IN (?) GROUP BY i.dav_id`,
    [davIds],
  );
  for (const l of linhas) {
    const status = Number(l.completos) === Number(l.itens) ? 'faturado' : Number(l.com_venda) ? 'parcial' : 'aberto';
    await c.query("UPDATE ven_davs SET status = ? WHERE id = ? AND status <> 'cancelado'", [status, l.dav_id]);
  }
}

async function gravarParcelas(c: PoolConnection, vendaId: number, parcelas: any[]) {
  await c.query('DELETE FROM ven_venda_parcelas WHERE venda_id = ?', [vendaId]);
  for (const p of parcelas) await c.query('INSERT INTO ven_venda_parcelas SET ?', [{ ...p, venda_id: vendaId }]);
}

async function vendaAberta(c: PoolConnection, id: unknown, empresa: number, alterar = false) {
  const [[v]]: any = await c.query('SELECT * FROM ven_vendas WHERE id = ? AND empresa_id = ? FOR UPDATE', [id, empresa]);
  if (!v) falha('Venda não encontrada.', 404);
  // Rejeitada: corrige e emite de novo com a mesma referência (o número da nota fica)
  if (v.status !== 'aberta' && !(alterar && v.status === 'rejeitada')) falha(`Venda ${v.numero} está ${v.status}: não pode ser ${alterar ? 'alterada' : 'cancelada'}.`, 409);
  return v;
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
              u.nome AS vendedor,
              (SELECT GROUP_CONCAT(DISTINCT d.numero ORDER BY d.numero SEPARATOR ', ')
                 FROM ven_venda_itens vi JOIN ven_dav_itens di ON di.id = vi.dav_item_id JOIN ven_davs d ON d.id = di.dav_id
                WHERE vi.venda_id = v.id) AS pedidos
         FROM ven_vendas v
         JOIN ven_naturezas_operacao n ON n.id = v.natureza_id
         LEFT JOIN cad_pessoas p ON p.id = v.pessoa_id
         LEFT JOIN cad_vendedores u ON u.id = v.vendedor_id
        WHERE v.empresa_id = ? ${filtros.map((f) => `AND ${f}`).join(' ')}
        ORDER BY v.numero DESC
        LIMIT 1000`,
      args,
    );
    return linhas;
  }));

  /** Itens de pedidos abertos/parciais com saldo a faturar */
  r.get('/vendas/pendentes', rota(async (req, _res, s) => {
    const args: unknown[] = [empresaDa(s)];
    const pessoa = idOuNull(req.query.pessoa_id);
    if (pessoa) args.push(pessoa);
    const [linhas] = await pool.query(
      `SELECT d.id AS dav_id, d.numero, d.data_emissao, d.status, d.valor_frete, d.pessoa_id, p.nome AS cliente, p.cpf_cnpj,
              d.natureza_id, n.descricao AS natureza, i.id AS item_id, i.item, i.descricao, i.unidade,
              i.quantidade, i.preco_unitario, i.valor_desconto, COALESCE(f.q, 0) AS faturado
         FROM ven_davs d
         JOIN ven_dav_itens i ON i.dav_id = d.id
         JOIN ven_naturezas_operacao n ON n.id = d.natureza_id
         LEFT JOIN cad_pessoas p ON p.id = d.pessoa_id
         LEFT JOIN (${FATURADO}) f ON f.dav_item_id = i.id
        WHERE d.empresa_id = ? AND d.tipo = 'pedido' AND d.status IN ('aberto', 'parcial')
          ${pessoa ? 'AND d.pessoa_id = ?' : ''} AND i.quantidade > COALESCE(f.q, 0)
        ORDER BY d.numero, i.item
        LIMIT 2000`,
      args,
    );
    return linhas;
  }));

  r.get('/vendas/:id', rota(async (req, _res, s) => {
    const [[v]]: any = await pool.query(
      `SELECT v.*, p.nome AS cliente, p.cpf_cnpj, t.nome AS transportadora
         FROM ven_vendas v LEFT JOIN cad_pessoas p ON p.id = v.pessoa_id LEFT JOIN cad_pessoas t ON t.id = v.transportadora_id
        WHERE v.id = ? AND v.empresa_id = ?`,
      [req.params.id, empresaDa(s)],
    );
    if (!v) falha('Venda não encontrada.', 404);
    const [itens] = await pool.query(
      `SELECT vi.*, d.numero AS pedido FROM ven_venda_itens vi
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
      const { cabecalho, linhas, linhasParcelas } = await lerDav(c, req.body, empresa);
      const { validade: _v, ...cab } = cabecalho;
      const venda = await inserirNumerado(c, 'ven_vendas', { ...cab, origem: 'tela', usuario_id: s.userId ?? null }, empresa);
      for (const l of linhas) await c.query('INSERT INTO ven_venda_itens SET ?', [{ ...l, venda_id: venda.id }]);
      await gravarParcelas(c, venda.id, linhasParcelas);
      return venda;
    });
  }));

  /** Venda de pedido: itens, cliente e natureza ficam como faturados; muda o resto */
  r.put('/vendas/:id', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    await transacao(async (c) => {
      const v = await vendaAberta(c, req.params.id, empresa, true);
      const dePedido = v.origem === 'pedido';
      const corpo = { ...req.body };
      if (dePedido) {
        const [itens] = await c.query('SELECT * FROM ven_venda_itens WHERE venda_id = ? ORDER BY item', [v.id]);
        Object.assign(corpo, { itens, natureza_id: v.natureza_id, pessoa_id: v.pessoa_id });
      }
      const { cabecalho, linhas, linhasParcelas } = await lerDav(c, corpo, empresa);
      const { validade: _v, ...cab } = cabecalho;
      await c.query('UPDATE ven_vendas SET ? WHERE id = ?', [cab, v.id]);
      if (!dePedido) {
        await c.query('DELETE FROM ven_venda_itens WHERE venda_id = ?', [v.id]);
        for (const l of linhas) await c.query('INSERT INTO ven_venda_itens SET ?', [{ ...l, venda_id: v.id }]);
      }
      await gravarParcelas(c, v.id, linhasParcelas);
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

    return transacao(async (c) => {
      const [itens]: any = await c.query(
        `SELECT i.*, d.numero AS pedido, d.status AS status_pedido, d.natureza_id, d.pessoa_id, d.vendedor_id, d.condicao_pagamento_id,
                d.modalidade_frete, d.transportadora_id, d.valor_frete AS frete_pedido, d.valor_total AS total_pedido,
                d.observacoes, d.informacoes_complementares
           FROM ven_dav_itens i JOIN ven_davs d ON d.id = i.dav_id
          WHERE i.id IN (?) AND d.empresa_id = ? AND d.tipo = 'pedido'
          ORDER BY d.numero, i.item
            FOR UPDATE`,
        [[...qtd.keys()], empresa],
      );
      if (itens.length !== qtd.size) falha('Item de pedido não encontrado.');
      const [fat]: any = await c.query(`SELECT * FROM (${FATURADO}) f WHERE f.dav_item_id IN (?)`, [[...qtd.keys()]]);
      const jaFaturado = new Map<number, number>(fat.map((f: any) => [f.dav_item_id, Number(f.q)]));

      const p0 = itens[0];
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
          descricao: i.descricao, unidade: i.unidade, ...base, valor_total: totalItem(base),
        };
      });

      const davIds = [...new Set<number>(itens.map((i: any) => i.dav_id))];
      const cabPedido = (id: number) => itens.find((i: any) => i.dav_id === id);
      const frete = davIds.reduce((s, id) => s + (cabPedido(id).status_pedido === 'aberto' ? Math.round(Number(cabPedido(id).frete_pedido) * 100) : 0), 0) / 100;
      const t = totais(linhas, frete);
      const juntar = (campo: string) => [...new Set(davIds.map((id) => String(cabPedido(id)[campo] ?? '').trim()).filter(Boolean))].join('\n') || null;

      // Data e vencimentos pelo relógio do MySQL (sessão em -03:00)
      const [[{ hoje }]]: any = await c.query('SELECT CURDATE() AS hoje');
      let parcelas: any[] = [];
      if (davIds.length === 1 && t.valor_total === Number(p0.total_pedido)) {
        const [pp]: any = await c.query('SELECT numero, vencimento, forma_pagamento, valor FROM ven_dav_parcelas WHERE dav_id = ? ORDER BY numero', [p0.dav_id]);
        if (pp.length && somaParcelas(pp.map((p: any) => p.valor)) === t.valor_total) parcelas = pp;
      }
      if (!parcelas.length && p0.condicao_pagamento_id) {
        const [[cp]]: any = await c.query('SELECT prazos, forma_pagamento FROM crm_condicoes_pagamento WHERE id = ?', [p0.condicao_pagamento_id]);
        if (cp && t.valor_total > 0) parcelas = gerarParcelas(cp.prazos, t.valor_total, hoje, cp.forma_pagamento || 'Boleto');
      }

      const venda = await inserirNumerado(c, 'ven_vendas', {
        natureza_id: p0.natureza_id, pessoa_id: p0.pessoa_id, vendedor_id: p0.vendedor_id, condicao_pagamento_id: p0.condicao_pagamento_id,
        data_emissao: hoje, origem: 'pedido', modalidade_frete: p0.modalidade_frete, transportadora_id: p0.transportadora_id,
        ...t, observacoes: juntar('observacoes'), informacoes_complementares: juntar('informacoes_complementares'), usuario_id: s.userId ?? null,
      }, empresa);
      for (const l of linhas) await c.query('INSERT INTO ven_venda_itens SET ?', [{ ...l, venda_id: venda.id }]);
      await gravarParcelas(c, venda.id, parcelas);
      await atualizarPedidos(c, davIds);
      return venda;
    });
  }));

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
