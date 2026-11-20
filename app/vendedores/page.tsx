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
import { api, docBr, foneBr } from '@/lib/api';
import { formatNumber } from '@/lib/utils';

interface Vendedor {
  id?: number;
  nome: string;
  apelido: string | null;
  cpf: string | null;
  telefone: string | null;
  email: string | null;
  comissao_percentual: number | string;
  observacoes: string | null;
  ativo: number | boolean;
  usuario_id: number | null;
  usuario_nome?: string | null;
}

const NOVO: Vendedor = { nome: '', apelido: '', cpf: '', telefone: '', email: '', comissao_percentual: '', observacoes: '', ativo: true, usuario_id: null };
const digitos = (v: string) => v.replace(/\D/g, '').slice(0, 11);

export default function VendedoresPage() {
  const [linhas, setLinhas] = useState<Vendedor[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [form, setForm] = useState<Vendedor | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [erro, setErro] = useState('');
  const [excluir, setExcluir] = useState<Vendedor | null>(null);
  const [usuarios, setUsuarios] = useState<{ id: number; nome: string }[]>([]);

  const carregar = useCallback(async () => {
    try {
      const [vs, us] = await Promise.all([api<Vendedor[]>('/api/vendedores'), api<{ id: number; nome: string }[]>('/api/vendedores/usuarios')]);
      setLinhas(vs);
      setUsuarios(us);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const muda = (campo: keyof Vendedor, valor: unknown) => setForm((f) => (f ? { ...f, [campo]: valor } : f));
  const abrir = (v: Vendedor) => (setErroForm(''), setForm({ ...v }));

  const salvar = async () => {
    if (!form) return;
    setSalvando(true);
    setErroForm('');
    try {
      await api(form.id ? `/api/vendedores/${form.id}` : '/api/vendedores', form.id ? 'PATCH' : 'POST', form);
      setForm(null);
      await carregar();
    } catch (e: any) {
      setErroForm(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const confirmarExcluir = async () => {
    const v = excluir;
    setExcluir(null);
    try {
      await api(`/api/vendedores/${v!.id}`, 'DELETE');
      await carregar();
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {form ? (
        <FormCrm
          id="vendedores"
          onSubmit={(e) => (e.preventDefault(), salvar())}
          onCancel={() => setForm(null)}
          saving={salvando}
          erro={erroForm}
          onFecharErro={() => setErroForm('')}
          rodape={form.id ? `Vendedor #${form.id}` : 'Inclusão'}
        >
          <Campo rotulo="Nome" span={2}>
            <input autoFocus required maxLength={60} value={form.nome} onFocus={sel} onChange={(e) => muda('nome', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Apelido">
            <input maxLength={20} value={form.apelido ?? ''} onFocus={sel} onChange={(e) => muda('apelido', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="CPF">
            <input inputMode="numeric" maxLength={14} value={docBr(form.cpf)} onFocus={sel} onChange={(e) => muda('cpf', digitos(e.target.value))} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Telefone" dica="Com DDD">
            <input inputMode="numeric" maxLength={15} value={foneBr(form.telefone)} onFocus={sel} onChange={(e) => muda('telefone', digitos(e.target.value))} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="E-mail" span={2}>
            <input type="email" maxLength={100} value={form.email ?? ''} onFocus={sel} onChange={(e) => muda('email', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Comissão (%)">
            <NumberField value={form.comissao_percentual} scale={2} onChange={(v) => muda('comissao_percentual', v)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Usuário" dica="Login do vendedor: o orçamento e o pedido novos já vêm com ele de vendedor">
            <select value={form.usuario_id ?? ''} onChange={(e) => muda('usuario_id', Number(e.target.value) || null)} className={INPUT_CLASS}>
              <option value="">— sem login —</option>
              {/* usuário já ligado mas inativo ou fora da empresa: continua aparecendo para não sumir ao salvar */}
              {form.usuario_id && !usuarios.some((u) => u.id === Number(form.usuario_id)) && <option value={form.usuario_id}>{form.usuario_nome ?? `#${form.usuario_id}`}</option>}
              {usuarios.map((u) => {
                const outro = linhas.find((v) => Number(v.usuario_id) === u.id && v.id !== form.id);
                return <option key={u.id} value={u.id} disabled={!!outro}>{outro ? `${u.nome} (já é ${outro.nome})` : u.nome}</option>;
              })}
            </select>
          </Campo>
          <Campo rotulo="Ativo">
            <Toggle checked={!!Number(form.ativo)} onChange={(v) => muda('ativo', v)} />
          </Campo>
          <Campo rotulo="Observações" span={4}>
            <textarea rows={3} maxLength={255} value={form.observacoes ?? ''} onChange={(e) => muda('observacoes', e.target.value)} className={INPUT_CLASS} />
          </Campo>
        </FormCrm>
      ) : (
        <ListaCrm
          className="flex-1"
          id="vendedores"
          linhas={linhas}
          carregando={carregando}
          chave={(r) => r.id!}
          onNovo={() => abrir({ ...NOVO })}
          onEditar={abrir}
          vazio="Nenhum vendedor cadastrado."
          colunas={[
            { key: 'nome', label: 'Nome', largura: 260 },
            { key: 'apelido', label: 'Apelido', largura: 120 },
            { key: 'cpf', label: 'CPF', largura: 130, render: (r) => docBr(r.cpf) },
            { key: 'telefone', label: 'Telefone', largura: 130, render: (r) => foneBr(r.telefone) },
            { key: 'email', label: 'E-mail', largura: 220 },
            { key: 'usuario_nome', label: 'Usuário', largura: 160 },
            { key: 'comissao_percentual', label: 'Comissão %', alinhar: 'numero', largura: 100, render: (r) => formatNumber(r.comissao_percentual) },
            { key: 'ativo', label: 'Ativo', alinhar: 'centro', largura: 70, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
          ]}
          acoes={(r) => (
            <>
              <BotaoAcao icone={Pencil} titulo="Editar" descricao="Abre o vendedor para edição" onClick={() => abrir(r)} />
              <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Apaga o vendedor (pede confirmação)" tom="perigo" onClick={() => setExcluir(r)} />
            </>
          )}
        />
      )}
      {excluir && (
        <ConfirmDialog
          titulo="Excluir vendedor"
          mensagem={`Excluir o vendedor “${excluir.nome}”? Vendedores já usados em orçamentos, pedidos, vendas ou clientes não podem ser excluídos; inative-os.`}
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
