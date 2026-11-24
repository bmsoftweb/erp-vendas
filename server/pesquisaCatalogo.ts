import type { Pool } from 'mysql2/promise';

/**
 * Catálogo das pesquisas configuráveis do erp-vendas e do erp-compras (produtos, clientes, transportadoras e fornecedores)
 * e a montagem do SQL.
 *
 * ARQUIVO COMPARTILHADO, cópia idêntica em:
 *   erp-vendas/code/server/pesquisaCatalogo.ts  → roda a pesquisa (server/pesquisas.ts)
 *   erp-compras/code/server/pesquisaCatalogo.ts → roda a pesquisa (server/pesquisas.ts)
 *   erp-master/code/server/pesquisaCatalogo.ts   → Configurações > Pesquisas: tabelas, colunas, campos do sistema e o SQL (ver, editar, testar)
 * Mudou aqui, copie para os outros. Não importa nada de nenhum dos apps.
 *
 * O catálogo é a lista fechada de colunas que a tela pode mostrar e de campos em que pode pesquisar: a tela só manda
 * chaves, e o SQL sai daqui. O suporte cadastra campos por grupo no BM-Master (ven_pesquisa_campos):
 *   - linha sem tabela = campo do sistema (chave do catálogo): muda nome, pesquisa e "no grid"; inativa, sai da pesquisa;
 *   - linha com tabela = campo extra, só das `tabelas` do catálogo e de colunas que existem no banco.
 */

/** digitos: compara só os números (CPF/CNPJ, telefone gravados só com dígitos) */
export type Modo = 'contem' | 'inicio' | 'igual' | 'digitos';
export type Formato = 'moeda' | 'qtd' | 'imagem' | 'doc' | 'fone' | 'data' | 'simnao';
export interface Campo {
  label: string;
  /** Expressão SQL; com `comEmpresa`, leva um `?` que recebe a empresa da sessão */
  sql: string;
  comEmpresa?: boolean;
  formato?: Formato;
  alinhar?: 'texto' | 'numero' | 'centro';
  largura?: number;
  /** Aparece no grid sem configuração gravada */
  visivel?: boolean;
  /** Pode ser pesquisado, e como */
  busca?: Modo;
  /** Pesquisado sem configuração gravada */
  buscaPadrao?: boolean;
  /** tabela.coluna que o campo mostra: essa coluna não pode virar campo extra (seria uma coluna repetida) */
  usa?: string;
}
export interface Catalogo {
  /** Chave da linha (vai como "id") */
  id: string;
  from: string;
  /** Filtro fixo; o `?` recebe a empresa da sessão */
  where: string;
  ordem: string;
  /** Filtros extras vindos da tela (só os listados aqui) */
  filtros?: Record<string, Record<string, string>>;
  /** Tabelas (já no `from`, com o alias) de onde o suporte pode tirar campos; `colunas` limita as liberadas */
  tabelas: Record<string, { alias: string; rotulo: string; colunas?: string[] }>;
  campos: Record<string, Campo>;
}

const DO_GRUPO = (col: string) => `${col} = (SELECT eg.grupo_id FROM sys_empresas eg WHERE eg.id = ?)`;

// Clientes e transportadoras: mesmos campos, filtros e configurações separados
const CAMPOS_PESSOAS: Record<string, Campo> = {
  nome: { label: 'Nome', sql: 'p.nome', usa: 'cad_pessoas.nome', largura: 260, visivel: true, busca: 'contem', buscaPadrao: true },
  nome_fantasia: { label: 'Fantasia', sql: 'p.nome_fantasia', usa: 'cad_pessoas.nome_fantasia', largura: 200, busca: 'contem', buscaPadrao: true },
  cpf_cnpj: { label: 'CPF/CNPJ', sql: 'p.cpf_cnpj', usa: 'cad_pessoas.cpf_cnpj', formato: 'doc', largura: 150, visivel: true, busca: 'digitos', buscaPadrao: true },
  codigo: { label: 'Código', sql: 'p.codigo', usa: 'cad_pessoas.codigo', largura: 80, busca: 'igual', buscaPadrao: true },
  cidade: { label: 'Cidade', sql: "CONCAT_WS('/', NULLIF(p.cidade_nome, ''), NULLIF(p.cidade_uf, ''))", usa: 'cad_pessoas.cidade_nome', largura: 170, visivel: true, busca: 'contem' },
  bairro: { label: 'Bairro', sql: 'p.bairro', usa: 'cad_pessoas.bairro', largura: 140, busca: 'contem' },
  fone: { label: 'Telefone', sql: 'p.fone_principal', usa: 'cad_pessoas.fone_principal', formato: 'fone', largura: 120, busca: 'digitos' },
  whatsapp: { label: 'WhatsApp', sql: 'p.whatsapp', usa: 'cad_pessoas.whatsapp', formato: 'fone', largura: 130, busca: 'digitos' },
  email: { label: 'E-mail', sql: 'p.email_principal', usa: 'cad_pessoas.email_principal', largura: 200, busca: 'contem' },
  ie: { label: 'IE', sql: 'p.ie', usa: 'cad_pessoas.ie', largura: 110, busca: 'inicio' },
};
const pessoas = (papel: string): Catalogo => ({
  id: 'p.id',
  from: `cad_pessoas p
  LEFT JOIN cad_regioes rg ON rg.id = p.regiao_id
  LEFT JOIN crm_segmentos sg ON sg.id = p.segmento_id
  LEFT JOIN cad_pessoas_tipos tc ON tc.id = p.tipo_cliente_id
  LEFT JOIN cad_vendedores ve ON ve.id = p.vendedor_id`,
  where: `p.date_delete IS NULL AND COALESCE(p.ativo, 1) = 1 AND ${papel} AND ${DO_GRUPO('p.grupo_id')}`,
  ordem: 'p.nome',
  tabelas: {
    cad_pessoas: { alias: 'p', rotulo: 'Pessoa (cadastro)' },
    cad_regioes: { alias: 'rg', rotulo: 'Região' },
    crm_segmentos: { alias: 'sg', rotulo: 'Segmento' },
    cad_pessoas_tipos: { alias: 'tc', rotulo: 'Tipo de cliente' },
    cad_vendedores: { alias: 've', rotulo: 'Vendedor', colunas: ['nome', 'apelido', 'email', 'telefone'] },
  },
  campos: CAMPOS_PESSOAS,
});

export const CATALOGOS: Record<string, Catalogo> = {
  // Clientes e quem não tem papel marcado
  clientes: pessoas('(p.is_cliente = 1 OR NOT (p.is_fornecedor OR p.is_transportadora OR p.is_colaborador))'),
  transportadoras: pessoas('p.is_transportadora = 1'),
  fornecedores: pessoas('p.is_fornecedor = 1'),
  produtos: {
    id: 'pr.id',
    from: `cad_produtos pr
  LEFT JOIN cad_produtos_unidades_medida um ON um.id = pr.unidade_id
  LEFT JOIN cad_produtos_marcas ma ON ma.id = pr.marca_id
  LEFT JOIN cad_produtos_categorias ca ON ca.id = pr.categoria_id`,
    where: `COALESCE(pr.ativo, 1) = 1 AND ${DO_GRUPO('pr.grupo_id')}`,
    ordem: 'pr.nome',
    filtros: { servico: { '1': 'pr.servico = 1', '0': 'COALESCE(pr.servico, 0) = 0' } },
    tabelas: {
      cad_produtos: { alias: 'pr', rotulo: 'Produto (cadastro)' },
      cad_produtos_marcas: { alias: 'ma', rotulo: 'Marca' },
      cad_produtos_categorias: { alias: 'ca', rotulo: 'Categoria' },
      cad_produtos_unidades_medida: { alias: 'um', rotulo: 'Unidade de medida' },
    },
    campos: {
      // Imagem principal do produto; sem ela, a primeira pela ordem
      imagem: {
        label: 'Imagem', formato: 'imagem', alinhar: 'centro', largura: 80, visivel: true,
        sql: '(SELECT i.url FROM cad_produtos_imagens i WHERE i.produto_id = pr.id ORDER BY i.principal DESC, i.variante_id IS NOT NULL, i.ordem, i.id LIMIT 1)',
      },
      // Código oficial do produto sem EAN (cProd, P2, D5): o id (Requisito VIII, I)
      id: { label: 'Código', sql: 'pr.id', usa: 'cad_produtos.id', largura: 80, alinhar: 'numero', visivel: true, busca: 'igual', buscaPadrao: true },
      nome: { label: 'Produto', sql: 'pr.nome', usa: 'cad_produtos.nome', largura: 280, visivel: true, busca: 'contem', buscaPadrao: true },
      sku: { label: 'SKU', sql: 'pr.sku', usa: 'cad_produtos.sku', largura: 110, visivel: true, busca: 'inicio', buscaPadrao: true },
      codigo_barras: { label: 'Cód. barras', sql: 'pr.codigo_barras', usa: 'cad_produtos.codigo_barras', largura: 130, busca: 'igual', buscaPadrao: true },
      marca: { label: 'Marca', sql: 'ma.descricao', usa: 'cad_produtos_marcas.descricao', largura: 120, busca: 'contem' },
      categoria: { label: 'Categoria', sql: 'ca.nome', usa: 'cad_produtos_categorias.nome', largura: 140, busca: 'contem' },
      ncm: { label: 'NCM', sql: 'pr.ncm', usa: 'cad_produtos.ncm', alinhar: 'centro', largura: 90, busca: 'inicio' },
      unidade: { label: 'Un', sql: "COALESCE(um.sigla, 'UN')", usa: 'cad_produtos_unidades_medida.sigla', alinhar: 'centro', largura: 56, visivel: true },
      // Saldo livre (quantidade − reservado) nas localizações da filial
      estoque: {
        label: 'Disponível', formato: 'qtd', alinhar: 'numero', largura: 100, visivel: true, comEmpresa: true,
        sql: `(SELECT COALESCE(SUM(s.quantidade - s.reservado), 0) FROM est_estoque_saldo s
           JOIN cad_produtos_lotes l ON l.id = s.lote_id
           JOIN cad_produtos_localizacoes lc ON lc.id = s.localizacao_id
          WHERE l.produto_id = pr.id AND lc.empresa_id = ?)`,
      },
      iat: { label: 'IAT', sql: 'pr.iat', usa: 'cad_produtos.iat', alinhar: 'centro', largura: 50 },
      preco_venda: { label: 'Preço', sql: 'pr.preco_venda', usa: 'cad_produtos.preco_venda', formato: 'moeda', alinhar: 'numero', largura: 100, visivel: true },
    },
  },
};

export const COLUNAS_BLOQUEADAS = /senha|hash|token|secret|password|api_key/i;
export const FORMATOS: string[] = ['moeda', 'qtd', 'data', 'doc', 'fone', 'simnao'];
export const MODOS: string[] = ['contem', 'inicio', 'igual', 'digitos'];
const like = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/**
 * Catálogo + campos que o suporte cadastrou para o grupo (ven_pesquisa_campos); undefined se a pesquisa não existe.
 * Campo inválido (tabela fora da lista, coluna bloqueada ou que não existe mais) fica de fora, sem erro.
 */
export async function catalogoDoGrupo(db: Pool, tipo: string, grupo: number): Promise<Catalogo | undefined> {
  const cat = CATALOGOS[tipo];
  if (!cat) return undefined;
  // ponytail: 2 consultas a cada busca; guardar em memória por grupo se pesar
  const [todas]: any = await db.query(
    'SELECT chave, tabela, coluna, label, formato, busca, visivel, ativo FROM ven_pesquisa_campos WHERE pesquisa = ? AND grupo_id = ? ORDER BY id',
    [tipo, grupo],
  );
  if (!todas.length) return cat;
  const campos = { ...cat.campos };
  for (const f of todas.filter((x: any) => !x.tabela && campos[x.chave])) {
    if (!f.ativo) {
      delete campos[f.chave];
      continue;
    }
    const c = campos[f.chave];
    // Campo que não pesquisa (ex.: imagem, estoque) continua sem pesquisa
    const busca = c.busca && MODOS.includes(f.busca) ? (f.busca as Modo) : undefined;
    campos[f.chave] = { ...c, label: f.label || c.label, visivel: !!f.visivel, busca, buscaPadrao: !!busca && c.buscaPadrao };
  }
  const linhas = todas.filter((x: any) => x.tabela && x.ativo);
  if (!linhas.length) return { ...cat, campos };
  const [cols]: any = await db.query(
    'SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN (?)',
    [Object.keys(cat.tabelas)],
  );
  const existe = new Set(cols.map((x: any) => `${x.t}.${x.c}`));
  for (const f of linhas) {
    const t = cat.tabelas[f.tabela];
    if (!t || !existe.has(`${f.tabela}.${f.coluna}`) || COLUNAS_BLOQUEADAS.test(f.coluna) || (t.colunas && !t.colunas.includes(f.coluna))) continue;
    if (!/^[a-z0-9_]{1,40}$/i.test(f.chave)) continue;
    // coluna conferida no information_schema: pode entrar no SQL
    const col = `${t.alias}.\`${f.coluna}\``;
    const formato = FORMATOS.includes(f.formato) ? (f.formato as Formato) : undefined;
    campos[f.chave] = {
      label: f.label,
      // DATETIME viraria Date em UTC no JSON (e o dia podia mudar): já sai como aaaa-mm-dd
      sql: formato === 'data' ? `DATE_FORMAT(${col}, '%Y-%m-%d')` : col,
      formato,
      alinhar: formato === 'moeda' || formato === 'qtd' ? 'numero' : formato === 'data' || formato === 'simnao' ? 'centro' : undefined,
      visivel: !!f.visivel,
      busca: MODOS.includes(f.busca) ? (f.busca as Modo) : undefined,
    };
  }
  return { ...cat, campos };
}

/** Condição da busca: cada palavra (até 8) em algum dos campos escolhidos (sem escolha, os de buscaPadrao) */
export function condicaoBusca(cat: Pick<Catalogo, 'campos'>, busca: string, chaves: string[]): { sql: string; params: string[] } {
  const campos = chaves.filter((k) => cat.campos[k]?.busca);
  const usar = campos.length ? campos : Object.keys(cat.campos).filter((k) => cat.campos[k].buscaPadrao);
  const palavras = busca.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const params: string[] = [];
  const partes = palavras.map((p) => {
    const ors = usar.map((k) => {
      const c = cat.campos[k];
      if (c.busca === 'digitos') {
        const d = p.replace(/\D/g, '');
        if (!d) return 'FALSE';
        // Telefone pode estar gravado com máscara: compara sem ela
        params.push(`%${d}%`);
        return `REGEXP_REPLACE(${c.sql}, '[^0-9]', '') LIKE ?`;
      }
      params.push(c.busca === 'contem' ? `%${like(p)}%` : c.busca === 'inicio' ? `${like(p)}%` : p);
      return c.busca === 'igual' ? `${c.sql} = ?` : `${c.sql} LIKE ?`;
    });
    return `(${ors.join(' OR ')})`;
  });
  return { sql: partes.length ? 'AND ' + partes.join('\n   AND ') : '', params };
}

/**
 * SQL da pesquisa como modelo, o mesmo que o suporte vê e edita no BM-Master:
 *   :empresa  → a filial do usuário (vira parâmetro)
 *   {filtros} → filtros da tela (ex.: produto × serviço)
 *   {busca}   → uma condição por palavra digitada, nos campos escolhidos em "Pesquisar em"
 * As colunas (alias = chave do campo) são as do grid; todas as do catálogo e as extras do grupo.
 */
export function modeloSql(cat: Catalogo): string {
  const colunas = Object.entries(cat.campos);
  // ponytail: traz todas as colunas do catálogo; só calcular as visíveis se a pesquisa pesar
  return `SELECT ${cat.id} AS id,\n       ${colunas.map(([k, c]) => `${c.sql} AS \`${k}\``).join(',\n       ')}
  FROM ${cat.from}
 WHERE ${cat.where}
   {filtros}
   {busca}
 ORDER BY ${cat.ordem} LIMIT 50`.replace(/\?/g, ':empresa');
}

/** Troca os marcadores do modelo pelo SQL e pelos parâmetros, na ordem em que aparecem */
export function aplicarModelo<E>(modelo: string, cat: Catalogo, busca: string, chaves: string[], filtrosTela: Record<string, unknown>, empresa: E): { sql: string; params: (string | E)[] } {
  const filtros = Object.entries(cat.filtros ?? {})
    .map(([nome, valores]) => valores[String(filtrosTela[nome] ?? '')])
    .filter(Boolean)
    .map((f) => `AND ${f}`)
    .join('\n   ');
  const b = condicaoBusca(cat, busca, chaves);
  const params: (string | E)[] = [];
  const sql = modelo.replace(/:empresa\b|\{busca\}|\{filtros\}/g, (m) => {
    if (m === ':empresa') {
      params.push(empresa);
      return '?';
    }
    if (m === '{busca}') {
      params.push(...b.params);
      return b.sql;
    }
    return filtros;
  });
  return { sql, params };
}

/** O SELECT padrão da pesquisa (sem SQL próprio do grupo) */
export const montarConsulta = <E>(cat: Catalogo, busca: string, chaves: string[], filtrosTela: Record<string, unknown>, empresa: E) =>
  aplicarModelo(modeloSql(cat), cat, busca, chaves, filtrosTela, empresa);

/**
 * SQL próprio do grupo (sys_grupos.config → pesquisas_sql.<pesquisa>, gravado pelo suporte no BM-Master).
 * Só um SELECT, sem `;` nem `?` (a filial é :empresa), sem gravar arquivo e sem colunas de senha/token;
 * roda numa transação somente leitura (executarLeitura). Texto do erro, ou null se serve.
 */
export function validarSqlProprio(sql: string): string | null {
  const s = sql.trim();
  if (!s) return 'Informe o SQL.';
  if (s.length > 15_000) return 'SQL muito grande (máximo 15.000 caracteres).';
  if (!/^(select|with)\b/i.test(s)) return 'O SQL tem que começar com SELECT.';
  if (s.includes(';')) return 'Só um comando: tire o ";".';
  if (s.includes('?')) return 'Não use "?": a filial do usuário é :empresa.';
  if (/\binto\s+(outfile|dumpfile|@)/i.test(s)) return 'INTO não é permitido.';
  if (COLUNAS_BLOQUEADAS.test(s)) return 'O SQL não pode usar colunas de senha, hash ou token.';
  if (!s.includes('{busca}')) return 'Falta o marcador {busca}: sem ele, o que o usuário digita não filtra nada.';
  return null;
}

/** SQL próprio do grupo para a pesquisa, se houver e for válido */
export async function sqlProprio(db: Pool, tipo: string, grupo: number): Promise<string | undefined> {
  const [[g]]: any = await db.query('SELECT config FROM sys_grupos WHERE id = ?', [grupo]);
  try {
    const sql = JSON.parse(String(g?.config || '{}'))?.pesquisas_sql?.[tipo];
    return typeof sql === 'string' && !validarSqlProprio(sql) ? sql : undefined;
  } catch {
    return undefined;
  }
}

/** Roda um SELECT numa transação somente leitura (o SQL próprio não consegue gravar nada) */
export async function executarLeitura(db: Pool, sql: string, params: unknown[]) {
  const conn = await db.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    return await conn.query(sql, params);
  } finally {
    await conn.query('ROLLBACK').catch(() => undefined);
    conn.release();
  }
}
