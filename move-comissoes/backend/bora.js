const fetch = require('node-fetch');
const db = require('./db');

const BASE_URL = 'https://app.boramvno.com.br/appapi';
let currentToken = null;
let tokenExpiry = null;

async function getToken() {
  if (currentToken && tokenExpiry && Date.now() < tokenExpiry) return currentToken;

  const email = process.env.BORA_EMAIL;
  const senha = process.env.BORA_SENHA;

  if (!email || !senha) throw new Error('Credenciais Bora não configuradas (BORA_EMAIL / BORA_SENHA)');

  const res = await fetch(`${BASE_URL}/api/Authentication/basic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: senha })
  });

  if (!res.ok) throw new Error(`Autenticação Bora falhou: ${res.status}`);

  const data = await res.json();
  currentToken = data.token || data.accessToken || data.access_token;
  if (!currentToken) throw new Error('Token não retornado pela Bora');

  tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 min (token dura 60)
  return currentToken;
}

async function boraGet(path) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (res.status === 401) {
    currentToken = null;
    return boraGet(path); // retry com novo token
  }
  if (!res.ok) throw new Error(`Bora API erro ${res.status} em ${path}`);
  return res.json();
}

// Busca vendas por período
// A Bora não tem endpoint de "todas as vendas" documentado no PDF.
// Usamos o relatório exportável via endpoint de histórico de assinantes
// ou montamos via consulta por data. Como a API não documenta um endpoint
// de listagem geral, fazemos sync via importação do CSV/relatório.
// Para integração real, substitua pela rota correta quando a Bora fornecer.
async function fetchVendasPeriodo(dataInicio, dataFim) {
  // Endpoint hipotético — ajustar conforme documentação adicional da Bora
  // O PDF não documenta um endpoint de listagem de todas as transações.
  // Esta função deve ser adaptada com o endpoint real fornecido pela Bora.
  try {
    const data = await boraGet(`/api/Subscription/report?startDate=${dataInicio}&endDate=${dataFim}`);
    return Array.isArray(data) ? data : (data.items || data.data || []);
  } catch (e) {
    console.warn('Endpoint de relatório não disponível:', e.message);
    return [];
  }
}

function resolverVendedor(vendedorBora) {
  if (!vendedorBora || vendedorBora.trim() === '') return null;
  const nome = vendedorBora.trim().toLowerCase();
  const usuario = db.prepare(`
    SELECT id FROM usuarios WHERE LOWER(nome) = ? AND perfil = 'vendedor'
  `).get(nome);
  return usuario ? usuario.id : null;
}

function calcularComissao(plano, tipo) {
  const planoDB = db.prepare(`
    SELECT comissao_ativacao, comissao_recarga FROM planos_comissao 
    WHERE LOWER(nome_plano) = LOWER(?) AND ativo = 1
  `).get(plano || '');

  if (!planoDB) return 0;
  const isAtivacao = tipo && tipo.toUpperCase().includes('ATIVAÇÃO');
  return isAtivacao ? planoDB.comissao_ativacao : planoDB.comissao_recarga;
}

function herdaVendedorDoIccid(iccid) {
  const ativacao = db.prepare(`
    SELECT vendedor_id FROM transacoes 
    WHERE iccid = ? AND tipo LIKE '%ATIVAÇÃO%' AND vendedor_id IS NOT NULL
    ORDER BY data_transacao ASC LIMIT 1
  `).get(iccid);
  return ativacao ? ativacao.vendedor_id : null;
}

async function syncTransacoes(registros) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO transacoes 
    (msisdn, iccid, data_transacao, cpf_cnpj, nome_cliente, plano, tipo, valor, 
     meio_pagamento, canal, vendedor_bora, supervisor, loja, vendedor_id, comissao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let novos = 0;
  const syncAll = db.transaction((rows) => {
    for (const r of rows) {
      // Mapear campos do relatório Bora
      const msisdn = r.msisdn || r.MSISDN || '';
      const iccid = r.iccid || r.ICCID || '';
      const data = r.data || r.DATA || r.date || '';
      const cpf = r.cpfCnpj || r['CPF/CNPJ'] || '';
      const nome = r.nomeCliente || r['NOME DO CLIENTE'] || '';
      const plano = r.plano || r.PLANO || '';
      const tipo = r.tipo || r.TIPO || '';
      const valor = parseFloat(r.valor || r.VALOR || 0);
      const meio = r.meioPagamento || r['MEIO DE PAGAMENTO'] || '';
      const canal = r.canal || r.CANAL || '';
      const vendedorBora = r.vendedor || r.VENDEDOR || '';
      const supervisor = r.supervisor || r.SUPERVISOR || '';
      const loja = r.loja || r.LOJA || '';

      // Resolver vendedor
      let vendedorId = resolverVendedor(vendedorBora);
      // Se recarga sem vendedor, herdar da ativação
      if (!vendedorId && iccid) vendedorId = herdaVendedorDoIccid(iccid);

      const comissao = vendedorId ? calcularComissao(plano, tipo) : 0;

      const resultado = insert.run(msisdn, iccid, data, cpf, nome, plano, tipo, valor,
        meio, canal, vendedorBora, supervisor, loja, vendedorId, comissao);
      if (resultado.changes > 0) novos++;
    }
  });

  syncAll(registros);
  return novos;
}

async function executarSync() {
  const logId = db.prepare(`INSERT INTO sync_log (status) VALUES ('executando')`).run().lastInsertRowid;

  try {
    const hoje = new Date();
    const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().split('T')[0];
    const fim = hoje.toISOString().split('T')[0];

    const registros = await fetchVendasPeriodo(inicio, fim);
    const novos = await syncTransacoes(registros);

    db.prepare(`UPDATE sync_log SET status='ok', finalizado_em=datetime('now'), registros_novos=? WHERE id=?`)
      .run(novos, logId);

    console.log(`[Sync] OK — ${novos} registros novos em ${new Date().toLocaleString('pt-BR')}`);
    return { ok: true, novos };
  } catch (e) {
    db.prepare(`UPDATE sync_log SET status='erro', finalizado_em=datetime('now'), erro=? WHERE id=?`)
      .run(e.message, logId);
    console.error('[Sync] Erro:', e.message);
    return { ok: false, erro: e.message };
  }
}

// Importação manual via array de objetos (para upload de CSV/Excel)
async function importarRegistros(registros) {
  return syncTransacoes(registros);
}

module.exports = { executarSync, importarRegistros, boraGet, getToken };
