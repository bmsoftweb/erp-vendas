// ICMS do item pelo grupo tributário. Rodar:  npx tsx --env-file=.env server/notas.test.ts
import assert from 'node:assert/strict';
import { icmsDoItem } from './notas.js';

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

console.log('notas: ok');
process.exit(0);
