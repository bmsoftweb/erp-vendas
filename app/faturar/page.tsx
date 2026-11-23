import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Receipt, Search, Ticket } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { Campo, INPUT_CLASS } from '@/components/FormCrm';
import { PesquisaCatalogo } from '@/components/PesquisaCatalogo';
import { CampoPesquisa } from '@/app/davs/TelaDav';
import { AvisoErro } from '@/components/AvisoErro';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { NumberField } from '@/components/NumberField';
import { Toggle } from '@/components/Toggle';
import { useRouter } from '@/lib/nav';
import { api, dataBr, docBr, moeda, numDav, qtd } from '@/lib/api';
import { totalItem } from '@/lib/totais';
import { ehVenda } from '@/lib/modelo';

/** Item de pedido com saldo (GET /api/vendas/pendentes) */
interface Pendente {
  dav_id: number; numero: number; prevenda_senha: string | null; data_emissao: string; status: string; valor_frete: string; pessoa_id: number | null; cliente: string | null; cpf_cnpj: string | null;
  natureza_id: number; natureza: string; item_id: number; item: number; descricao: string; unidade: string;
  quantidade: string; preco_unitario: string; valor_desconto: string; faturado: string; iat: string | null;
}

const saldoDe = (i: Pendente) => (Math.round(Number(i.quantidade) * 10000) - Math.round(Number(i.faturado) * 10000)) / 10000;
/** Valor da parte a faturar, com o desconto proporcional (o servidor calcula igual) */
const valorDe = (i: Pendente, q: number) => {
  const inteiro = Math.round(q * 10000) === Math.round(Number(i.quantidade) * 10000);
  const desconto = inteiro ? Number(i.valor_desconto) : Math.round((Number(i.valor_desconto) * q) / Number(i.quantidade) * 100) / 100;
  return totalItem({ quantidade: q, preco_unitario: i.preco_unitario, valor_desconto: desconto, iat: i.iat });
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
  // Caixa da pré-venda: senha → diálogo com natureza (NFC-e/NF-e) e cliente → venda aberta para o pagamento
  const [senha, setSenha] = useState('');
  const [caixa, setCaixa] = useState<{ p: Pendente; total: number; natureza_id: string; pessoa_id: number | null; cliente: string } | null>(null);
  const [pesquisaCliente, setPesquisaCliente] = useState(false);
  const [naturezas, setNaturezas] = useState<{ id: number; descricao: string; documento: string; cfop_estadual: string | null }[]>([]);
  useEffect(() => {
    api('/api/naturezas').then((n) => setNaturezas(n.filter((x: any) => Number(x.ativo) && ['nfe', 'nfce'].includes(x.documento))), (e) => setErro(e.message));
  }, []);

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
      if (t && !`${i.numero} ${i.prevenda_senha ?? ''} ${i.cliente ?? ''} ${i.cpf_cnpj ?? ''}`.toLowerCase().includes(t)) continue;
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

  const abrirCaixa = () => {
    const s = senha.replace(/\D/g, '');
    const linhas = itens.filter((i) => i.prevenda_senha === s);
    if (s.length !== 6) return setAviso('Informe os 6 dígitos da senha da pré-venda.');
    if (!linhas.length) return setAviso(`Nenhuma pré-venda em aberto com a senha ${s}.`);
    const p = linhas[0];
    const fr = p.status === 'aberto' ? Math.round(Number(p.valor_frete) * 100) : 0;
    const total = (linhas.reduce((t, i) => t + Math.round(valorDe(i, saldoDe(i)) * 100), 0) + fr) / 100;
    setCaixa({ p, total, natureza_id: String(p.natureza_id), pessoa_id: p.pessoa_id, cliente: p.cliente ? `${p.cliente}${p.cpf_cnpj ? ` • ${docBr(p.cpf_cnpj)}` : ''}` : '' });
  };
  // Modelo pelo cliente (Requisito IV): só as naturezas de venda dele; a que deixa de servir vira a única que sobra
  const [modelo, setModelo] = useState<'nfe' | 'nfce' | null>(null);
  const comCaixa = !!caixa;
  useEffect(() => {
    if (!comCaixa) return setModelo(null);
    api(`/api/modelo-nota?pessoa_id=${caixa?.pessoa_id ?? ''}&total=${caixa?.total ?? 0}`).then((r) => setModelo(r.modelo), (e) => setErro(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comCaixa, caixa?.pessoa_id, (caixa?.total ?? 0) >= 200000]);
  const servem = naturezas.filter((n) => ehVenda(n.cfop_estadual) && (!modelo || n.documento === modelo));
  useEffect(() => {
    if (!caixa || !modelo || servem.some((n) => n.id === Number(caixa.natureza_id))) return;
    setCaixa({ ...caixa, natureza_id: servem.length === 1 ? String(servem[0].id) : '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelo, caixa?.natureza_id]);
  const nfce = modelo === 'nfce';
  const confirmarCaixa = async () => {
    if (!caixa) return;
    if (!caixa.natureza_id) throw new Error('Escolha a natureza de operação.');
    const v = await api('/api/vendas/prevenda', 'POST', { senha: caixa.p.prevenda_senha, natureza_id: Number(caixa.natureza_id), pessoa_id: caixa.pessoa_id });
    router.push(`/vendas?abrir=${v.id}`);
  };

  const nPedidos = new Set(escolhidos.map((i) => i.dav_id)).size;
  const th = 'px-2 py-2 font-semibold border-b border-r border-stone-200 dark:border-stone-800';
  const td = 'px-2 py-1 border-b border-r border-stone-200 dark:border-stone-800';

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-stone-200 dark:border-stone-800 text-xs">
        <form onSubmit={(e) => (e.preventDefault(), abrirCaixa())} className="flex items-center gap-2">
          <label className="relative w-44">
            <Ticket className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
            <input value={senha} onChange={(e) => setSenha(e.target.value.replace(/\D/g, '').slice(0, 6))} onFocus={(e) => e.target.select()} inputMode="numeric" autoFocus placeholder="Senha da pré-venda" className={`${INPUT_CLASS} pl-8 font-mono`} />
          </label>
          <button type="submit" title="Abre a venda da pré-venda para receber o pagamento e emitir a nota" className="flex items-center gap-1.5 px-3 h-[34px] rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold cursor-pointer">
            Caixa
          </button>
        </form>
        <span className="text-stone-500 mr-auto">{carregando ? 'Carregando…' : `${pedidos.length} pedido(s) com saldo a faturar`}</span>
        <label className="relative w-72">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} onFocus={(e) => e.target.select()} placeholder="Pedido, senha da pré-venda, cliente ou CPF/CNPJ" className={`${INPUT_CLASS} pl-8`} />
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
                <Toggle size="sm" checked={ligado} onChange={(v) => marcar(p, v)} label={<b>Pedido {numDav(p.numero)}</b>} />
                {p.prevenda_senha && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">Pré-venda • senha <span className="font-mono">{p.prevenda_senha}</span></span>}
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
      {caixa && !pesquisaCliente && (
        <ConfirmDialog
          titulo={`Pré-venda • senha ${caixa.p.prevenda_senha}`}
          mensagem={`Pedido ${numDav(caixa.p.numero)}, ${moeda(caixa.total)}. A venda abre em seguida para lançar o pagamento e emitir a nota.`}
          confirmar="Abrir venda"
          tom="normal"
          onConfirmar={confirmarCaixa}
          onCancelar={() => setCaixa(null)}
        >
          <div className="space-y-3">
            <Campo rotulo="Natureza de operação">
              <select required value={caixa.natureza_id} onChange={(e) => setCaixa({ ...caixa, natureza_id: e.target.value })} className={INPUT_CLASS}>
                <option value="">Escolha…</option>
                {servem.map((n) => <option key={n.id} value={n.id}>{n.descricao}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Cliente">
              <CampoPesquisa
                obrigatorio={!nfce}
                texto={caixa.cliente}
                vazio={nfce ? 'Consumidor não identificado' : 'Pesquisar cliente…'}
                onAbrir={() => setPesquisaCliente(true)}
                onLimpar={() => setCaixa({ ...caixa, pessoa_id: null, cliente: '' })}
              />
            </Campo>
          </div>
        </ConfirmDialog>
      )}
      {caixa && pesquisaCliente && (
        <PesquisaCatalogo
          tipo="clientes"
          titulo="Escolher cliente"
          onEscolher={(c) => {
            setPesquisaCliente(false);
            setCaixa({ ...caixa, pessoa_id: c.id, cliente: `${c.nome}${c.cpf_cnpj ? ` • ${docBr(c.cpf_cnpj)}` : ''}` });
          }}
          onFechar={() => setPesquisaCliente(false)}
        />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {aviso && <AvisoErro tom="alerta" mensagem={aviso} onFechar={() => setAviso('')} />}
    </div>
  );
}
