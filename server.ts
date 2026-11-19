import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { createApp } from './server/app.js';

/**
 * Servidor local: a API (server/app.ts) e, por cima, o Vite (desenvolvimento) ou a pasta dist (produção).
 * Na Vercel a API roda como função (api/index.ts) e o front-end é estático: este arquivo não é usado lá.
 */
async function main() {
  const app = createApp();
  // Um servidor HTTP só: o HMR do Vite usa a mesma porta do app (a 24678 padrão colide com os outros projetos Vite abertos)
  const servidor = http.createServer(app);

  if (process.env.NODE_ENV === 'production') {
    const dist = path.join(process.cwd(), 'dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true, hmr: { server: servidor } }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  const porta = Number(process.env.PORT) || 3000;
  servidor.listen(porta, '0.0.0.0', () => console.log(`bm-vendas em http://localhost:${porta}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
