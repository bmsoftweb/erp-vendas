import crypto from 'crypto';
import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { ErroHttp, falha, rota } from './http.js';
import { transacao } from './davs.js';

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

type App = 'nfe' | 'nfs';
const ENV = { nfe: { url: 'NFE_URL', segredo: 'NFE_SECRET', nome: 'erp-nfe' }, nfs: { url: 'NFS_URL', segredo: 'NFS_SECRET', nome: 'erp-nfs' } };

/** Mesmo formato do criarToken do erp-nfe/erp-nfs: base64url({uid, emp, exp}).assinatura */
export function tokenPara(segredo: string, uid: number, emp: number, agoraMs = Date.now()): string {
  const corpo = Buffer.from(JSON.stringify({ uid, emp, exp: agoraMs + 5 * 60_000 })).toString('base64url');
  return `${corpo}.${crypto.createHmac('sha256', segredo).update(corpo).digest('base64url')}`;
}

/** POST no erp-nfe/erp-nfs com o token do usuário; devolve a resposta crua (JSON ou PDF) */
async function postar(app: App, emitente: number, uid: number, caminho: string, corpo: unknown) {
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
const mensagemDe = (d: any, status: number) =>
  [d?.error || d?.motivo || `HTTP ${status}`, ...(Array.isArray(d?.errosSchema) ? d.errosSchema.map((e: any) => `• ${typeof e === 'string' ? e : e?.mensagem ?? JSON.stringify(e)}`) : [])].join('\n');

/** Forma de pagamento da tela → tPag da NF-e */
const TPAG: Record<string, string> = { Dinheiro: '01', Cheque: '02', 'Cartão de crédito': '03', 'Cartão de débito': '04', Boleto: '15', PIX: '17', Transferência: '18' };
/** IBS/CBS de 2026, ano de teste da LC 214/2025 (CBS 0,9 %, IBS 0,1 %) */
const IBS_UF = 0.1;
const CBS = 0.9;

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
async function carregar(vendaId: unknown, empresa: number) {
  const [[v]]: any = await pool.query(
    `SELECT v.*, n.descricao AS natureza, n.documento, n.finalidade, n.tipo_operacao, n.cfop_estadual, n.cfop_interestadual,
            n.serie, n.consumidor_final, n.informacoes_complementares AS info_natureza
       FROM ven_vendas v JOIN ven_naturezas_operacao n ON n.id = v.natureza_id
      WHERE v.id = ? AND v.empresa_id = ?`,
    [vendaId, empresa],
  );
  if (!v) falha('Venda não encontrada.', 404);
  const [itens]: any = await pool.query(
    `SELECT vi.*, p.sku, p.codigo_barras, p.ncm, p.cest, p.servico, p.cserv_nacional, p.cserv_municipal, p.cnbs, p.aliquota_iss, p.iss_retido,
            g.id AS grupo_id, g.origem, g.cfop_dentro_uf, g.cfop_fora_uf, g.csosn, g.cst_icms, g.aliquota_icms,
            g.cst_pis, g.aliquota_pis, g.cst_cofins, g.aliquota_cofins, g.cst_ibscbs, g.cclass_trib
       FROM ven_venda_itens vi JOIN cad_produtos p ON p.id = vi.produto_id
       LEFT JOIN fis_grupos_tributarios g ON g.id = p.grupo_tributario_id
      WHERE vi.venda_id = ? ORDER BY vi.item`,
    [v.id],
  );
  const [parcelas]: any = await pool.query('SELECT * FROM ven_venda_parcelas WHERE venda_id = ? ORDER BY numero', [v.id]);
  const pessoa = async (id: number | null) => {
    if (!id) return null;
    const [[p]]: any = await pool.query('SELECT * FROM cad_pessoas WHERE id = ?', [id]);
    return p ? { ...p, ie: await ieDe(id) } : null;
  };
  return { v, itens, parcelas, cliente: await pessoa(v.pessoa_id), transportadora: await pessoa(v.transportadora_id) };
}

/** Emitente do app para o usuário logado (como o carregarUsuario do erp-nfe/erp-nfs, mais a empresa da venda) */
async function emitenteDe(app: App, uid: number, empresa: number) {
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

/** documento do POST /api/calcular e /api/emitir do erp-nfe */
async function montarNFe(d: Awaited<ReturnType<typeof carregar>>, emit: any) {
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
    const cfop = i.cfop || (interestadual ? v.cfop_interestadual || i.cfop_fora_uf : v.cfop_estadual || i.cfop_dentro_uf);
    if (!cfop) falha(`${rot}: sem CFOP ${interestadual ? 'interestadual' : 'estadual'} na natureza nem no grupo tributário.`);
    const gtin = digitos(i.codigo_barras);
    return {
      codigo: i.sku || String(i.produto_id),
      ...([8, 12, 13, 14].includes(gtin.length) && { ean: gtin }),
      descricao: i.descricao,
      ncm: digitos(i.ncm),
      ...(i.cest && { cest: digitos(i.cest) }),
      cfop,
      unidade: i.unidade,
      quantidade: Number(i.quantidade),
      valorUnitario: Number(i.preco_unitario),
      valorDesconto: Number(i.valor_desconto) || undefined,
      valorFrete: fretes[k] || undefined,
      imposto: {
        origem: Number(i.origem ?? 0),
        ...(simples ? { csosn: i.csosn } : { cst: i.cst_icms }),
        aliquota: Number(i.aliquota_icms || 0),
        pis: { cst: i.cst_pis, aliquota: Number(i.aliquota_pis || 0) },
        cofins: { cst: i.cst_cofins, aliquota: Number(i.aliquota_cofins || 0) },
        ...(i.cst_ibscbs && { ibscbs: { cst: i.cst_ibscbs, classificacao: i.cclass_trib, aliquotaIBSUF: IBS_UF, aliquotaIBSMun: 0, aliquotaCBS: CBS } }),
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
  const pagamentos = parcelas.length
    ? parcelas.map((p: any) => ({ forma: TPAG[p.forma_pagamento] ?? '99', valor: Number(p.valor), indPag: p.vencimento > hoje ? 1 : 0, ...(TPAG[p.forma_pagamento] ? {} : { descricao: p.forma_pagamento }) }))
    : [{ forma: '01', indPag: 0 }];

  const info = [v.info_natureza, v.informacoes_complementares].map((t) => String(t ?? '').trim()).filter(Boolean).join(' ');
  return {
    ide: {
      modelo, naturezaOperacao: v.natureza, serie: Number(serie), tipoDocumento: Number(v.tipo_operacao),
      finalidade: Number(v.finalidade), consumidorFinal,
      // NF-e: indPres padrão do erp-nfe (0); 9 exigiria o indIntermed, que o erp-nfe ainda não monta (rejeição 434)
      ...(nfce && { presencial: 1 }),
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
    ...(info && { informacoesAdicionais: { contribuinte: info } }),
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

  /**
   * Emite (ou retoma) a nota da venda. aberta/rejeitada/faturando → faturando → faturada | rejeitada.
   * Sem resposta, a venda fica "faturando" e emitir de novo consulta a mesma referência.
   */
  r.post('/vendas/:id/emitir', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    const uid = Number(s.userId);
    const anterior = await transacao(async (c) => {
      const [[v]]: any = await c.query('SELECT id, numero, status FROM ven_vendas WHERE id = ? AND empresa_id = ? FOR UPDATE', [req.params.id, empresa]);
      if (!v) falha('Venda não encontrada.', 404);
      if (!['aberta', 'rejeitada', 'faturando'].includes(v.status)) falha(`Venda ${v.numero} está ${v.status}.`, 409);
      return v.status as string;
    });

    const d = await carregar(req.params.id, empresa);
    const app: App = d.v.documento === 'nfse' ? 'nfs' : 'nfe';
    const emit = await emitenteDe(app, uid, empresa);
    const documento = app === 'nfe' ? await montarNFe(d, emit) : montarNFSe(d);
    const referencia = `VENDA-${d.v.id}`;

    await pool.query("UPDATE ven_vendas SET status = 'faturando' WHERE id = ?", [d.v.id]);
    // Sem resposta, chamar() lança e a venda fica "faturando"
    const { status, dados } = await chamar(app, emit.id, uid, '/api/emitir', app === 'nfe' ? { referencia, documento, sincrono: true } : { referencia, documento });

    // Recusada antes de reservar número (dados inválidos, 400/409/422): volta como estava
    if (status >= 400) {
      if (anterior !== 'faturando') await pool.query('UPDATE ven_vendas SET status = ? WHERE id = ?', [anterior, d.v.id]);
      falha(mensagemDe(dados, status), status === 409 ? 409 : 400);
    }
    const situacao = String(dados?.situacao ?? '');
    if (situacao === 'autorizada') {
      const [[nota]]: any = await pool.query(
        app === 'nfe' ? 'SELECT id FROM nfe_documentos WHERE empresa_id = ? AND referencia = ?' : 'SELECT id FROM nfs_notas WHERE empresa_id = ? AND referencia = ?',
        [emit.id, referencia],
      );
      await pool.query(`UPDATE ven_vendas SET status = 'faturada', ${app === 'nfe' ? 'nfe_documento_id' : 'nfs_nota_id'} = ? WHERE id = ?`, [nota?.id ?? null, d.v.id]);
    } else if (['rejeitada', 'denegada'].includes(situacao)) {
      await pool.query("UPDATE ven_vendas SET status = 'rejeitada' WHERE id = ?", [d.v.id]);
    }
    return {
      situacao: situacao || (status === 202 ? 'pendente' : 'desconhecida'),
      numero: dados?.numero ?? dados?.numeroNfse ?? null,
      chave: dados?.chave ?? null,
      motivo: [dados?.cStat ?? dados?.codigoStatus, dados?.motivo].filter(Boolean).join(' - ') || null,
    };
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

    const resp = await postar('nfe', emit.id, uid, '/api/danfe', { chave: n.chave });
    if (!resp.ok) falha(mensagemDe(await resp.json().catch(() => ({})), resp.status), 400);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="DANFE-${n.chave}.pdf"`);
    res.send(Buffer.from(await resp.arrayBuffer()));
  }));

  /**
   * Link para abrir o erp-nfe já logado e na nota da venda (botão "NFe"). Leva um token de 5 min
   * no hash (não vai para logs de servidor); o erp-nfe troca por uma sessão e limpa a barra.
   */
  r.get('/vendas/:id/nfe-link', rota(async (req, _res, s) => {
    const empresa = empresaDa(s);
    const uid = Number(s.userId);
    const [[v]]: any = await pool.query('SELECT id FROM ven_vendas WHERE id = ? AND empresa_id = ?', [req.params.id, empresa]);
    if (!v) falha('Venda não encontrada.', 404);
    const url = process.env.NFE_URL;
    const segredo = process.env.NFE_SECRET || '';
    if (!url || segredo.length < 32) falha('Integração com o erp-nfe não configurada (NFE_URL e NFE_SECRET no .env).', 503);
    const emit = await emitenteDe('nfe', uid, empresa);
    // Pela referência: acha também a nota rejeitada, que ainda não está em nfe_documento_id
    const [[n]]: any = await pool.query('SELECT chave FROM nfe_documentos WHERE empresa_id = ? AND referencia = ? LIMIT 1', [emit.id, `VENDA-${v.id}`]);
    const hash = new URLSearchParams({ sso: tokenPara(segredo, uid, emit.id), ...(n?.chave && { chave: n.chave }) });
    return { url: `${url!.replace(/\/$/, '')}/#${hash}`, temNota: !!n?.chave };
  }));

  return r;
}
