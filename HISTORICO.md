# Histórico de versões

Mais recente primeiro. PATCH a cada envio ao GitHub; MAJOR/MINOR só quando pedido.

## 0.1.1 — 2026-11-19

Primeiro envio ao repositório bmsoftweb/erp-vendas.

- Orçamentos e Pedidos (DAV, `ven_davs`): o orçamento aprovado gera o pedido; só o pedido é faturado.
- Faturar pedidos e Vendas (`ven_vendas`): faturamento parcial, vários pedidos numa venda e venda direta sem pedido.
- Naturezas de operação.
- Emissão pelos concentradores do erp-nfe e do erp-nfs (o vendas gera o token de sessão deles para o usuário logado); impostos calculados pelo erp-nfe.
- Dicas (tooltips) no padrão BMsoft em todo o app: caixa escura com seta no lugar da dica nativa do navegador.
