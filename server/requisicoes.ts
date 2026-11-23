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
 * Requisições Externas: pedidos aprovados no CRM (PAF-NFC-e de SC, Ato DIAT 54/2026, Requisito XVI e Requisito V, I, g).
 * Decisões do usuário (22/11/2026): o operador recebe na tela "Pedidos do CRM"; o obsFisco "RE" leva o CNPJ da BMsoft
 * (desenvolvedora do CRM, sys_paf) + o número do pedido; com a nota autorizada a RE fica Atendida e o pedido do CRM, Faturado.
 */

/** Nome da aplicação de origem (W4, campo 02: maiúsculas, sem acento) */
export const ORIGEM_CRM = 'BM-CRM';

/** CRE: inteiro sequencial de 9 dígitos por estabelecimento, nunca reaproveitado (Requisito XVI, I) */
async function proximoCre(c: PoolConnection, empresa: number) {
  await c.query('INSERT INTO ven_re_numeracao (empresa_id, ultimo) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE ultimo = LAST_INSERT_ID(ultimo + 1)', [empresa]);
  const [[{ n }]]: any = await c.query('SELECT LAST_INSERT_ID() AS n');
  return Number(n);
}

/** Pedido do CRM aprovado e ainda não recebido, travado para a transação */
async function pedidoCrm(c: PoolConnection, id: unknown, empresa: number) {
  const [[p]]: any = await c.query('SELECT * FROM crm_pedidos WHERE id = ? AND empresa_id = ? FOR UPDATE', [id, empresa]);
  if (!p) falha('Pedido do CRM não encontrado.', 404);
  const [[re]]: any = await c.query('SELECT cre, status FROM ven_requisicoes_externas WHERE empresa_id = ? AND origem = ? AND codigo_pedido = ?', [empresa, ORIGEM_CRM, String(p.numero_pedido)]);
  if (re) falha(`Pedido ${p.numero_pedido} do CRM já foi recebido (RE ${String(re.cre).padStart(9, '0')}, ${re.status}).`, 409);
  if (p.status !== 'aprovado') falha(`Pedido ${p.numero_pedido} do CRM está ${p.status}: só o aprovado é recebido.`, 409);
  return p;
}

async function origemCnpj(c: PoolConnection) {
  const [[paf]]: any = await c.query('SELECT desenvolvedor_cnpj FROM sys_paf WHERE id = 1');
  return digitos(paf?.desenvolvedor_cnpj) || falha('Dados do PAF-NFC-e não cadastrados (tabela sys_paf).');
}

/**
 * Recebe o pedido do CRM: RE "recebida" + pedido (DAV) com os itens e parcelas do CRM. Dado inválido (cliente,
 * produto, parcelas que não fecham…) registra a RE como "denegada", sem DAV (Requisito XVI, § 3º).
 */
export async function receber(id: unknown, empresa: number, uid: number | null, natureza: unknown) {
  const natureza_id = idOuNull(natureza) ?? falha('Escolha a natureza de operação.');
  const [[nat]]: any = await pool.query("SELECT 1 FROM ven_naturezas_operacao WHERE id = ? AND empresa_id = ? AND ativo = 1 AND documento IN ('nfe', 'nfce')", [natureza_id, empresa]);
  if (!nat) falha('Natureza de operação inválida: escolha uma de NF-e ou NFC-e ativa.');
  // Natureza do modelo errado é engano do operador, não dado inválido do CRM: recusa sem denegar a RE
  // O total é o que o lerDav vai recalcular dos itens (não o valor_total do CRM): conferido aqui, o erro de modelo não denega a RE
  const [[cp]]: any = await pool.query('SELECT pessoa_id FROM crm_pedidos WHERE id = ? AND empresa_id = ?', [id, empresa]);
  if (cp) {
    const [ci]: any = await pool.query(
      'SELECT i.quantidade, i.preco_unitario, i.desconto AS valor_desconto, pr.iat FROM crm_pedido_itens i LEFT JOIN cad_produtos pr ON pr.id = i.produto_id WHERE i.pedido_id = ?', [id]);
    await conferirModelo(pool, empresa, natureza_id, cp.pessoa_id, totais(ci.map((i: any) => ({ ...i, iat: i.iat ?? 'A' }))).valor_total);
  }

  try {
    return await transacao(async (c) => {
      const p = await pedidoCrm(c, id, empresa);
      const cre = await proximoCre(c, empresa);
      const [itens]: any = await c.query(
        `SELECT i.produto_id, i.quantidade, i.preco_unitario, i.desconto, pr.nome, COALESCE(um.sigla, 'UN') AS unidade
           FROM crm_pedido_itens i LEFT JOIN cad_produtos pr ON pr.id = i.produto_id
           LEFT JOIN cad_produtos_unidades_medida um ON um.id = pr.unidade_id
          WHERE i.pedido_id = ? ORDER BY i.id`,
        [p.id],
      );
      const [parcelas]: any = await c.query('SELECT vencimento, forma_pagamento, valor FROM crm_pedido_parcelas WHERE pedido_id = ? ORDER BY numero', [p.id]);
      const [[{ hoje }]]: any = await c.query('SELECT CURDATE() AS hoje');
      const { cabecalho: cab, linhas, linhasParcelas } = await lerDav(c, {
        natureza_id, pessoa_id: p.pessoa_id, data_emissao: hoje, modalidade_frete: 9, observacoes: p.observacoes, parcelas,
        itens: itens.map((i: any) => ({ produto_id: i.produto_id, descricao: i.nome ?? '', unidade: i.unidade, quantidade: i.quantidade, preco_unitario: i.preco_unitario, valor_desconto: i.desconto })),
      }, empresa);
      const codigo = String(p.numero_pedido);
      const dav = await inserirDav(c, { ...cab, validade: null, origem: 'crm', origem_id: p.id, referencia: codigo, usuario_id: uid }, empresa, 'pedido');
      await gravarFilhos(c, dav.id, linhas, linhasParcelas);
      await c.query('INSERT INTO ven_requisicoes_externas SET ?', [{
        empresa_id: empresa, cre, origem: ORIGEM_CRM, origem_cnpj: await origemCnpj(c), codigo_pedido: codigo, crm_pedido_id: p.id,
        status: 'recebida', dav_id: dav.id, valor_total: cab.valor_total, usuario_id: uid,
      }]);
      return { cre, status: 'recebida', dav: dav.numero };
    });
  } catch (e) {
    if (!(e instanceof ErroHttp) || e.status !== 400) throw e;
    const motivo = e.message.slice(0, 255);
    return transacao(async (c) => {
      const p = await pedidoCrm(c, id, empresa);
      const cre = await proximoCre(c, empresa);
      await c.query('INSERT INTO ven_requisicoes_externas SET ?', [{
        empresa_id: empresa, cre, origem: ORIGEM_CRM, origem_cnpj: await origemCnpj(c), codigo_pedido: String(p.numero_pedido), crm_pedido_id: p.id,
        status: 'denegada', motivo, valor_total: 0, usuario_id: uid,
      }]);
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

/** Nota da venda autorizada: RE dos DAV da venda → Atendida (§ 2º) e o pedido do CRM → Faturado (§ 4º) */
export async function atenderRe(vendaId: number) {
  const [re]: any = await pool.query(
    `SELECT DISTINCT re.id, re.crm_pedido_id FROM ven_requisicoes_externas re
       JOIN ven_dav_itens di ON di.dav_id = re.dav_id JOIN ven_venda_itens vi ON vi.dav_item_id = di.id
      WHERE vi.venda_id = ? AND re.status = 'recebida'`,
    [vendaId],
  );
  if (!re.length) return;
  await pool.query("UPDATE ven_requisicoes_externas SET status = 'atendida', atendida_em = NOW() WHERE id IN (?)", [re.map((r: any) => r.id)]);
  const crm = re.map((r: any) => r.crm_pedido_id).filter(Boolean);
  if (crm.length) await pool.query("UPDATE crm_pedidos SET status = 'faturado' WHERE id IN (?) AND status = 'aprovado'", [crm]);
}

export function createRequisicoesRouter() {
  const r = Router();

  /** Pedidos do CRM: aprovados ainda não recebidos (pendentes) ou todos os que já têm RE */
  r.get('/crm/pedidos', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    const pendentes = req.query.ver !== 'recebidos';
    const [linhas] = await pool.query(
      `SELECT c.id, c.numero_pedido, DATE_FORMAT(c.data_emissao, '%Y-%m-%d') AS data_emissao, c.valor_total, c.status AS status_crm,
              p.nome AS cliente, p.cpf_cnpj, re.cre, re.status AS status_re, re.motivo, d.numero AS dav
         FROM crm_pedidos c LEFT JOIN cad_pessoas p ON p.id = c.pessoa_id
         LEFT JOIN ven_requisicoes_externas re ON re.crm_pedido_id = c.id
         LEFT JOIN ven_davs d ON d.id = re.dav_id
        WHERE c.empresa_id = ? AND ${pendentes ? "c.status = 'aprovado' AND re.id IS NULL" : 're.id IS NOT NULL'}
        ORDER BY ${pendentes ? 'c.numero_pedido' : 're.cre DESC'}`,
      [empresa],
    );
    return linhas;
  }));

  r.post('/crm/pedidos/:id/receber', rota(async (req, _res, s) => receber(req.params.id, empresaDa(s), s.userId ?? null, req.body?.natureza_id)));

  return r;
}
