import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { falha, rota } from './http.js';

const DOCUMENTOS = ['nfe', 'nfce', 'nfse'];

/** Corpo da tela → colunas de ven_naturezas_operacao, validado */
function lerNatureza(b: any) {
  const descricao = String(b?.descricao ?? '').trim();
  if (!descricao) falha('Informe a descrição.');
  if (descricao.length > 60) falha('Descrição com mais de 60 caracteres (limite do natOp na nota).');
  const documento = String(b?.documento ?? '');
  if (!DOCUMENTOS.includes(documento)) falha('Documento inválido.');
  const finalidade = Number(b?.finalidade);
  if (![1, 2, 3, 4].includes(finalidade)) falha('Finalidade inválida.');
  const tipo = Number(b?.tipo_operacao);
  if (![0, 1].includes(tipo)) falha('Tipo de operação inválido.');

  // CFOP: 1/2 entrada e 5/6 saída; o 1º dígito do estadual é 1 ou 5, do interestadual 2 ou 6. NFS-e não tem CFOP.
  const cfop = (v: unknown, primeiro: string, nome: string) => {
    const c = String(v ?? '').replace(/\D/g, '');
    if (documento === 'nfse' || !c) return null;
    if (c.length !== 4 || c[0] !== primeiro) falha(`${nome}: CFOP deve ter 4 dígitos e começar com ${primeiro}.`);
    return c;
  };
  const cfop_estadual = cfop(b?.cfop_estadual, tipo ? '5' : '1', 'CFOP dentro do estado');
  const cfop_interestadual = documento === 'nfce' ? null : cfop(b?.cfop_interestadual, tipo ? '6' : '2', 'CFOP fora do estado');
  if (documento !== 'nfse' && !cfop_estadual) falha('Informe o CFOP dentro do estado.');

  const serie = b?.serie === '' || b?.serie == null ? null : Number(b.serie);
  if (serie !== null && (!Number.isInteger(serie) || serie < 0 || serie > 999)) falha('Série inválida (0 a 999).');

  return {
    descricao,
    documento,
    finalidade,
    tipo_operacao: tipo,
    cfop_estadual,
    cfop_interestadual,
    serie,
    consumidor_final: documento === 'nfce' || b?.consumidor_final ? 1 : 0,
    movimenta_estoque: b?.movimenta_estoque ? 1 : 0,
    informacoes_complementares: String(b?.informacoes_complementares ?? '').trim() || null,
    ativo: b?.ativo === false || b?.ativo === 0 ? 0 : 1,
  };
}

const duplicada = (e: any) => (e?.code === 'ER_DUP_ENTRY' ? falha('Já existe uma natureza com essa descrição.') : Promise.reject(e));

export function createNaturezasRouter() {
  const r = Router();

  r.get('/naturezas', rota(async (_req, _res, s) => {
    const [linhas] = await pool.query('SELECT * FROM ven_naturezas_operacao WHERE empresa_id = ? ORDER BY descricao', [empresaDa(s)]);
    return linhas;
  }));

  r.post('/naturezas', rota(async (req, _res, s) => {
    const n = lerNatureza(req.body);
    const [res]: any = await pool.query('INSERT INTO ven_naturezas_operacao SET ?', [{ ...n, empresa_id: empresaDa(s) }]).catch(duplicada);
    return { id: res.insertId };
  }));

  r.patch('/naturezas/:id', rota(async (req, _res, s) => {
    const n = lerNatureza(req.body);
    const [res]: any = await pool.query('UPDATE ven_naturezas_operacao SET ? WHERE id = ? AND empresa_id = ?', [n, req.params.id, empresaDa(s)]).catch(duplicada);
    if (!res.affectedRows) falha('Natureza não encontrada.', 404);
  }));

  r.delete('/naturezas/:id', rota(async (req, _res, s) => {
    const [res]: any = await pool.query('DELETE FROM ven_naturezas_operacao WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDa(s)]);
    if (!res.affectedRows) falha('Natureza não encontrada.', 404);
  }));

  return r;
}
