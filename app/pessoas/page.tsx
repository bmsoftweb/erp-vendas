import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pencil, Save, Search, Trash2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { TelaCheia, SecaoCrm, GradeCampos, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { Toggle } from '@/components/Toggle';
import { api, docBr, foneBr } from '@/lib/api';
import { documentoValido, mascaraDocumento } from '@/lib/documento';

/** Linha da lista */
interface LinhaPessoa {
  id: number;
  tipo_pessoa: 'F' | 'J';
  nome: string;
  nome_fantasia: string | null;
  cpf_cnpj: string | null;
  codigo: string | null;
  cidade: string | null;
  fone_principal: string | null;
  whatsapp: string | null;
  email_principal: string | null;
  vendedor: string | null;
  is_cliente: number;
  is_fornecedor: number;
  is_transportadora: number;
  ativo: number;
  bloqueado: number;
}

/** Campos do formulário (as colunas de cad_pessoas que esta tela mantém) */
type Pessoa = Record<string, any> & { id?: number; tipo_pessoa: 'F' | 'J'; nome: string };

interface Apoio {
  tipos: { id: number; nome: string }[];
  regioes: { id: number; nome: string }[];
  vendedores: { id: number; nome: string }[];
}

const NOVA: Pessoa = { tipo_pessoa: 'J', nome: '', is_cliente: 1, is_fornecedor: 0, is_transportadora: 0, ativo: 1, bloqueado: 0, ind_ie_dest: '9' };
const UFS = 'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO EX'.split(' ');
const IND_IE: Record<string, string> = { '1': 'Contribuinte do ICMS', '2': 'Contribuinte isento', '9': 'Não contribuinte' };
const PAPEIS: Record<string, string> = { is_cliente: 'Cliente', is_fornecedor: 'Fornecedor', is_transportadora: 'Transportadora' };
const so = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max);
const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

export default function PessoasPage() {
  const [linhas, setLinhas] = useState<LinhaPessoa[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [papel, setPapel] = useState('');
  const [form, setForm] = useState<Pessoa | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [excluir, setExcluir] = useState<LinhaPessoa | null>(null);
  const [buscandoCep, setBuscandoCep] = useState(false);
  const ultimoCep = useRef('');
  const numeroRef = useRef<HTMLInputElement>(null);

  const carregar = useCallback(async () => {
    try {
      const [ps, ap] = await Promise.all([api<LinhaPessoa[]>('/api/pessoas'), api<Apoio>('/api/pessoas/apoio')]);
      setLinhas(ps);
      setApoio(ap);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const muda = (campo: string, valor: unknown) => setForm((f) => (f ? { ...f, [campo]: valor } : f));

  const abrir = async (l: LinhaPessoa) => {
    try {
      const p = await api<Pessoa>(`/api/pessoas/${l.id}`);
      ultimoCep.current = p.cep ?? '';
      setForm(p);
    } catch (e: any) {
      setErro(e.message);
    }
  };
  const novo = () => {
    ultimoCep.current = '';
    setForm({ ...NOVA });
  };

  /** CEP completo: preenche endereço, bairro, cidade, UF e IBGE pelo ViaCEP e vai para o número */
  const buscarCep = async (cep: string) => {
    ultimoCep.current = cep;
    setBuscandoCep(true);
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(8000) }).then((x) => x.json());
      if (r.erro) throw new Error('CEP não encontrado.');
      setForm((f) =>
        f && {
          ...f,
          logradouro: String(r.logradouro || f.logradouro || '').slice(0, 100),
          bairro: String(r.bairro || f.bairro || '').slice(0, 50),
          cidade_nome: r.localidade || f.cidade_nome,
          cidade_uf: r.uf || f.cidade_uf,
          cidade_ibge: r.ibge || f.cidade_ibge,
        },
      );
      setTimeout(() => numeroRef.current?.focus());
    } catch (e: any) {
      setErro(e.message === 'CEP não encontrado.' ? e.message : 'Não foi possível consultar o CEP (ViaCEP): preencha o endereço à mão.');
    } finally {
      setBuscandoCep(false);
    }
  };

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSalvando(true);
    try {
      await api(form.id ? `/api/pessoas/${form.id}` : '/api/pessoas', form.id ? 'PATCH' : 'POST', form);
      setForm(null);
      await carregar();
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const confirmarExcluir = async () => {
    const p = excluir;
    setExcluir(null);
    try {
      await api(`/api/pessoas/${p!.id}`, 'DELETE');
      await carregar();
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const aviso = erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />;

  if (form) {
    const pf = form.tipo_pessoa === 'F';
    const doc = String(form.cpf_cnpj ?? '');
    const docRuim = doc.length > 0 && (doc.length !== (pf ? 11 : 14) || !documentoValido(doc));
    const texto = (campo: string, max: number, extra: React.ComponentProps<'input'> = {}) => (
      <input maxLength={max} value={form[campo] ?? ''} onFocus={sel} onChange={(e) => muda(campo, e.target.value)} className={INPUT_CLASS} {...extra} />
    );
    const fone = (campo: string) => (
      <input inputMode="numeric" maxLength={15} value={foneBr(form[campo])} onFocus={sel} onChange={(e) => muda(campo, so(e.target.value, 11))} className={INPUT_CLASS} />
    );
    const combo = (campo: string, itens: { id: number; nome: string }[], atual?: string | null) => (
      <select value={form[campo] ?? ''} onChange={(e) => muda(campo, Number(e.target.value) || null)} className={INPUT_CLASS}>
        <option value="">—</option>
        {/* valor gravado que saiu da lista (inativo): continua aparecendo para não sumir ao salvar */}
        {form[campo] && !itens.some((i) => i.id === Number(form[campo])) && <option value={form[campo]}>{atual ?? `#${form[campo]}`}</option>}
        {itens.map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
      </select>
    );

    return (
      <>
        <TelaCheia
          rodape={form.id ? `Pessoa #${form.id}` : 'Inclusão'}
          onVoltar={() => setForm(null)}
          rotuloVoltar="Cancelar"
          onSubmit={salvar}
          rotuloPrincipal="Salvar"
          iconePrincipal={<Save className="w-4 h-4" />}
          salvando={salvando}
        >
          <SecaoCrm titulo="Identificação">
            <GradeCampos>
              <Campo rotulo="Tipo">
                <select value={form.tipo_pessoa} onChange={(e) => setForm({ ...form, tipo_pessoa: e.target.value as 'F' | 'J', cpf_cnpj: '' })} className={INPUT_CLASS}>
                  <option value="J">Jurídica</option>
                  <option value="F">Física</option>
                </select>
              </Campo>
              <Campo rotulo={pf ? 'CPF' : 'CNPJ'}>
                <input autoFocus={!form.id} inputMode="numeric" value={mascaraDocumento(doc)} onFocus={sel} onChange={(e) => muda('cpf_cnpj', so(e.target.value, pf ? 11 : 14))} className={INPUT_CLASS} />
                {docRuim && <span className="text-[11px] font-medium text-rose-600">{doc.length === (pf ? 11 : 14) ? 'Dígitos não conferem' : 'Incompleto'}</span>}
              </Campo>
              <Campo rotulo={pf ? 'Nome' : 'Razão social'} span={2}>{texto('nome', 50, { required: true })}</Campo>
              {!pf && <Campo rotulo="Nome fantasia" span={2}>{texto('nome_fantasia', 150)}</Campo>}
              <Campo rotulo="Código" dica="Código interno ou do ERP">{texto('codigo', 20)}</Campo>
              <Campo rotulo="Ativo">
                <Toggle checked={!!Number(form.ativo)} onChange={(v) => muda('ativo', v ? 1 : 0)} />
              </Campo>
              {Object.entries(PAPEIS).map(([campo, rotulo]) => (
                <Campo key={campo} rotulo={rotulo}>
                  <Toggle checked={!!Number(form[campo])} onChange={(v) => muda(campo, v ? 1 : 0)} />
                </Campo>
              ))}
            </GradeCampos>
          </SecaoCrm>

          <SecaoCrm titulo="Fiscal">
            <GradeCampos>
              <Campo rotulo="Indicador da IE" dica="Vai na nota como indIEDest">
                <select value={form.ind_ie_dest ?? '9'} onChange={(e) => muda('ind_ie_dest', e.target.value)} className={INPUT_CLASS}>
                  {Object.entries(IND_IE).map(([k, v]) => <option key={k} value={k}>{k} - {v}</option>)}
                </select>
              </Campo>
              {form.ind_ie_dest !== '2' && (
                <Campo rotulo="Inscrição estadual">{texto('ie', 20, { required: form.ind_ie_dest === '1', onChange: (e) => muda('ie', e.target.value.replace(/[^0-9A-Za-z]/g, '').toUpperCase()) })}</Campo>
              )}
              {!pf && <Campo rotulo="Inscrição municipal">{texto('im', 20)}</Campo>}
              <Campo rotulo="E-mail da nota" dica="Recebe o XML e o DANFE; vários: separe com ;">{texto('email_nfe', 120)}</Campo>
            </GradeCampos>
          </SecaoCrm>

          <SecaoCrm titulo="Endereço">
            <GradeCampos>
              <Campo rotulo="CEP">
                <div className="relative">
                  <input
                    inputMode="numeric"
                    value={(form.cep ?? '').replace(/^(\d{5})(\d)/, '$1-$2')}
                    onFocus={sel}
                    onChange={(e) => {
                      const cep = so(e.target.value, 8);
                      muda('cep', cep);
                      if (cep.length === 8 && cep !== ultimoCep.current) buscarCep(cep);
                    }}
                    className={`${INPUT_CLASS} pr-8`}
                  />
                  <button
                    type="button"
                    title="Buscar o endereço pelo CEP"
                    data-dica-desc="Consulta o ViaCEP e preenche logradouro, bairro, cidade, UF e IBGE"
                    onClick={() => (form.cep ?? '').length === 8 && buscarCep(form.cep)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-blue-600 cursor-pointer"
                  >
                    {buscandoCep ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </Campo>
              <Campo rotulo="Logradouro" span={2}>{texto('logradouro', 100)}</Campo>
              <Campo rotulo="Número">{texto('numero', 7, { ref: numeroRef })}</Campo>
              <Campo rotulo="Complemento" span={2}>{texto('complemento', 60)}</Campo>
              <Campo rotulo="Bairro" span={2}>{texto('bairro', 50)}</Campo>
              <Campo rotulo="Cidade" span={2}>{texto('cidade_nome', 100)}</Campo>
              <Campo rotulo="UF">
                <select value={form.cidade_uf ?? ''} onChange={(e) => muda('cidade_uf', e.target.value)} className={INPUT_CLASS}>
                  <option value="">—</option>
                  {UFS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </Campo>
              <Campo rotulo="Código IBGE" dica="Vem com o CEP; obrigatório na nota">
                <input inputMode="numeric" maxLength={7} value={form.cidade_ibge ?? ''} onFocus={sel} onChange={(e) => muda('cidade_ibge', so(e.target.value, 7))} className={INPUT_CLASS} />
              </Campo>
            </GradeCampos>
          </SecaoCrm>

          <SecaoCrm titulo="Contato">
            <GradeCampos>
              <Campo rotulo="Telefone">{fone('fone_principal')}</Campo>
              <Campo rotulo="WhatsApp">{fone('whatsapp')}</Campo>
              <Campo rotulo="E-mail" span={2}>{texto('email_principal', 120, { type: 'email' })}</Campo>
            </GradeCampos>
          </SecaoCrm>

          <SecaoCrm titulo="Comercial">
            <GradeCampos>
              <Campo rotulo="Vendedor">{combo('vendedor_id', apoio?.vendedores ?? [], form.vendedor_nome)}</Campo>
              <Campo rotulo="Tipo de cliente">{combo('tipo_cliente_id', apoio?.tipos ?? [])}</Campo>
              <Campo rotulo="Região">{combo('regiao_id', apoio?.regioes ?? [])}</Campo>
              <Campo rotulo="Clube de descontos" dica="Associado: no PDV, com o CPF dele na venda, os itens saem pelo preço das listas de preço do clube (erp-estoque).">
                <Toggle checked={!!Number(form.clube_desconto)} onChange={(v) => muda('clube_desconto', v ? 1 : 0)} />
              </Campo>
              <Campo rotulo="Bloqueado">
                <Toggle checked={!!Number(form.bloqueado)} onChange={(v) => muda('bloqueado', v ? 1 : 0)} />
              </Campo>
              {!!Number(form.bloqueado) && <Campo rotulo="Motivo do bloqueio" span={4}>{texto('motivo_bloqueio', 200)}</Campo>}
            </GradeCampos>
          </SecaoCrm>

          <SecaoCrm titulo="Observações">
            <GradeCampos>
              <Campo rotulo="Observações" span={2}>
                <textarea rows={3} value={form.observacoes ?? ''} onChange={(e) => muda('observacoes', e.target.value)} className={INPUT_CLASS} />
              </Campo>
              <Campo rotulo="Observações internas" span={2} dica="Não saem em nenhum documento">
                <textarea rows={3} value={form.observacoes_internas ?? ''} onChange={(e) => muda('observacoes_internas', e.target.value)} className={INPUT_CLASS} />
              </Campo>
            </GradeCampos>
          </SecaoCrm>
        </TelaCheia>
        {aviso}
      </>
    );
  }

  const visiveis = papel ? linhas.filter((l) => Number(l[papel as keyof LinhaPessoa])) : linhas;

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ListaCrm
        className="flex-1"
        id="pessoas"
        linhas={visiveis}
        carregando={carregando}
        chave={(r) => r.id}
        onNovo={novo}
        onEditar={abrir}
        vazio="Nenhuma pessoa cadastrada."
        barraExtra={
          <select value={papel} onChange={(e) => setPapel(e.target.value)} title="Mostrar só um papel" className={`${INPUT_CLASS} w-auto`}>
            <option value="">Todos</option>
            {Object.entries(PAPEIS).map(([k, v]) => <option key={k} value={k}>{v}s</option>)}
          </select>
        }
        colunas={[
          { key: 'nome', label: 'Nome', largura: 260 },
          { key: 'nome_fantasia', label: 'Fantasia', largura: 180 },
          { key: 'cpf_cnpj', label: 'CPF/CNPJ', largura: 150, render: (r) => docBr(r.cpf_cnpj) },
          { key: 'cidade', label: 'Cidade', largura: 170 },
          { key: 'fone_principal', label: 'Telefone', largura: 130, render: (r) => foneBr(r.fone_principal) },
          { key: 'email_principal', label: 'E-mail', largura: 200 },
          { key: 'vendedor', label: 'Vendedor', largura: 140 },
          { key: 'papeis', label: 'Papéis', largura: 160, render: (r) => Object.keys(PAPEIS).filter((k) => Number(r[k as keyof LinhaPessoa])).map((k) => PAPEIS[k]).join(', ') },
          { key: 'codigo', label: 'Código', largura: 90 },
          { key: 'ativo', label: 'Ativo', alinhar: 'centro', largura: 70, render: (r) => (Number(r.bloqueado) ? 'Bloqueado' : Number(r.ativo) ? 'Sim' : 'Não') },
        ]}
        acoes={(r) => (
          <>
            <BotaoAcao icone={Pencil} titulo="Editar" descricao="Abre a pessoa para edição" onClick={() => abrir(r)} />
            <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Tira a pessoa do cadastro (pede confirmação)" tom="perigo" onClick={() => setExcluir(r)} />
          </>
        )}
      />
      {excluir && (
        <ConfirmDialog
          titulo="Excluir pessoa"
          mensagem={`Excluir “${excluir.nome}”? Ela some do cadastro e das pesquisas; orçamentos, pedidos, vendas e notas já feitos continuam com ela.`}
          confirmar="Excluir"
          tom="perigo"
          onConfirmar={confirmarExcluir}
          onCancelar={() => setExcluir(null)}
        />
      )}
      {aviso}
    </div>
  );
}
