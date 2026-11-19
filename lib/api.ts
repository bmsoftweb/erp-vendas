/** fetch da API: devolve o JSON ou lança Error com a mensagem do servidor; sessão expirada volta ao login */
export async function api<T = any>(url: string, metodo = 'GET', corpo?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: metodo,
    headers: corpo === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (r.status === 401) {
    window.location.href = '/';
    throw new Error('Sessão expirada.');
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.error || `Erro ${r.status}`);
  return dados;
}

/** 'aaaa-mm-dd' → 'dd/mm/aaaa' */
export const dataBr = (iso?: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

/** Hoje no relógio local, em 'aaaa-mm-dd' (nunca toISOString, que é UTC) */
export function hojeIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const moeda = (v: unknown) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Quantidade com 0 a 4 casas: 2 → 2; 1,5 → 1,5; 0,125 → 0,125 */
export const qtd = (v: unknown) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });

/** Só dígitos → CPF 000.000.000-00 ou CNPJ 00.000.000/0000-00; outro tamanho volta como veio */
export const docBr = (v?: string | null) => {
  const d = (v || '').replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return v || '';
};
