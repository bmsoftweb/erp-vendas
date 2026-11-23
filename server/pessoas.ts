import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { grupoDa } from './empresa.js';
import { falha, idOuNull, rota } from './http.js';
import { documentoValido } from '../lib/documento.js';

/**
 * Cadastro de pessoas (cad_pessoas): clientes, fornecedores e transportadoras. É do grupo de empresas,
 * compartilhado com o CRM e o ERP; aqui só os dados que a venda e a nota usam. Exclusão lógica (date_delete).
 */

const UFS = 'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO EX'.split(' ');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Corpo da tela → colunas de cad_pessoas, validado (só as colunas desta tela: o resto do cadastro fica como está) */
function lerPessoa(b: any) {
  const texto = (campo: string, rotulo: string, max: number) => {
    const v = String(b?.[campo] ?? '').trim();
    if (v.length > max) falha(`${rotulo}: no máximo ${max} caracteres.`);
    return v || null;
  };
  const digitos = (campo: string) => String(b?.[campo] ?? '').replace(/\D/g, '') || null;
  const email = (campo: string, rotulo: string) => {
    const v = texto(campo, rotulo, 120);
    if (v && !v.split(/[;,]/).every((e) => EMAIL.test(e.trim()))) falha(`${rotulo} inválido.`);
    return v;
  };
  const sim = (campo: string) => (b?.[campo] === true || Number(b?.[campo]) === 1 ? 1 : 0);

  const tipo_pessoa = b?.tipo_pessoa === 'F' ? 'F' : 'J';
  const nome = texto('nome', 'Nome', 50);
  if (!nome) falha('Informe o nome.');

  const cpf_cnpj = digitos('cpf_cnpj');
  if (cpf_cnpj) {
    if (cpf_cnpj.length !== (tipo_pessoa === 'F' ? 11 : 14)) falha(tipo_pessoa === 'F' ? 'CPF deve ter 11 dígitos.' : 'CNPJ deve ter 14 dígitos.');
    if (!documentoValido(cpf_cnpj)) falha(tipo_pessoa === 'F' ? 'CPF inválido.' : 'CNPJ inválido.');
  }

  // Indicador da IE do destinatário (NF-e): 1 contribuinte (IE obrigatória), 2 isento, 9 não contribuinte
  const ind_ie_dest = ['1', '2', '9'].includes(String(b?.ind_ie_dest)) ? String(b.ind_ie_dest) : '9';
  const ie = String(b?.ie ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 20) || null;
  if (ind_ie_dest === '1' && !ie) falha('Contribuinte do ICMS: informe a inscrição estadual.');

  const cep = digitos('cep');
  if (cep && cep.length !== 8) falha('CEP deve ter 8 dígitos.');
  const cidade_uf = String(b?.cidade_uf ?? '').toUpperCase() || null;
  if (cidade_uf && !UFS.includes(cidade_uf)) falha('UF inválida.');
  const cidade_ibge = digitos('cidade_ibge');
  if (cidade_ibge && cidade_ibge.length !== 7) falha('Código IBGE da cidade deve ter 7 dígitos.');

  const fone = (campo: string, rotulo: string) => {
    const v = digitos(campo);
    if (v && (v.length < 10 || v.length > 11)) falha(`${rotulo}: DDD + 8 ou 9 dígitos.`);
    return v;
  };

  const bloqueado = sim('bloqueado');
  return {
    tipo_pessoa,
    cpf_cnpj,
    nome,
    nome_fantasia: texto('nome_fantasia', 'Nome fantasia', 150),
    codigo: texto('codigo', 'Código', 20),
    is_cliente: sim('is_cliente'),
    is_fornecedor: sim('is_fornecedor'),
    is_transportadora: sim('is_transportadora'),
    ativo: b?.ativo === false || b?.ativo === 0 ? 0 : 1,
    ind_ie_dest,
    ie: ind_ie_dest === '2' ? null : ie,
    im: texto('im', 'Inscrição municipal', 20),
    email_nfe: email('email_nfe', 'E-mail da nota'),
    cep,
    logradouro: texto('logradouro', 'Logradouro', 100),
    numero: texto('numero', 'Número', 7) ?? '',
    complemento: texto('complemento', 'Complemento', 60),
    bairro: texto('bairro', 'Bairro', 50) ?? '',
    cidade_nome: texto('cidade_nome', 'Cidade', 100),
    cidade_uf,
    cidade_ibge,
    fone_principal: fone('fone_principal', 'Telefone'),
    whatsapp: fone('whatsapp', 'WhatsApp'),
    email_principal: email('email_principal', 'E-mail'),
    vendedor_id: idOuNull(b?.vendedor_id),
    tipo_cliente_id: idOuNull(b?.tipo_cliente_id),
    regiao_id: idOuNull(b?.regiao_id),
    // Coluna do SQL do clube (erp-pdv/extras/2026-11-22_clube_descontos.sql): só vai quando a tela manda
    ...(b && 'clube_desconto' in b && { clube_desconto: sim('clube_desconto') }),
    bloqueado,
    motivo_bloqueio: bloqueado ? texto('motivo_bloqueio', 'Motivo do bloqueio', 200) : null,
    observacoes: texto('observacoes', 'Observações', 65535),
    observacoes_internas: texto('observacoes_internas', 'Observações internas', 65535),
  };
}

/** Valida o corpo e o que depende do banco: documento e código repetidos no grupo, vendedor do grupo e a cidade pelo IBGE */
async function pessoaDaTela(b: any, grupo: number, id?: string) {
  const p = lerPessoa(b);
  if (p.cpf_cnpj) {
    const [[outra]]: any = await pool.query(
      'SELECT id, nome FROM cad_pessoas WHERE grupo_id = ? AND cpf_cnpj = ? AND date_delete IS NULL AND id <> ? LIMIT 1',
      [grupo, p.cpf_cnpj, id ?? 0],
    );
    if (outra) falha(`${p.tipo_pessoa === 'F' ? 'CPF' : 'CNPJ'} já cadastrado: ${outra.nome} (#${outra.id}).`);
  }
  if (p.codigo) {
    // Inclui as excluídas: o índice único (grupo_id, codigo) também vale para elas
    const [[outra]]: any = await pool.query('SELECT id, nome, date_delete FROM cad_pessoas WHERE grupo_id = ? AND codigo = ? AND id <> ? LIMIT 1', [
      grupo,
      p.codigo,
      id ?? 0,
    ]);
    if (outra) falha(`Código já usado por ${outra.nome} (#${outra.id}${outra.date_delete ? ', excluída' : ''}).`);
  }
  if (p.vendedor_id) {
    const [[v]]: any = await pool.query('SELECT 1 FROM cad_vendedores v JOIN sys_empresas e ON e.id = v.empresa_id WHERE v.id = ? AND e.grupo_id = ?', [p.vendedor_id, grupo]);
    if (!v) falha('Vendedor não encontrado neste grupo de empresas.');
  }
  if (p.tipo_cliente_id) {
    const [[t]]: any = await pool.query('SELECT 1 FROM cad_pessoas_tipos WHERE id = ?', [p.tipo_cliente_id]);
    if (!t) falha('Tipo de cliente não encontrado.');
  }
  if (p.regiao_id) {
    const [[r]]: any = await pool.query('SELECT 1 FROM cad_regioes WHERE id = ?', [p.regiao_id]);
    if (!r) falha('Região não encontrada.');
  }
  // cidade_id (critério das listas de preço do erp-estoque) sai do código IBGE
  const [[cidade]]: any = p.cidade_ibge ? await pool.query('SELECT id FROM cad_cidades WHERE codigo_ibge = ? LIMIT 1', [p.cidade_ibge]) : [[null]];
  return { ...p, cidade_id: cidade?.id ?? null };
}

export function createPessoasRouter() {
  const r = Router();

  // ponytail: a lista traz o grupo inteiro (filtra e pagina na tela); paginar no servidor se passar de alguns milhares
  r.get('/pessoas', rota(async (_req, _res, s) => {
    const [linhas] = await pool.query(
      `SELECT p.id, p.tipo_pessoa, p.nome, p.nome_fantasia, p.cpf_cnpj, p.codigo, p.fone_principal, p.whatsapp, p.email_principal,
              NULLIF(CONCAT_WS('/', NULLIF(p.cidade_nome, ''), NULLIF(p.cidade_uf, '')), '') AS cidade,
              p.is_cliente, p.is_fornecedor, p.is_transportadora, p.ativo, p.bloqueado, v.nome AS vendedor
         FROM cad_pessoas p LEFT JOIN cad_vendedores v ON v.id = p.vendedor_id
        WHERE p.grupo_id = ? AND p.date_delete IS NULL
        ORDER BY p.nome`,
      [grupoDa(s)],
    );
    return linhas;
  }));

  r.get('/pessoas/apoio', rota(async (_req, _res, s) => {
    const [tipos] = await pool.query('SELECT id, nome FROM cad_pessoas_tipos WHERE ativo = 1 ORDER BY nome');
    const [regioes] = await pool.query('SELECT id, nome FROM cad_regioes WHERE ativo = 1 ORDER BY nome');
    const [vendedores] = await pool.query(
      'SELECT v.id, v.nome FROM cad_vendedores v JOIN sys_empresas e ON e.id = v.empresa_id WHERE e.grupo_id = ? AND v.ativo = 1 ORDER BY v.nome',
      [grupoDa(s)],
    );
    return { tipos, regioes, vendedores };
  }));

  r.get('/pessoas/:id', rota(async (req, _res, s) => {
    const [[p]]: any = await pool.query(
      `SELECT p.*, v.nome AS vendedor_nome FROM cad_pessoas p LEFT JOIN cad_vendedores v ON v.id = p.vendedor_id
        WHERE p.id = ? AND p.grupo_id = ? AND p.date_delete IS NULL`,
      [req.params.id, grupoDa(s)],
    );
    if (!p) falha('Pessoa não encontrada.', 404);
    return p;
  }));

  r.post('/pessoas', rota(async (req, _res, s) => {
    const grupo = grupoDa(s);
    const p = await pessoaDaTela(req.body, grupo);
    const [res]: any = await pool.query('INSERT INTO cad_pessoas SET ?', [{ ...p, grupo_id: grupo, criado_por: s.userId ?? null, atualizado_por: s.userId ?? null }]);
    return { id: res.insertId };
  }));

  r.patch('/pessoas/:id', rota(async (req, _res, s) => {
    const grupo = grupoDa(s);
    const p = await pessoaDaTela(req.body, grupo, req.params.id);
    const [res]: any = await pool.query('UPDATE cad_pessoas SET ?, date_update = NOW() WHERE id = ? AND grupo_id = ? AND date_delete IS NULL', [
      { ...p, atualizado_por: s.userId ?? null },
      req.params.id,
      grupo,
    ]);
    if (!res.affectedRows) falha('Pessoa não encontrada.', 404);
  }));

  // Exclusão lógica: orçamentos, pedidos, vendas e notas continuam apontando para ela
  r.delete('/pessoas/:id', rota(async (req, _res, s) => {
    const [res]: any = await pool.query('UPDATE cad_pessoas SET date_delete = NOW(), atualizado_por = ? WHERE id = ? AND grupo_id = ? AND date_delete IS NULL', [
      s.userId ?? null,
      req.params.id,
      grupoDa(s),
    ]);
    if (!res.affectedRows) falha('Pessoa não encontrada.', 404);
  }));

  return r;
}
