import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Pesquisa no servidor enquanto digita (a última resposta vence). Mudou a URL, repete o último termo.
 * carregando já liga ao digitar (durante a espera de 250 ms): a lista na tela ainda é a da busca anterior.
 */
export function useBusca<T>(url: string | null) {
  const [itens, setItens] = useState<T[]>([]);
  const [carregando, setCarregando] = useState(false);
  const seq = useRef(0);
  const ultimo = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const buscar = useCallback((termo: string) => {
    if (!url) return;
    ultimo.current = termo;
    clearTimeout(timer.current);
    const n = ++seq.current;
    setCarregando(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await api<T[]>(`${url}${url.includes('?') ? '&' : '?'}busca=${encodeURIComponent(termo)}`);
        if (n === seq.current) setItens(r);
      } finally {
        if (n === seq.current) setCarregando(false);
      }
    }, 250);
  }, [url]);
  useEffect(() => {
    // URL nula = pesquisa fechada: a próxima abre sem termo
    if (url) buscar(ultimo.current);
    else ultimo.current = '';
  }, [url, buscar]);
  return { itens, carregando, buscar };
}
