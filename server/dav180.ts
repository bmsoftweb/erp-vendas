import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { aprovarOrcamento, davAberto, modeloExigido, naturezaDeVenda, transacao } from './davs.js';
import { DAV_VENCIDO, EMITIDO_HA_180, FATURADO, faturarItens } from './vendas.js';
import { emitirVenda } from './notas.js';
import { totais } from '../lib/totais.js';

/**
 * NFC-e automática dos DAV em aberto há mais de 180 dias (PAF-NFC-e de SC, Ato DIAT 54/2026, Requisito V, § 2º).
 * Decisões do usuário (22/11/2026): pedidos (aberto ou parcial, o saldo não faturado), pagamento tPag 90
 * "Sem pagamento", a primeira natureza de NFC-e ativa da empresa e rotina diária, em nome de quem criou o pedido.
 * Orçamento aberto também (23/11/2026): vira pedido como no "Aprovar", e o pedido conta o prazo desde o orçamento.
 * Com a nota autorizada, o pedido passa a "associado a um DF-e" (situação E do Controle dos DAV).
 * Pedido já todo numa venda sem nota (aberta, faturando ou rejeitada) fica "faturado" sem DF-e: a rotina emite essa
 * venda como está (a do usuário também); se não sair, a lista de vendas avisa até alguém corrigir (decisão de 22/11/2026).
 *
 * Roda uma vez por dia: no servidor local (agendarDav180, no server.ts) e na Vercel pelo cron do vercel.json
 * (GET /api/cron/dav-180, com o CRON_SECRET).
 */

/** Vai nas informações complementares da venda; também marca as vendas desta rotina para retomar a emissão */
export const INFO_180 = 'NFC-e emitida automaticamente: DAV em aberto ha mais de 180 dias (Ato DIAT 54/2026, Requisito V, par. 2).';

const num = (n: unknown) => String(n).padStart(10, '0');

export async function emitirDav180() {
  const resultado: string[] = [];

  // 0) Orçamento aberto vencido → pedido (o "Aprovar"), em nome de quem criou o orçamento; o passo 1 fatura
  const [orcamentos]: any = await pool.query(
    `SELECT id, empresa_id, numero, usuario_id FROM ven_davs
      WHERE tipo = 'orcamento' AND status = 'aberto' AND data_emissao < CURDATE() - INTERVAL 180 DAY
      ORDER BY empresa_id, numero`,
  );
  for (const o of orcamentos) {
    try {
      if (!o.usuario_id) throw new Error('orçamento sem o usuário que o criou');
      const pedido = await transacao(async (c) => aprovarOrcamento(c, await davAberto(c, o.id, o.empresa_id), o.usuario_id));
      resultado.push(`orçamento ${num(o.numero)}: pedido ${num(pedido.numero)} criado`);
    } catch (e: any) {
      resultado.push(`orçamento ${num(o.numero)} (empresa ${o.empresa_id}): ${e?.message ?? e}`);
    }
  }

  // 1) Pedido vencido → venda com o saldo de cada item
  const [pedidos]: any = await pool.query(
    `SELECT d.id, d.empresa_id, d.numero, d.usuario_id, d.pessoa_id, d.natureza_id, d.status, d.valor_frete FROM ven_davs d
      WHERE d.tipo = 'pedido' AND d.status IN ('aberto', 'parcial') AND ${EMITIDO_HA_180('d')}
      ORDER BY d.empresa_id, d.numero`,
  );
  for (const p of pedidos) {
    try {
      if (!p.usuario_id) throw new Error('pedido sem o usuário que o criou');
      const [saldos]: any = await pool.query(
        `SELECT i.id, i.quantidade, i.preco_unitario, i.valor_desconto, (SELECT iat FROM cad_produtos WHERE id = i.produto_id) AS iat,
                i.quantidade - COALESCE(f.q, 0) AS saldo FROM ven_dav_itens i LEFT JOIN (${FATURADO}) f ON f.dav_item_id = i.id
          WHERE i.dav_id = ? AND i.cancelado = 0 HAVING saldo > 0`,
        [p.id],
      );
      if (!saldos.length) continue;
      // Valor do saldo que vai na nota, com desconto proporcional e o frete do pedido ainda aberto (como faturarItens)
      const linhas = saldos.map((x: any) => {
        const q = Number(x.saldo);
        const inteiro = Math.round(q * 10000) === Math.round(Number(x.quantidade) * 10000);
        const desconto = inteiro ? Number(x.valor_desconto) : Math.round((Number(x.valor_desconto) * q) / Number(x.quantidade) * 100) / 100;
        return { quantidade: q, preco_unitario: x.preco_unitario, valor_desconto: desconto, iat: x.iat };
      });
      const aFaturar = totais(linhas, p.status === 'aberto' ? p.valor_frete : 0).valor_total;
      // Cliente que exige NF-e (CNPJ, produtor rural) ou saldo de R$ 200 mil ou mais (Anexo 11, art. 96, § 7º):
      // NF-e, de preferência com a natureza do pedido; senão NFC-e (Requisito IV)
      const nfe = (await modeloExigido(pool, p.empresa_id, p.pessoa_id, aFaturar)) === 'nfe';
      const nat = { id: await naturezaDeVenda(pool, p.empresa_id, nfe ? 'nfe' : 'nfce', p.natureza_id) }; // só natureza de venda (CFOP 5.1xx/5.4xx)
      const qtd = new Map<number, number>(saldos.map((s: any) => [s.id, Number(s.saldo)]));
      const venda = await transacao((c) => faturarItens(c, p.empresa_id, p.usuario_id, qtd, { natureza_id: nat.id, semPagamento: true, info: INFO_180 }));
      resultado.push(`pedido ${num(p.numero)}: venda ${venda.numero} criada`);
    } catch (e: any) {
      resultado.push(`pedido ${num(p.numero)} (empresa ${p.empresa_id}): ${e?.message ?? e}`);
    }
  }

  // 2) Vendas sem nota com pedido de mais de 180 dias (as do passo 1 e as que o usuário deixou abertas, sem resposta
  // ou rejeitadas) → emite. Rejeitada tenta de novo; continuando assim, fica no aviso da lista de vendas.
  const [vendas]: any = await pool.query(
    `SELECT v.id, v.empresa_id, v.numero, v.usuario_id FROM ven_vendas v
      WHERE v.status IN ('aberta', 'faturando', 'rejeitada') AND ${DAV_VENCIDO('v')} ORDER BY v.id`,
  );
  for (const v of vendas) {
    try {
      if (!v.usuario_id) throw new Error('venda sem o usuário que a criou');
      const r = await emitirVenda(v.id, v.empresa_id, Number(v.usuario_id));
      resultado.push(`venda ${v.numero}: NFC-e ${r.situacao}${r.numero ? ` nº ${r.numero}` : ''}${r.motivo ? ` (${r.motivo})` : ''}`);
    } catch (e: any) {
      resultado.push(`venda ${v.numero} (empresa ${v.empresa_id}): ${e?.message ?? e}`);
    }
  }

  if (resultado.length) console.log(`[DAV 180 dias]\n  ${resultado.join('\n  ')}`);
  return resultado;
}

/** Servidor local: 1 minuto depois de subir e depois a cada 24 horas */
export function agendarDav180() {
  const rodar = () => void emitirDav180().catch((e) => console.error('[DAV 180 dias]', e));
  setTimeout(rodar, 60_000);
  setInterval(rodar, 24 * 60 * 60_000);
}

/** Cron da Vercel: chama com "Authorization: Bearer <CRON_SECRET>" */
export function createDav180Router() {
  const r = Router();
  r.get('/cron/dav-180', async (req, res) => {
    const segredo = process.env.CRON_SECRET;
    if (!segredo || req.headers.authorization !== `Bearer ${segredo}`) return void res.status(401).json({ error: 'Não autorizado.' });
    try {
      res.json({ success: true, resultado: await emitirDav180() });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
  return r;
}
