import { randomInt } from 'node:crypto';
import { Router } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { dataIso, falha, idOuNull, rota } from './http.js';
import { totais, totalItem } from '../lib/totais.js';
import { ehVenda } from '../lib/modelo.js';

/**
 * DAV: orçamentos e pedidos (ven_davs, tipo). Só o DAV "aberto" pode ser alterado ou baixado; nunca é apagado.
 * Orçamento aprovado gera um pedido novo (cópia) e fica como histórico.
 * Pessoas e produtos são do grupo de empresas da filial (cad_*.grupo_id = sys_empresas.grupo_id).
 */
const TIPOS = ['orcamento', 'pedido'] as const;
type Tipo = (typeof TIPOS)[number];
const NOME: Record<Tipo, string> = { orcamento: 'Orçamento', pedido: 'Pedido' };
/**
 * O DAV teve DF-e emitido: item numa venda que recebeu nota (autorizada, em contingência ou já cancelada; a venda guarda
 * o id da nota mesmo cancelada). Depois disso o DAV não é alterado nem reimpresso (Requisito V, § 1º, III, a e b) e o
 * Controle dos DAV (D4, campo 11) o mostra como "E".
 */
export const DFE_DE = (dav: string) => `EXISTS(SELECT 1 FROM ven_dav_itens di JOIN ven_venda_itens vi ON vi.dav_item_id = di.id
                   JOIN ven_vendas vn ON vn.id = vi.venda_id WHERE di.dav_id = ${dav} AND (vn.nfe_documento_id IS NOT NULL OR vn.nfs_nota_id IS NOT NULL))`;
/** DAV com DF-e: o dele ou, no orçamento, o do pedido gerado dele */
const COM_NOTA = `(${DFE_DE('d.id')} OR EXISTS(SELECT 1 FROM ven_davs pd WHERE pd.orcamento_id = d.id AND ${DFE_DE('pd.id')}))`;
const DO_GRUPO = (col: string) => `${col} = (SELECT eg.grupo_id FROM sys_empresas eg WHERE eg.id = ?)`;

/** Validade do orçamento não pode ser antes da emissão (datas AAAA-MM-DD; a emissão é a do servidor) */
const validadeOk = (validade: string | null, emissao: string) => {
  if (validade && validade < emissao) falha('A validade do orçamento não pode ser anterior à data de emissão.');
};

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

type Consulta = Pick<PoolConnection, 'query'>;

/** NFC-e só abaixo de R$ 200.000,00 (RICMS/SC Anexo 11, art. 96, § 7º) */
const LIMITE_NFCE = 200000;

/**
 * Modelo da nota pelo destinatário (PAF-NFC-e de SC, Requisito IV, II), sem escolha do usuário: sem cliente ou com CPF
 * → NFC-e; CNPJ ou CPF com IE (produtor rural) → NF-e. CPF de outra UF também é NFC-e (FAQ 6 do roteiro, Ato DIAT
 * 56/2026: pessoa natural, com ou sem CPF, gera NFC-e): a venda presencial a quem mora fora é operação interna, e a
 * NFC-e sai sem endereço. Saiu a regra de 22/11/2026 que mandava esse cliente para NF-e.
 */
export async function modeloExigido(c: Consulta, _empresa: number, pessoa_id: number | null, total = 0): Promise<'nfe' | 'nfce'> {
  if (total >= LIMITE_NFCE) return 'nfe'; // RICMS/SC Anexo 11, art. 96, § 7º
  if (!pessoa_id) return 'nfce';
  const [[p]]: any = await c.query('SELECT cpf_cnpj, ie FROM cad_pessoas WHERE id = ?', [pessoa_id]);
  if (!p) return 'nfce';
  const cnpj = String(p.cpf_cnpj ?? '').replace(/\D/g, '').length === 14;
  const ie = String(p.ie ?? '').replace(/\D/g, '') !== '';
  return cnpj || ie ? 'nfe' : 'nfce';
}

/** Natureza de venda com o modelo errado para o cliente → falha. Remessas, devoluções e NFS-e não entram na regra */
export async function conferirModelo(c: Consulta, empresa: number, natureza_id: number, pessoa_id: number | null, total = 0) {
  const [[n]]: any = await c.query('SELECT documento, cfop_estadual FROM ven_naturezas_operacao WHERE id = ?', [natureza_id]);
  if (!n || n.documento === 'nfse' || !ehVenda(n.cfop_estadual)) return;
  const m = await modeloExigido(c, empresa, pessoa_id, total);
  if (m !== n.documento)
    falha(total >= LIMITE_NFCE
      ? 'Venda de R$ 200.000,00 ou mais não pode ser NFC-e (RICMS/SC Anexo 11, art. 96, § 7º): escolha uma natureza de NF-e.'
      : m === 'nfce'
      ? 'Venda sem cliente ou a CPF é NFC-e (PAF-NFC-e, Requisito IV): escolha uma natureza de NFC-e.'
      : 'Venda a CNPJ ou a produtor rural (CPF com IE) é NF-e (PAF-NFC-e, Requisito IV): escolha uma natureza de NF-e.');
}

/** Natureza de venda (CFOP de venda) ativa do modelo, de preferência a `preferida` (Faturar e rotina dos 180 dias) */
export async function naturezaDeVenda(c: Consulta, empresa: number, modelo: 'nfe' | 'nfce', preferida: number): Promise<number> {
  const [nats]: any = await c.query('SELECT id, cfop_estadual FROM ven_naturezas_operacao WHERE empresa_id = ? AND documento = ? AND ativo = 1 ORDER BY id = ? DESC, id', [empresa, modelo, preferida]);
  return nats.find((n: any) => ehVenda(n.cfop_estadual))?.id ?? falha(`A empresa não tem natureza de venda de ${modelo === 'nfe' ? 'NF-e' : 'NFC-e'} ativa.`);
}

/** Corpo da tela, validado contra o banco (natureza, cliente, produtos, condição da filial) */
/** troco: na venda, as parcelas podem passar do total; o que passa é troco e sai do pagamento em dinheiro */
/** Hoje pelo relógio do MySQL (sessão em -03:00), AAAA-MM-DD */
export async function hojeSql(c: Consulta): Promise<string> {
  const [[{ hoje }]]: any = await c.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoje");
  return hoje;
}

/** checarAtivo: produto inativo só é recusado na inclusão (tela); a venda de pedido e a rotina dos 180 dias passam */
export async function lerDav(c: PoolConnection, b: any, empresa: number, troco = false, checarAtivo = true) {
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
  if (vendedor_id) {
    const [[v]]: any = await c.query('SELECT 1 FROM cad_vendedores WHERE id = ? AND empresa_id = ?', [vendedor_id, empresa]);
    if (!v) falha('Vendedor não encontrado nesta empresa.');
  }

  const itens: any[] = Array.isArray(b?.itens) ? b.itens : [];
  if (!itens.length) falha('Inclua pelo menos um item.');
  const ids = [...new Set(itens.map((i) => idOuNull(i.produto_id) ?? falha('Item sem produto.')))];
  // Unidade do cadastro, não a do navegador (como requisicoes.ts)
  const [prods]: any = await c.query(
    `SELECT p.id, p.nome, p.servico, p.iat, p.ativo, COALESCE(um.sigla, 'UN') AS unidade FROM cad_produtos p
       LEFT JOIN cad_produtos_unidades_medida um ON um.id = p.unidade_id WHERE p.id IN (?) AND ${DO_GRUPO('p.grupo_id')}`, [ids, empresa]);
  if (prods.length !== ids.length) falha('Produto não encontrado nesta empresa.');
  const inativo = checarAtivo && prods.find((p: any) => p.ativo !== null && !Number(p.ativo));
  if (inativo) falha(`Produto ${inativo.nome} está inativo.`);
  const servico = nat.documento === 'nfse';
  if (prods.some((p: any) => !!Number(p.servico) !== servico))
    falha(servico ? 'A natureza é de NFS-e: só entram serviços. Produtos vão em outro pedido.' : 'A natureza é de NF-e/NFC-e: serviços vão em outro pedido, com natureza de NFS-e.');

  const iatDe = (id: unknown) => prods.find((p: any) => p.id === Number(id))?.iat ?? 'A';
  const linhas = itens.map((i, n) => {
    const quantidade = Number(i.quantidade);
    const preco = Number(i.preco_unitario);
    const desconto = Number(i.valor_desconto || 0);
    if (!(quantidade > 0)) falha(`Item ${n + 1}: quantidade deve ser maior que zero.`);
    if (!(preco >= 0)) falha(`Item ${n + 1}: preço inválido.`);
    const total = totalItem({ quantidade, preco_unitario: preco, valor_desconto: desconto, iat: iatDe(i.produto_id) });
    if (desconto < 0 || total < 0) falha(`Item ${n + 1}: desconto maior que o valor do item.`);
    // Descrição da Tabela de Mercadorias, não digitada (PAF-NFC-e, Requisito VIII)
    const prod = prods.find((p: any) => p.id === Number(i.produto_id));
    const descricao = String(prod?.nome ?? '').trim();
    if (!descricao) falha(`Item ${n + 1}: produto sem nome no cadastro.`);
    return {
      item: n + 1,
      produto_id: Number(i.produto_id),
      variante_id: idOuNull(i.variante_id),
      descricao: descricao.slice(0, 120),
      unidade: String(prod.unidade).trim().slice(0, 6) || 'UN',
      quantidade,
      preco_unitario: preco,
      valor_desconto: desconto,
      valor_total: total,
    };
  });

  const frete = Number(b?.valor_frete || 0);
  if (!(frete >= 0)) falha('Frete inválido.');
  const t = totais(linhas.map((l) => ({ ...l, iat: iatDe(l.produto_id) })), frete);
  await conferirModelo(c, empresa, natureza_id, pessoa_id, t.valor_total);

  const parcelas: any[] = Array.isArray(b?.parcelas) ? b.parcelas : [];
  const somaParcelas = Math.round(parcelas.reduce((s, p) => s + Math.round(Number(p.valor || 0) * 100), 0)) / 100;
  const br = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const sobra = Math.round((somaParcelas - t.valor_total) * 100) / 100;
  if (parcelas.length && sobra !== 0) {
    if (!troco || sobra < 0) falha(`A soma das parcelas (${br(somaParcelas)}) difere do total (${br(t.valor_total)}).`);
    const dinheiro = parcelas.filter((p) => p.forma_pagamento === 'Dinheiro').reduce((s, p) => s + Number(p.valor || 0), 0);
    if (sobra >= dinheiro) falha(`As parcelas passam ${br(sobra)} do total: o troco só sai de pagamento em dinheiro, e o dinheiro (${br(dinheiro)}) precisa ser maior que o troco.`);
  }
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

/**
 * Log de alteração de itens do DAV (PAF-NFC-e de SC, Arquivo III, registro D6): compara os itens gravados com os
 * que chegaram, pelo id que a tela devolve. Sem id (ou de outro DAV) = inclusão; id que sumiu = exclusão; quantidade,
 * preço ou desconto diferente = alteração. Em A e E vão quantidade e preço de antes; em I, os incluídos (item 6.6.3).
 * O item que continua leva o id, o número e a data de inclusão que já tinha (registro D5, campos 03 e 04); o novo fica
 * com a data de agora e o próximo número do DAV (o do item cancelado não volta).
 */
export async function logItens(c: PoolConnection, davId: number, enviados: any[], linhas: any[], usuario: number | null) {
  const [antigos]: any = await c.query(
    `SELECT id, item, produto_id, descricao, unidade, quantidade, preco_unitario, valor_desconto,
            DATE_FORMAT(incluido_em, '%Y-%m-%d %H:%i:%s') AS incluido_em
       FROM ven_dav_itens WHERE dav_id = ? AND cancelado = 0`,
    [davId],
  );
  const [[{ ultimo }]]: any = await c.query('SELECT COALESCE(MAX(item), 0) AS ultimo FROM ven_dav_itens WHERE dav_id = ?', [davId]);
  let proximo = Number(ultimo);
  const porId = new Map<number, any>(antigos.map((a: any) => [a.id, a]));
  const log: unknown[][] = [];
  const reg = (tipo: string, i: any) =>
    log.push([davId, tipo, i.item, i.produto_id, i.descricao, i.unidade, i.quantidade, i.preco_unitario, usuario]);
  const incluir = (l: any) => ((l.item = ++proximo), reg('I', l));
  linhas.forEach((l, n) => {
    const a = porId.get(Number(enviados[n]?.id));
    if (!a) return incluir(l);
    porId.delete(a.id);
    if (a.produto_id !== l.produto_id) return reg('E', a), incluir(l);
    Object.assign(l, { id: a.id, item: a.item, incluido_em: a.incluido_em });
    if (Number(a.quantidade) !== l.quantidade || Number(a.preco_unitario) !== l.preco_unitario || Number(a.valor_desconto) !== l.valor_desconto) reg('A', a);
  });
  for (const a of porId.values()) reg('E', a);
  if (log.length)
    await c.query('INSERT INTO ven_dav_itens_log (dav_id, tipo, item, produto_id, descricao, unidade, quantidade, preco_unitario, usuario_id) VALUES ?', [log]);
}

/**
 * Itens: o que continua (id vindo do logItens) é atualizado; o novo é incluído; o que saiu não se apaga, fica cancelado
 * com o mesmo número (Arquivo III, D5, campos 04 e 18), fora dos totais, do faturamento e da impressão.
 */
export async function gravarFilhos(c: PoolConnection, davId: number, linhas: any[], parcelas: any[]) {
  const ficam = linhas.map((l) => l.id).filter(Boolean);
  await c.query(`UPDATE ven_dav_itens SET cancelado = 1 WHERE dav_id = ?${ficam.length ? ' AND id NOT IN (?)' : ''}`, ficam.length ? [davId, ficam] : [davId]);
  await c.query('DELETE FROM ven_dav_parcelas WHERE dav_id = ?', [davId]);
  for (const { id, ...l } of linhas)
    await c.query(id ? 'UPDATE ven_dav_itens SET ? WHERE id = ?' : 'INSERT INTO ven_dav_itens SET ?', id ? [l, id] : [{ ...l, dav_id: davId }]);
  for (const p of parcelas) await c.query('INSERT INTO ven_dav_parcelas SET ?', [{ ...p, dav_id: davId }]);
}

/** Venda com o próximo número; colisão de número (duas ao mesmo tempo) tenta de novo */
export async function inserirNumerado(c: PoolConnection, tabela: 'ven_vendas', dados: Record<string, unknown>, empresa: number): Promise<{ id: number; numero: number }> {
  // ponytail: MAX+1 com nova tentativa; contador próprio (como ven_dav_numeracao) se a concorrência crescer
  for (let tentativa = 0; ; tentativa++) {
    const [[m]]: any = await c.query(`SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM ${tabela} WHERE empresa_id = ?`, [empresa]);
    try {
      await c.query('SAVEPOINT num');
      const [r]: any = await c.query(`INSERT INTO ${tabela} SET ?`, [{ ...dados, empresa_id: empresa, numero: m.n }]);
      return { id: r.insertId, numero: m.n };
    } catch (e: any) {
      if (e?.code !== 'ER_DUP_ENTRY' || tentativa >= 4 || String(e.message).includes('referencia')) throw e;
      await c.query('ROLLBACK TO SAVEPOINT num');
    }
  }
}

/**
 * DAV com o próximo número do contador da empresa: único para orçamento e pedido e nunca reaproveitado
 * (PAF-NFC-e de SC, Requisito V, I, b). A linha do contador fica travada até o fim da transação.
 */
export async function inserirDav(c: PoolConnection, dados: Record<string, unknown>, empresa: number, tipo: Tipo): Promise<{ id: number; numero: number }> {
  await c.query('INSERT INTO ven_dav_numeracao (empresa_id, ultimo) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE ultimo = LAST_INSERT_ID(ultimo + 1)', [empresa]);
  const [[{ numero }]]: any = await c.query('SELECT LAST_INSERT_ID() AS numero');
  const [r]: any = await c.query('INSERT INTO ven_davs SET ?', [{ ...dados, empresa_id: empresa, tipo, numero }]);
  return { id: r.insertId, numero: Number(numero) };
}

/**
 * Senha da pré-venda (Requisito V, I, f): 6 dígitos aleatórios, sem repetir entre as pré-vendas em aberto da empresa.
 * Pedido sem pré-venda = null. Ao alterar, a senha já entregue ao consumidor é mantida.
 */
export async function senhaPrevenda(c: PoolConnection, empresa: number, ligado: unknown, atual: string | null = null) {
  if (!ligado) return null;
  if (atual) return atual;
  for (;;) {
    const senha = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const [[uso]]: any = await c.query("SELECT 1 FROM ven_davs WHERE empresa_id = ? AND prevenda_senha = ? AND status IN ('aberto', 'parcial')", [empresa, senha]);
    if (!uso) return senha;
  }
}

export async function davAberto(c: PoolConnection, id: unknown, empresa: number) {
  const [[d]]: any = await c.query('SELECT * FROM ven_davs WHERE id = ? AND empresa_id = ? FOR UPDATE', [id, empresa]);
  if (!d) falha('Registro não encontrado.', 404);
  if (d.status !== 'aberto') falha(`${NOME[d.tipo as Tipo]} ${String(d.numero).padStart(10, '0')} está ${d.status}: não pode ser alterado.`, 409);
  return d;
}

/** Orçamento aberto (travado por davAberto) → pedido novo com os mesmos dados; o orçamento fica "aprovado" */
export async function aprovarOrcamento(c: PoolConnection, o: any, usuario_id: number | null) {
  if (o.tipo !== 'orcamento') falha('Só orçamento pode ser aprovado.');
  const { id: _id, numero: _n, tipo: _t, status: _s, validade: _v, referencia: _r, criado_em: _c, atualizado_em: _a, baixado_em: _x, baixa_motivo: _m, empresa_id: _e, ...dados } = o;
  // Data do pedido = hoje no MySQL (sessão em -03:00), não no relógio do servidor Node
  const hoje = { toSqlString: () => 'CURDATE()' };
  const pedido = await inserirDav(c, { ...dados, orcamento_id: o.id, data_emissao: hoje, usuario_id }, o.empresa_id, 'pedido');
  await c.query(
    `INSERT INTO ven_dav_itens (dav_id, item, produto_id, variante_id, descricao, unidade, quantidade, preco_unitario, valor_desconto, valor_total, tributos)
     SELECT ?, ROW_NUMBER() OVER (ORDER BY item), produto_id, variante_id, descricao, unidade, quantidade, preco_unitario, valor_desconto, valor_total, tributos
       FROM ven_dav_itens WHERE dav_id = ? AND cancelado = 0`, // cancelado do orçamento não vai para o pedido
    [pedido.id, o.id],
  );
  await c.query(
    'INSERT INTO ven_dav_parcelas (dav_id, numero, vencimento, forma_pagamento, valor) SELECT ?, numero, vencimento, forma_pagamento, valor FROM ven_dav_parcelas WHERE dav_id = ?',
    [pedido.id, o.id],
  );
  await c.query("UPDATE ven_davs SET status = 'aprovado' WHERE id = ?", [o.id]);
  return pedido;
}

export function createDavsRouter() {
  const r = Router();

  /** Modelo que o cliente exige nas naturezas de venda (as telas filtram a lista de naturezas por ele) */
  r.get('/modelo-nota', rota(async (req, _res, s) => ({ modelo: await modeloExigido(pool, empresaDa(s), idOuNull(req.query.pessoa_id), Number(req.query.total) || 0) })));

  r.get('/davs', rota(async (req, _res, s) => {
    const tipo = tipoDe(req.query.tipo);
    const filtros: string[] = [];
    const args: unknown[] = [empresaDa(s), tipo];
    if (req.query.de) (filtros.push('d.data_emissao >= ?'), args.push(dataIso(req.query.de, 'De')));
    if (req.query.ate) (filtros.push('d.data_emissao <= ?'), args.push(dataIso(req.query.ate, 'Até')));
    if (req.query.status) (filtros.push('d.status = ?'), args.push(String(req.query.status)));
    const [linhas] = await pool.query(
      `SELECT d.id, d.numero, d.data_emissao, d.validade, d.status, d.valor_total, d.orcamento_id, d.baixa_motivo, d.prevenda_senha,
              p.nome AS cliente, p.cpf_cnpj, n.descricao AS natureza, n.documento,
              u.nome AS vendedor,
              (SELECT pd.numero FROM ven_davs pd WHERE pd.orcamento_id = d.id LIMIT 1) AS pedido_numero,
              o.numero AS orcamento_numero, ${COM_NOTA} AS com_nota
         FROM ven_davs d
         JOIN ven_naturezas_operacao n ON n.id = d.natureza_id
         LEFT JOIN cad_pessoas p ON p.id = d.pessoa_id
         LEFT JOIN cad_vendedores u ON u.id = d.vendedor_id
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
    const [itens] = await pool.query('SELECT i.*, p.iat FROM ven_dav_itens i JOIN cad_produtos p ON p.id = i.produto_id WHERE i.dav_id = ? AND i.cancelado = 0 ORDER BY i.item', [d.id]);
    const [parcelas] = await pool.query('SELECT * FROM ven_dav_parcelas WHERE dav_id = ? ORDER BY numero', [d.id]);
    const [log] = await pool.query(
      `SELECT l.tipo, l.item, l.descricao, l.unidade, l.quantidade, l.preco_unitario, u.login AS usuario,
              DATE_FORMAT(l.alterado_em, '%d/%m/%Y %H:%i:%s') AS quando
         FROM ven_dav_itens_log l LEFT JOIN sys_usuarios u ON u.id = l.usuario_id
        WHERE l.dav_id = ? ORDER BY l.id`,
      [d.id],
    );
    return { ...d, itens, parcelas, log };
  }));

  /**
   * Dados da impressão do DAV (PAF-NFC-e de SC, Requisito V, I): emitente, destinatário, itens com o código do cadastro.
   * Com nota autorizada de algum item, não é reimpresso (§ 1º, III, a: reemissão vedada depois do DF-e).
   */
  r.get('/davs/:id/impressao', rota(async (req, _res, s) => {
    const [[d]]: any = await pool.query(
      `SELECT d.*, p.nome AS cliente, p.cpf_cnpj, p.logradouro, p.numero AS end_numero, p.complemento, p.bairro, p.cidade_nome, p.cidade_uf, p.cep,
              p.fone_principal, v.nome AS vendedor,
              e.razao_social AS emit_razao, e.nome_fantasia AS emit_fantasia, e.cnpj AS emit_cnpj, e.inscricao_estadual AS emit_ie,
              e.logradouro AS emit_logradouro, e.numero AS emit_numero, e.bairro AS emit_bairro, e.cidade AS emit_cidade, e.uf AS emit_uf,
              e.cep AS emit_cep, e.telefone AS emit_fone, ${COM_NOTA} AS com_nota
         FROM ven_davs d JOIN sys_empresas e ON e.id = d.empresa_id
         LEFT JOIN cad_pessoas p ON p.id = d.pessoa_id LEFT JOIN cad_vendedores v ON v.id = d.vendedor_id
        WHERE d.id = ? AND d.empresa_id = ?`,
      [req.params.id, empresaDa(s)],
    );
    if (!d) falha('Registro não encontrado.', 404);
    if (Number(d.com_nota))
      falha(`${NOME[d.tipo as Tipo]} ${String(d.numero).padStart(10, '0')} já teve nota emitida (mesmo cancelada): o DAV não é reimpresso depois do DF-e.`, 409);
    const [itens] = await pool.query(
      `SELECT i.*, COALESCE(NULLIF(REGEXP_REPLACE(COALESCE(p.codigo_barras, ''), '[^0-9]', ''), ''), p.id) AS codigo
         FROM ven_dav_itens i JOIN cad_produtos p ON p.id = i.produto_id WHERE i.dav_id = ? AND i.cancelado = 0 ORDER BY i.item`, // EAN ou id, como no D5 e na nota
      [d.id],
    );
    const [parcelas] = await pool.query('SELECT * FROM ven_dav_parcelas WHERE dav_id = ? ORDER BY numero', [d.id]);
    return { ...d, itens, parcelas };
  }));

  r.post('/davs', rota(async (req, _res, s) => {
    const tipo = tipoDe(req.body?.tipo);
    const empresa = empresaDa(s);
    return transacao(async (c) => {
      const { cabecalho, linhas, linhasParcelas } = await lerDav(c, req.body, empresa);
      // Data de emissão pelo relógio do servidor, não digitada: conta os 180 dias e o período do Arquivo III (Requisito V, § 2º)
      cabecalho.data_emissao = await hojeSql(c);
      if (tipo === 'pedido') Object.assign(cabecalho, { validade: null, prevenda_senha: await senhaPrevenda(c, empresa, req.body?.prevenda) });
      validadeOk(cabecalho.validade, cabecalho.data_emissao);
      const dav = await inserirDav(c, { ...cabecalho, origem: 'tela', usuario_id: s.userId ?? null }, empresa, tipo);
      await gravarFilhos(c, dav.id, linhas, linhasParcelas);
      return dav;
    });
  }));

  r.put('/davs/:id', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    await transacao(async (c) => {
      const d = await davAberto(c, req.params.id, empresa);
      const [[dfe]]: any = await c.query(`SELECT ${COM_NOTA} AS sim FROM ven_davs d WHERE d.id = ?`, [d.id]);
      if (Number(dfe?.sim)) falha(`${NOME[d.tipo as Tipo]} ${String(d.numero).padStart(10, '0')} já teve nota emitida (mesmo cancelada): não pode ser alterado. Fature o saldo num DAV novo.`, 409);
      const { cabecalho, linhas, linhasParcelas } = await lerDav(c, req.body, empresa);
      delete (cabecalho as any).data_emissao; // a data de emissão do DAV não muda depois de gravado
      if (d.tipo === 'pedido') Object.assign(cabecalho, { validade: null, prevenda_senha: await senhaPrevenda(c, empresa, req.body?.prevenda, d.prevenda_senha) });
      validadeOk(cabecalho.validade, d.data_emissao);
      await c.query('UPDATE ven_davs SET ? WHERE id = ?', [cabecalho, d.id]);
      await logItens(c, d.id, Array.isArray(req.body?.itens) ? req.body.itens : [], linhas, s.userId ?? null);
      await gravarFilhos(c, d.id, linhas, linhasParcelas);
    });
  }));

  // Sem exclusão de DAV: o PAF-NFC-e não pode apagar DAV (Requisito V, III); o que não segue é baixado

  /** Orçamento aberto → pedido novo com os mesmos dados; o orçamento fica "aprovado" */
  r.post('/davs/:id/aprovar', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    return transacao(async (c) => aprovarOrcamento(c, await davAberto(c, req.params.id, empresa), s.userId ?? null));
  }));

  // Recusa = baixa do orçamento que o cliente não aceitou: também exige o motivo (Requisito V, § 1º, II e III-c)
  r.post('/davs/:id/recusar', rota(async (req, _res, s) => {
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) falha('Informe o motivo da recusa.');
    await transacao(async (c) => {
      const o = await davAberto(c, req.params.id, empresaDa(s));
      if (o.tipo !== 'orcamento') falha('Só orçamento pode ser recusado.');
      await c.query("UPDATE ven_davs SET status = 'recusado', baixado_em = NOW(), baixa_motivo = ? WHERE id = ?", [motivo.slice(0, 200), o.id]);
    });
  }));

  // DAV não se cancela, só se baixa, e fica no banco (Requisito V, § 1º, II e III-c), sempre com o motivo.
  // Só o aberto: com venda já não
  r.post('/davs/:id/baixar', rota(async (req, _res, s) => {
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) falha('Informe o motivo da baixa.');
    await transacao(async (c) => {
      const d = await davAberto(c, req.params.id, empresaDa(s));
      await c.query("UPDATE ven_davs SET status = 'baixado', baixado_em = NOW(), baixa_motivo = ? WHERE id = ?", [motivo.slice(0, 200), d.id]);
    });
  }));

  return r;
}
