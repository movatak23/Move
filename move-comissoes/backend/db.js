const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    perfil TEXT NOT NULL CHECK(perfil IN ('admin', 'gerente', 'vendedor')),
    ativo INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS planos_comissao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome_plano TEXT UNIQUE NOT NULL,
    comissao_ativacao REAL DEFAULT 0,
    comissao_recarga REAL DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    atualizado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msisdn TEXT NOT NULL,
    iccid TEXT NOT NULL,
    data_transacao TEXT NOT NULL,
    cpf_cnpj TEXT,
    nome_cliente TEXT,
    plano TEXT,
    tipo TEXT NOT NULL,
    valor REAL,
    meio_pagamento TEXT,
    canal TEXT,
    vendedor_bora TEXT,
    supervisor TEXT,
    loja TEXT,
    vendedor_id INTEGER REFERENCES usuarios(id),
    comissao REAL DEFAULT 0,
    sync_em TEXT DEFAULT (datetime('now')),
    UNIQUE(msisdn, iccid, data_transacao, tipo)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    iniciado_em TEXT DEFAULT (datetime('now')),
    finalizado_em TEXT,
    status TEXT,
    registros_novos INTEGER DEFAULT 0,
    erro TEXT
  );

  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );
`);

// Admin padrão se não existir
const bcrypt = require('bcryptjs');
const adminExiste = db.prepare('SELECT id FROM usuarios WHERE perfil = ?').get('admin');
if (!adminExiste) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)`)
    .run('Administrador', 'admin@move.com', hash, 'admin');
}

module.exports = db;
