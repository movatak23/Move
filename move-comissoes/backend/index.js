require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Servir frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Rotas
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/relatorio', require('./routes/relatorio'));

// Health check
app.get('/api/status', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
  }
});

// Sync automático a cada hora
const { executarSync } = require('./bora');
cron.schedule('0 * * * *', () => {
  console.log('[Cron] Iniciando sync horário...');
  executarSync();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Move Comissões rodando na porta ${PORT}`);
  // Sync inicial ao subir
  setTimeout(executarSync, 5000);
});
