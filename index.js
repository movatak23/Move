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
const MOVE_APP_KEY        = process.env.MOVE_APP_KEY        || 'move-app-2026';
const MOVE_ZAPI_INSTANCE  = process.env.MOVE_ZAPI_INSTANCE  || '3F3A6D855AFBB2BDF16E7E7503EF1C64';
const MOVE_ZAPI_TOKEN     = process.env.MOVE_ZAPI_TOKEN     || 'ABDF61CE9B2A8A340C5FF549';
const MOVE_ZAPI_CLIENT_TOKEN = process.env.MOVE_ZAPI_CLIENT_TOKEN || '';
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
// Sanitiza SUPABASE_URL: extrai só o https:// mesmo se alguém colar conteúdo de .env completo na variável
const SUPABASE_URL = (String(process.env.SUPABASE_URL || '').match(/https?:\/\/[^\s\n,;]+/) || [''])[0].replace(/\/$/, '');
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
  if (!BORA_EMAIL || !BORA_SENHA) {
    console.error('[BORA AUTH] BORA_EMAIL ou BORA_SENHA ausentes nas variáveis de ambiente');
    throw new Error('Credenciais Bora não configuradas');
  }
  const credencial = Buffer.from(`${BORA_EMAIL}:${BORA_SENHA}`).toString('base64');
  let resp;
  try {
    resp = await axios.post(`${BORA_BASE}/api/Authentication/basic`, {}, {
      headers: { Authorization: `Basic ${credencial}` }
    });
  } catch (e) {
    console.error('[BORA AUTH] Falha na autenticação:', e.response?.status, JSON.stringify(e.response?.data || e.message));
    throw e;
  }
  const token = resp.data?.token || resp.data?.accessToken || resp.headers['x-access-token'];
  if (!token) {
    console.error('[BORA AUTH] Token não retornado. Resposta:', JSON.stringify(resp.data), 'Headers:', JSON.stringify(resp.headers));
    throw new Error('Token Bora não retornado');
  }
  console.log('[BORA AUTH] Token obtido com sucesso');
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

// Middleware para requisições do app mobile (sem login de vendedor)
function authApp(req, res, next) {
  const key = req.headers['x-move-app-key'];
  if (!key || key !== MOVE_APP_KEY) return res.status(401).json({ erro: 'Chave do app inválida' });
  next();
}

// Envia mensagem via Z-API (instância Move)
async function enviarWhatsAppMove(telefone, mensagem) {
  let fone = String(telefone).replace(/\D/g, '');
  // Remove zeros à esquerda
  fone = fone.replace(/^0+/, '');
  // Garante DDI 55: se tem 10-11 dígitos (DDD + número), prefixa 55
  if (fone.length === 10 || fone.length === 11) fone = '55' + fone;
  if (fone.length < 12) throw new Error('Telefone inválido: ' + telefone);

  try {
    await axios.post(
      `https://api.z-api.io/instances/${MOVE_ZAPI_INSTANCE}/token/${MOVE_ZAPI_TOKEN}/send-text`,
      { phone: fone, message: mensagem },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(MOVE_ZAPI_CLIENT_TOKEN ? {
            'Client-Token': MOVE_ZAPI_CLIENT_TOKEN,
            'client-token': MOVE_ZAPI_CLIENT_TOKEN
          } : {})
        },
        timeout: 15000
      }
    );
  } catch (e) {
    const zapiMsg = e.response?.data?.message || e.response?.data?.error || e.response?.data?.value || JSON.stringify(e.response?.data || {});
    console.error('[zapi-move] erro:', e.response?.status, zapiMsg);
    throw new Error(`Z-API (${e.response?.status || '?'}): ${zapiMsg}`);
  }
}

// Migration: tabela de controle de notificações WhatsApp (evita duplicata no mesmo dia)
async function garantirTabelaNotifWhatsapp() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS move_notif_whatsapp (
      id SERIAL PRIMARY KEY,
      msisdn VARCHAR(25) NOT NULL,
      tipo VARCHAR(50) NOT NULL DEFAULT 'vencimento_24h',
      enviado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS move_notif_wpp_dia
    ON move_notif_whatsapp (msisdn, tipo, DATE(enviado_em AT TIME ZONE 'America/Recife'))
  `).catch(() => null);
}

// Email de PIX enviado ao cliente após ativação
async function enviarEmailPix({ email, nome, pixCode, planoNome, planoValor }) {
  const destino = limparEmail(email);
  if (!destino || !pixCode) return { skipped: true };
  if (!RESEND_API_KEY) return { skipped: true, motivo: 'RESEND_API_KEY não configurado' };
  const valor = parseFloat(planoValor || 0).toFixed(2).replace('.', ',');
  const codeCurto = String(pixCode).slice(0, 60);
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111827;line-height:1.6">
    <h2 style="color:#00bfff;margin:0 0 16px">⚡ Seu código PIX para ativação Move</h2>
    <p>Olá, ${escapeHtml(nome || 'cliente')}.</p>
    <p>Seu chip foi ativado com sucesso! Realize o pagamento via PIX para liberar sua linha.</p>
    <div style="background:#f0f9ff;border:2px solid #00bfff;border-radius:12px;padding:20px;margin:24px 0">
      <p style="margin:0 0 8px;font-weight:700;color:#0369a1">Código PIX (Copia e Cola)</p>
      <p style="margin:0;font-family:monospace;font-size:12px;word-break:break-all;color:#111">${escapeHtml(pixCode)}</p>
    </div>
    <p><strong>Plano:</strong> ${escapeHtml(planoNome || '')}</p>
    <p><strong>Valor:</strong> R$ ${valor}/mês</p>
    <p style="font-size:12px;color:#6b7280;margin-top:24px">Após o pagamento sua linha será ativada automaticamente em até 5 minutos.</p>
  </div>`;
  try {
    await axios.post('https://api.resend.com/emails', {
      from: EMAIL_FROM,
      to: [destino],
      subject: '⚡ Código PIX para ativar sua linha Move',
      html,
      text: `Olá ${nome || 'cliente'}, seu código PIX: ${codeCurto}...`,
    }, { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    return { enviado: true, destino };
  } catch (e) {
    console.error('[email-pix] erro:', e.message);
    return { erro: e.message };
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

// Verifica se um ICCID é do tipo eSIM consultando a Bora (iccicType: "E-SIM")
async function esimEhTipoEsim(iccid) {
  try {
    const data = await boraGet(`/api/Subscriber/${encodeURIComponent(iccid)}/iccid`);
    return String(data?.iccicType || data?.iccidType || '').toUpperCase().includes('E-SIM');
  } catch {
    return false;
  }
}

// Limite de eSIMs ativados e NÃO PAGOS por vendedor principal, no mês corrente
const LIMITE_ESIM_PENDENTE = parseInt(process.env.LIMITE_ESIM_PENDENTE || '3', 10);

// Conta quantas linhas o vendedor principal ativou no mês que ainda NÃO estão ACTIVE na Bora.
// Verifica em tempo real na Bora (fonte da verdade).
async function contarEsimsPendentesVendedor(vendedorPrincipalId) {
  // Linhas ativadas por este vendedor no mês corrente (BRT)
  const { rows } = await pool.query(
    `SELECT id, msisdn, iccid, status
       FROM linhas
      WHERE vendedor_id = $1
        AND data_ativacao >= date_trunc('month', (NOW() AT TIME ZONE 'America/Recife'))
        AND msisdn IS NOT NULL`,
    [vendedorPrincipalId]
  );

  let pendentes = 0;
  const pendentesDetalhe = [];

  for (const linha of rows) {
    // Já marcada como ativa/paga no nosso banco — não precisa consultar
    if (String(linha.status || '').toLowerCase() === 'ativa') continue;

    let ativaNaBora = false;
    try {
      const details = await boraGet(`/api/Subscription/${linha.msisdn}/details`);
      const st = String(details?.status || '').toUpperCase();
      ativaNaBora = (st === 'ACTIVE');
      // Sincroniza nosso banco quando detecta que pagou
      if (ativaNaBora && String(linha.status || '').toLowerCase() !== 'ativa') {
        await pool.query("UPDATE linhas SET status='ativa' WHERE id=$1", [linha.id]).catch(() => null);
      }
    } catch {
      // Sem details / erro: trata como pendente (conservador)
      ativaNaBora = false;
    }

    if (!ativaNaBora) {
      pendentes++;
      pendentesDetalhe.push({ msisdn: linha.msisdn, iccid: linha.iccid });
    }
    await aguardar(120);
  }

  return {
    pendentes,
    limite: LIMITE_ESIM_PENDENTE,
    bloqueado: pendentes >= LIMITE_ESIM_PENDENTE,
    restantes: Math.max(0, LIMITE_ESIM_PENDENTE - pendentes),
    detalhe: pendentesDetalhe,
  };
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

function normalizarMsisdnParaBora(valor) {
  let fone = String(valor || '').replace(/\D/g, '').replace(/^0+/, '');
  if (fone.length === 10 || fone.length === 11) fone = '55' + fone;
  return fone;
}

function variantesMsisdn(valor) {
  const digitos = String(valor || '').replace(/\D/g, '').replace(/^0+/, '');
  const set = new Set([String(valor || '').trim(), digitos]);
  if (digitos.length === 10 || digitos.length === 11) set.add(`55${digitos}`);
  if (digitos.startsWith('55') && digitos.length > 11) set.add(digitos.slice(2));
  return Array.from(set).filter(Boolean);
}

async function carregarMapasComissaoPlanos() {
  const { rows } = await pool.query('SELECT * FROM planos_comissao');
  const porId = new Map();
  const porNome = new Map();
  for (const p of rows) {
    porId.set(String(p.plano_id || ''), p);
    porNome.set(String(p.plano_nome || '').toUpperCase().trim(), p);
  }
  return { porId, porNome };
}

function localizarPlanoComissao(mapas, planId, planNome) {
  return mapas.porId.get(String(planId || '')) ||
         mapas.porNome.get(String(planNome || '').toUpperCase().trim()) ||
         null;
}

function sqlFiltroPeriodoTransacoes(alias = 't', startParam = '$2', endParam = '$3') {
  const pref = alias ? `${alias}.` : '';
  // Mantém todas as comparações como DATE para evitar o erro PostgreSQL:
  // "operator does not exist: text >= date".
  // periodo_referencia pode vir como 'AAAA-MM' (retroativo mensal), 'AAAA-MM-DD' ou vazio.
  return ` AND (
    (
      COALESCE(${pref}periodo_referencia,'') ~ '^\d{4}-\d{2}$'
      AND (${pref}periodo_referencia || '-01')::date <= ${endParam}::date
      AND ((${pref}periodo_referencia || '-01')::date + INTERVAL '1 month - 1 day') >= ${startParam}::date
    )
    OR
    (
      NOT (COALESCE(${pref}periodo_referencia,'') ~ '^\d{4}-\d{2}$')
      AND COALESCE(
        CASE
          WHEN COALESCE(${pref}periodo_referencia,'') ~ '^\d{4}-\d{2}-\d{2}$' THEN ${pref}periodo_referencia::date
          ELSE NULL
        END,
        ${pref}data_transacao::date
      ) BETWEEN ${startParam}::date AND ${endParam}::date
    )
  )`;
}

function dataHojeRecifeISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Recife',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizarDataDashboardISO(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  const d = raw ? new Date(raw) : null;
  if (d && !Number.isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  return dataHojeRecifeISO();
}

function dataBoletoISO(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.substring(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    const [dia, mes, ano] = raw.split('/');
    return `${ano}-${mes}-${dia}`;
  }
  const d = raw ? new Date(raw) : null;
  if (d && !Number.isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  return null;
}

function boletoPendente(boleto) {
  return !(
    boleto?.paid ||
    boleto?.paymentDate ||
    boleto?.paidAt ||
    boleto?.status === 'PAID' ||
    String(boleto?.status || '').toUpperCase() === 'PAID' ||
    String(boleto?.status || '').toUpperCase() === 'PAGO'
  );
}

async function calcularIndicadoresDiaPorEscopo({ campoEscopo = null, vendedorId = null, dataReferencia = null } = {}) {
  const dataDia = normalizarDataDashboardISO(dataReferencia);
  const params = [dataDia];
  let filtroEscopo = '';

  if (campoEscopo && vendedorId) {
    params.push(vendedorId);
    filtroEscopo = ` AND l.${campoEscopo} = $2`;
  }

  const { rows: linhasAtivasRows } = await pool.query(
    `SELECT COUNT(DISTINCT l.id)::int AS total
       FROM linhas l
      WHERE LOWER(COALESCE(l.status, '')) IN ('ativa', 'active')
        AND l.msisdn IS NOT NULL
        AND COALESCE(l.iccid, '') NOT ILIKE 'retroativo-%'
        AND (l.data_ativacao IS NULL OR l.data_ativacao::date <= $1::date)
        ${filtroEscopo}`,
    params
  );

  const { rows: linhas } = await pool.query(
    `SELECT DISTINCT l.id, l.msisdn, l.documento_cliente
       FROM linhas l
      WHERE LOWER(COALESCE(l.status, '')) IN ('ativa', 'active')
        AND l.msisdn IS NOT NULL
        AND l.documento_cliente IS NOT NULL
        AND COALESCE(l.iccid, '') NOT ILIKE 'retroativo-%'
        AND (l.data_ativacao IS NULL OR l.data_ativacao::date <= $1::date)
        ${filtroEscopo}`,
    params
  );

  let vencimentos = 0;
  let errosVencimentos = 0;
  const docsConsultados = new Map();

  for (const linha of linhas) {
    try {
      const doc = String(linha.documento_cliente || '').replace(/\D/g, '');
      if (!doc) continue;
      let lista = docsConsultados.get(doc);
      if (!lista) {
        const boletos = await boraGet(`/api/Subscriber/${doc}/billets`);
        lista = Array.isArray(boletos) ? boletos : (boletos?.items || boletos?.billets || boletos?.data || []);
        docsConsultados.set(doc, lista);
        await aguardar(80);
      }

      const temVencimentoNoDia = lista.some(b => {
        if (!boletoPendente(b)) return false;
        const vencISO = dataBoletoISO(b.dueDate || b.expiration || b.vencimento || b.due_date);
        return vencISO === dataDia;
      });
      if (temVencimentoNoDia) vencimentos++;
    } catch (e) {
      errosVencimentos++;
    }
  }

  return {
    data_referencia: dataDia,
    linhas_ativas_dia: parseInt(linhasAtivasRows[0]?.total || 0, 10),
    linhas_vencimento_dia: vencimentos,
    erros_vencimentos: errosVencimentos
  };
}


function dataEventoPlanoBora(plano, fallback) {
  const raw = String(
    plano?.createdAt ||
    plano?.activationDate ||
    plano?.activatedAt ||
    plano?.startDate ||
    plano?.date ||
    plano?.expiration ||
    fallback ||
    ''
  ).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.substring(0, 10);
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  const d = raw ? new Date(raw) : null;
  if (d && !Number.isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  return null;
}

function dataDentroPeriodo(dataISO, inicio, fim) {
  if (!dataISO) return false;
  const data = String(dataISO).substring(0, 10);
  if (inicio && data < inicio) return false;
  if (fim && data > fim) return false;
  return true;
}

// Calcula a Receita Move pelo relatório SALES da Bora (xlsx).
// Esse relatório lista TODAS as transações (ativações, recargas, pacotes) que passaram
// pela Bora no período — inclusive linhas sem vendedor cadastrado no nosso sistema.
// Receita Move = soma da comissão configurada (ativacao/recarga) de cada transação.
async function calcularReceitaMoveSalesBora({ dataInicio, dataFim }) {
  const XLSX = require('xlsx');
  const mapas = await carregarMapasComissaoPlanos();
  const inicio = dataInicio || '2023-01-01';
  const fim = dataFim || dataHojeRecifeISO();

  // Baixa o relatório Sales como binário
  const token = await getBoraToken();
  const resp = await axios.get(
    `${BORA_BASE}/api/Report/Sales`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { customerId: '', initialDate: inicio, finalDate: fim },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );

  const wb = XLSX.read(resp.data, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, { defval: '' });

  let receitaMove = 0;
  let ativacoes = 0, recargas = 0, pacotes = 0;
  let semPlano = 0;
  let totalTransacoes = linhas.length;
  const planosNaoEncontrados = new Set();

  for (const row of linhas) {
    // Colunas reais do relatório Sales: PLANO, TIPO, VALOR
    const plano = String(row['PLANO'] || row['Plano'] || '').trim();
    const tipoRaw = String(row['TIPO'] || row['Tipo'] || '').toUpperCase().trim();
    if (!plano) continue;

    // Classifica: tudo que começa com "ATIVAÇÃO" = ativacao; RECARGA e PACOTE = recarga
    const ehAtivacao = tipoRaw.startsWith('ATIVA');
    const ehRecarga  = tipoRaw.includes('RECARGA') || tipoRaw.includes('PACOTE');

    if (!ehAtivacao && !ehRecarga) continue;

    // Localiza comissão do plano (por nome). Planos não cadastrados são ignorados.
    const cfg = localizarPlanoComissao(mapas, null, plano);
    if (!cfg) {
      semPlano++;
      planosNaoEncontrados.add(plano);
      continue;
    }

    const comissao = ehAtivacao
      ? Number(cfg.comissao_ativacao || 0)
      : Number(cfg.comissao_recarga || 0);

    if (comissao <= 0) continue;
    receitaMove += comissao;

    if (ehAtivacao) ativacoes++;
    else if (tipoRaw.includes('PACOTE')) pacotes++;
    else recargas++;
  }

  return {
    receita_move_periodo: Number(receitaMove.toFixed(2)),
    ativacoes_bora_periodo: ativacoes,
    recargas_bora_periodo: recargas + pacotes,
    total_transacoes_bora: totalTransacoes,
    eventos_sem_plano_configurado: semPlano,
    planos_nao_encontrados: Array.from(planosNaoEncontrados),
    fonte_receita_move: 'bora_report_sales',
  };
}

async function calcularReceitaMoveBoraPeriodo({ dataInicio, dataFim }) {
  const mapas = await carregarMapasComissaoPlanos();
  const inicio = dataInicio || null;
  const fim = dataFim || dataHojeRecifeISO();

  const { rows: linhas } = await pool.query(
    `SELECT DISTINCT ON (regexp_replace(COALESCE(msisdn,''), '\\D', '', 'g'))
            id, msisdn, iccid, data_ativacao, plano_id, plano_nome
       FROM linhas
      WHERE msisdn IS NOT NULL
        AND regexp_replace(COALESCE(msisdn,''), '\\D', '', 'g') <> ''
      ORDER BY regexp_replace(COALESCE(msisdn,''), '\\D', '', 'g'), id DESC`
  );

  let receitaMove = 0;
  let ativacoesBora = 0;
  let recargasBora = 0;
  let linhasConsultadas = 0;
  let linhasComErro = 0;
  let eventosSemPlanoConfigurado = 0;

  for (const linha of linhas) {
    const msisdnBora = normalizarMsisdnParaBora(linha.msisdn);
    if (!msisdnBora || msisdnBora.length < 12) continue;

    let details;
    try {
      details = await boraGet(`/api/Subscription/${msisdnBora}/details`);
      linhasConsultadas++;
      await aguardar(80);
    } catch (e) {
      linhasComErro++;
      continue;
    }

    const planArray = Array.isArray(details?.plan) ? details.plan : [];
    const activationDate = dataEventoPlanoBora(null, details?.activationDate || linha.data_ativacao);
    const linhaRetroativa = String(linha.iccid || '').toLowerCase().startsWith('retroativo-');

    if (planArray.length) {
      for (let i = 0; i < planArray.length; i++) {
        const plano = planArray[i];
        const tipo = i === 0 ? 'ativacao' : 'recarga';
        if (linhaRetroativa && tipo === 'ativacao') continue;

        const dataEvento = i === 0
          ? dataEventoPlanoBora(plano, activationDate)
          : dataEventoPlanoBora(plano, null);

        if (!dataDentroPeriodo(dataEvento, inicio, fim)) continue;

        const cfg = localizarPlanoComissao(mapas, plano?.planId || plano?.id || plano?.idPlanExternal, plano?.name || plano?.nome);
        if (!cfg) {
          eventosSemPlanoConfigurado++;
          continue;
        }

        const valorComissao = tipo === 'ativacao'
          ? Number(cfg.comissao_ativacao || 0)
          : Number(cfg.comissao_recarga || 0);

        if (valorComissao <= 0) continue;
        receitaMove += valorComissao;
        if (tipo === 'ativacao') ativacoesBora++;
        if (tipo === 'recarga') recargasBora++;
      }
      continue;
    }

    // Fallback conservador: se a Bora não retornar array de planos, conta apenas a ativação
    // pelo plano atual da linha/detalhes, desde que a data de ativação esteja no período.
    if (!linhaRetroativa && dataDentroPeriodo(activationDate, inicio, fim)) {
      const cfg = localizarPlanoComissao(
        mapas,
        details?.planData?.id || details?.planId || linha.plano_id,
        details?.planData?.name || details?.planName || linha.plano_nome
      );
      if (cfg) {
        const valorComissao = Number(cfg.comissao_ativacao || 0);
        if (valorComissao > 0) {
          receitaMove += valorComissao;
          ativacoesBora++;
        }
      } else {
        eventosSemPlanoConfigurado++;
      }
    }
  }

  return {
    receita_move_periodo: receitaMove,
    ativacoes_bora_periodo: ativacoesBora,
    recargas_bora_periodo: recargasBora,
    linhas_consultadas_bora: linhasConsultadas,
    linhas_com_erro_bora: linhasComErro,
    eventos_sem_plano_configurado: eventosSemPlanoConfigurado,
    fonte_receita_move: 'bora_subscription_details'
  };
}

function dataReferenciaPlano(plano, fallback) {
  const valor = plano?.createdAt || plano?.activationDate || plano?.expiration || fallback || new Date().toISOString();
  const iso = String(valor);
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.substring(0, 10);
  const d = new Date(valor);
  if (!Number.isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  return new Date().toISOString().substring(0, 10);
}

async function sincronizarHistoricoRecargasLinha({ linhaId, msisdn, vendedorId, subvendedorId }) {
  const msisdnBora = normalizarMsisdnParaBora(msisdn);
  if (!linhaId || !msisdnBora || msisdnBora.length < 12) {
    return { ok: false, motivo: 'MSISDN inválido para sincronizar histórico', inseridas: 0, atualizadas: 0 };
  }

  let details;
  try {
    details = await boraGet(`/api/Subscription/${msisdnBora}/details`);
  } catch (e) {
    console.warn('[transferir-vendedor] Não foi possível consultar histórico na Bora:', msisdnBora, e.response?.status || '', e.response?.data?.detail || e.message);
    return { ok: false, motivo: e.response?.data?.detail || e.message, inseridas: 0, atualizadas: 0 };
  }

  const mapas = await carregarMapasComissaoPlanos();
  const planArray = Array.isArray(details?.plan) ? details.plan : [];
  const planoAtual = planArray.length ? planArray[planArray.length - 1] : null;
  const dataAtivacao = details?.activationDate || planoAtual?.createdAt || null;
  const statusLinha = details?.status || null;
  const documento = details?.document || details?.subscriber?.document || null;
  const nomeCliente = details?.name || details?.subscriber?.name || details?.subscriberName || null;

  if (planoAtual || dataAtivacao || statusLinha || documento || nomeCliente) {
    const planoCfg = planoAtual ? localizarPlanoComissao(mapas, planoAtual.planId, planoAtual.name) : null;
    await pool.query(
      `UPDATE linhas
          SET msisdn = COALESCE(NULLIF($2,''), msisdn),
              plano_id = COALESCE(NULLIF($3,''), plano_id),
              plano_nome = COALESCE(NULLIF($4,''), plano_nome),
              documento_cliente = COALESCE(NULLIF($5,''), documento_cliente),
              nome_cliente = COALESCE(NULLIF($6,''), nome_cliente),
              status = COALESCE(NULLIF($7,''), status),
              data_ativacao = COALESCE($8::timestamp, data_ativacao),
              ultima_checagem = NOW()
        WHERE id=$1`,
      [linhaId, msisdnBora, planoAtual?.planId || planoCfg?.plano_id || '', planoAtual?.name || planoCfg?.plano_nome || '', documento || '', nomeCliente || '', statusLinha || '', dataAtivacao]
    ).catch(() => null);
  }

  const { rows: linhaRetroRows } = await pool.query('SELECT iccid FROM linhas WHERE id=$1 LIMIT 1', [linhaId]).catch(() => ({ rows: [] }));
  const linhaEhRetroativa = String(linhaRetroRows?.[0]?.iccid || '').toLowerCase().startsWith('retroativo-');

  let inseridas = 0;
  let atualizadas = 0;

  async function upsertTransacao({ tipo, plano, dataRef }) {
    // Linha retroativa não gera comissão de ativação.
    // Para retroativos, o valor válido de comissão é apenas o de recarga/mensalidade.
    if (linhaEhRetroativa && tipo === 'ativacao') {
      return;
    }
    const cfg = localizarPlanoComissao(mapas, plano?.planId, plano?.name);
    const periodo = dataRef;
    const comissao = tipo === 'ativacao'
      ? parseFloat(cfg?.comissao_ativacao || 0)
      : parseFloat(cfg?.comissao_recarga || 0);
    const valorPlano = parseFloat(cfg?.plano_valor || 0) || null;
    const planoId = plano?.planId || cfg?.plano_id || null;
    const planoNome = plano?.name || cfg?.plano_nome || null;

    const existe = await pool.query(
      `SELECT id FROM transacoes
        WHERE linha_id=$1 AND tipo=$2 AND COALESCE(periodo_referencia, data_transacao::date::text)=$3
        LIMIT 1`,
      [linhaId, tipo, periodo]
    );

    if (existe.rows.length) {
      await pool.query(
        `UPDATE transacoes
            SET vendedor_id=$1,
                subvendedor_id=$2,
                plano_id=COALESCE(plano_id,$3),
                plano_nome=COALESCE(NULLIF(plano_nome,''),$4),
                valor_plano=COALESCE(valor_plano,$5),
                comissao=CASE WHEN COALESCE(comissao,0)=0 THEN $6 ELSE comissao END,
                periodo_referencia=COALESCE(periodo_referencia,$7),
                data_transacao=COALESCE(data_transacao,$8::timestamp),
                fonte=COALESCE(NULLIF(fonte,''),'bora_details')
          WHERE id=$9`,
        [vendedorId, subvendedorId, planoId, planoNome, valorPlano, comissao, periodo, periodo, existe.rows[0].id]
      );
      atualizadas++;
      return;
    }

    await pool.query(
      `INSERT INTO transacoes (linha_id, vendedor_id, subvendedor_id, tipo, plano_id, plano_nome, valor_plano, comissao, data_transacao, periodo_referencia, fonte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamp,$10,'bora_details')`,
      [linhaId, vendedorId, subvendedorId, tipo, planoId, planoNome, valorPlano, comissao, periodo, periodo]
    );
    inseridas++;
  }

  if (planArray.length) {
    const primeiro = planArray[0];
    await upsertTransacao({
      tipo: 'ativacao',
      plano: primeiro,
      dataRef: dataReferenciaPlano(primeiro, dataAtivacao)
    });

    for (let i = 1; i < planArray.length; i++) {
      const p = planArray[i];
      await upsertTransacao({
        tipo: 'recarga',
        plano: p,
        dataRef: dataReferenciaPlano(p, dataAtivacao)
      });
    }
  } else if (!linhaEhRetroativa) {
    const { rows: linhaRows } = await pool.query('SELECT plano_id, plano_nome, data_ativacao FROM linhas WHERE id=$1', [linhaId]);
    const linha = linhaRows[0] || {};
    await upsertTransacao({
      tipo: 'ativacao',
      plano: { planId: linha.plano_id, name: linha.plano_nome },
      dataRef: dataReferenciaPlano(null, linha.data_ativacao)
    });
  }

  return { ok: true, inseridas, atualizadas, totalPlanosBora: planArray.length };
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
    const vendedorId = parseInt(req.params.id, 10);
    if (!vendedorId) return res.status(400).json({ erro: 'Vendedor inválido' });

    // Segurança: vendedor/subvendedor só acessa o próprio painel. Admin pode consultar qualquer vendedor.
    if (req.user.role !== 'admin' && parseInt(req.user.id, 10) !== vendedorId) {
      return res.status(403).json({ erro: 'Acesso negado' });
    }

    const { rows: alvoRows } = await pool.query('SELECT id, role FROM vendedores WHERE id=$1', [vendedorId]);
    if (!alvoRows.length) return res.status(404).json({ erro: 'Vendedor não encontrado' });

    const alvoRole = alvoRows[0].role;
    const campoEscopo = alvoRole === 'subvendedor' ? 'subvendedor_id' : 'vendedor_id';
    const { data_inicio, data_fim } = req.query;

    // 1) Garante que toda linha do vendedor tenha uma transação de ativação.
    // Isso evita painel vazio quando a linha existe, mas a comissão/ativação não foi registrada em transacoes.
    await pool.query(
      `INSERT INTO transacoes (linha_id, vendedor_id, subvendedor_id, tipo, plano_id, plano_nome, valor_plano, comissao, data_transacao, fonte)
       SELECT l.id,
              l.vendedor_id,
              l.subvendedor_id,
              'ativacao',
              COALESCE(NULLIF(l.plano_id,''), pc.plano_id),
              COALESCE(NULLIF(l.plano_nome,''), pc.plano_nome),
              pc.plano_valor,
              COALESCE(pc.comissao_ativacao, 0),
              COALESCE(l.data_ativacao, NOW()),
              'sistema'
         FROM linhas l
         LEFT JOIN LATERAL (
           SELECT pc.*
             FROM planos_comissao pc
            WHERE (l.plano_id IS NOT NULL AND pc.plano_id::text = l.plano_id::text)
               OR (l.plano_nome IS NOT NULL AND UPPER(TRIM(pc.plano_nome)) = UPPER(TRIM(l.plano_nome)))
            ORDER BY CASE WHEN pc.plano_id::text = COALESCE(l.plano_id::text,'') THEN 0 ELSE 1 END
            LIMIT 1
         ) pc ON true
        WHERE l.${campoEscopo} = $1
          AND COALESCE(l.iccid, '') NOT ILIKE 'retroativo-%'
          AND NOT EXISTS (
            SELECT 1 FROM transacoes t
             WHERE t.linha_id = l.id
               AND t.tipo = 'ativacao'
          )`,
      [vendedorId]
    );

    // 2) Regra de retroativos: linhas com ICCID retroativo-* não geram comissão de ativação.
    // Elas só devem remunerar recargas/mensalidades.
    await pool.query(
      `UPDATE transacoes t
          SET comissao = 0
         FROM linhas l
        WHERE l.id = t.linha_id
          AND t.${campoEscopo} = $1
          AND t.tipo = 'ativacao'
          AND COALESCE(l.iccid, '') ILIKE 'retroativo-%'
          AND COALESCE(t.comissao, 0) <> 0`,
      [vendedorId]
    );

    // 3) Preenche comissões zeradas/nulas a partir da tabela planos_comissao.
    // Não altera comissões já preenchidas manualmente, exceto a regra acima dos retroativos.
    await pool.query(
      `UPDATE transacoes t
          SET comissao = CASE
                WHEN t.tipo = 'ativacao' AND COALESCE(pc.comissao_ativacao, 0) > 0 THEN pc.comissao_ativacao
                WHEN t.tipo = 'recarga'   AND COALESCE(pc.comissao_recarga, 0) > 0 THEN pc.comissao_recarga
                ELSE t.comissao
              END,
              valor_plano = COALESCE(t.valor_plano, pc.plano_valor),
              plano_id = COALESCE(NULLIF(t.plano_id,''), NULLIF(l.plano_id,''), pc.plano_id),
              plano_nome = COALESCE(NULLIF(t.plano_nome, ''), NULLIF(l.plano_nome,''), pc.plano_nome)
         FROM linhas l, planos_comissao pc
        WHERE l.id = t.linha_id
          AND (
            pc.plano_id::text = COALESCE(NULLIF(t.plano_id,''), NULLIF(l.plano_id,''), '')::text
            OR UPPER(TRIM(pc.plano_nome)) = UPPER(TRIM(COALESCE(NULLIF(t.plano_nome,''), NULLIF(l.plano_nome,''), '')))
          )
          AND t.${campoEscopo} = $1
          AND NOT (t.tipo = 'ativacao' AND COALESCE(l.iccid, '') ILIKE 'retroativo-%')
          AND COALESCE(t.comissao, 0) = 0`,
      [vendedorId]
    );

    const params = [vendedorId];
    let filtroTransacoes = '';
    if (data_inicio && data_fim) {
      filtroTransacoes = sqlFiltroPeriodoTransacoes('t', '$2', '$3');
      params.push(data_inicio, data_fim);
    }

    const { rows: transacoes } = await pool.query(
      `SELECT t.*, l.msisdn, l.nome_cliente, l.iccid,
              COALESCE(t.valor_plano, pc.plano_valor) AS valor_plano,
              COALESCE(NULLIF(t.plano_nome, ''), NULLIF(l.plano_nome,''), pc.plano_nome) AS plano_nome
         FROM transacoes t
         LEFT JOIN linhas l ON l.id = t.linha_id
         LEFT JOIN LATERAL (
           SELECT pc.*
             FROM planos_comissao pc
            WHERE pc.plano_id::text = COALESCE(NULLIF(t.plano_id,''), NULLIF(l.plano_id,''), '')::text
               OR UPPER(TRIM(pc.plano_nome)) = UPPER(TRIM(COALESCE(NULLIF(t.plano_nome,''), NULLIF(l.plano_nome,''), '')))
            LIMIT 1
         ) pc ON true
        WHERE t.${campoEscopo} = $1${filtroTransacoes}
          AND NOT (t.tipo = 'ativacao' AND COALESCE(l.iccid, '') ILIKE 'retroativo-%')
        ORDER BY COALESCE(t.periodo_referencia, t.data_transacao::date::text) DESC`,
      params
    );

    const { rows: resumo } = await pool.query(
      `SELECT t.tipo, COUNT(*) as quantidade, COALESCE(SUM(t.comissao),0) as total_comissao
         FROM transacoes t
         LEFT JOIN linhas l ON l.id = t.linha_id
        WHERE t.${campoEscopo}=$1${filtroTransacoes}
          AND NOT (t.tipo = 'ativacao' AND COALESCE(l.iccid, '') ILIKE 'retroativo-%')
        GROUP BY t.tipo`,
      params
    );

    const paramsLinhas = [vendedorId];
    let filtroLinhas = '';
    if (data_inicio && data_fim) {
      filtroLinhas = ' AND l.data_ativacao::date BETWEEN $2::date AND $3::date';
      paramsLinhas.push(data_inicio, data_fim);
    }

    const filtroJoinTransacoesLinhas = (data_inicio && data_fim) ? sqlFiltroPeriodoTransacoes('t', '$2', '$3') : '';

    const { rows: linhas } = await pool.query(
      `SELECT l.*,
              COALESCE(NULLIF(l.plano_nome,''), tx.plano_nome_ref, pc.plano_nome) AS plano_nome,
              COALESCE(NULLIF(l.plano_id,''), tx.plano_id_ref, pc.plano_id) AS plano_id,
              COALESCE(pc.plano_valor, tx.valor_plano_ref, 0) AS plano_valor,
              CASE WHEN COALESCE(l.iccid, '') ILIKE 'retroativo-%' THEN 0 ELSE COALESCE(tx.comissao_ativacao, 0) END AS comissao_ativacao,
              COALESCE(tx.comissao_recarga, 0) AS comissao_recarga,
              CASE WHEN COALESCE(l.iccid, '') ILIKE 'retroativo-%'
                   THEN COALESCE(tx.comissao_recarga, 0)
                   ELSE COALESCE(tx.comissao_ativacao, 0) + COALESCE(tx.comissao_recarga, 0)
              END AS total_comissao,
              COALESCE(tx.quantidade_recargas, 0) AS quantidade_recargas,
              COALESCE(tx.total_transacoes, 0) AS total_transacoes
         FROM linhas l
         LEFT JOIN LATERAL (
           SELECT
             MAX(NULLIF(t.plano_id,'')) AS plano_id_ref,
             MAX(NULLIF(t.plano_nome,'')) AS plano_nome_ref,
             MAX(t.valor_plano) AS valor_plano_ref,
             COALESCE(SUM(CASE WHEN t.tipo='ativacao' THEN t.comissao ELSE 0 END), 0) AS comissao_ativacao,
             COALESCE(SUM(CASE WHEN t.tipo='recarga' THEN t.comissao ELSE 0 END), 0) AS comissao_recarga,
             COUNT(CASE WHEN t.tipo='recarga' THEN 1 END) AS quantidade_recargas,
             COUNT(t.id) AS total_transacoes
           FROM transacoes t
          WHERE t.linha_id = l.id${filtroJoinTransacoesLinhas}
         ) tx ON true
         LEFT JOIN LATERAL (
           SELECT pc.*
             FROM planos_comissao pc
            WHERE pc.plano_id::text = COALESCE(NULLIF(l.plano_id,''), tx.plano_id_ref, '')::text
               OR UPPER(TRIM(pc.plano_nome)) = UPPER(TRIM(COALESCE(NULLIF(l.plano_nome,''), tx.plano_nome_ref, '')))
            ORDER BY CASE WHEN pc.plano_id::text = COALESCE(NULLIF(l.plano_id,''), tx.plano_id_ref, '')::text THEN 0 ELSE 1 END
            LIMIT 1
         ) pc ON true
        WHERE l.${campoEscopo} = $1${filtroLinhas}
        ORDER BY l.data_ativacao DESC`,
      paramsLinhas
    );

    const { rows: topClientes } = await pool.query(
      `SELECT l.msisdn,
              COALESCE(NULLIF(l.nome_cliente,''), 'Cliente sem nome') AS nome_cliente,
              COALESCE(NULLIF(l.plano_nome,''), MAX(NULLIF(t.plano_nome,'')), 'Sem plano') AS plano_nome,
              COUNT(t.id)::int AS quantidade_recargas,
              COALESCE(SUM(t.comissao), 0) AS total_comissao_recargas,
              COALESCE(SUM(t.valor_plano), 0) AS total_valor_planos,
              MAX(COALESCE(t.periodo_referencia, t.data_transacao::date::text)) AS ultima_recarga
         FROM linhas l
         JOIN transacoes t ON t.linha_id = l.id
        WHERE t.${campoEscopo} = $1
          AND t.tipo = 'recarga'${filtroTransacoes}
        GROUP BY l.id, l.msisdn, l.nome_cliente, l.plano_nome
        ORDER BY COUNT(t.id) DESC, COALESCE(SUM(t.comissao), 0) DESC
        LIMIT 5`,
      params
    );

    const indicadoresDia = await calcularIndicadoresDiaPorEscopo({
      campoEscopo,
      vendedorId,
      dataReferencia: data_fim || dataHojeRecifeISO()
    });

    res.json({ transacoes, resumo, linhas, top_clientes: topClientes, indicadores_dia: indicadoresDia });
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
      `SELECT v.id AS vendedor_id, v.nome, v.email,
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



// ─── KPIs financeiros do dashboard admin ─────────────────────────────────────
// Receita da Move = mesmo valor da comissão do vendedor em cada ativação/recarga.
// Observação: inadimplência/cancelamento usa o STATUS atual salvo na tabela linhas,
// porque o schema atual não possui uma data específica de bloqueio/cancelamento.
app.get('/api/dashboard/financeiro-periodo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const dataInicio = req.query.data_inicio || null;
    const dataFim = req.query.data_fim || null;

    // Receita Move no período: usa o relatório SALES da Bora (pega TODAS as transações,
    // inclusive linhas sem vendedor cadastrado no nosso sistema). Fallback para o método
    // antigo (via Subscription details) se o relatório falhar.
    let receitaBora;
    try {
      receitaBora = await calcularReceitaMoveSalesBora({ dataInicio, dataFim });
    } catch (e) {
      console.error('[RECEITA SALES] falhou, usando fallback:', e.message);
      receitaBora = await calcularReceitaMoveBoraPeriodo({ dataInicio, dataFim });
    }

    const paramsLinhas = [];
    let filtroLinhasPeriodo = '';
    if (dataFim) {
      paramsLinhas.push(dataFim);
      filtroLinhasPeriodo = ' AND (l.data_ativacao IS NULL OR l.data_ativacao::date <= $1::date)';
    }

    const { rows: linhasRows } = await pool.query(
      `SELECT
          COUNT(*)::int AS total_linhas,
          COUNT(CASE WHEN LOWER(COALESCE(l.status,'')) IN ('ativa','active') THEN 1 END)::int AS linhas_ativas,
          COUNT(CASE WHEN LOWER(COALESCE(l.status,'')) IN ('bloqueada','bloqueado','suspensa','suspenso','inadimplente','overdue','blocked','suspended') THEN 1 END)::int AS linhas_inadimplentes,
          COUNT(CASE WHEN LOWER(COALESCE(l.status,'')) IN ('cancelada','cancelado','cancelled','canceled') THEN 1 END)::int AS linhas_canceladas
         FROM linhas l
        WHERE COALESCE(l.iccid, '') NOT ILIKE 'retroativo-%'
          AND l.msisdn IS NOT NULL${filtroLinhasPeriodo}`,
      paramsLinhas
    );

    const base = Number(linhasRows[0]?.total_linhas || 0);
    const inad = Number(linhasRows[0]?.linhas_inadimplentes || 0);
    const canc = Number(linhasRows[0]?.linhas_canceladas || 0);

    res.json({
      ok: true,
      receita_move_periodo: Number(receitaBora.receita_move_periodo || 0),
      ativacoes_comissionadas: Number(receitaBora.ativacoes_bora_periodo || 0),
      recargas_comissionadas: Number(receitaBora.recargas_bora_periodo || 0),
      linhas_consultadas_bora: Number(receitaBora.linhas_consultadas_bora || 0),
      linhas_com_erro_bora: Number(receitaBora.linhas_com_erro_bora || 0),
      eventos_sem_plano_configurado: Number(receitaBora.eventos_sem_plano_configurado || 0),
      fonte_receita_move: receitaBora.fonte_receita_move,
      total_linhas_base: base,
      linhas_ativas_base: Number(linhasRows[0]?.linhas_ativas || 0),
      linhas_inadimplentes: inad,
      taxa_inadimplencia: base ? (inad / base) * 100 : 0,
      linhas_canceladas: canc,
      taxa_cancelamento: base ? (canc / base) * 100 : 0,
      data_inicio: dataInicio,
      data_fim: dataFim || null
    });
  } catch (e) {
    console.error('[DASHBOARD FINANCEIRO]', e.message, e.stack);
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/dashboard/indicadores-dia', authMiddleware, async (req, res) => {
  try {
    const dataReferencia = req.query.data || req.query.data_fim || dataHojeRecifeISO();
    let campoEscopo = null;
    let vendedorId = null;

    if (req.user.role === 'admin') {
      if (req.query.vendedor_id) {
        vendedorId = parseInt(req.query.vendedor_id, 10);
        const { rows } = await pool.query('SELECT role FROM vendedores WHERE id=$1', [vendedorId]);
        if (!rows.length) return res.status(404).json({ erro: 'Vendedor não encontrado' });
        campoEscopo = rows[0].role === 'subvendedor' ? 'subvendedor_id' : 'vendedor_id';
      }
    } else {
      vendedorId = parseInt(req.user.id, 10);
      campoEscopo = req.user.role === 'subvendedor' ? 'subvendedor_id' : 'vendedor_id';
    }

    const indicadores = await calcularIndicadoresDiaPorEscopo({ campoEscopo, vendedorId, dataReferencia });
    res.json({ ok: true, ...indicadores });
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
// ─── ROTAS PÚBLICAS DO APP MOBILE ────────────────────────────────────────────
// Usam authApp (x-move-app-key) em vez de JWT de vendedor

// Envia mensagem WhatsApp manual para o número de um cliente (suporte/promoção/avisos)
app.post('/api/bora/whatsapp/enviar', authMiddleware, async (req, res) => {
  try {
    const { msisdn, mensagem } = req.body;
    if (!msisdn) return res.status(400).json({ erro: 'Número não informado' });
    if (!mensagem || !mensagem.trim()) return res.status(400).json({ erro: 'Mensagem vazia' });
    await enviarWhatsAppMove(msisdn, mensagem.trim());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.response?.data?.message || e.message });
  }
});

// Transferir a venda de uma linha para outro vendedor (somente admin)
app.post('/api/linhas/transferir-vendedor', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { msisdn, novo_vendedor_id } = req.body;
    if (!msisdn || !novo_vendedor_id) return res.status(400).json({ erro: 'Informe a linha e o vendedor de destino' });

    // Confirma que o vendedor de destino existe
    const v = await pool.query('SELECT id, nome, role, parent_id FROM vendedores WHERE id=$1', [novo_vendedor_id]);
    if (!v.rows.length) return res.status(404).json({ erro: 'Vendedor de destino não encontrado' });
    const vendedor = v.rows[0];

    // Se for subvendedor, vendedor_id = parent, subvendedor_id = ele. Se for vendedor, subvendedor_id = null.
    const novoVendedorPrincipal = vendedor.role === 'subvendedor' ? (vendedor.parent_id || vendedor.id) : vendedor.id;
    const novoSubvendedor       = vendedor.role === 'subvendedor' ? vendedor.id : null;

    // Localiza a(s) linha(s) por MSISDN normalizado. Regra de negócio:
    // a linha tem apenas UM vendedor atual e a ÚLTIMA transferência sempre prevalece.
    // Por isso, buscamos qualquer registro local com o mesmo número, com/sem DDI 55 e com/sem máscara.
    const digitosMsisdn = String(msisdn).replace(/\D/g, '').replace(/^0+/, '');
    const msisdnBora = normalizarMsisdnParaBora(msisdn);
    const variantes = variantesMsisdn(msisdn);

    const sqlMesmoMsisdn = `
      SELECT id FROM linhas
       WHERE (
         CASE
           WHEN regexp_replace(COALESCE(msisdn::text, ''), '[^0-9]', '', 'g') LIKE '55%'
             THEN regexp_replace(COALESCE(msisdn::text, ''), '[^0-9]', '', 'g')
           WHEN length(regexp_replace(COALESCE(msisdn::text, ''), '[^0-9]', '', 'g')) IN (10,11)
             THEN '55' || regexp_replace(COALESCE(msisdn::text, ''), '[^0-9]', '', 'g')
           ELSE regexp_replace(COALESCE(msisdn::text, ''), '[^0-9]', '', 'g')
         END
       ) = $1
       OR regexp_replace(COALESCE(msisdn::text, ''), '[^0-9]', '', 'g') = ANY($2::text[])
    `;

    let linhaRes = await pool.query(sqlMesmoMsisdn, [msisdnBora || digitosMsisdn, variantes]);

    // Se a linha veio da consulta/Bora, mas ainda não existe no banco local, cria o vínculo mínimo no CRM.
    // O histórico completo será buscado na Bora logo abaixo e vinculado ao novo vendedor.
    let linhaCriadaNoCrm = false;
    if (!linhaRes.rows.length) {
      const iccidTransferencia = `transferencia-${msisdnBora || digitosMsisdn}`;
      linhaRes = await pool.query(
        `INSERT INTO linhas (iccid, msisdn, vendedor_id, subvendedor_id, status)
         VALUES ($1,$2,$3,$4,'ativa')
         ON CONFLICT (iccid) DO UPDATE
         SET msisdn=$2, vendedor_id=$3, subvendedor_id=$4
         RETURNING id`,
        [iccidTransferencia, msisdnBora || digitosMsisdn, novoVendedorPrincipal, novoSubvendedor]
      );
      linhaCriadaNoCrm = true;
    }

    // Reconsulta após eventual criação para garantir que todos os registros locais deste mesmo MSISDN
    // sejam atualizados para o último vendedor. Isso impede que a mesma linha fique vinculada a 2 vendedores.
    linhaRes = await pool.query(sqlMesmoMsisdn, [msisdnBora || digitosMsisdn, variantes]);

    const linhaIdsTransferidas = linhaRes.rows.map(r => Number(r.id)).filter(Boolean);

    let linhasAfetadas = 0, transacoesAfetadas = 0;
    let historicoInserido = 0;
    let historicoAtualizado = 0;
    const historicoBora = [];

    for (const { id: linhaId } of linhaRes.rows) {
      // 1) Transfere a linha para o último vendedor selecionado.
      // Esta atualização intencionalmente sobrescreve qualquer vendedor anterior.
      const r1 = await pool.query(
        'UPDATE linhas SET vendedor_id=$1, subvendedor_id=$2 WHERE id=$3',
        [novoVendedorPrincipal, novoSubvendedor, linhaId]
      );

      // 2) Antes de finalizar, busca o histórico da Bora e cria as transações antigas que ainda não existem.
      // Assim a linha passa a contar para o vendedor recebido desde a ativação, inclusive em relatórios por período.
      const sync = await sincronizarHistoricoRecargasLinha({
        linhaId,
        msisdn: msisdnBora || digitosMsisdn,
        vendedorId: novoVendedorPrincipal,
        subvendedorId: novoSubvendedor
      });
      historicoBora.push(sync);
      historicoInserido += Number(sync.inseridas || 0);
      historicoAtualizado += Number(sync.atualizadas || 0);

      // 3) Garante que TODO o histórico local existente dessa linha vá para o novo vendedor.
      const r2 = await pool.query(
        'UPDATE transacoes SET vendedor_id=$1, subvendedor_id=$2 WHERE linha_id=$3',
        [novoVendedorPrincipal, novoSubvendedor, linhaId]
      );

      linhasAfetadas += r1.rowCount;
      transacoesAfetadas += r2.rowCount;
    }

    // Reforço final: se existirem registros duplicados no CRM para o mesmo MSISDN,
    // todos ficam com o mesmo vendedor atual e todas as transações passam para ele.
    if (linhaIdsTransferidas.length) {
      await pool.query(
        'UPDATE linhas SET vendedor_id=$1, subvendedor_id=$2 WHERE id = ANY($3::int[])',
        [novoVendedorPrincipal, novoSubvendedor, linhaIdsTransferidas]
      );
      const rFinal = await pool.query(
        'UPDATE transacoes SET vendedor_id=$1, subvendedor_id=$2 WHERE linha_id = ANY($3::int[])',
        [novoVendedorPrincipal, novoSubvendedor, linhaIdsTransferidas]
      );
      transacoesAfetadas = Math.max(transacoesAfetadas, rFinal.rowCount);
    }

    res.json({
      ok: true,
      vendedor: vendedor.nome,
      linhasAfetadas,
      transacoesAfetadas,
      linhaCriadaNoCrm,
      historicoInserido,
      historicoAtualizado,
      regraTransferencia: 'ultima_transferencia_prevalece',
      vendedorAtualId: novoVendedorPrincipal,
      subvendedorAtualId: novoSubvendedor,
      linhaIdsTransferidas,
      historicoBora
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Logo público da Move (sem autenticação) — usado na tela inicial do app
app.get('/api/app/logo', (req, res) => {
  const url = obterMoveLogoUrl();
  res.json({ url });
});

// Cobranças mensais do cliente (por CPF)
app.get('/api/app/cobrancas/:cpf', authApp, async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/\D/g, '');
    // Busca linhas ativas do cliente no banco
    const { rows: linhas } = await pool.query(
      `SELECT msisdn, plano_nome, documento_cliente FROM linhas WHERE documento_cliente = $1 AND msisdn IS NOT NULL`,
      [cpf]
    );
    if (!linhas.length) return res.json({ cobracas: [] });

    const todas = [];
    for (const linha of linhas) {
      try {
        const boletos = await boraGet(`/api/Subscriber/${linha.documento_cliente}/billets`);
        const lista = Array.isArray(boletos) ? boletos : (boletos?.items || boletos?.billets || []);
        for (const b of lista) {
          todas.push({
            id:        b.id || b.billetId || null,
            msisdn:    linha.msisdn,
            plano:     linha.plano_nome || '—',
            barcode:   b.digitableLine || b.barCode || b.typeableLine || null,
            url:       b.url || b.pdfUrl || b.link || null,
            pixCode:   b.pix?.code || b.pixCode || null,
            pixQrUrl:  b.pix?.qrCodeUrl || b.pixQrUrl || null,
            valor:     parseFloat(b.value || b.amount || b.price || 0),
            vencimento:b.dueDate || b.expiration || null,
            pago:      !!(b.paid || b.paymentDate),
          });
        }
      } catch {}
    }

    // Ordena: pendentes primeiro, depois por vencimento
    todas.sort((a, b) => {
      if (a.pago !== b.pago) return a.pago ? 1 : -1;
      return new Date(a.vencimento || 0) - new Date(b.vencimento || 0);
    });

    res.json({ cobrancas: todas });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Envia cobrança por email
app.post('/api/app/cobrancas/enviar-email', authApp, async (req, res) => {
  try {
    const { cpf, msisdn, barcode, pixCode, url, email, nome, plano, vencimento } = req.body;

    // Tenta buscar email do titular na Bora se não vier no payload
    let emailFinal = email || null;
    let nomeFinal  = nome  || null;
    if (!emailFinal && msisdn) {
      try {
        const details = await boraGet(`/api/Subscription/${msisdn}/details`);
        const doc = details?.document || cpf;
        if (doc) {
          const sub = await boraGet(`/api/Subscriber/${doc}/document`);
          emailFinal = sub?.email || null;
          nomeFinal  = nomeFinal || sub?.name || null;
        }
      } catch {}
    }
    if (!emailFinal) return res.status(400).json({ erro: 'E-mail não encontrado para esta linha.' });

    const vencStr = vencimento ? new Date(vencimento).toLocaleDateString('pt-BR') : null;
    const titulo  = `Sua fatura Move${plano ? ' — ' + plano : ''}${vencStr ? ' — Venc. ' + vencStr : ''}`;

    if (pixCode) {
      await enviarEmailPix({ email: emailFinal, nome: nomeFinal, pixCode, planoNome: plano || 'Mensalidade Move', planoValor: 0 });
    } else if (barcode || url) {
      await enviarEmailBoleto({ email: emailFinal, nome: nomeFinal, barcode, url });
    } else {
      return res.status(400).json({ erro: 'Nenhum código de pagamento disponível para enviar.' });
    }

    res.json({ ok: true, destino: emailFinal });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Próximo eSIM disponível no estoque
app.get('/api/app/esim/proximo', authApp, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT iccid FROM esims
       WHERE (status IS NULL OR status = 'disponivel')
         AND iccid IS NOT NULL
       ORDER BY id ASC LIMIT 1`
    );
    if (!rows.length) return res.status(404).json({ erro: 'Nenhum eSIM disponível no estoque. Entre em contato com o suporte.' });
    res.json({ iccid: rows[0].iccid });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Planos habilitados para ativação (respeita filtro do admin)
app.get('/api/app/planos/ativacao', authApp, async (req, res) => {
  try {
    const data = await boraGet('/api/Plan/Activation');
    const lista = Array.isArray(data) ? data : (data?.plans || data?.items || []);
    const { rows } = await pool.query('SELECT plano_id FROM planos_comissao WHERE habilitado = true');
    const habilitados = new Set(rows.map(r => String(r.plano_id)));
    const filtrado = habilitados.size > 0
      ? lista.filter(p => habilitados.has(String(p.idPlanExternal || p.id || p.planId || '')))
      : lista;
    res.json(filtrado);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// DDDs disponíveis
app.get('/api/app/ddds', authApp, async (req, res) => {
  try {
    const data = await boraGet('/api/Cart/DDD');
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Verificar ICCID (chip físico)
app.get('/api/app/iccid/:iccid', authApp, async (req, res) => {
  try {
    const data = await boraGet(`/api/Card/${req.params.iccid}`);
    res.json(data);
  } catch (e) { res.status(e.response?.status || 500).json({ erro: e.response?.data || e.message }); }
});

// Ativação completa pelo app (eSIM ou físico) com emails automáticos
app.post('/api/app/ativar', authApp, async (req, res) => {
  try {
    const { subscriber, tipoChip, ddd, planId, planType, paymentType, recorrencia, plano_id, plano_nome, plano_valor } = req.body;

    // Cria ou busca subscriber na Bora antes do loop (evita criar duplicado a cada tentativa)
    let clientId = null;
    try {
      const existing = await boraGet(`/api/Subscriber/${subscriber.document}/document`);
      clientId = existing?.idSubscriberExternal || existing?.id || null;
    } catch {}
    if (!clientId) {
      const subResp = await boraPost('/api/Subscriber', subscriber);
      clientId = subResp?.idSubscriberExternal || subResp?.id || null;
    }
    if (!clientId) throw new Error('Não foi possível registrar o cliente');

    // Determina ICCID e cria carrinho
    // Para eSIM: tenta até 5 chips do estoque; rejeição da Bora marca como inválido e passa para o próximo
    let iccid = req.body.iccid || null;
    let cart   = null;
    let cartId = null;

    if (tipoChip === 'esim') {
      const MAX = 5;
      for (let t = 1; t <= MAX; t++) {
        const { rows } = await pool.query(
          `SELECT iccid FROM esims WHERE (status IS NULL OR status = 'disponivel') AND iccid IS NOT NULL ORDER BY id ASC LIMIT 1`
        );
        if (!rows.length) {
          return res.status(409).json({ erro: 'Estoque de eSIM esgotado. Entre em contato com o suporte.' });
        }
        iccid = rows[0].iccid;
        try {
          cart = await boraPost('/api/Cart/subscription', { iccid, ddd, planId, planType: planType || 'Controle', clientId });
          cartId = cart.cartId || cart.id;
          if (!cartId) throw new Error('cartId não retornado');
          break; // sucesso — sai do loop
        } catch (cartErr) {
          // ICCID rejeitado pela Bora — descarta do estoque e tenta o próximo
          console.error(`[app-ativar] eSIM ${iccid} rejeitado (tentativa ${t}/${MAX}):`, cartErr.message);
          await pool.query(
            `UPDATE esims SET status='invalido', usado_em=NOW() WHERE iccid=$1`, [iccid]
          ).catch(() => null);
          iccid = null; cart = null; cartId = null;
          if (t === MAX) return res.status(409).json({ erro: `Nenhum eSIM válido disponível após ${MAX} tentativas. Contate o suporte.` });
        }
      }
    } else {
      if (!iccid) return res.status(400).json({ erro: 'ICCID não informado' });
      cart = await boraPost('/api/Cart/subscription', { iccid, ddd, planId, planType: planType || 'Controle', clientId });
      cartId = cart.cartId || cart.id;
      if (!cartId) throw new Error('Erro ao criar carrinho');
    }

    // Processa pagamento
    const recType = recorrencia || 'BILLET';
    let pagamento;
    if (paymentType === 'pix') {
      pagamento = await boraPost(`/api/Cart/subscription/${cartId}/pix`, { isRecurrence: true, recurrenceType: recType });
    } else if (paymentType === 'billet') {
      pagamento = await boraPost(`/api/Cart/subscription/${cartId}/billet`, { isRecurrence: true, recurrenceType: recType });
    } else if (paymentType === 'billetcombo') {
      pagamento = await boraPost(`/api/Cart/subscription/${cartId}/BilletCombo`, {});
    } else {
      throw new Error('Forma de pagamento inválida');
    }

    const msisdnFinal = pagamento?.msisdn || pagamento?.pmsisdn || null;
    const pixData = pagamento?.pix || null;

    // Salva no banco (vendedor_id = 1 = operação própria Move)
    const { rows: planoRows } = await pool.query('SELECT comissao_ativacao FROM planos_comissao WHERE plano_id=$1', [plano_id]);
    const comissao = planoRows[0]?.comissao_ativacao || 0;

    const { rows: linhaRows } = await pool.query(
      `INSERT INTO linhas (iccid, msisdn, vendedor_id, plano_id, plano_nome, documento_cliente, nome_cliente)
       VALUES ($1,$2,1,$3,$4,$5,$6)
       ON CONFLICT (iccid) DO UPDATE SET msisdn=$2, plano_id=$3, plano_nome=$4
       RETURNING id`,
      [iccid, msisdnFinal, plano_id, plano_nome, subscriber.document, subscriber.name]
    );
    await pool.query(
      `INSERT INTO transacoes (linha_id, vendedor_id, tipo, plano_id, plano_nome, valor_plano, comissao, fonte)
       VALUES ($1,1,'ativacao',$2,$3,$4,$5,'app')`,
      [linhaRows[0].id, plano_id, plano_nome, plano_valor, comissao]
    );

    // Marca eSIM como usado
    await pool.query(
      `UPDATE esims SET status='usado', msisdn=$1, nome_cliente=$2, documento_cliente=$3, usado_em=NOW() WHERE iccid=$4`,
      [msisdnFinal, subscriber.name, subscriber.document, iccid]
    ).catch(() => null);

    // Email de PIX (não bloqueia a resposta)
    if (pixData?.code) {
      enviarEmailPix({ email: subscriber.email, nome: subscriber.name, pixCode: pixData.code, planoNome: plano_nome, planoValor: plano_valor })
        .catch(e => console.error('[app-ativar] email pix erro:', e.message));
    }

    // Email de QR Code eSIM (já existente, não bloqueia)
    capturarSalvarEnviarQrCodeEsim({ iccid, email: subscriber.email, nome: subscriber.name, msisdn: msisdnFinal })
      .catch(e => console.error('[app-ativar] esim qr erro:', e.message));

    res.json({
      ok: true,
      iccid,
      msisdn: msisdnFinal,
      tipoChip,
      emailEnviado: subscriber.email,
      pix: pixData ? { code: pixData.code, qrCodeUrl: pixData.qrCodeUrl } : null,
      billet: pagamento?.billet ? { url: pagamento.billet.url || pagamento.billet.digitableLine } : null,
    });
  } catch (e) {
    console.error('[app-ativar] erro:', e.message);
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.response?.data || e.message });
  }
});

app.post('/api/bora/ativar', authMiddleware, async (req, res) => {
  try {
    const { subscriber, cartPayload, paymentType, recorrencia, vendedor_id, plano_id, plano_nome, plano_valor } = req.body;

    // Bloqueio por limite de eSIMs pendentes (não pagos) no mês — só para eSIM
    const ehEsim = cartPayload?.tipoChip === 'esim' || cartPayload?.iccidType === 'E-SIM'
                || (cartPayload?.iccid && await esimEhTipoEsim(cartPayload.iccid));
    if (ehEsim) {
      const { vendedor_id: vendPrincipal } = await resolverEscopoVenda(req, vendedor_id);
      const limite = await contarEsimsPendentesVendedor(vendPrincipal);
      if (limite.bloqueado) {
        return res.status(403).json({
          erro: `Limite atingido: você tem ${limite.pendentes} ativações de eSIM não pagas este mês (máximo ${limite.limite}). Aguarde os clientes pagarem para liberar novas ativações.`,
          limite_pendentes: limite
        });
      }
    }

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

    // Confirma na Bora que o ICCID está realmente disponível antes de prosseguir.
    // Vale para eSIM e físico — evita o erro genérico "ICCID não está disponível".
    if (cartPayload.iccid && await esimJaUsadoNaBora(cartPayload.iccid)) {
      await pool.query(
        "UPDATE esims SET status='usado', usado_em=NOW() WHERE iccid=$1 AND status='disponivel'",
        [cartPayload.iccid]
      ).catch(() => null);
      return res.status(409).json({ erro: 'Este ICCID já foi utilizado e foi removido do estoque. Selecione outro.' });
    }

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
    let cart;
    try {
      cart = await boraPost('/api/Cart/subscription', cartBody);
    } catch (cartErr) {
      // Se a Bora rejeitou o ICCID, retira do estoque para não bloquear futuras ativações
      await pool.query(
        `UPDATE esims SET status='invalido', usado_em=NOW() WHERE iccid=$1 AND (status IS NULL OR status='disponivel')`,
        [cartPayload.iccid]
      ).catch(() => null);
      throw cartErr;
    }
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
      const { rows: pcRows } = await pool.query(
        `SELECT * FROM planos_comissao
          WHERE plano_id::text=$1::text OR UPPER(TRIM(plano_nome))=UPPER(TRIM($2))
          LIMIT 1`,
        [plano_id || '', plano_nome || '']
      );
      const cfg = pcRows[0] || {};
      const comissaoRecarga = parseFloat(r.comissao || 0) || parseFloat(cfg.comissao_recarga || 0) || 0;
      await pool.query(
        `INSERT INTO transacoes (linha_id, vendedor_id, subvendedor_id, tipo, plano_id, plano_nome, valor_plano, comissao, periodo_referencia, fonte)
         VALUES ($1,$2,$3,'recarga',$4,$5,$6,$7,$8,'retroativo')
         ON CONFLICT DO NOTHING`,
        [linhaId, escopo.vendedor_id, escopo.subvendedor_id, plano_id || cfg.plano_id || null, plano_nome || cfg.plano_nome || null, cfg.plano_valor || null, comissaoRecarga, periodoNorm]
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

// Verifica na Bora se um ICCID já está em uso.
// Resposta real da Bora no endpoint /iccid: { status: "IN_USE" | "AVAILABLE", iccid, ... }
async function esimJaUsadoNaBora(iccid) {
  try {
    const data = await boraGet(`/api/Subscriber/${encodeURIComponent(iccid)}/iccid`);
    const status = String(data?.status || '').toUpperCase();
    // Só marca como usado quando a Bora informa explicitamente um estado de uso.
    // Estados conhecidos de indisponibilidade: IN_USE, USED, ACTIVE, BLOCKED, CANCELED.
    const usado = ['IN_USE', 'USED', 'ACTIVE', 'BLOCKED', 'CANCELED', 'CANCELLED', 'SUSPENDED'].includes(status);
    return usado;
  } catch (e) {
    // Erro de consulta (404, rede): não remove para não tirar eSIM bom por engano.
    return false;
  }
}

// Sincroniza o estoque local com a Bora: marca como usado os que já estão em uso lá
async function sincronizarEstoqueEsim() {
  const { rows } = await pool.query(
    "SELECT iccid FROM esims WHERE status='disponivel' AND iccid IS NOT NULL"
  );
  let sincronizados = 0;
  for (const { iccid } of rows) {
    try {
      if (await esimJaUsadoNaBora(iccid)) {
        await pool.query(
          "UPDATE esims SET status='usado', usado_em=NOW() WHERE iccid=$1 AND status='disponivel'",
          [iccid]
        );
        sincronizados++;
      }
    } catch {}
    await aguardar(150); // pausa leve entre consultas para não sobrecarregar a Bora
  }
  return sincronizados;
}

// Status do limite de eSIMs pendentes do vendedor logado (para exibir aviso na tela)
app.get('/api/esim/limite-pendentes', authMiddleware, async (req, res) => {
  try {
    const { vendedor_id } = await resolverEscopoVenda(req);
    const status = await contarEsimsPendentesVendedor(vendedor_id);
    res.json(status);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/esim/disponiveis', authMiddleware, async (req, res) => {
  try {
    // Sincroniza com a Bora antes de listar (remove os já usados lá)
    if (String(req.query.sync || 'true') !== 'false') {
      await sincronizarEstoqueEsim().catch(e => console.error('[esim-sync]', e.message));
    }
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

    let detalhes = [];

    if (tipo === 'cpf') {
      // Busca todas as assinaturas do CPF e depois busca details de cada uma
      const cpf = valor.replace(/\D/g, '');
      const subs = await boraGet(`/api/Subscription/${cpf}`);
      const lista = Array.isArray(subs) ? subs : (subs?.subscriptions || subs?.items || [subs]);
      detalhes = await Promise.all(lista.slice(0, 10).map(async s => {
        try {
          const ms = s.msisdn || s.phoneNumber || s.number;
          if (!ms) return s;
          if (s.activationDate) return s; // já é details
          return await boraGet(`/api/Subscription/${ms}/details`);
        } catch { return s; }
      }));
    } else {
      // numero, iccid ou imsi — busca details diretamente
      const data = await boraGet(`/api/Subscription/${valor}/details`);
      detalhes = [data];
    }

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

// ─── NOTIFICAÇÃO WHATSAPP — vencimento em 24h ────────────────────────────────
async function executarNotifVencimento() {
  console.log('[NOTIF-WPP] Iniciando verificação de vencimentos...');
  const { rows: linhas } = await pool.query(`
    SELECT id, msisdn, plano_nome, documento_cliente, nome_cliente
    FROM linhas
    WHERE status = 'ativa' AND msisdn IS NOT NULL AND documento_cliente IS NOT NULL
  `);

  const agora    = new Date();
  const limite24 = new Date(agora.getTime() + 24 * 60 * 60 * 1000);
  let enviados = 0, pulados = 0, erros = 0;

  for (const linha of linhas) {
    try {
      // Busca boletos pendentes do subscriber na Bora
      const boletos = await boraGet(`/api/Subscriber/${linha.documento_cliente}/billets`);
      const lista   = Array.isArray(boletos) ? boletos : (boletos?.items || boletos?.billets || []);

      const bPendente = lista.find(b => {
        if (b.paid || b.paymentDate) return false;
        const venc = new Date(b.dueDate || b.expiration || 0);
        return venc > agora && venc <= limite24;
      });

      if (!bPendente) { pulados++; continue; }

      // Verifica se já notificou hoje (constraint única por dia)
      const jaEnviou = await pool.query(
        `SELECT 1 FROM move_notif_whatsapp
         WHERE msisdn=$1 AND tipo='vencimento_24h'
         AND DATE(enviado_em AT TIME ZONE 'America/Recife') = CURRENT_DATE`,
        [linha.msisdn]
      );
      if (jaEnviou.rows.length) { pulados++; continue; }

      const pixCode  = bPendente.pix?.code || bPendente.pixCode || null;
      const barcode  = bPendente.digitableLine || bPendente.barCode || bPendente.typeableLine || null;
      const valor    = parseFloat(bPendente.value || bPendente.amount || 0);
      const valorFmt = valor > 0 ? `R$ ${valor.toFixed(2).replace('.', ',')}` : '';
      const vencData = new Date(bPendente.dueDate || bPendente.expiration).toLocaleDateString('pt-BR');
      const foneFmt  = linha.msisdn.replace('55','').replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
      const nome     = (linha.nome_cliente || '').split(' ')[0] || 'cliente';

      let msg = `Olá, ${nome}! 👋\n\n`;
      msg    += `⏰ Sua fatura Move vence *hoje*!\n\n`;
      msg    += `📱 Linha: ${foneFmt}\n`;
      msg    += `📋 Plano: ${linha.plano_nome || '—'}\n`;
      if (valorFmt) msg += `💰 Valor: *${valorFmt}*\n`;
      msg    += `📅 Vencimento: ${vencData}\n`;

      if (pixCode) {
        msg += `\n⚡ *Pague via PIX — Copia e Cola:*\n${pixCode}\n`;
      } else if (barcode) {
        msg += `\n📄 *Linha digitável do boleto:*\n${barcode}\n`;
      }

      msg += `\nApós o pagamento sua linha continua ativa normalmente. ✅\n`;
      msg += `Dúvidas? Responda esta mensagem.`;

      await enviarWhatsAppMove(linha.msisdn, msg);

      await pool.query(
        `INSERT INTO move_notif_whatsapp (msisdn, tipo) VALUES ($1, 'vencimento_24h')
         ON CONFLICT DO NOTHING`,
        [linha.msisdn]
      );

      console.log(`[NOTIF-WPP] ✓ Enviado -> ${linha.msisdn} | venc: ${vencData}`);
      enviados++;
      await aguardar(1500); // pausa entre envios para não sobrecarregar Z-API

    } catch (e) {
      console.error(`[NOTIF-WPP] ✗ Erro linha ${linha.msisdn}:`, e.message);
      erros++;
    }
  }

  console.log(`[NOTIF-WPP] Concluído — enviados: ${enviados} | pulados: ${pulados} | erros: ${erros}`);
  return { enviados, pulados, erros };
}

// Cron: todo dia às 8h (BRT = UTC-3, então 11h UTC)
cron.schedule('0 11 * * *', () => {
  executarNotifVencimento().catch(e => console.error('[NOTIF-WPP] Erro cron:', e.message));
});

// Rota de disparo manual (admin) — para testar sem esperar o cron
app.post('/api/admin/notif/disparar-vencimentos', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas admin' });
  try {
    const resultado = await executarNotifVencimento();
    res.json({ ok: true, ...resultado });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});


// ─── NOTIFICAÇÃO WHATSAPP — parcial semanal de comissões dos vendedores ─────
function formatarMoedaBR(valor) {
  const n = Number(valor || 0);
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

function nomePrimeiro(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || 'vendedor';
}

async function executarNotifParcialComissoes({ forcar = false } = {}) {
  console.log('[COMISSOES-WPP] Iniciando envio de parcial semanal...');

  const { rows: vendedores } = await pool.query(`
    SELECT id, nome, telefone
      FROM vendedores
     WHERE ativo = true
       AND role = 'vendedor'
       AND telefone IS NOT NULL
       AND TRIM(telefone) <> ''
     ORDER BY nome
  `);

  let enviados = 0, pulados = 0, erros = 0;
  const detalhes = [];

  for (const vendedor of vendedores) {
    const telefoneLimpo = String(vendedor.telefone || '').replace(/\D/g, '');
    if (!telefoneLimpo) { pulados++; continue; }

    try {
      if (!forcar) {
        const jaEnviou = await pool.query(
          `SELECT 1 FROM move_notif_whatsapp
            WHERE msisdn=$1 AND tipo='parcial_comissao_7d'
              AND enviado_em >= (NOW() - INTERVAL '7 days')
            LIMIT 1`,
          [telefoneLimpo]
        );
        if (jaEnviou.rows.length) { pulados++; continue; }
      }

      const { rows: resumoRows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE tipo='ativacao') AS ativacoes,
          COUNT(*) FILTER (WHERE tipo='recarga') AS recargas,
          COALESCE(SUM(comissao) FILTER (WHERE tipo='ativacao'), 0) AS comissao_ativacao,
          COALESCE(SUM(comissao) FILTER (WHERE tipo='recarga'), 0) AS comissao_recarga,
          COALESCE(SUM(comissao), 0) AS total_comissao
        FROM transacoes
        WHERE vendedor_id = $1
          AND data_transacao >= date_trunc('month', (NOW() AT TIME ZONE 'America/Recife'))
          AND data_transacao <  date_trunc('month', (NOW() AT TIME ZONE 'America/Recife')) + INTERVAL '1 month'
      `, [vendedor.id]);

      const { rows: linhasRows } = await pool.query(`
        SELECT COUNT(*)::int AS total_linhas
          FROM linhas
         WHERE vendedor_id = $1
           AND data_ativacao >= date_trunc('month', (NOW() AT TIME ZONE 'America/Recife'))
           AND data_ativacao <  date_trunc('month', (NOW() AT TIME ZONE 'America/Recife')) + INTERVAL '1 month'
      `, [vendedor.id]);

      const r = resumoRows[0] || {};
      const ativacoes = Number(r.ativacoes || 0);
      const recargas = Number(r.recargas || 0);
      const comissaoAtivacao = Number(r.comissao_ativacao || 0);
      const comissaoRecarga = Number(r.comissao_recarga || 0);
      const totalComissao = Number(r.total_comissao || 0);
      const totalLinhas = Number(linhasRows[0]?.total_linhas || 0);

      const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Recife' });
      const mes = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Recife' });

      let msg = `Olá, ${nomePrimeiro(vendedor.nome)}! 👋\n\n`;
      msg += `📊 *Parcial das suas comissões — ${mes}*\n`;
      msg += `Atualizado em: ${hoje}\n\n`;
      msg += `✅ Ativações: *${ativacoes}*\n`;
      msg += `🔄 Recargas detectadas: *${recargas}*\n`;
      msg += `📱 Linhas vinculadas no mês: *${totalLinhas}*\n\n`;
      msg += `💰 Comissão por ativações: *${formatarMoedaBR(comissaoAtivacao)}*\n`;
      msg += `💰 Comissão por recargas: *${formatarMoedaBR(comissaoRecarga)}*\n`;
      msg += `🏁 *Total acumulado até agora: ${formatarMoedaBR(totalComissao)}*\n\n`;
      msg += `Este é um resumo automático. Para conferir os detalhes, acesse seu painel da Move.`;

      await enviarWhatsAppMove(telefoneLimpo, msg);

      await pool.query(
        `INSERT INTO move_notif_whatsapp (msisdn, tipo)
         VALUES ($1, 'parcial_comissao_7d')
         ON CONFLICT DO NOTHING`,
        [telefoneLimpo]
      );

      enviados++;
      detalhes.push({ vendedor_id: vendedor.id, nome: vendedor.nome, telefone: telefoneLimpo, total_comissao: totalComissao });
      console.log(`[COMISSOES-WPP] ✓ Enviado -> vendedor ${vendedor.id} | ${vendedor.nome} | ${formatarMoedaBR(totalComissao)}`);
      await aguardar(1500);
    } catch (e) {
      erros++;
      detalhes.push({ vendedor_id: vendedor.id, nome: vendedor.nome, erro: e.message });
      console.error(`[COMISSOES-WPP] ✗ Erro vendedor ${vendedor.id} (${vendedor.nome}):`, e.message);
    }
  }

  console.log(`[COMISSOES-WPP] Concluído — enviados: ${enviados} | pulados: ${pulados} | erros: ${erros}`);
  return { enviados, pulados, erros, detalhes };
}

// Cron: toda segunda-feira às 9h (BRT = UTC-3, então 12h UTC).
// Isso garante um disparo semanal, equivalente a uma parcial a cada 7 dias.
cron.schedule('0 12 * * 1', () => {
  executarNotifParcialComissoes().catch(e => console.error('[COMISSOES-WPP] Erro cron:', e.message));
});

// Rota manual para teste/acionamento administrativo.
// Envie { "forcar": true } no body se quiser ignorar o bloqueio de 7 dias no teste.
app.post('/api/admin/notif/disparar-parcial-comissoes', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas admin' });
  try {
    const resultado = await executarNotifParcialComissoes({ forcar: Boolean(req.body?.forcar) });
    res.json({ ok: true, ...resultado });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});
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
// Passo 1 — Busca dados da linha para exibir no modal de confirmação
app.get('/api/bora/reativar/:msisdn', authMiddleware, async (req, res) => {
  try {
    const msisdn = req.params.msisdn;
    const details = await boraGet(`/api/Subscription/${msisdn}/details`);
    const accountId = details?.accountId || null;

    // Bora retorna plan como array — pega o último (mais recente)
    const planArray   = Array.isArray(details?.plan) ? details.plan : [];
    const ultimoPlano = planArray[planArray.length - 1] || {};
    const planName    = ultimoPlano.name || ultimoPlano.nome
                     || details?.planData?.name || details?.planName || null;
    const planId      = ultimoPlano.idPlanExternal || ultimoPlano.planId || ultimoPlano.id
                     || details?.planData?.id || details?.planId || null;
    const recurrenceType = details?.recurrenceType || details?.paymentMethod || 'BILLET';

    // Se ainda não tem planId, resolve pelo nome nos planos disponíveis
    let planIdFinal = planId;
    if (!planIdFinal && planName) {
      try {
        const planos = await boraGet('/api/Plan/Activation');
        const lista  = Array.isArray(planos) ? planos : (planos.plans || planos.items || []);
        const match  = lista.find(p =>
          String(p.name || p.nome || '').toUpperCase().trim() === String(planName).toUpperCase().trim()
        );
        if (match) planIdFinal = match.idPlanExternal || match.id || match.planId || null;
      } catch {}
    }

    res.json({ accountId, planName, planId: planIdFinal, recurrenceType, details });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// Passo 2 — Suspende a linha (cancela recorrência automaticamente na Bora)
app.post('/api/bora/linha/:msisdn/suspender-recorrencia', authMiddleware, async (req, res) => {
  try {
    const msisdn = req.params.msisdn;
    const details = await boraGet(`/api/Subscription/${msisdn}/details`);
    const accountId = details?.accountId;
    if (!accountId) throw new Error('accountId não encontrado para esta linha');

    const data = await boraPut(`/api/Subscription/suspend/${accountId}`, {});
    await pool.query("UPDATE linhas SET status='suspensa' WHERE msisdn=$1", [msisdn]);
    res.json({ ok: true, accountId, data });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// Passo 3 — Gera cart de reativação e processa primeiro pagamento
app.post('/api/bora/reativar/pagamento', authMiddleware, async (req, res) => {
  try {
    const { msisdn, planId, paymentTypePrimeiro, paymentTypeRecorrencia } = req.body;
    if (!msisdn) throw new Error('msisdn obrigatório');
    if (!planId) throw new Error('planId obrigatório');
    if (!paymentTypePrimeiro) throw new Error('paymentTypePrimeiro obrigatório');

    // Busca clientId do subscriber pelo msisdn
    const details = await boraGet(`/api/Subscription/${msisdn}/details`);
    const documento = details?.document || details?.cpf || details?.subscriber?.document || null;
    if (!documento) throw new Error('Documento do assinante não encontrado');

    const subscriber = await boraGet(`/api/Subscriber/${documento}/document`);
    const clientId = subscriber?.idSubscriberExternal || subscriber?.id || null;
    if (!clientId) throw new Error('clientId não encontrado para este assinante');

    // Email e nome do titular (da Bora ou do payload)
    const emailTitular = req.body.email || subscriber?.email || details?.email || null;
    const nomeTitular  = req.body.nome  || subscriber?.name  || details?.name  || null;

    // Cria cart de reativação
    const cart = await boraPost('/api/Cart/reactivation', { msisdn, planId, clientId });
    const cartId = cart?.cartId || cart?.id;
    if (!cartId) throw new Error('cartId não retornado pela Bora na reativação');

    // Processa primeiro pagamento conforme escolha do usuário
    const tipoNorm = String(paymentTypePrimeiro).toLowerCase();
    let pagamento;
    if (tipoNorm === 'pix') {
      pagamento = await boraPost(`/api/Cart/reactivation/${cartId}/pix`, {});
    } else if (tipoNorm === 'billetcombo') {
      pagamento = await boraPost(`/api/Cart/reactivation/${cartId}/BilletCombo`, {});
    } else {
      pagamento = await boraPost(`/api/Cart/reactivation/${cartId}/billet`, {});
    }

    const pixData    = pagamento?.pix    || null;
    const billetData = pagamento?.billet || null;

    // Envia email com o link de pagamento (não bloqueia a resposta)
    if (emailTitular) {
      if (pixData?.code) {
        enviarEmailPix({
          email: emailTitular,
          nome: nomeTitular,
          pixCode: pixData.code,
          planoNome: 'Reativação de linha',
          planoValor: 0
        }).catch(e => console.error('[reativar] email pix erro:', e.message));
      } else if (billetData?.barCode || billetData?.digitableLine || billetData?.url) {
        enviarEmailBoleto({
          email: emailTitular,
          nome: nomeTitular,
          barcode: billetData.barCode || billetData.digitableLine || '',
          url: billetData.url || billetData.pdfUrl || ''
        }).catch(e => console.error('[reativar] email boleto erro:', e.message));
      }
    }

    res.json({
      ok: true,
      cartId,
      msisdn,
      pix: pixData ? {
        code:      pixData.code      || null,
        qrCodeUrl: pixData.qrCodeUrl || null,
        protocol:  pixData.protocol  || null
      } : null,
      billet: billetData ? {
        url:     billetData.url            || billetData.digitableLine || null,
        barcode: billetData.barCode        || billetData.digitableLine || null
      } : null,
      paymentTypeRecorrencia: paymentTypeRecorrencia || 'billet'
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.message });
  }
});

// Reativação — fluxo real da Bora (2 passos):
//   1) POST /api/Subscription/reactivation { msisdn } -> { cartId, clientId, planId }
//   2) POST /api/cart/recharge/{cartId}/{pix|billet|BilletCombo} { isRecurrence, recurrenceType, cartId }
app.post('/api/bora/reativar', authMiddleware, async (req, res) => {
  try {
    const { msisdn, paymentType, pagamento, paymentTypeRecorrencia, recorrencia, email, nome } = req.body;
    if (!msisdn) throw new Error('msisdn obrigatório');

    // primeiro pagamento: pix | billet | billetcombo
    const tipoPrimeiro   = String(paymentType || pagamento || 'pix').toLowerCase();
    // recorrência: BILLET | CREDIT
    const tipoRecorrente = String(paymentTypeRecorrencia || recorrencia || 'BILLET').toUpperCase();

    // ── Passo 1: cria o carrinho de reativação (Bora só aceita { msisdn }) ──
    const react = await boraPost('/api/Subscription/reactivation', { msisdn });
    const cartId = react?.cartId || react?.cart?.id || null;
    if (!cartId) throw new Error('cartId não retornado pela reativação');

    // ── Passo 2: processa o primeiro pagamento sobre o cartId ──
    const payBody = { isRecurrence: true, recurrenceType: tipoRecorrente, cartId };
    let pagamentoResp;
    if (tipoPrimeiro === 'pix') {
      pagamentoResp = await boraPost(`/api/cart/recharge/${cartId}/pix`, payBody);
    } else if (tipoPrimeiro === 'billetcombo') {
      pagamentoResp = await boraPost(`/api/cart/recharge/${cartId}/BilletCombo`, payBody);
    } else {
      pagamentoResp = await boraPost(`/api/cart/recharge/${cartId}/billet`, payBody);
    }

    await pool.query("UPDATE linhas SET status='ativa' WHERE msisdn=$1", [msisdn]).catch(() => null);

    // Extrai PIX / boleto da resposta
    const pixData    = pagamentoResp?.pix || null;
    const billetData = pagamentoResp?.billet || null;
    const pixCode    = pixData?.code || pagamentoResp?.pixCode || pagamentoResp?.pixCopyPaste || null;
    const pixQrUrl   = pixData?.qrCodeUrl || pagamentoResp?.qrCodeUrl || null;
    const barcode    = billetData?.barCode || billetData?.digitableLine || pagamentoResp?.barcode || null;
    const billetUrl  = billetData?.url || billetData?.pdfUrl || pagamentoResp?.billetUrl || null;

    // Email do titular (payload -> Bora details)
    let emailFinal = email || null;
    let nomeFinal  = nome  || null;
    if (!emailFinal) {
      try {
        const details = await boraGet(`/api/Subscription/${msisdn}/details`);
        emailFinal = details?.email || null;
        nomeFinal  = nomeFinal || details?.name || null;
      } catch {}
    }

    if (emailFinal) {
      if (pixCode) {
        enviarEmailPix({ email: emailFinal, nome: nomeFinal, pixCode, planoNome: 'Reativação de linha', planoValor: 0 })
          .catch(e => console.error('[reativar] email pix:', e.message));
      } else if (barcode || billetUrl) {
        enviarEmailBoleto({ email: emailFinal, nome: nomeFinal, barcode, url: billetUrl })
          .catch(e => console.error('[reativar] email boleto:', e.message));
      }
    }

    res.json({
      ok: true,
      msisdn,
      cartId,
      pix:    pixCode ? { code: pixCode, qrCodeUrl: pixQrUrl } : null,
      billet: (barcode || billetUrl) ? { barcode, url: billetUrl } : null,
    });
  } catch (e) {
    console.error('[reativar] erro:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ erro: e.response?.data?.detail || e.response?.data?.message || e.message });
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

// PIX pendente de uma linha (por MSISDN) — busca em boletos de assinatura E de recarga
app.get('/api/bora/linha/:msisdn/pix-pendente', authMiddleware, async (req, res) => {
  try {
    const msisdn = req.params.msisdn;
    const details = await boraGet(`/api/Subscription/${msisdn}/details`);
    const doc = details?.document || details?.cpf || null;

    const planArray = Array.isArray(details?.plan) ? details.plan : [];
    const planoNome = planArray[planArray.length-1]?.name || details?.planName || '';

    // Helper: encontra boleto pendente com PIX numa lista
    function acharPixPendente(lista) {
      const arr = Array.isArray(lista) ? lista : (lista?.items || lista?.billets || lista?.data || []);
      return arr.find(b => {
        if (b.paid || b.paymentDate) return false;
        // aceita qualquer campo que pareça código PIX (string longa)
        const code = b.pix?.code || b.pixCode || b.pixCopyPaste || b.qrCode?.code || null;
        return !!code;
      }) || null;
    }

    function extrairPix(b) {
      return {
        tem_pix:   true,
        code:      b.pix?.code || b.pixCode || b.pixCopyPaste || b.qrCode?.code || null,
        qrCodeUrl: b.pix?.qrCodeUrl || b.pixQrUrl || b.qrCode?.url || b.qrCodeUrl || null,
        valor:     parseFloat(b.value || b.amount || b.price || 0),
        plano:     planoNome,
        msisdn,
        vencimento:b.dueDate || b.expiration || null,
      };
    }

    // 1) Boletos do subscriber (assinatura)
    if (doc) {
      try {
        const boletos = await boraGet(`/api/Subscriber/${doc}/billets`);
        const b = acharPixPendente(boletos);
        if (b) return res.json(extrairPix(b));
      } catch {}
    }

    // 2) Pool global de pendentes filtrado pelo msisdn desta linha
    try {
      const pendentes = await boraGet('/api/Subscriber/billets/pending');
      const arr = Array.isArray(pendentes) ? pendentes : (pendentes?.items || pendentes?.billets || pendentes?.data || []);
      const b = arr.find(x => {
        if (x.paid || x.paymentDate) return false;
        const ms = x.msisdn || x.phoneNumber || x.subscriber?.msisdn || '';
        if (ms && ms !== msisdn) return false; // se tem msisdn e é diferente, pula
        const code = x.pix?.code || x.pixCode || x.pixCopyPaste || x.qrCode?.code || null;
        return !!code;
      });
      if (b) return res.json(extrairPix(b));
    } catch {}

    // 3) Carrinhos pendentes do subscriber (recargas)
    if (doc) {
      try {
        const carts = await boraGet(`/api/Subscriber/${doc}/carts`);
        const arr = Array.isArray(carts) ? carts : (carts?.items || carts?.carts || carts?.data || []);
        const b = arr.find(x => {
          if (x.paid || x.paymentDate || x.status === 'paid') return false;
          const code = x.pix?.code || x.pixCode || x.pixCopyPaste || null;
          return !!code;
        });
        if (b) return res.json(extrairPix(b));
      } catch {}
    }

    res.json({ tem_pix: false });
  } catch (e) {
    res.status(e.response?.status || 500).json({ erro: e.message });
  }
});

// Envia o código PIX por WhatsApp para o MSISDN da linha
app.post('/api/bora/linha/:msisdn/pix/enviar-whatsapp', authMiddleware, async (req, res) => {
  try {
    const { code, valor, plano } = req.body;
    const msisdn   = req.params.msisdn;
    const valorFmt = parseFloat(valor || 0) > 0
      ? `R$ ${parseFloat(valor).toFixed(2).replace('.', ',')}` : '';
    const foneFmt  = msisdn.replace('55','').replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');

    let msg  = `⚡ *PIX Move${plano ? ' — ' + plano : ''}*\n\n`;
    msg     += `📱 Linha: ${foneFmt}\n`;
    if (valorFmt) msg += `💰 Valor: *${valorFmt}*\n`;
    msg     += `\n*Código PIX — Copia e Cola:*\n${code}`;

    await enviarWhatsAppMove(msisdn, msg);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/bora/linha/:doc/boleto', authMiddleware, async (req, res) => {  try {
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
          console.error(`[CRON] Erro na linha ${linha.msisdn}: ${err.message} | Bora respondeu:`, JSON.stringify(err.response?.data || 'sem corpo'));
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
garantirTabelaNotifWhatsapp().catch(err => console.error('[DB] Erro ao preparar tabela notif WhatsApp:', err.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bora Vendas rodando na porta ${PORT}`);
  setTimeout(checarRecargas, 2 * 60 * 1000);
});
