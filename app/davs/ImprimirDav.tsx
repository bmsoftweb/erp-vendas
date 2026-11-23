import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { Toggle } from '@/components/Toggle';
import { api, dataBr, docBr, foneBr, moeda, numDav, qtd } from '@/lib/api';

/**
 * Impressão do DAV (orçamento/pedido) no leiaute do PAF-NFC-e de SC (Ato DIAT 54/2026, Requisito V, I):
 * título + aviso de "não é documento fiscal" em negrito, número com 10 dígitos, emitente e destinatário com CNPJ/CPF,
 * itens com quantidade, unitário e total. O usuário escolhe discriminar ou não o desconto (Requisito VIII, § 2º).
 * A página é a do navegador (Ctrl+P / botão Imprimir): A4, sem o menu do app.
 * Pré-venda sai só com a senha, sem os itens (Ato DIAT 56/2026, roteiro, Teste 33).
 */
const TITULO: Record<string, string> = { orcamento: 'ORÇAMENTO', pedido: 'PEDIDO' };
/** Pedido de pré-venda sai com o título "PRÉ-VENDA" (Requisito V, I, a) */
const titulo = (d: any) => (d.prevenda_senha ? 'PRÉ-VENDA' : TITULO[d.tipo]);
const cepBr = (v: unknown) => String(v ?? '').replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2');

export default function ImprimirDav() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [erro, setErro] = useState('');
  const [discriminar, setDiscriminar] = useState(true);

  useEffect(() => {
    api(`/api/davs/${id}/impressao`).then(setD, (e) => setErro(e.message));
  }, [id]);
  useEffect(() => {
    if (d) document.title = `${titulo(d)} ${numDav(d.numero)}`;
  }, [d]);

  if (erro) return <p className="p-8 text-sm text-rose-700">{erro}</p>;
  if (!d) return <p className="p-8 text-sm text-stone-500">Carregando…</p>;

  const prevenda = !!d.prevenda_senha;
  const desconto = !prevenda && Number(d.valor_desconto) > 0;
  const mostraDesconto = discriminar && desconto;
  const linha = (partes: unknown[]) => partes.map((p) => String(p ?? '').trim()).filter(Boolean).join(', ');

  return (
    <div className="min-h-screen bg-stone-200 print:bg-white text-black">
      <style>{'@page { size: A4 portrait; margin: 12mm } @media print { html, body { background: #fff !important } }'}</style>

      <div className="print:hidden sticky top-0 z-10 flex items-center justify-center gap-6 bg-white border-b border-stone-300 px-4 py-2 text-sm">
        {desconto && <Toggle size="sm" checked={discriminar} onChange={setDiscriminar} label="Discriminar o desconto" />}
        <button type="button" onClick={() => window.print()} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 cursor-pointer">
          <Printer className="w-4 h-4" /> Imprimir
        </button>
      </div>

      <div className="mx-auto my-6 print:my-0 w-[210mm] max-w-full print:w-full bg-white p-[12mm] print:p-0 shadow print:shadow-none text-[11px] leading-snug">
        {/* Título e aviso (Requisito V, I, a) */}
        <div className="text-center border-b-2 border-black pb-2">
          <h1 className="text-xl font-bold tracking-wide">{titulo(d)}</h1>
          <div className="mt-1 font-bold">
            <p>NÃO É DOCUMENTO FISCAL</p>
            <p>NÃO É VÁLIDO COMO RECIBO E COMO GARANTIA DE MERCADORIA</p>
            <p>NÃO COMPROVA PAGAMENTO</p>
          </div>
        </div>

        {/* Emitente (c) e número/datas (b) */}
        <div className="flex justify-between gap-6 py-2 border-b border-black">
          <div>
            <p className="text-sm font-bold">{d.emit_razao}</p>
            <p>CNPJ: {docBr(d.emit_cnpj)}{d.emit_ie ? `   IE: ${d.emit_ie}` : ''}</p>
            <p>{linha([`${d.emit_logradouro ?? ''} ${d.emit_numero ?? ''}`, d.emit_bairro, d.emit_cidade && `${d.emit_cidade}/${d.emit_uf}`, d.emit_cep && `CEP ${cepBr(d.emit_cep)}`])}</p>
            {d.emit_fone && <p>Fone: {d.emit_fone}</p>}
          </div>
          <div className="text-right shrink-0">
            <p>Nº do DAV</p>
            <p className="text-base font-bold font-mono">{numDav(d.numero)}</p>
            <p>Emissão: {dataBr(d.data_emissao)}</p>
            {d.tipo === 'orcamento' && d.validade && <p>Válido até: {dataBr(d.validade)}</p>}
            {d.prevenda_senha && <p className="mt-1">Senha: <b className="text-base font-mono">{d.prevenda_senha}</b></p>}
            {/* Requisição externa: código do pedido em campo específico (Requisito V, I, g) */}
            {d.origem === 'crm' && d.referencia && <p className="mt-1">Pedido da requisição externa: <b className="font-mono">{d.referencia}</b></p>}
          </div>
        </div>

        {prevenda ? (
          <div className="py-6 text-center">
            <p className="text-sm">Senha da pré-venda</p>
            <p className="text-5xl font-bold font-mono tracking-[0.3em] my-2">{d.prevenda_senha}</p>
            <p className="text-sm">Apresente esta senha no caixa para pagar e retirar a mercadoria.</p>
          </div>
        ) : (
        <>
        {/* Destinatário (d): só quando informado */}
        <div className="py-2 border-b border-black">
          <p className="font-bold">DESTINATÁRIO</p>
          {d.cliente ? (
            <>
              <p>{d.cliente}{d.cpf_cnpj ? ` - ${String(d.cpf_cnpj).length === 11 ? 'CPF' : 'CNPJ'}: ${docBr(d.cpf_cnpj)}` : ''}</p>
              <p>{linha([`${d.logradouro ?? ''} ${d.end_numero ?? ''}`, d.complemento, d.bairro, d.cidade_nome && `${d.cidade_nome}/${d.cidade_uf}`, d.cep && `CEP ${cepBr(d.cep)}`])}</p>
              {d.fone_principal && <p>Fone: {foneBr(d.fone_principal)}</p>}
            </>
          ) : (
            <p>Consumidor não identificado</p>
          )}
          {d.vendedor && <p className="mt-1">Vendedor: {d.vendedor}</p>}
        </div>

        {/* Itens (e) */}
        <table className="w-full mt-2 border-collapse">
          <thead>
            <tr className="border-b border-black text-left">
              <th className="py-1 pr-2 w-8">Item</th>
              <th className="py-1 pr-2 w-20">Código</th>
              <th className="py-1 pr-2">Descrição</th>
              <th className="py-1 pr-2 text-right w-16">Qtd</th>
              <th className="py-1 pr-2 w-8">Un</th>
              <th className="py-1 pr-2 text-right w-20">Vl. unit.</th>
              {mostraDesconto && <th className="py-1 pr-2 text-right w-20">Desconto</th>}
              <th className="py-1 text-right w-24">Total</th>
            </tr>
          </thead>
          <tbody>
            {d.itens.map((i: any) => (
              <tr key={i.item} className="border-b border-stone-300 align-top">
                <td className="py-1 pr-2">{String(i.item).padStart(3, '0')}</td>
                <td className="py-1 pr-2 font-mono">{i.codigo}</td>
                <td className="py-1 pr-2">{i.descricao}</td>
                <td className="py-1 pr-2 text-right">{qtd(i.quantidade)}</td>
                <td className="py-1 pr-2">{i.unidade}</td>
                {/* Sem discriminar, o unitário já sai líquido do desconto */}
                <td className="py-1 pr-2 text-right">{moeda(mostraDesconto ? i.preco_unitario : Number(i.valor_total) / Number(i.quantidade))}</td>
                {mostraDesconto && <td className="py-1 pr-2 text-right">{Number(i.valor_desconto) ? moeda(i.valor_desconto) : ''}</td>}
                <td className="py-1 text-right">{moeda(i.valor_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totais */}
        <div className="flex justify-end mt-2">
          <table className="w-64">
            <tbody>
              <tr><td className="py-0.5">Produtos</td><td className="text-right">{moeda(mostraDesconto ? d.valor_produtos : Number(d.valor_produtos) - Number(d.valor_desconto))}</td></tr>
              {mostraDesconto && <tr><td className="py-0.5">Desconto</td><td className="text-right">-{moeda(d.valor_desconto)}</td></tr>}
              {Number(d.valor_frete) > 0 && <tr><td className="py-0.5">Frete</td><td className="text-right">{moeda(d.valor_frete)}</td></tr>}
              <tr className="border-t border-black font-bold text-sm"><td className="py-1">TOTAL</td><td className="text-right">{moeda(d.valor_total)}</td></tr>
            </tbody>
          </table>
        </div>

        {d.parcelas.length > 0 && (
          <div className="mt-3">
            <p className="font-bold">CONDIÇÃO DE PAGAMENTO</p>
            <p>{d.parcelas.map((p: any) => `${p.numero}ª ${dataBr(p.vencimento)} ${p.forma_pagamento} ${moeda(p.valor)}`).join('   ·   ')}</p>
          </div>
        )}
        {d.informacoes_complementares && (
          <div className="mt-3">
            <p className="font-bold">INFORMAÇÕES COMPLEMENTARES</p>
            <p className="whitespace-pre-line">{d.informacoes_complementares}</p>
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}
