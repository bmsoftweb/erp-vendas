import express from 'express';
import { createAuthRouter } from './auth.js';
import { createApoioRouter } from './apoio.js';
import { createDavsRouter } from './davs.js';
import { createNaturezasRouter } from './naturezas.js';
import { createVendasRouter } from './vendas.js';
import { createNotasRouter } from './notas.js';

/**
 * App Express só com a API (/api/*). Usado pelo servidor local (server.ts), que põe o front-end por cima,
 * e pela função da Vercel (api/index.ts).
 */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', createAuthRouter());
  app.use('/api', createApoioRouter());
  app.use('/api', createDavsRouter());
  app.use('/api', createNaturezasRouter());
  app.use('/api', createVendasRouter());
  app.use('/api', createNotasRouter());

  // API desconhecida: 404 em JSON em vez de cair no index.html
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  return app;
}
