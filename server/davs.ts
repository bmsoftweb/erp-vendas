import { Router } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { dataIso, falha, idOuNull, rota } from './http.js';
import { totais, totalItem } from '../lib/totais.js';

/**
 * DAV: orçamentos e pedidos (ven_davs, tipo). Só o DAV "aberto" pode ser alterado ou excluído.
 * Orçamento aprovado gera um pedido novo (cópia) e fica como histórico.
 * Pessoas e produtos são do grupo de empresas da filial (cad_*.grupo_id = sys_empresas.grupo_id).
 */
const TIPOS = ['orcamento', 'pedido'] as const;
type Tipo = (typeof TIPOS)[number];
const NOME: Record<Tipo, string> = { orcamento: 'Orçamento', pedido: 'Pedido' };
const DO_GRUPO = (col: string) => `${col} = (SELECT eg.grupo_id FROM sys_empresas eg WHERE eg.id = ?)`;

const tipoDe = (v: unknown): Tipo => (TIPOS.includes(v as Tipo) ? (v as Tipo) : falha('Tipo inválido.'));

export async function transacao<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Corpo da tela, validado contra o banco (natureza, cliente, produtos, condição da filial) */
export async function lerDav(c: PoolConnection, b: any, empresa: number) {
  const natureza_id = idOuNull(b?.natureza_id) ?? falha('Escolha a natureza de operação.');
  const [[nat]]: any = await c.query('SELECT documento FROM ven_naturezas_operacao WHERE id = ? AND empresa_id = ? AND ativo = 1', [natureza_id, empresa]);
  if (!nat) falha('Natureza de operação inválida ou inativa.');

  const pessoa_id = idOuNull(b?.pessoa_id);
  if (!pessoa_id && nat.documento !== 'nfce') falha('Escolha o cliente.');
  const transportadora_id = idOuNull(b?.transportadora_id);
  const pessoas = [pessoa_id, transportadora_id].filter(Boolean);
  if (pessoas.length) {
    const [ok]: any = await c.query(`SELECT id FROM cad_pessoas WHERE id IN (?) AND date_delete IS NULL AND ${DO_GRUPO('grupo_id')}`, [pessoas, empresa]);
    if (ok.length !== new Set(pessoas).size) falha('Cliente ou transportadora não encontrado nesta empresa.');
  }

  const condicao_pagamento_id = idOuNull(b?.condicao_pagamento_id);
  if (condicao_pagamento_id) {
    const [[cp]]: any = await c.query('SELECT 1 FROM crm_condicoes_pagamento WHERE id = ? AND empresa_id = ?', [condicao_pagamento_id, empresa]);
    if (!cp) falha('Condição de pagamento inválida.');
  }
  const vendedor_id = idOuNull(b?.vendedor_id);

  const itens: any[] = Array.isArray(b?.itens) ? b.itens : [];
  if (!itens.length) falha('Inclua pelo menos um item.');
  const ids = [...new Set(itens.map((i) => idOuNull(i.produto_id) ?? falha('Item sem produto.')))];
  const [prods]: any = await c.query(`SELECT id, servico FROM cad_produtos WHERE id IN (?) AND ${DO_GRUPO('grupo_id')}`, [ids, empresa]);
  if (prods.length !== ids.length) falha('Produto não encontrado nesta empresa.');
  const servico = nat.documento === 'nfse';
  if (prods.some((p: any) => !!Number(p.servico) !== servico))
    falha(servico ? 'A natureza é de NFS-e: só entram serviços. Produtos vão em outro pedido.' : 'A natureza é de NF-e/NFC-e: serviços vão em outro pedido, com natureza de NFS-e.');

  const linhas = itens.map((i, n) => {
    const quantidade = Number(i.quantidade);
    const preco = Number(i.preco_unitario);
    const desconto = Number(i.valor_desconto || 0);
    if (!(quantidade > 0)) falha(`Item ${n + 1}: quantidade deve ser maior que zero.`);
    if (!(preco >= 0)) falha(`Item ${n + 1}: preço inválido.`);
    const total = totalItem({ quantidade, preco_unitario: preco, valor_desconto: desconto });
    if (desconto < 0 || total < 0) falha(`Item ${n + 1}: desconto maior que o valor do item.`);
    const descricao = String(i.descricao ?? '').trim();
    if (!descricao) falha(`Item ${n + 1}: informe a descrição.`);
    return {
      item: n + 1,
      produto_id: Number(i.produto_id),
      variante_id: idOuNull(i.variante_id),
      descricao: descricao.slice(0, 120),
      unidade: String(i.unidade ?? '').trim().slice(0, 6) || 'UN',
      quantidade,
      preco_unitario: preco,
      valor_desconto: desconto,
      valor_total: total,
    };
  });

  const frete = Number(b?.valor_frete || 0);
  if (!(frete >= 0)) falha('Frete inválido.');
  const t = totais(linhas, frete);

  const parcelas: any[] = Array.isArray(b?.parcelas) ? b.parcelas : [];
  const somaParcelas = Math.round(parcelas.reduce((s, p) => s + Math.round(Number(p.valor || 0) * 100), 0)) / 100;
  if (parcelas.length && somaParcelas !== t.valor_total)
    falha(`A soma das parcelas (${somaParcelas.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}) difere do total (${t.valor_total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}).`);
  const linhasParcelas = parcelas.map((p, n) => {
    if (!(Number(p.valor) > 0)) falha(`Parcela ${n + 1}: valor inválido.`);
    return { numero: n + 1, vencimento: dataIso(p.vencimento, `Parcela ${n + 1}`), forma_pagamento: String(p.forma_pagamento || 'Boleto').slice(0, 30), valor: Number(p.valor) };
  });

  const mod = Number(b?.modalidade_frete ?? 9);
  if (![0, 1, 2, 3, 4, 9].includes(mod)) falha('Modalidade de frete inválida.');

  const cabecalho = {
    natureza_id,
    pessoa_id,
    vendedor_id,
    condicao_pagamento_id,
    data_emissao: dataIso(b?.data_emissao, 'Data'),
    validade: b?.validade ? dataIso(b.validade, 'Validade') : null,
    modalidade_frete: mod,
    transportadora_id: mod === 9 ? null : transportadora_id,
    ...t,
    observacoes: String(b?.observacoes ?? '').trim() || null,
    informacoes_complementares: String(b?.informacoes_complementares ?? '').trim() || null,
  };
  return { cabecalho, linhas, linhasParcelas };
}

async function gravarFilhos(c: PoolConnection, davId: number, linhas: any[], parcelas: any[]) {
  await c.query('DELETE FROM ven_dav_itens WHERE dav_id = ?', [davId]);
  await c.query('DELETE FROM ven_dav_parcelas WHERE dav_id = ?', [davId]);
  for (const l of linhas) await c.query('INSERT INTO ven_dav_itens SET ?', [{ ...l, dav_id: davId }]);
  for (const p of parcelas) await c.query('INSERT INTO ven_dav_parcelas SET ?', [{ ...p, dav_id: davId }]);
}

/** Insere com o próximo número (do tipo, no DAV); colisão de número (dois ao mesmo tempo) tenta de novo */
export async function inserirNumerado(c: PoolConnection, tabela: 'ven_davs' | 'ven_vendas', dados: Record<string, unknown>, empresa: number, tipo?: Tipo): Promise<{ id: number; numero: number }> {
  // ponytail: MAX+1 com nova tentativa; contador próprio (como nfe_numeracao) se a concorrência crescer
  for (let tentativa = 0; ; tentativa++) {
    const [[m]]: any = await c.query(`SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM ${tabela} WHERE empresa_id = ?${tipo ? ' AND tipo = ?' : ''}`, [empresa, tipo]);
    try {
      await c.query('SAVEPOINT num');
      const [r]: any = await c.query(`INSERT INTO ${tabela} SET ?`, [{ ...dados, empresa_id: empresa, ...(tipo && { tipo }), numero: m.n }]);
      return { id: r.insertId, numero: m.n };
    } catch (e: any) {
      if (e?.code !== 'ER_DUP_ENTRY' || tentativa >= 4 || String(e.message).includes('referencia')) throw e;
      await c.query('ROLLBACK TO SAVEPOINT num');
    }
  }
}

async function davAberto(c: PoolConnection, id: unknown, empresa: number) {
  const [[d]]: any = await c.query('SELECT * FROM ven_davs WHERE id = ? AND empresa_id = ? FOR UPDATE', [id, empresa]);
  if (!d) falha('Registro não encontrado.', 404);
  if (d.status !== 'aberto') falha(`${NOME[d.tipo as Tipo]} ${d.numero} está ${d.status}: não pode ser alterado.`, 409);
  return d;
}

export function createDavsRouter() {
  const r = Router();

  r.get('/davs', rota(async (req, _res, s) => {
    const tipo = tipoDe(req.query.tipo);
    const filtros: string[] = [];
    const args: unknown[] = [empresaDa(s), tipo];
    if (req.query.de) (filtros.push('d.data_emissao >= ?'), args.push(dataIso(req.query.de, 'De')));
    if (req.query.ate) (filtros.push('d.data_emissao <= ?'), args.push(dataIso(req.query.ate, 'Até')));
    if (req.query.status) (filtros.push('d.status = ?'), args.push(String(req.query.status)));
    const [linhas] = await pool.query(
      `SELECT d.id, d.numero, d.data_emissao, d.validade, d.status, d.valor_total, d.orcamento_id,
              p.nome AS cliente, p.cpf_cnpj, n.descricao AS natureza, n.documento,
              COALESCE(NULLIF(u.nome, ''), u.login) AS vendedor,
              (SELECT pd.numero FROM ven_davs pd WHERE pd.orcamento_id = d.id LIMIT 1) AS pedido_numero,
              o.numero AS orcamento_numero
         FROM ven_davs d
         JOIN ven_naturezas_operacao n ON n.id = d.natureza_id
         LEFT JOIN cad_pessoas p ON p.id = d.pessoa_id
         LEFT JOIN sys_usuarios u ON u.id = d.vendedor_id
         LEFT JOIN ven_davs o ON o.id = d.orcamento_id
        WHERE d.empresa_id = ? AND d.tipo = ? ${filtros.map((f) => `AND ${f}`).join(' ')}
        ORDER BY d.numero DESC
        LIMIT 1000`,
      args,
    );
    return linhas;
  }));

  r.get('/davs/:id', rota(async (req, _res, s) => {
    const [[d]]: any = await pool.query(
      `SELECT d.*, p.nome AS cliente, p.cpf_cnpj, t.nome AS transportadora
         FROM ven_davs d LEFT JOIN cad_pessoas p ON p.id = d.pessoa_id LEFT JOIN cad_pessoas t ON t.id = d.transportadora_id
        WHERE d.id = ? AND d.empresa_id = ?`,
      [req.params.id, empresaDa(s)],
    );
    if (!d) falha('Registro não encontrado.', 404);
    const [itens] = await pool.query('SELECT * FROM ven_dav_itens WHERE dav_id = ? ORDER BY item', [d.id]);
    const [parcelas] = await pool.query('SELECT * FROM ven_dav_parcelas WHERE dav_id = ? ORDER BY numero', [d.id]);
    return { ...d, itens, parcelas };
  }));

  r.post('/davs', rota(async (req, _res, s) => {
    const tipo = tipoDe(req.body?.tipo);
    const empresa = empresaDa(s);
    return transacao(async (c) => {
      const { cabecalho, linhas, linhasParcelas } = await lerDav(c, req.body, empresa);
      if (tipo === 'pedido') cabecalho.validade = null;
      const dav = await inserirNumerado(c, 'ven_davs', { ...cabecalho, origem: 'tela', usuario_id: s.userId ?? null }, empresa, tipo);
      await gravarFilhos(c, dav.id, linhas, linhasParcelas);
      return dav;
    });
  }));

  r.put('/davs/:id', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    await transacao(async (c) => {
      const d = await davAberto(c, req.params.id, empresa);
      const { cabecalho, linhas, linhasParcelas } = await lerDav(c, req.body, empresa);
      if (d.tipo === 'pedido') cabecalho.validade = null;
      await c.query('UPDATE ven_davs SET ? WHERE id = ?', [cabecalho, d.id]);
      await gravarFilhos(c, d.id, linhas, linhasParcelas);
    });
  }));

  r.delete('/davs/:id', rota(async (req, _res, s) => {
    await transacao(async (c) => {
      const d = await davAberto(c, req.params.id, empresaDa(s));
      await c.query('DELETE FROM ven_davs WHERE id = ?', [d.id]);
    });
  }));

  /** Orçamento aberto → pedido novo com os mesmos dados; o orçamento fica "aprovado" */
  r.post('/davs/:id/aprovar', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    return transacao(async (c) => {
      const o = await davAberto(c, req.params.id, empresa);
      if (o.tipo !== 'orcamento') falha('Só orçamento pode ser aprovado.');
      const { id: _id, numero: _n, tipo: _t, status: _s, validade: _v, referencia: _r, criado_em: _c, atualizado_em: _a, cancelado_em: _x, empresa_id: _e, ...dados } = o;
      // Data do pedido = hoje no MySQL (sessão em -03:00), não no relógio do servidor Node
      const hoje = { toSqlString: () => 'CURDATE()' };
      const pedido = await inserirNumerado(c, 'ven_davs', { ...dados, orcamento_id: o.id, data_emissao: hoje, usuario_id: s.userId ?? null }, empresa, 'pedido');
      await c.query(
        `INSERT INTO ven_dav_itens (dav_id, item, produto_id, variante_id, descricao, unidade, quantidade, preco_unitario, valor_desconto, valor_total, tributos)
         SELECT ?, item, produto_id, variante_id, descricao, unidade, quantidade, preco_unitario, valor_desconto, valor_total, tributos FROM ven_dav_itens WHERE dav_id = ?`,
        [pedido.id, o.id],
      );
      await c.query(
        'INSERT INTO ven_dav_parcelas (dav_id, numero, vencimento, forma_pagamento, valor) SELECT ?, numero, vencimento, forma_pagamento, valor FROM ven_dav_parcelas WHERE dav_id = ?',
        [pedido.id, o.id],
      );
      await c.query("UPDATE ven_davs SET status = 'aprovado' WHERE id = ?", [o.id]);
      return pedido;
    });
  }));

  r.post('/davs/:id/recusar', rota(async (req, _res, s) => {
    await transacao(async (c) => {
      const o = await davAberto(c, req.params.id, empresaDa(s));
      if (o.tipo !== 'orcamento') falha('Só orçamento pode ser recusado.');
      await c.query("UPDATE ven_davs SET status = 'recusado' WHERE id = ?", [o.id]);
    });
  }));

  r.post('/davs/:id/cancelar', rota(async (req, _res, s) => {
    await transacao(async (c) => {
      const d = await davAberto(c, req.params.id, empresaDa(s));
      await c.query("UPDATE ven_davs SET status = 'cancelado', cancelado_em = NOW() WHERE id = ?", [d.id]);
    });
  }));

  return r;
}
