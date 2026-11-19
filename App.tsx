import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Login from './app/page';
import { LayoutApp } from '@/components/LayoutApp';
import TelaDav from './app/davs/TelaDav';
import Naturezas from './app/naturezas/page';
import Faturar from './app/faturar/page';

/** Uma rota por tela */
export const App: React.FC = () => (
  <Routes>
    <Route path="/" element={<Login />} />
    <Route element={<LayoutApp />}>
      <Route path="/orcamentos" element={<TelaDav tipo="orcamento" />} />
      <Route path="/pedidos" element={<TelaDav tipo="pedido" />} />
      <Route path="/faturar" element={<Faturar />} />
      <Route path="/vendas" element={<TelaDav tipo="venda" />} />
      <Route path="/naturezas" element={<Naturezas />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);
