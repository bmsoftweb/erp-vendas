# Histórico de versões

Mais recente primeiro. PATCH a cada envio ao GitHub; MAJOR/MINOR só quando pedido.

## 0.1.4 — 2026-11-19

- Novas telas no menu: Pessoas (clientes, fornecedores e transportadoras do grupo de empresas, com CPF/CNPJ validado) e Vendedores (cad_vendedores, um cadastro por empresa).
- Vendedor dos orçamentos, pedidos e vendas passa a vir do cadastro de vendedores (antes eram os usuários).
- Pesquisas de produto, cliente e transportadora configuráveis pelo usuário (colunas e campos pesquisados), com o catálogo compartilhado com o BM-Master.
- NF-e, pelo grupo tributário do produto:
  - manda a alíquota de crédito do Simples (o erp-nfe calcula o valor), e trava o CSOSN 101 sem alíquota;
  - trava a nota se o grupo não serve ao regime de quem emite (sem CSOSN no Simples, sem CST fora dele) ou está inativo.
  - Teste: `npx tsx --env-file=.env server/notas.test.ts`.
- Seta do select encostada à direita, com a moldura do foco também com a lista aberta.
- Conexão com o banco: fecha as conexões paradas antes de reaproveitar (evita ECONNRESET).

## 0.1.3 — 2026-11-19

- Menu: grupo Fiscal com a opção NFe, que abre o erp-nfe já logado numa nova aba (direto na tela de Envios).

## 0.1.2 — 2026-11-19

- Campos de digitação com fundo azul bem fraco (inclusive as células da grade de itens e parcelas); campo bloqueado continua cinza.
- Moldura dos campos mais clara; no foco, moldura de 2px na cor da barra da esquerda (âmbar se obrigatório, verde se opcional).
- Escolha do Cliente com a barra âmbar de campo obrigatório.
- Observações: Informações complementares à esquerda e Observações internas à direita.

## 0.1.1 — 2026-11-19

Primeiro envio ao repositório bmsoftweb/erp-vendas.

- Orçamentos e Pedidos (DAV, `ven_davs`): o orçamento aprovado gera o pedido; só o pedido é faturado.
- Faturar pedidos e Vendas (`ven_vendas`): faturamento parcial, vários pedidos numa venda e venda direta sem pedido.
- Naturezas de operação.
- Emissão pelos concentradores do erp-nfe e do erp-nfs (o vendas gera o token de sessão deles para o usuário logado); impostos calculados pelo erp-nfe.
- Dicas (tooltips) no padrão BMsoft em todo o app: caixa escura com seta no lugar da dica nativa do navegador.
