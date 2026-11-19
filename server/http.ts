import type { Request, Response } from 'express';
import { getIronSession } from 'iron-session';
import { sessionOptions, SessionData } from './session.js';

/** Erro com status HTTP: a mensagem vai para o usuário */
export class ErroHttp extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

export const falha = (mensagem: string, status = 400): never => {
  throw new ErroHttp(status, mensagem);
};

/**
 * Handler com sessão obrigatória. O retorno vira JSON; ErroHttp vira { error } com o status dele.
 * FK impedindo exclusão sai como 409 com mensagem legível.
 */
export const rota =
  (fn: (req: Request, res: Response, s: SessionData) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      const s = await getIronSession<SessionData>(req, res, sessionOptions);
      if (!s.isLoggedIn) return void res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
      const r = await fn(req, res, s);
      if (!res.headersSent) res.json(r ?? { success: true });
    } catch (e: any) {
      if (res.headersSent) return;
      if (e instanceof ErroHttp) return void res.status(e.status).json({ error: e.message });
      if (e?.code === 'ER_ROW_IS_REFERENCED_2') return void res.status(409).json({ error: 'Registro em uso por outro cadastro: não pode ser excluído.' });
      console.error(e);
      res.status(500).json({ error: e?.message || 'Erro interno do servidor.' });
    }
  };

/** Data ISO (aaaa-mm-dd) válida ou falha */
export function dataIso(v: unknown, campo: string): string {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1) falha(`${campo}: data inválida.`);
  return s;
}

/** Inteiro positivo ou null */
export const idOuNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : falha('Identificador inválido.'));
