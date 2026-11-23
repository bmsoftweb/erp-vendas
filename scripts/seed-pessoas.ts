/**
 * Seed de teste: 20 pessoas (5 jurídicas, 15 físicas) no grupo da empresa 0 (DEMONSTRACAO).
 * Rodar: npx tsx --env-file=.env scripts/seed-pessoas.ts
 * Clientes de SC. Idempotente pelo código SEED01..SEED20 (já existente é atualizado). Reversão no fim do arquivo.
 */
import { masterPool as pool } from '../server/db.js';
import { documentoValido } from '../lib/documento.js';

const GRUPO = 0;

/** CPF/CNPJ com dígitos verificadores válidos a partir de uma base fixa (sempre o mesmo número para o mesmo seed) */
function comDv(base: string): string {
  let d = base;
  while (d.length < (base.length === 9 ? 11 : 14)) {
    if (base.length === 9) {
      const n = d.length;
      let soma = 0;
      for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
      d += ((soma * 10) % 11) % 10;
    } else {
      const pesos = d.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const r = pesos.reduce((s, p, i) => s + Number(d[i]) * p, 0) % 11;
      d += r < 2 ? 0 : 11 - r;
    }
  }
  return d;
}

const CIDADES = [
  { nome: 'Florianópolis', uf: 'SC', ibge: '4205407', ddd: '48', cep: '88010001', bairro: 'Centro', rua: 'Rua Felipe Schmidt' },
  { nome: 'Joinville', uf: 'SC', ibge: '4209102', ddd: '47', cep: '89201001', bairro: 'Centro', rua: 'Rua do Príncipe' },
  { nome: 'Blumenau', uf: 'SC', ibge: '4202404', ddd: '47', cep: '89010001', bairro: 'Centro', rua: 'Rua XV de Novembro' },
  { nome: 'Chapecó', uf: 'SC', ibge: '4204202', ddd: '49', cep: '89801001', bairro: 'Centro', rua: 'Avenida Getúlio Vargas' },
  { nome: 'Itajaí', uf: 'SC', ibge: '4208203', ddd: '47', cep: '88301001', bairro: 'Centro', rua: 'Rua Hercílio Luz' },
  { nome: 'Criciúma', uf: 'SC', ibge: '4204608', ddd: '48', cep: '88801001', bairro: 'Centro', rua: 'Rua Coronel Pedro Benedet' },
  { nome: 'São José', uf: 'SC', ibge: '4216602', ddd: '48', cep: '88101001', bairro: 'Campinas', rua: 'Avenida Presidente Kennedy' },
];

const JURIDICAS = [
  ['Alfa Comércio de Alimentos Ltda', 'Alfa Alimentos'],
  ['Beta Materiais de Construção Ltda', 'Beta Construção'],
  ['Gama Distribuidora de Bebidas Ltda', 'Gama Bebidas'],
  ['Delta Transportes e Logística Ltda', 'Delta Log'],
  ['Ômega Papelaria e Informática Ltda', 'Ômega Papelaria'],
];

const FISICAS: [string, 'M' | 'F', string][] = [
  ['Ana Paula Ferreira', 'F', '1985-03-12'],
  ['Bruno Henrique Costa', 'M', '1990-07-25'],
  ['Carla Regina Souza', 'F', '1978-11-02'],
  ['Daniel Augusto Lima', 'M', '1982-01-30'],
  ['Eduarda Martins Rocha', 'F', '1995-09-14'],
  ['Felipe Andrade Gomes', 'M', '1988-05-08'],
  ['Gabriela Nunes Barbosa', 'F', '1992-12-19'],
  ['Henrique Silva Pereira', 'M', '1975-04-23'],
  ['Isabela Cardoso Ribeiro', 'F', '2000-06-06'],
  ['João Pedro Almeida', 'M', '1987-08-17'],
  ['Juliana Teixeira Melo', 'F', '1983-10-28'],
  ['Lucas Oliveira Santos', 'M', '1998-02-11'],
  ['Mariana Carvalho Dias', 'F', '1980-07-04'],
  ['Rafael Moreira Araújo', 'M', '1993-03-27'],
  ['Sofia Mendes Correia', 'F', '1979-12-01'],
];

const pessoas = [
  ...JURIDICAS.map(([nome, fantasia], i) => ({
    tipo_pessoa: 'J',
    nome,
    nome_fantasia: fantasia,
    cpf_cnpj: comDv(`${String(47815290 + i * 3307).padStart(8, '0')}0001`),
    is_cliente: 1,
    is_fornecedor: i === 1 || i === 2 ? 1 : 0,
    is_transportadora: i === 3 ? 1 : 0,
    email_nfe: `nfe@${fantasia.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}.com.br`,
  })),
  ...FISICAS.map(([nome, sexo, nasc], i) => ({
    tipo_pessoa: 'F',
    nome,
    cpf_cnpj: comDv(String(528174000 + i * 7919).padStart(9, '0')),
    sexo,
    data_nascimento: nasc,
    is_cliente: 1,
  })),
];

const [cidades]: any = await pool.query('SELECT id, codigo_ibge FROM cad_cidades WHERE codigo_ibge IN (?)', [CIDADES.map((c) => c.ibge)]);
const cidadeId = new Map<string, number>(cidades.map((c: any) => [String(c.codigo_ibge), c.id]));

let incluidas = 0;
let atualizadas = 0;
for (const [i, p] of pessoas.entries()) {
  if (!documentoValido(p.cpf_cnpj)) throw new Error(`Documento inválido gerado: ${p.cpf_cnpj}`);
  const codigo = `SEED${String(i + 1).padStart(2, '0')}`;
  const c = CIDADES[i % CIDADES.length];
  const fone = `${c.ddd}9${String(81000000 + i * 1237).slice(0, 8)}`;
  const linha = {
    ...p,
    grupo_id: GRUPO,
    codigo,
    ativo: 1,
    ind_ie_dest: '9', // não contribuinte: sem IE inventada (IE válida depende da regra de cada UF)
    cep: c.cep,
    logradouro: c.rua,
    numero: String(100 + i * 10),
    bairro: c.bairro,
    cidade_nome: c.nome,
    cidade_uf: c.uf,
    cidade_ibge: c.ibge,
    cidade_id: cidadeId.get(c.ibge) ?? null,
    fone_principal: fone,
    whatsapp: fone,
    email_principal: `${p.nome.split(' ')[0].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}${i + 1}@exemplo.com.br`,
  };
  // Chave única (grupo_id, codigo): o que já existe é atualizado
  const [res]: any = await pool.query('INSERT INTO cad_pessoas SET ? ON DUPLICATE KEY UPDATE ?, date_update = NOW()', [linha, linha]);
  if (res.affectedRows === 1) incluidas++;
  else atualizadas++;
}
console.log(`Pessoas incluídas: ${incluidas}, atualizadas: ${atualizadas} (de ${pessoas.length}).`);
await pool.end();

// Reversão (apaga só o que este seed criou):
// DELETE FROM cad_pessoas WHERE grupo_id = 0 AND codigo LIKE 'SEED__';
