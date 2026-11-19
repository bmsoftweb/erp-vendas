import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Receipt, Search } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { INPUT_CLASS } from '@/components/FormCrm';
import { AvisoErro } from '@/components/AvisoErro';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { NumberField } from '@/components/NumberField';
import { Toggle } from '@/components/Toggle';
import { useRouter } from '@/lib/nav';
import { api, dataBr, docBr, moeda, qtd } from '@/lib/api';
import { totalItem } from '@/lib/totais';

/** Item de pedido com saldo (GET /api/vendas/pendentes) */
interface Pendente {
  dav_id: number; numero: number; data_emissao: string; status: string; valor_frete: string; pessoa_id: number | null; cliente: string | null; cpf_cnpj: string | null;
  natureza_id: number; natureza: string; item_id: number; item: number; descricao: string; unidade: string;
  quantidade: string; preco_unitario: string; valor_desconto: string; faturado: string;
}

const saldoDe = (i: Pendente) => (Math.round(Number(i.quantidade) * 10000) - Math.round(Number(i.faturado) * 10000)) / 10000;
/** Valor da parte a faturar, com o desconto proporcional (o servidor calcula igual) */
const valorDe = (i: Pendente, q: number) => {
  const inteiro = Math.round(q * 10000) === Math.round(Number(i.quantidade) * 10000);
  const desconto = inteiro ? Number(i.valor_desconto) : Math.round((Number(i.valor_desconto) * q) / Number(i.quantidade) * 100) / 100;
  return totalItem({ quantidade: q, preco_unitario: i.preco_unitario, valor_desconto: desconto });
};

/**
 * Faturar pedidos: escolhe um ou mais pedidos do mesmo cliente e natureza, ajusta quanto faturar de cada item
 * e gera a venda (que abre em seguida para conferir parcelas e emitir a nota).
 */
export default function FaturarPage() {
  const router = useRouter();
  const [itens, setItens] = useState<Pendente[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState('');
  const [marcados, setMarcados] = useState<Set<number>>(new Set());
  const [aFaturar, setAFaturar] = useState<Record<number, string>>({});
  const [gerando, setGerando] = useState(false);
  const [confirma, setConfirma] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  const carregar = useCallback(async () => {
    try {
      const r = await api<Pendente[]>('/api/vendas/pendentes');
      setItens(r);
      setAFaturar(Object.fromEntries(r.map((i) => [i.item_id, String(saldoDe(i))])));
      setMarcados(new Set());
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  // Um bloco por pedido, na ordem do número
  const pedidos = useMemo(() => {
    const t = busca.trim().toLowerCase();
    const mapa = new Map<number, Pendente[]>();
    for (const i of itens) {
      if (t && !`${i.numero} ${i.cliente ?? ''} ${i.cpf_cnpj ?? ''}`.toLowerCase().includes(t)) continue;
      mapa.set(i.dav_id, [...(mapa.get(i.dav_id) ?? []), i]);
    }
    return [...mapa.values()];
  }, [itens, busca]);

  const escolhidos = itens.filter((i) => marcados.has(i.dav_id) && Number(aFaturar[i.item_id]) > 0);
  // O frete do pedido entra na primeira venda dele (pedido ainda aberto), como no servidor
  const comFrete = [...new Map(escolhidos.filter((i) => i.status === 'aberto').map((i) => [i.dav_id, i])).values()];
  const frete = comFrete.reduce((s, i) => s + Math.round(Number(i.valor_frete) * 100), 0) / 100;
  const total = (escolhidos.reduce((s, i) => s + Math.round(valorDe(i, Number(aFaturar[i.item_id])) * 100), 0) + Math.round(frete * 100)) / 100;

  const marcar = (p: Pendente, ligar: boolean) => {
    const outro = itens.find((i) => marcados.has(i.dav_id));
    if (ligar && outro && (outro.pessoa_id !== p.pessoa_id || outro.natureza_id !== p.natureza_id))
      return setAviso('Uma venda junta só pedidos do mesmo cliente e da mesma natureza de operação.');
    setMarcados((m) => {
      const n = new Set(m);
      ligar ? n.add(p.dav_id) : n.delete(p.dav_id);
      return n;
    });
  };

  const gerar = async () => {
    setConfirma(false);
    setGerando(true);
    try {
      const v = await api('/api/vendas/faturar', 'POST', { itens: escolhidos.map((i) => ({ dav_item_id: i.item_id, quantidade: aFaturar[i.item_id] })) });
      router.push(`/vendas?abrir=${v.id}`);
    } catch (e: any) {
      setErro(e.message);
      setGerando(false);
    }
  };

  const nPedidos = new Set(escolhidos.map((i) => i.dav_id)).size;
  const th = 'px-2 py-2 font-semibold border-b border-r border-stone-200 dark:border-stone-800';
  const td = 'px-2 py-1 border-b border-r border-stone-200 dark:border-stone-800';

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-stone-200 dark:border-stone-800 text-xs">
        <span className="text-stone-500 mr-auto">{carregando ? 'Carregando…' : `${pedidos.length} pedido(s) com saldo a faturar`}</span>
        <label className="relative w-72">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} onFocus={(e) => e.target.select()} placeholder="Pedido, cliente ou CPF/CNPJ" className={`${INPUT_CLASS} pl-8`} />
        </label>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {!carregando && !pedidos.length && <p className="text-center text-xs text-stone-500 py-10">Nenhum pedido com saldo a faturar.</p>}
        {pedidos.map((linhas) => {
          const p = linhas[0];
          const ligado = marcados.has(p.dav_id);
          return (
            <div key={p.dav_id} className={`rounded-lg border ${ligado ? 'border-blue-400 dark:border-blue-700' : 'border-stone-200 dark:border-stone-800'}`}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs bg-stone-50 dark:bg-stone-950 rounded-t-lg">
                <Toggle size="sm" checked={ligado} onChange={(v) => marcar(p, v)} label={<b>Pedido {p.numero}</b>} />
                <span>{dataBr(p.data_emissao)}</span>
                <span className="font-semibold">{p.cliente ?? 'Consumidor'}{p.cpf_cnpj ? ` • ${docBr(p.cpf_cnpj)}` : ''}</span>
                <span className="text-stone-500">{p.natureza}</span>
                {p.status === 'parcial' && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">Parcial</span>}
              </div>
              {ligado && (
                <table className="planilha w-full text-xs border-collapse">
                  <thead className="text-stone-600 dark:text-stone-300">
                    <tr>
                      <th className={`${th} w-10 text-right`}>#</th>
                      <th className={`${th} text-left`}>Descrição</th>
                      <th className={`${th} w-14 text-center`}>Un</th>
                      <th className={`${th} w-24 text-right`}>Pedida</th>
                      <th className={`${th} w-24 text-right`}>Faturada</th>
                      <th className={`${th} w-24 text-right`}>Saldo</th>
                      <th className={`${th} w-32 text-right`}>A faturar</th>
                      <th className={`${th} w-28 text-right`}>Preço</th>
                      <th className={`${th} w-28 text-right`}>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.map((i) => (
                      <tr key={i.item_id}>
                        <td className={`${td} text-right text-stone-500`}>{i.item}</td>
                        <td className={td}>{i.descricao}</td>
                        <td className={`${td} text-center`}>{i.unidade}</td>
                        <td className={`${td} text-right tabular-nums`}>{qtd(i.quantidade)}</td>
                        <td className={`${td} text-right tabular-nums`}>{qtd(i.faturado)}</td>
                        <td className={`${td} text-right tabular-nums`}>{qtd(saldoDe(i))}</td>
                        <td className={td}><NumberField value={aFaturar[i.item_id]} scale={4} onChange={(v) => setAFaturar((a) => ({ ...a, [i.item_id]: v }))} className={INPUT_CLASS} /></td>
                        <td className={`${td} text-right tabular-nums`}>{moeda(i.preco_unitario)}</td>
                        <td className={`${td} text-right tabular-nums font-semibold`}>{moeda(valorDe(i, Number(aFaturar[i.item_id] || 0)))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-6 px-4 py-3 border-t border-stone-200 dark:border-stone-800 text-xs">
        <span>{nPedidos} pedido(s) • {escolhidos.length} item(ns)</span>
        {frete > 0 && <span>Frete <b className="tabular-nums">{moeda(frete)}</b></span>}
        <span className="text-sm">Total <b className="tabular-nums">{moeda(total)}</b></span>
        <button
          type="button"
          disabled={!escolhidos.length || gerando}
          onClick={() => setConfirma(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          <Receipt className="w-4 h-4" /> {gerando ? 'Gerando…' : 'Gerar venda'}
        </button>
      </div>

      {confirma && (
        <ConfirmDialog
          titulo="Gerar venda"
          mensagem={`Gerar a venda com ${escolhidos.length} item(ns) de ${nPedidos} pedido(s), no total de ${moeda(total)}${frete ? `, com ${moeda(frete)} de frete` : ''}? Ela abre em seguida para conferir as parcelas.`}
          confirmar="Gerar venda"
          tom="normal"
          onConfirmar={gerar}
          onCancelar={() => setConfirma(false)}
        />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {aviso && <AvisoErro tom="alerta" mensagem={aviso} onFechar={() => setAviso('')} />}
    </div>
  );
}
