const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Relatório de transações por vendedor com filtros
router.get('/transacoes', auth('admin', 'gerente', 'vendedor'), (req, res) => {
  const { inicio, fim, vendedor_id, tipo } = req.query;
  const user = req.user;

  // Vendedor só vê os próprios dados
  const idFiltro = user.perfil === 'vendedor' ? user.id : (vendedor_id || null);

  let sql = `
    SELECT t.*, u.nome as vendedor_nome
    FROM transacoes t
    LEFT JOIN usuarios u ON u.id = t.vendedor_id
    WHERE t.vendedor_id IS NOT NULL
  `;
  const params = [];

  if (idFiltro) { sql += ` AND t.vendedor_id = ?`; params.push(idFiltro); }
  if (inicio) { sql += ` AND t.data_transacao >= ?`; params.push(inicio); }
  if (fim) { sql += ` AND t.data_transacao <= ?`; params.push(fim); }
  if (tipo === 'ativacao') sql += ` AND t.tipo LIKE '%ATIVAÇÃO%'`;
  if (tipo === 'recarga') sql += ` AND t.tipo = 'RECARGA'`;

  sql += ` ORDER BY t.data_transacao DESC LIMIT 1000`;

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Resumo de comissões por vendedor
router.get('/resumo', auth('admin', 'gerente', 'vendedor'), (req, res) => {
  const { inicio, fim, vendedor_id } = req.query;
  const user = req.user;
  const idFiltro = user.perfil === 'vendedor' ? user.id : (vendedor_id || null);

  let sql = `
    SELECT 
      u.nome as vendedor,
      u.id as vendedor_id,
      COUNT(*) as total_transacoes,
      SUM(CASE WHEN t.tipo LIKE '%ATIVAÇÃO%' THEN 1 ELSE 0 END) as ativacoes,
      SUM(CASE WHEN t.tipo = 'RECARGA' THEN 1 ELSE 0 END) as recargas,
      SUM(CASE WHEN t.tipo LIKE '%ATIVAÇÃO%' THEN t.comissao ELSE 0 END) as comissao_ativacoes,
      SUM(CASE WHEN t.tipo = 'RECARGA' THEN t.comissao ELSE 0 END) as comissao_recargas,
      SUM(t.comissao) as total_comissao,
      SUM(t.valor) as volume_total
    FROM transacoes t
    JOIN usuarios u ON u.id = t.vendedor_id
    WHERE t.vendedor_id IS NOT NULL
  `;
  const params = [];

  if (idFiltro) { sql += ` AND t.vendedor_id = ?`; params.push(idFiltro); }
  if (inicio) { sql += ` AND t.data_transacao >= ?`; params.push(inicio); }
  if (fim) { sql += ` AND t.data_transacao <= ?`; params.push(fim); }

  sql += ` GROUP BY t.vendedor_id ORDER BY total_comissao DESC`;

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Detalhes de um vendedor específico
router.get('/vendedor/:id', auth('admin', 'gerente', 'vendedor'), (req, res) => {
  const user = req.user;
  const idAlvo = parseInt(req.params.id);

  // Vendedor não pode ver dados de outros
  if (user.perfil === 'vendedor' && user.id !== idAlvo) {
    return res.status(403).json({ error: 'Sem permissão' });
  }

  const vendedor = db.prepare(`SELECT id, nome, email FROM usuarios WHERE id = ?`).get(idAlvo);
  if (!vendedor) return res.status(404).json({ error: 'Vendedor não encontrado' });

  const { inicio, fim } = req.query;
  let sql = `SELECT * FROM transacoes WHERE vendedor_id = ?`;
  const params = [idAlvo];

  if (inicio) { sql += ` AND data_transacao >= ?`; params.push(inicio); }
  if (fim) { sql += ` AND data_transacao <= ?`; params.push(fim); }
  sql += ` ORDER BY data_transacao DESC`;

  const transacoes = db.prepare(sql).all(...params);

  const resumo = {
    ativacoes: transacoes.filter(t => t.tipo.includes('ATIVAÇÃO')).length,
    recargas: transacoes.filter(t => t.tipo === 'RECARGA').length,
    comissao_ativacoes: transacoes.filter(t => t.tipo.includes('ATIVAÇÃO')).reduce((s, t) => s + t.comissao, 0),
    comissao_recargas: transacoes.filter(t => t.tipo === 'RECARGA').reduce((s, t) => s + t.comissao, 0),
    total_comissao: transacoes.reduce((s, t) => s + t.comissao, 0),
    volume_total: transacoes.reduce((s, t) => s + t.valor, 0)
  };

  res.json({ vendedor, resumo, transacoes });
});

// Recalcular comissões (útil após alterar planos)
router.post('/recalcular', auth('admin'), (req, res) => {
  const transacoes = db.prepare(`SELECT id, plano, tipo, iccid, vendedor_id FROM transacoes`).all();
  let atualizadas = 0;

  const upd = db.prepare(`UPDATE transacoes SET comissao=? WHERE id=?`);
  const recalcAll = db.transaction(() => {
    for (const t of transacoes) {
      if (!t.vendedor_id) continue;
      const planoDB = db.prepare(`
        SELECT comissao_ativacao, comissao_recarga FROM planos_comissao 
        WHERE LOWER(nome_plano) = LOWER(?) AND ativo = 1
      `).get(t.plano || '');
      if (!planoDB) continue;
      const isAtivacao = t.tipo && t.tipo.toUpperCase().includes('ATIVAÇÃO');
      const comissao = isAtivacao ? planoDB.comissao_ativacao : planoDB.comissao_recarga;
      upd.run(comissao, t.id);
      atualizadas++;
    }
  });
  recalcAll();
  res.json({ ok: true, atualizadas });
});

module.exports = router;
