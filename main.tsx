import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './app/globals.css';
import '@/lib/origemMaster'; // antes das telas: guarda a marca ?master=1 antes que o roteamento troque o endereço
import { ThemeProvider } from '@/context/ThemeContext';
import { App } from './App';
import { Dica } from './components/Dica';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <App />
        <Dica />
        {/* PAF único: o Menu Fiscal fica no caixa (erp-pdv); aviso fixo por cima dos modais (Requisito VI, § 1º) */}
        <p className="fixed bottom-1 right-2 z-[999] text-[10px] font-black tracking-widest text-stone-400 pointer-events-none print:hidden">MENU FISCAL INACESSÍVEL NESTA TELA</p>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
