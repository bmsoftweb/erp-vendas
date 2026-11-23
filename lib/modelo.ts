/** Natureza de venda (CFOP 5.1xx/5.4xx): o modelo da nota segue o destinatário (PAF-NFC-e de SC, Requisito IV, II) */
export const ehVenda = (cfop: unknown) => /^5[14]/.test(String(cfop ?? ''));
