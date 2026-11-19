import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { rota } from './http.js';

/** Listas de apoio das telas: naturezas, condições, vendedores e as pesquisas de cliente e produto */
const DO_GRUPO = (col: string) => `${col} = (SELECT eg.grupo_id FROM sys_empresas eg WHERE eg.id = ?)`;
const termo = (v: unknown) => `%${String(v ?? '').trim()}%`;

export function createApoioRouter() {
  const r = Router();

  r.get('/apoio', rota(async (_req, _res, s) => {
    const e = empresaDa(s);
    const [naturezas] = await pool.query('SELECT id, descricao, documento FROM ven_naturezas_operacao WHERE empresa_id = ? AND ativo = 1 ORDER BY descricao', [e]);
    const [condicoes] = await pool.query('SELECT id, nome, prazos, forma_pagamento FROM crm_condicoes_pagamento WHERE empresa_id = ? AND ativo = 1 ORDER BY nome', [e]);
    const [vendedores] = await pool.query(
      `SELECT DISTINCT u.id, COALESCE(NULLIF(u.nome, ''), u.login) AS nome
         FROM sys_usuarios u LEFT JOIN sys_usuarios_empresas ue ON ue.usuario_id = u.id
        WHERE u.ativo = 1 AND (ue.empresa_id = ? OR u.empresa_id = ?) ORDER BY nome`,
      [e, e],
    );
    const [[cfg]]: any = await pool.query('SELECT natureza_padrao_id, validade_orcamento_dias FROM ven_config WHERE empresa_id = ?', [e]);
    return { naturezas, condicoes, vendedores, naturezaPadrao: cfg?.natureza_padrao_id ?? null, validadeDias: cfg?.validade_orcamento_dias ?? 7, usuarioId: s.userId };
  }));

  /** ?transportadora=1 traz só transportadoras; senão, clientes (e quem não tem papel marcado) */
  r.get('/pessoas', rota(async (req, _res, s) => {
    const papel = req.query.transportadora ? 'p.is_transportadora = 1' : '(p.is_cliente = 1 OR NOT (p.is_fornecedor OR p.is_transportadora OR p.is_colaborador))';
    const [linhas] = await pool.query(
      `SELECT p.id, p.nome, p.cpf_cnpj, p.cidade_nome AS cidade, p.cidade_uf AS uf
         FROM cad_pessoas p
        WHERE p.date_delete IS NULL AND COALESCE(p.ativo, 1) = 1 AND ${papel} AND ${DO_GRUPO('p.grupo_id')}
          AND (p.nome LIKE ? OR p.cpf_cnpj LIKE ? OR p.codigo = ?)
        ORDER BY p.nome LIMIT 50`,
      [empresaDa(s), termo(req.query.busca), termo(String(req.query.busca ?? '').replace(/\D/g, '') || '§'), String(req.query.busca ?? '')],
    );
    return linhas;
  }));

  /** ?servico=1 só serviços, ?servico=0 só produtos */
  r.get('/produtos', rota(async (req, _res, s) => {
    const servico = req.query.servico === '1' ? 'AND pr.servico = 1' : req.query.servico === '0' ? 'AND COALESCE(pr.servico, 0) = 0' : '';
    const [linhas] = await pool.query(
      `SELECT pr.id, pr.nome, pr.sku, pr.codigo_barras, pr.preco_venda, pr.servico, COALESCE(um.sigla, 'UN') AS unidade
         FROM cad_produtos pr LEFT JOIN cad_produtos_unidades_medida um ON um.id = pr.unidade_id
        WHERE COALESCE(pr.ativo, 1) = 1 AND ${DO_GRUPO('pr.grupo_id')} ${servico}
          AND (pr.nome LIKE ? OR pr.sku = ? OR pr.codigo_barras = ?)
        ORDER BY pr.nome LIMIT 50`,
      [empresaDa(s), termo(req.query.busca), String(req.query.busca ?? ''), String(req.query.busca ?? '')],
    );
    return linhas;
  }));

  return r;
}
