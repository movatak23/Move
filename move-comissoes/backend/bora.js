const { db } = require('./db');

// ===== SINCRONIZAÇÃO COM API BORA =====

async function fetchVendasPeriodo(dataInicio, dataFim) {
          try {
                      const BORA_USER = process.env.BORA_USER;
                      const BORA_PASS = process.env.BORA_PASS;

            if (!BORA_USER || !BORA_PASS) {
                          console.error('[Bora API] Credenciais não configuradas');
                          return [];
            }

            const auth = Buffer.from(`${BORA_USER}:${BORA_PASS}`).toString('base64');

            const url = `https://app.boramvno.com.br/appapi/api/Report/Sales?customerId=&initialDate=${dataInicio}&finalDate=${dataFim}`;

            console.log(`[Bora API] Buscando vendas de ${dataInicio} até ${dataFim}`);

            const response = await fetch(url, {
                          method: 'GET',
                          headers: {
                                          'Authorization': `Basic ${auth}`,
                                          'Content-Type': 'application/json'
                          }
            });

            if (response.status === 401) {
                          console.error('[Bora API] Erro ao buscar vendas: 401 - Credenciais inválidas');
                          return [];
            }

            if (!response.ok) {
                          console.error(`[Bora API] Erro ${response.status}: ${response.statusText}`);
                          return [];
            }

            const data = await response.json();
                      console.log(`[Bora API] Recebidas ${data.length || 0} vendas do período`);
                      return Array.isArray(data) ? data : [];

          } catch (erro) {
                      console.error('[Bora API] Erro ao buscar vendas:', erro.message);
                      return [];
          }
}

// ===== PROCESSAMENTO DE VENDAS =====

async function processarVendas(vendas) {
          if (!vendas || vendas.length === 0) {
                      console.log('[Bora Sync] Nenhuma venda para processar');
                      return { novos: 0, atualizados: 0, erros: 0 };
          }

  let novos = 0, atualizados = 0, erros = 0;

  for (const venda of vendas) {
              try {
                            const stmt = db.prepare(`
                                    INSERT INTO transacoes (
                                              msisdn, iccid, data_transacao, cpf_cnpj, nome_cliente,
                                                        plano, tipo, valor, meio_pagamento, canal, vendedor_bora,
                                                                  supervisor, loja
                                                                          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                                                                  ON CONFLICT(msisdn, iccid, data_transacao, tipo) DO UPDATE SET
                                                                                            nome_cliente = excluded.nome_cliente,
                                                                                                      valor = excluded.valor,
                                                                                                                sync_em = datetime('now')
                                                                                                                      `);

                stmt.run(
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
                                            console.error('[Bora Sync] Erro ao processar venda:', erro.message);
                                            erros++;
                            }
              }
  }

  console.log(`[Bora Sync] Novos: ${novos} | Atualizados: ${atualizados} | Erros: ${erros}`);
          return { novos, atualizados, erros };
}

// ===== CÁLCULO DE COMISSÕES =====

async function recalcularComissoes() {
          try {
                      console.log('[Bora Sync] Recalculando comissões...');

            // Buscar todas as transações sem comissão calculada
            const transacoes = db.prepare(`
                  SELECT t.id, t.valor, t.tipo, t.vendedor_bora, t.plano
                        FROM transacoes t
                              WHERE t.comissao = 0 AND t.valor > 0
                                  `).all();

            if (transacoes.length === 0) {
                          console.log('[Bora Sync] Nenhuma transação pendente de cálculo');
                          return;
            }

            let comissoesCalculadas = 0;

            for (const transacao of transacoes) {
                          try {
                                          // Buscar plano de comissão
                            const plano = db.prepare(`
                                      SELECT comissao_ativacao, comissao_recarga FROM planos_comissao WHERE nome_plano = ?
                                              `).get(transacao.plano);

                            let taxa = 0;
                                          if (plano) {
                                                            if (transacao.tipo === 'ativacao' || transacao.tipo === 'activation') {
                                                                                taxa = plano.comissao_ativacao;
                                                            } else if (transacao.tipo === 'recarga' || transacao.tipo === 'recharge') {
                                                                                taxa = plano.comissao_recarga;
                                                            }
                                          }

                            const comissao = (transacao.valor * taxa) / 100;

                            // Atualizar comissão na transação
                            db.prepare(`
                                      UPDATE transacoes SET comissao = ? WHERE id = ?
                                              `).run(comissao, transacao.id);

                            comissoesCalculadas++;
                          } catch (erro) {
                                          console.error('[Bora Sync] Erro ao calcular comissão:', erro.message);
                          }
            }

            console.log(`[Bora Sync] ${comissoesCalculadas} comissões calculadas`);
          } catch (erro) {
                      console.error('[Bora Sync] Erro ao recalcular comissões:', erro.message);
          }
}

// ===== SINCRONIZAÇÃO PRINCIPAL =====

async function executarSync() {
          const sincronizacao = {
                      iniciado_em: new Date().toISOString(),
                      status: 'processando',
                      registros_novos: 0,
                      erro: null
          };

  try {
              console.log('[Bora Sync] ========== INICIANDO SINCRONIZAÇÃO ==========');
              const agora = new Date();

            // Calcular período: últimos 7 dias
            const dataFim = agora.toISOString().split('T')[0];
              const dataInicio = new Date(agora.setDate(agora.getDate() - 7)).toISOString().split('T')[0];

            console.log(`[Bora Sync] Período: ${dataInicio} até ${dataFim}`);

            // Buscar vendas da API Bora
            const vendas = await fetchVendasPeriodo(dataInicio, dataFim);

            // Processar vendas
            if (vendas.length > 0) {
                          const resultado = await processarVendas(vendas);
                          sincronizacao.registros_novos = resultado.novos;
            }

            // Recalcular comissões
            await recalcularComissoes();

            sincronizacao.status = 'sucesso';
              console.log('[Bora Sync] ========== SINCRONIZAÇÃO CONCLUÍDA ==========\n');

  } catch (erro) {
              sincronizacao.status = 'erro';
              sincronizacao.erro = erro.message;
              console.error('[Bora Sync] ERRO CRÍTICO:', erro);
  }

  // Registrar sincronização no log
  try {
              db.prepare(`
                    INSERT INTO sync_log (status, registros_novos, erro)
                          VALUES (?, ?, ?)
                              `).run(sincronizacao.status, sincronizacao.registros_novos, sincronizacao.erro);
  } catch (erro) {
              console.error('[Bora Sync] Erro ao registrar sincronização:', erro.message);
  }

  return sincronizacao;
}

module.exports = { executarSync, fetchVendasPeriodo, processarVendas, recalcularComissoes };
