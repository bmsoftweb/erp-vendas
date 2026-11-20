/** CPF (11 dígitos) ou CNPJ (14 dígitos) com dígitos verificadores válidos. Usado na tela e no servidor */
export function documentoValido(valor: string | null | undefined): boolean {
  const d = String(valor ?? '').replace(/\D/g, '');
  if (/^(\d)\1+$/.test(d)) return false;
  if (d.length === 11) {
    const dv = (n: number) => {
      let soma = 0;
      for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
      return ((soma * 10) % 11) % 10;
    };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
  }
  if (d.length === 14) {
    const dv = (n: number) => {
      const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const r = pesos.reduce((s, p, i) => s + Number(d[i]) * p, 0) % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
  }
  return false;
}

/** Máscara enquanto digita: até 11 dígitos CPF (000.000.000-00), depois CNPJ (00.000.000/0000-00) */
export function mascaraDocumento(valor: string | null | undefined): string {
  const d = String(valor ?? '').replace(/\D/g, '').slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})$/, '$1.$2.$3/$4-$5');
}
