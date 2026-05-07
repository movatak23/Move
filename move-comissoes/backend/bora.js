const db = require('./db');

// Função auxiliar para gerar Basic Auth
function gerarBasicAuth(usuario, senha) {
      const credenciais = `${usuario}:${senha}`;
      return 'Basic ' + Buffer.from(credenciais).toString('base64');
}

// Função para buscar vendas da API Bora
async function fetchVendasPeriodo(dataInicio, dataFim) {
      try {
              const url = `https://app.boramvno.com.br/appapi/api/Report/Sales?customerId=&initialDate=${dataInicio}&finalDate=${dataFim}`;

        console.log(`[Bora API] Buscando vendas de ${dataInicio} até ${dataFim}`);

        const response = await fetch(url, {
                  method: 'GET',
                  headers: {
                              'Content-Type': 'application/json'
                  }
        });

        if (!response.ok) {
                  throw new Error(`Erro ao buscar vendas: ${response.status}`);
        }

        const data = await response.json();
              console.log(`[Bora API] Recebidas ${data.length || 0} vendas`);
              return data;
      } catch (erro) {
              console.error('[Bora API] Erro ao buscar vendas:', erro);
              return [];
      }
}

// Função para processar vendas
async function processarVendas(vendas) {
      try {
              if (!vendas || vendas.length === 0) {
                        console.log('[Bora Sync] Nenhuma venda para processar');
                        return;
              }

        console.log(`[Bora Sync] Processando ${vendas.length} vendas...`);

        for (const venda of vendas) {
                  // Ajustar nomes de campos conforme API Bora retorna
                const numeroSerie = venda.iccid || venda.msisdn || venda.numero_serie;
                  const planoNome = venda.planName || venda.plano || venda.nome_plano;
                  const valor = parseFloat(venda.value || venda.valor || 0);
                  const dataVenda = venda.date || venda.data_venda || new Date().toISOString();
                  const vendedor = venda.vendedor || 'API Bora';

                if (!numeroSerie || !planoNome) {
                            console.warn('[Bora Sync] Venda incompleta (faltam dados essenciais):', venda);
                            continue;
                }

                // Buscar plano no BD
                const planoObj = await db.query(
                            'SELECT id, comissao FROM planos WHERE nome = ?',
                            [planoNome]
                          );

                if (!planoObj || planoObj.length === 0) {
                            console.warn(`[Bora Sync] Plano "${planoNome}" não encontrado no BD`);
                            continue;
                }

                const planoId = planoObj[0].id;
                  const comissaoPlano = planoObj[0].comissao;
                  const comissaoCalculada = valor * (comissaoPlano / 100);

                // Inserir ou atualizar venda
                await db.query(
                            `INSERT INTO vendas (numero_serie, plano_id, valor, data_venda, vendedor, comissao, status)
                                     VALUES (?, ?, ?, ?, ?, ?, ?)
                                              ON DUPLICATE KEY UPDATE valor = VALUES(valor), comissao = VALUES(comissao), status = 'processada'`,
                            [
                                          numeroSerie, planoId, valor, dataVenda, vendedor,
                                          comissaoCalculada, 'processada'
                                        ]
                          );

                console.log(`[Bora Sync] ✓ Venda processada: ${numeroSerie} - ${planoNome} - R$ ${valor}`);
        }

        console.log('[Bora Sync] Vendas processadas com sucesso');
      } catch (erro) {
              console.error('[Bora Sync] Erro ao processar vendas:', erro);
              throw erro;
      }
}

// Função para recalcular comissões
async function recalcularComissoes() {
      try {
              console.log('[Bora Sync] Recalculando comissões...');

        const vendas = await db.query(
                  `SELECT v.id, v.valor, v.plano_id, p.comissao
                         FROM vendas v
                                JOIN planos p ON v.plano_id = p.id
                                       WHERE v.status = 'processada'`
                );

        if (!vendas || vendas.length === 0) {
                  console.log('[Bora Sync] Nenhuma venda para recalcular');
                  return;
        }

        for (const venda of vendas) {
                  const novaComissao = venda.valor * (venda.comissao / 100);
                  await db.query(
                              'UPDATE vendas SET comissao = ? WHERE id = ?',
                              [novaComissao, venda.id]
                            );
        }

        console.log(`[Bora Sync] ✓ ${vendas.length} comissões recalculadas`);
      } catch (erro) {
              console.error('[Bora Sync] Erro ao recalcular comissões:', erro);
      }
}

// Função principal de sync
async function executarSync() {
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
        await processarVendas(vendas);

        // Recalcular comissões
        await recalcularComissoes();

        console.log('[Bora Sync] ========== SINCRONIZAÇÃO CONCLUÍDA ==========\n');
      } catch (erro) {
              console.error('[Bora Sync] ERRO CRÍTICO:', erro);
      }
}

module.exports = { executarSync, fetchVendasPeriodo, processarVendas, recalcularComissoes, gerarBasicAuth };
