// ICMS do item pelo grupo tributário. Rodar:  npx tsx --env-file=.env server/notas.test.ts
import assert from 'node:assert/strict';
import { comST, gtinPublico, icmsDoItem } from './notas.js';

const rot = 'Item 1 (LAMINA)';
// Grupo "Laminas" do banco: CSOSN 101 com 5% de crédito e CST 00
const laminas = { grupo_descricao: 'Laminas', grupo_ativo: 1, csosn: '101', aliquota_credito_sn: '5.0000', cst_icms: '00' };
const erro = (f: () => unknown, trecho: string) => assert.throws(f, (e: any) => e.status === 400 && e.message.includes(trecho), trecho);

// Simples manda o CSOSN com o crédito; regime normal manda só o CST
assert.deepEqual(icmsDoItem(laminas, true, rot), { csosn: '101', aliquotaCredito: 5 });
assert.deepEqual(icmsDoItem(laminas, false, rot), { cst: '00' });
// CSOSN sem crédito (102) não manda aliquotaCredito
assert.deepEqual(icmsDoItem({ ...laminas, csosn: '102', aliquota_credito_sn: '0.0000' }, true, rot), { csosn: '102' });

// CSOSN 101 sem a alíquota de crédito
erro(() => icmsDoItem({ ...laminas, aliquota_credito_sn: 0 }, true, rot), 'CSOSN 101 e está sem a alíquota de crédito');
// Grupo do regime errado para quem emite
erro(() => icmsDoItem({ ...laminas, csosn: null }, true, rot), 'não tem CSOSN, e a empresa é do Simples');
erro(() => icmsDoItem({ ...laminas, cst_icms: null }, false, rot), 'não tem CST do ICMS');
// Grupo inativo
erro(() => icmsDoItem({ ...laminas, grupo_ativo: 0 }, true, rot), '"Laminas" está inativo');

// Substituição tributária (CEST obrigatório): CSOSN 500 no Simples, CST 60 no regime normal
assert.equal(comST({ csosn: '500', cst_icms: '00' }, true), true);
assert.equal(comST(laminas, true), false);
assert.equal(comST({ cst_icms: '60' }, false), true);

// GTIN público (Requisito VII, § 3º): o resto vai "SEM GTIN"
assert.equal(gtinPublico('7891000315507'), '7891000315507');
assert.equal(gtinPublico('7891000315508'), null); // dígito errado
assert.equal(gtinPublico('2990000000361'), null); // código interno (prefixo 2xx)
assert.equal(gtinPublico('0412345678903'), null); // circulação restrita 04x
assert.equal(gtinPublico('036000291452'), '036000291452'); // GTIN-12
assert.equal(gtinPublico('20123451'), null); // GTIN-8 restrito
assert.equal(gtinPublico('17891000315504'), '17891000315504'); // GTIN-14
assert.equal(gtinPublico('123'), null);

console.log('notas: ok');
process.exit(0);
