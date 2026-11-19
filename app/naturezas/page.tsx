import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { FormCrm, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { NumberField } from '@/components/NumberField';
import { Toggle } from '@/components/Toggle';
import { api } from '@/lib/api';

interface Natureza {
  id?: number;
  descricao: string;
  documento: 'nfe' | 'nfce' | 'nfse';
  finalidade: number;
  tipo_operacao: number;
  cfop_estadual: string | null;
  cfop_interestadual: string | null;
  serie: number | string | null;
  consumidor_final: number | boolean;
  movimenta_estoque: number | boolean;
  informacoes_complementares: string | null;
  ativo: number | boolean;
}

const DOCUMENTO = { nfe: 'NF-e (55)', nfce: 'NFC-e (65)', nfse: 'NFS-e' };
const FINALIDADE: Record<number, string> = { 1: 'Normal', 2: 'Complementar', 3: 'Ajuste', 4: 'Devolução' };
const NOVA: Natureza = {
  descricao: '', documento: 'nfe', finalidade: 1, tipo_operacao: 1, cfop_estadual: '', cfop_interestadual: '',
  serie: '', consumidor_final: false, movimenta_estoque: true, informacoes_complementares: '', ativo: true,
};

export default function NaturezasPage() {
  const [linhas, setLinhas] = useState<Natureza[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [form, setForm] = useState<Natureza | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [erro, setErro] = useState('');
  const [excluir, setExcluir] = useState<Natureza | null>(null);

  const carregar = useCallback(async () => {
    try {
      setLinhas(await api('/api/naturezas'));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const muda = (campo: keyof Natureza, valor: unknown) => setForm((f) => (f ? { ...f, [campo]: valor } : f));

  const salvar = async () => {
    if (!form) return;
    setSalvando(true);
    setErroForm('');
    try {
      await api(form.id ? `/api/naturezas/${form.id}` : '/api/naturezas', form.id ? 'PATCH' : 'POST', form);
      setForm(null);
      await carregar();
    } catch (e: any) {
      setErroForm(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const confirmarExcluir = async () => {
    const n = excluir;
    setExcluir(null);
    try {
      await api(`/api/naturezas/${n!.id}`, 'DELETE');
      await carregar();
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const nfse = form?.documento === 'nfse';
  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {form ? (
        <FormCrm
          id="naturezas"
          onSubmit={(e) => (e.preventDefault(), salvar())}
          onCancel={() => setForm(null)}
          saving={salvando}
          erro={erroForm}
          onFecharErro={() => setErroForm('')}
          rodape={form.id ? `Natureza #${form.id}` : 'Inclusão'}
        >
          <Campo rotulo="Descrição" span={2} dica="Vai para a nota como natureza da operação (natOp)">
            <input autoFocus required maxLength={60} value={form.descricao} onFocus={sel} onChange={(e) => muda('descricao', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Documento">
            <select value={form.documento} onChange={(e) => muda('documento', e.target.value)} className={INPUT_CLASS}>
              {Object.entries(DOCUMENTO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Tipo">
            <select value={form.tipo_operacao} onChange={(e) => muda('tipo_operacao', Number(e.target.value))} className={INPUT_CLASS}>
              <option value={1}>Saída</option>
              <option value={0}>Entrada</option>
            </select>
          </Campo>
          {!nfse && (
            <Campo rotulo="Finalidade">
              <select value={form.finalidade} onChange={(e) => muda('finalidade', Number(e.target.value))} className={INPUT_CLASS}>
                {Object.entries(FINALIDADE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Campo>
          )}
          {!nfse && (
            <Campo rotulo="CFOP dentro do estado">
              <input required inputMode="numeric" maxLength={4} value={form.cfop_estadual ?? ''} onFocus={sel} onChange={(e) => muda('cfop_estadual', e.target.value.replace(/\D/g, ''))} className={INPUT_CLASS} />
            </Campo>
          )}
          {form.documento === 'nfe' && (
            <Campo rotulo="CFOP fora do estado">
              <input inputMode="numeric" maxLength={4} value={form.cfop_interestadual ?? ''} onFocus={sel} onChange={(e) => muda('cfop_interestadual', e.target.value.replace(/\D/g, ''))} className={INPUT_CLASS} />
            </Campo>
          )}
          <Campo rotulo="Série" dica="Vazio = a série padrão do emissor">
            <NumberField value={form.serie ?? ''} scale={0} onChange={(v) => muda('serie', v)} className={INPUT_CLASS} />
          </Campo>
          {form.documento === 'nfe' && (
            <Campo rotulo="Consumidor final">
              <Toggle checked={!!Number(form.consumidor_final)} onChange={(v) => muda('consumidor_final', v)} />
            </Campo>
          )}
          {!nfse && (
            <Campo rotulo="Movimenta estoque">
              <Toggle checked={!!Number(form.movimenta_estoque)} onChange={(v) => muda('movimenta_estoque', v)} />
            </Campo>
          )}
          <Campo rotulo="Ativa">
            <Toggle checked={!!Number(form.ativo)} onChange={(v) => muda('ativo', v)} />
          </Campo>
          <Campo rotulo="Informações complementares" span={4} dica="Texto fixo que vai no campo de informações complementares da nota">
            <textarea rows={3} value={form.informacoes_complementares ?? ''} onChange={(e) => muda('informacoes_complementares', e.target.value)} className={INPUT_CLASS} />
          </Campo>
        </FormCrm>
      ) : (
        <ListaCrm
          className="flex-1"
          id="naturezas"
          linhas={linhas}
          carregando={carregando}
          chave={(r) => r.id!}
          onNovo={() => (setErroForm(''), setForm({ ...NOVA }))}
          onEditar={(r) => (setErroForm(''), setForm({ ...r }))}
          vazio="Nenhuma natureza de operação cadastrada. Comece por “Venda de mercadoria”."
          colunas={[
            { key: 'descricao', label: 'Descrição', largura: 280 },
            { key: 'documento', label: 'Documento', alinhar: 'centro', largura: 110, render: (r) => DOCUMENTO[r.documento] },
            { key: 'tipo_operacao', label: 'Tipo', alinhar: 'centro', largura: 80, render: (r) => (Number(r.tipo_operacao) ? 'Saída' : 'Entrada') },
            { key: 'finalidade', label: 'Finalidade', alinhar: 'centro', largura: 110, render: (r) => (r.documento === 'nfse' ? '' : FINALIDADE[r.finalidade]) },
            { key: 'cfop_estadual', label: 'CFOP UF', alinhar: 'centro', largura: 80 },
            { key: 'cfop_interestadual', label: 'CFOP fora', alinhar: 'centro', largura: 90 },
            { key: 'serie', label: 'Série', alinhar: 'numero', largura: 70 },
            { key: 'ativo', label: 'Ativa', alinhar: 'centro', largura: 70, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
          ]}
          acoes={(r) => (
            <>
              <BotaoAcao icone={Pencil} titulo="Editar" descricao="Abre a natureza para edição" onClick={() => (setErroForm(''), setForm({ ...r }))} />
              <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Apaga a natureza (pede confirmação)" tom="perigo" onClick={() => setExcluir(r)} />
            </>
          )}
        />
      )}
      {excluir && (
        <ConfirmDialog
          titulo="Excluir natureza"
          mensagem={`Excluir a natureza “${excluir.descricao}”? Naturezas já usadas em orçamentos ou pedidos não podem ser excluídas; inative-as.`}
          confirmar="Excluir"
          tom="perigo"
          onConfirmar={confirmarExcluir}
          onCancelar={() => setExcluir(null)}
        />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>
  );
}
