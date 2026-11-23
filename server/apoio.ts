import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { rota } from './http.js';

/** Listas de apoio das telas: naturezas, condições, vendedores (pesquisas de produto e pessoa: server/pesquisas.ts) */

export function createApoioRouter() {
  const r = Router();

  r.get('/apoio', rota(async (_req, _res, s) => {
    const e = empresaDa(s);
    const [naturezas] = await pool.query('SELECT id, descricao, documento, cfop_estadual FROM ven_naturezas_operacao WHERE empresa_id = ? AND ativo = 1 ORDER BY descricao', [e]);
    const [condicoes] = await pool.query('SELECT id, nome, prazos, forma_pagamento FROM crm_condicoes_pagamento WHERE empresa_id = ? AND ativo = 1 ORDER BY nome', [e]);
    const [vendedores]: any = await pool.query('SELECT id, nome, usuario_id FROM cad_vendedores WHERE empresa_id = ? AND ativo = 1 ORDER BY nome', [e]);
    // Intermediadores (cadastro do erp-pdv): P de pagamento nas parcelas, T da transação na venda
    const [intermediadores] = await pool.query('SELECT id, codigo, tipo, nome_fantasia, cnpj FROM cad_intermediadores WHERE empresa_id = ? AND ativo = 1 ORDER BY codigo', [e]);
    const [[cfg]]: any = await pool.query('SELECT natureza_padrao_id, validade_orcamento_dias FROM ven_config WHERE empresa_id = ?', [e]);
    // Vendedor ligado ao usuário logado: já vem escolhido no orçamento/pedido novo
    const vendedorPadrao = vendedores.find((v: any) => s.userId && Number(v.usuario_id) === Number(s.userId))?.id ?? null;
    // Usuário de balcão (sys_usuarios.balcao, marcado no bm-master): pedido novo já como pré-venda.
    // SELECT * para não quebrar o apoio num banco ainda sem a coluna
    const [[u]]: any = await pool.query('SELECT * FROM sys_usuarios WHERE id = ?', [s.userId ?? 0]);
    return { naturezas, condicoes, vendedores, intermediadores, vendedorPadrao, prevendaPadrao: !!Number(u?.balcao), naturezaPadrao: cfg?.natureza_padrao_id ?? null, validadeDias: cfg?.validade_orcamento_dias ?? 7 };
  }));

  return r;
}
