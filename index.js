'use strict';

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
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
const MOVE_BUILD_TAG_QRCODE_ESIM = 'move-qrcode-esim-route-confirmed-2026-06-03';

// ─── Configuração de e-mail / eSIM ───────────────────────────────────────────
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Move <noreply@move.local>';
const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const ESIM_EMAIL_AUTO = String(process.env.ESIM_EMAIL_AUTO || 'true').toLowerCase() !== 'false';

// ─── Configuração de marca / Supabase Storage ───────────────────────────────
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'move-logos';
const SUPABASE_FOLDER = process.env.SUPABASE_FOLDER || 'parceiros/logos';
const MOVE_LOGO_URL = process.env.MOVE_LOGO_URL || null;
// Caminho padrão do logo da Move dentro do Supabase Storage.
// Se MOVE_LOGO_URL estiver configurado, ele tem prioridade.
const SUPABASE_MOVE_LOGO_PATH = process.env.SUPABASE_MOVE_LOGO_PATH || `${String(SUPABASE_FOLDER || 'parceiros/logos').replace(/^\/+|\/+$/g, '')}/move5g.png`;

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
  boraTokenExpira = Date.now() + 50 * 60 * 1000;
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

async function boraPut(endpoint, body = {}) {
  const token = await getBoraToken();
  const resp = await axios.put(`${BORA_BASE}${endpoint}`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const novoToken = resp.headers['x-access-token'];
  if (novoToken) {
    boraTokenCache = novoToken;
    boraTokenExpira = Date.now() + 50 * 60 * 1000;
  }
  return resp.data;
}


// ─── Utilitários eSIM QR Code / E-mail ───────────────────────────────────────
function limparEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function mascararIccid(iccid) {
  const s = String(iccid || '');
  if (s.length <= 8) return s;
  return `${s.slice(0, 6)}••••••${s.slice(-4)}`;
}

async function garantirColunasEsimQrCode() {
  try {
    await pool.query(`ALTER TABLE esims ADD COLUMN IF NOT EXISTS qr_code_url TEXT`);
    await pool.query(`ALTER TABLE esims ADD COLUMN IF NOT EXISTS qr_code_capturado_em TIMESTAMP`);
    await pool.query(`ALTER TABLE esims ADD COLUMN IF NOT EXISTS qr_code_enviado_em TIMESTAMP`);
    await pool.query(`ALTER TABLE esims ADD COLUMN IF NOT EXISTS qr_code_email_destino VARCHAR(200)`);
    await pool.query(`ALTER TABLE esims ADD COLUMN IF NOT EXISTS qr_code_email_erro TEXT`);
  } catch (e) {
    console.warn('[DB] Não foi possível garantir colunas de QR Code eSIM:', e.message);
  }
}


async function garantirColunasEquipeVendedor() {
  try {
    await pool.query(`ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES vendedores(id)`);
    await pool.query(`ALTER TABLE linhas ADD COLUMN IF NOT EXISTS subvendedor_id INTEGER REFERENCES vendedores(id)`);
    await pool.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS subvendedor_id INTEGER REFERENCES vendedores(id)`);
    await pool.query(`ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS logo_url TEXT`);
    await pool.query(`ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS logo_public_id TEXT`);
    await pool.query(`ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS nome_exibicao VARCHAR(150)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendedores_parent_id ON vendedores(parent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendedores_role_parent ON vendedores(role, parent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_linhas_subvendedor_id ON linhas(subvendedor_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transacoes_subvendedor_id ON transacoes(subvendedor_id)`);
  } catch (e) {
    console.warn('[DB] Não foi possível garantir colunas de equipe do vendedor:', e.message);
  }
}

async function consultarEsimPorIccid(iccid) {
  if (!iccid) throw new Error('ICCID não informado para consulta do eSIM');
  return await boraGet(`/api/Subscriber/${encodeURIComponent(iccid)}/iccid`);
}

function aguardar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function capturarQrCodeEsim(iccid, tentativas = 5) {
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const esimInfo = await consultarEsimPorIccid(iccid);
      const qrCodeUrl = esimInfo?.qrCodeUrl || esimInfo?.qrcodeUrl || esimInfo?.qr_code_url || null;
      if (!qrCodeUrl) {
        throw new Error('A Bora não retornou qrCodeUrl para este ICCID');
      }

      const qrResp = await axios.get(qrCodeUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: 2 * 1024 * 1024
      });

      const qrBuffer = Buffer.from(qrResp.data);
      if (!qrBuffer.length) throw new Error('Imagem do QR Code veio vazia');

      return { esimInfo, qrCodeUrl, qrBuffer };
    } catch (e) {
      ultimoErro = e;
      if (tentativa < tentativas) await aguardar(1500);
    }
  }

  throw ultimoErro || new Error('Não foi possível capturar o QR Code do eSIM');
}

function montarHtmlEmailEsim({ nome, iccid, msisdn }) {
  const nomeSeguro = escapeHtml(nome || 'cliente');
  const iccidSeguro = escapeHtml(mascararIccid(iccid));
  const numeroSeguro = escapeHtml(msisdn || '');
  return `
  <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111827;line-height:1.5">
    <h2 style="margin:0 0 12px;color:#111827">Seu eSIM Move está pronto</h2>
    <p>Olá, ${nomeSeguro}.</p>
    <p>Segue o QR Code para configurar seu eSIM. Abra a câmera do celular ou vá em <strong>Adicionar eSIM/Plano Celular</strong> nas configurações do aparelho.</p>
    <div style="text-align:center;margin:24px 0">
      <img src="cid:esim-qrcode" alt="QR Code do eSIM" style="width:260px;max-width:100%;border:1px solid #e5e7eb;border-radius:12px;padding:12px" />
    </div>
    ${numeroSeguro ? `<p><strong>Número:</strong> ${numeroSeguro}</p>` : ''}
    <p><strong>ICCID:</strong> ${iccidSeguro}</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-top:18px">
      <p style="margin:0 0 8px"><strong>Atenção:</strong></p>
      <p style="margin:0">Não compartilhe este QR Code. Ele é de uso pessoal e deve ser instalado apenas no aparelho do titular.</p>
    </div>
    <p style="font-size:12px;color:#6b7280;margin-top:24px">Caso já tenha instalado o eSIM, desconsidere este e-mail.</p>
  </div>`;
}

async function enviarEmailEsim({ email, nome, iccid, msisdn, qrBuffer }) {
  const destino = limparEmail(email);
  if (!destino) throw new Error('Cliente sem e-mail cadastrado');

  const subject = 'Seu QR Code de eSIM Move';
  const html = montarHtmlEmailEsim({ nome, iccid, msisdn });
  const text = `Olá, ${nome || 'cliente'}. Segue em anexo o QR Code para configurar seu eSIM Move. Não compartilhe este QR Code.`;
  const filename = `esim-${String(iccid || 'qrcode').slice(-6)}.png`;

  if (RESEND_API_KEY) {
    await axios.post('https://api.resend.com/emails', {
      from: EMAIL_FROM,
      to: [destino],
      subject,
      html,
      text,
      attachments: [{ filename, content: qrBuffer.toString('base64'), content_type: 'image/png', content_id: 'esim-qrcode' }]
    }, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000
    });
    return { provider: 'resend', destino };
  }

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('Envio de e-mail não configurado. Configure RESEND_API_KEY ou SMTP_HOST/SMTP_USER/SMTP_PASS.');
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: destino,
    subject,
    text,
    html,
    attachments: [{
      filename,
      content: qrBuffer,
      contentType: 'image/png',
      cid: 'esim-qrcode'
    }]
  });

  return { provider: 'smtp', destino };
}

async function capturarSalvarEnviarQrCodeEsim({ iccid, email, nome, msisdn }) {
  const resultado = {
    qrCodeUrl: null,
    emailDestino: limparEmail(email),
    emailEnviado: false,
    erroEmail: null,
    erroCaptura: null
  };

  try {
    const { qrCodeUrl, qrBuffer } = await capturarQrCodeEsim(iccid);
    resultado.qrCodeUrl = qrCodeUrl;

    try {
      await pool.query(
        `UPDATE esims
         SET qr_code_url=$1, qr_code_capturado_em=NOW(), qr_code_email_erro=NULL
         WHERE iccid=$2`,
        [qrCodeUrl, iccid]
      );
    } catch (e) {
      console.warn('[ESIM] Não foi possível salvar URL do QR Code:', e.message);
    }

    if (!ESIM_EMAIL_AUTO) {
      resultado.erroEmail = 'Envio automático desativado por ESIM_EMAIL_AUTO=false';
      return resultado;
    }

    const envio = await enviarEmailEsim({ email, nome, iccid, msisdn, qrBuffer });
    resultado.emailEnviado = true;
    resultado.emailDestino = envio.destino;

    try {
      await pool.query(
        `UPDATE esims
         SET qr_code_enviado_em=NOW(), qr_code_email_destino=$1, qr_code_email_erro=NULL
         WHERE iccid=$2`,
        [envio.destino, iccid]
      );
    } catch (e) {
      console.warn('[ESIM] Não foi possível registrar envio do QR Code:', e.message);
    }

    return resultado;
  } catch (e) {
    resultado.erroCaptura = e.message;
    try {
      await pool.query(
        `UPDATE esims SET qr_code_email_erro=$1 WHERE iccid=$2`,
        [e.message, iccid]
      );
    } catch {}
    return resultado;
  }
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

function vendedorPrincipalOnly(req, res, next) {
  if (req.user.role !== 'vendedor') return res.status(403).json({ erro: 'Acesso permitido apenas ao vendedor principal' });
  next();
}

function supabaseStorageConfigurado() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY && SUPABASE_BUCKET);
}

function validarArquivoLogo(file) {
  if (!file) throw new Error('Nenhum logo enviado');
  const tiposPermitidos = ['image/png', 'image/jpeg', 'image/webp'];
  if (!tiposPermitidos.includes(file.mimetype)) {
    throw new Error('Formato inválido. Envie PNG, JPG ou WEBP. Recomendado: PNG transparente 300 x 120 px.');
  }
  if (file.size > 500 * 1024) {
    throw new Error('Logo acima de 500 KB. Comprima a imagem e envie novamente.');
  }
}

function extensaoLogoPorMime(mimetype) {
  if (mimetype === 'image/jpeg') return 'jpg';
  if (mimetype === 'image/webp') return 'webp';
  return 'png';
}

function montarCaminhoLogoSupabase({ file, vendedorId }) {
  const pasta = String(SUPABASE_FOLDER || 'parceiros/logos').replace(/^\/+|\/+$/g, '');
  const ext = extensaoLogoPorMime(file.mimetype);
  return `${pasta}/vendedor-${vendedorId}-${Date.now()}.${ext}`;
}

function montarUrlPublicaSupabase(objectPath) {
  const encodedPath = String(objectPath || '')
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
  return `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(SUPABASE_BUCKET)}/${encodedPath}`;
}

function pareceUrlImagemDireta(url) {
  return /^https?:\/\/.+\.(png|jpe?g|webp|svg)(\?.*)?$/i.test(String(url || '').trim());
}

function obterMoveLogoUrl() {
  if (MOVE_LOGO_URL && pareceUrlImagemDireta(MOVE_LOGO_URL)) return MOVE_LOGO_URL;
  if (!SUPABASE_URL || !SUPABASE_BUCKET || !SUPABASE_MOVE_LOGO_PATH) return null;
  return montarUrlPublicaSupabase(SUPABASE_MOVE_LOGO_PATH);
}

async function uploadLogoSupabase({ file, vendedorId }) {
  if (!supabaseStorageConfigurado()) {
    throw new Error('Supabase Storage não configurado. Configure SUPABASE_URL, SUPABASE_SECRET_KEY e SUPABASE_BUCKET.');
  }
  validarArquivoLogo(file);

  const objectPath = montarCaminhoLogoSupabase({ file, vendedorId });
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${objectPath}`;

  await axios.post(uploadUrl, file.buffer, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      apikey: SUPABASE_SECRET_KEY,
      'Content-Type': file.mimetype,
      'x-upsert': 'true',
      'Cache-Control': '3600'
    },
    maxContentLength: 2 * 1024 * 1024,
    timeout: 30000
  });

  return {
    logo_url: montarUrlPublicaSupabase(objectPath),
    logo_public_id: objectPath
  };
}

async function removerLogoSupabase(objectPath) {
  if (!objectPath || !supabaseStorageConfigurado()) return;
  try {
    await axios.delete(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}`, {
      headers: {
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        apikey: SUPABASE_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      data: { prefixes: [objectPath] },
      timeout: 15000
    });
  } catch (e) {
    console.warn('[Supabase Storage] Não foi possível remover logo antigo:', e.response?.data || e.message);
  }
}

function adminOuVendedorPrincipal(req, res, next) {
  if (!['admin', 'vendedor'].includes(req.user.role)) {
    return res.status(403).json({ erro: 'Acesso negado' });
  }
  next();
}

async function resolverEscopoVenda(req, vendedorIdInformado = null) {
  if (req.user.role === 'subvendedor') {
    let parentId = req.user.parent_id || null;
    if (!parentId) {
      const { rows } = await pool.query('SELECT parent_id FROM vendedores WHERE id=$1 AND role=$2', [req.user.id, 'subvendedor']);
      parentId = rows[0]?.parent_id || null;
    }
    if (!parentId) throw new Error('Subvendedor sem vendedor principal vinculado');
    return { vendedor_id: parentId, subvendedor_id: req.user.id };
  }
  if (req.user.role === 'vendedor') {
    return { vendedor_id: req.user.id, subvendedor_id: null };
  }
  return { vendedor_id: vendedorIdInformado || req.user.id, subvendedor_id: null };
}


// ─── Diagnóstico de deploy ───────────────────────────────────────────────────
// Use esta rota para confirmar se o Railway está rodando esta versão do backend.
// Não retorna credenciais nem dados sensíveis.
app.get('/api/deploy/check', (req, res) => {
  res.json({
    ok: true,
    app: 'Move Bora Vendas',
    build: MOVE_BUILD_TAG_QRCODE_ESIM,
    qrcodeEsimRoute: '/api/bora/esim/:iccid/qrcode',
    resendConfigured: Boolean(RESEND_API_KEY),
    emailAuto: ESIM_EMAIL_AUTO,
    timestamp: new Date().toISOString()
  });
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await pool.query('SELECT * FROM vendedores WHERE email=$1 AND ativo=true', [email]);
    if (!rows.length) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const v = rows[0];
    const ok = await bcrypt.compare(senha, v.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const token = jwt.sign({ id: v.id, nome: v.nome, email: v.email, role: v.role, parent_id: v.parent_id || null }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, id: v.id, nome: v.nome, role: v.role, parent_id: v.parent_id || null });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── VENDEDORES / SUBVENDEDORES ──────────────────────────────────────────────
app.get('/api/vendedores', authMiddleware, adminOuVendedorPrincipal, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const params = isAdmin ? [] : [req.user.id];
    const filtro = isAdmin
      ? "v.role = 'vendedor' AND v.parent_id IS NULL"
      : "v.role = 'subvendedor' AND v.parent_id = $1";
    const joinLinhas = isAdmin ? 'l.vendedor_id = v.id' : 'l.subvendedor_id = v.id';
    const joinTransacoes = isAdmin ? 't.vendedor_id = v.id' : 't.subvendedor_id = v.id';

    const { rows } = await pool.query(
      `SELECT v.id, v.nome, v.email, v.telefone, v.ativo, v.criado_em, v.role, v.parent_id,
        COUNT(DISTINCT l.id) AS total_linhas,
        COALESCE(SUM(t.comissao),0) AS total_comissao
       FROM vendedores v
       LEFT JOIN linhas l ON ${joinLinhas}
       LEFT JOIN transacoes t ON ${joinTransacoes}
       WHERE ${filtro}
       GROUP BY v.id ORDER BY v.nome`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/vendedores', authMiddleware, adminOuVendedorPrincipal, async (req, res) => {
  try {
    const { nome, email, senha, telefone, permissoes } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Nome, email e senha são obrigatórios' });
    const hash = await bcrypt.hash(senha, 10);
    const roleNovo = req.user.role === 'admin' ? 'vendedor' : 'subvendedor';
    const parentId = req.user.role === 'admin' ? null : req.user.id;
    const { rows } = await pool.query(
      `INSERT INTO vendedores (nome, email, senha_hash, telefone, role, ativo, parent_id)
       VALUES ($1,$2,$3,$4,$5,true,$6)
       RETURNING id, nome, email, role, parent_id`,
      [nome, email, hash, telefone || null, roleNovo, parentId]
    );
    if (Array.isArray(permissoes)) {
      for (const perm of permissoes) {
        await pool.query('INSERT INTO vendedor_permissoes (vendedor_id, permissao) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, perm]);
      }
    }
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ erro: 'Já existe usuário com este email' });
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/vendedores/:id', authMiddleware, adminOuVendedorPrincipal, async (req, res) => {
  try {
    const alvoId = req.params.id;
    const paramsAlvo = req.user.role === 'admin'
      ? [alvoId]
      : [alvoId, req.user.id];
    const sqlAlvo = req.user.role === 'admin'
      ? "SELECT id FROM vendedores WHERE id=$1 AND role='vendedor' AND parent_id IS NULL"
      : "SELECT id FROM vendedores WHERE id=$1 AND role='subvendedor' AND parent_id=$2";
    const { rows: alvo } = await pool.query(sqlAlvo, paramsAlvo);
    if (!alvo.length) return res.status(403).json({ erro: 'Vendedor fora do seu escopo' });

    const { nome, telefone, ativo, senha, permissoes } = req.body;
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await pool.query('UPDATE vendedores SET nome=$1, telefone=$2, ativo=$3, senha_hash=$4 WHERE id=$5',
        [nome, telefone || null, ativo, hash, alvoId]);
    } else {
      await pool.query('UPDATE vendedores SET nome=$1, telefone=$2, ativo=$3 WHERE id=$4',
        [nome, telefone || null, ativo, alvoId]);
    }
    if (permissoes) {
      await pool.query('DELETE FROM vendedor_permissoes WHERE vendedor_id=$1', [alvoId]);
      for (const perm of permissoes) {
        await pool.query('INSERT INTO vendedor_permissoes (vendedor_id, permissao) VALUES ($1,$2) ON CONFLICT DO NOTHING', [alvoId, perm]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/vendedores/:id/permissoes', authMiddleware, async (req, res) => {
  try {
    const alvoId = parseInt(req.params.id);
    if (req.user.role === 'vendedor') {
      const { rows: alvo } = await pool.query("SELECT id FROM vendedores WHERE id=$1 AND role='subvendedor' AND parent_id=$2", [alvoId, req.user.id]);
      if (!alvo.length && alvoId !== parseInt(req.user.id)) return res.status(403).json({ erro: 'Acesso negado' });
    } else if (req.user.role === 'subvendedor' && alvoId !== parseInt(req.user.id)) {
      return res.status(403).json({ erro: 'Acesso negado' });
    }
    const { rows } = await pool.query('SELECT permissao FROM vendedor_permissoes WHERE vendedor_id=$1', [alvoId]);
    res.json(rows.map(r => r.permissao));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/minhas-permissoes', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.json(['consulta','recarga','portabilidade','boleto_combado','troca_plano','ativacao']);
    const { rows } = await pool.query('SELECT permissao FROM vendedor_permissoes WHERE vendedor_id=$1', [req.user.id]);
    res.json(rows.map(r => r.permissao));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── ADMINISTRADORES (admin) ─────────────────────────────────────────────────
app.get('/api/admins', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome, email, telefone, ativo, criado_em
       FROM vendedores
       WHERE role='admin'
       ORDER BY nome`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/admins', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nome, email, senha, telefone } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Nome, email e senha são obrigatórios' });
    const hash = await bcrypt.hash(senha, 10);
    const { rows } = await pool.query(
      `INSERT INTO vendedores (nome, email, senha_hash, telefone, role, ativo)
       VALUES ($1,$2,$3,$4,'admin',true)
       RETURNING id, nome, email, telefone, role, ativo`,
      [nome, email, hash, telefone || null]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ erro: 'Já existe usuário com este email' });
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/admins/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nome, telefone, ativo, senha } = req.body;
    const adminId = req.params.id;
    const { rows: existe } = await pool.query("SELECT id FROM vendedores WHERE id=$1 AND role='admin'", [adminId]);
    if (!existe.length) return res.status(404).json({ erro: 'Administrador não encontrado' });
    if (parseInt(adminId) === parseInt(req.user.id) && ativo === false) {
      return res.status(400).json({ erro: 'Você não pode desativar seu próprio acesso' });
    }
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await pool.query(
        "UPDATE vendedores SET nome=$1, telefone=$2, ativo=$3, senha_hash=$4 WHERE id=$5 AND role='admin'",
        [nome, telefone || null, ativo, hash, adminId]
      );
    } else {
      await pool.query(
        "UPDATE vendedores SET nome=$1, telefone=$2, ativo=$3 WHERE id=$4 AND role='admin'",
        [nome, telefone || null, ativo, adminId]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── MINHA SENHA ─────────────────────────────────────────────────────────────
app.put('/api/minha-senha', authMiddleware, async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body;
    if (!senhaAtual || !novaSenha) return res.status(400).json({ erro: 'Informe a senha atual e a nova senha' });
    if (String(novaSenha).length < 6) return res.status(400).json({ erro: 'A nova senha deve ter pelo menos 6 caracteres' });
    const { rows } = await pool.query('SELECT senha_hash FROM vendedores WHERE id=$1 AND ativo=true', [req.user.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const ok = await bcrypt.compare(senhaAtual, rows[0].senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query('UPDATE vendedores SET senha_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
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
    const isSubvendedorProprio = req.user.role === 'subvendedor' && parseInt(req.user.id) === parseInt(vendedorId);
    if (req.user.role !== 'admin' && parseInt(req.user.id) !== parseInt(vendedorId)) {
      return res.status(403).json({ erro: 'Acesso negado' });
    }
    const { data_inicio, data_fim } = req.query;
    const params = [vendedorId];
    let filtro = '';
    if (data_inicio && data_fim) {
      filtro = ` AND (
        CASE WHEN t.fonte IN ('retroativo','bora_details','bora_polling')
          THEN t.periodo_referencia BETWEEN $2 AND $3
          ELSE t.data_transacao::date::text BETWEEN $2 AND $3
        END
      )`;
      params.push(data_inicio, data_fim);
    }
    const { rows: transacoes } = await pool.query(
      `SELECT t.*, l.msisdn, l.nome_cliente, l.iccid
       FROM transacoes t
       LEFT JOIN linhas l ON l.id = t.linha_id
       WHERE ${isSubvendedorProprio ? 't.subvendedor_id' : 't.vendedor_id'} = $1${filtro}
       ORDER BY COALESCE(t.periodo_referencia, t.data_transacao::date::text) DESC`,
      params
    );
    const filtroResumo = filtro.replace(/t\./g, '');
    const { rows: resumo } = await pool.query(
      `SELECT tipo, COUNT(*) as quantidade, COALESCE(SUM(comissao),0) as total_comissao
       FROM transacoes WHERE ${isSubvendedorProprio ? 'subvendedor_id' : 'vendedor_id'}=$1${filtroResumo}
       GROUP BY tipo`,
      params
    );
    const { rows: linhas } = await pool.query(
      `SELECT * FROM linhas WHERE ${isSubvendedorProprio ? 'subvendedor_id' : 'vendedor_id'}=$1 ORDER BY data_ativacao DESC`,
      [vendedorId]
    );
    res.json({ transacoes, resumo, linhas });
  } catch (e) {
    console.error('[RELATORIO VENDEDOR]', e.message, e.stack);
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
       AND v.role='vendedor' AND v.parent_id IS NULL
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


app.get('/api/bora/esim/:iccid/qrcode', authMiddleware, async (req, res) => {
  try {
    const { esimInfo, qrCodeUrl } = await capturarQrCodeEsim(req.params.iccid);
    res.json({ ok: true, iccid: req.params.iccid, qrCodeUrl, esimInfo });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});


// Alias administrativo para o mesmo endpoint de QR Code, mantendo compatibilidade com o padrão Subscriber.
app.get('/api/bora/subscriber/:iccid/qrcode', authMiddleware, async (req, res) => {
  try {
    const { esimInfo, qrCodeUrl } = await capturarQrCodeEsim(req.params.iccid);
    res.json({ ok: true, iccid: req.params.iccid, qrCodeUrl, esimInfo });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

app.post('/api/esim/:iccid/enviar-qrcode', authMiddleware, async (req, res) => {
  try {
    const { email, nome, msisdn } = req.body || {};
    let destino = email;
    let nomeCliente = nome;
    let numero = msisdn;

    if (!destino || !nomeCliente || !numero) {
      const { rows } = await pool.query('SELECT * FROM esims WHERE iccid=$1 LIMIT 1', [req.params.iccid]);
      if (rows.length) {
        destino = destino || rows[0].qr_code_email_destino;
        nomeCliente = nomeCliente || rows[0].nome_cliente;
        numero = numero || rows[0].msisdn;
      }
    }

    const resultado = await capturarSalvarEnviarQrCodeEsim({
      iccid: req.params.iccid,
      email: destino,
      nome: nomeCliente,
      msisdn: numero
    });

    if (!resultado.emailEnviado) {
      return res.status(400).json({ ok: false, ...resultado });
    }

    res.json({ ok: true, ...resultado });
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
    const lista = Array.isArray(data) ? data : (data?.plans || data?.items || []);
    res.json(lista.filter(p => /gb/i.test(p.name || p.nome || '')));
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

    const cartBody = {
      iccid: cartPayload.iccid,
      ddd: cartPayload.ddd,
      planId: cartPayload.planId,
      planType: cartPayload.planType || 'Controle',
      clientId
    };
    if (cartPayload.msisdnPortabilidade) {
      cartBody.msisdn = cartPayload.msisdnPortabilidade;
    }
    const cart = await boraPost('/api/Cart/subscription', cartBody);
    const cartId = cart.cartId || cart.id;
    if (!cartId) throw new Error('cartId não retornado pela Bora');

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

    const { rows: planoRows } = await pool.query(
      'SELECT comissao_ativacao FROM planos_comissao WHERE plano_id=$1',
      [plano_id]
    );
    const comissao = planoRows[0]?.comissao_ativacao || 0;

    const { vendedor_id: vendedorPrincipalId, subvendedor_id: subvendedorId } = await resolverEscopoVenda(req, vendedor_id);
    const iccid = cartPayload.iccid || subscriber.iccid;
    const msisdn = pagamento.msisdn || cartPayload.msisdn || null;
    const { rows: linhaRows } = await pool.query(
      `INSERT INTO linhas (iccid, msisdn, vendedor_id, subvendedor_id, plano_id, plano_nome, documento_cliente, nome_cliente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (iccid) DO UPDATE SET msisdn=$2, vendedor_id=$3, subvendedor_id=$4, plano_id=$5, plano_nome=$6
       RETURNING id`,
      [iccid, msisdn, vendedorPrincipalId, subvendedorId, plano_id, plano_nome, subscriber.document, subscriber.name]
    );
    const linhaId = linhaRows[0].id;

    await pool.query(
      `INSERT INTO transacoes (linha_id, vendedor_id, subvendedor_id, tipo, plano_id, plano_nome, valor_plano, comissao, fonte)
       VALUES ($1,$2,$3,'ativacao',$4,$5,$6,$7,'sistema')`,
      [linhaId, vendedorPrincipalId, subvendedorId, plano_id, plano_nome, plano_valor, comissao]
    );

    const pixData = pagamento?.pix || null;
    const msisdnFinal = pagamento?.msisdn || pagamento?.pmsisdn || cartPayload.msisdn || null;

    try {
      await pool.query(
        `UPDATE esims SET status='usado', vendedor_id=$1, msisdn=$2,
         nome_cliente=$3, documento_cliente=$4, usado_em=NOW()
         WHERE iccid=$5`,
        [vendedorPrincipalId, msisdnFinal, subscriber.name, subscriber.document, iccid]
      );
    } catch {}

    const esim = await capturarSalvarEnviarQrCodeEsim({
      iccid,
      email: subscriber.email,
      nome: subscriber.name,
      msisdn: msisdnFinal
    });

    res.json({
      ok: true,
      cartId,
      comissao,
      msisdn: msisdnFinal,
      esim,
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

app.get('/api/bora/historic/:msisdn', authMiddleware, async (req, res) => {
  try {
    const details = await boraGet(`/api/Subscription/${req.params.msisdn}/details`);
    res.json(details);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

// ─── Calculadora: simula recargas por período com /details ────────────────────
app.post('/api/calculadora/simular', authMiddleware, async (req, res) => {
  try {
    const { msisdn, plano_id, data_inicio, data_fim } = req.body;

    const numeros = msisdn.split(',')
      .map(n => n.trim())
      .filter(n => n.length >= 8)
      .map(n => n.startsWith('55') ? n : '55' + n);

    if (!numeros.length) throw new Error('Nenhum número válido informado');

    const { rows: planosComissao } = await pool.query('SELECT * FROM planos_comissao');
    const mapaComissaoId = {};
    const mapaComissaoNome = {};
    planosComissao.forEach(p => {
      mapaComissaoId[String(p.plano_id)] = p;
      mapaComissaoNome[String(p.plano_nome).toUpperCase().trim()] = p;
    });

    function buscarComissao(planId, planNome) {
      return mapaComissaoId[String(planId || '')] ||
             mapaComissaoNome[String(planNome || '').toUpperCase().trim()] ||
             null;
    }

    async function processarNumero(msisdnNorm) {
      try {
        const details = await boraGet(`/api/Subscription/${msisdnNorm}/details`);
        const dataAtivacao = details?.activationDate || null;
        const statusLinha  = details?.status || '—';
        let planArray = Array.isArray(details?.plan) ? details.plan : [];

        if (data_inicio || data_fim) {
          const ini = data_inicio ? new Date(data_inicio) : null;
          const fim = data_fim ? new Date(data_fim + 'T23:59:59') : null;
          planArray = planArray.filter(p => {
            const d = new Date(p.createdAt || p.expiration || '');
            if (ini && d < ini) return false;
            if (fim && d > fim) return false;
            return true;
          });
        }

        const planoRecente = planArray.length ? planArray[planArray.length - 1] : null;
        const planoAtualNome = planoRecente?.name || 'Sem plano';
        const resultado = [];

        if (dataAtivacao) {
          const primeiroPlano = planArray[0] || null;
          const comissaoAtiv = buscarComissao(primeiroPlano?.planId, primeiroPlano?.name);
          resultado.push({
            mes: dataAtivacao.substring(0, 7),
            tipo: 'ativacao',
            plano_nome: primeiroPlano?.name || '—',
            data: dataAtivacao,
            comissao: parseFloat(comissaoAtiv?.comissao_ativacao || 0),
            sem_config: !comissaoAtiv
          });
        }

        for (let i = 1; i < planArray.length; i++) {
          const p = planArray[i];
          const comissaoRec = buscarComissao(p.planId, p.name);
          resultado.push({
            mes: (p.createdAt || '').substring(0, 7),
            tipo: 'recarga',
            plano_nome: p.name || '—',
            data: p.createdAt || null,
            comissao: parseFloat(comissaoRec?.comissao_recarga || 0),
            sem_config: !comissaoRec
          });
        }

        const totalLinha = resultado.reduce((a, r) => a + r.comissao, 0);
        return { msisdn: msisdnNorm, plano_atual_nome: planoAtualNome, data_ativacao: dataAtivacao, status: statusLinha, total_comissao: totalLinha, resultado };
      } catch (err) {
        return { msisdn: msisdnNorm, erro: err.response?.data?.detail || err.message, resultado: [] };
      }
    }

    const linhas = [];
    const LOTE = 5;
    for (let i = 0; i < numeros.length; i += LOTE) {
      const lote = numeros.slice(i, i + LOTE);
      const resultados = await Promise.all(lote.map(processarNumero));
      linhas.push(...resultados);
    }

    const totalGeralComissao = linhas.reduce((a, l) => a + (l.total_comissao || 0), 0);
    res.json({ linhas, total_geral: totalGeralComissao });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message });
  }
});

// ─── Registrar comissões retroativas ─────────────────────────────────────────
app.post('/api/comissao/registrar-retroativo', authMiddleware, async (req, res) => {
  try {
    const { msisdn, vendedor_id, plano_id, plano_nome, recargas } = req.body;
    const escopo = await resolverEscopoVenda(req, vendedor_id);

    let { rows: linhaRows } = await pool.query(
      'SELECT id FROM linhas WHERE msisdn=$1', [msisdn]
    );

    let linhaId;
    if (!linhaRows.length) {
      const ins = await pool.query(
        `INSERT INTO linhas (iccid, msisdn, vendedor_id, subvendedor_id, plano_id, plano_nome, status)
         VALUES ($1,$2,$3,$4,$5,$6,'ativa') RETURNING id`,
        [`retroativo-${msisdn}`, msisdn, escopo.vendedor_id, escopo.subvendedor_id, plano_id, plano_nome]
      );
      linhaId = ins.rows[0].id;
    } else {
      linhaId = linhaRows[0].id;
      await pool.query(
        'UPDATE linhas SET vendedor_id=$1, subvendedor_id=$2, plano_id=$3, plano_nome=$4 WHERE id=$5',
        [escopo.vendedor_id, escopo.subvendedor_id, plano_id, plano_nome, linhaId]
      );
    }

    let inseridas = 0;
    for (const r of recargas || []) {
      const periodoCheck = String(r.periodo || '').substring(0, 7);
      const { rows: existe } = await pool.query(
        "SELECT id FROM transacoes WHERE linha_id=$1 AND tipo='recarga' AND LEFT(periodo_referencia,7)=$2",
        [linhaId, periodoCheck]
      );
      if (existe.length) continue;
      const periodoNorm = String(r.periodo || '').substring(0, 7);
      await pool.query(
        `INSERT INTO transacoes (linha_id, vendedor_id, subvendedor_id, tipo, plano_id, plano_nome, comissao, periodo_referencia, fonte)
         VALUES ($1,$2,$3,'recarga',$4,$5,$6,$7,'retroativo')
         ON CONFLICT DO NOTHING`,
        [linhaId, escopo.vendedor_id, escopo.subvendedor_id, plano_id, plano_nome, r.comissao, periodoNorm]
      );
      inseridas++;
    }

    res.json({ ok: true, inseridas });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── E-SIM — Import via upload ───────────────────────────────────────────────
const multer = require('multer');
const XLSX = require('xlsx');
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });


// ─── MARCA DO VENDEDOR PRINCIPAL / APP ──────────────────────────────────────
app.get('/api/minha-marca', authMiddleware, vendedorPrincipalOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome, nome_exibicao, logo_url, logo_public_id
       FROM vendedores
       WHERE id=$1 AND role='vendedor' AND parent_id IS NULL`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Vendedor principal não encontrado' });
    res.json({
      nome: rows[0].nome,
      nome_exibicao: rows[0].nome_exibicao || rows[0].nome,
      logo_url: rows[0].logo_url || null,
      supabaseStorageConfigurado: supabaseStorageConfigurado()
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/minha-marca', authMiddleware, vendedorPrincipalOnly, uploadMem.single('logo'), async (req, res) => {
  try {
    const nomeExibicao = String(req.body.nome_exibicao || '').trim().slice(0, 150) || null;
    let novoLogo = null;

    const { rows: atualRows } = await pool.query(
      `SELECT logo_public_id FROM vendedores WHERE id=$1 AND role='vendedor' AND parent_id IS NULL`,
      [req.user.id]
    );
    if (!atualRows.length) return res.status(404).json({ erro: 'Vendedor principal não encontrado' });

    if (req.file) {
      novoLogo = await uploadLogoSupabase({ file: req.file, vendedorId: req.user.id });
      if (atualRows[0].logo_public_id) await removerLogoSupabase(atualRows[0].logo_public_id);
      await pool.query(
        `UPDATE vendedores
         SET nome_exibicao=$1, logo_url=$2, logo_public_id=$3
         WHERE id=$4 AND role='vendedor' AND parent_id IS NULL`,
        [nomeExibicao, novoLogo.logo_url, novoLogo.logo_public_id, req.user.id]
      );
    } else {
      await pool.query(
        `UPDATE vendedores SET nome_exibicao=$1 WHERE id=$2 AND role='vendedor' AND parent_id IS NULL`,
        [nomeExibicao, req.user.id]
      );
    }

    const { rows } = await pool.query(
      `SELECT nome, nome_exibicao, logo_url FROM vendedores WHERE id=$1`,
      [req.user.id]
    );
    res.json({ ok: true, nome_exibicao: rows[0].nome_exibicao || rows[0].nome, logo_url: rows[0].logo_url || null });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/minha-marca/logo', authMiddleware, vendedorPrincipalOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT logo_public_id FROM vendedores WHERE id=$1 AND role='vendedor' AND parent_id IS NULL`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Vendedor principal não encontrado' });
    if (rows[0].logo_public_id) await removerLogoSupabase(rows[0].logo_public_id);
    await pool.query(
      `UPDATE vendedores SET logo_url=NULL, logo_public_id=NULL WHERE id=$1 AND role='vendedor' AND parent_id IS NULL`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

async function buscarBrandingPorFiltro(filtroSql, valor) {
  const { rows } = await pool.query(
    `SELECT v.nome, v.nome_exibicao, v.logo_url
     FROM linhas l
     JOIN vendedores v ON v.id = l.vendedor_id
     WHERE ${filtroSql}
       AND v.role='vendedor'
       AND v.parent_id IS NULL
     ORDER BY l.data_ativacao DESC NULLS LAST, l.id DESC
     LIMIT 1`,
    [valor]
  );
  const parceiro = rows[0] || null;
  return {
    moveLogoUrl: obterMoveLogoUrl(),
    parceiroNome: parceiro ? (parceiro.nome_exibicao || parceiro.nome) : null,
    parceiroLogoUrl: parceiro?.logo_url || null,
    temParceiro: Boolean(parceiro && parceiro.logo_url)
  };
}


app.get('/api/app/branding/move', (req, res) => {
  res.json({
    moveLogoUrl: obterMoveLogoUrl()
  });
});

app.get('/api/app/linha/:msisdn/branding', async (req, res) => {
  try {
    const digits = String(req.params.msisdn || '').replace(/\D/g, '');
    if (!digits || digits.length < 8) return res.status(400).json({ erro: 'Número inválido' });
    const data = await buscarBrandingPorFiltro(
      `RIGHT(regexp_replace(COALESCE(l.msisdn,''), '\\D', '', 'g'), 11) = RIGHT($1, 11)`,
      digits
    );
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/app/cliente/:documento/branding', async (req, res) => {
  try {
    const doc = String(req.params.documento || '').replace(/\D/g, '');
    if (!doc || doc.length < 11) return res.status(400).json({ erro: 'Documento inválido' });
    const data = await buscarBrandingPorFiltro(
      `regexp_replace(COALESCE(l.documento_cliente,''), '\\D', '', 'g') = $1`,
      doc
    );
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/esim/importar', authMiddleware, adminOnly, uploadMem.single('planilha'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Nenhum arquivo enviado');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    let inseridos = 0;
    let ignorados = 0;

    for (const row of rows) {
      let iccid = null;
      let statusCol = null;
      for (let i = 0; i < row.length; i++) {
        const val = String(row[i] || '').trim().replace(/\s/g,'');
        if (val.startsWith('89') && val.length >= 18) {
          iccid = val;
          statusCol = String(row[i + 1] || '').trim().toUpperCase();
          break;
        }
      }
      if (!iccid) continue;
      if (statusCol && statusCol !== '') { ignorados++; continue; }

      try {
        await pool.query(
          `INSERT INTO esims (iccid, status) VALUES ($1, 'disponivel')
           ON CONFLICT (iccid) DO NOTHING`,
          [iccid]
        );
        inseridos++;
      } catch { ignorados++; }
    }

    res.json({ ok: true, inseridos, ignorados });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/esim/disponiveis', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM esims WHERE status='disponivel' ORDER BY importado_em ASC"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/esim/contagem', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*) as total FROM esims WHERE status='disponivel'"
    );
    res.json({ total: parseInt(rows[0].total) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/esim/:iccid/usar', authMiddleware, async (req, res) => {
  try {
    const { vendedor_id, msisdn, nome_cliente, documento_cliente } = req.body;
    await pool.query(
      `UPDATE esims SET status='usado', vendedor_id=$1, msisdn=$2,
       nome_cliente=$3, documento_cliente=$4, usado_em=NOW()
       WHERE iccid=$5`,
      [vendedor_id, msisdn, nome_cliente, documento_cliente, req.params.iccid]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/esim/historico', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, v.nome as vendedor_nome
       FROM esims e LEFT JOIN vendedores v ON v.id = e.vendedor_id
       ORDER BY e.importado_em DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── CLIENTE APP ──────────────────────────────────────────────────────────────
const bcryptCliente = require('bcryptjs');
const jwtCliente = require('jsonwebtoken');

app.post('/api/cliente/cadastro', async (req, res) => {
  try {
    const { cpf, nome, senha } = req.body;
    if (!cpf || !nome || !senha) throw new Error('Campos obrigatórios: cpf, nome, senha');

    try {
      await boraGet(`/api/Subscriber/${cpf}/document`);
    } catch {
      return res.status(400).json({ erro: 'CPF não encontrado na base Move. Entre em contato com o suporte.' });
    }

    const hash = await bcryptCliente.hash(senha, 10);
    const { rows } = await pool.query(
      `INSERT INTO clientes (cpf, nome, senha_hash) VALUES ($1,$2,$3)
       ON CONFLICT (cpf) DO UPDATE SET nome=$2, senha_hash=$3
       RETURNING id, cpf, nome`,
      [cpf, nome, hash]
    );
    const cliente = rows[0];
    const token = jwtCliente.sign({ id: cliente.id, cpf: cliente.cpf, nome: cliente.nome }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, cliente });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/cliente/login', async (req, res) => {
  try {
    const { cpf, senha } = req.body;
    const { rows } = await pool.query('SELECT * FROM clientes WHERE cpf=$1', [cpf]);
    if (!rows.length) return res.status(401).json({ erro: 'CPF ou senha incorretos' });
    const ok = await bcryptCliente.compare(senha, rows[0].senha_hash);
    if (!ok) return res.status(401).json({ erro: 'CPF ou senha incorretos' });
    const cliente = rows[0];
    const token = jwtCliente.sign({ id: cliente.id, cpf: cliente.cpf, nome: cliente.nome }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, cliente: { id: cliente.id, cpf: cliente.cpf, nome: cliente.nome } });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

function authCliente(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    req.cliente = jwtCliente.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

app.get('/api/cliente/linhas/:cpf', authCliente, async (req, res) => {
  try {
    const cpf = req.params.cpf;
    const subs = await boraGet(`/api/Subscription/${cpf}`);
    const lista = Array.isArray(subs) ? subs : (subs.subscriptions || subs.items || []);
    if (!lista.length) return res.json({ linhas: [] });
    const detalhes = await Promise.all(
      lista.slice(0,10).map(async s => {
        try {
          const ms = s.msisdn || s.phoneNumber || s.number;
          if (!ms) return s;
          return await boraGet(`/api/Subscription/${ms}/details`);
        } catch { return s; }
      })
    );
    res.json({ linhas: detalhes });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.get('/api/cliente/linha/:cpf', authCliente, async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/\D/g, '');
    const subscriber = await boraGet(`/api/Subscriber/${cpf}/document`);
    if (!subscriber) throw new Error('Subscriber não encontrado');
    const linhas = await boraGet(`/api/Subscription/${cpf}`);
    const lista = Array.isArray(linhas) ? linhas : (linhas?.subscriptions || linhas?.items || [linhas]);
    if (!lista.length) throw new Error('Nenhuma linha encontrada');
    const primeiraLinha = lista[0];
    const identificador = primeiraLinha?.msisdn || primeiraLinha?.iccid || primeiraLinha?.identifier;
    if (!identificador) throw new Error('Identificador da linha não encontrado');
    const details = await boraGet(`/api/Subscription/${identificador}/details`);
    res.json({ linha: details });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.get('/api/cliente/consumo/:msisdn', authCliente, async (req, res) => {
  try {
    const data = await boraGet(`/api/Subscription/${req.params.msisdn}/consumption`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.get('/api/bora/consumo/:msisdn', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet(`/api/Subscription/${req.params.msisdn}/consumption`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.get('/api/cliente/planos-recarga/:msisdn', authCliente, async (req, res) => {
  try {
    const data = await boraGet('/api/Plan/Recharge', { msisdn: req.params.msisdn });
    const lista = Array.isArray(data) ? data : (data?.plans || data?.items || []);
    res.json(lista.filter(p => /gb/i.test(p.name || p.nome || '')));
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.post('/api/cliente/recarregar', authCliente, async (req, res) => {
  try {
    const { msisdn, plano_id, plano_nome, pagamento } = req.body;
    const subDetails = await boraGet(`/api/Subscription/${msisdn}/details`);
    const clientId = subDetails?.boraIntegration?.customerId || subDetails?.boraData?.customerId || null;
    const cart = await boraPost('/api/Cart/recharge', { msisdn, planId: plano_id, clientId });
    const cartId = cart.cartId || cart.id;
    if (!cartId) throw new Error('cartId não retornado pela Bora');
    let pagamentoResp;
    if (pagamento === 'pix') {
      pagamentoResp = await boraPost(`/api/Cart/recharge/${cartId}/pix`, {});
    } else if (pagamento === 'billet') {
      pagamentoResp = await boraPost(`/api/Cart/recharge/${cartId}/billet`, {});
    } else {
      throw new Error('Forma de pagamento inválida');
    }
    const pixData = pagamentoResp?.pix || null;
    res.json({
      ok: true,
      cartId,
      pix: pixData ? { code: pixData.code, qrCodeUrl: pixData.qrCodeUrl } : null,
      billet: pagamentoResp?.billet ? { url: pagamentoResp.billet.url, barcode: pagamentoResp.billet.digitableLine || pagamentoResp.billet.barCode } : null
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});


// ─── PROXY BORA — Recarga pelo painel web ───────────────────────────────────
app.post('/api/bora/recarregar', authMiddleware, async (req, res) => {
  try {
    const { msisdn, plano_id, plano_nome, plano_valor, pagamento } = req.body;
    if (!msisdn || !plano_id || !pagamento) throw new Error('msisdn, plano_id e pagamento são obrigatórios');

    let linhaRows = [];
    const escopo = await resolverEscopoVenda(req, req.body.vendedor_id || null);
    if (req.user.role !== 'admin') {
      const { rows: perms } = await pool.query(
        "SELECT 1 FROM vendedor_permissoes WHERE vendedor_id=$1 AND permissao='recarga'",
        [req.user.id]
      );
      if (!perms.length) return res.status(403).json({ erro: 'Você não tem permissão para fazer recarga' });
      const result = await pool.query('SELECT * FROM linhas WHERE msisdn=$1 AND vendedor_id=$2', [msisdn, escopo.vendedor_id]);
      linhaRows = result.rows;
      if (!linhaRows.length) return res.status(403).json({ erro: 'Linha não encontrada na sua carteira' });
    } else {
      const result = await pool.query('SELECT * FROM linhas WHERE msisdn=$1 LIMIT 1', [msisdn]);
      linhaRows = result.rows;
    }

    const subDetails = await boraGet(`/api/Subscription/${msisdn}/details`);
    const clientId = subDetails?.boraIntegration?.customerId || subDetails?.boraData?.customerId || subDetails?.customerId || null;
    const cart = await boraPost('/api/Cart/recharge', { msisdn, planId: plano_id, clientId });
    const cartId = cart.cartId || cart.id;
    if (!cartId) throw new Error('cartId não retornado pela Bora');

    let pagamentoResp;
    if (pagamento === 'pix') {
      pagamentoResp = await boraPost(`/api/Cart/recharge/${cartId}/pix`, {});
    } else if (pagamento === 'billet') {
      pagamentoResp = await boraPost(`/api/Cart/recharge/${cartId}/billet`, {});
    } else {
      throw new Error('Forma de pagamento inválida');
    }

    // Registra comissão quando a linha estiver vinculada a um vendedor
    const linha = linhaRows[0] || null;
    if (linha?.id && linha?.vendedor_id) {
      const mesRef = new Date().toISOString().substring(0, 7);
      const { rows: existe } = await pool.query(
        `SELECT id FROM transacoes WHERE linha_id=$1 AND tipo='recarga' AND periodo_referencia=$2`,
        [linha.id, mesRef]
      );
      if (!existe.length) {
        const { rows: planoRows } = await pool.query('SELECT comissao_recarga, plano_nome, plano_valor FROM planos_comissao WHERE plano_id=$1', [plano_id]);
        const comissao = parseFloat(planoRows[0]?.comissao_recarga || 0);
        await pool.query(
          `INSERT INTO transacoes (linha_id, vendedor_id, subvendedor_id, tipo, plano_id, plano_nome, valor_plano, comissao, periodo_referencia, fonte)
           VALUES ($1,$2,$3,'recarga',$4,$5,$6,$7,$8,'sistema')`,
          [linha.id, linha.vendedor_id, escopo.subvendedor_id, plano_id, plano_nome || planoRows[0]?.plano_nome || null, plano_valor || planoRows[0]?.plano_valor || null, comissao, mesRef]
        );
      }
    }

    const pixData = pagamentoResp?.pix || null;
    res.json({
      ok: true,
      cartId,
      pix: pixData ? { code: pixData.code || null, qrCodeUrl: pixData.qrCodeUrl || null } : null,
      billet: pagamentoResp?.billet ? {
        url: pagamentoResp.billet.url || pagamentoResp.billet.digitableLine || null,
        barcode: pagamentoResp.billet.digitableLine || pagamentoResp.billet.barCode || null
      } : null
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// ─── CONSULTA DE LINHA ────────────────────────────────────────────────────────
app.get('/api/consulta/linha', authMiddleware, async (req, res) => {
  try {
    const { tipo, valor } = req.query;
    if (req.user.role !== 'admin') {
      const { rows: carteira } = await pool.query(
        'SELECT * FROM linhas WHERE vendedor_id=$1', [req.user.id]
      );
      const linha = carteira.find(l =>
        l.msisdn === valor || l.iccid === valor ||
        l.documento_cliente === valor.replace(/\D/g,'')
      );
      if (!linha) return res.status(403).json({ erro: 'Linha não encontrada na sua carteira' });
      const details = await boraGet(`/api/Subscription/${linha.msisdn}/details`);
      return res.json({ linhas: [details] });
    }
    let endpoint;
    if (tipo === 'cpf') endpoint = `/api/Subscription/${valor.replace(/\D/g,'')}`;
    else endpoint = `/api/Subscription/${valor}/details`;
    const data = await boraGet(endpoint);
    const lista = Array.isArray(data) ? data : [data];
    const detalhes = await Promise.all(lista.slice(0,10).map(async s => {
      try {
        const ms = s.msisdn || s.phoneNumber || s.number;
        if (!ms || s.activationDate) return s;
        return await boraGet(`/api/Subscription/${ms}/details`);
      } catch { return s; }
    }));
    res.json({ linhas: detalhes });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// ─── PORTABILIDADE ────────────────────────────────────────────────────────────
app.get('/api/portabilidade/lista', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet('/api/Portability/List');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.post('/api/portabilidade/realizar', authMiddleware, async (req, res) => {
  try {
    const data = await boraPost('/api/Portability', req.body);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// ─── PROMOÇÕES ────────────────────────────────────────────────────────────────
app.get('/api/promocoes', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM promocoes WHERE ativo=true AND (validade IS NULL OR validade >= NOW()) ORDER BY criado_em DESC"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/promocoes/todas', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM promocoes ORDER BY criado_em DESC");
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/promocoes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { titulo, descricao, tipo, validade } = req.body;
    const { rows } = await pool.query(
      "INSERT INTO promocoes (titulo, descricao, tipo, validade) VALUES ($1,$2,$3,$4) RETURNING *",
      [titulo, descricao, tipo || 'info', validade || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/promocoes/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { titulo, descricao, tipo, validade, ativo } = req.body;
    const { rows } = await pool.query(
      "UPDATE promocoes SET titulo=$1, descricao=$2, tipo=$3, validade=$4, ativo=$5 WHERE id=$6 RETURNING *",
      [titulo, descricao, tipo, validade || null, ativo, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/promocoes/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query("DELETE FROM promocoes WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── RANKING ──────────────────────────────────────────────────────────────────
app.get('/api/ranking', authMiddleware, async (req, res) => {
  try {
    const { periodo } = req.query;
    let filtro = '';
    if (periodo === 'hoje') filtro = "AND DATE(t.data_transacao) = CURRENT_DATE";
    else if (periodo === 'semana') filtro = "AND t.data_transacao >= NOW() - INTERVAL '7 days'";
    else filtro = "AND DATE_TRUNC('month', t.data_transacao) = DATE_TRUNC('month', NOW())";

    const { rows } = await pool.query(`
      SELECT v.id, v.nome, v.email,
        COUNT(DISTINCT CASE WHEN t.tipo='ativacao' THEN t.id END) as ativacoes,
        COUNT(DISTINCT CASE WHEN t.tipo='recarga' THEN t.id END) as recargas,
        COALESCE(SUM(t.comissao),0) as total_comissao,
        COUNT(DISTINCT t.id) as total_transacoes
      FROM vendedores v
      LEFT JOIN transacoes t ON t.vendedor_id = v.id ${filtro}
      WHERE v.role = 'vendedor' AND v.ativo = true
      GROUP BY v.id, v.nome, v.email
      ORDER BY total_transacoes DESC, total_comissao DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── INADIMPLÊNCIA ────────────────────────────────────────────────────────────
app.get('/api/inadimplencia', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await boraGet('/api/Subscriber/billets/pending');
    res.json(data);
  } catch {
    try {
      const { rows: linhas } = await pool.query(
        "SELECT DISTINCT documento_cliente FROM linhas WHERE status='ativa' AND documento_cliente IS NOT NULL LIMIT 50"
      );
      const resultados = [];
      for (const l of linhas.slice(0,20)) {
        try {
          const boletos = await boraGet(`/api/Subscriber/${l.documento_cliente}/billets`);
          if (Array.isArray(boletos) && boletos.length) {
            resultados.push(...boletos.map(b => ({ ...b, documento: l.documento_cliente })));
          }
        } catch {}
      }
      res.json(resultados);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  }
});

// ─── ALERTAS DE VENCIMENTO (cron diário) ─────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('[ALERTA] Verificando vencimentos...');
  try {
    const { rows: linhas } = await pool.query(`
      SELECT l.*, v.nome as vendedor_nome, v.email as vendedor_email
      FROM linhas l JOIN vendedores v ON v.id = l.vendedor_id
      WHERE l.status = 'ativa' AND l.msisdn IS NOT NULL
    `);
    const hoje = new Date();
    for (const linha of linhas) {
      try {
        const details = await boraGet(`/api/Subscription/${linha.msisdn}/details`);
        const planArray = Array.isArray(details?.plan) ? details.plan : [];
        const ultimo = planArray[planArray.length-1];
        if (!ultimo?.expiration) continue;
        const venc = new Date(ultimo.expiration);
        const diasRestantes = Math.ceil((venc-hoje)/(1000*60*60*24));
        if (diasRestantes <= 3 && diasRestantes >= 0) {
          await pool.query(
            `INSERT INTO alertas_vencimento (linha_id, vendedor_id, msisdn, dias_restantes, data_vencimento)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (linha_id, DATE(NOW())) DO NOTHING`,
            [linha.id, linha.vendedor_id, linha.msisdn, diasRestantes, venc]
          );
          console.log(`[ALERTA] ${linha.msisdn} vence em ${diasRestantes} dias — vendedor: ${linha.vendedor_nome}`);
        }
      } catch {}
    }
  } catch (e) { console.error('[ALERTA] Erro:', e.message); }
});

app.get('/api/alertas/vencimento', authMiddleware, async (req, res) => {
  try {
    const vendedorId = req.user.role === 'admin' ? null : req.user.id;
    const query = vendedorId
      ? `SELECT * FROM alertas_vencimento WHERE vendedor_id=$1 AND data_alerta >= NOW()-INTERVAL '7 days' ORDER BY dias_restantes ASC`
      : `SELECT av.*, v.nome as vendedor_nome FROM alertas_vencimento av JOIN vendedores v ON v.id=av.vendedor_id WHERE av.data_alerta >= NOW()-INTERVAL '7 days' ORDER BY av.dias_restantes ASC`;
    const params = vendedorId ? [vendedorId] : [];
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── BLOQUEIO / DESBLOQUEIO ───────────────────────────────────────────────────
app.post('/api/bora/linha/:msisdn/bloquear', authMiddleware, async (req, res) => {
  try {
    const details = await boraGet(`/api/Subscription/${req.params.msisdn}/details`);
    const accountId = details?.accountId;
    if (!accountId) throw new Error('accountId não encontrado para esta linha');
    const data = await boraPut(`/api/Subscription/temporarily-suspend/${accountId}`, {});
    await pool.query("UPDATE linhas SET status='bloqueada' WHERE msisdn=$1", [req.params.msisdn]);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.post('/api/bora/linha/:msisdn/desbloquear', authMiddleware, async (req, res) => {
  try {
    const details = await boraGet(`/api/Subscription/${req.params.msisdn}/details`);
    const accountId = details?.accountId;
    if (!accountId) throw new Error('accountId não encontrado para esta linha');
    const data = await boraPut(`/api/Subscription/release/${accountId}`, {});
    await pool.query("UPDATE linhas SET status='ativa' WHERE msisdn=$1", [req.params.msisdn]);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// ─── TROCAR PLANO ─────────────────────────────────────────────────────────────
app.get('/api/bora/trocar-plano/:msisdn', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet(`/api/Subscription/changeplan/${req.params.msisdn}`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.post('/api/bora/trocar-plano', authMiddleware, async (req, res) => {
  try {
    const data = await boraPost('/api/Subscription/changeplan', req.body);
    if (req.body.msisdn && req.body.planId) {
      await pool.query(
        "UPDATE linhas SET plano_id=$1 WHERE msisdn=$2",
        [req.body.planId, req.body.msisdn]
      );
    }
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// ─── REATIVAÇÃO DE LINHA ──────────────────────────────────────────────────────
app.get('/api/bora/reativar/:msisdn', authMiddleware, async (req, res) => {
  try {
    const data = await boraGet(`/api/Subscription/reactivation/${req.params.msisdn}`);
    // Tenta resolver o planId pelo nome do plano nos planos de ativação
    if (data && data.planName && !data.planId) {
      try {
        const planos = await boraGet('/api/Plan/Activation');
        const lista = Array.isArray(planos) ? planos : (planos.plans || planos.items || []);
        const match = lista.find(p =>
          String(p.name || p.nome || '').toUpperCase().trim() === String(data.planName).toUpperCase().trim()
        );
        if (match) {
          data.planId = match.idPlanExternal || match.id || match.planId || null;
        }
      } catch {}
    }
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.post('/api/bora/reativar', authMiddleware, async (req, res) => {
  try {
    const { msisdn, planId, paymentType } = req.body;
    if (!msisdn) throw new Error('msisdn obrigatório');
    const body = { msisdn };
    if (planId) body.planId = planId;
    if (paymentType) body.paymentType = paymentType;
    const data = await boraPost('/api/Subscription/reactivation', body);
    await pool.query("UPDATE linhas SET status='ativa' WHERE msisdn=$1", [msisdn]);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// ─── RELATÓRIO DE CHURN ───────────────────────────────────────────────────────
app.get('/api/relatorio/churn', authMiddleware, adminOnly, async (req, res) => {
  try {
    const dias = parseInt(req.query.periodo) || 30;
    const { rows } = await pool.query(
      `SELECT l.msisdn, l.iccid, l.nome_cliente, l.documento_cliente,
        l.plano_nome, l.status, l.data_ativacao, v.nome as vendedor_nome,
        EXTRACT(DAY FROM NOW() - l.data_ativacao)::int as dias_ativo
       FROM linhas l
       LEFT JOIN vendedores v ON v.id = l.vendedor_id
       WHERE l.status IN ('cancelada','suspensa','bloqueada','cancelled','suspended')
         AND l.data_ativacao >= NOW() - ($1 * INTERVAL '1 day')
       ORDER BY l.data_ativacao DESC`,
      [dias]
    );
    res.json({ total: rows.length, periodo: dias, linhas: rows });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── Reenvio de boleto ────────────────────────────────────────────────────────
app.post('/api/bora/boleto/:billetId/reenviar', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      const msisdn = req.body?.msisdn;
      if (!msisdn) return res.status(400).json({ erro: 'Informe o número da linha para validar a carteira do vendedor' });
      const { rows } = await pool.query('SELECT id FROM linhas WHERE msisdn=$1 AND vendedor_id=$2', [msisdn, req.user.id]);
      if (!rows.length) return res.status(403).json({ erro: 'Você só pode reenviar boleto de linhas da sua carteira' });
    }
    const data = await boraPost(`/api/Subscriber/billets/${req.params.billetId}/resend`, {});
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.get('/api/bora/linha/:doc/boleto', authMiddleware, async (req, res) => {
  try {
    const boletos = await boraGet(`/api/Subscriber/${req.params.doc}/billets`);
    const lista = Array.isArray(boletos) ? boletos : (boletos?.items || boletos?.billets || []);
    const b = lista.find(x => !x.paid && !x.paymentDate) || lista[0];
    if (!b) return res.status(404).json({ erro: 'Nenhum boleto encontrado para esta linha' });
    res.json({
      billetId: b.id || b.billetId || null,
      barcode: b.digitableLine || b.barCode || b.typeableLine || '',
      url: b.url || b.pdfUrl || b.link || '',
      dueDate: b.dueDate || b.expiration || null
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

app.post('/api/bora/boleto/enviar-email', authMiddleware, async (req, res) => {
  try {
    const { email, nome, barcode, url } = req.body || {};
    const r = await enviarEmailBoleto({ email, nome, barcode, url });
    res.json({ ok: true, destino: r.destino });
  } catch (e) {
    res.status(400).json({ ok: false, erro: e.message });
  }
});

async function enviarEmailBoleto({ email, nome, barcode, url }) {
  const destino = limparEmail(email);
  if (!destino) throw new Error('E-mail do titular não informado');
  if (!RESEND_API_KEY) throw new Error('Envio de e-mail não configurado (RESEND_API_KEY)');
  const subject = 'Seu boleto Move';
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827">
    <h2 style="margin:0 0 12px">Seu boleto Move</h2>
    <p>Olá${nome ? ', ' + nome : ''}. Segue a linha digitável do seu boleto:</p>
    <div style="background:#f3f4f6;border-radius:8px;padding:14px;font-family:monospace;font-size:14px;word-break:break-all;margin:12px 0">${barcode || ''}</div>
    ${url ? `<p><a href="${url}" style="color:#2563eb">Abrir boleto em PDF</a></p>` : ''}
    <p style="font-size:12px;color:#6b7280;margin-top:24px">Pague pelo app do seu banco usando a linha digitável acima.</p>
  </div>`;
  const text = `Olá${nome ? ', ' + nome : ''}. Linha digitável do seu boleto Move:\n${barcode || ''}${url ? '\n\nBoleto: ' + url : ''}`;
  await axios.post('https://api.resend.com/emails', {
    from: EMAIL_FROM, to: [destino], subject, html, text
  }, { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
  return { destino };
}

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
    const mesRef = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;

    let detectadas = 0;
    let atualizadas = 0;

    for (const linha of linhas) {
      try {
        const details = await boraGet(`/api/Subscription/${linha.msisdn}/details`);

        const planoAtualId = details?.planData?.id || details?.plan?.id || details?.planId || null;
        const planoAtualNome = details?.planData?.name || details?.plan?.name || details?.planName || linha.plano_nome;
        const statusLinha = details?.status || details?.lineStatus || 'ativa';

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

        const statusNorm = String(statusLinha).toLowerCase();
        if (statusNorm.includes('suspend') || statusNorm.includes('cancel') || statusNorm.includes('inativ')) {
          await pool.query('UPDATE linhas SET status=$1 WHERE id=$2', [statusNorm, linha.id]);
          console.log(`[CRON] Linha ${linha.msisdn} suspensa/cancelada — ignorando recarga`);
          continue;
        }

        const { rows: existe } = await pool.query(
          `SELECT id FROM transacoes
           WHERE linha_id=$1 AND tipo='recarga' AND periodo_referencia=$2`,
          [linha.id, mesRef]
        );
        if (existe.length > 0) {
          await pool.query('UPDATE linhas SET ultima_checagem=NOW() WHERE id=$1', [linha.id]);
          continue;
        }

        const proximoVenc = details?.planData?.nextRenewalDate || details?.nextRenewalDate || null;
        let linhaAtiva = false;
        if (proximoVenc) {
          const venc = new Date(proximoVenc);
          linhaAtiva = venc >= hoje || venc.getMonth() === hoje.getMonth();
        } else {
          const dataAtiv = new Date(linha.data_ativacao);
          const mesesAtiva = (hoje.getFullYear() - dataAtiv.getFullYear()) * 12 + (hoje.getMonth() - dataAtiv.getMonth());
          linhaAtiva = mesesAtiva >= 1;
        }

        if (!linhaAtiva) {
          await pool.query('UPDATE linhas SET ultima_checagem=NOW() WHERE id=$1', [linha.id]);
          continue;
        }

        const { rows: planoRows } = await pool.query(
          'SELECT comissao_recarga, plano_nome FROM planos_comissao WHERE plano_id=$1',
          [linha.plano_id]
        );
        const comissao = parseFloat(planoRows[0]?.comissao_recarga || 0);
        if (comissao === 0) {
          await pool.query('UPDATE linhas SET ultima_checagem=NOW() WHERE id=$1', [linha.id]);
          continue;
        }

        await pool.query(
          `INSERT INTO transacoes (linha_id, vendedor_id, tipo, plano_id, plano_nome, comissao, periodo_referencia, fonte)
           VALUES ($1,$2,'recarga',$3,$4,$5,$6,'bora_details')`,
          [linha.id, linha.vendedor_id, linha.plano_id, linha.plano_nome, comissao, mesRef]
        );
        detectadas++;
        console.log(`[CRON] Recarga registrada: ${linha.msisdn} (${linha.vendedor_nome}) plano=${linha.plano_nome} comissão=R$${comissao}`);

        await pool.query('UPDATE linhas SET ultima_checagem=NOW() WHERE id=$1', [linha.id]);
      } catch (err) {
        // FIX: linha não encontrada na Bora (404) → marca como cancelada no banco
        if (err.response?.status === 404) {
          await pool.query("UPDATE linhas SET status='cancelada' WHERE id=$1", [linha.id]);
          console.log(`[CRON] Linha ${linha.msisdn} não encontrada na Bora (404) — marcada como cancelada`);
        } else {
          console.error(`[CRON] Erro na linha ${linha.msisdn}: ${err.message}`);
        }
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
garantirColunasEsimQrCode().catch(err => console.error('[DB] Erro ao preparar colunas eSIM:', err.message));
garantirColunasEquipeVendedor().catch(err => console.error('[DB] Erro ao preparar equipe de vendedores:', err.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bora Vendas rodando na porta ${PORT}`);
  setTimeout(checarRecargas, 2 * 60 * 1000);
});
