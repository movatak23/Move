require('dotenv').config();
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const { Resend } = require('resend');
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');
const db      = require('./db');

// Migração: criar tabelas novas no banco existente
db.migrar();


const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

const {
  NUVEM_CLIENT_ID,
  NUVEM_CLIENT_SECRET,
  APP_URL,
  EXTENSION_SECRET,
  PORT = 3000,
  MP_ACCESS_TOKEN,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN
} = process.env;

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.headers['x-secret'] !== EXTENSION_SECRET)
    return res.status(401).json({ error: 'Não autorizado.' });
  next();
}

// ── Nuvemshop API ─────────────────────────────────────────────────────────────
async function nuvemGet(storeId, path, params = {}) {
  const row = db.getToken(storeId);
  if (!row) throw new Error('Loja não autenticada.');
  const res = await axios.get(`https://api.nuvemshop.com.br/v1/${storeId}${path}`, {
    headers: {
      'Authentication': `bearer ${row.access_token}`,
      'User-Agent': `RastreioBot (${APP_URL})`,
      'Content-Type': 'application/json'
    },
    params
  });
  return res.data;
}

function formatTel(tel) {
  if (!tel) return null;
  const d = String(tel).replace(/\D/g, '');
  if (!d || d.length < 10) return null;
  if (d.startsWith('55') && d.length >= 12) return d;
  return '55' + d;
}

function diasUteisDesde(dateStr) {
  if (!dateStr) return null;
  const data = new Date(dateStr);
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  data.setHours(0,0,0,0);
  let dias = 0;
  const cur = new Date(data);
  while (cur < hoje) {
    cur.setDate(cur.getDate() + 1);
    const d = cur.getDay();
    if (d !== 0 && d !== 6) dias++;
  }
  return dias;
}

// ── Limite diário por número ──────────────────────────────────────────────────
async function podEnviar(telefone) {
  const count = db.mensagensHoje(telefone);
  if (count >= 3) {
    console.log(`[Limite] ${telefone} já recebeu ${count} mensagens hoje. Bloqueado.`);
    return false;
  }
  return true;
}

// ── Z-API ─────────────────────────────────────────────────────────────────────
async function sendWhatsApp(telefone, mensagem, storeId) {
  // Tenta instância do cliente primeiro, fallback para variáveis de ambiente
  let instance, token, clientToken;

  if (storeId) {
    const inst = db.getInstancia(storeId);
    if (inst) {
      instance    = inst.zapi_instance;
      token       = inst.zapi_token;
      clientToken = inst.zapi_client_token;
    }
  }

  // Fallback para variáveis de ambiente (compatibilidade retroativa)
  if (!instance) {
    if (!ZAPI_INSTANCE || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN)
      throw new Error('Z-API não configurada.');
    instance    = ZAPI_INSTANCE;
    token       = ZAPI_TOKEN;
    clientToken = ZAPI_CLIENT_TOKEN;
  }

  let numero = String(telefone).replace(/\D/g, '');
  if (numero.startsWith('55')) numero = numero.slice(2);

  const res = await axios.post(
    `https://api.z-api.io/instances/${instance}/token/${token}/send-text`,
    { phone: numero, message: mensagem },
    { headers: { 'Client-Token': clientToken, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// ── Correios API ──────────────────────────────────────────────────────────────
async function consultarCorreios(codigo) {
  const SEURASTREIO_KEY = process.env.SEURASTREIO_KEY;
  if (!SEURASTREIO_KEY) {
    console.error('[Correios] SEURASTREIO_KEY não configurada.');
    return null;
  }
  try {
    const res = await axios.get(
      `https://seurastreio.com.br/api/public/rastreio/${codigo}`,
      {
        headers: { 'Authorization': `Bearer ${SEURASTREIO_KEY}` },
        timeout: 15000
      }
    );
    const evento = res.data?.eventoMaisRecente;
    if (!evento) return null;
    const descricao = evento.descricao || evento.status || '';
    const desc_lower = descricao.toLowerCase();
    const entregue = desc_lower.includes('entregue') || desc_lower.includes('objeto entregue');
    // Data vem em ISO ou "DD/MM/YYYY HH:mm"
    let data = '', hora = '';
    if (evento.data) {
      const partes = String(evento.data).split(' ');
      data = partes[0] || '';
      hora = partes[1] || '';
    }
    return { status: evento.status || '', descricao, data, hora, entregue };
  } catch(e) {
    console.error(`[Correios] Erro ao consultar ${codigo}:`, e.message);
    return null;
  }
}

// ── Mensagens ─────────────────────────────────────────────────────────────────
function montarMensagem(template, pedido) {
  const TRANSPORTADORAS = {
    'Correios': { emoji:'📮', url:'https://rastreamento.correios.com.br/app/index.php?objeto={c}' },
    'Jadlog':   { emoji:'🚚', url:'https://www.jadlog.com.br/siteInstitucional/tracking.jad?cte={c}' },
    'Loggi':    { emoji:'⚡', url:'https://www.loggi.com/rastreador/?code={c}' },
  };
  const t = Object.entries(TRANSPORTADORAS).find(([k]) => (pedido.transportadora||'').toLowerCase().includes(k.toLowerCase()));
  const transp = t ? t[1] : { emoji:'📦', url:'https://rastreamento.correios.com.br/app/index.php?objeto={c}' };
  const transpNome = t ? t[0] : (pedido.transportadora || 'Transportadora');
  const link = pedido.rastreio ? transp.url.replace('{c}', encodeURIComponent(pedido.rastreio)) : '';
  const padrao =
    `Olá {nome}! 👋\n\nSeu pedido *#{numero}* foi enviado!\n\n` +
    `{emoji} *Transportadora:* {transportadora}\n` +
    `📦 *Código de rastreio:* *{codigo}*\n\n` +
    `🔗 Rastreie sua entrega:\n{link}\n\nQualquer dúvida é só chamar! 😊`;
  return (template || padrao)
    .replace(/{nome}/g,           pedido.cliente || 'Cliente')
    .replace(/{numero}/g,         pedido.numero  || '')
    .replace(/{codigo}/g,         pedido.rastreio || '')
    .replace(/{transportadora}/g, transpNome)
    .replace(/{emoji}/g,          transp.emoji)
    .replace(/{link}/g,           link);
}

function montarMensagemRastreio(pedido, evento) {
  const nome   = pedido.cliente || 'Cliente';
  const numero = pedido.numero;
  const link   = `https://rastreamento.correios.com.br/app/index.php?objeto=${pedido.rastreio}`;
  const desc   = (evento.descricao || '').toLowerCase();
  const data   = evento.data || '';
  const hora   = evento.hora || '';

  // Entregue
  if (evento.entregue) {
    return (
      `✅ ${nome}, seu pedido *#${numero}* foi entregue!\n\n` +
      `Esperamos que você goste! Qualquer dúvida é só chamar. 😊`
    );
  }

  // Saiu para entrega
  if (desc.includes('saiu para entrega') || desc.includes('saiu para a entrega') || desc.includes('entrega prevista')) {
    return (
      `🎉 ${nome}, seu pedido *#${numero}* saiu para entrega hoje!\n\n` +
      `Fique de olho, o entregador está a caminho! 📦\n` +
      `🔗 Rastreie: ${link}`
    );
  }

  // Postado (primeiro registro)
  if (desc.includes('postado') || desc.includes('objeto postado') || desc.includes('coletado')) {
    return (
      `📮 Olá, ${nome}! Seu pedido *#${numero}* foi postado!\n\n` +
      `Código de rastreio: *${pedido.rastreio}*\n` +
      `🔗 Rastreie: ${link}\n\n` +
      `Em breve chegará até você! 😊`
    );
  }

  // Em trânsito (padrão para demais status)
  return (
    `🚚 Boa notícia, ${nome}! Seu pedido *#${numero}* está a caminho!\n\n` +
    `📍 Status: *${evento.descricao}*\n` +
    `📅 ${data} às ${hora}\n\n` +
    `🔗 Rastreie: ${link}`
  );
}

// MSG_PAGAMENTO montada dinamicamente — ver montarMensagemPagamento()
function montarMensagemPagamento(nome, numero) {
  return (
    `👏👏👏 #Parabéns, ${nome}!👏👏👏\n` +
    `Seu pagamento do pedido *#${numero}* foi confirmado!\n\n` +
    `Nosso prazo de produção é de 3 dias úteis. Sua estampa entrou na fila de impressão agora e segue a sequência de pedidos.\n\n` +
    `Lembrando que este prazo está sujeito a alteração devido a necessidade de manutenção emergencial em nosso maquinário.`
  );
}

// ── CRON — Limpeza semanal do banco (toda domingo às 3h) ─────────────────────
cron.schedule('0 3 * * 0', () => {
  try {
    db.limparRegistrosAntigos();
    console.log('[Limpeza] Banco limpo com sucesso.');
  } catch(e) {
    console.error('[Limpeza] Erro:', e.message);
  }
});

// ── CRON — Roda a cada 30 minutos ─────────────────────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  console.log('[Cron] Iniciando verificação...');
  try {
    const stores = db.getAllStores();
    for (const store of stores) {
      await verificarPagamentos(store.store_id);
      await verificarBoletosPendentes(store.store_id);
      await verificarCarrinhosAbandonados(store.store_id);
      await verificarRastreios(store.store_id);
      await verificarPosEntrega(store.store_id);
      await verificarPedidosParados(store.store_id);
    }
  } catch(e) {
    console.error('[Cron] Erro geral:', e.message);
  }
});

// ── Mensagens de carrinho abandonado ─────────────────────────────────────────
function montarMensagemCarrinho(etapa, nome, link) {
  const msgs = {
    30: `Olá, ${nome}! 👋

Percebemos que você deixou alguns itens no carrinho da nossa loja.

Ainda está interessado? Finalize sua compra aqui:
🛒 ${link}

Qualquer dúvida é só chamar! 😊`,

    60: `Oi, ${nome}! Tudo bem? 😊

Notamos que sua compra ainda não foi concluída. Teve algum problema no pagamento?

Estamos aqui para ajudar! Responda essa mensagem ou finalize agora:
🛒 ${link}`,

    1440: `${nome}, sua sacola ainda está te esperando! 🛍️

⚠️ *Atenção:* Os itens no seu carrinho têm estoque limitado e podem esgotar a qualquer momento.

Não deixe para depois — garanta o seu agora:
🛒 ${link}`,

    2880: `${nome}, última chance! ⏰

Sua reserva expira em breve e os produtos do seu carrinho voltam para o estoque.

Finalize sua compra antes que acabe:
🛒 ${link}

_Esta é a última notificação sobre este carrinho._`
  };
  return msgs[etapa] || null;
}

// ── Mensagens de recuperação de boleto/Pix não pago ─────────────────────────
function montarMensagemBoleto(etapa, nome, numero, gateway) {
  const metodo = (gateway || '').toLowerCase().includes('pix') ? 'PIX' : 'boleto';
  const msgs = {
    60: `Olá, ${nome}! 😊

Identificamos que seu pedido *#${numero}* ainda está aguardando pagamento via *${metodo}*.

Finalize seu pagamento para garantir seu pedido!

Qualquer dúvida é só chamar. 💬`,

    1440: `${nome}, seu pedido *#${numero}* ainda está pendente! ⏳

Teve alguma dificuldade com o pagamento via *${metodo}*? Estamos aqui para ajudar!

Responda essa mensagem se precisar de suporte. 😊`,

    2880: `⚠️ ${nome}, *última chance!*

Seu pedido *#${numero}* está prestes a ser cancelado por falta de pagamento.

Finalize agora para não perder sua reserva!

Qualquer problema com o ${metodo}, é só falar. 💬`
  };
  return msgs[etapa] || null;
}

// ── Verificar boletos/Pix não pagos ──────────────────────────────────────────
async function verificarBoletosPendentes(storeId) {
  try {
    const orders = await nuvemGet(storeId, '/orders', {
      per_page: 100,
      payment_status: 'pending',
      fields: 'id,number,contact_name,contact_phone,gateway,created_at,status'
    });

    const agora = Date.now();

    for (const o of orders) {
      if (o.status === 'cancelled') continue;

      // Ignorar apenas cartão de crédito pendente (aprovação demorada é normal)
      // Pedidos manuais não têm gateway — devem ser processados normalmente
      const gw = (o.gateway || '').toLowerCase();
      const ehCartao = gw.includes('credit') || gw.includes('credito') ||
                       gw.includes('debit')  || gw.includes('debito')  ||
                       gw.includes('card');
      if (ehCartao) continue;

      const telefone = formatTel(o.contact_phone);
      if (!telefone) continue;

      const criadoEm = new Date(o.created_at).getTime();
      const minutos  = Math.floor((agora - criadoEm) / 60000);
      const id       = String(o.id);
      const nome     = o.contact_name || 'Cliente';

      // Janelas ampliadas: até 4h após cada marco para não perder crons
      // Etapa 9999 = resgate único para pedidos antigos sem nenhuma mensagem enviada
      let etapa = null;
      if (minutos >= 60   && minutos < 300)  etapa = 60;
      if (minutos >= 1440 && minutos < 1680) etapa = 1440;
      if (minutos >= 2880 && minutos < 3120) etapa = 2880;
      if (minutos >= 4320 && !db.jaBoletoEnviado(id, 60) && !db.jaBoletoEnviado(id, 1440) && !db.jaBoletoEnviado(id, 2880)) etapa = 9999;
      if (!etapa) continue;

      if (db.jaBoletoEnviado(id, etapa)) continue;

      // Determinar método para personalizar mensagem
      const metodoLabel = gw.includes('pix') ? 'PIX' : gw === '' ? 'link de pagamento' : 'boleto';
      let mensagem;
      if (etapa === 9999) {
        mensagem = `⚠️ ${nome}, seu pedido *#${o.number}* ainda está aguardando pagamento. Ainda tem interesse? O que falta para finalizarmos e despacharmos seu pedido nas próximas 24h?`;
      } else {
        mensagem = montarMensagemBoleto(etapa, nome, o.number, metodoLabel);
      }
      if (!mensagem) continue;

      try {
        if (!await podEnviar(telefone, storeId)) continue;
        await sendWhatsApp(telefone, mensagem, storeId);
        db.marcarBoletoEnviado(id, storeId, etapa);
        db.registrarMensagem(telefone);
        console.log(`[Boleto/Manual] Etapa ${etapa}min → ${nome} pedido #${o.number} (${metodoLabel || 'manual'})`);
      } catch(e) {
        console.error(`[Boleto/Manual] Falha para #${o.number}:`, e.message);
      }

      await new Promise(r => setTimeout(r, 500));
    }
  } catch(e) {
    const msg = e.response?.data?.description || e.message || '';
    if (msg.includes('Last page is 0')) return;
    console.error(`[Boleto] Erro loja ${storeId}:`, e.response?.data || e.message);
  }
}

// ── Verificar carrinhos abandonados ──────────────────────────────────────────
async function verificarCarrinhosAbandonados(storeId) {
  try {
    const carrinhos = await nuvemGet(storeId, '/checkouts', {
      per_page: 50,
      fields: 'id,contact_name,contact_phone,abandoned_checkout_url,created_at'
    });

    const agora = Date.now();

    for (const c of carrinhos) {
      if (!c.contact_phone) continue;
      const telefone = formatTel(c.contact_phone);
      if (!telefone) continue;

      const criadoEm = new Date(c.created_at).getTime();
      const minutos = Math.floor((agora - criadoEm) / 60000);
      const nome = c.contact_name || 'Cliente';
      const link = c.abandoned_checkout_url || '';
      const id   = String(c.id);

      // Define qual etapa deve ser disparada
      let etapa = null;
      if (minutos >= 30  && minutos < 90)   etapa = 30;
      if (minutos >= 60  && minutos < 120)  etapa = 60;
      if (minutos >= 1440 && minutos < 1500) etapa = 1440;
      if (minutos >= 2880 && minutos < 2940) etapa = 2880;
      if (!etapa) continue;

      // Verifica se essa etapa já foi enviada
      if (db.jaCarrinhoEnviado(id, etapa)) continue;

      const mensagem = montarMensagemCarrinho(etapa, nome, link);
      if (!mensagem) continue;

      try {
        if (!await podEnviar(telefone, storeId)) continue;
        await sendWhatsApp(telefone, mensagem, storeId);
        db.marcarCarrinhoEnviado(id, storeId, etapa, telefone);
        db.registrarMensagem(telefone);
        console.log(`[Carrinho] Etapa ${etapa}min enviada para ${nome} — carrinho #${id}`);
      } catch(e) {
        console.error(`[Carrinho] Falha etapa ${etapa}min para #${id}:`, e.message);
      }

      await new Promise(r => setTimeout(r, 500));
    }
    // Cruzar carrinhos com pedidos pagos para marcar recuperados
    try {
      const pedidosPagos = await nuvemGet(storeId, '/orders', {
        per_page: 100,
        payment_status: 'paid',
        fields: 'id,contact_phone,created_at'
      });
      for (const o of pedidosPagos) {
        const tel = formatTel(o.contact_phone);
        if (tel) db.marcarCarrinhoRecuperado(tel, storeId);
      }
    } catch(e) { /* silencioso — não bloqueia o fluxo principal */ }

  } catch(e) {
    const msg = e.response?.data?.description || e.message || '';
    if (msg.includes('Last page is 0')) return;
    console.error(`[Carrinho] Erro loja ${storeId}:`, e.response?.data || e.message);
  }
}

// ── Verificar pagamentos recentes (últimas 2h) ────────────────────────────────
async function verificarPagamentos(storeId) {
  try {
    const desde = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const orders = await nuvemGet(storeId, '/orders', {
      per_page: 50,
      payment_status: 'paid',
      created_at_min: desde,
      fields: 'id,number,contact_name,contact_phone,payment_status,created_at'
    });

    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      if (db.jaConfirmacaoEnviada(String(o.id))) continue;

      const telefone = formatTel(o.contact_phone);
      if (!telefone) continue;

      try {
        await sendWhatsApp(telefone, montarMensagemPagamento(o.contact_name || 'Cliente', o.number));
        db.marcarConfirmacaoEnviada(String(o.id), storeId);
        console.log(`[Pagamento] WhatsApp enviado para pedido #${o.number}`);
      } catch(e) {
        console.error(`[Pagamento] Falha para #${o.number}:`, e.message);
      }

      await new Promise(r => setTimeout(r, 500));
    }
  } catch(e) {
    const msg = e.response?.data?.description || e.message || '';
    if (msg.includes('Last page is 0')) return; // sem pedidos — silencioso
    console.error(`[Pagamento] Erro loja ${storeId}:`, e.response?.data || e.message);
  }
}

// ── Verificar mudanças de rastreio ────────────────────────────────────────────
async function verificarRastreios(storeId) {
  try {
    const orders = await nuvemGet(storeId, '/orders', {
      per_page: 200,
      payment_status: 'paid',
      fields: 'id,number,contact_name,contact_phone,shipping_status,shipping_tracking_number,created_at'
    });

    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      const rastreio = o.shipping_tracking_number?.trim();
      if (!rastreio) continue;
      const telefone = formatTel(o.contact_phone);
      if (!telefone) continue;
      if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/i.test(rastreio)) continue;
      if (db.statusRastreio(rastreio) === 'entregue') continue;

      const evento = await consultarCorreios(rastreio);
      if (!evento) continue;

      const statusAnterior = db.statusRastreio(rastreio);
      const statusNovo = evento.entregue ? 'entregue' : evento.descricao;

      if (statusNovo && statusNovo !== statusAnterior) {
        console.log(`[Rastreio] ${rastreio}: "${statusAnterior}" → "${statusNovo}"`);
        const pedido = { cliente: o.contact_name, numero: o.number, rastreio };
        try {
          if (!await podEnviar(telefone, storeId)) continue;
          await sendWhatsApp(telefone, montarMensagemRastreio(pedido, evento), storeId);
          db.registrarMensagem(telefone);
          console.log(`[Rastreio] WhatsApp enviado para #${o.number}`);

          // Pesquisa de satisfação quando entregue
          if (evento.entregue && !db.jaSatisfacaoEnviada(String(o.id))) {
            await new Promise(r => setTimeout(r, 3000));
            if (await podEnviar(telefone)) {
              const msgSatisfacao =
                `Como foi a sua experiência com o pedido *#${o.number}*, ${o.contact_name || 'Cliente'}? 😊\n\n` +
                `Responda com um número:\n\n` +
                `5️⃣ — Excelente\n` +
                `4️⃣ — Bom\n` +
                `3️⃣ — Regular\n` +
                `2️⃣ — Ruim\n` +
                `1️⃣ — Péssimo\n\n` +
                `Sua opinião é muito importante para continuarmos melhorando! 🙏`;
              await sendWhatsApp(telefone, msgSatisfacao, storeId);
              db.marcarSatisfacaoEnviada(String(o.id), storeId);
              db.registrarMensagem(telefone);
              console.log(`[Satisfação] Pesquisa enviada para #${o.number}`);
            }
          }
        } catch(e) {
          console.error(`[Rastreio] Falha para #${o.number}:`, e.message);
        }
        db.atualizarStatusRastreio(rastreio, statusNovo, evento.data + ' ' + evento.hora);
      } else if (!statusAnterior) {
        db.atualizarStatusRastreio(rastreio, statusNovo || 'postado', evento.data + ' ' + evento.hora);
      }

      await new Promise(r => setTimeout(r, 7000)); // respeita limite 10req/min SeuRastreio
    }
  } catch(e) {
    console.error(`[Rastreio] Erro loja ${storeId}:`, e.response?.data || e.message);
  }
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
app.get('/auth/install', (req, res) => {
  const { store_id, session_code } = req.query;
  const state = session_code ? `ext_${session_code}` : (store_id || 'manual');
  if (session_code) {
    try { db.upsertAuthSession(session_code, 'pending'); } catch(e) {}
  }
  const redirect = encodeURIComponent(`${APP_URL}/auth/callback`);
  res.redirect(`https://www.nuvemshop.com.br/apps/${NUVEM_CLIENT_ID}/authorize?state=${state}&redirect_uri=${redirect}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state: storeId } = req.query;
  if (!code) return res.status(400).send('Código OAuth ausente.');
  try {
    const { data } = await axios.post('https://www.nuvemshop.com.br/apps/authorize/token', {
      client_id: NUVEM_CLIENT_ID,
      client_secret: NUVEM_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code
    }, { headers: { 'Content-Type': 'application/json' } });
    const rawState = String(storeId || '');
    const sessionCode = rawState.startsWith('ext_') ? rawState.slice(4) : null;
    const sid = String(data.user_id || (sessionCode ? '' : storeId));
    if (sid) db.saveToken(sid, data.access_token);
    if (sessionCode) {
      const realSid = String(data.user_id || sid);
      if (realSid) db.saveToken(realSid, data.access_token);
      try { db.completeAuthSession(sessionCode, realSid); } catch(e) {}
    }
    const isExt = !!sessionCode;
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
    <style>*{font-family:sans-serif;text-align:center;}body{background:#0d0d10;color:#fff;padding:3rem;}
    h2{color:#00d084;}code{background:#1e1e25;padding:4px 10px;border-radius:6px;font-size:18px;color:#00d084;}</style></head>
    <body><h2>✅ RastreioBot conectado!</h2><p>Loja autenticada com sucesso.</p>
    <p style="margin-top:1.5rem;">Seu <strong>Store ID</strong>:</p><code>${sid}</code>
    ${isExt ? '<p style="color:#00d084;margin-top:1rem;">Você pode fechar esta aba e voltar para a extensão.</p>' : '<p style="color:#888;margin-top:1.5rem;">Cole esse ID nas configurações da extensão.</p>'}
    </body></html>`);
  } catch(e) {
    console.error('OAuth erro:', e.response?.data || e.message);
    res.status(500).send('Erro na autenticação. Tente novamente.');
  }
});

// ── Pedidos ───────────────────────────────────────────────────────────────────
app.get('/pedidos/:storeId', auth, async (req, res) => {
  const { storeId } = req.params;
  const prazo = parseInt(req.query.prazo || '3');
  const incluirNotificados = req.query.incluir_notificados === 'true';
  try {
    const orders = await nuvemGet(storeId, '/orders', {
      per_page: 200,
      payment_status: 'paid',
      fields: 'id,number,contact_name,contact_phone,shipping_status,shipping_tracking_number,shipping_option,created_at'
    });
    const resultado = [];
    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      const jaEnviado = db.jaNotificado(String(o.id));
      if (jaEnviado && !incluirNotificados) continue;
      const tel = formatTel(o.contact_phone);
      const diasUteis = diasUteisDesde(o.created_at);
      let statusPrazo = null;
      const temRastreio = !!(o.shipping_tracking_number && o.shipping_tracking_number.trim());
      const foiEnviado  = o.shipping_status === 'shipped' || temRastreio;
      if (!foiEnviado) {
        statusPrazo = diasUteis > prazo ? 'atrasado' : diasUteis === prazo ? 'hoje' : 'ok';
      }
      const statusRastreio = temRastreio ? db.statusRastreio(o.shipping_tracking_number.trim()) : null;
      resultado.push({
        order_id: String(o.id), numero: o.number, cliente: o.contact_name || '',
        telefone: tel, rastreio: o.shipping_tracking_number || '',
        transportadora: o.shipping_option || '',
        status: foiEnviado ? 'shipped' : (o.shipping_status || 'pending'),
        statusRastreio, diasUteis, statusPrazo, ja_notificado: jaEnviado, created_at: o.created_at
      });
    }
    resultado.sort((a, b) => {
      const p = x => x.statusPrazo === 'atrasado' ? 0 : x.statusPrazo === 'hoje' ? 1 : x.status === 'shipped' ? 2 : 3;
      return p(a) - p(b);
    });
    res.json({ success: true, total: resultado.length, pedidos: resultado });
  } catch(e) {
    console.error('Erro /pedidos:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Marcar notificado ─────────────────────────────────────────────────────────
app.post('/notificado', auth, (req, res) => {
  const { order_id, store_id, rastreio, telefone } = req.body;
  if (!order_id || !store_id) return res.status(400).json({ error: 'order_id e store_id obrigatórios.' });
  db.marcarNotificado(order_id, store_id, rastreio, telefone);
  res.json({ success: true });
});

// ── Gestão de clientes (uso interno — você mesmo acessa) ─────────────────────

// Listar todos os clientes
app.get('/admin/clientes', auth, (req, res) => {
  const clientes = db.listarInstancias();
  const stores   = db.getAllStores();
  res.json({ success: true, total: clientes.length, clientes, stores });
});

// Cadastrar novo cliente
app.post('/admin/clientes', auth, (req, res) => {
  const { store_id, zapi_instance, zapi_token, zapi_client_token, nome_cliente } = req.body;
  if (!store_id || !zapi_instance || !zapi_token || !zapi_client_token)
    return res.status(400).json({ error: 'store_id, zapi_instance, zapi_token e zapi_client_token obrigatórios.' });
  db.salvarInstancia(store_id, zapi_instance, zapi_token, zapi_client_token, nome_cliente);
  res.json({ success: true, message: `Cliente ${nome_cliente || store_id} cadastrado.` });
});

// Remover cliente
app.delete('/admin/clientes/:storeId', auth, (req, res) => {
  // Remove apenas a instância, mantém tokens OAuth
  const { storeId } = req.params;
  res.json({ success: true, message: `Cliente ${storeId} removido.` });
});

// ── Rastreio público (sem auth) ───────────────────────────────────────────────
app.get('/rastreio-publico', async (req, res) => {
  const { codigo } = req.query;
  if (!codigo) return res.status(400).json({ success: false, error: 'Código obrigatório.' });
  const evento = await consultarCorreios(codigo);
  if (!evento) return res.json({ success: false, error: 'Não encontrado.' });
  res.json({ success: true, evento });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const stores = db.getAllStores();
  res.json({ ok: true, lojas: stores.length, versao: '2.5.0', cron: 'ativo (30min)' });
});

// ── API Dashboard Admin ───────────────────────────────────────────────────────
app.get('/admin/dashboard', auth, (req, res) => {
  try {
    const stats = db.getAdminStats();
    res.json({ success: true, ...stats });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API Dashboard Lojista ─────────────────────────────────────────────────────
app.get('/dashboard/:storeId', auth, async (req, res) => {
  const { storeId } = req.params;
  try {
    const stats = db.getLojistaStats(storeId);
    // Verifica status Z-API
    let zapiConectado = false;
    try {
      const inst = db.getInstancia(storeId) || {};
      const instance = inst.zapi_instance || process.env.ZAPI_INSTANCE;
      const token    = inst.zapi_token    || process.env.ZAPI_TOKEN;
      const client   = inst.zapi_client_token || process.env.ZAPI_CLIENT_TOKEN;
      if (instance && token && client) {
        const r = await axios.get(
          `https://api.z-api.io/instances/${instance}/token/${token}/status`,
          { headers: { 'Client-Token': client }, timeout: 5000 }
        );
        zapiConectado = r.data?.connected === true || r.data?.status === 'connected';
      }
    } catch(e) { zapiConectado = false; }
    res.json({ success: true, ...stats, zapiConectado });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard completo Nuvemshop (extensão Chrome) ───────────────────────────
app.get('/dashboard-nuvem/:storeId', auth, async (req, res) => {
  const { storeId } = req.params;
  try {
    // Railway em UTC — meia-noite BRT = 03:00 UTC
    const _agora = new Date();
    const _brt = new Date(_agora.getTime() - 3 * 60 * 60 * 1000);
    const _ano = _brt.getUTCFullYear(), _mes = _brt.getUTCMonth(), _dia = _brt.getUTCDate();
    const _brtIso = (y, m, d) => new Date(Date.UTC(y, m, d, 3, 0, 0)).toISOString();
    const inicioDia    = _brtIso(_ano, _mes, _dia);
    const inicioOntem  = _brtIso(_ano, _mes, _dia - 1);
    const inicioSemana = _brtIso(_ano, _mes, _dia - _brt.getUTCDay());
    const inicioMes    = _brtIso(_ano, _mes, 1);

    const nuvemSafe = async (path, params) => {
      try { return await nuvemGet(storeId, path, params); }
      catch(e) {
        const status = e.response?.status;
        if (status === 404 || (e.response?.data?.description || '').includes('Last page is 0')) return [];
        throw e;
      }
    };

    const [pedidosHoje, pedidosOntem, pedidosSemana, pedidosMes] = await Promise.all([
      nuvemSafe('/orders', { created_at_min: inicioDia,    per_page: 200 }),
      nuvemSafe('/orders', { created_at_min: inicioOntem,  created_at_max: inicioDia, per_page: 200 }),
      nuvemSafe('/orders', { created_at_min: inicioSemana, per_page: 200 }),
      nuvemSafe('/orders', { created_at_min: inicioMes,    per_page: 200 })
    ]);

    // Filtra pedidos pagos (exclui cancelados e pendentes)
    const pagosHoje   = pedidosHoje.filter(p => p.payment_status === 'paid');
    const pagosOntem  = pedidosOntem.filter(p => p.payment_status === 'paid');
    const pagosSemana = pedidosSemana.filter(p => p.payment_status === 'paid');
    const pagosMes    = pedidosMes.filter(p => p.payment_status === 'paid');

    // Métricas hoje
    const totalHoje       = pagosHoje.reduce((s, p) => s + parseFloat(p.total || 0), 0);
    const freteHoje       = pagosHoje.reduce((s, p) => s + parseFloat(p.shipping_cost_owner || 0), 0);
    const ticketMedioHoje = pagosHoje.length > 0 ? totalHoje / pagosHoje.length : 0;

    // Métricas ontem
    const totalOntem = pagosOntem.reduce((s, p) => s + parseFloat(p.total || 0), 0);

    // Variação
    const variacaoValor = totalOntem > 0 ? ((totalHoje - totalOntem) / totalOntem * 100) : null;
    const variacaoQtd   = pagosOntem.length > 0 ? ((pagosHoje.length - pagosOntem.length) / pagosOntem.length * 100) : null;

    // Pendentes de ação
    const aguardandoPagamento = pedidosHoje.filter(p => p.payment_status === 'pending').length;
    const aguardandoEnvio     = pedidosHoje.filter(p => p.payment_status === 'paid' && p.shipping_status === 'unpacked').length;

    // Produto mais vendido hoje
    const prodContagem = {};
    for (const p of pagosHoje) {
      for (const prod of (p.products || [])) {
        const nome = prod.name || 'Produto';
        prodContagem[nome] = (prodContagem[nome] || 0) + (prod.quantity || 1);
      }
    }
    const prodMaisVendido = Object.entries(prodContagem).sort((a,b) => b[1]-a[1])[0] || null;

    // Hora de pico
    const contagemHoras = {};
    for (const p of pedidosHoje) {
      const h = new Date(p.created_at).getHours();
      contagemHoras[h] = (contagemHoras[h] || 0) + 1;
    }
    const picoPar = Object.entries(contagemHoras).sort((a,b) => b[1]-a[1])[0];
    const horaPico = picoPar ? `${String(picoPar[0]).padStart(2,'0')}h` : null;

    // Semana e mês
    const totalSemana  = pagosSemana.reduce((s, p) => s + parseFloat(p.total || 0), 0);
    const freteSemana  = pagosSemana.reduce((s, p) => s + parseFloat(p.shipping_cost_owner || 0), 0);
    const totalMes     = pagosMes.reduce((s, p) => s + parseFloat(p.total || 0), 0);
    const freteMes     = pagosMes.reduce((s, p) => s + parseFloat(p.shipping_cost_owner || 0), 0);
    const ticketSemana = pagosSemana.length > 0 ? totalSemana / pagosSemana.length : 0;
    const ticketMes    = pagosMes.length    > 0 ? totalMes    / pagosMes.length    : 0;

    // Últimos 5 pedidos de hoje
    const ultimos = pedidosHoje.slice(0, 5).map(p => ({
      numero:  p.number,
      total:   parseFloat(p.total || 0),
      status:  p.payment_status,
      cliente: p.customer ? (p.customer.name || 'Cliente') : 'Cliente',
      hora:    new Date(p.created_at).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Recife' })
    }));

    // Score de saúde
    let score = 100;
    const totalPedidos = pagosHoje.length + aguardandoPagamento + aguardandoEnvio;
    if (totalPedidos > 0) {
      const txPendente = (aguardandoPagamento + aguardandoEnvio) / totalPedidos;
      score -= Math.round(txPendente * 40);
    }
    if (totalHoje === 0) score -= 20;
    score = Math.max(0, Math.min(100, score));

    res.json({
      success: true,
      hoje: {
        qtd: pagosHoje.length,
        total: totalHoje,
        frete: freteHoje,
        ticketMedio: ticketMedioHoje,
        variacaoValor,
        variacaoQtd,
        aguardandoPagamento,
        aguardandoEnvio,
        prodMaisVendido,
        horaPico
      },
      semana: { qtd: pagosSemana.length, total: totalSemana },
      mes:    { qtd: pagosMes.length, total: totalMes, frete: freteMes },
      semana_det: { qtd: pagosSemana.length, total: totalSemana, frete: freteSemana, ticketMedio: ticketSemana },
      mes_det:    { qtd: pagosMes.length,    total: totalMes,    frete: freteMes,    ticketMedio: ticketMes    },
      ultimos,
      score,
      atualizadoEm: new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Recife' })
    });
  } catch(e) {
    console.error('[Dashboard Nuvem]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Auth status (polling da extensão) ────────────────────────────────────────
app.get('/auth/status', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code obrigatorio' });
  try {
    const row = db.getAuthSession(code);
    if (!row) return res.json({ status: 'pending' });
    if (row.status === 'done') {
      db.deleteAuthSession(code);
      return res.json({ status: 'done', store_id: row.store_id });
    }
    res.json({ status: row.status });
  } catch(e) {
    res.json({ status: 'pending' });
  }
});

// ── Email via Resend ──────────────────────────────────────────────────────────
async function enviarChavePorEmail(email, chave, plano, expiraEm) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const expira = new Date(expiraEm).toLocaleDateString('pt-BR');
  await resend.emails.send({
    from: 'LoggZap <contato@loggzap.com.br>',
    to: email,
    subject: 'Sua chave de ativacao LoggZap',
    html: '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0d0d10;color:#ededf2;padding:32px;border-radius:12px">' +
      '<h2 style="color:#4f8ef7">LoggZap Dashboard</h2>' +
      '<p>Seu pagamento foi confirmado! Aqui esta sua chave de ativacao:</p>' +
      '<div style="background:#1e1e25;border:1px solid #4f8ef7;border-radius:8px;padding:16px;text-align:center;margin:24px 0">' +
      '<code style="font-size:20px;color:#00d084;letter-spacing:2px">' + chave + '</code></div>' +
      '<p><strong>Plano:</strong> ' + (plano === 'basic' ? 'Basic - R$29/mes' : 'Premium - R$397/mes') + '</p>' +
      '<p><strong>Valido ate:</strong> ' + expira + '</p>' +
      '<p style="margin-top:24px">Para ativar: abra a extensao → Configuracoes → Cole a chave → Ativar chave.</p>' +
      '<hr style="border-color:#2a2a35;margin:24px 0">' +
      '<p style="color:#888;font-size:12px">LoggZap | suporte: contato@loggzap.com.br</p></div>'
  });
}

function gerarChave(plano) {
  const crypto = require('crypto');
  const prefixo = plano === 'premium' ? 'LZP' : 'LZB';
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  return prefixo + '-' + rand.slice(0,4) + '-' + rand.slice(4,8) + '-' + rand.slice(8);
}

// ── Rota de teste de email ────────────────────────────────────────────────────
app.get('/teste/email', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Informe ?email=seu@email.com' });
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'LoggZap <contato@loggzap.com.br>',
      to: email,
      subject: '✅ Teste de email LoggZap',
      html: '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0d0d10;color:#ededf2;padding:32px;border-radius:12px">' +
        '<h2 style="color:#00d084">✅ Email funcionando!</h2>' +
        '<p>O Resend está configurado corretamente para o domínio <strong>loggzap.com.br</strong>.</p>' +
        '<hr style="border-color:#2a2a35;margin:24px 0">' +
        '<p style="color:#888;font-size:12px">LoggZap | contato@loggzap.com.br</p></div>'
    });
    res.json({ success: true, enviado_para: email });
  } catch(e) {
    console.error('[Teste Email]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Checkout Mercado Pago ─────────────────────────────────────────────────────
app.post('/checkout/criar', async (req, res) => {
  const { plano, email } = req.body;
  if (!plano || !email) return res.status(400).json({ error: 'plano e email obrigatorios' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN nao configurado' });
  const precos = { basic: 29, premium: 397 };
  const nomes  = { basic: 'LoggZap Basic', premium: 'LoggZap Premium' };
  if (!precos[plano]) return res.status(400).json({ error: 'plano invalido' });
  try {
    const { data } = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      {
        items: [{ title: nomes[plano], quantity: 1, unit_price: precos[plano], currency_id: 'BRL' }],
        payer: { email },
        back_urls: {
          success: APP_URL + '/checkout/sucesso',
          failure: APP_URL + '/checkout/erro',
          pending: APP_URL + '/checkout/pendente'
        },
        auto_return: 'approved',
        external_reference: JSON.stringify({ plano, email, meses: 1 }),
        notification_url: APP_URL + '/webhook/mp'
      },
      { headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, url: data.init_point, id: data.id });
  } catch(e) {
    console.error('[Checkout MP]', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Webhook Mercado Pago ──────────────────────────────────────────────────────
app.post('/webhook/mp', async (req, res) => {
  res.sendStatus(200);
  const { type, data } = req.body;
  if (type !== 'payment') return;
  try {
    const { data: pagamento } = await axios.get(
      'https://api.mercadopago.com/v1/payments/' + data.id,
      { headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN } }
    );
    if (pagamento.status !== 'approved') return;
    const ref = JSON.parse(pagamento.external_reference || '{}');
    const { plano, email, meses = 1 } = ref;
    if (!plano || !email) return;
    const jaProcessado = db.getLicencasPorPayment(String(data.id));
    if (jaProcessado) return;
    const chave = gerarChave(plano);
    db.criarLicenca(chave, plano, null, meses);
    db.salvarPaymentId(chave, String(data.id));
    await enviarChavePorEmail(email, chave, plano,
      new Date(Date.now() + meses * 30 * 24 * 60 * 60 * 1000).toISOString()
    );
    console.log('[MP] Licenca ' + chave + ' gerada para ' + email + ' — plano ' + plano);
  } catch(e) {
    console.error('[Webhook MP]', e.message);
  }
});

// ── Validar licenca (extensao) ────────────────────────────────────────────────
app.post('/licenca/validar', auth, (req, res) => {
  const { chave, store_id } = req.body;
  if (!chave || !store_id) return res.status(400).json({ error: 'chave e store_id obrigatorios' });
  const resultado = db.validarLicenca(chave, store_id);
  res.json(resultado);
});

app.get('/licenca/status/:storeId', auth, (req, res) => {
  const lic = db.getLicencaPorStore(req.params.storeId);
  if (!lic) return res.json({ plano: 'trial', valida: false });
  if (new Date(lic.expira_em) < new Date()) return res.json({ plano: 'trial', valida: false, motivo: 'expirada' });
  res.json({ plano: lic.plano, valida: true, expira_em: lic.expira_em });
});

// ── Cadastro de novo usuário ──────────────────────────────────────────────────
app.post('/cadastro', async (req, res) => {
  const { nome, email, whatsapp, plano } = req.body;
  if (!nome || !email) return res.status(400).json({ error: 'Nome e email são obrigatórios.' });

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const nomeFormatado = nome.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    const isPremium = (plano === 'premium');

    // Email com extensão + manual
    await resend.emails.send({
      from: 'LoggZap <contato@loggzap.com.br>',
      to: email,
      subject: '⚡ Seu LoggZap Dashboard está pronto para instalar',
      html: `
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#07090e;font-family:'DM Sans',Arial,sans-serif;color:#eef0f8">
          <div style="max-width:600px;margin:0 auto;padding:40px 24px">
            <div style="text-align:center;margin-bottom:36px">
              <span style="font-size:32px;font-weight:800">Logg<span style="color:#00d084">Zap</span></span>
            </div>
            <div style="background:#0c0f16;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:32px">
              <h1 style="font-size:22px;font-weight:700;margin:0 0 12px">Olá, ${nomeFormatado}! 👋</h1>
              <p style="color:#8b93a8;font-size:15px;line-height:1.7;margin:0 0 24px">
                Seu acesso ao <strong style="color:#00d084">LoggZap Dashboard</strong> está pronto. 
                Siga os passos abaixo para instalar em menos de 5 minutos.
              </p>
              
              ${isPremium ? `<div style="background:linear-gradient(135deg,rgba(79,142,247,0.1),rgba(79,142,247,0.05));border:1px solid rgba(79,142,247,0.3);border-radius:10px;padding:20px;margin-bottom:24px">
                <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#4f8ef7;text-transform:uppercase;margin-bottom:12px">&#9889; Você escolheu o Premium</div>
                <p style="color:#8b93a8;font-size:14px;margin:0 0 12px;line-height:1.65">Após instalar e configurar a extensão, acesse dentro dela:</p>
                <div style="background:#07090e;border-radius:8px;padding:14px;font-size:14px;color:#eef0f8;line-height:1.8">
                  &#9881; <strong>Configurações</strong> &rarr; <strong>Plano</strong> &rarr; <strong>Assinar Premium</strong>
                </div>
                <p style="color:#8b93a8;font-size:13px;margin:12px 0 0">Você será redirecionado para o pagamento seguro via Mercado Pago.</p>
              </div>` : ''}
              <div style="background:#11151e;border-radius:10px;padding:20px;margin-bottom:24px">
                <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#00d084;text-transform:uppercase;margin-bottom:12px">Passo 1 — Baixe a extensão</div>
                <p style="color:#8b93a8;font-size:14px;margin:0 0 16px">Clique no botão abaixo para baixar o arquivo da extensão:</p>
                <a href="${process.env.APP_URL}/download/extensao" style="display:inline-block;background:#00d084;color:#000;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">⬇️ Baixar LoggZap v2.6</a>
              </div>

              <div style="background:#11151e;border-radius:10px;padding:20px;margin-bottom:24px">
                <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#00d084;text-transform:uppercase;margin-bottom:12px">Passo 2 — Leia o manual</div>
                <p style="color:#8b93a8;font-size:14px;margin:0 0 16px">O manual completo de instalação está disponível online:</p>
                <a href="${process.env.APP_URL}/manual" style="display:inline-block;border:1px solid rgba(255,255,255,0.15);color:#eef0f8;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">📖 Ver manual de instalação</a>
              </div>

              <div style="background:#11151e;border-radius:10px;padding:20px">
                <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#00d084;text-transform:uppercase;margin-bottom:12px">Dados de configuração</div>
                <p style="color:#8b93a8;font-size:14px;margin:0 0 8px">Use estes dados quando for configurar a extensão:</p>
                <div style="background:#07090e;border-radius:6px;padding:14px;font-family:monospace;font-size:13px;color:#00d084">
                  Chave Secreta: MinhaChave2024Secreta
                </div>
              </div>
            </div>

            <div style="text-align:center;margin-top:32px">
              <p style="color:#424a61;font-size:13px">Seu trial de 7 dias começa quando você instalar a extensão.</p>
              <p style="color:#424a61;font-size:13px;margin-top:8px">Dúvidas? <a href="mailto:contato@loggzap.com.br" style="color:#00d084">contato@loggzap.com.br</a></p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    console.log('[Cadastro] Lead registrado:', nome, email, plano);

    // Notificar leads@loggzap.com.br
    try {
      await resend.emails.send({
        from: 'LoggZap <contato@loggzap.com.br>',
        to: 'leads@loggzap.com.br',
        subject: `🔔 Novo lead: ${nome} — Plano ${plano}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0c0f16;color:#eef0f8;border-radius:12px">
            <h2 style="color:#00d084;margin:0 0 20px">Novo cadastro no LoggZap</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#8b93a8;font-size:14px">Nome</td><td style="padding:8px 0;font-size:14px"><strong>${nome}</strong></td></tr>
              <tr><td style="padding:8px 0;color:#8b93a8;font-size:14px">Email</td><td style="padding:8px 0;font-size:14px"><a href="mailto:${email}" style="color:#00d084">${email}</a></td></tr>
              <tr><td style="padding:8px 0;color:#8b93a8;font-size:14px">WhatsApp</td><td style="padding:8px 0;font-size:14px">${whatsapp || '—'}</td></tr>
              <tr><td style="padding:8px 0;color:#8b93a8;font-size:14px">Plano</td><td style="padding:8px 0;font-size:14px"><strong style="color:#00d084">${plano}</strong></td></tr>
              <tr><td style="padding:8px 0;color:#8b93a8;font-size:14px">Data</td><td style="padding:8px 0;font-size:14px">${new Date().toLocaleString('pt-BR', {timeZone:'America/Recife'})}</td></tr>
            </table>
          </div>
        `
      });
    } catch(notifErr) { console.error('[Cadastro] Erro notif lead:', notifErr.message); }

    res.json({ success: true });
  } catch(e) {
    console.error('[Cadastro] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao enviar email. Tente novamente.' });
  }
});

// ── Download da extensão ──────────────────────────────────────────────────────
app.get('/download/extensao', (req, res) => {
  const path = require('path');
  const file = path.join(__dirname, 'public', 'LoggZap_v2.6.zip');
  res.download(file, 'LoggZap_Dashboard_v2.6.zip');
});

// ── Manual de instalação ──────────────────────────────────────────────────────
app.get('/manual', (req, res) => {
  const path = require('path');
  res.sendFile(path.join(__dirname, 'public', 'manual-loggzap.html'));
});


// ── Paginas de retorno do checkout ───────────────────────────────────────────
app.get('/checkout/sucesso', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{font-family:sans-serif;text-align:center;}body{background:#0d0d10;color:#fff;padding:3rem;}</style></head><body><h2 style="color:#00d084">Pagamento aprovado!</h2><p>Sua chave sera enviada para o seu email em instantes.</p><p style="color:#888;margin-top:1rem">Verifique tambem a pasta de spam.</p></body></html>');
});

app.get('/checkout/erro', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{font-family:sans-serif;text-align:center;}body{background:#0d0d10;color:#fff;padding:3rem;}</style></head><body><h2 style="color:#e05a5a">Pagamento nao aprovado</h2><p>Tente novamente ou entre em contato: contato@loggzap.com.br</p></body></html>');
});

app.get('/checkout/pendente', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{font-family:sans-serif;text-align:center;}body{background:#0d0d10;color:#fff;padding:3rem;}</style></head><body><h2 style="color:#e8a030">Pagamento em processamento</h2><p>Voce recebera a chave por email assim que o pagamento for confirmado.</p></body></html>');
});


// ── Rota de teste de email (remover em producao) ──────────────────────────────
app.post('/teste/email', auth, async (req, res) => {
  const { email, plano = 'basic' } = req.body;
  if (!email) return res.status(400).json({ error: 'email obrigatorio' });
  try {
    const chave = gerarChave(plano);
    const expiraEm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.criarLicenca(chave, plano, null, 1);
    // Tenta enviar email com timeout
    let emailEnviado = false;
    try {
      await Promise.race([
        enviarChavePorEmail(email, chave, plano, expiraEm),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
      ]);
      emailEnviado = true;
    } catch(emailErr) {
      console.error('[Teste Email] Falha no envio:', emailErr.message);
    }
    res.json({ success: true, chave, emailEnviado, mensagem: emailEnviado ? 'Email enviado!' : 'Licenca criada mas email falhou. Use a chave manualmente.' });
  } catch(e) {
    console.error('[Teste Email]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Diagnóstico Nuvemshop ─────────────────────────────────────────────────────
app.get('/diagnostico/:storeId', async (req, res) => {
  const { storeId } = req.params;
  try {
    const row = db.getToken(storeId);
    if (!row) return res.json({ erro: 'Token nao encontrado no banco', storeId });
    const token = row.access_token;
    const tokenPreview = token ? token.substring(0, 10) + '...' : 'VAZIO';
    
    let nuvemRes = null;
    let nuvemErro = null;
    try {
      const r = await axios.get(
        `https://api.nuvemshop.com.br/v1/${storeId}/orders`,
        {
          headers: {
            'Authentication': `bearer ${token}`,
            'User-Agent': `RastreioBot (${APP_URL})`
          },
          params: { per_page: 1 }
        }
      );
      nuvemRes = { status: r.status, total: Array.isArray(r.data) ? r.data.length : 'nao array' };
    } catch(e) {
      nuvemErro = { status: e.response?.status, msg: e.response?.data || e.message };
    }
    
    res.json({ storeId, tokenPreview, nuvemRes, nuvemErro });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── Ativar plano via chave ────────────────────────────────────────────────────
app.post('/ativar', auth, (req, res) => {
  const { chave, store_id } = req.body;
  if (!chave || !store_id) return res.status(400).json({ error: 'chave e store_id obrigatorios' });
  // Tabela de chaves — em produção use banco de dados
  const CHAVES = {
    'LOGGZAP-BASIC-2026':   'basic',
    'LOGGZAP-PREMIUM-2026': 'premium'
  };
  const plano = CHAVES[chave.toUpperCase()];
  if (!plano) return res.status(400).json({ error: 'Chave invalida.' });
  res.json({ success: true, plano, store_id });
});

// ── Configurações por loja ────────────────────────────────────────────────────
app.get('/config/:storeId', auth, (req, res) => {
  try {
    res.json({ success: true, config: db.getConfig(req.params.storeId) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/config/:storeId', auth, (req, res) => {
  try {
    db.salvarConfig(req.params.storeId, req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Opt-out manual ────────────────────────────────────────────────────────────
app.post('/optout', auth, (req, res) => {
  const { telefone, storeId, acao } = req.body;
  if (!telefone) return res.status(400).json({ error: 'telefone obrigatório' });
  if (acao === 'remover') db.removerOptOut(telefone);
  else db.marcarOptOut(telefone, storeId);
  res.json({ success: true });
});

// ── API Frete ─────────────────────────────────────────────────────────────────
app.get('/frete/:storeId', auth, async (req, res) => {
  const { storeId } = req.params;
  try {
    const orders = await nuvemGet(storeId, '/orders', {
      per_page: 200,
      payment_status: 'paid',
      fields: 'id,number,shipping_cost_customer,created_at'
    });

    const agora  = new Date();
    const hoje   = new Date(agora); hoje.setHours(0,0,0,0);
    const semana = new Date(agora); semana.setDate(semana.getDate() - 7); semana.setHours(0,0,0,0);
    const mes    = new Date(agora); mes.setDate(mes.getDate() - 30);      mes.setHours(0,0,0,0);

    function calcPeriod(desde) {
      const period   = orders.filter(o => new Date(o.created_at) >= desde);
      const comFrete = period.filter(o => parseFloat(o.shipping_cost_customer || 0) > 0);
      const total    = comFrete.reduce((acc, o) => acc + parseFloat(o.shipping_cost_customer || 0), 0);
      return {
        total: Math.round(total * 100) / 100,
        pedidos: comFrete.length,
        pedidosTotal: period.length
      };
    }

    res.json({
      success: true,
      hoje:   calcPeriod(hoje),
      semana: calcPeriod(semana),
      mes:    calcPeriod(mes)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stats de carrinho ────────────────────────────────────────────────────────
app.get('/carrinho-stats/:storeId', auth, async (req, res) => {
  try {
    const stats = db.getCarrinhoStats(req.params.storeId);
    res.json({ success: true, ...stats });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Enviar WhatsApp ───────────────────────────────────────────────────────────
app.post('/enviar-whatsapp', auth, async (req, res) => {
  const { telefone, mensagem, order_id, store_id, rastreio } = req.body;
  if (!telefone || !mensagem) return res.status(400).json({ error: 'telefone e mensagem obrigatórios.' });
  try {
    const result = await sendWhatsApp(telefone, mensagem, storeId);
    if (order_id && store_id) db.marcarNotificado(order_id, store_id, rastreio, telefone);
    res.json({ success: true, result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.response?.data?.message || e.message });
  }
});

// ── Status Z-API ──────────────────────────────────────────────────────────────
app.get('/whatsapp/status', auth, async (req, res) => {
  if (!ZAPI_INSTANCE || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN)
    return res.json({ conectado: false, erro: 'Z-API não configurada.' });
  try {
    const r = await axios.get(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/status`,
      { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }
    );
    const conectado = r.data?.connected === true || r.data?.status === 'connected';
    res.json({ conectado, estado: r.data?.status || 'unknown', data: r.data });
  } catch(e) {
    res.json({ conectado: false, erro: e.message });
  }
});

app.get('/whatsapp/qrcode', auth, (req, res) => {
  res.json({ success: false, error: 'Com Z-API o QR Code é gerado no painel de z-api.io.' });
});

app.post('/whatsapp/criar-instancia', auth, (req, res) => {
  res.json({ success: true, message: 'Z-API não precisa criar instância via API.' });
});

// ── Relatório semanal — toda segunda às 8h ───────────────────────────────────
// ── Pós-entrega ───────────────────────────────────────────────────────────────
async function verificarPosEntrega(storeId) {
  try {
    const orders = await nuvemGet(storeId, '/orders', {
      per_page: 100,
      payment_status: 'paid',
      fields: 'id,number,contact_name,contact_phone,shipping_status,created_at'
    });
    const cfg = db.getConfig(storeId);
    const templatePadrao = `Olá, {nome}! 🎉\n\nSeu pedido *#{numero}* foi entregue! Esperamos que você tenha adorado.\n\nConta pra gente o que achou? Sua opinião é muito importante para nós! 😊`;
    const template = cfg.template_pos_entrega || templatePadrao;

    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      if (o.shipping_status !== 'delivered') continue;
      if (db.jaPosEntregaEnviado(String(o.id))) continue;
      const telefone = formatTel(o.contact_phone);
      if (!telefone) continue;
      const nome = o.contact_name || 'Cliente';
      const mensagem = template.replace('{nome}', nome).replace('{numero}', o.number);
      try {
        if (!await podEnviar(telefone, storeId)) continue;
        await sendWhatsApp(telefone, mensagem, storeId);
        db.marcarPosEntregaEnviado(String(o.id), storeId);
        db.registrarMensagem(telefone);
        console.log(`[PósEntrega] Enviado para ${nome} — pedido #${o.number}`);
      } catch(e) {
        console.error(`[PósEntrega] Falha #${o.number}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch(e) {
    const msg = e.response?.data?.description || e.message || '';
    if (msg.includes('Last page is 0')) return;
    console.error(`[PósEntrega] Erro loja ${storeId}:`, e.message);
  }
}

// ── Alerta pedido parado ──────────────────────────────────────────────────────
async function verificarPedidosParados(storeId) {
  try {
    const cfg = db.getConfig(storeId);
    const diasLimite = cfg.alerta_parado_dias || 5;
    const orders = await nuvemGet(storeId, '/orders', {
      per_page: 100,
      payment_status: 'paid',
      fields: 'id,number,contact_name,contact_phone,shipping_status,shipping_tracking_number,created_at'
    });
    const inst = db.getInstancia(storeId);
    if (!inst) return; // sem instância, sem como avisar o lojista
    const telLojista = inst.zapi_instance ? null : null; // aviso vai para o lojista via número configurado

    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      if (o.shipping_status === 'shipped' || o.shipping_status === 'delivered') continue;
      if (o.shipping_tracking_number?.trim()) continue; // já tem rastreio
      if (db.jaAlertaParadoEnviado(String(o.id))) continue;
      const diasUteis = diasUteisDesde(o.created_at);
      if (diasUteis < diasLimite) continue;

      const telefoneCliente = formatTel(o.contact_phone);
      const nome = o.contact_name || 'Cliente';

      // Avisa o LOJISTA (número configurado no env)
      const telLojistaMsg = process.env.LOJISTA_WHATSAPP;
      if (telLojistaMsg) {
        try {
          await sendWhatsApp(telLojistaMsg,
            `⚠️ *Pedido parado!*\n\nO pedido *#${o.number}* de *${nome}* está há *${diasUteis} dias úteis* sem envio.\n\nVerifique e atualize o rastreio para evitar reclamações.`,
            storeId
          );
          db.marcarAlertaParadoEnviado(String(o.id), storeId);
          console.log(`[Parado] Alerta enviado ao lojista — pedido #${o.number}`);
        } catch(e) {
          console.error(`[Parado] Falha ao alertar lojista #${o.number}:`, e.message);
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch(e) {
    const msg = e.response?.data?.description || e.message || '';
    if (msg.includes('Last page is 0')) return;
    console.error(`[Parado] Erro loja ${storeId}:`, e.message);
  }
}

cron.schedule('0 8 * * 1', async () => {
  console.log('[Relatório] Gerando relatório semanal...');
  try {
    const stores = db.getAllStores();
    for (const store of stores) {
      await enviarRelatorioSemanal(store.store_id);
    }
  } catch(e) {
    console.error('[Relatório] Erro:', e.message);
  }
});

async function enviarRelatorioSemanal(storeId) {
  try {
    const orders = await nuvemGet(storeId, '/orders', {
      per_page: 200,
      payment_status: 'paid',
      fields: 'id,number,contact_name,shipping_status,shipping_tracking_number,created_at'
    });

    const prazo = 3;
    let atrasados = [], pendentes = [], entregues = [], emTransito = [];

    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      const diasUteis = diasUteisDesde(o.created_at);
      const temRastreio = !!(o.shipping_tracking_number?.trim());
      const foiEnviado = o.shipping_status === 'shipped' || temRastreio;
      const statusRastreio = temRastreio ? db.statusRastreio(o.shipping_tracking_number.trim()) : null;

      if (statusRastreio === 'entregue') {
        entregues.push(o);
      } else if (temRastreio) {
        emTransito.push(o);
      } else if (!foiEnviado && diasUteis > prazo) {
        atrasados.push(o);
      } else if (!foiEnviado) {
        pendentes.push(o);
      }
    }

    const hoje = new Date().toLocaleDateString('pt-BR');

    // Mensagem WhatsApp
    const msgWA =
      `📊 *Relatório Semanal DTFclub*\n` +
      `📅 ${hoje}\n\n` +
      `⚠️ *Atrasados (sem envio):* ${atrasados.length}\n` +
      `📦 *Aguardando envio:* ${pendentes.length}\n` +
      `🚚 *Em trânsito:* ${emTransito.length}\n` +
      `✅ *Entregues:* ${entregues.length}\n\n` +
      (atrasados.length > 0
        ? `*Pedidos atrasados:*\n` + atrasados.slice(0,10).map(o => `• #${o.number} — ${o.contact_name}`).join('\n')
        : `Nenhum pedido atrasado! 🎉`);

    await sendWhatsApp('5581996852660', msgWA);
    console.log('[Relatório] WhatsApp enviado');

    // E-mail
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const atrasadosHtml = atrasados.length
      ? atrasados.map(o => `<tr><td>#${o.number}</td><td>${o.contact_name}</td><td>${diasUteisDesde(o.created_at)} dias úteis</td></tr>`).join('')
      : '<tr><td colspan="3">Nenhum pedido atrasado 🎉</td></tr>';

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: 'dtfclub23@gmail.com',
      subject: `📊 Relatório Semanal DTFclub — ${hoje}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f5f5f5;padding:20px;border-radius:12px;">
          <h2 style="color:#00d084;">📊 Relatório Semanal DTFclub</h2>
          <p style="color:#666;">Gerado em ${hoje}</p>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:20px 0;">
            <div style="background:#fff;padding:15px;border-radius:8px;border-left:4px solid #e05a5a;">
              <div style="font-size:28px;font-weight:bold;color:#e05a5a;">${atrasados.length}</div>
              <div style="color:#666;">⚠️ Atrasados</div>
            </div>
            <div style="background:#fff;padding:15px;border-radius:8px;border-left:4px solid #e8a030;">
              <div style="font-size:28px;font-weight:bold;color:#e8a030;">${pendentes.length}</div>
              <div style="color:#666;">📦 Aguardando envio</div>
            </div>
            <div style="background:#fff;padding:15px;border-radius:8px;border-left:4px solid #4f8ef7;">
              <div style="font-size:28px;font-weight:bold;color:#4f8ef7;">${emTransito.length}</div>
              <div style="color:#666;">🚚 Em trânsito</div>
            </div>
            <div style="background:#fff;padding:15px;border-radius:8px;border-left:4px solid #00d084;">
              <div style="font-size:28px;font-weight:bold;color:#00d084;">${entregues.length}</div>
              <div style="color:#666;">✅ Entregues</div>
            </div>
          </div>

          <h3 style="color:#e05a5a;">Pedidos Atrasados</h3>
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;">
            <thead style="background:#e05a5a;color:#fff;">
              <tr><th style="padding:10px;text-align:left;">Pedido</th><th style="padding:10px;text-align:left;">Cliente</th><th style="padding:10px;text-align:left;">Dias úteis</th></tr>
            </thead>
            <tbody>${atrasadosHtml}</tbody>
          </table>
        </div>
      `
    });

    console.log('[Relatório] E-mail enviado para dtfclub23@gmail.com');
  } catch(e) {
    console.error('[Relatório] Erro ao enviar:', e.message);
  }
}

// ── Webhook Z-API — Resposta automática de rastreio ──────────────────────────
const GATILHOS = [
  'cadê meu pedido', 'cade meu pedido',
  'cadê meu código', 'cade meu codigo',
  'código de rastreio', 'codigo de rastreio',
  'preciso do código', 'preciso do codigo',
  'meu pedido ainda nao chegou', 'meu pedido não chegou',
  'rastreio', 'rastreamento', 'onde está meu pedido',
  'onde esta meu pedido'
];

function contemGatilho(texto) {
  const t = (texto || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return GATILHOS.some(g => {
    const gn = g.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return t === gn;
  });
}

app.post('/webhook/zapi', async (req, res) => {
  res.json({ ok: true }); // Responde imediatamente

  try {
    const body = req.body;

    // Ignora mensagens enviadas pelo próprio bot
    if (body.fromMe) return;
    if (!body.text?.message) return;

    const texto    = body.text.message;
    const telefone = body.phone; // formato: 5581999999999

    if (!contemGatilho(texto)) return;

    console.log(`[ZAPI] Gatilho detectado de ${telefone}: "${texto}"`);

    // Busca pedido mais recente pelo telefone em todas as lojas
    const stores = db.getAllStores();
    let pedidoEncontrado = null;

    for (const store of stores) {
      try {
        const orders = await nuvemGet(store.store_id, '/orders', {
          per_page: 50,
          payment_status: 'paid',
          fields: 'id,number,contact_name,contact_phone,shipping_tracking_number,shipping_option,created_at'
        });

        // Normaliza telefone para comparar
        const telLimpo = String(telefone).replace(/\D/g, '');

        const pedido = orders
          .filter(o => o.status !== 'cancelled')
          .find(o => {
            const t = formatTel(o.contact_phone);
            return t && String(t).replace(/\D/g, '').endsWith(telLimpo.slice(-10));
          });

        if (pedido) {
          pedidoEncontrado = { ...pedido, store_id: store.store_id };
          break;
        }
      } catch(e) {
        console.error(`[ZAPI] Erro ao buscar loja ${store.store_id}:`, e.message);
      }
    }

    // Opt-out por palavra-chave
    const palavrasOptOut = ['parar', 'sair', 'stop', 'não quero', 'nao quero', 'cancelar', 'descadastrar'];
    if (palavrasOptOut.some(p => texto.toLowerCase().includes(p))) {
      db.marcarOptOut(telefone, pedidoEncontrado?.store_id);
      await sendWhatsApp(telefone,
        `Tudo bem! Você não receberá mais mensagens automáticas. 😊\n\nSe precisar de ajuda, fale conosco diretamente.`
      );
      console.log(`[OptOut] ${telefone} optou por sair.`);
      return res.sendStatus(200);
    }

    if (!pedidoEncontrado) {
      await sendWhatsApp(telefone,
        `Olá! 😊 Não encontrei nenhum pedido vinculado a este número.\n\n` +
        `Se precisar de ajuda, entre em contato com nossa equipe!`
      );
      return;
    }

    const rastreio = pedidoEncontrado.shipping_tracking_number?.trim();
    const nome     = pedidoEncontrado.contact_name || 'Cliente';
    const numero   = pedidoEncontrado.number;
    const link     = rastreio
      ? `https://rastreamento.correios.com.br/app/index.php?objeto=${rastreio}`
      : null;

    // Busca status atual no DB
    const statusAtual = rastreio ? db.statusRastreio(rastreio) : null;

    let mensagem;
    if (!rastreio) {
      mensagem =
        `Olá, ${nome}! 😊\n\n` +
        `Seu pedido *#${numero}* ainda está em produção.\n\n` +
        `Assim que for enviado, você receberá o código de rastreio aqui. 📦`;
    } else {
      mensagem =
        `Olá, ${nome}! 😊\n\n` +
        `Seu pedido *#${numero}*:\n\n` +
        `📦 *Código de rastreio:* ${rastreio}\n` +
        (statusAtual ? `📍 *Status atual:* ${statusAtual}\n` : '') +
        `\n🔗 Rastreie aqui: ${link}`;
    }

    if (await podEnviar(telefone)) {
      await sendWhatsApp(telefone, mensagem, storeId);
      db.registrarMensagem(telefone);
      console.log(`[ZAPI] Resposta automática enviada para ${telefone} — pedido #${numero}`);
    }
  } catch(e) {
    console.error('[ZAPI] Erro no webhook:', e.message);
  }
});

app.listen(PORT, () => {
  console.log(`RastreioBot v2.4.0 rodando na porta ${PORT}`);
  console.log('Cron ativo: verificação a cada 30 minutos');
});

// ── Keep-alive — ping a cada 10 minutos para evitar hibernação ───────────────
const APP_URL_PING = process.env.APP_URL || '';
if (APP_URL_PING) {
  cron.schedule('*/10 * * * *', async () => {
    try {
      await axios.get(`${APP_URL_PING}/status`, { timeout: 10000 });
      console.log('[Keep-alive] OK');
    } catch(e) {
      console.warn('[Keep-alive] Falha no ping:', e.message);
    }
  });
  console.log('Keep-alive ativo: ping a cada 10 minutos');
}
