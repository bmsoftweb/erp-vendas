import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Ban, Calculator, CheckCircle2, Copy, Eye, ExternalLink, FileCheck2, Pencil, Plus, Printer, Save, Search, Trash2, X, XCircle } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { TelaCheia, SecaoCrm, GradeCampos, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao, SeparadorAcoes, Vazio } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { ModalPesquisa } from '@/components/ModalPesquisa';
import { NumberField } from '@/components/NumberField';
import { DateField } from '@/components/DateField';
import { api, dataBr, docBr, hojeIso, moeda, qtd } from '@/lib/api';
import { totais, totalItem } from '@/lib/totais';
import { FORMAS_PAGAMENTO, gerarParcelas, somaParcelas, somarDias } from '@/lib/parcelas';

type Tipo = 'orcamento' | 'pedido' | 'venda';
const NOME: Record<Tipo, string> = { orcamento: 'Orçamento', pedido: 'Pedido', venda: 'Venda' };
const STATUS_LISTA: Record<Tipo, string[]> = {
  orcamento: ['aberto', 'aprovado', 'recusado', 'cancelado'],
  pedido: ['aberto', 'parcial', 'faturado', 'cancelado'],
  venda: ['aberta', 'faturando', 'faturada', 'rejeitada', 'cancelada'],
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const DOC: Record<string, string> = { nfe: 'NF-e', nfce: 'NFC-e', nfse: 'NFS-e' };
/** Totais do /api/calcular do erp-nfe que vale mostrar */
const IMPOSTOS: [string, string][] = [['vICMS', 'ICMS'], ['vST', 'ICMS ST'], ['vFCP', 'FCP'], ['vIPI', 'IPI'], ['vPIS', 'PIS'], ['vCOFINS', 'COFINS'], ['vIBSUF', 'IBS UF'], ['vIBSMun', 'IBS Mun.'], ['vCBS', 'CBS'], ['vICMSUFDest', 'DIFAL UF destino']];

interface Item { pedido?: number; produto_id: number; descricao: string; unidade: string; quantidade: string | number; preco_unitario: string | number; valor_desconto: string | number }
interface Parcela { vencimento: string; forma_pagamento: string; valor: string | number }
interface Dav {
  id?: number; numero?: number; status?: string; tipo?: Tipo; origem?: string;
  natureza_id: number | ''; pessoa_id: number | null; cliente?: string; cpf_cnpj?: string;
  vendedor_id: number | ''; condicao_pagamento_id: number | '';
  data_emissao: string; validade: string | null;
  modalidade_frete: number; transportadora_id: number | null; transportadora?: string;
  valor_frete: string | number; observacoes: string; informacoes_complementares: string;
  itens: Item[]; parcelas: Parcela[];
}
interface Apoio {
  naturezas: { id: number; descricao: string; documento: string }[];
  condicoes: { id: number; nome: string; prazos: string; forma_pagamento: string }[];
  vendedores: { id: number; nome: string }[];
  naturezaPadrao: number | null; validadeDias: number; usuarioId: number;
}

const STATUS: Record<string, string> = {
  aberto: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  aberta: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  faturando: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  faturada: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  rejeitada: 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  cancelada: 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  aprovado: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  faturado: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  parcial: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  recusado: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
  cancelado: 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
};
const FRETE: Record<number, string> = { 9: 'Sem frete', 0: 'Por conta do emitente (CIF)', 1: 'Por conta do destinatário (FOB)', 2: 'Por conta de terceiros', 3: 'Próprio do emitente', 4: 'Próprio do destinatário' };

/** Pesquisa no servidor enquanto digita (a última resposta vence) */
function useBusca<T>(url: string | null) {
  const [itens, setItens] = useState<T[]>([]);
  const [carregando, setCarregando] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const buscar = useCallback((termo: string) => {
    if (!url) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const n = ++seq.current;
      setCarregando(true);
      try {
        const r = await api<T[]>(`${url}${url.includes('?') ? '&' : '?'}busca=${encodeURIComponent(termo)}`);
        if (n === seq.current) setItens(r);
      } finally {
        if (n === seq.current) setCarregando(false);
      }
    }, 250);
  }, [url]);
  useEffect(() => {
    if (url) buscar('');
  }, [url, buscar]);
  return { itens, carregando, buscar };
}

/** Botão no visual de campo que abre a pesquisa */
const CampoPesquisa: React.FC<{ texto?: string; vazio: string; onAbrir: () => void; onLimpar?: () => void; obrigatorio?: boolean }> = ({ texto, vazio, onAbrir, onLimpar, obrigatorio }) => (
  <div className="relative">
    <button type="button" onClick={onAbrir} data-obrigatorio={obrigatorio ? '' : undefined} className={`${INPUT_CLASS} campo-botao text-left flex items-center gap-2 cursor-pointer`}>
      <Search className="w-3.5 h-3.5 text-stone-400 shrink-0" />
      <span className={`truncate ${texto ? '' : 'text-stone-400 font-normal'}`}>{texto || vazio}</span>
    </button>
    {texto && onLimpar && (
      <button type="button" onClick={onLimpar} title="Limpar" className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-stone-400 hover:text-stone-700 cursor-pointer">
        <X className="w-3.5 h-3.5" />
      </button>
    )}
  </div>
);

export default function TelaDav({ tipo }: { tipo: Tipo }) {
  const nome = NOME[tipo];
  const fem = tipo === 'venda';
  const g = (m: string, f: string) => (fem ? f : m);
  const base = tipo === 'venda' ? '/api/vendas' : '/api/davs';
  const [params, setParams] = useSearchParams();
  const [linhas, setLinhas] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [filtro, setFiltro] = useState({ de: somarDias(hojeIso(), -90), ate: '', status: '' });
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [form, setForm] = useState<Dav | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [ok, setOk] = useState('');
  const [confirma, setConfirma] = useState<{ titulo: string; mensagem: string; rotulo: string; perigo?: boolean; acao: () => Promise<void> } | null>(null);
  const [pesquisa, setPesquisa] = useState<'cliente' | 'transportadora' | 'produto' | null>(null);
  const [impostos, setImpostos] = useState<Record<string, number> | null>(null);
  const [calculando, setCalculando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const q = new URLSearchParams({ tipo, ...Object.fromEntries(Object.entries(filtro).filter(([, v]) => v)) });
      setLinhas(await api(`${base}?${q}`));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [tipo, base, filtro]);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => void api<Apoio>('/api/apoio').then(setApoio).catch((e) => setErro(e.message)), []);
  useRefreshDaTela(carregar);
  // Vindo do Faturar pedidos: /vendas?abrir=<id> abre a venda gerada
  useEffect(() => {
    const id = Number(params.get('abrir'));
    if (id) (abrir(id), setParams({}, { replace: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  useEffect(() => setImpostos(null), [form?.id]);
  // Trocar de Orçamentos para Pedidos (mesmo componente) fecha o registro aberto
  useEffect(() => setForm(null), [tipo]);

  const natureza = apoio?.naturezas.find((n) => n.id === Number(form?.natureza_id));
  const editavel = !form?.id || form.status === 'aberto' || form.status === 'aberta' || (tipo === 'venda' && form.status === 'rejeitada');
  // Venda que veio de pedido: itens, cliente e natureza são os faturados (para mudar, cancele e fature de novo)
  const itensFixos = tipo === 'venda' && form?.origem === 'pedido';
  const t = useMemo(() => totais(form?.itens ?? [], form?.valor_frete), [form?.itens, form?.valor_frete]);
  const somaParc = somaParcelas((form?.parcelas ?? []).map((p) => p.valor));

  const urlPesquisa =
    pesquisa === 'cliente' ? '/api/pessoas' :
    pesquisa === 'transportadora' ? '/api/pessoas?transportadora=1' :
    pesquisa === 'produto' ? `/api/produtos?servico=${natureza?.documento === 'nfse' ? 1 : 0}` : null;
  const busca = useBusca<any>(urlPesquisa);

  const novo = () => {
    if (!apoio) return;
    const hoje = hojeIso();
    setForm({
      natureza_id: apoio.naturezaPadrao ?? (apoio.naturezas.length === 1 ? apoio.naturezas[0].id : ''),
      pessoa_id: null, vendedor_id: apoio.vendedores.some((v) => v.id === apoio.usuarioId) ? apoio.usuarioId : '',
      condicao_pagamento_id: '', data_emissao: hoje, validade: tipo === 'orcamento' ? somarDias(hoje, apoio.validadeDias) : null,
      modalidade_frete: 9, transportadora_id: null, valor_frete: 0, observacoes: '', informacoes_complementares: '', itens: [], parcelas: [],
    });
  };

  const abrir = async (id: number, copia = false) => {
    try {
      const d = await api(`${base}/${id}`);
      const dav: Dav = { ...d, observacoes: d.observacoes ?? '', informacoes_complementares: d.informacoes_complementares ?? '', vendedor_id: d.vendedor_id ?? '', condicao_pagamento_id: d.condicao_pagamento_id ?? '' };
      if (copia) {
        const hoje = hojeIso();
        Object.assign(dav, { id: undefined, numero: undefined, status: undefined, origem: undefined, data_emissao: hoje, validade: tipo === 'orcamento' ? somarDias(hoje, apoio?.validadeDias ?? 7) : null, parcelas: [] });
      }
      setForm(dav);
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const muda = <K extends keyof Dav>(campo: K, valor: Dav[K]) => setForm((f) => (f ? { ...f, [campo]: valor } : f));
  const mudaItem = (i: number, campo: keyof Item, valor: string) =>
    setForm((f) => (f ? { ...f, itens: f.itens.map((it, k) => (k === i ? { ...it, [campo]: valor } : it)) } : f));
  const mudaParcela = (i: number, campo: keyof Parcela, valor: string) =>
    setForm((f) => (f ? { ...f, parcelas: f.parcelas.map((p, k) => (k === i ? { ...p, [campo]: valor } : p)) } : f));

  const gerar = () => {
    const c = apoio?.condicoes.find((x) => x.id === Number(form?.condicao_pagamento_id));
    if (!form) return;
    if (!t.valor_total) return setAviso('Inclua os itens antes de gerar as parcelas.');
    muda('parcelas', gerarParcelas(c?.prazos ?? '0', t.valor_total, form.data_emissao || hojeIso(), c?.forma_pagamento || 'Dinheiro'));
  };

  const salvar = async () => {
    if (!form) return;
    setSalvando(true);
    try {
      const corpo = { ...form, tipo };
      const r = form.id ? await api(`${base}/${form.id}`, 'PUT', corpo) : await api(base, 'POST', corpo);
      setForm(null);
      setAviso('');
      await carregar();
      setOk(form.id ? `${nome} ${form.numero} ${g('gravado', 'gravada')}.` : `${nome} ${r.numero} ${g('incluído', 'incluída')}.`);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const executar = (titulo: string, mensagem: string, rotulo: string, url: string, metodo = 'POST', perigo = false, depois?: (r: any) => void) =>
    setConfirma({
      titulo, mensagem, rotulo, perigo,
      acao: async () => {
        setConfirma(null);
        try {
          const r = await api(url, metodo);
          await carregar();
          depois?.(r);
        } catch (e: any) {
          setErro(e.message);
        }
      },
    });

  const calcular = async () => {
    if (!form?.id) return;
    setCalculando(true);
    try {
      setImpostos((await api(`/api/vendas/${form.id}/calcular`, 'POST')).totais);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCalculando(false);
    }
  };

  /** Abre o erp-nfe já logado e na nota da venda (aba aberta no clique, para o navegador não bloquear) */
  const abrirNfe = async () => {
    const aba = window.open('', '_blank');
    if (aba) aba.opener = null;
    try {
      const { url } = await api(`/api/vendas/${form!.id}/nfe-link`);
      if (aba) aba.location.href = url;
      else if (!window.open(url, '_blank', 'noopener')) setAviso('O navegador bloqueou a aba do erp-nfe: libere as janelas pop-up deste endereço.');
    } catch (e: any) {
      aba?.close();
      setErro(e.message);
    }
  };

  /** DANFE da nota autorizada numa aba nova (aberta já no clique, para o navegador não bloquear) */
  const danfe = async (r: any) => {
    const aba = window.open('', '_blank');
    try {
      const resp = await fetch(`/api/vendas/${r.id}/danfe`);
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Falha ao gerar o DANFE.');
      const url = URL.createObjectURL(await resp.blob());
      if (aba) aba.location.href = url;
      else if (!window.open(url, '_blank')) setAviso('O navegador bloqueou a aba do DANFE: libere as janelas pop-up deste endereço.');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      aba?.close();
      setErro(e.message);
    }
  };

  /** Emite (ou retoma) a nota da venda e diz o que aconteceu */
  const emitir = (r: any) =>
    executar(`Emitir ${DOC[r.documento]}`, `Emitir a ${DOC[r.documento]} da venda ${r.numero} (${moeda(r.valor_total)})? Ela é transmitida no ambiente configurado no ${r.documento === 'nfse' ? 'erp-nfs' : 'erp-nfe'}.`, 'Emitir nota', `/api/vendas/${r.id}/emitir`, 'POST', false, (n) =>
      n.situacao === 'autorizada' ? setOk(`${DOC[r.documento]} ${n.numero ?? ''} autorizada.`)
        : n.situacao === 'rejeitada' || n.situacao === 'denegada' ? setErro(`${DOC[r.documento]} ${n.situacao}: ${n.motivo ?? 'sem motivo'}. Corrija a venda e emita de novo.`)
        : setAviso(`A ${DOC[r.documento]} foi enviada e ainda não tem resposta. Use “Emitir nota” de novo para consultar.`));

  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  if (form) {
    const titulo = form.id ? `${nome} ${form.numero}` : `${g('Novo', 'Nova')} ${nome.toLowerCase()}`;
    const difParcelas = form.parcelas.length ? Math.round((t.valor_total - somaParc) * 100) / 100 : 0;
    return (
      <>
        <TelaCheia
          larga
          rodape={form.id ? `${titulo} • ${form.status}` : 'Inclusão'}
          onVoltar={() => setForm(null)}
          rotuloVoltar={editavel ? 'Cancelar' : 'Voltar para a Lista'}
          onSubmit={editavel ? salvar : undefined}
          rotuloPrincipal="Salvar"
          iconePrincipal={<Save className="w-4 h-4" />}
          salvando={salvando}
          acoes={tipo === 'venda' && form.id && natureza?.documento !== 'nfse' && (
            <button type="button" onClick={abrirNfe} title="Abre o erp-nfe já na nota desta venda" className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-xs font-semibold text-stone-600 dark:text-stone-300 border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer">
              <ExternalLink className="w-3.5 h-3.5" /> <span>NFe</span>
            </button>
          )}
        >
          {!editavel && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              {titulo} está <b>{form.status}</b>: só consulta.
            </div>
          )}
          <fieldset disabled={!editavel} className="space-y-5 min-w-0">
            <SecaoCrm titulo={titulo}>
              <GradeCampos>
                <Campo rotulo="Natureza de operação">
                  <select required autoFocus={!form.natureza_id} disabled={itensFixos} value={form.natureza_id} onChange={(e) => muda('natureza_id', Number(e.target.value) || '')} className={INPUT_CLASS}>
                    <option value="">Escolha…</option>
                    {apoio?.naturezas.map((n) => <option key={n.id} value={n.id}>{n.descricao}</option>)}
                  </select>
                </Campo>
                <Campo rotulo="Cliente" span={2}>
                  <CampoPesquisa
                    obrigatorio={natureza?.documento !== 'nfce'}
                    texto={form.cliente ? `${form.cliente}${form.cpf_cnpj ? ` • ${docBr(form.cpf_cnpj)}` : ''}` : ''}
                    vazio={natureza?.documento === 'nfce' ? 'Consumidor não identificado' : 'Pesquisar cliente…'}
                    onAbrir={() => !itensFixos && setPesquisa('cliente')}
                    onLimpar={editavel && !itensFixos ? () => setForm({ ...form, pessoa_id: null, cliente: '', cpf_cnpj: '' }) : undefined}
                  />
                </Campo>
                <Campo rotulo="Vendedor">
                  <select value={form.vendedor_id} onChange={(e) => muda('vendedor_id', Number(e.target.value) || '')} className={INPUT_CLASS}>
                    <option value="">—</option>
                    {apoio?.vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
                  </select>
                </Campo>
                <Campo rotulo="Data">
                  <DateField required value={form.data_emissao} onChange={(v) => muda('data_emissao', v)} />
                </Campo>
                {tipo === 'orcamento' && (
                  <Campo rotulo="Validade">
                    <DateField value={form.validade ?? ''} onChange={(v) => muda('validade', v)} />
                  </Campo>
                )}
                <Campo rotulo="Condição de pagamento">
                  <select value={form.condicao_pagamento_id} onChange={(e) => muda('condicao_pagamento_id', Number(e.target.value) || '')} className={INPUT_CLASS}>
                    <option value="">—</option>
                    {apoio?.condicoes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                  </select>
                </Campo>
              </GradeCampos>
            </SecaoCrm>

            <SecaoCrm
              titulo="Itens"
              direita={editavel && !itensFixos && (
                <button type="button" onClick={() => (natureza ? setPesquisa('produto') : setAviso('Escolha a natureza de operação antes dos itens.'))} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer">
                  <Plus className="w-3.5 h-3.5" /> Adicionar item
                </button>
              )}
            >
              <fieldset disabled={itensFixos} className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 min-w-0">
                <table className="planilha w-full text-xs border-collapse">
                  <thead className="bg-stone-50 dark:bg-stone-950 text-stone-600 dark:text-stone-300">
                    <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:font-semibold [&>th]:border-b [&>th]:border-r [&>th]:border-stone-200 dark:[&>th]:border-stone-800">
                      <th className="w-10 text-right">#</th>
                      <th className="text-left">Descrição</th>
                      <th className="w-14 text-center">Un</th>
                      <th className="w-28 text-right">Quantidade</th>
                      <th className="w-32 text-right">Preço</th>
                      <th className="w-28 text-right">Desconto</th>
                      <th className="w-32 text-right">Total</th>
                      {editavel && !itensFixos && <th className="w-10" />}
                    </tr>
                  </thead>
                  <tbody>
                    {form.itens.map((it, i) => (
                      <tr key={i} className="[&>td]:px-2 [&>td]:py-1 [&>td]:border-b [&>td]:border-r [&>td]:border-stone-200 dark:[&>td]:border-stone-800">
                        <td className="text-right text-stone-500">{i + 1}</td>
                        <td title={it.pedido ? `Pedido ${it.pedido}` : undefined}><input required value={it.descricao} maxLength={120} onFocus={sel} onChange={(e) => mudaItem(i, 'descricao', e.target.value)} className={INPUT_CLASS} /></td>
                        <td className="text-center">{it.unidade}</td>
                        <td><NumberField value={it.quantidade} scale={4} onChange={(v) => mudaItem(i, 'quantidade', v)} className={INPUT_CLASS} /></td>
                        <td><NumberField value={it.preco_unitario} scale={2} onChange={(v) => mudaItem(i, 'preco_unitario', v)} className={INPUT_CLASS} /></td>
                        <td><NumberField value={it.valor_desconto} scale={2} onChange={(v) => mudaItem(i, 'valor_desconto', v)} className={INPUT_CLASS} /></td>
                        <td className="text-right font-semibold tabular-nums">{moeda(totalItem(it))}</td>
                        {editavel && !itensFixos && (
                          <td className="text-center">
                            <button type="button" title="Remover item" onClick={() => setConfirma({ titulo: 'Remover item', mensagem: `Remover “${it.descricao}” da lista?`, rotulo: 'Remover', perigo: true, acao: async () => (setConfirma(null), muda('itens', form.itens.filter((_, k) => k !== i))) })} className="p-1 rounded text-stone-400 hover:text-rose-600 cursor-pointer">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                    {!form.itens.length && (
                      <tr><td colSpan={8} className="px-3 py-6 text-center text-stone-500">Nenhum item. Use “Adicionar item”.</td></tr>
                    )}
                  </tbody>
                </table>
              </fieldset>
              {itensFixos && <p className="mt-2 text-xs text-stone-500">Itens faturados de pedido: para mudar, cancele a venda e fature de novo.</p>}
              <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-2 text-xs items-center">
                <span>Produtos <b className="tabular-nums">{moeda(t.valor_produtos)}</b></span>
                <span>Descontos <b className="tabular-nums">{moeda(t.valor_desconto)}</b></span>
                <span className="flex items-center gap-2">Frete <span className="w-28"><NumberField value={form.valor_frete} scale={2} onChange={(v) => muda('valor_frete', v)} className={INPUT_CLASS} /></span></span>
                <span className="text-sm">Total <b className="tabular-nums">{moeda(t.valor_total)}</b></span>
              </div>
            </SecaoCrm>

            <SecaoCrm
              titulo="Pagamento"
              direita={editavel && (
                <div className="flex gap-1">
                  <button type="button" onClick={gerar} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer">Gerar pela condição</button>
                  <button type="button" onClick={() => muda('parcelas', [...form.parcelas, { vencimento: form.data_emissao, forma_pagamento: 'Boleto', valor: Math.max(difParcelas || t.valor_total - somaParc, 0) }])} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer">
                    <Plus className="w-3.5 h-3.5" /> Parcela
                  </button>
                </div>
              )}
            >
              {form.parcelas.length ? (
                <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 max-w-2xl">
                  <table className="planilha w-full text-xs border-collapse">
                    <thead className="bg-stone-50 dark:bg-stone-950 text-stone-600 dark:text-stone-300">
                      <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:font-semibold [&>th]:border-b [&>th]:border-r [&>th]:border-stone-200 dark:[&>th]:border-stone-800">
                        <th className="w-10 text-right">#</th><th className="w-40 text-center">Vencimento</th><th className="text-left">Forma</th><th className="w-32 text-right">Valor</th>{editavel && <th className="w-10" />}
                      </tr>
                    </thead>
                    <tbody>
                      {form.parcelas.map((p, i) => (
                        <tr key={i} className="[&>td]:px-2 [&>td]:py-1 [&>td]:border-b [&>td]:border-r [&>td]:border-stone-200 dark:[&>td]:border-stone-800">
                          <td className="text-right text-stone-500">{i + 1}</td>
                          <td><DateField required value={p.vencimento} onChange={(v) => mudaParcela(i, 'vencimento', v)} /></td>
                          <td>
                            <select value={p.forma_pagamento} onChange={(e) => mudaParcela(i, 'forma_pagamento', e.target.value)} className={INPUT_CLASS}>
                              {FORMAS_PAGAMENTO.map((f) => <option key={f}>{f}</option>)}
                            </select>
                          </td>
                          <td><NumberField value={p.valor} scale={2} onChange={(v) => mudaParcela(i, 'valor', v)} className={INPUT_CLASS} /></td>
                          {editavel && (
                            <td className="text-center">
                              <button type="button" title="Remover parcela" onClick={() => setConfirma({ titulo: 'Remover parcela', mensagem: `Remover a parcela ${i + 1}?`, rotulo: 'Remover', perigo: true, acao: async () => (setConfirma(null), muda('parcelas', form.parcelas.filter((_, k) => k !== i))) })} className="p-1 rounded text-stone-400 hover:text-rose-600 cursor-pointer">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-stone-500">Sem parcelas: à vista. Escolha a condição e use “Gerar pela condição”.</p>
              )}
              {difParcelas !== 0 && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">As parcelas somam {moeda(somaParc)}; faltam {moeda(difParcelas)} para o total de {moeda(t.valor_total)}.</p>
              )}
            </SecaoCrm>

            {natureza?.documento === 'nfe' && (
              <SecaoCrm titulo="Transporte">
                <GradeCampos>
                  <Campo rotulo="Frete" span={2}>
                    <select value={form.modalidade_frete} onChange={(e) => muda('modalidade_frete', Number(e.target.value))} className={INPUT_CLASS}>
                      {Object.entries(FRETE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </Campo>
                  {form.modalidade_frete !== 9 && (
                    <Campo rotulo="Transportadora" span={2}>
                      <CampoPesquisa texto={form.transportadora} vazio="Pesquisar transportadora…" onAbrir={() => setPesquisa('transportadora')} onLimpar={editavel ? () => setForm({ ...form, transportadora_id: null, transportadora: '' }) : undefined} />
                    </Campo>
                  )}
                </GradeCampos>
              </SecaoCrm>
            )}

            {tipo === 'venda' && form.id && natureza && natureza.documento !== 'nfse' && (
              <SecaoCrm
                titulo="Impostos"
                direita={
                  <button type="button" onClick={calcular} disabled={calculando} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer disabled:opacity-50">
                    <Calculator className="w-3.5 h-3.5" /> {calculando ? 'Calculando…' : 'Calcular pelo erp-nfe'}
                  </button>
                }
              >
                {impostos ? (
                  <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
                    {IMPOSTOS.filter(([k]) => Number(impostos[k])).map(([k, rot]) => <span key={k}>{rot} <b className="tabular-nums">{moeda(impostos[k])}</b></span>)}
                    <span className="text-sm">Total da nota <b className="tabular-nums">{moeda(impostos.vNF)}</b></span>
                  </div>
                ) : (
                  <p className="text-xs text-stone-500">Calcula com os dados gravados da venda, sem emitir nem reservar número.</p>
                )}
              </SecaoCrm>
            )}

            <SecaoCrm titulo="Observações">
              <GradeCampos>
                <Campo rotulo="Informações complementares" span={2} dica="Vão para a nota, depois do texto da natureza">
                  <textarea rows={3} value={form.informacoes_complementares} onChange={(e) => muda('informacoes_complementares', e.target.value)} className={INPUT_CLASS} />
                </Campo>
                <Campo rotulo="Observações internas" span={2} dica="Não vão para a nota">
                  <textarea rows={3} value={form.observacoes} onChange={(e) => muda('observacoes', e.target.value)} className={INPUT_CLASS} />
                </Campo>
              </GradeCampos>
            </SecaoCrm>
          </fieldset>
        </TelaCheia>

        {pesquisa === 'produto' && (
          <ModalPesquisa
            titulo={natureza?.documento === 'nfse' ? 'Adicionar serviço' : 'Adicionar produto'}
            placeholder="Nome, SKU ou código de barras"
            itens={busca.itens}
            carregando={busca.carregando}
            onBusca={busca.buscar}
            chave={(p) => p.id}
            colunas={[
              { label: 'Produto', render: (p) => p.nome },
              { label: 'SKU', render: (p) => p.sku, largura: 'w-28' },
              { label: 'Un', render: (p) => p.unidade, alinhar: 'centro', largura: 'w-14' },
              { label: 'Preço', render: (p) => moeda(p.preco_venda), alinhar: 'direita', largura: 'w-28' },
            ]}
            onEscolher={(p) => {
              setPesquisa(null);
              muda('itens', [...form.itens, { produto_id: p.id, descricao: p.nome, unidade: p.unidade, quantidade: 1, preco_unitario: Number(p.preco_venda || 0), valor_desconto: 0 }]);
            }}
            onFechar={() => setPesquisa(null)}
          />
        )}
        {(pesquisa === 'cliente' || pesquisa === 'transportadora') && (
          <ModalPesquisa
            titulo={pesquisa === 'cliente' ? 'Escolher cliente' : 'Escolher transportadora'}
            placeholder="Nome, CPF/CNPJ ou código"
            itens={busca.itens}
            carregando={busca.carregando}
            onBusca={busca.buscar}
            chave={(p) => p.id}
            colunas={[
              { label: 'Nome', render: (p) => p.nome },
              { label: 'CPF/CNPJ', render: (p) => docBr(p.cpf_cnpj), largura: 'w-40' },
              { label: 'Cidade', render: (p) => [p.cidade, p.uf].filter(Boolean).join('/'), largura: 'w-40' },
            ]}
            onEscolher={(p) => {
              setPesquisa(null);
              setForm(pesquisa === 'cliente' ? { ...form, pessoa_id: p.id, cliente: p.nome, cpf_cnpj: p.cpf_cnpj } : { ...form, transportadora_id: p.id, transportadora: p.nome });
            }}
            onFechar={() => setPesquisa(null)}
          />
        )}
        {confirma && <ConfirmDialog titulo={confirma.titulo} mensagem={confirma.mensagem} confirmar={confirma.rotulo} tom={confirma.perigo ? 'perigo' : 'normal'} onConfirmar={confirma.acao} onCancelar={() => setConfirma(null)} />}
        {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
        {aviso && <AvisoErro tom="alerta" mensagem={aviso} onFechar={() => setAviso('')} />}
        {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
      </>
    );
  }

  const aberto = (r: any) => r.status === 'aberto' || r.status === 'aberta';
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ListaCrm
        className="flex-1"
        id={`davs_${tipo}`}
        linhas={linhas}
        carregando={carregando}
        chave={(r) => r.id}
        onNovo={apoio?.naturezas.length ? novo : () => setAviso('Cadastre uma natureza de operação antes (Cadastros › Naturezas de operação).')}
        rotuloNovo={`${g('Novo', 'Nova')} ${nome.toLowerCase()}`}
        onEditar={(r) => abrir(r.id)}
        acoesEmMenu={tipo === 'orcamento'}
        vazio={`${g('Nenhum', 'Nenhuma')} ${nome.toLowerCase()} no período.`}
        barraExtra={
          <div className="flex items-center gap-2 text-xs">
            <span className="w-36 shrink-0"><DateField value={filtro.de} onChange={(v) => setFiltro({ ...filtro, de: v })} placeholder="De" /></span>
            <span className="w-36 shrink-0"><DateField value={filtro.ate} onChange={(v) => setFiltro({ ...filtro, ate: v })} placeholder="Até" /></span>
            <select value={filtro.status} onChange={(e) => setFiltro({ ...filtro, status: e.target.value })} className={INPUT_CLASS + ' !w-36 shrink-0'}>
              <option value="">Todos</option>
              {STATUS_LISTA[tipo].map((s) => <option key={s} value={s}>{cap(s)}</option>)}
            </select>
          </div>
        }
        colunas={[
          { key: 'numero', label: 'Número', alinhar: 'numero', largura: 90 },
          { key: 'data_emissao', label: 'Data', alinhar: 'centro', largura: 100, render: (r) => dataBr(r.data_emissao) },
          ...(tipo === 'orcamento' ? [{ key: 'validade', label: 'Validade', alinhar: 'centro' as const, largura: 100, render: (r: any) => dataBr(r.validade) }] : []),
          { key: 'cliente', label: 'Cliente', largura: 240, render: (r) => r.cliente ?? <span className="text-stone-400">Consumidor</span> },
          { key: 'natureza', label: 'Natureza', largura: 160 },
          { key: 'vendedor', label: 'Vendedor', largura: 140 },
          { key: 'valor_total', label: 'Total', alinhar: 'numero', largura: 110, render: (r) => moeda(r.valor_total) },
          { key: 'status', label: 'Situação', alinhar: 'centro', largura: 100, render: (r) => <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS[r.status] ?? ''}`}>{cap(r.status)}</span> },
          tipo === 'orcamento' ? { key: 'pedido_numero', label: 'Pedido', alinhar: 'numero' as const, largura: 80 }
            : tipo === 'pedido' ? { key: 'orcamento_numero', label: 'Orçamento', alinhar: 'numero' as const, largura: 90 }
            : { key: 'pedidos', label: 'Pedidos', largura: 110 },
        ]}
        rodape={(k) => (k === 'valor_total' ? <b>{moeda(linhas.filter((r) => !['cancelado', 'cancelada', 'recusado'].includes(r.status)).reduce((s, r) => s + Number(r.valor_total), 0))}</b> : null)}
        acoes={(r) =>
          tipo === 'venda' ? (
            // Posições fixas: Emitir ou Imprimir DANFE (nunca juntos), Cancelar | Editar/Consultar
            <>
              {['aberta', 'rejeitada', 'faturando'].includes(r.status) ? <BotaoAcao icone={FileCheck2} titulo="Emitir nota" descricao={`Emite a ${DOC[r.documento]} pelo ${r.documento === 'nfse' ? 'erp-nfs' : 'erp-nfe'} (pede confirmação)`} tom="verde" onClick={() => emitir(r)} />
                : r.status === 'faturada' && r.documento !== 'nfse' ? <BotaoAcao icone={Printer} titulo="Imprimir DANFE" descricao={`Abre o DANFE da ${DOC[r.documento]} em PDF numa aba nova`} onClick={() => danfe(r)} />
                : <Vazio />}
              {aberto(r) ? <BotaoAcao icone={Ban} titulo="Cancelar" descricao="Cancela a venda sem nota; o saldo volta aos pedidos" tom="perigo" onClick={() => executar('Cancelar venda', `Cancelar a venda ${r.numero}?${r.pedidos ? ` Os itens voltam a ficar a faturar no(s) pedido(s) ${r.pedidos}.` : ''}`, 'Cancelar venda', `/api/vendas/${r.id}/cancelar`, 'POST', true, () => setOk(`Venda ${r.numero} cancelada.`))} /> : <Vazio />}
              <SeparadorAcoes />
              <BotaoAcao icone={aberto(r) || r.status === 'rejeitada' ? Pencil : Eye} titulo={aberto(r) || r.status === 'rejeitada' ? 'Editar' : 'Consultar'} descricao="Abre a venda" onClick={() => abrir(r.id)} />
            </>
          ) : tipo === 'orcamento' ? (
            <>
              {aberto(r) ? <BotaoAcao icone={CheckCircle2} titulo="Aprovar" descricao="Gera um pedido com os mesmos itens" tom="verde" onClick={() => executar('Aprovar orçamento', `Aprovar o orçamento ${r.numero}? Será gerado um pedido com os mesmos itens e parcelas.`, 'Aprovar e gerar pedido', `/api/davs/${r.id}/aprovar`, 'POST', false, (p) => setOk(`Pedido ${p.numero} gerado.`))} /> : <Vazio />}
              {aberto(r) ? <BotaoAcao icone={XCircle} titulo="Recusar" descricao="O cliente não aceitou" onClick={() => executar('Recusar orçamento', `Marcar o orçamento ${r.numero} como recusado?`, 'Recusar', `/api/davs/${r.id}/recusar`)} /> : <Vazio />}
              <BotaoAcao icone={Copy} titulo="Duplicar" descricao="Novo orçamento com os mesmos dados" onClick={() => abrir(r.id, true)} />
              {aberto(r) ? <BotaoAcao icone={Ban} titulo="Cancelar" descricao="Cancela o orçamento" tom="perigo" onClick={() => executar('Cancelar orçamento', `Cancelar o orçamento ${r.numero}?`, 'Cancelar orçamento', `/api/davs/${r.id}/cancelar`, 'POST', true)} /> : <Vazio />}
              <SeparadorAcoes />
              <BotaoAcao icone={aberto(r) ? Pencil : Eye} titulo={aberto(r) ? 'Editar' : 'Consultar'} descricao="Abre o orçamento" onClick={() => abrir(r.id)} />
              {aberto(r) ? <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Apaga o orçamento (pede confirmação)" tom="perigo" onClick={() => executar('Excluir orçamento', `Excluir o orçamento ${r.numero}? Não dá para desfazer.`, 'Excluir', `/api/davs/${r.id}`, 'DELETE', true)} /> : <Vazio />}
            </>
          ) : (
            // Posições fixas: Duplicar, Cancelar | Editar/Consultar, Excluir (a que não vale vira espaço)
            <>
              <BotaoAcao icone={Copy} titulo="Duplicar" descricao="Novo pedido com os mesmos dados" onClick={() => abrir(r.id, true)} />
              {aberto(r) ? <BotaoAcao icone={Ban} titulo="Cancelar" descricao="Cancela o pedido" tom="perigo" onClick={() => executar('Cancelar pedido', `Cancelar o pedido ${r.numero}?`, 'Cancelar pedido', `/api/davs/${r.id}/cancelar`, 'POST', true)} /> : <Vazio />}
              <SeparadorAcoes />
              <BotaoAcao icone={aberto(r) ? Pencil : Eye} titulo={aberto(r) ? 'Editar' : 'Consultar'} descricao="Abre o pedido" onClick={() => abrir(r.id)} />
              {aberto(r) ? <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Apaga o pedido (pede confirmação)" tom="perigo" onClick={() => executar('Excluir pedido', `Excluir o pedido ${r.numero}? Não dá para desfazer.`, 'Excluir', `/api/davs/${r.id}`, 'DELETE', true)} /> : <Vazio />}
            </>
          )
        }
      />
      {confirma && <ConfirmDialog titulo={confirma.titulo} mensagem={confirma.mensagem} confirmar={confirma.rotulo} tom={confirma.perigo ? 'perigo' : 'normal'} onConfirmar={confirma.acao} onCancelar={() => setConfirma(null)} />}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {aviso && <AvisoErro tom="alerta" mensagem={aviso} onFechar={() => setAviso('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}

