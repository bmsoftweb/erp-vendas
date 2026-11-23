import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import { TelaHeader } from '@/components/TelaHeader';
import { RodapeSistema } from '@/components/RodapeSistema';
import { AvisoErro } from '@/components/AvisoErro';

/**
 * Casca das telas logadas, como no Romaneio e no crmWeb: menu, cabeçalho e barra de status ficam aqui, uma vez só,
 * e não são refeitos ao trocar de opção. Cada tela desenha apenas o conteúdo; o título vem da rota.
 */

const TELAS: Record<string, { titulo: string; subtitulo: string; semCabecalho?: boolean }> = {
  '/orcamentos': { titulo: 'Orçamentos', subtitulo: 'Propostas ao cliente; aprovado, vira pedido' },
  '/pedidos': { titulo: 'Pedidos', subtitulo: 'Pedidos de venda (DAV) a faturar' },
  '/faturar': { titulo: 'Faturar pedidos', subtitulo: 'Junta pedidos do mesmo cliente, total ou em parte, numa venda' },
  '/vendas': { titulo: 'Vendas', subtitulo: 'Faturamento: cada venda vira uma nota' },
  '/naturezas': { titulo: 'Naturezas de operação', subtitulo: 'Documento fiscal, finalidade e CFOP de cada tipo de venda' },
  '/pessoas': { titulo: 'Pessoas', subtitulo: 'Clientes, fornecedores e transportadoras do grupo de empresas' },
  '/crm-pedidos': { titulo: 'Pedidos do CRM', subtitulo: 'Pedidos aprovados no CRM: recebidos como requisição externa, viram pedido de venda' },
  '/vendedores': { titulo: 'Vendedores', subtitulo: 'Quem vende: aparece nos orçamentos, pedidos e vendas' },
};

/** O botão de recarregar do cabeçalho chama o que a tela ativa registrou */
const RefreshCtx = createContext<{ registrar: (fn: (() => void) | null) => void }>({ registrar: () => {} });

/** A tela registra como se recarrega (o botão só aparece nas que registram) */
export function useRefreshDaTela(fn: () => void) {
  const { registrar } = useContext(RefreshCtx);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    registrar(() => ref.current());
    return () => registrar(null);
  }, [registrar]);
}

export const LayoutApp: React.FC = () => {
  const { pathname } = useLocation();
  const [empresa, setEmpresa] = useState<string | undefined>();
  const [nome, setNome] = useState('');
  const [refresh, setRefresh] = useState<(() => void) | null>(null);
  const registrar = useCallback((fn: (() => void) | null) => setRefresh(() => fn), []);

  useEffect(() => {
    fetch('/api/user')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (!u) return;
        setNome(u.userName || '');
        setEmpresa(u.empresaNome);
      })
      .catch(() => {});
  }, []);

  // Fila das NFC-e em contingência (PAF-NFC-e, Requisito III, II): enquanto o app está aberto, a cada minuto.
  // Na Vercel não há processo fixo; no servidor local o agendarContingencia também transmite sozinho.
  // NFC-e normal que passou do prazo de cancelar pede NF-e de estorno (Anexo 11, art. 106): aviso âmbar a cada minuto
  // enquanto o erp-nfe devolver estorno pendente (o servidor chama mesmo sem venda em contingência)
  const [estorno, setEstorno] = useState('');
  useEffect(() => {
    const rodar = () => void fetch('/api/nfce/contingencia', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => {
        if (!r) return;
        const lista: { numero: number; chave: string }[] = r.estornos ?? [];
        setEstorno(lista.length ? `Emita NF-e de estorno (Anexo 11, art. 106) para a(s) NFC-e ${lista.map((e) => `nº ${e.numero} (${e.chave})`).join(', ')}: a tentativa normal foi autorizada junto com a contingência e passou do prazo de cancelamento.` : '');
      })
      .catch(() => {});
    rodar();
    const id = setInterval(rodar, 60_000);
    return () => clearInterval(id);
  }, []);

  const tela = TELAS[pathname] ?? { titulo: '', subtitulo: '' };
  return (
    <RefreshCtx.Provider value={{ registrar }}>
      <div className="min-h-screen bg-elegant-bg font-sans text-elegant-text">
        <Sidebar userName={nome || 'Admin'} />
        <div className="lg:ml-[var(--larg-menu)] h-screen flex flex-col min-w-0 overflow-hidden">
          {!tela.semCabecalho && <TelaHeader titulo={tela.titulo} subtitulo={tela.subtitulo} empresaNome={empresa} onRefresh={refresh ?? undefined} />}
          <div className="flex-1 min-h-0 flex flex-col">
            <Outlet />
          </div>
          <RodapeSistema />
        </div>
      </div>
      {estorno && <AvisoErro mensagem={estorno} tom="alerta" onFechar={() => setEstorno('')} />}
    </RefreshCtx.Provider>
  );
};
