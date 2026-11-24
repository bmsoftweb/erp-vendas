import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Archive, Ban, Calculator, CheckCircle2, Copy, Eye, ExternalLink, FileCheck2, HandCoins, Minus, Pencil, Plus, Printer, Save, Search, Trash2, X, XCircle } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { TelaCheia, SecaoCrm, GradeCampos, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao, SeparadorAcoes, Vazio } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { PesquisaCatalogo } from '@/components/PesquisaCatalogo';
import { NumberField } from '@/components/NumberField';
import { DateField } from '@/components/DateField';
import { Toggle } from '@/components/Toggle';
import { api, dataBr, docBr, hojeIso, moeda, numDav, qtd } from '@/lib/api';
import { totais, totalItem } from '@/lib/totais';
import { ehVenda } from '@/lib/modelo';
import { FORMAS_PAGAMENTO, gerarParcelas, somaParcelas, somarDias } from '@/lib/parcelas';
import { mascaraDocumento } from '@/lib/documento';

type Tipo = 'orcamento' | 'pedido' | 'venda';
const NOME: Record<Tipo, string> = { orcamento: 'Orçamento', pedido: 'Pedido', venda: 'Venda' };
const STATUS_LISTA: Record<Tipo, string[]> = {
  orcamento: ['aberto', 'aprovado', 'recusado', 'baixado'],
  pedido: ['aberto', 'parcial', 'faturado', 'baixado'],
  venda: ['aberta', 'faturando', 'faturada', 'rejeitada', 'cancelada'],
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const DOC: Record<string, string> = { nfe: 'NF-e', nfce: 'NFC-e', nfse: 'NFS-e' };
/** Totais do /api/calcular do erp-nfe que vale mostrar */
const IMPOSTOS: [string, string][] = [['vICMS', 'ICMS'], ['vST', 'ICMS ST'], ['vFCP', 'FCP'], ['vIPI', 'IPI'], ['vPIS', 'PIS'], ['vCOFINS', 'COFINS'], ['vIBSUF', 'IBS UF'], ['vIBSMun', 'IBS Mun.'], ['vCBS', 'CBS'], ['vICMSUFDest', 'DIFAL UF destino']];

interface Item { pedido?: number; iat?: string | null; produto_id: number; descricao: string; unidade: string; quantidade: string | number; preco_unitario: string | number; valor_desconto: string | number; total?: string }
/** Na venda, cada pagamento leva o intermediador e, se houver, CNPJ transacional/UF e bandeira/autorização do cartão (PAF-NFC-e, Requisito XI) */
interface Parcela {
  vencimento: string; forma_pagamento: string; valor: string | number;
  intermediador_id?: number | string | ''; cnpj_pag?: string | null; uf_pag?: string | null; bandeira?: string | null; autorizacao?: string | null;
}
/** tBand da NF-e */
const BANDEIRAS: Record<string, string> = { '01': 'Visa', '02': 'Mastercard', '03': 'American Express', '04': 'Sorocred', '05': 'Diners', '06': 'Elo', '07': 'Hipercard', '08': 'Aura', '09': 'Cabal', '99': 'Outros' };
interface Dav {
  id?: number; numero?: number; status?: string; tipo?: Tipo; origem?: string;
  natureza_id: number | ''; pessoa_id: number | null; cliente?: string; cpf_cnpj?: string;
  vendedor_id: number | ''; condicao_pagamento_id: number | '';
  data_emissao: string; validade: string | null;
  modalidade_frete: number; transportadora_id: number | null; transportadora?: string;
  valor_frete: string | number; observacoes: string; informacoes_complementares: string;
  itens: Item[]; parcelas: Parcela[];
  /** Venda por marketplace/delivery: intermediador da transação (infIntermed) */
  intermediador_transacao_id?: number | '' | null;
  /** Pedido de pré-venda (PAF-NFC-e): a senha de 6 dígitos é gerada no servidor ao gravar */
  prevenda?: boolean; prevenda_senha?: string | null;
  /** Log de alteração de itens (registro D6 do PAF-NFC-e), só leitura */
  log?: { tipo: 'I' | 'A' | 'E'; item: number; descricao: string; unidade: string; quantidade: string; preco_unitario: string; usuario: string | null; quando: string }[];
}
const TIPO_LOG = { I: 'Inclusão', A: 'Alteração', E: 'Exclusão' };
interface Apoio {
  naturezas: { id: number; descricao: string; documento: string; cfop_estadual: string | null }[];
  condicoes: { id: number; nome: string; prazos: string; forma_pagamento: string }[];
  vendedores: { id: number; nome: string }[];
  /** Cadastro do erp-pdv: P pagamento, T transação */
  intermediadores: Intermediador[];
  vendedorPadrao: number | null; prevendaPadrao: boolean; naturezaPadrao: number | null; validadeDias: number;
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
  baixado: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
};
/** − e + dentro do campo Quantidade da grade de itens */
const BOTAO_QTD = 'absolute top-1/2 -translate-y-1/2 p-1 rounded text-stone-400 hover:text-stone-800 hover:bg-stone-200/70 dark:hover:text-stone-100 dark:hover:bg-stone-700/70 disabled:opacity-30 disabled:pointer-events-none cursor-pointer';
const FRETE: Record<number, string> = { 9: 'Sem frete', 0: 'Por conta do emitente (CIF)', 1: 'Por conta do destinatário (FOB)', 2: 'Por conta de terceiros', 3: 'Próprio do emitente', 4: 'Próprio do destinatário' };

/** Botão no visual de campo que abre a pesquisa */
interface Intermediador { id: number; codigo: string; tipo: 'P' | 'T'; nome_fantasia: string; cnpj: string }
const rotuloInter = (i: Intermediador) => `${i.codigo} · ${i.nome_fantasia} · ${mascaraDocumento(i.cnpj)}`;

/**
 * Intermediador pelo código, nome fantasia ou CNPJ (PAF-NFC-e, Requisito XI, I; roteiro do Ato DIAT 56/2026, Teste 7):
 * achou, mostra código · nome · CNPJ; a lista de sugestões do navegador filtra enquanto digita.
 */
function CampoIntermediador({ lista, valor, onChange, required, vazio, title }: {
  lista: Intermediador[]; valor: unknown; onChange: (id: number | null) => void; required?: boolean; vazio?: string; title?: string;
}) {
  const id = useId();
  const atual = lista.find((i) => i.id === Number(valor));
  /** null = mostra o escolhido */
  const [texto, setTexto] = useState<string | null>(null);
  const achar = (t: string) => {
    const s = t.trim().toLowerCase();
    const dig = t.replace(/\D/g, '');
    return lista.find((i) => rotuloInter(i).toLowerCase() === s || i.codigo === t.trim() || i.nome_fantasia.toLowerCase() === s || (dig.length === 14 && i.cnpj === dig));
  };
  return (
    <>
      <input
        list={id} required={required} value={texto ?? (atual ? rotuloInter(atual) : '')} placeholder={vazio} title={title}
        onChange={(e) => (setTexto(e.target.value), onChange(achar(e.target.value)?.id ?? null))}
        onFocus={(e) => e.target.select()} onBlur={() => setTexto(null)} className={INPUT_CLASS}
      />
      <datalist id={id}>{lista.map((i) => <option key={i.id} value={rotuloInter(i)} />)}</datalist>
    </>
  );
}

export const CampoPesquisa: React.FC<{ texto?: string; vazio: string; onAbrir: () => void; onLimpar?: () => void; obrigatorio?: boolean }> = ({ texto, vazio, onAbrir, onLimpar, obrigatorio }) => (
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
  /** Orçamento e pedido (DAV) com 10 dígitos; a venda fica como está */
  const num = (n: unknown) => (fem ? String(n ?? '') : numDav(n));
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
  // Baixa do DAV: o motivo é obrigatório (PAF-NFC-e de SC)
  const [baixa, setBaixa] = useState<{ r: any; motivo: string; recusa?: boolean } | null>(null);
  // Cancelamento da nota da venda: a justificativa vai para a SEFAZ (15 a 255 caracteres)
  const [cancelaNota, setCancelaNota] = useState<{ r: any; justificativa: string } | null>(null);
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
  // Vendas sem nota com pedido de mais de 180 dias (PAF-NFC-e, Requisito V, § 2º): aviso fixo até saírem
  const [vencidas, setVencidas] = useState<{ id: number; numero: number; status: string }[]>([]);
  useEffect(() => {
    if (tipo === 'venda') void api<typeof vencidas>('/api/vendas/dav-vencido').then(setVencidas).catch(() => setVencidas([]));
  }, [tipo, linhas]);
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
  // Contingência recusada também: o DANFE já saiu, só se corrige o que não muda o imposto (Anexo 11, art. 104, § 4º, I)
  const itensFixos = tipo === 'venda' && (form?.origem === 'pedido' || !!Number((form as any)?.contingencia));

  // Modelo da nota pelo cliente (PAF-NFC-e, Requisito IV): as naturezas de venda do outro modelo somem da lista;
  // a escolhida que deixa de servir é trocada pela única que sobra ou limpa
  const [modelo, setModelo] = useState<'nfe' | 'nfce' | null>(null);
  const comForm = !!form;
  const t = useMemo(() => totais(form?.itens ?? [], form?.valor_frete), [form?.itens, form?.valor_frete]);
  // R$ 200 mil ou mais é NF-e (Anexo 11, art. 96, § 7º): refaz a consulta só quando o total cruza o limite
  const acimaLimite = t.valor_total >= 200000;
  useEffect(() => {
    if (!comForm) return setModelo(null);
    api(`/api/modelo-nota?pessoa_id=${form?.pessoa_id ?? ''}&total=${t.valor_total}`).then((r) => setModelo(r.modelo), () => setModelo(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comForm, form?.pessoa_id, acimaLimite]);
  const filtrar = !!modelo && editavel && !itensFixos;
  const naturezas = (apoio?.naturezas ?? []).filter((n) => !filtrar || n.documento === 'nfse' || !ehVenda(n.cfop_estadual) || n.documento === modelo);
  useEffect(() => {
    if (!filtrar || !form) return;
    if (form.natureza_id !== '' && naturezas.some((n) => n.id === Number(form.natureza_id))) return;
    const vendas = naturezas.filter((n) => ehVenda(n.cfop_estadual) && n.documento === modelo);
    const nova = vendas.length === 1 ? vendas[0].id : '';
    if (nova !== form.natureza_id) muda('natureza_id', nova);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtrar, modelo, form?.natureza_id]);
  const somaParc = somaParcelas((form?.parcelas ?? []).map((p) => p.valor));


  const novo = () => {
    if (!apoio) return;
    const hoje = hojeIso();
    setForm({
      natureza_id: apoio.naturezaPadrao ?? (apoio.naturezas.length === 1 ? apoio.naturezas[0].id : ''),
      pessoa_id: null, vendedor_id: apoio.vendedorPadrao ?? (apoio.vendedores.length === 1 ? apoio.vendedores[0].id : ''),
      condicao_pagamento_id: '', data_emissao: hoje, validade: tipo === 'orcamento' ? somarDias(hoje, apoio.validadeDias) : null,
      modalidade_frete: 9, transportadora_id: null, valor_frete: 0, observacoes: '', informacoes_complementares: '', itens: [], parcelas: [],
      // Usuário de balcão (cadastro de usuários do erp-master): o pedido novo já nasce pré-venda
      prevenda: tipo === 'pedido' && apoio.prevendaPadrao,
    });
  };

  const abrir = async (id: number, copia = false) => {
    try {
      const d = await api(`${base}/${id}`);
      const dav: Dav = { ...d, prevenda: !!d.prevenda_senha, observacoes: d.observacoes ?? '', informacoes_complementares: d.informacoes_complementares ?? '', vendedor_id: d.vendedor_id ?? '', condicao_pagamento_id: d.condicao_pagamento_id ?? '' };
      if (copia) {
        const hoje = hojeIso();
        Object.assign(dav, { id: undefined, numero: undefined, status: undefined, origem: undefined, log: [], prevenda_senha: null, data_emissao: hoje, validade: tipo === 'orcamento' ? somarDias(hoje, apoio?.validadeDias ?? 7) : null, parcelas: [] });
      }
      setForm(dav);
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const muda = <K extends keyof Dav>(campo: K, valor: Dav[K]) => setForm((f) => (f ? { ...f, [campo]: valor } : f));
  const mudaItem = (i: number, campo: keyof Item, valor: string) =>
    setForm((f) => (f ? { ...f, itens: f.itens.map((it, k) => (k === i ? { ...it, [campo]: valor } : it)) } : f));
  // Requisito VIII, II-b do PAF-NFC-e: o operador pode informar o TOTAL do item e a quantidade sai dele,
  // (total + desconto) ÷ preço. O total digitado fica só enquanto o campo tem o foco; depois volta a ser o calculado.
  const mudaTotal = (i: number, valor: string) =>
    setForm((f) => {
      if (!f) return f;
      const it = f.itens[i];
      const preco = Number(it.preco_unitario);
      if (!(preco > 0)) return setAviso('Informe o preço do item antes do total.'), f;
      const quantidade = ((Number(valor) + Number(it.valor_desconto || 0)) / preco).toFixed(4);
      return { ...f, itens: f.itens.map((x, k) => (k === i ? { ...x, total: valor, quantidade } : x)) };
    });
  const fimTotal = (i: number) => setForm((f) => (f ? { ...f, itens: f.itens.map((x, k) => (k === i ? { ...x, total: undefined } : x)) } : f));
  const mudaParcela = (i: number, campo: keyof Parcela, valor: string) =>
    setForm((f) => (f ? { ...f, parcelas: f.parcelas.map((p, k) => (k === i ? { ...p, [campo]: valor } : p)) } : f));

  const interPag = apoio?.intermediadores.filter((i) => i.tipo === 'P') ?? [];
  const interTransacao = apoio?.intermediadores.filter((i) => i.tipo === 'T') ?? [];

  const gerar = () => {
    const c = apoio?.condicoes.find((x) => x.id === Number(form?.condicao_pagamento_id));
    if (!form) return;
    if (!t.valor_total) return setAviso('Inclua os itens antes de gerar as parcelas.');
    muda('parcelas', gerarParcelas(c?.prazos ?? '0', t.valor_total, form.data_emissao || hojeIso(), c?.forma_pagamento || 'Dinheiro'));
  };

  /** Resultado da emissão: autorizada, em contingência, rejeitada ou sem resposta */
  const avisarNota = (doc: string, n: any) =>
    n.situacao === 'autorizada' ? setOk(`${DOC[doc]} ${n.numero ?? ''} autorizada.`)
      : n.situacao === 'contingencia' ? setAviso(`${DOC[doc]} ${n.numero ?? ''} emitida em contingência (SEFAZ sem resposta). Imprima o DANFE; a autorização é pedida sozinha quando a SEFAZ voltar.`)
      : n.situacao === 'rejeitada' || n.situacao === 'denegada' ? setErro(`${DOC[doc]} ${n.situacao}: ${n.motivo ?? 'sem motivo'}. Corrija a venda e emita de novo.`)
      : setAviso(`A ${DOC[doc]} foi enviada e ainda não tem resposta. Use “Emitir nota” de novo para consultar.`);

  /**
   * Venda de NF-e/NFC-e: só "Concluir e emitir", que grava e emite no mesmo clique (PAF-NFC-e, Requisito III). Sem
   * "Salvar" de rascunho: venda com pagamento gravada sem DF-e é a informação diversa do Requisito I. Quem quer
   * guardar para depois faz pedido (DAV)
   */
  const conclui = tipo === 'venda' && ['nfe', 'nfce'].includes(natureza?.documento ?? '');
  const salvar = async (emitirNota = false) => {
    if (!form) return;
    setSalvando(true);
    try {
      const corpo = { ...form, tipo };
      const r = form.id ? await api(`${base}/${form.id}`, 'PUT', corpo) : await api(base, 'POST', corpo);
      if (emitirNota && natureza) {
        const id = form.id ?? r.id;
        setForm(null);
        try {
          avisarNota(natureza.documento, await api(`/api/vendas/${id}/emitir`, 'POST'));
        } catch (e: any) {
          setErro(`Venda ${form.numero ?? r.numero} gravada, mas a nota não saiu: ${e.message}`);
        }
        await carregar();
        return;
      }
      setForm(null);
      setAviso('');
      await carregar();
      setOk(form.id ? `${nome} ${num(form.numero)} ${g('gravado', 'gravada')}.` : `${nome} ${num(r.numero)} ${g('incluído', 'incluída')}.`);
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

  /** Impressão do DAV (orçamento/pedido) numa aba nova */
  const imprimir = (r: any) => {
    if (!window.open(`/imprimir-dav/${r.id}`, '_blank')) setAviso('O navegador bloqueou a aba da impressão: libere as janelas pop-up deste endereço.');
  };

  /** DANFE da nota autorizada numa aba nova (aberta já no clique, para o navegador não bloquear) */
  // NFC-e de contingência (tpEmis 9): 2 vias, a 2ª do estabelecimento (Anexo 11, art. 104, § 6º)
  const danfe = (r: any) => (Number(r.contingencia) ? ['', '?via=estabelecimento'] : ['']).forEach(async (via) => {
    const aba = window.open('', '_blank');
    try {
      const resp = await fetch(`/api/vendas/${r.id}/danfe${via}`);
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Falha ao gerar o DANFE.');
      const url = URL.createObjectURL(await resp.blob());
      if (aba) aba.location.href = url;
      else if (!window.open(url, '_blank')) setAviso('O navegador bloqueou a aba do DANFE: libere as janelas pop-up deste endereço.');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      aba?.close();
      setErro(e.message);
    }
  });

  /** Emite (ou retoma) a nota da venda e diz o que aconteceu */
  const emitir = (r: any) =>
    executar(`Emitir ${DOC[r.documento]}`, `Emitir a ${DOC[r.documento]} da venda ${r.numero} (${moeda(r.valor_total)})? Ela é transmitida no ambiente configurado no ${r.documento === 'nfse' ? 'erp-nfs' : 'erp-nfe'}.`, 'Emitir nota', `/api/vendas/${r.id}/emitir`, 'POST', false, (n) => avisarNota(r.documento, n));

  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  if (form) {
    const titulo = form.id ? `${nome} ${num(form.numero)}` : `${g('Novo', 'Nova')} ${nome.toLowerCase()}`;
    const difParcelas = form.parcelas.length ? Math.round((t.valor_total - somaParc) * 100) / 100 : 0;
    return (
      <>
        <TelaCheia
          larga
          rodape={form.id ? `${titulo} • ${form.status}` : 'Inclusão'}
          onVoltar={() => setForm(null)}
          rotuloVoltar={editavel ? 'Cancelar' : 'Voltar para a Lista'}
          onSubmit={editavel ? () => void salvar(conclui) : undefined}
          rotuloPrincipal={conclui ? 'Concluir e emitir' : 'Salvar'}
          iconePrincipal={conclui ? <FileCheck2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          salvando={salvando}
          acoes={<>
            {tipo === 'venda' && form.id && natureza?.documento !== 'nfse' && (
            <button type="button" onClick={abrirNfe} title="Abre o erp-nfe já na nota desta venda" className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-xs font-semibold text-stone-600 dark:text-stone-300 border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer">
              <ExternalLink className="w-3.5 h-3.5" /> <span>NFe</span>
            </button>
            )}
          </>}
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
                    {naturezas.map((n) => <option key={n.id} value={n.id}>{n.descricao}</option>)}
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
                  <input disabled value={dataBr(form.data_emissao)} title="Data do servidor na inclusão; não muda depois" className={INPUT_CLASS} />
                </Campo>
                {tipo === 'orcamento' && (
                  <Campo rotulo="Validade">
                    <DateField value={form.validade ?? ''} onChange={(v) => muda('validade', v)} />
                  </Campo>
                )}
                {tipo === 'pedido' && (
                  <Campo rotulo="Pré-venda">
                    <div className="h-[34px] flex items-center gap-3">
                      <Toggle checked={!!form.prevenda} onChange={(v) => muda('prevenda', v)} title="O consumidor recebe uma senha e paga no caixa (Faturar pedidos)" />
                      {form.prevenda && <span className="text-xs whitespace-nowrap">{form.prevenda_senha ? <>Senha <b className="font-mono">{form.prevenda_senha}</b></> : 'Senha ao salvar'}</span>}
                    </div>
                  </Campo>
                )}
                <Campo rotulo="Condição de pagamento">
                  <select value={form.condicao_pagamento_id} onChange={(e) => muda('condicao_pagamento_id', Number(e.target.value) || '')} className={INPUT_CLASS}>
                    <option value="">—</option>
                    {apoio?.condicoes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                  </select>
                </Campo>
                {tipo === 'venda' && interTransacao.length > 0 && (
                  <Campo rotulo="Intermediador da transação">
                    <CampoIntermediador lista={interTransacao} valor={form.intermediador_transacao_id} onChange={(v) => muda('intermediador_transacao_id', v)} vazio="Venda própria (código, nome ou CNPJ)" title="Marketplace ou delivery por onde a venda entrou (vai na nota como intermediador)" />
                  </Campo>
                )}
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
                      <th className="w-36 text-right">Quantidade</th>
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
                        <td title={it.pedido ? `Pedido ${numDav(it.pedido)}` : undefined}><input value={it.descricao} disabled title="Descrição do cadastro do produto" className={INPUT_CLASS} /></td>
                        <td className="text-center">{it.unidade}</td>
                        <td className="relative">
                          <NumberField value={it.quantidade} scale={4} onChange={(v) => mudaItem(i, 'quantidade', v)} className={INPUT_CLASS + (editavel && !itensFixos ? ' !pl-7 !pr-7' : '')} />
                          {editavel && !itensFixos && (
                            <>
                              <button type="button" tabIndex={-1} title="Diminuir 1" disabled={Number(it.quantidade) <= 1} onClick={() => mudaItem(i, 'quantidade', (Number(it.quantidade) - 1).toFixed(4))} className={BOTAO_QTD + ' left-1'}>
                                <Minus className="w-3 h-3" />
                              </button>
                              <button type="button" tabIndex={-1} title="Aumentar 1" onClick={() => mudaItem(i, 'quantidade', (Number(it.quantidade) + 1).toFixed(4))} className={BOTAO_QTD + ' right-1'}>
                                <Plus className="w-3 h-3" />
                              </button>
                            </>
                          )}
                        </td>
                        <td><NumberField value={it.preco_unitario} scale={2} onChange={(v) => mudaItem(i, 'preco_unitario', v)} className={INPUT_CLASS} /></td>
                        <td><NumberField value={it.valor_desconto} scale={2} onChange={(v) => mudaItem(i, 'valor_desconto', v)} className={INPUT_CLASS} /></td>
                        {editavel && !itensFixos ? (
                          <td onBlur={() => fimTotal(i)}><NumberField value={it.total ?? totalItem(it)} scale={2} onChange={(v) => mudaTotal(i, v)} className={INPUT_CLASS + ' font-semibold'} /></td>
                        ) : (
                          <td className="text-right font-semibold tabular-nums">{moeda(totalItem(it))}</td>
                        )}
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

            {!!form.log?.length && (
              <SecaoCrm titulo="Alterações dos itens">
                <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
                  <table className="w-full text-xs border-collapse">
                    <thead className="bg-stone-50 dark:bg-stone-950 text-stone-600 dark:text-stone-300">
                      <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-semibold [&>th]:border-b [&>th]:border-r [&>th]:border-stone-200 dark:[&>th]:border-stone-800">
                        <th className="w-36 text-center">Data e hora</th>
                        <th className="w-24 text-left">Tipo</th>
                        <th className="w-10 text-right">#</th>
                        <th className="text-left">Descrição</th>
                        <th className="w-28 text-right">Quantidade</th>
                        <th className="w-28 text-right">Preço</th>
                        <th className="w-32 text-left">Usuário</th>
                      </tr>
                    </thead>
                    <tbody>
                      {form.log.map((l, k) => (
                        <tr key={k} className="[&>td]:px-2 [&>td]:py-1 [&>td]:border-b [&>td]:border-r [&>td]:border-stone-200 dark:[&>td]:border-stone-800">
                          <td className="text-center tabular-nums">{l.quando}</td>
                          <td>{TIPO_LOG[l.tipo]}</td>
                          <td className="text-right">{l.item}</td>
                          <td>{l.descricao}</td>
                          <td className="text-right tabular-nums">{qtd(l.quantidade)} {l.unidade}</td>
                          <td className="text-right tabular-nums">{moeda(l.preco_unitario)}</td>
                          <td>{l.usuario ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-[11px] text-stone-500">Em alteração e exclusão, quantidade e preço são os de antes da mudança.</p>
              </SecaoCrm>
            )}

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
                <div className={`overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 ${tipo === 'venda' ? '' : 'max-w-2xl'}`}>
                  <table className={`planilha w-full text-xs border-collapse ${tipo === 'venda' ? 'min-w-[64rem]' : ''}`}>
                    <thead className="bg-stone-50 dark:bg-stone-950 text-stone-600 dark:text-stone-300">
                      <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:font-semibold [&>th]:border-b [&>th]:border-r [&>th]:border-stone-200 dark:[&>th]:border-stone-800">
                        <th className="w-10 text-right">#</th><th className="w-40 text-center">Vencimento</th><th className="min-w-40 text-left">Forma</th><th className="w-32 text-right">Valor</th>
                        {tipo === 'venda' && <><th className="min-w-52 text-left">Intermediador</th><th className="w-36 text-left">Bandeira</th><th className="w-36 text-left">Autorização</th><th className="w-44 text-left">CNPJ transacional</th><th className="w-16 text-left">UF</th></>}
                        {editavel && <th className="w-10" />}
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
                          {tipo === 'venda' && (() => {
                            const cartao = p.forma_pagamento.startsWith('Cartão');
                            return (
                              <>
                                <td>
                                  <CampoIntermediador required={p.forma_pagamento !== 'Sem pagamento'} lista={interPag} valor={p.intermediador_id} onChange={(v) => mudaParcela(i, 'intermediador_id', v == null ? '' : String(v))} vazio="Código, nome ou CNPJ" title="Quem processou o pagamento (cadastro de intermediadores do erp-pdv)" />
                                </td>
                                <td>
                                  {cartao && (
                                    <select value={p.bandeira ?? ''} onChange={(e) => mudaParcela(i, 'bandeira', e.target.value)} className={INPUT_CLASS}>
                                      <option value="">—</option>
                                      {Object.entries(BANDEIRAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                    </select>
                                  )}
                                </td>
                                <td>{cartao && <input value={p.autorizacao ?? ''} maxLength={128} onChange={(e) => mudaParcela(i, 'autorizacao', e.target.value)} onFocus={(e) => e.target.select()} className={INPUT_CLASS} />}</td>
                                <td><input value={mascaraDocumento(p.cnpj_pag)} inputMode="numeric" onChange={(e) => mudaParcela(i, 'cnpj_pag', e.target.value.replace(/\D/g, '').slice(0, 14))} onFocus={(e) => e.target.select()} title="CNPJ de quem recebeu o pagamento, quando não é o emitente (opcional)" className={INPUT_CLASS} /></td>
                                <td><input value={p.uf_pag ?? ''} maxLength={2} onChange={(e) => mudaParcela(i, 'uf_pag', e.target.value.replace(/[^a-z]/gi, '').toUpperCase())} onFocus={(e) => e.target.select()} className={INPUT_CLASS} /></td>
                              </>
                            );
                          })()}
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
              {(() => {
                // Venda: o que passa do total é troco, se sair do dinheiro (lerDav confere de novo)
                const dinheiro = somaParcelas(form.parcelas.filter((p) => p.forma_pagamento === 'Dinheiro').map((p) => p.valor));
                if (tipo === 'venda' && difParcelas < 0 && -difParcelas < dinheiro)
                  return <p className="mt-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">Troco: {moeda(-difParcelas)} <span className="text-xs font-normal text-stone-500">(pago {moeda(somaParc)} para o total de {moeda(t.valor_total)})</span></p>;
                if (difParcelas > 0) return <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">As parcelas somam {moeda(somaParc)}; faltam {moeda(difParcelas)} para o total de {moeda(t.valor_total)}.</p>;
                if (difParcelas < 0)
                  return <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">As parcelas somam {moeda(somaParc)}; passam {moeda(-difParcelas)} do total de {moeda(t.valor_total)}.{tipo === 'venda' && ' Troco só sai de pagamento em dinheiro maior que o troco.'}</p>;
                return null;
              })()}
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
          <PesquisaCatalogo
            tipo="produtos"
            titulo={natureza?.documento === 'nfse' ? 'Adicionar serviço' : 'Adicionar produto'}
            filtros={`servico=${natureza?.documento === 'nfse' ? 1 : 0}`}
            onEscolher={(p) => {
              setPesquisa(null);
              muda('itens', [...form.itens, { produto_id: p.id, iat: p.iat, descricao: p.nome, unidade: p.unidade, quantidade: 1, preco_unitario: Number(p.preco_venda || 0), valor_desconto: 0 }]);
            }}
            onFechar={() => setPesquisa(null)}
          />
        )}
        {(pesquisa === 'cliente' || pesquisa === 'transportadora') && (
          <PesquisaCatalogo
            key={pesquisa}
            tipo={pesquisa === 'cliente' ? 'clientes' : 'transportadoras'}
            titulo={pesquisa === 'cliente' ? 'Escolher cliente' : 'Escolher transportadora'}
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
      {vencidas.length > 0 && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {vencidas.length === 1 ? 'A venda' : 'As vendas'}{' '}
          {vencidas.map((v, i) => (
            <span key={v.id}>{i > 0 && ', '}<button type="button" onClick={() => abrir(v.id)} className="font-semibold underline cursor-pointer">{v.numero}</button> ({v.status})</span>
          ))}{' '}
          {vencidas.length === 1 ? 'tem pedido' : 'têm pedidos'} de mais de 180 dias sem nota (PAF-NFC-e, Requisito V, § 2º). A rotina diária tenta emitir; se não sair, corrija e emita.
        </div>
      )}
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
          { key: 'numero', label: 'Número', alinhar: 'numero', largura: fem ? 90 : 110, render: (r) => num(r.numero) },
          { key: 'data_emissao', label: 'Data', alinhar: 'centro', largura: 100, render: (r) => dataBr(r.data_emissao) },
          ...(tipo === 'orcamento' ? [{ key: 'validade', label: 'Validade', alinhar: 'centro' as const, largura: 100, render: (r: any) => dataBr(r.validade) }] : []),
          { key: 'cliente', label: 'Cliente', largura: 240, render: (r) => r.cliente ?? <span className="text-stone-400">Consumidor</span> },
          { key: 'natureza', label: 'Natureza', largura: 160 },
          ...(tipo === 'venda' ? [
            { key: 'documento', label: 'Documento', alinhar: 'centro' as const, largura: 90, render: (r: any) => DOC[r.documento] ?? '' },
            { key: 'numero_nota', label: 'Nº nota', alinhar: 'numero' as const, largura: 100, render: (r: any) => r.numero_nota ?? '' },
            // Venda do erp-vendas não passa por um caixa do PDV (pdv_caixas): o caixa é quem faturou a NFC-e
            { key: 'operador', label: 'Caixa', largura: 130, render: (r: any) => (r.documento === 'nfce' ? r.operador ?? '' : '') },
          ] : []),
          { key: 'vendedor', label: 'Vendedor', largura: 140 },
          { key: 'valor_total', label: 'Total', alinhar: 'numero', largura: 110, render: (r) => moeda(r.valor_total) },
          { key: 'status', label: 'Situação', alinhar: 'centro', largura: fem ? 190 : 100, render: (r) => (
            <span className="inline-flex items-center gap-1">
              <span title={r.baixa_motivo ? `Motivo da ${r.status === 'recusado' ? 'recusa' : 'baixa'}: ${r.baixa_motivo}` : undefined} className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS[r.status] ?? ''}`}>{cap(r.status)}</span>
              {r.situacao_nota === 'contingencia' && <span title="NFC-e emitida em contingência: aguardando a autorização da SEFAZ, pedida sozinha a cada minuto" className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">Contingência</span>}
            </span>
          ) },
          tipo === 'orcamento' ? { key: 'pedido_numero', label: 'Pedido', alinhar: 'numero' as const, largura: 110, render: (r: any) => numDav(r.pedido_numero) }
            : tipo === 'pedido' ? { key: 'orcamento_numero', label: 'Orçamento', alinhar: 'numero' as const, largura: 110, render: (r: any) => numDav(r.orcamento_numero) }
            : { key: 'pedidos', label: 'Pedidos', largura: 110 },
          ...(tipo === 'pedido' ? [{ key: 'prevenda_senha', label: 'Senha pré-venda', alinhar: 'centro' as const, largura: 120, render: (r: any) => r.prevenda_senha && <span className="font-mono">{r.prevenda_senha}</span> }] : []),
        ]}
        rodape={(k) => (k === 'valor_total' ? <b>{moeda(linhas.filter((r) => !['baixado', 'cancelada', 'recusado'].includes(r.status)).reduce((s, r) => s + Number(r.valor_total), 0))}</b> : null)}
        acoes={(r) =>
          tipo === 'venda' ? (
            // Posições fixas: Emitir ou Imprimir DANFE (nunca juntos), Cancelar ou EConf (nunca juntos), Cancelar nota | Editar/Consultar
            <>
              {['aberta', 'rejeitada', 'faturando'].includes(r.status) ? <BotaoAcao icone={FileCheck2} titulo="Emitir nota" descricao={`Emite a ${DOC[r.documento]} pelo ${r.documento === 'nfse' ? 'erp-nfs' : 'erp-nfe'} (pede confirmação)`} tom="verde" onClick={() => emitir(r)} />
                : r.status === 'faturada' && r.documento !== 'nfse' ? <BotaoAcao icone={Printer} titulo="Imprimir DANFE" descricao={`Abre o DANFE da ${DOC[r.documento]} em PDF numa aba nova`} onClick={() => danfe(r)} />
                : <Vazio />}
              {aberto(r) ? <BotaoAcao icone={Ban} titulo="Cancelar" descricao="Cancela a venda sem nota; o saldo volta aos pedidos" tom="perigo" onClick={() => executar('Cancelar venda', `Cancelar a venda ${r.numero}?${r.pedidos ? ` Os itens voltam a ficar a faturar no(s) pedido(s) ${r.pedidos}.` : ''}`, 'Cancelar venda', `/api/vendas/${r.id}/cancelar`, 'POST', true, () => setOk(`Venda ${r.numero} cancelada.`))} />
                : r.status === 'faturada' && r.situacao_nota === 'autorizada' ? <BotaoAcao icone={HandCoins} titulo="Conciliação financeira" descricao={`Envia à SEFAZ o evento EConf com os pagamentos já vencidos da ${DOC[r.documento]}`} onClick={() => executar('Conciliação financeira', `Enviar a conciliação financeira (EConf) dos pagamentos já vencidos da ${DOC[r.documento]} da venda ${r.numero}?`, 'Enviar EConf', `/api/vendas/${r.id}/econf`, 'POST', false, (x) => setOk(`EConf registrado: ${x.motivo}`))} />
                : <Vazio />}
              {r.status === 'faturada' && r.documento !== 'nfse' && ['autorizada', 'cancelada'].includes(r.situacao_nota)
                ? <BotaoAcao icone={XCircle} titulo="Cancelar nota" descricao={`Cancela a ${DOC[r.documento]} na SEFAZ (pede a justificativa); a venda fica cancelada e os itens voltam aos pedidos e ao estoque`} tom="perigo" onClick={() => setCancelaNota({ r, justificativa: '' })} />
                : <Vazio />}
              <SeparadorAcoes />
              <BotaoAcao icone={aberto(r) || r.status === 'rejeitada' ? Pencil : Eye} titulo={aberto(r) || r.status === 'rejeitada' ? 'Editar' : 'Consultar'} descricao="Abre a venda" onClick={() => abrir(r.id)} />
            </>
          ) : tipo === 'orcamento' ? (
            <>
              {aberto(r) ? <BotaoAcao icone={CheckCircle2} titulo="Aprovar" descricao="Gera um pedido com os mesmos itens" tom="verde" onClick={() => executar('Aprovar orçamento', `Aprovar o orçamento ${num(r.numero)}? Será gerado um pedido com os mesmos itens e parcelas.`, 'Aprovar e gerar pedido', `/api/davs/${r.id}/aprovar`, 'POST', false, (p) => setOk(`Pedido ${num(p.numero)} gerado.`))} /> : <Vazio />}
              {aberto(r) ? <BotaoAcao icone={XCircle} titulo="Recusar" descricao="O cliente não aceitou" onClick={() => setBaixa({ r, motivo: '', recusa: true })} /> : <Vazio />}
              {Number(r.com_nota) ? <Vazio /> : <BotaoAcao icone={Printer} titulo="Imprimir" descricao="Abre o orçamento para imprimir numa aba nova (com nota do pedido gerado não se reimprime)" onClick={() => imprimir(r)} />}
              {Number(r.com_nota) ? <Vazio /> : <BotaoAcao icone={Copy} titulo="Duplicar" descricao="Novo orçamento com os mesmos dados (com nota não se gera de novo)" onClick={() => abrir(r.id, true)} />}
              {aberto(r) ? <BotaoAcao icone={Archive} titulo="Baixar" descricao="Encerra o orçamento sem venda; ele continua na lista como baixado" tom="perigo" onClick={() => setBaixa({ r, motivo: '' })} /> : <Vazio />}
              <SeparadorAcoes />
              <BotaoAcao icone={aberto(r) ? Pencil : Eye} titulo={aberto(r) ? 'Editar' : 'Consultar'} descricao="Abre o orçamento" onClick={() => abrir(r.id)} />
            </>
          ) : (
            // Posições fixas: Imprimir, Duplicar, Baixar | Editar/Consultar (a que não vale vira espaço). DAV não se exclui (PAF-NFC-e)
            <>
              {Number(r.com_nota) ? <Vazio /> : <BotaoAcao icone={Printer} titulo="Imprimir" descricao="Abre o pedido para imprimir numa aba nova (com nota autorizada não se reimprime)" onClick={() => imprimir(r)} />}
              {Number(r.com_nota) ? <Vazio /> : <BotaoAcao icone={Copy} titulo="Duplicar" descricao="Novo pedido com os mesmos dados (com nota não se gera de novo: roteiro, Teste 32)" onClick={() => abrir(r.id, true)} />}
              {aberto(r) ? <BotaoAcao icone={Archive} titulo="Baixar" descricao="Encerra o pedido sem venda; ele continua na lista como baixado" tom="perigo" onClick={() => setBaixa({ r, motivo: '' })} /> : <Vazio />}
              <SeparadorAcoes />
              <BotaoAcao icone={aberto(r) ? Pencil : Eye} titulo={aberto(r) ? 'Editar' : 'Consultar'} descricao="Abre o pedido" onClick={() => abrir(r.id)} />
            </>
          )
        }
      />
      {confirma && <ConfirmDialog titulo={confirma.titulo} mensagem={confirma.mensagem} confirmar={confirma.rotulo} tom={confirma.perigo ? 'perigo' : 'normal'} onConfirmar={confirma.acao} onCancelar={() => setConfirma(null)} />}
      {baixa && (
        <ConfirmDialog
          titulo={baixa.recusa ? 'Recusar orçamento' : `Baixar ${NOME[tipo].toLowerCase()}`}
          mensagem={baixa.recusa
            ? `Marcar o orçamento ${num(baixa.r.numero)} como recusado? Ele fica na lista e não pode mais ser alterado.`
            : `Baixar o ${NOME[tipo].toLowerCase()} ${num(baixa.r.numero)}? Ele fica na lista como baixado e não pode mais ser alterado.`}
          confirmar={baixa.recusa ? 'Recusar' : 'Baixar'}
          onConfirmar={async () => {
            if (!baixa.motivo.trim()) throw new Error(`Informe o motivo da ${baixa.recusa ? 'recusa' : 'baixa'}.`);
            await api(`/api/davs/${baixa.r.id}/${baixa.recusa ? 'recusar' : 'baixar'}`, 'POST', { motivo: baixa.motivo.trim() });
            setBaixa(null);
            setOk(`${NOME[tipo]} ${num(baixa.r.numero)} ${baixa.recusa ? 'recusado' : 'baixado'}.`);
            await carregar();
          }}
          onCancelar={() => setBaixa(null)}
        >
          <Campo rotulo={baixa.recusa ? 'Motivo da recusa' : 'Motivo da baixa'}>
            <input autoFocus required maxLength={200} value={baixa.motivo} onFocus={(e) => e.target.select()} onChange={(e) => setBaixa({ ...baixa, motivo: e.target.value })} className={INPUT_CLASS} />
          </Campo>
        </ConfirmDialog>
      )}
      {cancelaNota && (
        <ConfirmDialog
          titulo={`Cancelar ${DOC[cancelaNota.r.documento]}`}
          mensagem={cancelaNota.r.situacao_nota === 'cancelada'
            ? `A ${DOC[cancelaNota.r.documento]} da venda ${cancelaNota.r.numero} já foi cancelada no erp-nfe. Marcar a venda como cancelada? Os itens voltam aos pedidos e ao estoque.`
            : `Cancelar a ${DOC[cancelaNota.r.documento]} da venda ${cancelaNota.r.numero} (${moeda(cancelaNota.r.valor_total)}) na SEFAZ? Não tem volta. Prazo: ${cancelaNota.r.documento === 'nfce' ? '30 minutos' : '24 horas'} da autorização.`}
          confirmar="Cancelar nota"
          tom="perigo"
          onConfirmar={async () => {
            const { r, justificativa } = cancelaNota;
            if (r.situacao_nota !== 'cancelada' && justificativa.trim().length < 15) throw new Error('A justificativa precisa ter ao menos 15 caracteres.');
            const x = await api(`/api/vendas/${r.id}/cancelar-nota`, 'POST', { justificativa: justificativa.trim() });
            setCancelaNota(null);
            setOk(`Venda ${r.numero} cancelada: ${x.motivo}.`);
            await carregar();
          }}
          onCancelar={() => setCancelaNota(null)}
        >
          {cancelaNota.r.situacao_nota !== 'cancelada' && (
            <Campo rotulo="Justificativa (15 a 255 caracteres)">
              <input autoFocus required maxLength={255} value={cancelaNota.justificativa} onFocus={(e) => e.target.select()} onChange={(e) => setCancelaNota({ ...cancelaNota, justificativa: e.target.value })} className={INPUT_CLASS} />
            </Campo>
          )}
        </ConfirmDialog>
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {aviso && <AvisoErro tom="alerta" mensagem={aviso} onFechar={() => setAviso('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}

