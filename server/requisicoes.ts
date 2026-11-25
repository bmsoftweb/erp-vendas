import { Router } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { ErroHttp, falha, idOuNull, rota } from './http.js';
import { conferirModelo, gravarFilhos, inserirDav, lerDav, transacao } from './davs.js';
import { emitenteDe } from './notas.js';
import { totais } from '../lib/totais.js';

const digitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/**
 * Requisições Externas: pedidos aprovados no CRM e pedidos fechados no portal B2B
 * (PAF-NFC-e de SC, Ato DIAT 54/2026, Requisito XVI e Requisito V, I, g).
 * Decisões do usuário (22/11/2026): o operador recebe na tela "Pedidos do CRM"; o obsFisco "RE" leva o CNPJ da BMsoft
 * (desenvolvedora do CRM, sys_paf) + o número do pedido; com a nota autorizada a RE fica Atendida e o pedido do CRM, Faturado.
 * 24/11/2026: o B2B (b2b_pedidos) entra pelo mesmo caminho, com origem BM-B2B; o DAV fica com origem 'api'.
 */

/** Nome da aplicação de origem (W4, campo 02: maiúsculas, sem acento) */
export const ORIGEM_CRM = 'BM-CRM';
export const ORIGEM_B2B = 'BM-B2B';

/** O que muda entre os pedidos do CRM e os do portal B2B */
const FONTES = {
  crm: {
    nome: 'CRM', origem: ORIGEM_CRM, tabela: 'crm_pedidos', coluna: 'crm_pedido_id', pronto: 'aprovado', davOrigem: 'crm',
    itens: 'SELECT i.produto_id, i.quantidade, i.preco_unitario, i.desconto FROM crm_pedido_itens i WHERE i.pedido_id = ? ORDER BY i.id',
    parcelas: 'SELECT vencimento, forma_pagamento, valor FROM crm_pedido_parcelas WHERE pedido_id = ? ORDER BY numero',
  },
  b2b: {
    nome: 'B2B', origem: ORIGEM_B2B, tabela: 'b2b_pedidos', coluna: 'b2b_pedido_id', pronto: 'fechado', davOrigem: 'api',
    // Desconto do B2B vem no preço praticado; o DAV recebe o desconto em valor por item
    itens: `SELECT i.produto_id, i.quantidade, i.preco_tabela AS preco_unitario,
                   ROUND(i.preco_tabela * i.quantidade - i.valor_total, 2) AS desconto
              FROM b2b_pedido_itens i WHERE i.pedido_id = ? ORDER BY i.id`,
    parcelas: null, // o B2B só leva a condição escolhida (vai nas observações); as parcelas ficam com o vendedor
  },
} as const;
type Fonte = keyof typeof FONTES;
const fonteDe = (v: unknown): Fonte => (v === 'b2b' ? 'b2b' : 'crm');

/** CRE: inteiro sequencial de 9 dígitos por estabelecimento, nunca reaproveitado (Requisito XVI, I) */
async function proximoCre(c: PoolConnection, empresa: number) {
  await c.query('INSERT INTO ven_re_numeracao (empresa_id, ultimo) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE ultimo = LAST_INSERT_ID(ultimo + 1)', [empresa]);
  const [[{ n }]]: any = await c.query('SELECT LAST_INSERT_ID() AS n');
  return Number(n);
}

/** Pedido da origem pronto para receber e ainda não recebido, travado para a transação */
async function pedidoExterno(c: PoolConnection, f: Fonte, id: unknown, empresa: number) {
  const F = FONTES[f];
  const [[p]]: any = await c.query(`SELECT * FROM ${F.tabela} WHERE id = ? AND empresa_id = ? FOR UPDATE`, [id, empresa]);
  if (!p) falha(`Pedido do ${F.nome} não encontrado.`, 404);
  const [[re]]: any = await c.query('SELECT cre, status FROM ven_requisicoes_externas WHERE empresa_id = ? AND origem = ? AND codigo_pedido = ?', [empresa, F.origem, String(p.numero_pedido)]);
  if (re) falha(`Pedido ${p.numero_pedido} do ${F.nome} já foi recebido (RE ${String(re.cre).padStart(9, '0')}, ${re.status}).`, 409);
  if (p.status !== F.pronto) falha(`Pedido ${p.numero_pedido} do ${F.nome} está ${p.status}: só o ${F.pronto} é recebido.`, 409);
  return p;
}

async function origemCnpj(c: PoolConnection) {
  const [[paf]]: any = await c.query('SELECT desenvolvedor_cnpj FROM sys_paf WHERE id = 1');
  return digitos(paf?.desenvolvedor_cnpj) || falha('Dados do PAF-NFC-e não cadastrados (tabela sys_paf).');
}

/** Frete do B2B no DAV: CIF = remetente (0), FOB = destinatário (1), retirada = sem frete (9) */
function freteB2b(p: any) {
  const modalidade = p.tipo_frete === 'CIF' ? 0 : p.tipo_frete === 'FOB_REDESPACHO' ? 1 : 9;
  return { modalidade_frete: modalidade, valor_frete: modalidade === 9 ? 0 : Number(p.valor_frete || 0) };
}

/** Observações do DAV: as do pedido + condição de pagamento e transportadora escolhidas no portal */
function observacoesB2b(p: any) {
  return [
    p.observacoes,
    p.condicao_pagamento && `Condição de pagamento (portal B2B): ${p.condicao_pagamento}`,
    p.transportadora_nome && `Transportadora indicada: ${p.transportadora_nome}`,
  ].filter(Boolean).join('\n') || null;
}

/** Histórico do pedido no portal B2B (a trilha que o comprador vê) */
async function historicoB2b(c: { query: PoolConnection['query'] }, pedidoId: number, anterior: string, novo: string, motivo: string | null) {
  await c.query(
    `INSERT INTO b2b_pedido_historico (pedido_id, status_anterior, status_novo, autor_tipo, autor_nome, motivo_justificativa, data_hora)
     VALUES (?, ?, ?, 'gestor_loja', 'Loja (erp-vendas)', ?, NOW())`,
    [pedidoId, anterior, novo, motivo],
  );
}

/**
 * Recebe o pedido externo: RE "recebida" + pedido (DAV) com os itens (e parcelas, no CRM). Dado inválido (cliente,
 * produto, parcelas que não fecham…) registra a RE como "denegada", sem DAV (Requisito XVI, § 3º).
 */
export async function receber(origem: unknown, id: unknown, empresa: number, uid: number | null, natureza: unknown) {
  const f = fonteDe(origem);
  const F = FONTES[f];
  const natureza_id = idOuNull(natureza) ?? falha('Escolha a natureza de operação.');
  const [[nat]]: any = await pool.query("SELECT 1 FROM ven_naturezas_operacao WHERE id = ? AND empresa_id = ? AND ativo = 1 AND documento IN ('nfe', 'nfce')", [natureza_id, empresa]);
  if (!nat) falha('Natureza de operação inválida: escolha uma de NF-e ou NFC-e ativa.');
  // Natureza do modelo errado é engano do operador, não dado inválido da origem: recusa sem denegar a RE
  // O total é o que o lerDav vai recalcular dos itens (não o valor_total da origem): conferido aqui, o erro de modelo não denega a RE
  const [[cp]]: any = await pool.query(`SELECT * FROM ${F.tabela} WHERE id = ? AND empresa_id = ?`, [id, empresa]);
  if (cp) {
    const [ci]: any = await pool.query(
      `SELECT x.quantidade, x.preco_unitario, x.desconto AS valor_desconto, pr.iat FROM (${F.itens}) x LEFT JOIN cad_produtos pr ON pr.id = x.produto_id`, [id]);
    const frete = f === 'b2b' ? freteB2b(cp).valor_frete : 0;
    await conferirModelo(pool, empresa, natureza_id, cp.pessoa_id, totais(ci.map((i: any) => ({ ...i, iat: i.iat ?? 'A' })), frete).valor_total);
  }

  try {
    return await transacao(async (c) => {
      const p = await pedidoExterno(c, f, id, empresa);
      const cre = await proximoCre(c, empresa);
      const [itens]: any = await c.query(
        `SELECT x.produto_id, x.quantidade, x.preco_unitario, x.desconto, pr.nome, COALESCE(um.sigla, 'UN') AS unidade
           FROM (${F.itens}) x LEFT JOIN cad_produtos pr ON pr.id = x.produto_id
           LEFT JOIN cad_produtos_unidades_medida um ON um.id = pr.unidade_id`,
        [p.id],
      );
      const [parcelas]: any = F.parcelas ? await c.query(F.parcelas, [p.id]) : [[]];
      const [[{ hoje }]]: any = await c.query('SELECT CURDATE() AS hoje');
      const { cabecalho: cab, linhas, linhasParcelas } = await lerDav(c, {
        natureza_id, pessoa_id: p.pessoa_id, data_emissao: hoje, parcelas,
        ...(f === 'b2b' ? { ...freteB2b(p), observacoes: observacoesB2b(p) } : { modalidade_frete: 9, observacoes: p.observacoes }),
        itens: itens.map((i: any) => ({ produto_id: i.produto_id, descricao: i.nome ?? '', unidade: i.unidade, quantidade: i.quantidade, preco_unitario: i.preco_unitario, valor_desconto: i.desconto })),
      }, empresa);
      const codigo = String(p.numero_pedido);
      const dav = await inserirDav(c, { ...cab, validade: null, origem: F.davOrigem, origem_id: p.id, referencia: codigo, usuario_id: uid }, empresa, 'pedido');
      await gravarFilhos(c, dav.id, linhas, linhasParcelas);
      await c.query('INSERT INTO ven_requisicoes_externas SET ?', [{
        empresa_id: empresa, cre, origem: F.origem, origem_cnpj: await origemCnpj(c), codigo_pedido: codigo, [F.coluna]: p.id,
        status: 'recebida', dav_id: dav.id, valor_total: cab.valor_total, usuario_id: uid,
      }]);
      if (f === 'b2b') await historicoB2b(c, p.id, p.status, p.status, `Recebido pela loja: RE ${String(cre).padStart(9, '0')}, pedido ${dav.numero}`);
      return { cre, status: 'recebida', dav: dav.numero };
    });
  } catch (e) {
    if (!(e instanceof ErroHttp) || e.status !== 400) throw e;
    const motivo = e.message.slice(0, 255);
    return transacao(async (c) => {
      const p = await pedidoExterno(c, f, id, empresa);
      const cre = await proximoCre(c, empresa);
      await c.query('INSERT INTO ven_requisicoes_externas SET ?', [{
        empresa_id: empresa, cre, origem: F.origem, origem_cnpj: await origemCnpj(c), codigo_pedido: String(p.numero_pedido), [F.coluna]: p.id,
        status: 'denegada', motivo, valor_total: 0, usuario_id: uid,
      }]);
      // No portal o pedido denegado volta como bloqueado, com o motivo, para o comprador ver
      if (f === 'b2b') {
        await c.query("UPDATE b2b_pedidos SET status = 'bloqueado', obs_bloqueio = ? WHERE id = ?", [motivo, p.id]);
        await historicoB2b(c, p.id, p.status, 'bloqueado', `Requisição denegada pela loja: ${motivo}`);
      }
      return { cre, status: 'denegada', motivo };
    });
  }
}

/** obsFisco "RE" da nota: CNPJ da responsável pela aplicação + código do pedido, um por RE dos DAV da venda */
export async function obsFiscoRe(vendaId: number) {
  const [re]: any = await pool.query(
    `SELECT DISTINCT re.origem_cnpj, re.codigo_pedido FROM ven_requisicoes_externas re
       JOIN ven_dav_itens di ON di.dav_id = re.dav_id JOIN ven_venda_itens vi ON vi.dav_item_id = di.id
      WHERE vi.venda_id = ? AND re.status <> 'denegada' ORDER BY re.codigo_pedido`,
    [vendaId],
  );
  return re.map((r: any) => ({ campo: 'RE', texto: `${r.origem_cnpj}${r.codigo_pedido}` }));
}

/** Nota da venda autorizada: RE dos DAV da venda → Atendida (§ 2º) e o pedido do CRM/B2B → Faturado (§ 4º) */
export async function atenderRe(vendaId: number) {
  const [re]: any = await pool.query(
    `SELECT DISTINCT re.id, re.crm_pedido_id, re.b2b_pedido_id FROM ven_requisicoes_externas re
       JOIN ven_dav_itens di ON di.dav_id = re.dav_id JOIN ven_venda_itens vi ON vi.dav_item_id = di.id
      WHERE vi.venda_id = ? AND re.status = 'recebida'`,
    [vendaId],
  );
  if (!re.length) return;
  await pool.query("UPDATE ven_requisicoes_externas SET status = 'atendida', atendida_em = NOW() WHERE id IN (?)", [re.map((r: any) => r.id)]);
  const crm = re.map((r: any) => r.crm_pedido_id).filter(Boolean);
  if (crm.length) await pool.query("UPDATE crm_pedidos SET status = 'faturado' WHERE id IN (?) AND status = 'aprovado'", [crm]);

  const b2b = re.map((r: any) => r.b2b_pedido_id).filter(Boolean);
  if (b2b.length) {
    const [[nota]]: any = await pool.query(
      'SELECT nd.chave FROM ven_vendas v JOIN nfe_documentos nd ON nd.id = v.nfe_documento_id WHERE v.id = ?', [vendaId]);
    const [peds]: any = await pool.query("SELECT id, status FROM b2b_pedidos WHERE id IN (?) AND status = 'fechado'", [b2b]);
    for (const p of peds) {
      await pool.query("UPDATE b2b_pedidos SET status = 'faturado', chave_nfe = ? WHERE id = ?", [nota?.chave ?? null, p.id]);
      await historicoB2b(pool as any, p.id, p.status, 'faturado', nota?.chave ? `NF-e autorizada: ${nota.chave}` : 'Nota autorizada');
    }
  }
}

export function createRequisicoesRouter() {
  const r = Router();

  /** Pedidos externos (CRM aprovados e B2B fechados): ainda não recebidos (pendentes) ou todos os que já têm RE */
  r.get('/crm/pedidos', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    const pendentes = req.query.ver !== 'recebidos';
    const consulta = (f: Fonte) => {
      const F = FONTES[f];
      return `SELECT '${f}' AS origem, c.id, c.numero_pedido, DATE_FORMAT(c.data_emissao, '%Y-%m-%d') AS data_emissao, c.valor_total,
                     c.status AS status_origem, p.nome AS cliente, p.cpf_cnpj, re.cre, re.status AS status_re, re.motivo, d.numero AS dav
                FROM ${F.tabela} c LEFT JOIN cad_pessoas p ON p.id = c.pessoa_id
                LEFT JOIN ven_requisicoes_externas re ON re.${F.coluna} = c.id
                LEFT JOIN ven_davs d ON d.id = re.dav_id
               WHERE c.empresa_id = ? AND ${pendentes ? `c.status = '${F.pronto}' AND re.id IS NULL` : 're.id IS NOT NULL'}`;
    };
    const [linhas] = await pool.query(
      `${consulta('crm')} UNION ALL ${consulta('b2b')} ORDER BY ${pendentes ? 'data_emissao, numero_pedido' : 'cre DESC'}`,
      [empresa, empresa],
    );
    return linhas;
  }));

  r.post('/crm/pedidos/:id/receber', rota(async (req, _res, s) =>
    receber(req.body?.origem, req.params.id, empresaDa(s), s.userId ?? null, req.body?.natureza_id)));

  return r;
}
