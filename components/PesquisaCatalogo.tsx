import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ListFilter, Loader2, Search, X } from 'lucide-react';
import { INPUT_CLASS } from '@/components/FormCrm';
import { ListaCrm, type ColunaLista } from '@/components/ListaCrm';
import { Toggle } from '@/components/Toggle';
import { AvisoErro } from '@/components/AvisoErro';
import { api, dataBr, docBr, foneBr, moeda, qtd } from '@/lib/api';
import { useBusca } from '@/lib/useBusca';
import { gravarConfigLista, lerConfigListas } from '@/lib/config-listas-cliente';

/**
 * Pesquisa configurável pelo usuário (catálogo em server/pesquisas.ts):
 * - grid no ListaCrm: colunas, ordem, larguras e grade no menu da lista, gravados em "Salvar Configuração" (chave pesquisa_<tipo>);
 * - "Pesquisar em": campos usados na busca, gravados na hora (chave pesquisa_<tipo>_busca).
 * Clique destaca; duplo clique (ou setas + Enter) escolhe; Esc, X ou clique fora fecham.
 */
interface CampoCatalogo {
  key: string;
  label: string;
  formato?: 'moeda' | 'qtd' | 'imagem' | 'doc' | 'fone' | 'data' | 'simnao';
  alinhar?: 'texto' | 'numero' | 'centro';
  largura?: number;
  visivel: boolean;
  buscavel: boolean;
  buscaPadrao: boolean;
}

interface Props {
  tipo: 'produtos' | 'clientes' | 'transportadoras' | 'fornecedores';
  titulo: string;
  placeholder?: string;
  /** Filtros extras do catálogo (ex.: "servico=0") */
  filtros?: string;
  onEscolher: (linha: any) => void;
  onFechar: () => void;
}

const celula = (c: CampoCatalogo, v: any): React.ReactNode =>
  c.formato === 'imagem' ? (v ? <img src={v} alt="" loading="lazy" className="h-9 w-9 object-contain inline-block rounded" /> : null)
  : c.formato === 'moeda' ? moeda(v)
  : c.formato === 'qtd' ? qtd(v)
  : c.formato === 'doc' ? docBr(v)
  : c.formato === 'fone' ? foneBr(v)
  : c.formato === 'data' ? dataBr(v)
  : c.formato === 'simnao' ? (v == null ? '' : Number(v) ? 'Sim' : 'Não')
  : String(v ?? '');

export function PesquisaCatalogo({ tipo, titulo, placeholder, filtros, onEscolher, onFechar }: Props) {
  const [campos, setCampos] = useState<CampoCatalogo[]>([]);
  const [buscarEm, setBuscarEm] = useState<string[] | null>(null);
  const [abrirCampos, setAbrirCampos] = useState(false);
  const [destaque, setDestaque] = useState(0);
  const [erro, setErro] = useState('');
  const caixaCampos = useRef<HTMLDivElement>(null);
  const chaveBusca = `pesquisa_${tipo}_busca`;

  useEffect(() => {
    api<CampoCatalogo[]>(`/api/pesquisa/${tipo}/campos`).then(setCampos).catch((e) => setErro(e.message));
    lerConfigListas()
      .then((tudo) => Array.isArray(tudo[chaveBusca]) && setBuscarEm(tudo[chaveBusca]))
      .catch(() => {});
  }, [tipo, chaveBusca]);

  const pesquisaveis = campos.filter((c) => c.buscavel);
  const ativos = buscarEm?.filter((k) => pesquisaveis.some((c) => c.key === k)) ?? pesquisaveis.filter((c) => c.buscaPadrao).map((c) => c.key);
  // Só busca depois do catálogo: a URL muda quando os campos chegam e repetiria a consulta
  const url = campos.length ? `/api/pesquisa/${tipo}?${filtros ? filtros + '&' : ''}campos=${ativos.join(',')}` : null;
  const busca = useBusca<any>(url);
  const linhas = busca.itens;

  useEffect(() => setDestaque(0), [linhas]);

  // Enter antes de a busca do que foi digitado voltar escolhe a primeira linha quando ela chegar, não a da lista antiga
  const enterPendente = useRef(false);
  useEffect(() => {
    if (busca.carregando || !enterPendente.current) return;
    enterPendente.current = false;
    if (linhas[0]) onEscolher(linhas[0]);
  }, [busca.carregando, linhas, onEscolher]);

  // Esc fecha primeiro o que estiver aberto por cima (lista de campos, menu da lista), depois o modal
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (abrirCampos) return setAbrirCampos(false);
      if (!document.querySelector('[data-menu-lista]')) onFechar();
    };
    // captura: roda antes do listener do menu da lista, enquanto ele ainda está na tela
    window.addEventListener('keydown', tecla, true);
    return () => window.removeEventListener('keydown', tecla, true);
  }, [onFechar, abrirCampos]);

  useEffect(() => {
    if (!abrirCampos) return;
    const fora = (e: MouseEvent) => !caixaCampos.current?.contains(e.target as Node) && setAbrirCampos(false);
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, [abrirCampos]);

  const alternarCampo = async (key: string) => {
    const novos = ativos.includes(key) ? ativos.filter((k) => k !== key) : [...ativos, key];
    if (!novos.length) return setErro('Deixe pelo menos um campo para pesquisar.');
    setBuscarEm(novos);
    try {
      await gravarConfigLista(chaveBusca, novos);
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const colunas: ColunaLista<any>[] = campos.map((c) => ({ key: c.key, label: c.label, alinhar: c.alinhar, largura: c.largura, render: (l) => celula(c, l[c.key]) }));

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-stone-950/70 backdrop-blur-xs" onClick={onFechar} aria-hidden="true" />
      <div role="dialog" aria-modal="true" className="relative w-full max-w-5xl h-[85vh] bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl shadow-2xl z-10 p-5 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-stone-900 dark:text-stone-100">{titulo}</h3>
          <button type="button" title="Fechar" onClick={onFechar} className="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
            <input
              autoFocus
              type="text"
              placeholder={placeholder ?? ativos.map((k) => campos.find((c) => c.key === k)?.label).join(', ') + '…'}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                enterPendente.current = false;
                busca.buscar(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setDestaque((d) => Math.min(d + 1, linhas.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setDestaque((d) => Math.max(d - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (busca.carregando) enterPendente.current = true;
                  else if (linhas[destaque]) onEscolher(linhas[destaque]);
                }
              }}
              className={INPUT_CLASS + ' pl-8'}
            />
            {busca.carregando && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-stone-400" />}
          </div>
          <div ref={caixaCampos} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setAbrirCampos((v) => !v)}
              title="Pesquisar em"
              data-dica-desc={ativos.map((k) => campos.find((c) => c.key === k)?.label).join(', ')}
              className={`${INPUT_CLASS} campo-botao !w-auto flex items-center gap-1.5 cursor-pointer whitespace-nowrap`}
            >
              <ListFilter className="w-3.5 h-3.5 text-stone-400" /> Pesquisar em ({ativos.length})
            </button>
            {abrirCampos && (
              <div className="absolute right-0 top-full mt-1 z-30 w-56 py-1 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl">
                {pesquisaveis.map((c) => (
                  <div key={c.key} className="px-3 py-1.5">
                    <Toggle size="sm" checked={ativos.includes(c.key)} onChange={() => alternarCampo(c.key)} label={c.label} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="mt-3 flex-1 min-h-0 flex flex-col rounded-lg border border-stone-200 dark:border-stone-800 overflow-hidden">
          {campos.length > 0 && (
            <ListaCrm
              id={`pesquisa_${tipo}`}
              colunas={colunas}
              linhas={linhas}
              chave={(l) => l.id}
              carregando={busca.carregando}
              buscar={false}
              paginar={false}
              ordenavel={false}
              visiveisPadrao={campos.filter((c) => c.visivel).map((c) => c.key)}
              selecionada={linhas[destaque]?.id ?? null}
              onClique={(l) => setDestaque(linhas.indexOf(l))}
              onEditar={onEscolher}
              vazio="Nenhum resultado."
              className="flex-1"
            />
          )}
        </div>
        <p className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">Duplo clique ou setas e Enter para escolher; Esc fecha. Colunas e grade: menu ☰ da lista.</p>
      </div>
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>,
    document.body,
  );
}
