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
      method: 'POST', // ou GET, conforme documenta a Bora
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Erro na autenticação: ${response.status}`);
    }

    const data = await response.json();
    return data.token; // Ajustar conforme o retorno da API
  } catch (erro) {
    console.error('Erro ao autenticar na Bora:', erro);
    throw erro;
  }
}
