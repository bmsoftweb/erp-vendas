import { masterPool as pool } from './db.js';
import { falha } from './http.js';

/**
 * Integração com o erp-financ (FINANC_URL + FINANC_CHAVE_API, a mesma chave do .env do financeiro). Sem FINANC_URL,
 * nada é conferido nem enviado.
 *  - venda a prazo: conferirCredito antes de gravar as parcelas (cliente bloqueado, atraso, limite);
 *  - nota autorizada: gerarTitulo, o financeiro monta o título a receber lendo a venda;
 *  - cancelar a nota: antes, podeCancelarTitulo (recusa se alguma parcela já foi recebida); depois, cancelarTitulo.
 * Se o financeiro estava fora ao gerar/cancelar, a rodada agendada dele acerta sozinha (o cancelamento da nota não espera).
 */

async function financ(empresa: number, caminho: string, corpo?: unknown) {
  const r = await fetch(`${process.env.FINANC_URL!.replace(/\/+$/, '')}/api/financ${caminho}`, {
    method: corpo === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${process.env.FINANC_CHAVE_API ?? ''}`, 'X-Empresa-Id': String(empresa), 'Content-Type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: r.status, dados: (await r.json().catch(() => ({}))) as any };
}

/** Formas cobradas pela própria loja: são venda a prazo mesmo vencendo no dia */
const COBRADAS_PELA_LOJA = new Set(['Boleto', 'Cheque', 'Cartão da loja', 'Crédito em loja']);

/**
 * Venda a prazo (parcela vencendo depois da emissão ou em forma cobrada pela loja): o financeiro diz se o cliente pode
 * comprar. Financeiro fora do ar recusa a venda a prazo (à vista passa).
 * ponytail: a consulta roda dentro da transação da venda (até 10 s com os pedidos travados); tirar dela se demorar.
 */
export async function conferirCredito(empresa: number, pessoaId: number | null, emissao: string, parcelas: any[]) {
  if (!process.env.FINANC_URL || !pessoaId) return;
  const centavos = parcelas
    .filter((p) => COBRADAS_PELA_LOJA.has(p.forma_pagamento) || String(p.vencimento).slice(0, 10) > emissao)
    .reduce((s, p) => s + Math.round(Number(p.valor) * 100), 0);
  if (!centavos) return;
  const r = await financ(empresa, `/pessoas/${pessoaId}/situacao?valor=${(centavos / 100).toFixed(2)}`)
    .catch(() => falha('Financeiro fora do ar: não deu para conferir o crédito do cliente. Tente de novo ou venda à vista.', 503));
  if (r.status >= 400) falha(`Financeiro: ${r.dados.error ?? `erro ${r.status}`}`, 502);
  if (!r.dados.pode_vender_a_prazo) falha(`Venda a prazo bloqueada pelo financeiro: ${(r.dados.motivos ?? []).join(' ')}`, 409);
}

/** Nota autorizada: título a receber da venda (com cliente e alguma parcela que não seja "Sem pagamento"). Não falha a venda. */
export async function gerarTitulo(empresa: number, vendaId: number) {
  if (!process.env.FINANC_URL) return;
  try {
    const [[v]]: any = await pool.query(
      "SELECT 1 AS ok FROM ven_vendas v WHERE v.id = ? AND v.pessoa_id IS NOT NULL AND EXISTS (SELECT 1 FROM ven_venda_parcelas p WHERE p.venda_id = v.id AND p.forma_pagamento <> 'Sem pagamento')",
      [vendaId],
    );
    if (!v) return;
    const r = await financ(empresa, '/receber/titulos', { venda_id: vendaId });
    if (r.status >= 400) console.error(`Venda ${vendaId}: o financeiro recusou o título (${r.dados.error ?? r.status}); a rodada do financeiro tenta de novo.`);
  } catch (e: any) {
    console.error(`Venda ${vendaId}: financeiro fora do ar (${e?.message ?? e}); a rodada do financeiro cria o título depois.`);
  }
}

/** Antes de cancelar a nota: parcela já recebida (ou renegociada) no financeiro impede, com a lista na mensagem */
export async function podeCancelarTitulo(empresa: number, vendaId: number) {
  if (!process.env.FINANC_URL) return;
  const r = await financ(empresa, `/receber/titulos/venda/${vendaId}/cancelar`, { simular: true })
    .catch(() => falha('Financeiro fora do ar: não deu para conferir se a venda já tem parcela recebida. Tente de novo.', 503));
  if (r.status === 404) return; // venda que não virou título
  if (r.status >= 400) falha(`Financeiro: ${r.dados.error ?? `erro ${r.status}`}`, r.status === 409 ? 409 : 502);
}

/** Depois de cancelar a nota: cancela as parcelas no financeiro. Não falha (a rodada do financeiro acerta). */
export async function cancelarTitulo(empresa: number, vendaId: number, motivo: string) {
  if (!process.env.FINANC_URL) return;
  try {
    const r = await financ(empresa, `/receber/titulos/venda/${vendaId}/cancelar`, { motivo: motivo.slice(0, 255) });
    if (r.status >= 400 && r.status !== 404) console.error(`Venda ${vendaId} cancelada, mas o financeiro recusou cancelar o título: ${r.dados.error ?? r.status}`);
  } catch (e: any) {
    console.error(`Venda ${vendaId} cancelada com o financeiro fora do ar (${e?.message ?? e}); a rodada do financeiro cancela o título.`);
  }
}
