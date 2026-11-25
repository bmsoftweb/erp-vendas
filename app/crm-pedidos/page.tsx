import React, { useCallback, useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { api, dataBr, docBr, moeda, numDav } from '@/lib/api';

/**
 * Pedidos externos: o pedido aprovado no CRM ou fechado no portal B2B entra no erp-vendas como Requisição Externa
 * (PAF-NFC-e de SC, Requisito XVI). Receber = RE com o CRE + pedido (DAV) com os itens; com dado inválido, a RE fica denegada.
 */
const STATUS_RE: Record<string, string> = {
  recebida: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  atendida: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  denegada: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
};
const cre = (n: unknown) => String(n ?? '').padStart(9, '0');
const ORIGEM: Record<string, string> = { crm: 'CRM', b2b: 'B2B' };

export default function PedidosCrm() {
  const [ver, setVer] = useState<'pendentes' | 'recebidos'>('pendentes');
  const [linhas, setLinhas] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [naturezas, setNaturezas] = useState<{ id: number; descricao: string; documento: string; ativo: number }[]>([]);
  const [receber, setReceber] = useState<{ r: any; natureza_id: string } | null>(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setLinhas(await api(`/api/crm/pedidos?ver=${ver}`));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [ver]);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);
  useEffect(() => {
    api('/api/naturezas').then((n) => setNaturezas(n.filter((x: any) => Number(x.ativo) && ['nfe', 'nfce'].includes(x.documento))), (e) => setErro(e.message));
  }, []);

  const confirmar = async () => {
    if (!receber?.natureza_id) throw new Error('Escolha a natureza de operação.');
    const r = await api(`/api/crm/pedidos/${receber.r.id}/receber`, 'POST', { natureza_id: Number(receber.natureza_id), origem: receber.r.origem });
    const de = `Pedido ${receber.r.numero_pedido} do ${ORIGEM[receber.r.origem]}`;
    setReceber(null);
    if (r.status === 'denegada') setAviso(`${de}: RE ${cre(r.cre)} denegada. ${r.motivo}`);
    else setOk(`${de} recebido: RE ${cre(r.cre)}, pedido ${numDav(r.dav)}.`);
    await carregar();
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ListaCrm
        className="flex-1"
        id={`crm-pedidos-${ver}`}
        linhas={linhas}
        carregando={carregando}
        chave={(r) => `${r.origem}-${r.id}`}
        vazio={ver === 'pendentes' ? 'Nenhum pedido do CRM ou do B2B esperando para ser recebido.' : 'Nenhum pedido externo recebido ainda.'}
        barraExtra={
          <select value={ver} onChange={(e) => setVer(e.target.value as any)} className={INPUT_CLASS + ' !w-44'}>
            <option value="pendentes">A receber</option>
            <option value="recebidos">Recebidos (RE)</option>
          </select>
        }
        colunas={[
          { key: 'origem', label: 'Origem', alinhar: 'centro', largura: 80, render: (r) => ORIGEM[r.origem] },
          { key: 'numero_pedido', label: 'Pedido', alinhar: 'numero', largura: 100 },
          { key: 'data_emissao', label: 'Data', alinhar: 'centro', largura: 100, render: (r) => dataBr(r.data_emissao) },
          { key: 'cliente', label: 'Cliente', largura: 260 },
          { key: 'cpf_cnpj', label: 'CPF/CNPJ', alinhar: 'centro', largura: 150, render: (r) => docBr(r.cpf_cnpj) },
          { key: 'valor_total', label: 'Total', alinhar: 'numero', largura: 110, render: (r) => moeda(r.valor_total) },
          ...(ver === 'recebidos'
            ? [
                { key: 'cre', label: 'CRE', alinhar: 'centro' as const, largura: 100, render: (r: any) => cre(r.cre) },
                {
                  key: 'status_re', label: 'Situação RE', alinhar: 'centro' as const, largura: 110,
                  render: (r: any) => <span title={r.motivo || undefined} className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_RE[r.status_re] ?? ''}`}>{r.status_re[0].toUpperCase() + r.status_re.slice(1)}</span>,
                },
                { key: 'dav', label: 'Pedido (DAV)', alinhar: 'centro' as const, largura: 110, render: (r: any) => numDav(r.dav) },
              ]
            : []),
        ]}
        acoes={ver === 'pendentes' ? (r) => (
          <BotaoAcao icone={Inbox} titulo="Receber" descricao="Registra a requisição externa e gera o pedido (DAV)" tom="verde"
            onClick={() => setReceber({ r, natureza_id: naturezas.length === 1 ? String(naturezas[0].id) : '' })} />
        ) : undefined}
      />
      {receber && (
        <ConfirmDialog
          titulo={`Receber pedido do ${ORIGEM[receber.r.origem]}`}
          mensagem={`Pedido ${receber.r.numero_pedido} de ${receber.r.cliente ?? 'consumidor'} (${moeda(receber.r.valor_total)}). Registra a requisição externa e gera o pedido de venda; com dado inválido, a requisição fica denegada.`}
          confirmar="Receber"
          tom="normal"
          onConfirmar={confirmar}
          onCancelar={() => setReceber(null)}
        >
          <Campo rotulo="Natureza de operação">
            <select required autoFocus value={receber.natureza_id} onChange={(e) => setReceber({ ...receber, natureza_id: e.target.value })} className={INPUT_CLASS}>
              <option value="">Escolha…</option>
              {naturezas.map((n) => <option key={n.id} value={n.id}>{n.descricao}</option>)}
            </select>
          </Campo>
        </ConfirmDialog>
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {aviso && <AvisoErro tom="alerta" mensagem={aviso} onFechar={() => setAviso('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}
