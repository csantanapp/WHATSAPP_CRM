-- Link de captação personalizável: o texto do link (entry_keyword) pode ser
-- trocado na tela de Funis. Os textos antigos ficam como apelidos, pra links
-- já divulgados (cartaz, anúncio, bio) continuarem caindo no funil certo.

ALTER TABLE funnels ADD COLUMN IF NOT EXISTS entry_keyword_aliases TEXT[] NOT NULL DEFAULT '{}';
