import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import { TelaHeader } from '@/components/TelaHeader';
import { RodapeSistema } from '@/components/RodapeSistema';

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
    </RefreshCtx.Provider>
  );
};
