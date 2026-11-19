import { Router, Request, Response } from 'express';
import { abrirSessao, autenticar, ErroAcesso } from './acessoErp.js';
import { getIronSession } from 'iron-session';
import { sessionOptions, SessionData } from './session.js';
import { lerConfigGrid, salvarConfigGrid, lerConfigListas, salvarConfigListas } from './config-grid.js';

/**
 * Entrada vinda do Master (lançador de módulos), sem a tela de login:
 *   GET /api/entrar?user=base64(login:senha)&e=<empresa>&g=<grupo>&tema=<light|dark>&volta=<endereço do Master>
 * Confere o usuário e a filial como o login e abre a sessão. Deu certo: vai para a tela inicial. Deu erro (usuário
 * inativo, senha trocada, filial não liberada…): volta para o Master com ?erro=<mensagem>.
 * O endereço de volta só é aceito se for o do Master (MASTER_URL no .env, separado por vírgula; sem ele, localhost),
 * para o link não servir de redirecionamento para outro site.
 */
function voltaPermitida(v: string | null): URL | null {
  if (!v) return null;
  try {
    const url = new URL(v);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const permitidas = (process.env.MASTER_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ok = permitidas.length ? permitidas.some((p) => new URL(p).origin === url.origin) : ['localhost', '127.0.0.1'].includes(url.hostname);
    return ok ? url : null;
  } catch {
    return null;
  }
}

const redirecionar = (res: Response, para: string) => res.redirect(302, para);

export function createAuthRouter() {
  const router = Router();

  router.get('/entrar', async (req: Request, res: Response) => {
    const q = new URL(req.originalUrl, 'http://localhost').searchParams;
    const volta = voltaPermitida(q.get('volta'));
    try {
      const credencial = Buffer.from(q.get('user') || '', 'base64').toString('utf8');
      const i = credencial.indexOf(':');
      if (i < 1) throw new ErroAcesso(400, 'Acesso inválido: abra o módulo pelo Master.');
      const { u, filiais } = await autenticar(credencial.slice(0, i).trim(), credencial.slice(i + 1));
      // A empresa pedida pelo Master (a principal do usuário) quando liberada; senão, a primeira liberada
      const pedida = Number(q.get('e'));
      const f = filiais.find((x) => q.get('e') !== null && Number(x.id) === pedida) ?? filiais[0];
      await abrirSessao(req, res, u, f);
      // master=1: ao Sair, fecha a aba do Master (lib/origemMaster.ts); tema do Master (light/dark): a tela inicial
      // aplica e guarda (context/ThemeContext.tsx)
      const tema = q.get('tema');
      return redirecionar(res, tema === 'light' || tema === 'dark' ? `/?master=1&tema=${tema}` : '/?master=1');
    } catch (err: any) {
      const mensagem = err instanceof ErroAcesso ? err.message : 'Erro ao entrar no Vendas. Tente novamente.';
      if (!(err instanceof ErroAcesso)) console.error('Entrada pelo Master:', err);
      if (volta) {
        volta.searchParams.set('erro', `Vendas: ${mensagem}`);
        return redirecionar(res, volta.toString());
      }
      return res.status(err instanceof ErroAcesso ? err.status : 500).type('text/plain; charset=utf-8').send(mensagem);
    }
  });

  router.post('/login', async (req: Request, res: Response) => {
    try {
      const body = req.body;
      const login = String(body?.login || '').trim();
      const senha = typeof body?.senha === 'string' ? body.senha : '';
      const { u, filiais } = await autenticar(login, senha);
  
      // Mais de uma filial: a tela pergunta em qual entrar e reenvia login + senha + empresaId
      const pedida = body?.empresaId;
      const f = filiais.length === 1 ? filiais[0] : filiais.find((x) => pedida != null && pedida !== '' && Number(x.id) === Number(pedida));
      if (!f) {
        if (pedida != null && pedida !== '') return res.status(403).json({ error: 'Filial não liberada para este usuário.' });
        return res.json({ escolherFilial: true, filiais: filiais.map((x) => ({ id: Number(x.id), nome: x.nome, grupo: x.grupo_nome || '' })) });
      }
      const session = await abrirSessao(req, res, u, f);
      return res.json({ success: true, role: session.role });
    } catch (error: any) {
      if (error instanceof ErroAcesso) return res.status(error.status).json({ error: error.message });
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Erro interno do servidor: ' + error.message });
    }
  });

  router.post('/logout', async (req: Request, res: Response) => {
    try {
      const session = await getIronSession<SessionData>(req, res, sessionOptions);
      session.destroy();
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/user', async (req: Request, res: Response) => {
    try {
      const session = await getIronSession<SessionData>(req, res, sessionOptions);
      if (!session.isLoggedIn) return res.status(401).json({ isLoggedIn: false });
      return res.json(session);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/user/config-grid', async (req: Request, res: Response) => {
    try {
      const session = await getIronSession<SessionData>(req, res, sessionOptions);
      if (!session.isLoggedIn || !session.userId) return res.status(401).json({ error: 'Não autorizado' });
  
      return res.json(await lerConfigGrid(session.userId));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/user/config-grid', async (req: Request, res: Response) => {
    try {
      const session = await getIronSession<SessionData>(req, res, sessionOptions);
      if (!session.isLoggedIn || !session.userId) return res.status(401).json({ error: 'Não autorizado' });
  
      await salvarConfigGrid(session.userId, req.body);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/user/config-listas', async (req: Request, res: Response) => {
    try {
      const session = await getIronSession<SessionData>(req, res, sessionOptions);
      if (!session.isLoggedIn || !session.userId) return res.status(401).json({ error: 'Não autorizado' });
      return res.json(await lerConfigListas(session.userId));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.put('/user/config-listas', async (req: Request, res: Response) => {
    try {
      const session = await getIronSession<SessionData>(req, res, sessionOptions);
      if (!session.isLoggedIn || !session.userId) return res.status(401).json({ error: 'Não autorizado' });
      const corpo = req.body;
      if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return res.status(400).json({ error: 'Configuração inválida.' });
      await salvarConfigListas(session.userId, corpo);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}
