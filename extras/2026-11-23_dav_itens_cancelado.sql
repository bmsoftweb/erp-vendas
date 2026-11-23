-- PAF-NFC-e de SC, Arquivo III, registro D5: item removido do DAV não é apagado; fica cancelado com o mesmo número
-- (campo 04 sequencial; campo 18 indicador de cancelamento 'S'/'N'), fora dos totais, do faturamento e da impressão.
-- O erp-pdv (Menu Fiscal) lê ven_dav_itens.cancelado no D5 campo 18 e tira os cancelados dos totais do D4.

ALTER TABLE ven_dav_itens ADD COLUMN cancelado TINYINT(1) NOT NULL DEFAULT 0;

-- Reversão (os itens cancelados passam a contar como ativos; apague-os antes se for o caso):
-- ALTER TABLE ven_dav_itens DROP COLUMN cancelado;
