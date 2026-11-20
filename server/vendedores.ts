import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { empresaDa } from './empresa.js';
import { falha, rota } from './http.js';
import { documentoValido } from '../lib/documento.js';

/** Corpo da tela → colunas de cad_vendedores, validado */
function lerVendedor(b: any) {
  const texto = (v: unknown) => String(v ?? '').trim();
  const nome = texto(b?.nome);
  if (!nome) falha('Informe o nome.');
  if (nome.length > 60) falha('Nome com mais de 60 caracteres.');
  const apelido = texto(b?.apelido);
  if (apelido.length > 20) falha('Apelido com mais de 20 caracteres.');
  const cpf = texto(b?.cpf).replace(/\D/g, '');
  if (cpf && (cpf.length !== 11 || !documentoValido(cpf))) falha('CPF inválido.');
  const telefone = texto(b?.telefone).replace(/\D/g, '');
  if (telefone && telefone.length !== 10 && telefone.length !== 11) falha('Telefone deve ter DDD + 8 ou 9 dígitos.');
  const email = texto(b?.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falha('E-mail inválido.');
  const comissao = Number(b?.comissao_percentual || 0);
  if (!Number.isFinite(comissao) || comissao < 0 || comissao > 100) falha('Comissão deve ficar entre 0 e 100%.');

  return {
    nome,
    apelido: apelido || null,
    cpf: cpf || null,
    telefone: telefone || null,
    email: email || null,
    comissao_percentual: comissao,
    observacoes: texto(b?.observacoes).slice(0, 255) || null,
    ativo: b?.ativo === false || b?.ativo === 0 ? 0 : 1,
    usuario_id: Number(b?.usuario_id) > 0 ? Number(b.usuario_id) : null,
  };
}

/** Usuários ativos da empresa: os que podem ser ligados a um vendedor */
const USUARIOS_DA_EMPRESA = `SELECT DISTINCT u.id, COALESCE(NULLIF(u.nome, ''), u.login) AS nome
  FROM sys_usuarios u LEFT JOIN sys_usuarios_empresas ue ON ue.usuario_id = u.id
 WHERE u.ativo = 1 AND (ue.empresa_id = ? OR u.empresa_id = ?)`;

/** Valida o corpo e confere se o usuário escolhido é da empresa (o vínculo que já existia pode ficar, mesmo com o usuário inativo) */
async function vendedorDaTela(b: any, empresa: number, id?: string) {
  const v = lerVendedor(b);
  if (v.usuario_id) {
    const [ok]: any = await pool.query(
      `${USUARIOS_DA_EMPRESA} AND u.id = ? UNION SELECT usuario_id, NULL FROM cad_vendedores WHERE id = ? AND empresa_id = ? AND usuario_id = ?`,
      [empresa, empresa, v.usuario_id, id ?? 0, empresa, v.usuario_id],
    );
    if (!ok.length) falha('Usuário não encontrado nesta empresa (ou inativo).');
  }
  return v;
}

const usuarioRepetido = (e: any) => (e?.code === 'ER_DUP_ENTRY' ? falha('Esse usuário já está ligado a outro vendedor.') : Promise.reject(e));

export function createVendedoresRouter() {
  const r = Router();

  r.get('/vendedores', rota(async (_req, _res, s) => {
    const [linhas] = await pool.query(
      `SELECT v.*, COALESCE(NULLIF(u.nome, ''), u.login) AS usuario_nome
         FROM cad_vendedores v LEFT JOIN sys_usuarios u ON u.id = v.usuario_id
        WHERE v.empresa_id = ? ORDER BY v.nome`,
      [empresaDa(s)],
    );
    return linhas;
  }));

  r.get('/vendedores/usuarios', rota(async (_req, _res, s) => {
    const e = empresaDa(s);
    const [linhas] = await pool.query(`${USUARIOS_DA_EMPRESA} ORDER BY nome`, [e, e]);
    return linhas;
  }));

  r.post('/vendedores', rota(async (req, _res, s) => {
    const e = empresaDa(s);
    const [res]: any = await pool.query('INSERT INTO cad_vendedores SET ?', [{ ...(await vendedorDaTela(req.body, e)), empresa_id: e }]).catch(usuarioRepetido);
    return { id: res.insertId };
  }));

  r.patch('/vendedores/:id', rota(async (req, _res, s) => {
    const e = empresaDa(s);
    const [res]: any = await pool.query('UPDATE cad_vendedores SET ? WHERE id = ? AND empresa_id = ?', [await vendedorDaTela(req.body, e, req.params.id), req.params.id, e]).catch(usuarioRepetido);
    if (!res.affectedRows) falha('Vendedor não encontrado.', 404);
  }));

  r.delete('/vendedores/:id', rota(async (req, _res, s) => {
    // A FK zeraria o vendedor dos documentos (ON DELETE SET NULL): quem já foi usado só pode ser inativado
    const [[uso]]: any = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM ven_davs WHERE vendedor_id = ?) OR EXISTS(SELECT 1 FROM ven_vendas WHERE vendedor_id = ?)
           OR EXISTS(SELECT 1 FROM cad_pessoas WHERE vendedor_id = ?) AS usado`,
      [req.params.id, req.params.id, req.params.id],
    );
    if (Number(uso.usado)) falha('Vendedor já usado em orçamentos, pedidos, vendas ou clientes: inative-o em vez de excluir.');
    const [res]: any = await pool.query('DELETE FROM cad_vendedores WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDa(s)]);
    if (!res.affectedRows) falha('Vendedor não encontrado.', 404);
  }));

  return r;
}
