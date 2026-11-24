import { Router } from 'express';
import { masterPool as pool } from './db.js';
import { empresaDa, grupoDa } from './empresa.js';
import { falha, rota } from './http.js';
import { aplicarModelo, catalogoDoGrupo, executarLeitura, montarConsulta, sqlProprio } from './pesquisaCatalogo.js';

/**
 * Pesquisas configuráveis (produtos, clientes e transportadoras). O catálogo e o SQL ficam em pesquisaCatalogo.ts,
 * arquivo compartilhado com o BM-Master (Configurações > Pesquisas): mudou lá, copie para o outro app.
 *   GET /api/pesquisa/:tipo/campos           → colunas e campos pesquisáveis
 *   GET /api/pesquisa/:tipo?busca=&campos=   → até 50 linhas; cada palavra da busca tem que aparecer em algum dos campos
 */
export function createPesquisasRouter() {
  const r = Router();
  const doGrupo = async (tipo: string, s: Parameters<typeof grupoDa>[0]) => (await catalogoDoGrupo(pool, tipo, grupoDa(s))) ?? falha('Pesquisa não encontrada.', 404);

  r.get('/pesquisa/:tipo/campos', rota(async (req, _res, s) => {
    const cat = await doGrupo(req.params.tipo, s);
    return Object.entries(cat.campos).map(([key, c]) => ({
      key, label: c.label, formato: c.formato, alinhar: c.alinhar, largura: c.largura,
      visivel: !!c.visivel, buscavel: !!c.busca, buscaPadrao: !!c.buscaPadrao,
    }));
  }));

  r.get('/pesquisa/:tipo', rota(async (req, _res, s) => {
    const cat = await doGrupo(req.params.tipo, s);
    const args = [cat, String(req.query.busca ?? ''), String(req.query.campos ?? '').split(','), req.query, empresaDa(s)] as const;
    // SQL próprio do grupo (editado pelo suporte no BM-Master): se falhar, a pesquisa segue com o padrão
    const proprio = await sqlProprio(pool, req.params.tipo, grupoDa(s));
    if (proprio) {
      try {
        const q = aplicarModelo(proprio, ...args);
        const [linhas]: any = await executarLeitura(pool, q.sql, q.params);
        // IAT do produto para o total da tela bater com o servidor (Requisito VII): o SQL próprio pode não trazer
        if (req.params.tipo === 'produtos' && linhas.length && !('iat' in linhas[0])) {
          const [iats]: any = await pool.query('SELECT id, iat FROM cad_produtos WHERE id IN (?)', [linhas.map((l: any) => l.id)]);
          for (const l of linhas) l.iat = iats.find((x: any) => x.id === Number(l.id))?.iat ?? null;
        }
        return linhas;
      } catch (err) {
        console.error(`SQL próprio da pesquisa de ${req.params.tipo} (grupo ${grupoDa(s)}) falhou; usando o padrão:`, err);
      }
    }
    const q = montarConsulta(...args);
    const [linhas] = await pool.query(q.sql, q.params);
    return linhas;
  }));

  return r;
}
