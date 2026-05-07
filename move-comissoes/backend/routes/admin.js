const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { executarSync, importarRegistros } = require('../bora');

const router = express.Router();

// ── USUÁRIOS ──────────────────────────────────────────────────────────────────
router.get('/usuarios', auth('admin', 'gerente'), (req, res) => {
  const rows = db.prepare(`SELECT id, nome, email, perfil, ativo, criado_em FROM usuarios ORDER BY nome`).all();
  res.json(rows);
});

router.post('/usuarios', auth('admin'), (req, res) => {
  const { nome, email, senha, perfil } = req.body;
  if (!nome || !email || !senha || !perfil) return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  if (!['admin', 'gerente', 'vendedor'].includes(perfil)) return res.status(400).json({ error: 'Perfil inválido' });

  try {
    const hash = bcrypt.hashSync(senha, 10);
    const r = db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)`)
      .run(nome.trim(), email.toLowerCase().trim(), hash, perfil);
    res.json({ id: r.lastInsertRowid, ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/usuarios/:id', auth('admin'), (req, res) => {
  const { nome, email, senha, perfil, ativo } = req.body;
  const { id } = req.params;

  if (senha) {
    const hash = bcrypt.hashSync(senha, 10);
    db.prepare(`UPDATE usuarios SET senha_hash=? WHERE id=?`).run(hash, id);
  }
  if (nome) db.prepare(`UPDATE usuarios SET nome=? WHERE id=?`).run(nome.trim(), id);
  if (email) db.prepare(`UPDATE usuarios SET email=? WHERE id=?`).run(email.toLowerCase().trim(), id);
  if (perfil) db.prepare(`UPDATE usuarios SET perfil=? WHERE id=?`).run(perfil, id);
  if (ativo !== undefined) db.prepare(`UPDATE usuarios SET ativo=? WHERE id=?`).run(ativo ? 1 : 0, id);

  res.json({ ok: true });
});

router.delete('/usuarios/:id', auth('admin'), (req, res) => {
  db.prepare(`UPDATE usuarios SET ativo=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── PLANOS/COMISSÕES ──────────────────────────────────────────────────────────
router.get('/planos', auth('admin', 'gerente'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM planos_comissao ORDER BY nome_plano`).all());
});

router.post('/planos', auth('admin'), (req, res) => {
  const { nome_plano, comissao_ativacao, comissao_recarga } = req.body;
  if (!nome_plano) return res.status(400).json({ error: 'Nome do plano obrigatório' });

  try {
    const r = db.prepare(`
      INSERT INTO planos_comissao (nome_plano, comissao_ativacao, comissao_recarga)
      VALUES (?, ?, ?)
    `).run(nome_plano.trim().toUpperCase(), comissao_ativacao || 0, comissao_recarga || 0);
    res.json({ id: r.lastInsertRowid, ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Plano já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/planos/:id', auth('admin'), (req, res) => {
  const { nome_plano, comissao_ativacao, comissao_recarga, ativo } = req.body;
  db.prepare(`
    UPDATE planos_comissao SET 
      nome_plano=COALESCE(?,nome_plano),
      comissao_ativacao=COALESCE(?,comissao_ativacao),
      comissao_recarga=COALESCE(?,comissao_recarga),
      ativo=COALESCE(?,ativo),
      atualizado_em=datetime('now')
    WHERE id=?
  `).run(nome_plano, comissao_ativacao, comissao_recarga, ativo, req.params.id);
  res.json({ ok: true });
});

router.delete('/planos/:id', auth('admin'), (req, res) => {
  db.prepare(`UPDATE planos_comissao SET ativo=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── SYNC ──────────────────────────────────────────────────────────────────────
router.post('/sync', auth('admin'), async (req, res) => {
  const resultado = await executarSync();
  res.json(resultado);
});

// Import manual via JSON (frontend converte Excel → JSON)
router.post('/importar', auth('admin'), async (req, res) => {
  const { registros } = req.body;
  if (!Array.isArray(registros) || registros.length === 0)
    return res.status(400).json({ error: 'Nenhum registro enviado' });

  try {
    const novos = await importarRegistros(registros);
    res.json({ ok: true, novos, total: registros.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sync/log', auth('admin'), (req, res) => {
  const rows = db.prepare(`SELECT * FROM sync_log ORDER BY id DESC LIMIT 20`).all();
  res.json(rows);
});

// ── DASHBOARD ADMIN ──────────────────────────────────────────────────────────
router.get('/dashboard', auth('admin', 'gerente'), (req, res) => {
  const { inicio, fim } = req.query;
  const filtro = inicio && fim ? `AND data_transacao BETWEEN '${inicio}' AND '${fim}'` : '';

  const totais = db.prepare(`
    SELECT 
      COUNT(*) as total_transacoes,
      SUM(CASE WHEN tipo LIKE '%ATIVAÇÃO%' THEN 1 ELSE 0 END) as ativacoes,
      SUM(CASE WHEN tipo = 'RECARGA' THEN 1 ELSE 0 END) as recargas,
      SUM(valor) as volume_total,
      SUM(comissao) as total_comissoes
    FROM transacoes WHERE 1=1 ${filtro}
  `).get();

  const porVendedor = db.prepare(`
    SELECT u.nome, u.id,
      COUNT(*) as transacoes,
      SUM(CASE WHEN t.tipo LIKE '%ATIVAÇÃO%' THEN 1 ELSE 0 END) as ativacoes,
      SUM(CASE WHEN t.tipo = 'RECARGA' THEN 1 ELSE 0 END) as recargas,
      SUM(t.comissao) as total_comissao
    FROM transacoes t
    JOIN usuarios u ON u.id = t.vendedor_id
    WHERE t.vendedor_id IS NOT NULL ${filtro}
    GROUP BY t.vendedor_id
    ORDER BY total_comissao DESC
  `).all();

  res.json({ totais, porVendedor });
});

module.exports = router;
