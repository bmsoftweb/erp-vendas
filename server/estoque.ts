import { masterPool as pool } from './db.js';

/**
 * Baixa de estoque dos DF-e de venda (PAF-NFC-e: o registro E2 do Arquivo I mostra o estoque atualizado pelas vendas).
 * Grava no estoque do erp-estoque, no mesmo formato do lançamento dele (POST /movimento: est_estoque_movimentacoes +
 * est_estoque_saldo por lote e localização), então a venda aparece na tela de Movimento e no saldo de lá.
 * Cópia de erp-pdv/code/server/estoque.ts (só o import do pool muda): mudar lá também.
 *
 * - Cada nota é um documento (referencia_tipo 'nfe_documento', referencia_id = nfe_documentos.id): baixar de novo a
 *   mesma nota não faz nada.
 * - A venda nunca trava por falta de estoque: o saldo pode ficar negativo (extras/2026-11-23_saldo_negativo.sql do
 *   erp-estoque tira o CHECK chk_saldo_qtd), e o E2 sai com o sinal "-".
 * - Lote/localização: o saldo do produto com mais quantidade na filial; sem saldo, o primeiro lote ativo do produto (cria
 *   o lote "0" se não houver) na primeira localização física da filial. Filial sem localização: não baixa.
 * - Nota cancelada, rejeitada ou denegada que tinha baixado volta ao estoque (estornarCancelados), venha o cancelamento
 *   do caixa, do erp-vendas ou da tela do erp-nfe.
 * - custo_medio e estoque_valor por produto + variante + filial, na conta do erp-compras: a saída mantém o médio.
 * - Datas pelo NOW() do MySQL: o pool fixa a sessão em -03:00 (Brasília).
 * ponytail: só a nota de saída; NF-e de devolução/estorno (entrada) não movimenta, acrescentar quando o PAF emitir.
 */

const REF = 'nfe_documento';

export interface ItemBaixa { produto_id: number; variante_id?: number | null; quantidade: number }

async function localDoItem(c: any, empresa: number, it: ItemBaixa) {
  const variante = Number(it.variante_id) || 0;
  const [[s]]: any = await c.query(
    `SELECT s.lote_id, s.localizacao_id, l.preco_custo FROM est_estoque_saldo s
       JOIN cad_produtos_lotes l ON l.id = s.lote_id
       JOIN cad_produtos_localizacoes lc ON lc.id = s.localizacao_id
      WHERE l.produto_id = ? AND COALESCE(l.variante_id, 0) = ? AND lc.empresa_id = ? AND lc.tipo <> 'virtual'
      ORDER BY s.quantidade - s.reservado DESC, s.id LIMIT 1`,
    [it.produto_id, variante, empresa],
  );
  if (s) return s;
  const [[loc]]: any = await c.query("SELECT id FROM cad_produtos_localizacoes WHERE empresa_id = ? AND ativo = 1 AND tipo <> 'virtual' ORDER BY id LIMIT 1", [empresa]);
  if (!loc) return null;
  let [[lote]]: any = await c.query(
    'SELECT id AS lote_id, preco_custo FROM cad_produtos_lotes WHERE produto_id = ? AND COALESCE(variante_id, 0) = ? AND ativo = 1 ORDER BY id LIMIT 1',
    [it.produto_id, variante],
  );
  if (!lote) {
    const [[p]]: any = await c.query('SELECT sku FROM cad_produtos WHERE id = ?', [it.produto_id]);
    const [ins]: any = await c.query(
      `INSERT INTO cad_produtos_lotes (grupo_id, codigo, numero_lote, produto_id, variante_id, observacao)
       VALUES ((SELECT grupo_id FROM sys_empresas WHERE id = ?), ?, '0', ?, ?, 'Criado pela baixa da venda')`,
      [empresa, String(p?.sku || it.produto_id).slice(0, 100), it.produto_id, variante || null],
    );
    lote = { lote_id: ins.insertId, preco_custo: 0 };
  }
  return { lote_id: lote.lote_id, localizacao_id: loc.id, preco_custo: lote.preco_custo };
}

const casas = (v: number, c: number) => Math.round(v * 10 ** c) / 10 ** c;

/**
 * Saldo e custo médio do produto na filial (produto + variante, lotes e localizações não virtuais somados), com o
 * produto e as linhas de saldo travados. Mesma conta do erp-compras (server/estoque.ts de lá): médio = o do último
 * movimento da filial com a coluna; sem nenhum, o preco_custo do lote.
 */
async function posicao(c: any, empresa: number, produto: number, variante: number | null, custoLote: unknown) {
  await c.query('SELECT id FROM cad_produtos WHERE id = ? FOR UPDATE', [produto]);
  const [saldos]: any = await c.query(
    `SELECT s.quantidade FROM est_estoque_saldo s
       JOIN cad_produtos_lotes l ON l.id = s.lote_id
       JOIN cad_produtos_localizacoes lc ON lc.id = s.localizacao_id
      WHERE l.produto_id = ? AND COALESCE(l.variante_id, 0) = ? AND lc.empresa_id = ? AND lc.tipo <> 'virtual'
      FOR UPDATE`,
    [produto, variante ?? 0, empresa],
  );
  const [[mov]]: any = await c.query(
    `SELECT custo_medio FROM est_estoque_movimentacoes
      WHERE empresa_id = ? AND produto_id = ? AND COALESCE(variante_id, 0) = ? AND custo_medio IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [empresa, produto, variante ?? 0],
  );
  const qtd = saldos.reduce((s: number, x: any) => s + Number(x.quantidade), 0);
  return { qtd, medio: mov ? Number(mov.custo_medio) : Number(custoLote) > 0 ? Number(custoLote) : null };
}

async function mover(c: any, empresa: number, tipo: 'saida' | 'entrada', lote: number, loc: number, q: number, custo: unknown,
  docId: number, produto: number, variante: number | null, usuario: string, obs: string) {
  // A venda não muda o médio; a volta da nota cancelada entra pelo custo com que saiu. Sem médio conhecido, fica sem valor.
  const p = await posicao(c, empresa, produto, variante, custo);
  let medio = p.medio;
  if (tipo === 'entrada' && Number(custo) > 0) medio = p.qtd <= 0 || medio === null ? Number(custo) : casas((p.qtd * medio + q * Number(custo)) / (p.qtd + q), 6);
  const valor = medio === null ? null : casas((p.qtd + (tipo === 'saida' ? -q : q)) * medio, 2);
  await c.query(
    `INSERT INTO est_estoque_movimentacoes (empresa_id, tipo, lote_id, localizacao_orig_id, localizacao_dest_id, quantidade, custo_unitario,
       estoque_valor, custo_medio, referencia_tipo, referencia_id, produto_id, variante_id, usuario, observacao, date_insert)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [empresa, tipo, lote, tipo === 'saida' ? loc : null, tipo === 'entrada' ? loc : null, q, Number(custo) || null, valor, medio,
      REF, docId, produto, variante || null, (usuario || 'Sistema').slice(0, 100), obs],
  );
  await c.query(
    `INSERT INTO est_estoque_saldo (lote_id, localizacao_id, quantidade, reservado, date_update) VALUES (?, ?, ?, 0, NOW())
     ON DUPLICATE KEY UPDATE quantidade = quantidade + VALUES(quantidade), date_update = NOW()`,
    [lote, loc, tipo === 'saida' ? -q : q],
  );
}

/** Saída dos itens da nota (uma vez por nota) e estorno das notas que deixaram de valer */
export async function baixarEstoque(empresa: number, docId: number, itens: ItemBaixa[], usuario: string, obs: string) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    // Já baixada = o último movimento da nota é saída (estornada e emitida de novo pela mesma referência, baixa outra vez)
    const [[ultimo]]: any = await c.query('SELECT tipo FROM est_estoque_movimentacoes WHERE referencia_tipo = ? AND referencia_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE', [REF, docId]);
    if (ultimo?.tipo !== 'saida') {
      for (const it of itens) {
        const q = Number(it.quantidade);
        if (!(q > 0)) continue;
        const l = await localDoItem(c, empresa, it);
        if (!l) {
          console.error(`Estoque: empresa ${empresa} sem localização física; a nota ${docId} não baixou o estoque.`);
          break;
        }
        await mover(c, empresa, 'saida', l.lote_id, l.localizacao_id, q, l.preco_custo, docId, it.produto_id, Number(it.variante_id) || null, usuario, obs);
      }
    }
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
  await estornarCancelados(empresa);
}

/**
 * Devolve ao estoque as saídas de notas canceladas, rejeitadas ou denegadas, uma vez por nota.
 * ponytail: varre as saídas da filial a cada venda e no Menu Fiscal; índice em (referencia_tipo, referencia_id) se pesar.
 */
export async function estornarCancelados(empresa: number) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    // Saídas ainda não estornadas (depois do último estorno da nota), travadas para dois estornos ao mesmo tempo não dobrarem
    const [saidas]: any = await c.query(
      `SELECT m.* FROM est_estoque_movimentacoes m
         JOIN nfe_documentos n ON n.id = m.referencia_id
        WHERE m.empresa_id = ? AND m.referencia_tipo = ? AND m.tipo = 'saida'
          AND n.situacao NOT IN ('autorizada', 'contingencia', 'enviada', 'processando', 'assinada')
          AND m.id > COALESCE((SELECT MAX(e.id) FROM est_estoque_movimentacoes e
                                WHERE e.referencia_tipo = m.referencia_tipo AND e.referencia_id = m.referencia_id AND e.tipo = 'entrada'), 0)
        FOR UPDATE`,
      [empresa, REF],
    );
    for (const m of saidas)
      await mover(c, empresa, 'entrada', m.lote_id, m.localizacao_orig_id, Number(m.quantidade), m.custo_unitario, m.referencia_id, m.produto_id, m.variante_id, 'estorno', `Estorno: ${m.observacao ?? ''}`.slice(0, 500));
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
