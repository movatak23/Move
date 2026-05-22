'use strict';

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Banco ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ─── Config ───────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'bora-vendas-secret-2024';
const BORA_BASE = 'https://app.boramvno.com.br/appapi';
const BORA_EMAIL = process.env.BORA_EMAIL;
const BORA_SENHA = process.env.BORA_SENHA;

// ─── Token Bora (cache em memória + DB) ──────────────────────────────────────
let boraTokenCache = null;
let boraTokenExpira = null;

async function getBoraToken() {
  if (boraTokenCache && boraTokenExpira && Date.now() < boraTokenExpira) {
    return boraTokenCache;
  }
  const credencial = Buffer.from(`${BORA_EMAIL}:${BORA_SENHA}`).toString('base64');
  const resp = await axios.post(`${BORA_BASE}/api/Authentication/basic`, {}, {
    headers: { Authorization: `Basic ${credencial}` }
  });
  const token = resp.data?.token || resp.data?.accessToken || resp.headers['x-access-token'];
  if (!token) throw new Error('Token Bora não retornado');
  boraTokenCache = token;
  boraTokenExpira = Date.now() + 50 * 60 * 1000; // 50 min (antes dos 60 expirar)
  await pool.query(
    'INSERT INTO bora_auth (token, token_gerado_em) VALUES ($1, NOW()) ON CONFLICT DO NOTHING',
    [token]
  );
  return token;
}

async function boraGet(endpoint, params = {}) {
  const token = await getBoraToken();
  const resp = await axios.get(`${BORA_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    params
  });
  // Refresh token se vier no header
  const novoToken = resp.headers['x-access-token'];
  if (novoToken) {
    boraTokenCache = novoToken;
    boraTokenExpira = Date.now() + 50 * 60 * 1000;
  }
  return resp.data;
}

async function boraPost(endpoint, body = {}) {
  const token = await getBoraToken();
  const resp = await axios.post(`${BORA_BASE}${endpoint}`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const novoToken = resp.headers['x-access-token'];
  if (novoToken) {
    boraTokenCache = novoToken;
    boraTokenExpira = Date.now() + 50 * 60 * 1000;
  }
  return resp.data;
}

// ─── Middleware Auth próprio ──────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ erro: 'Token não fornecido' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  next();
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await pool.query('SELECT * FROM vendedores WHERE email=$1 AND ativo=true', [email]);
    if (!rows.length) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const v = rows[0];
    const ok = await bcrypt.compare(senha, v.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const token = jwt.sign({ id: v.id, nome: v.nome, email: v.email, role: v.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, nome: v.nome, role: v.role });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── VENDEDORES (admin) ───────────────────────────────────────────────────────
app.get('/api/vendedores', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.id, v.nome, v.email, v.telefone, v.ativo, v.criado_em,
        COUNT(DISTINCT l.id) AS total_linhas,
        COALESCE(SUM(t.comissao),0) AS total_comissao
       FROM vendedores v
       LEFT JOIN linhas l ON l.vendedor_id = v.id
       LEFT JOIN transacoes t ON t.vendedor_id = v.id
       WHERE v.role = 'vendedor'
       GROUP BY v.id ORDER BY v.nome`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/vendedores', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nome, email, senha, telefone } = req.body;
    const hash = await bcrypt.hash(senha, 10);
    const { rows } = await pool.query(
      'INSERT INTO vendedores (nome, email, senha_hash, telefone) VALUES ($1,$2,$3,$4) RETURNING id, nome, email',
      [nome, email, hash, telefone]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/vendedores/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nome, telefone, ativo, senha } = req.body;
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await pool.query('UPDATE vendedores SET nome=$1, telefone=$2, ativo=$3, senha_hash=$4 WHERE id=$5',
        [nome, telefone, ativo, hash, req.params.id]);
    } else {
      await pool.query('UPDATE vendedores SET nome=$1, telefone=$2, ativo=$3 WHERE id=$4',
        [nome, telefone, ativo, req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── PLANOS COMISSÃO (admin) ──────────────────────────────────────────────────
app.get('/api/planos-comissao', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM planos_comissao ORDER BY plano_nome');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/planos-comissao', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { plano_id, plano_nome, plano_valor, comissao_ativacao, comissao_recarga } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO planos_comissao (plano_id, plano_nome, plano_valor, comissao_ativacao, comissao_recarga)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (plano_id) DO UPDATE SET plano_nome=$2, plano_valor=$3, comissao_ativacao=$4, comissao_recarga=$5
       RETURNING *`,
      [plano_id, plano_nome, plano_valor, comissao_ativacao, comissao_recarga]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── RELATÓRIOS ───────────────────────────────────────────────────────────────
app.get('/api/relatorio/vendedor/:id', authMiddleware, async (req, res) => {
  try {
    const vendedorId = req.params.id;
    // Vendedor só vê o próprio
    if (req.user.role !== 'admin' && req.user.id !== parseInt(vendedorId)) {
      return res.status(403).json({ erro: 'Acesso negado' });
    }
    const { data_inicio, data_fim } = req.query;
    const params = [vendedorId];
    let filtro = '';
    if (data_inicio && data_fim) {
      filtro = ' AND t.data_transacao BETWEEN $2 AND $3';
      params.push(data_inicio, data_fim + ' 23:59:59');
    }
    const { rows: transacoes } = await pool.query(
      `SELECT t.*, l.msisdn, l.nome_cliente, l.iccid
       FROM transacoes t
       LEFT JOIN linhas l ON l.id = t.linha_id
       WHERE t.vendedor_id = $1${filtro}
       ORDER BY t.data_transacao DESC`,
      params
    );
    const { rows: resumo } = await pool.query(
      `SELECT tipo, COUNT(*) as quantidade, COALESCE(SUM(comissao),0) as total_comissao
       FROM transacoes WHERE vendedor_id=$1${filtro}
       GROUP BY tipo`,
      params
    );
    const { rows: linhas } = await pool.query(
      'SELECT * FROM linhas WHERE vendedor_id=$1 ORDER BY data_ativacao DESC',
      [vendedorId]
    );
    res.json({ transacoes, resumo, linhas });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/relatorio/geral', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    const params = [];
    let filtro = 'WHERE 1=1';
    if (data_inicio && data_fim) {
      filtro += ' AND t.data_transacao BETWEEN $1 AND $2';
      params.push(data_inicio, data_fim + ' 23:59:59');
    }
    const { rows } = await pool.query(
      `SELECT v.nome, v.email,
        COUNT(DISTINCT CASE WHEN t.tipo='ativacao' THEN t.id END) as ativacoes,
        COUNT(DISTINCT CASE WHEN t.tipo='recarga' THEN t.id END) as recargas,
        COALESCE(SUM(CASE WHEN t.tipo='ativacao' THEN t.comissao END),0) as comissao_ativacao,
        COALESCE(SUM(CASE WHEN t.tipo='recarga' THEN t.comissao END),0) as comissao_recarga,
        COALESCE(SUM(t.comissao),0) as total_comissao
       FROM vendedores v
       LEFT JOIN transacoes t ON t.vendedor_id = v.id
       ${filtro}
       AND v.role='vendedor'
       GROUP BY v.id, v.nome, v.email
       ORDER BY total_comissao DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── PROXY BORA — Subscriber ──────────────────────────────────────────────────
app.get('/api/bora/subscriber/documento/:doc', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet(`/api/Subscriber/${req.params.doc}/document`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

app.get('/api/bora/subscriber/iccid/:iccid', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet(`/api/Subscriber/${req.params.iccid}/iccid`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

app.post('/api/bora/subscriber', authMiddleware, async (req, res) => {
  try {
    const data = await boraPost('/api/Subscriber', req.body);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

// ─── PROXY BORA — Planos ──────────────────────────────────────────────────────
app.get('/api/bora/planos/ativacao', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet('/api/Plan/Activation');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

app.get('/api/bora/planos/recarga', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet('/api/Plan/Recharge', { msisdn: req.query.msisdn });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

app.get('/api/bora/ddds', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet('/api/Cart/DDD');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

// ─── PROXY BORA — Ativação completa ──────────────────────────────────────────
app.post('/api/bora/ativar', authMiddleware, async (req, res) => {
  try {
    const { subscriber, cartPayload, paymentType, recorrencia, vendedor_id, plano_id, plano_nome, plano_valor } = req.body;

    // 1. Busca subscriber existente ou cadastra novo
    let clientId = null;
    try {
      const existing = await boraGet(`/api/Subscriber/${subscriber.document}/document`);
      clientId = existing?.idSubscriberExternal || existing?.id || null;
    } catch {}

    if (!clientId) {
      const subResp = await boraPost('/api/Subscriber', subscriber);
      clientId = subResp?.idSubscriberExternal || subResp?.id || null;
    }

    if (!clientId) throw new Error('Não foi possível obter clientId do subscriber');

    // 2. Cria carrinho com clientId correto
    const cartBody = {
      iccid: cartPayload.iccid,
      ddd: cartPayload.ddd,
      planId: cartPayload.planId,
      planType: cartPayload.planType || 'Controle',
      clientId
    };
    // Portabilidade: envia msisdn do número a portar
    if (cartPayload.msisdnPortabilidade) {
      cartBody.msisdn = cartPayload.msisdnPortabilidade;
    }
    const cart = await boraPost('/api/Cart/subscription', cartBody);
    const cartId = cart.cartId || cart.id;
    if (!cartId) throw new Error('cartId não retornado pela Bora');

    // 3. Finaliza pagamento
    const recType = recorrencia || 'BILLET';
    let pagamento;
    if (paymentType === 'pix') {
      pagamento = await boraPost(`/api/Cart/subscription/${cartId}/pix`, {
        isRecurrence: true,
        recurrenceType: recType
      });
    } else if (paymentType === 'billet') {
      pagamento = await boraPost(`/api/Cart/subscription/${cartId}/billet`, {
        isRecurrence: true,
        recurrenceType: recType
      });
    } else if (paymentType === 'billetcombo') {
      pagamento = await boraPost(`/api/Cart/subscription/${cartId}/BilletCombo`, {});
    } else {
      throw new Error('paymentType inválido: use pix, billet ou billetcombo');
    }

    // 4. Busca comissão do plano
    const { rows: planoRows } = await pool.query(
      'SELECT comissao_ativacao FROM planos_comissao WHERE plano_id=$1',
      [plano_id]
    );
    const comissao = planoRows[0]?.comissao_ativacao || 0;

    // 5. Salva linha no banco
    const iccid = cartPayload.iccid || subscriber.iccid;
    const msisdn = pagamento.msisdn || cartPayload.msisdn || null;
    const { rows: linhaRows } = await pool.query(
      `INSERT INTO linhas (iccid, msisdn, vendedor_id, plano_id, plano_nome, documento_cliente, nome_cliente)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (iccid) DO UPDATE SET msisdn=$2, vendedor_id=$3, plano_id=$4, plano_nome=$5
       RETURNING id`,
      [iccid, msisdn, vendedor_id, plano_id, plano_nome, subscriber.document, subscriber.name]
    );
    const linhaId = linhaRows[0].id;

    // 6. Registra transação de ativação
    await pool.query(
      `INSERT INTO transacoes (linha_id, vendedor_id, tipo, plano_id, plano_nome, valor_plano, comissao, fonte)
       VALUES ($1,$2,'ativacao',$3,$4,$5,$6,'sistema')`,
      [linhaId, vendedor_id, plano_id, plano_nome, plano_valor, comissao]
    );

    // Extrai dados do PIX se houver
    const pixData = pagamento?.pix || null;

    res.json({
      ok: true,
      cartId,
      comissao,
      msisdn: pagamento?.msisdn || pagamento?.pmsisdn || null,
      isPortability: pagamento?.isPortability || false,
      pix: pixData ? {
        code: pixData.code || null,
        qrCodeUrl: pixData.qrCodeUrl || null,
        protocol: pixData.protocol || null
      } : null,
      billet: pagamento?.billet ? {
        url: pagamento.billet.url || pagamento.billet.digitableLine || null,
        barcode: pagamento.billet.barCode || pagamento.billet.digitableLine || null
      } : null
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

// ─── PROXY BORA — Detalhes de linha ───────────────────────────────────────────
app.get('/api/bora/linha/:identificador', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet(`/api/Subscription/${req.params.identificador}/details`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});


// ─── Calculadora retroativa via /details ─────────────────────────────────────
app.get('/api/bora/historic/:msisdn', authMiddleware, async (req, res) => {
  try {
    // Busca detalhes atuais da linha
    const details = await boraGet(`/api/Subscription/${req.params.msisdn}/details`);
    res.json(details);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

// ─── Calculadora: simula recargas por período com /details ────────────────────
app.post('/api/calculadora/simular', authMiddleware, async (req, res) => {
  try {
    const { msisdn, plano_id } = req.body;

    // Normaliza MSISDN — adiciona DDI 55 se necessário
    const msisdnNorm = msisdn.startsWith('55') ? msisdn : '55' + msisdn;

    // Busca detalhes reais da linha na Bora
    const details = await boraGet(`/api/Subscription/${msisdnNorm}/details`);

    // Campos básicos
    const dataAtivacao = details?.activationDate || null;
    const statusLinha  = details?.status || '—';
    if (!dataAtivacao) throw new Error('Data de ativação não encontrada na Bora');

    // plan é um array com histórico real de recargas
    const planArray = Array.isArray(details?.plan) ? details.plan : [];

    // Plano mais recente = último do array
    const planoRecente = planArray.length ? planArray[planArray.length - 1] : null;
    const planoAtualNome = planoRecente?.name || 'Sem plano';

    // Busca comissões configuradas — indexa por ID e por nome (uppercase) para fallback
    const { rows: planosComissao } = await pool.query('SELECT * FROM planos_comissao');
    const mapaComissaoId = {};
    const mapaComissaoNome = {};
    planosComissao.forEach(p => {
      mapaComissaoId[String(p.plano_id)] = p;
      mapaComissaoNome[String(p.plano_nome).toUpperCase().trim()] = p;
    });

    function buscarComissao(planId, planNome) {
      // Tenta por ID primeiro, depois por nome
      return mapaComissaoId[String(planId || '')] ||
             mapaComissaoNome[String(planNome || '').toUpperCase().trim()] ||
             null;
    }

    // Monta resultado usando o histórico real do array plan
    const resultado = [];
    const mesAtiv = dataAtivacao.substring(0, 7);

    // Primeiro registro = ativação
    const primeiroPlano = planArray.length ? planArray[0] : null;
    const comissaoAtiv = buscarComissao(primeiroPlano?.planId, primeiroPlano?.name);
    resultado.push({
      mes: mesAtiv,
      tipo: 'ativacao',
      plano_id: primeiroPlano?.planId || null,
      plano_nome: primeiroPlano?.name || 'Plano ativação',
      data: dataAtivacao,
      comissao: parseFloat(comissaoAtiv?.comissao_ativacao || 0),
      sem_config: !comissaoAtiv
    });

    // Demais registros = recargas
    for (let i = 1; i < planArray.length; i++) {
      const p = planArray[i];
      const comissaoRec = buscarComissao(p.planId, p.name);
      resultado.push({
        mes: (p.createdAt || '').substring(0, 7),
        tipo: 'recarga',
        plano_id: p.planId || null,
        plano_nome: p.name || '—',
        data: p.createdAt || null,
        comissao: parseFloat(comissaoRec?.comissao_recarga || 0),
        sem_config: !comissaoRec
      });
    }

    res.json({
      msisdn: msisdnNorm,
      plano_atual_nome: planoAtualNome,
      data_ativacao: dataAtivacao,
      status: statusLinha,
      resultado
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

// ─── Registrar comissões retroativas ─────────────────────────────────────────
app.post('/api/comissao/registrar-retroativo', authMiddleware, async (req, res) => {
  try {
    const { msisdn, vendedor_id, plano_id, plano_nome, recargas } = req.body;

    // Busca ou cria linha
    let { rows: linhaRows } = await pool.query(
      'SELECT id FROM linhas WHERE msisdn=$1', [msisdn]
    );

    let linhaId;
    if (!linhaRows.length) {
      const ins = await pool.query(
        `INSERT INTO linhas (iccid, msisdn, vendedor_id, plano_id, plano_nome, status)
         VALUES ($1,$2,$3,$4,$5,'ativa') RETURNING id`,
        [`retroativo-${msisdn}`, msisdn, vendedor_id, plano_id, plano_nome]
      );
      linhaId = ins.rows[0].id;
    } else {
      linhaId = linhaRows[0].id;
      await pool.query(
        'UPDATE linhas SET vendedor_id=$1, plano_id=$2, plano_nome=$3 WHERE id=$4',
        [vendedor_id, plano_id, plano_nome, linhaId]
      );
    }

    let inseridas = 0;
    for (const r of recargas) {
      const { rows: existe } = await pool.query(
        'SELECT id FROM transacoes WHERE linha_id=$1 AND tipo=$2 AND periodo_referencia=$3',
        [linhaId, 'recarga', r.periodo]
      );
      if (existe.length) continue;
      await pool.query(
        `INSERT INTO transacoes (linha_id, vendedor_id, tipo, plano_id, plano_nome, comissao, periodo_referencia, fonte)
         VALUES ($1,$2,'recarga',$3,$4,$5,$6,'retroativo')`,
        [linhaId, vendedor_id, plano_id, plano_nome, r.comissao, r.periodo]
      );
      inseridas++;
    }

    res.json({ ok: true, inseridas });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── CRON — Polling de recargas via /details ─────────────────────────────────
async function checarRecargas() {
  console.log(`[CRON] Iniciando polling — ${new Date().toISOString()}`);
  try {
    const { rows: linhas } = await pool.query(
      `SELECT l.*, v.nome as vendedor_nome
       FROM linhas l
       JOIN vendedores v ON v.id = l.vendedor_id
       WHERE l.status = 'ativa' AND l.msisdn IS NOT NULL`
    );

    const hoje = new Date();
    // Período de referência = mês atual (AAAA-MM)
    const mesRef = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;

    let detectadas = 0;
    let atualizadas = 0;

    for (const linha of linhas) {
      try {
        // 1. Busca detalhes atuais da linha na Bora
        const details = await boraGet(`/api/Subscription/${linha.msisdn}/details`);

        // 2. Extrai plano atual retornado pela Bora
        const planoAtualId = details?.planData?.id || details?.plan?.id || details?.planId || null;
        const planoAtualNome = details?.planData?.name || details?.plan?.name || details?.planName || linha.plano_nome;
        const statusLinha = details?.status || details?.lineStatus || 'ativa';

        // 3. Se plano mudou, atualiza no banco
        if (planoAtualId && planoAtualId !== linha.plano_id) {
          await pool.query(
            'UPDATE linhas SET plano_id=$1, plano_nome=$2 WHERE id=$3',
            [planoAtualId, planoAtualNome, linha.id]
          );
          console.log(`[CRON] Plano atualizado: ${linha.msisdn} | ${linha.plano_nome} → ${planoAtualNome}`);
          atualizadas++;
          linha.plano_id = planoAtualId;
          linha.plano_nome = planoAtualNome;
        }

        // 4. Verifica se linha está suspensa/cancelada
        const statusNorm = String(statusLinha).toLowerCase();
        if (statusNorm.includes('suspend') || statusNorm.includes('cancel') || statusNorm.includes('inativ')) {
          await pool.query('UPDATE linhas SET status=$1 WHERE id=$2', [statusNorm, linha.id]);
          console.log(`[CRON] Linha ${linha.msisdn} suspensa/cancelada — ignorando recarga`);
          continue;
        }

        // 5. Verifica se já tem recarga registrada neste mês
        const { rows: existe } = await pool.query(
          `SELECT id FROM transacoes
           WHERE linha_id=$1 AND tipo='recarga' AND periodo_referencia=$2`,
          [linha.id, mesRef]
        );
        if (existe.length > 0) {
          await pool.query('UPDATE linhas SET ultima_checagem=NOW() WHERE id=$1', [linha.id]);
          continue;
        }

        // 6. Só registra recarga se a linha tem atividade no mês atual
        // Critério: data de renovação/próximo vencimento está no mês corrente ou passou
        const proximoVenc = details?.planData?.nextRenewalDate || details?.nextRenewalDate || null;
        let linhaAtiva = false;
        if (proximoVenc) {
          const venc = new Date(proximoVenc);
          // Se o próximo vencimento é futuro, significa que já pagou este mês
          linhaAtiva = venc >= hoje || venc.getMonth() === hoje.getMonth();
        } else {
          // Sem data de vencimento: usa data de ativação como critério
          const dataAtiv = new Date(linha.data_ativacao);
          const mesesAtiva = (hoje.getFullYear() - dataAtiv.getFullYear()) * 12 + (hoje.getMonth() - dataAtiv.getMonth());
          linhaAtiva = mesesAtiva >= 1; // Pelo menos 1 mês ativa = houve pelo menos 1 recarga
        }

        if (!linhaAtiva) {
          await pool.query('UPDATE linhas SET ultima_checagem=NOW() WHERE id=$1', [linha.id]);
          continue;
        }

        // 7. Busca comissão do plano atual
        const { rows: planoRows } = await pool.query(
          'SELECT comissao_recarga, plano_nome FROM planos_comissao WHERE plano_id=$1',
          [linha.plano_id]
        );
        const comissao = parseFloat(planoRows[0]?.comissao_recarga || 0);
        if (comissao === 0) {
          await pool.query('UPDATE linhas SET ultima_checagem=NOW() WHERE id=$1', [linha.id]);
          continue;
        }

        // 8. Registra recarga com comissão do plano atual
        await pool.query(
          `INSERT INTO transacoes (linha_id, vendedor_id, tipo, plano_id, plano_nome, comissao, periodo_referencia, fonte)
           VALUES ($1,$2,'recarga',$3,$4,$5,$6,'bora_details')`,
          [linha.id, linha.vendedor_id, linha.plano_id, linha.plano_nome, comissao, mesRef]
        );
        detectadas++;
        console.log(`[CRON] Recarga registrada: ${linha.msisdn} (${linha.vendedor_nome}) plano=${linha.plano_nome} comissão=R$${comissao}`);

        await pool.query('UPDATE linhas SET ultima_checagem=NOW() WHERE id=$1', [linha.id]);
      } catch (err) {
        console.error(`[CRON] Erro na linha ${linha.msisdn}: ${err.message}`);
      }
    }

    console.log(`[CRON] Concluído. ${detectadas} recargas | ${atualizadas} planos atualizados.`);
  } catch (err) {
    console.error(`[CRON] Erro geral: ${err.message}`);
  }
}

// Roda a cada hora
cron.schedule('0 * * * *', checarRecargas);

// Endpoint para forçar polling manualmente
app.post('/api/admin/polling/forcar', authMiddleware, adminOnly, async (req, res) => {
  checarRecargas().catch(console.error);
  res.json({ ok: true, mensagem: 'Polling iniciado em background' });
});

// ─── Serve o frontend ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bora Vendas rodando na porta ${PORT}`);
  // Roda polling 2 minutos após iniciar
  setTimeout(checarRecargas, 2 * 60 * 1000);
});
