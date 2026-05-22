-- Plataforma de Gestão de Vendedores Bora MVNO
-- Executar uma vez no PostgreSQL Railway

CREATE TABLE IF NOT EXISTS vendedores (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  senha_hash VARCHAR(255) NOT NULL,
  telefone VARCHAR(20),
  ativo BOOLEAN DEFAULT true,
  role VARCHAR(20) DEFAULT 'vendedor', -- 'admin' ou 'vendedor'
  criado_em TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planos_comissao (
  id SERIAL PRIMARY KEY,
  plano_id VARCHAR(100) NOT NULL UNIQUE, -- ID do plano na Bora
  plano_nome VARCHAR(200) NOT NULL,
  plano_valor NUMERIC(10,2) NOT NULL,
  comissao_ativacao NUMERIC(10,2) NOT NULL DEFAULT 0,
  comissao_recarga NUMERIC(10,2) NOT NULL DEFAULT 0,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS linhas (
  id SERIAL PRIMARY KEY,
  iccid VARCHAR(50) UNIQUE NOT NULL,
  msisdn VARCHAR(20),
  vendedor_id INTEGER REFERENCES vendedores(id),
  plano_id VARCHAR(100),
  plano_nome VARCHAR(200),
  documento_cliente VARCHAR(20),
  nome_cliente VARCHAR(200),
  status VARCHAR(30) DEFAULT 'ativa',
  data_ativacao TIMESTAMP DEFAULT NOW(),
  ultima_checagem TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transacoes (
  id SERIAL PRIMARY KEY,
  linha_id INTEGER REFERENCES linhas(id),
  vendedor_id INTEGER REFERENCES vendedores(id),
  tipo VARCHAR(20) NOT NULL, -- 'ativacao' ou 'recarga'
  plano_id VARCHAR(100),
  plano_nome VARCHAR(200),
  valor_plano NUMERIC(10,2),
  comissao NUMERIC(10,2) NOT NULL DEFAULT 0,
  data_transacao TIMESTAMP DEFAULT NOW(),
  periodo_referencia VARCHAR(20), -- 'AAAA-MM-DD' data da recarga detectada
  fonte VARCHAR(30) DEFAULT 'sistema' -- 'sistema' ou 'bora_polling'
);

CREATE TABLE IF NOT EXISTS bora_auth (
  id SERIAL PRIMARY KEY,
  token TEXT,
  token_gerado_em TIMESTAMP DEFAULT NOW()
);

-- Admin padrão (senha: admin123 - TROCAR após primeiro login)
INSERT INTO vendedores (nome, email, senha_hash, role)
VALUES ('Administrador', 'admin@suaempresa.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin')
ON CONFLICT (email) DO NOTHING;

CREATE TABLE IF NOT EXISTS esims (
  id SERIAL PRIMARY KEY,
  iccid VARCHAR(30) UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'disponivel', -- 'disponivel' ou 'usado'
  vendedor_id INTEGER REFERENCES vendedores(id),
  msisdn VARCHAR(20),
  nome_cliente VARCHAR(200),
  documento_cliente VARCHAR(20),
  usado_em TIMESTAMP,
  importado_em TIMESTAMP DEFAULT NOW()
);
