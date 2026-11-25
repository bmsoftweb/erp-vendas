import { brutoItem } from '../lib/totais.js';
import crypto from 'crypto';
import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { ErroHttp, falha, rota } from './http.js';
import { conferirModelo, transacao } from './davs.js';
import type { SessionData } from './session.js';
import { atenderRe, obsFiscoRe } from './requisicoes.js';
import { ehVenda } from '../lib/modelo.js';
import { TPAG } from '../lib/parcelas.js';
import { baixarEstoque, estornarCancelados } from './estoque.js';
import { atualizarPedidos } from './vendas.js';
import { cancelarTitulo, gerarTitulo, podeCancelarTitulo } from './financ.js';

/**
 * Emissão da nota da venda pelos concentradores do erp-nfe (NF-e/NFC-e) e do erp-nfs (NFS-e).
 * Contrato: doc/contrato-erp-nfe-nfs.md. Referência VENDA-<id>: repetir a chamada nunca gera outra nota.
 *
 * Autenticação: o token de sessão de cada app (HMAC-SHA256 com o SESSION_SECRET dele, que aqui fica em
 * NFE_SECRET / NFS_SECRET), gerado para o próprio usuário logado. A nota sai em nome de quem faturou.
 *
 * Dados fiscais: NCM/CEST do cad_produtos + grupo tributário (fis_grupos_tributarios) para NF-e;
 * código de serviço, NBS e ISS do cad_produtos para NFS-e. O erp-nfe calcula os impostos.
 */

/**
 * Identificação do PAF-NFC-e (Ato DIAT 54/2026, Requisito IV, § 4º): o nome vai no obsFisco "PAF" e a versão no verProc
 * de toda NF-e/NFC-e. PAF único com o erp-pdv (decisão de 23/11/2026): o nome é o dele e o Menu Fiscal fica lá,
 * consolidando as notas "VENDA-%" e os DAV daqui (Requisito VI, § 6º).
 */
export const PAF = { nome: 'BM-PDV' };

/** Versão do PAF-NFC-e: uma só para o erp-pdv e o erp-vendas (PAF único), na sys_paf (extras/2026-11-23_sys_paf_versao.sql do erp-pdv) */
export async function versaoPaf(): Promise<string> {
  const [[p]]: any = await pool.query('SELECT versao FROM sys_paf WHERE id = 1');
  return p?.versao || falha('Versão do PAF-NFC-e não cadastrada (sys_paf.versao).');
}


type App = 'nfe' | 'nfs';
const ENV = { nfe: { url: 'NFE_URL', segredo: 'NFE_SECRET', nome: 'erp-nfe' }, nfs: { url: 'NFS_URL', segredo: 'NFS_SECRET', nome: 'erp-nfs' } };

/** Mesmo formato do criarToken do erp-nfe/erp-nfs: base64url({uid, emp, exp}).assinatura */
export function tokenPara(segredo: string, uid: number, emp: number, agoraMs = Date.now()): string {
  const corpo = Buffer.from(JSON.stringify({ uid, emp, exp: agoraMs + 5 * 60_000 })).toString('base64url');
  return `${corpo}.${crypto.createHmac('sha256', segredo).update(corpo).digest('base64url')}`;
}

/** POST no erp-nfe/erp-nfs com o token do usuário; devolve a resposta crua (JSON ou PDF) */
export async function postar(app: App, emitente: number, uid: number, caminho: string, corpo: unknown) {
  const url = process.env[ENV[app].url];
  const segredo = process.env[ENV[app].segredo] || '';
  if (!url || segredo.length < 32) falha(`Integração com o ${ENV[app].nome} não configurada (${ENV[app].url} e ${ENV[app].segredo} no .env).`, 503);
  try {
    return await fetch(`${url!.replace(/\/$/, '')}${caminho}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenPara(segredo, uid, emitente)}` },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e: any) {
    throw new ErroHttp(504, `Sem resposta do ${ENV[app].nome} (${e?.message ?? e}). Tente de novo: a mesma venda nunca gera duas notas.`);
  }
}

async function chamar(app: App, emitente: number, uid: number, caminho: string, corpo: unknown) {
  const r = await postar(app, emitente, uid, caminho, corpo);
  const dados: any = await r.json().catch(() => ({}));
  return { status: r.status, dados };
}

/** Erro do concentrador em texto (400/409/422, com a lista de erros de schema quando vier) */
export const mensagemDe = (d: any, status: number) =>
  [d?.error || d?.motivo || `HTTP ${status}`, ...(Array.isArray(d?.errosSchema) ? d.errosSchema.map((e: any) => `• ${typeof e === 'string' ? e : e?.mensagem ?? JSON.stringify(e)}`) : [])].join('\n');

/** tPag com grupo de cartão (tabela de meios do erp-pdv) */
const CARTAO = ['03', '04', '05', '10', '11', '12', '13', '17', '18', '19'];
/** IBS/CBS de 2026, ano de teste da LC 214/2025 (CBS 0,9 %, IBS 0,1 %) */
export const IBS_UF = 0.1; // só no CST 000 (decisão de 23/11/2026)
const CBS = 0.9; // só no CST 000 (decisão de 23/11/2026)

/** Coluna de inscrição estadual do cad_pessoas, se existir neste banco */
let colunaIE: string | null | undefined;
async function ieDe(pessoaId: number): Promise<string> {
  if (colunaIE === undefined) {
    const [r]: any = await pool.query(
      "SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cad_pessoas' AND COLUMN_NAME IN ('inscricao_estadual', 'ie', 'rg_ie') LIMIT 1",
    );
    colunaIE = r[0]?.c ?? null;
  }
  if (!colunaIE) return '';
  const [[p]]: any = await pool.query(`SELECT ${colunaIE} AS ie FROM cad_pessoas WHERE id = ?`, [pessoaId]);
  return String(p?.ie ?? '').trim();
}

/** Tudo o que a nota precisa, lido do banco */
export async function carregar(vendaId: unknown, empresa: number) {
  const [[v]]: any = await pool.query(
    `SELECT v.*, n.descricao AS natureza, n.documento, n.finalidade, n.tipo_operacao, n.cfop_estadual, n.cfop_interestadual,
            n.serie, n.consumidor_final, n.informacoes_complementares AS info_natureza
       FROM ven_vendas v JOIN ven_naturezas_operacao n ON n.id = v.natureza_id
      WHERE v.id = ? AND v.empresa_id = ?`,
    [vendaId, empresa],
  );
  if (!v) falha('Venda não encontrada.', 404);
  const [itens]: any = await pool.query(
    `SELECT vi.*, p.iat, p.codigo_barras, p.ncm, p.cest, p.servico, p.cserv_nacional, p.cserv_municipal, p.cnbs, p.aliquota_iss, p.iss_retido,
            g.id AS grupo_id, g.descricao AS grupo_descricao, g.ativo AS grupo_ativo, g.origem, g.cfop_dentro_uf, g.cfop_fora_uf,
            g.csosn, g.aliquota_credito_sn, g.cst_icms, g.aliquota_icms,
            g.cst_pis, g.aliquota_pis, g.cst_cofins, g.aliquota_cofins, g.cst_ibscbs, g.cclass_trib, g.cst_is, g.cclass_trib_is, g.aliquota_is
       FROM ven_venda_itens vi JOIN cad_produtos p ON p.id = vi.produto_id
       -- grupo tributário só do mesmo grupo de empresas do produto; de outro grupo conta como "sem grupo tributário"
       LEFT JOIN fis_grupos_tributarios g ON g.id = p.grupo_tributario_id AND g.grupo_id = p.grupo_id
      WHERE vi.venda_id = ? ORDER BY vi.item`,
    [v.id],
  );
  // Produto inativo não barra a emissão: só a inclusão do item (lerDav); a venda de pedido e a dos 180 dias saem
  const [parcelas]: any = await pool.query(
    `SELECT p.*, i.cnpj AS cnpj_intermediador, i.nome_fantasia AS intermediador
       FROM ven_venda_parcelas p LEFT JOIN cad_intermediadores i ON i.id = p.intermediador_id AND i.tipo = 'P' AND i.ativo = 1
      WHERE p.venda_id = ? ORDER BY p.numero`,
    [v.id],
  );
  const [[transacao]]: any = v.intermediador_transacao_id
    ? await pool.query("SELECT cnpj, identificacao FROM cad_intermediadores WHERE id = ? AND tipo = 'T' AND ativo = 1", [v.intermediador_transacao_id])
    : [[null]];
  if (v.intermediador_transacao_id && !transacao) falha('Intermediador da transação inativo ou não encontrado.');
  const pessoa = async (id: number | null) => {
    if (!id) return null;
    const [[p]]: any = await pool.query('SELECT * FROM cad_pessoas WHERE id = ?', [id]);
    return p ? { ...p, ie: await ieDe(id) } : null;
  };
  // DAV (pedidos) de onde vieram os itens: vão no infCpl como #DAV (PAF-NFC-e de SC, Requisito V, IV)
  const [davs]: any = await pool.query(
    `SELECT DISTINCT d.numero FROM ven_venda_itens vi JOIN ven_dav_itens di ON di.id = vi.dav_item_id JOIN ven_davs d ON d.id = di.dav_id
      WHERE vi.venda_id = ? ORDER BY d.numero`,
    [v.id],
  );
  return { v, itens, parcelas, transacao, davs: davs.map((x: any) => Number(x.numero)) as number[], cliente: await pessoa(v.pessoa_id), transportadora: await pessoa(v.transportadora_id) };
}

/** Emitente do app para o usuário logado (como o carregarUsuario do erp-nfe/erp-nfs, mais a empresa da venda) */
export async function emitenteDe(app: App, uid: number, empresa: number) {
  const [[e]]: any = await pool.query(
    `SELECT e.* FROM sys_usuarios u
       JOIN sys_empresas se ON se.id = u.empresa_id
       JOIN ${app}_empresas e ON e.cnpj = se.cnpj COLLATE utf8mb4_unicode_ci
      WHERE u.id = ? AND se.id = ? AND u.ativo = 1 AND se.ativo = 1 AND e.ativo = 1
      LIMIT 1`,
    [uid, empresa],
  );
  if (e) return e;
  // Diz qual das condições falhou
  const [[se]]: any = await pool.query('SELECT cnpj, nome_fantasia, razao_social FROM sys_empresas WHERE id = ?', [empresa]);
  const nome = se?.nome_fantasia || se?.razao_social || `empresa ${empresa}`;
  const [[em]]: any = await pool.query(`SELECT ativo FROM ${app}_empresas WHERE cnpj = ? COLLATE utf8mb4_unicode_ci LIMIT 1`, [se?.cnpj ?? '']);
  if (!em) falha(`${nome} (CNPJ ${se?.cnpj || 'vazio'}) não está cadastrada como emitente no ${ENV[app].nome}.`);
  if (!Number(em.ativo)) falha(`${nome} está inativa como emitente no ${ENV[app].nome}.`);
  const [[u]]: any = await pool.query('SELECT u.empresa_id, u.ativo, se.nome_fantasia, se.razao_social FROM sys_usuarios u LEFT JOIN sys_empresas se ON se.id = u.empresa_id WHERE u.id = ?', [uid]);
  falha(
    !u || !Number(u.ativo) ? 'Seu usuário está inativo.'
      : `Seu usuário é da empresa ${u.nome_fantasia || u.razao_social || u.empresa_id}, e o ${ENV[app].nome} só emite pela empresa do próprio usuário. Entre com um usuário de ${nome}.`,
  );
}

const digitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/**
 * GTIN que pode ir no cEAN/cEANTrib; null = "SEM GTIN" (mesma regra do caixa, erp-pdv lib/fiscal.ts). A SEFAZ confere o
 * GTIN no Cadastro Centralizado (RICMS/SC, Anexo 11, arts. 96, VIII, e 99, § 1º; PAF-NFC-e, Requisito VII, § 3º).
 * Fora: tamanho diferente de 8/12/13/14, dígito verificador errado e prefixos GS1 de uso interno (020–029, 040–049 e
 * 200–299 no GTIN-13; GTIN-12 conta com um zero na frente, GTIN-14 sem o indicador; GTIN-8 começado por 0 ou 2).
 */
export function gtinPublico(codigo: unknown): string | null {
  const g = digitos(codigo);
  if (![8, 12, 13, 14].includes(g.length)) return null;
  const soma = [...g.slice(0, -1)].reverse().reduce((t, d, i) => t + Number(d) * (i % 2 ? 1 : 3), 0);
  if ((10 - (soma % 10)) % 10 !== Number(g.at(-1))) return null;
  if (g.length === 8) return /^[02]/.test(g) ? null : g;
  const prefixo = Number((g.length === 14 ? g.slice(1) : g.padStart(13, '0')).slice(0, 3));
  const restrito = (prefixo >= 20 && prefixo <= 29) || (prefixo >= 40 && prefixo <= 49) || (prefixo >= 200 && prefixo <= 299);
  return restrito ? null : g;
}
const docDe = (p: any) => (digitos(p.cpf_cnpj).length === 11 ? { cpf: digitos(p.cpf_cnpj) } : { cnpj: digitos(p.cpf_cnpj) });

/** Frete rateado pelo valor dos itens, em centavos; a sobra vai no último */
export function ratear(total: number, pesos: number[]): number[] {
  const cent = Math.round(total * 100);
  const soma = pesos.reduce((s, p) => s + p, 0);
  if (!cent || !soma) return pesos.map(() => 0);
  const partes = pesos.map((p) => Math.floor((cent * p) / soma));
  partes[partes.length - 1] += cent - partes.reduce((s, p) => s + p, 0);
  return partes.map((p) => p / 100);
}

/**
 * ICMS do item pelo grupo tributário do produto (fis_grupos_tributarios, cadastro do erp-estoque): CSOSN para emitente
 * do Simples, com o crédito do Simples (o erp-nfe calcula o valor), e CST do ICMS para os demais. O grupo precisa estar
 * ativo e ser do regime de quem emite.
 */
export function icmsDoItem(i: any, simples: boolean, rot: string): { csosn: string; aliquotaCredito?: number } | { cst: string } {
  const grupo = `o grupo tributário "${i.grupo_descricao}"`;
  const onde = 'Troque o grupo nos dados fiscais do produto (erp-estoque).';
  if (!Number(i.grupo_ativo)) falha(`${rot}: ${grupo} está inativo. ${onde}`);
  if (!simples) return i.cst_icms ? { cst: String(i.cst_icms) } : falha(`${rot}: ${grupo} não tem CST do ICMS, e a empresa não é do Simples Nacional. ${onde}`);
  if (!i.csosn) falha(`${rot}: ${grupo} não tem CSOSN, e a empresa é do Simples Nacional. ${onde}`);
  const credito = Number(i.aliquota_credito_sn) || 0;
  if (String(i.csosn) === '101' && !(credito > 0)) falha(`${rot}: ${grupo} é CSOSN 101 e está sem a alíquota de crédito do Simples. Preencha no grupo (erp-estoque › Dados Fiscais).`);
  return { csosn: String(i.csosn), ...(credito > 0 && { aliquotaCredito: credito }) };
}

/** ICMS por substituição tributária: só nesses o CEST é obrigatório (mesma lista do erp-pdv) */
const CSOSN_ST = ['201', '202', '203', '500'];
const CST_ST = ['10', '30', '60', '70'];
export const comST = (i: any, simples: boolean) => (simples ? CSOSN_ST.includes(String(i.csosn ?? '')) : CST_ST.includes(String(i.cst_icms ?? '')));

/** documento do POST /api/calcular e /api/emitir do erp-nfe */
export async function montarNFe(d: Awaited<ReturnType<typeof carregar>>, emit: any) {
  const { v, itens, parcelas, cliente, transportadora } = d;
  const nfce = v.documento === 'nfce';
  const modelo = nfce ? '65' : '55';
  const simples = [1, 2, 4].includes(Number(emit.crt));

  let serie = v.serie;
  if (serie == null) {
    const [[s]]: any = await pool.query('SELECT serie FROM nfe_series WHERE empresa_id = ? AND modelo = ? AND ativo = 1 ORDER BY serie LIMIT 1', [emit.id, modelo]);
    serie = s?.serie ?? falha(`Nenhuma série ativa do modelo ${modelo} no erp-nfe (tela Séries), e a natureza não fixa uma.`);
  }

  const ufCliente = cliente?.cidade_uf ? String(cliente.cidade_uf).toUpperCase() : '';
  const interestadual = !nfce && !!ufCliente && ufCliente !== String(emit.uf).toUpperCase();
  const indIEDest = !cliente ? 9 : cliente.ie ? (/ISENTO/i.test(cliente.ie) ? 2 : 1) : 9;
  // Destinatário não contribuinte só pode ser consumidor final (rejeição 696)
  const consumidorFinal = nfce || indIEDest === 9 ? 1 : Number(v.consumidor_final) ? 1 : 0;

  const fretes = ratear(Number(v.valor_frete), itens.map((i: any) => Number(i.valor_total)));
  const itensNFe = itens.map((i: any, k: number) => {
    const rot = `Item ${i.item} (${i.descricao})`;
    if (digitos(i.ncm).length !== 8) falha(`${rot}: produto sem NCM. Preencha nos dados fiscais do produto (erp-estoque).`);
    if (!i.grupo_id) falha(`${rot}: produto sem grupo tributário. Preencha nos dados fiscais do produto (erp-estoque).`);
    // Como o caixa (erp-pdv, server/notas.ts): sem CST IBS/CBS e cClassTrib, ou com ST sem CEST, a nota não sai
    if (!i.cst_ibscbs || !i.cclass_trib) falha(`${rot}: o grupo tributário "${i.grupo_descricao}" não tem CST do IBS/CBS e cClassTrib. Complete o grupo (erp-estoque).`);
    if (comST(i, simples) && digitos(i.cest).length !== 7) falha(`${rot}: produto com substituição tributária sem CEST. Preencha nos dados fiscais do produto (erp-estoque).`);
    const cfop = i.cfop || (interestadual ? v.cfop_interestadual || i.cfop_fora_uf : v.cfop_estadual || i.cfop_dentro_uf);
    if (!cfop) falha(`${rot}: sem CFOP ${interestadual ? 'interestadual' : 'estadual'} na natureza nem no grupo tributário.`);
    const gtin = digitos(i.codigo_barras);
    return {
      codigo: gtin || String(i.produto_id), // cProd = EAN do cadastro ou o id (o mesmo do PDV)
      ean: gtinPublico(gtin) ?? 'SEM GTIN', // código interno ou inválido vai só no cProd (Requisito VII, § 3º)
      descricao: i.descricao, // xProd = descrição gravada no item, que veio da Tabela de Mercadorias (Requisito VIII)
      ncm: digitos(i.ncm),
      ...(i.cest && { cest: digitos(i.cest) }),
      cfop,
      unidade: i.unidade,
      quantidade: Number(i.quantidade),
      valorUnitario: Number(i.preco_unitario),
      // IAT 'T': o vProd vai truncado, igual ao DAV e ao caixa (o erp-nfe arredonda quando não recebe o total)
      ...(String(i.iat ?? '').toUpperCase() === 'T' && { valorTotal: brutoItem({ quantidade: i.quantidade, preco_unitario: i.preco_unitario, iat: 'T' }) / 100 }),
      valorDesconto: Number(i.valor_desconto) || undefined,
      valorFrete: fretes[k] || undefined,
      imposto: {
        origem: Number(i.origem ?? 0),
        ...icmsDoItem(i, simples, rot),
        aliquota: Number(i.aliquota_icms || 0),
        pis: { cst: i.cst_pis, aliquota: Number(i.aliquota_pis || 0) },
        cofins: { cst: i.cst_cofins, aliquota: Number(i.aliquota_cofins || 0) },
        ...(i.cst_ibscbs && { ibscbs: { cst: i.cst_ibscbs, classificacao: i.cclass_trib, aliquotaIBSUF: i.cst_ibscbs === '000' ? IBS_UF : 0, aliquotaIBSMun: 0, aliquotaCBS: i.cst_ibscbs === '000' ? CBS : 0 } }),
        // Imposto Seletivo do grupo (extras/2026-11-23_imposto_seletivo.sql do erp-estoque): só a alíquota percentual
        ...(i.cst_is && { seletivo: { cst: i.cst_is, classificacao: i.cclass_trib_is, aliquota: Number(i.aliquota_is || 0) } }),
      },
    };
  });

  const endereco = (p: any) => ({
    logradouro: p.logradouro || '', numero: p.numero || 'SN', ...(p.complemento && { complemento: p.complemento }), bairro: p.bairro || '',
    codigoMunicipio: digitos(p.cidade_ibge), municipio: p.cidade_nome || '', uf: String(p.cidade_uf || '').toUpperCase(), cep: digitos(p.cep),
    ...(digitos(p.fone_principal) && { fone: digitos(p.fone_principal) }),
  });
  if (cliente && !nfce && digitos(cliente.cidade_ibge).length !== 7) falha('Cliente sem município (código IBGE) no endereço. Complete o cadastro.');

  const hoje = v.data_emissao;
  // Pagamentos com intermediador (PAF-NFC-e, Requisito XI); fora de venda (remessa, devolução) continua sem exigir
  const venda = ehVenda(v.cfop_estadual);
  if (venda && !parcelas.length) falha('Informe o pagamento da venda.');
  const pagamentos = parcelas.length
    ? parcelas.map((p: any) => {
        const forma = TPAG[p.forma_pagamento] ?? '99';
        // tPag 90 "Sem pagamento" (NFC-e automática dos 180 dias): não houve pagamento, sai sem intermediador (decisão de 24/11/2026)
        if (venda && forma !== '90' && !p.intermediador) falha(`Pagamento ${p.numero}: informe o intermediador do pagamento (PAF-NFC-e, Requisito XI).`);
        const cnpjInter = digitos(p.cnpj_intermediador);
        return {
          forma, valor: Number(p.valor), indPag: p.vencimento > hoje ? 1 : 0, ...(forma === '99' && { descricao: p.forma_pagamento }),
          ...(p.cnpj_pag && { cnpjPagamento: p.cnpj_pag, ufPagamento: p.uf_pag }),
          ...(CARTAO.includes(forma) && {
            cartao: { integracao: 2, ...(cnpjInter.length === 14 && { cnpj: cnpjInter }), ...(p.bandeira && { bandeira: p.bandeira }), ...(p.autorizacao && { autorizacao: p.autorizacao }) },
          }),
        };
      })
    : [{ forma: '01', indPag: 0 }];
  // Troco: o que as parcelas passam do total (vTroco; o vPag do dinheiro leva o valor entregue)
  const troco = Math.round((parcelas.reduce((s: number, p: any) => s + Number(p.valor), 0) - Number(v.valor_total)) * 100) / 100;

  const dav = d.davs.map((n) => `#DAV ${String(n).padStart(10, '0')}`).join(' ');
  const info = [v.info_natureza, v.informacoes_complementares, dav].map((t) => String(t ?? '').trim()).filter(Boolean).join(' ');
  return {
    ide: {
      modelo, naturezaOperacao: v.natureza, serie: Number(serie), tipoDocumento: Number(v.tipo_operacao),
      finalidade: Number(v.finalidade), consumidorFinal,
      // Com intermediador da transação (marketplace/delivery): indPres 9 + infIntermed (Requisito X).
      // Sem ele: NFC-e presencial sem intermediador; NF-e no indPres padrão do erp-nfe (0, que não leva indIntermed)
      ...(d.transacao
        ? { presencial: 9, intermediador: { cnpj: digitos(d.transacao.cnpj), identificador: d.transacao.identificacao } }
        : nfce && { presencial: 1, indicadorIntermediador: 0 }),
      versaoProcesso: `${PAF.nome} ${await versaoPaf()}`,
    },
    ...(cliente && {
      destinatario: {
        ...docDe(cliente), nome: cliente.nome, indIEDest,
        ...(indIEDest === 1 && { inscricaoEstadual: digitos(cliente.ie) }),
        ...(cliente.email_principal && { email: cliente.email_principal }),
        ...(!nfce && { endereco: endereco(cliente) }),
      },
    }),
    itens: itensNFe,
    ...(!nfce && {
      transporte: {
        modalidadeFrete: Number(v.modalidade_frete),
        ...(transportadora && {
          transportadora: { ...docDe(transportadora), nome: transportadora.nome, ...(transportadora.ie && { ie: digitos(transportadora.ie) }),
            endereco: [transportadora.logradouro, transportadora.numero].filter(Boolean).join(', '), municipio: transportadora.cidade_nome, uf: transportadora.cidade_uf },
        }),
      },
    }),
    pagamentos,
    ...(troco > 0 && { troco }),
    informacoesAdicionais: { ...(info && { contribuinte: info }), obsFisco: [{ campo: 'PAF', texto: PAF.nome }, ...(await obsFiscoRe(v.id))] },
  };
}

/** documento do POST /api/emitir do erp-nfs (uma NFS-e leva um código de serviço) */
function montarNFSe(d: Awaited<ReturnType<typeof carregar>>) {
  const { v, itens, cliente } = d;
  if (!cliente) falha('NFS-e precisa do tomador: escolha o cliente.');
  if (Number(v.valor_frete)) falha('NFS-e não tem frete: tire o frete da venda.');
  const chave = (i: any) => [i.cserv_nacional, i.cserv_municipal, i.cnbs, i.aliquota_iss, i.iss_retido].join('|');
  if (new Set(itens.map(chave)).size > 1) falha('Uma NFS-e leva um só código de serviço, NBS e alíquota de ISS: separe os serviços em vendas diferentes.');
  const i0 = itens[0];
  if (!i0?.cserv_nacional) falha(`${i0?.descricao ?? 'Serviço'}: sem código de serviço nacional. Preencha nos dados fiscais do produto (erp-estoque).`);
  const bruto = itens.reduce((s: number, i: any) => s + Math.round(Number(i.quantidade) * Number(i.preco_unitario) * 100), 0) / 100;
  const desconto = itens.reduce((s: number, i: any) => s + Math.round(Number(i.valor_desconto) * 100), 0) / 100;
  const descricao = itens.map((i: any) => (Number(i.quantidade) === 1 ? i.descricao : `${i.descricao} (${Number(i.quantidade).toLocaleString('pt-BR')} ${i.unidade})`)).join('; ');
  const info = [v.info_natureza, v.informacoes_complementares].map((t) => String(t ?? '').trim()).filter(Boolean).join(' ');
  return {
    competencia: v.data_emissao,
    codigoServico: i0.cserv_nacional,
    codigoServicoMunicipal: i0.cserv_municipal || '000',
    ...(i0.cnbs && { codigoNBS: i0.cnbs }),
    descricao: descricao.slice(0, 2000),
    valorServico: bruto,
    descontoIncondicionado: desconto,
    ...(i0.aliquota_iss != null && { aliquotaIss: Number(i0.aliquota_iss) }),
    issRetido: !!Number(i0.iss_retido),
    municipioPrestacao: '',
    informacoesComplementares: info,
    tomador: {
      documento: digitos(cliente.cpf_cnpj), nome: cliente.nome, ...(cliente.email_principal && { email: cliente.email_principal }),
      cep: digitos(cliente.cep), codigoMunicipio: digitos(cliente.cidade_ibge), logradouro: cliente.logradouro || '', numero: cliente.numero || 'SN', bairro: cliente.bairro || '',
    },
  };
}

/**
 * Emite (ou retoma) a nota da venda. aberta/rejeitada/faturando → faturando → faturada | rejeitada.
 * Sem resposta, a venda fica "faturando" e emitir de novo consulta a mesma referência.
 */
export async function emitirVenda(vendaId: unknown, empresa: number, uid: number) {
  const anterior = await transacao(async (c) => {
    const [[v]]: any = await c.query('SELECT id, numero, status FROM ven_vendas WHERE id = ? AND empresa_id = ? FOR UPDATE', [vendaId, empresa]);
    if (!v) falha('Venda não encontrada.', 404);
    if (!['aberta', 'rejeitada', 'faturando'].includes(v.status)) falha(`Venda ${v.numero} está ${v.status}.`, 409);
    return v.status as string;
  });

  const d = await carregar(vendaId, empresa);
  await conferirModelo(pool, empresa, d.v.natureza_id, d.v.pessoa_id, Number(d.v.valor_total));
  const app: App = d.v.documento === 'nfse' ? 'nfs' : 'nfe';
  const emit = await emitenteDe(app, uid, empresa);
  const documento = app === 'nfe' ? await montarNFe(d, emit) : montarNFSe(d);
  const referencia = `VENDA-${d.v.id}`;

  await pool.query("UPDATE ven_vendas SET status = 'faturando' WHERE id = ?", [d.v.id]);
  // Sem resposta, chamar() lança e a venda fica "faturando"
  // NFC-e sem comunicação com a SEFAZ sai em contingência offline (PAF-NFC-e, Requisito III); a fila transmite depois
  const { status, dados } = await chamar(app, emit.id, uid, '/api/emitir',
    app === 'nfe' ? { referencia, documento, sincrono: true, contingencia: d.v.documento === 'nfce' } : { referencia, documento });

  // Recusada antes de reservar número (dados inválidos, 400/409/422): volta como estava
  if (status >= 400) {
    if (anterior !== 'faturando') await pool.query('UPDATE ven_vendas SET status = ? WHERE id = ?', [anterior, d.v.id]);
    falha(mensagemDe(dados, status), status === 409 ? 409 : 400);
  }
  const situacao = String(dados?.situacao ?? '');
  // Em contingência a NFC-e já é documento válido (DANFE impresso): a venda fica faturada, com o selo até a autorização
  if (situacao === 'autorizada' || situacao === 'contingencia') {
    const [[nota]]: any = await pool.query(
      app === 'nfe' ? 'SELECT id FROM nfe_documentos WHERE empresa_id = ? AND referencia = ?' : 'SELECT id FROM nfs_notas WHERE empresa_id = ? AND referencia = ?',
      [emit.id, referencia],
    );
    await pool.query(`UPDATE ven_vendas SET status = 'faturada', ${app === 'nfe' ? 'nfe_documento_id' : 'nfs_nota_id'} = ? WHERE id = ?`, [nota?.id ?? null, d.v.id]);
    await atenderRe(d.v.id);
    await gerarTitulo(empresa, d.v.id); // conta a receber no erp-financ; fora do ar, a rodada dele cria depois
    // Baixa do estoque (PAF-NFC-e, registro E2): falhar aqui não desfaz a nota emitida; a nota já baixada não baixa de novo
    if (app === 'nfe' && nota?.id) {
      try {
        const [itens]: any = await pool.query('SELECT produto_id, variante_id, quantidade FROM ven_venda_itens WHERE venda_id = ?', [d.v.id]);
        const [[u]]: any = await pool.query('SELECT login FROM sys_usuarios WHERE id = ?', [uid]);
        await baixarEstoque(empresa, Number(nota.id), itens, String(u?.login ?? ''), `Venda ${d.v.numero}`);
      } catch (e) {
        console.error(`Venda ${d.v.numero} faturada, mas a baixa do estoque falhou:`, e);
      }
    }
  } else if (['rejeitada', 'denegada'].includes(situacao)) {
    await pool.query("UPDATE ven_vendas SET status = 'rejeitada' WHERE id = ?", [d.v.id]);
  }
  return {
    situacao: situacao || (status === 202 ? 'pendente' : 'desconhecida'),
    numero: dados?.numero ?? dados?.numeroNfse ?? null,
    chave: dados?.chave ?? null,
    motivo: [dados?.cStat ?? dados?.codigoStatus, dados?.motivo].filter(Boolean).join(' - ') || null,
  };
}

/**
 * Transmite as NFC-e em contingência (PAF-NFC-e, Requisito III, II: automática e autônoma), uma chamada por empresa.
 * Roda a cada minuto no servidor local (agendarContingencia) e pelas telas abertas (POST /nfce/contingencia).
 */
export async function transmitirContingencias(empresa?: number, uid?: number) {
  const [pend]: any = await pool.query(
    `SELECT v.empresa_id, MIN(v.usuario_id) AS usuario_id FROM ven_vendas v JOIN nfe_documentos nd ON nd.id = v.nfe_documento_id
      WHERE nd.situacao = 'contingencia' AND v.usuario_id IS NOT NULL ${empresa === undefined ? '' : 'AND v.empresa_id = ?'}
      GROUP BY v.empresa_id`,
    empresa === undefined ? [] : [empresa],
  );
  // Pela tela (usuário logado), chama o erp-nfe mesmo sem venda em contingência: a resposta traz os estornos pendentes
  if (empresa !== undefined && uid && !pend.length) pend.push({ empresa_id: empresa, usuario_id: uid });
  const resultado: string[] = [];
  // NFC-e normais (tentativa paralela à contingência) fora do prazo de cancelar: pedem NF-e de estorno (art. 106)
  const estornos: { numero: number; chave: string; motivo: string }[] = [];
  for (const p of pend) {
    try {
      const uid = Number(p.usuario_id);
      const emit = await emitenteDe('nfe', uid, p.empresa_id);
      const { status, dados } = await chamar('nfe', emit.id, uid, '/api/emitir-contingencia', {});
      if (status >= 400) throw new Error(mensagemDe(dados, status));
      if (Array.isArray(dados?.estornos)) estornos.push(...dados.estornos);
      resultado.push(`empresa ${p.empresa_id}: ${dados?.transmitidas ?? 0} transmitida(s), ${dados?.pendentes ?? 0} pendente(s)${dados?.erro ? ` (${dados.erro})` : ''}`);
    } catch (e: any) {
      resultado.push(`empresa ${p.empresa_id}: ${e?.message ?? e}`);
    }
  }
  // Contingência recusada (vista por este módulo, pelo PDV ou pelo próprio erp-nfe): a venda volta a rejeitada e o
  // "Emitir nota" gera de novo com o mesmo número e data (RICMS/SC Anexo 11, art. 104, § 4º; referência VENDA-id)
  await pool.query(
    `UPDATE ven_vendas v JOIN nfe_documentos nd ON nd.id = v.nfe_documento_id SET v.status = 'rejeitada'
      WHERE v.status = 'faturada' AND nd.situacao = 'rejeitada' AND SUBSTRING(nd.chave, 35, 1) = '9' ${empresa === undefined ? '' : 'AND v.empresa_id = ?'}`,
    empresa === undefined ? [] : [empresa],
  );
  if (resultado.length) console.log(`[Contingência NFC-e]\n  ${resultado.join('\n  ')}`);
  return { resultado, estornos };
}

/** Servidor local: fila da contingência a cada minuto */
export function agendarContingencia() {
  setInterval(() => void transmitirContingencias().catch((e) => console.error('[Contingência NFC-e]', e)), 60_000);
}

export function createNotasRouter() {
  const r = Router();

  /** Impostos da NF-e/NFC-e pelo motor do erp-nfe, sem número nem gravação */
  r.post('/vendas/:id/calcular', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    const d = await carregar(req.params.id, empresa);
    if (d.v.documento === 'nfse') falha('O ISS da NFS-e é calculado na emissão, pelo erp-nfs.');
    const emit = await emitenteDe('nfe', Number(s.userId), empresa);
    const { status, dados } = await chamar('nfe', emit.id, Number(s.userId), '/api/calcular', { documento: await montarNFe(d, emit) });
    if (status !== 200 || !dados?.success) falha(mensagemDe(dados, status), 400);
    return { modelo: dados.modelo, totais: dados.totais, itens: dados.itens };
  }));

  r.post('/nfce/contingencia', rota(async (_req, _res, s) => transmitirContingencias(empresaDa(s), Number(s.userId) || undefined)));

  r.post('/vendas/:id/emitir', rota(async (req, _res, s) => emitirVenda(req.params.id, empresaDa(s), Number(s.userId))));

  /** Conciliação financeira (EConf, 110750) dos pagamentos já vencidos da NF-e/NFC-e autorizada (Requisito XI, § 7º) */
  r.post('/vendas/:id/econf', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    const uid = Number(s.userId);
    const [[n]]: any = await pool.query(
      `SELECT nd.chave, nd.situacao FROM ven_vendas v JOIN nfe_documentos nd ON nd.id = v.nfe_documento_id
        WHERE v.id = ? AND v.empresa_id = ? AND v.status = 'faturada'`,
      [req.params.id, empresa],
    );
    if (!n) falha('Venda sem NF-e/NFC-e.', 404);
    if (n.situacao !== 'autorizada') falha('A conciliação financeira só vale para nota autorizada.');
    const [pags]: any = await pool.query(
      `SELECT p.forma_pagamento, p.valor, DATE_FORMAT(p.vencimento, '%Y-%m-%d') AS data, p.cnpj_pag, p.uf_pag, p.bandeira, p.autorizacao, i.cnpj AS cnpj_inter
         FROM ven_venda_parcelas p LEFT JOIN cad_intermediadores i ON i.id = p.intermediador_id
        WHERE p.venda_id = ? AND p.vencimento <= CURDATE() ORDER BY p.numero`,
      [req.params.id],
    );
    // EConf é de pagamento eletrônico: dinheiro (01), cheque (02), crédito em loja (21) e "Sem pagamento" (90) não vão (como o erp-pdv)
    const eletronicos = pags.filter((p: any) => !['01', '02', '21', '90'].includes(TPAG[p.forma_pagamento] ?? '99'));
    if (!eletronicos.length) falha('Nenhum pagamento eletrônico vencido para conciliar (dinheiro não vai no EConf).');
    const pagamentosEConf = eletronicos.map((p: any) => {
      const tPag = TPAG[p.forma_pagamento] ?? '99';
      return {
        indPag: 0, tPag, valor: Number(p.valor), data: p.data,
        ...(p.cnpj_pag && { cnpjPagamento: p.cnpj_pag, ufPagamento: p.uf_pag }),
        ...(CARTAO.includes(tPag) && digitos(p.cnpj_inter).length === 14 && { cnpjInstituicao: digitos(p.cnpj_inter) }),
        ...(p.bandeira && { bandeira: p.bandeira }),
        ...(p.autorizacao && { autorizacao: p.autorizacao }),
      };
    });
    const emit = await emitenteDe('nfe', uid, empresa);
    const { status, dados } = await chamar('nfe', emit.id, uid, '/api/evento', { chave: n.chave, tipoEvento: '110750', pagamentosEConf });
    if (status >= 400 || !dados?.sucesso) falha(mensagemDe({ error: dados?.error || `${dados?.cStat ?? ''} - ${dados?.xMotivo ?? 'EConf recusado'}` }, status));
    return { motivo: `${dados.cStat} - ${dados.xMotivo}` };
  }));

  /**
   * Cancelamento da NF-e/NFC-e da venda (110111) pelo erp-nfe: a venda fica cancelada, os itens voltam a faturar nos
   * pedidos e ao estoque. Nota já cancelada fora daqui (tela do erp-nfe) só acerta a venda, sem evento.
   * Prazo: NFC-e 30 min (RICMS/SC Anexo 11, art. 106); NF-e 24 h, conferido pela SEFAZ.
   */
  r.post('/vendas/:id/cancelar-nota', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    const uid = Number(s.userId);
    const justificativa = String(req.body?.justificativa ?? '').trim();
    const [[n]]: any = await pool.query(
      `SELECT v.numero, nd.chave, nd.situacao, nd.protocolo, nd.modelo,
              SUBSTRING(REGEXP_SUBSTR(nd.xml_protocolo, '<dhRecbto>[^<]+'), 11) AS autorizacao
         FROM ven_vendas v JOIN nfe_documentos nd ON nd.id = v.nfe_documento_id
        WHERE v.id = ? AND v.empresa_id = ? AND v.status = 'faturada'`,
      [req.params.id, empresa],
    );
    if (!n) falha('Venda faturada com NF-e/NFC-e não encontrada.', 404);
    if (n.situacao === 'contingencia') falha('Esta NFC-e foi emitida em contingência e ainda não foi autorizada. O cancelamento só é possível depois da autorização.');
    if (!['autorizada', 'cancelada'].includes(n.situacao)) falha(`Nota ${n.situacao}: só nota autorizada pode ser cancelada.`);
    await podeCancelarTitulo(empresa, Number(req.params.id)); // parcela já recebida no financeiro: estorne a baixa lá antes
    let motivo = 'Nota já estava cancelada no erp-nfe';
    if (n.situacao === 'autorizada') {
      if (justificativa.length < 15 || justificativa.length > 255) falha('A justificativa do cancelamento precisa ter de 15 a 255 caracteres.');
      const autorizada = Date.parse(n.autorizacao);
      if (n.modelo === '65' && Date.now() > autorizada + 30 * 60_000)
        falha('Passou o prazo de 30 minutos da autorização: a NFC-e não pode mais ser cancelada. Se a venda não aconteceu, corrija com NF-e de estorno ' +
          '(art. 106, parágrafo único, do Anexo 11 do RICMS/SC).');
      const emit = await emitenteDe('nfe', uid, empresa);
      const { status, dados } = await chamar('nfe', emit.id, uid, '/api/evento', { chave: n.chave, tipoEvento: '110111', protocolo: n.protocolo, justificativa });
      if (status >= 400 || !dados?.sucesso) falha(mensagemDe({ error: dados?.error || `${dados?.cStat ?? ''} - ${dados?.xMotivo ?? 'Cancelamento recusado'}` }, status));
      motivo = `${dados.cStat} - ${dados.xMotivo}`;
    }
    await transacao(async (c) => {
      await c.query("UPDATE ven_vendas SET status = 'cancelada', cancelado_em = NOW() WHERE id = ?", [req.params.id]);
      const [davs]: any = await c.query('SELECT DISTINCT di.dav_id FROM ven_venda_itens vi JOIN ven_dav_itens di ON di.id = vi.dav_item_id WHERE vi.venda_id = ?', [req.params.id]);
      await atualizarPedidos(c, davs.map((d: any) => d.dav_id));
    });
    // Se o estorno falhar aqui, a próxima venda ou o Menu Fiscal do erp-pdv estornam
    await estornarCancelados(empresa).catch((e) => console.error('Estorno do estoque do cancelamento:', e));
    await cancelarTitulo(empresa, Number(req.params.id), `Venda ${n.numero}: nota cancelada${justificativa ? ` (${justificativa})` : ''}`);
    return { motivo };
  }));

  /** DANFE (PDF) da NF-e/NFC-e autorizada da venda, gerado pelo erp-nfe a partir da chave */
  r.get('/vendas/:id/danfe', rota(async (req, res, s) => {
    const empresa = empresaDa(s);
    const uid = Number(s.userId);
    const [[v]]: any = await pool.query('SELECT v.numero, n.documento, v.nfe_documento_id FROM ven_vendas v JOIN ven_naturezas_operacao n ON n.id = v.natureza_id WHERE v.id = ? AND v.empresa_id = ?', [req.params.id, empresa]);
    if (!v) falha('Venda não encontrada.', 404);
    if (v.documento === 'nfse') falha('A NFS-e não tem DANFE: a impressão dela sai pelo erp-nfs.');
    if (!v.nfe_documento_id) falha(`A venda ${v.numero} não tem nota autorizada.`);
    const emit = await emitenteDe('nfe', uid, empresa);
    const [[n]]: any = await pool.query('SELECT chave FROM nfe_documentos WHERE id = ? AND empresa_id = ?', [v.nfe_documento_id, emit.id]);
    if (!n?.chave) falha('Nota da venda não encontrada no erp-nfe.', 404);

    // NFC-e de contingência sai em 2 vias (Anexo 11, art. 104, § 6º): a 2ª pede via=estabelecimento
    const via = req.query.via === 'estabelecimento' ? '?via=estabelecimento' : '';
    const resp = await postar('nfe', emit.id, uid, `/api/danfe${via}`, { chave: n.chave });
    if (!resp.ok) falha(mensagemDe(await resp.json().catch(() => ({})), resp.status), 400);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="DANFE-${n.chave}.pdf"`);
    res.send(Buffer.from(await resp.arrayBuffer()));
  }));

  /**
   * Link para abrir o erp-nfe já logado (opção "NFe" do menu) ou já na nota de uma venda (botão "NFe").
   * Leva um token de 5 min no hash (não vai para logs de servidor); o erp-nfe troca por uma sessão e limpa a barra.
   */
  async function linkNfe(s: SessionData, vendaId?: string) {
    const empresa = empresaDa(s);
    const uid = Number(s.userId);
    let v: any;
    if (vendaId) {
      [[v]] = await pool.query('SELECT id FROM ven_vendas WHERE id = ? AND empresa_id = ?', [vendaId, empresa]) as any;
      if (!v) falha('Venda não encontrada.', 404);
    }
    const url = process.env.NFE_URL;
    const segredo = process.env.NFE_SECRET || '';
    if (!url || segredo.length < 32) falha('Integração com o erp-nfe não configurada (NFE_URL e NFE_SECRET no .env).', 503);
    const emit = await emitenteDe('nfe', uid, empresa);
    // Pela referência: acha também a nota rejeitada, que ainda não está em nfe_documento_id
    const [[n]]: any = v
      ? await pool.query('SELECT chave FROM nfe_documentos WHERE empresa_id = ? AND referencia = ? LIMIT 1', [emit.id, `VENDA-${v.id}`])
      : [[]];
    const hash = new URLSearchParams({ sso: tokenPara(segredo, uid, emit.id), ...(n?.chave && { chave: n.chave }) });
    return { url: `${url!.replace(/\/$/, '')}/#${hash}`, temNota: !!n?.chave };
  }
  r.get('/nfe-link', rota(async (_req, _res, s) => linkNfe(s)));
  r.get('/vendas/:id/nfe-link', rota(async (req, _res, s) => linkNfe(s, req.params.id)));

  return r;
}
