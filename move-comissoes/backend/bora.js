const db = require('./db');

// Função auxiliar para gerar Basic Auth
function gerarBasicAuth(usuario, senha) {
    const credenciais = `${usuario}:${senha}`;
    return 'Basic ' + Buffer.from(credenciais).toString('base64');
}

// Corrigir a função de autenticação
async function autenticarBora(usuario, senha) {
    try {
          const authHeader = gerarBasicAuth(usuario, senha);

      const response = await fetch('https://api.bora.com/api/Authentication/basic', {
              method: 'POST',
              headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
              }
      });

      if (!response.ok) {
              throw new Error(`Erro na autenticação: ${response.status}`);
      }

      const data = await response.json();
          return data.token;
    } catch (erro) {
          console.error('Erro ao autenticar na Bora:', erro);
          throw erro;
    }
}

// Função principal de sync
async function executarSync() {
    try {
          console.log('[Bora Sync] Iniciando sincronização...');

      // Log: função ativa
      console.log('[Bora Sync] Nota: Importação de Excel é o método atual');
          console.log('[Bora Sync] Aguardando endpoint de listagem de transações da Bora');

      // TODO: Implementar quando a Bora disponibilizar endpoint de listagem
      // const token = await autenticarBora(process.env.BORA_USER, process.env.BORA_PASS);
      // const vendas = await fetchVendasPeriodo(token, dataInicio, dataFim);
      // await processarVendas(vendas);
      // await recalcularComissoes();

      console.log('[Bora Sync] Sincronização concluída');
    } catch (erro) {
          console.error('[Bora Sync] Erro ao sincronizar:', erro);
    }
}

// Função para processar vendas (será usada quando tivermos os dados)
async function processarVendas(vendas) {
    try {
          console.log(`[Bora Sync] Processando ${vendas.length} vendas...`);

      for (const venda of vendas) {
              const { numeroSerie, plano, valor, dataVenda, vendedor } = venda;

            // Buscar plano no BD
            const planoObj = await db.query(
                      'SELECT id, comissao FROM planos WHERE nome = ?',
                      [plano]
                    );

            if (!planoObj || planoObj.length === 0) {
                      console.warn(`[Bora Sync] Plano "${plano}" não encontrado no BD`);
                      continue;
            }

            const planoId = planoObj[0].id;
              const comissaoPlano = planoObj[0].comissao;

            // Inserir venda
            await db.query(
                      `INSERT INTO vendas (numero_serie, plano_id, valor, data_venda, vendedor, comissao, status)
                               VALUES (?, ?, ?, ?, ?, ?, ?)
                                        ON DUPLICATE KEY UPDATE valor = ?, data_venda = ?, comissao = ?`,
                      [
                                  numeroSerie, planoId, valor, dataVenda, vendedor,
                                  valor * (comissaoPlano / 100), 'processada',
                                  valor, dataVenda, valor * (comissaoPlano / 100)
                                ]
                    );
      }

      console.log('[Bora Sync] Vendas processadas com sucesso');
    } catch (erro) {
          console.error('[Bora Sync] Erro ao processar vendas:', erro);
          throw erro;
    }
}

// Função para recalcular comissões (chamada quando planos são alterados)
async function recalcularComissoes() {
    try {
          console.log('[Bora Sync] Recalculando comissões...');

      const vendas = await db.query(
              `SELECT v.id, v.valor, v.plano_id, p.comissao
                     FROM vendas v
                            JOIN planos p ON v.plano_id = p.id
                                   WHERE v.status = 'processada'`
            );

      for (const venda of vendas) {
              const novaComissao = venda.valor * (venda.comissao / 100);
              await db.query(
                        'UPDATE vendas SET comissao = ? WHERE id = ?',
                        [novaComissao, venda.id]
                      );
      }

      console.log('[Bora Sync] Comissões recalculadas com sucesso');
    } catch (erro) {
          console.error('[Bora Sync] Erro ao recalcular comissões:', erro);
          throw erro;
    }
}

module.exports = { executarSync, autenticarBora, gerarBasicAuth, processarVendas, recalcularComissoes };
