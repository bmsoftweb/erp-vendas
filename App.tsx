import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Login from './app/page';
import { LayoutApp } from '@/components/LayoutApp';
import TelaDav from './app/davs/TelaDav';
import ImprimirDav from './app/davs/ImprimirDav';
import Naturezas from './app/naturezas/page';
import Vendedores from './app/vendedores/page';
import Pessoas from './app/pessoas/page';
import Faturar from './app/faturar/page';
import PedidosCrm from './app/crm-pedidos/page';

/** Uma rota por tela */
export const App: React.FC = () => (
  <Routes>
    <Route path="/" element={<Login />} />
    {/* Impressão do DAV em aba própria, sem o menu do app */}
    <Route path="/imprimir-dav/:id" element={<ImprimirDav />} />
    <Route element={<LayoutApp />}>
      <Route path="/orcamentos" element={<TelaDav tipo="orcamento" />} />
      <Route path="/pedidos" element={<TelaDav tipo="pedido" />} />
      <Route path="/faturar" element={<Faturar />} />
      <Route path="/vendas" element={<TelaDav tipo="venda" />} />
      <Route path="/naturezas" element={<Naturezas />} />
      <Route path="/vendedores" element={<Vendedores />} />
      <Route path="/pessoas" element={<Pessoas />} />
      <Route path="/crm-pedidos" element={<PedidosCrm />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);
