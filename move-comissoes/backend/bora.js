const { db } = require('./db');

/**
 * ===== SINCRONIZAÇÃO COM API BORA =====
 * 
 * Sistema de sincronização real com tratamento robusto de erros
 * Valida credenciais, trata 401, e salva dados de verdade no banco
 */

async function fetchVendasPeriodo(dataInicio, dataFim) {
            try {
                          const BORA_USER = process.env.BORA_USER;
                          const BORA_PASS = process.env.BORA_PASS;

              // Validar credenciais
              if (!BORA_USER || !BORA_PASS) {
                              console.error('[Bora API] ❌ Credenciais não configuradas em Railway Variables');
                              console.error('[Bora API] Esperado: BORA_USER e BORA_PASS');
                              return { sucesso: false, erro: 'Credenciais não configuradas', dados: [] };
              }

              // Preparar autenticação Basic Auth
              const auth = Buffer.from(`${BORA_USER}:${BORA_PASS}`).toString('base64');
                          const url = `https://app.boramvno.com.br/appapi/api/Report/Sales?customerId=&initialDate=${dataInicio}&finalDate=${dataFim}`;

              console.log(`[Bora API] 🔍 Buscando vendas de ${dataInicio} até ${dataFim}`);
                          console.log(`[Bora API] 🔐 Usando autenticação: ${BORA_USER}`);

              const response = await fetch(url, {
                              method: 'GET',
                              headers: {
                                                'Authorization': `Basic ${auth}`,
                                                'Content-Type': 'application/json',
                                                'User-Agent': 'Move-Comissoes/1.0'
                              },
                              timeout: 15000
              });

              console.log(`[Bora API] 📡 Status HTTP: ${response.status} ${response.statusText}`);

              // Tratar 401 especificamente
              if (response.status === 401) {
                              console.error('[Bora API] ❌ Erro 401 - FALHA DE AUTENTICAÇÃO');
                              console.error('[Bora API] Possíveis causas:');
                              console.error('[Bora API]   1. Email ou senha incorretos');
                              console.error('[Bora API]   2. Conta expirou ou foi bloqueada');
                              console.error('[Bora API]   3. IP do servidor está bloqueado');
                              return { sucesso: false, erro: 'Autenticação falhou (401)', dados: [] };
              }

              if (!response.ok) {
                              console.error(`[Bora API] ❌ Erro HTTP ${response.status}`);
                              const texto = await response.text();
                              console.error(`[Bora API] Resposta: ${texto.substring(0, 200)}`);
                              return { sucesso: false, erro: `HTTP ${response.status}`, dados: [] };
              }

              // Ler resposta
              const dados = await response.json();

              if (!Array.isArray(dados)) {
                              console.warn('[Bora API] ⚠️  Resposta não é um array. Tipo:', typeof dados);
                              return { sucesso: false, erro: 'Resposta não é um array', dados: [] };
              }

              console.log(`[Bora API] ✅ Sucesso! Recebidas ${dados.length} vendas`);
                          return { sucesso: true, erro: null, dados };

            } catch (erro) {
                          console.error('[Bora API] ❌ Erro ao buscar vendas:');
                          console.error(`[Bora API]   ${erro.message}`);
                          return { sucesso: false, erro: erro.message, dados: [] };
            }
}

async function processarVendas(vendas) {
            if (!vendas || vendas.length === 0) {
                          console.log('[Bora Sync] ℹ️  Nenhuma venda para processar');
                          return { novos: 0, atualizados: 0, erros: 0 };
            }

  let novos = 0, atualizados = 0, erros = 0;
            console.log(`[Bora Sync] 📥 Processando ${vendas.length} vendas...`);

  for (const venda of vendas) {
                try {
                                db.prepare(`
                                        INSERT INTO transacoes (
                                                  msisdn, iccid, data_transacao, cpf_cnpj, nome_cliente,
                                                            plano, tipo, valor, meio_pagamento, canal, vendedor_bora,
                                                                      supervisor, loja
                                                                              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                                                                    `).run(
                                                  venda.msisdn || venda.phone || '',
                                                  venda.iccid || venda.sim || '',
                                                  venda.data_transacao || venda.date || new Date().toISOString(),
                                                  venda.cpf_cnpj || '',
                                                  venda.nome_cliente || venda.customer_name || '',
                                                  venda.plano || venda.plan || '',
                                                  venda.tipo || venda.type || 'venda',
                                                  venda.valor || venda.amount || 0,
                                                  venda.meio_pagamento || venda.payment_method || '',
                                                  venda.canal || venda.channel || '',
                                                  venda.vendedor_bora || venda.seller_name || '',
                                                  venda.supervisor || venda.supervisor_name || '',
                                                  venda.loja || venda.store || ''
                                                );
                                novos++;
                } catch (erro) {
                                if (erro.message.includes('UNIQUE constraint failed')) {
                                                  atualizados++;
                                } else {
                                                  console.error(`[Bora Sync] ❌ Erro ao inserir venda: ${erro.message}`);
                                                  erros++;
                                }
                }
  }

  console.log(`[Bora Sync] ✅ Resultado: ${novos} novos, ${atualizados} atualizados, ${erros} erros`);
            return { novos, atualizados, erros };
}

async function recalcularComissoes() {
            try {
                          console.log('[Bora Sync] 🧮 Recalculando comissões...');

              const transacoes = db.prepare(`
                    SELECT id, valor, tipo, plano FROM transacoes WHERE comissao = 0 AND valor > 0
                        `).all();

              if (transacoes.length === 0) {
                              console.log('[Bora Sync] ℹ️  Nenhuma transação com comissão pendente');
                              return;
              }

              let calculadas = 0;
                          for (const trans of transacoes) {
                                          try {
                                                            const plano = db.prepare(
                                                                                `SELECT comissao_ativacao, comissao_recarga FROM planos_comissao WHERE nome_plano = ?`
                                                                              ).get(trans.plano);

                                            let taxa = 0;
                                                            if (plano) {
                                                                                taxa = trans.tipo === 'ativacao' ? plano.comissao_ativacao : plano.comissao_recarga;
                                                            }

                                            const comissao = (trans.valor * taxa) / 100;
                                                            db.prepare(`UPDATE transacoes SET comissao = ? WHERE id = ?`).run(comissao, trans.id);
                                                            calculadas++;
                                          } catch (e) {
                                                            console.error(`[Bora Sync] ❌ Erro ao calcular comissão: ${e.message}`);
                                          }
                          }

              console.log(`[Bora Sync] ✅ ${calculadas} comissões calculadas`);
            } catch (erro) {
                          console.error(`[Bora Sync] ❌ Erro ao recalcular: ${erro.message}`);
            }
}

async function executarSync() {
            const inicio = Date.now();
            console.log('[Bora Sync] ========== INICIANDO SINCRONIZAÇÃO ==========');

  try {
                // Calcular período
              const agora = new Date();
                const dataFim = agora.toISOString().split('T')[0];
                const dataInicio = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

              console.log(`[Bora Sync] 📅 Período: ${dataInicio} até ${dataFim}`);

              // Buscar vendas
              const resultado = await fetchVendasPeriodo(dataInicio, dataFim);

              if (!resultado.sucesso) {
                              console.error(`[Bora Sync] ❌ Falha na busca: ${resultado.erro}`);
                              console.log('[Bora Sync] ========== SINCRONIZAÇÃO FALHOU ==========\n');
                              return;
              }

              // Processar vendas
              const stats = await processarVendas(resultado.dados);

              // Recalcular comissões
              await recalcularComissoes();

              const duracao = ((Date.now() - inicio) / 1000).toFixed(2);
                console.log(`[Bora Sync] ✅ ========== SINCRONIZAÇÃO CONCLUÍDA EM ${duracao}s ==========\n`);

  } catch (erro) {
                console.error(`[Bora Sync] ❌ ERRO CRÍTICO: ${erro.message}`);
                console.log('[Bora Sync] ========== SINCRONIZAÇÃO FALHOU ==========\n');
  }
}

module.exports = { executarSync, fetchVendasPeriodo, processarVendas, recalcularComissoes };
