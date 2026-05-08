# 🔍 DIRETRIZES DE VALIDAÇÃO DE SOLUÇÕES - SKILL OBRIGATÓRIA

## 📌 Propósito
Este documento estabelece um padrão **obrigatório** para validar soluções antes de apresentá-las como funcionais. Evita apresentar código quebrado como pronto, garantindo qualidade real.

**Criado em:** 7 de Maio de 2026  
**Razão:** Múltiplas apresentações de "soluções funcionais" que na verdade tinham erros críticos nos logs

---

## ❌ ERROS QUE COMETI (NÃO REPETIR)

### 1. Confundir "Deployment Successful" com "Código Funcionando"
- **Erro:** Disser que solução estava pronta porque Railway mostrou "Deployment successful"
- **Realidade:** Deployment sucedeu, mas código ainda tinha `db.query is not a function`
- **Lição:** Status do deployment ≠ código funcionando
- **Solução:** Verificar LOGS REAIS após execução, não apenas status de build

### 2. Ignorar Erros "Persistentes" nos Logs
- **Erro:** Ver erro 401 e "db.query" erroneamente e achar que era cache antigo
- **Realidade:** Eram erros REAIS do código novo que estava rodando
- **Lição:** Se erro aparece no log APÓS deploy timestamp, não é cache - é problema real
- **Solução:** Verificar timestamp do log vs timestamp do deploy

### 3. Assumir que API "foi chamada" sem verificar resposta
- **Erro:** Ver `[Bora API] Buscando vendas...` e achar que funcionou
- **Realidade:** Log seguinte mostrava "Erro ao buscar vendas: Error 401"
- **Lição:** Uma log de "tentando fazer" não significa "conseguiu fazer"
- **Solução:** Verificar se há erro logo após, e validar dados no banco

### 4. Não verificar se dados foram de fato inseridos
- **Erro:** Ver log `[Bora Sync] Nenhuma venda para processar` e achar normal
- **Realidade:** Significava que API retornou erro e não trouxe dados
- **Lição:** "Nenhuma venda" pode ser sucesso OU falha - verificar por quê
- **Solução:** Fazer SELECT COUNT(*) no banco para validar insersão real

### 5. Apresentar solução antes de esperar primeira execução
- **Erro:** Disser "pronto" logo após deploy, sem aguardar cron/startup rodarem
- **Realidade:** Primeira execução do código novo ainda não tinha acontecido
- **Lição:** Deployment é apenas preparação, execução é o teste real
- **Solução:** Aguardar MÍNIMO 2-3 minutos e verificar logs de execução real

---

## ✅ CHECKLIST DE VALIDAÇÃO OBRIGATÓRIO

### ANTES DE APRESENTAR QUALQUER SOLUÇÃO, FAZER TODOS ESTES PASSOS:

#### 📋 PASSO 1: Verificar Logs (Obrigatório - 10 últimas linhas)
```
PROCEDIMENTO:
1. Ir para Railway > Logs
2. Filtrar por timestamp POSTERIOR ao deploy
3. Procurar por: TypeError, Error, Failed, 401, 500, db.query
4. CONTAR quantas linhas vermelhas há

SUCESSO SE:
✅ 0 linhas vermelhas nos últimos 30 minutos
✅ Timestamp dos logs é DEPOIS do deploy realizado
✅ Nenhuma mensagem de erro repetida
✅ Ao menos 1 mensagem de sucesso (ex: "SINCRONIZAÇÃO CONCLUÍDA")

FALHA SE:
❌ Há qualquer TypeError, Error, ou Failed
❌ Há "401", "Erro ao buscar", "is not a function"
❌ Logs anteriores ao deployment (código antigo rodando)
❌ Nenhuma mensagem de sucesso esperado aparece
```

#### 📋 PASSO 2: Validar Credenciais (Obrigatório)
```
PROCEDIMENTO:
1. Railway > Service Settings > Variables
2. Verificar cada variável de ambiente necessária existe
3. Para APIs: Testar com curl/fetch se credenciais funcionam

SUCESSO SE:
✅ BORA_USER definido (não vazio)
✅ BORA_PASS definido (não vazio)
✅ Teste de API retorna 200 (não 401)
✅ Response contém dados esperados

FALHA SE:
❌ Variável não existe
❌ Variável está vazia ou "undefined"
❌ Teste retorna 401 ou 403
❌ Response é vazia ou contém erro
```

#### 📋 PASSO 3: Validar Resposta da API (Se aplicável)
```
PROCEDIMENTO:
1. Fazer POST/GET manual para testar endpoint
2. Verificar status code HTTP
3. Verificar se resposta contém dados esperados
4. Procurar por erro no response body

SUCESSO SE:
✅ Status code = 200
✅ Response contém array de dados (não vazio)
✅ Dados têm estrutura esperada (campos presentes)
✅ Nenhuma mensagem de erro na resposta

FALHA SE:
❌ Status = 401, 403, 404, 500
❌ Response vazia ou null
❌ Response contém "error", "Error", "failed"
❌ Estrutura de dados incorreta
```

#### 📋 PASSO 4: Validar Banco de Dados (Obrigatório)
```
PROCEDIMENTO:
1. Executar SELECT para verificar dados inseridos
2. Para sincronização: SELECT COUNT(*) FROM transacoes
3. Verificar se há registros novos vs esperado

SUCESSO SE:
✅ SELECT retorna dados (não erro)
✅ COUNT > 0 (dados foram de fato inseridos)
✅ Campos têm valores corretos
✅ Timestamps são recentes

FALHA SE:
❌ SELECT retorna erro (tabela não existe, etc)
❌ COUNT = 0 (nada foi inserido)
❌ Campos estão NULL ou vazios
❌ Timestamps são antigos (dados não são novos)
```

#### 📋 PASSO 5: Teste Manual End-to-End (Obrigatório)
```
PROCEDIMENTO:
1. Acessar aplicação em produção
2. Executar ação que deve funcionar (ex: POST /api/sync/vendas)
3. Acompanhar logs em tempo real
4. Aguardar resposta da API
5. Verificar se dados aparecem no banco

SUCESSO SE:
✅ Ação executa sem erro HTTP
✅ Logs mostram processo completo
✅ Nenhum error/TypeError nos logs
✅ Dados aparecem no banco em segundos
✅ Se há cálculos, resultados estão corretos

FALHA SE:
❌ API retorna erro (4xx, 5xx)
❌ Logs mostram erro em qualquer etapa
❌ Dados não aparecem no banco após esperar
❌ Cálculos retornam valores errados/zero
```

---

## 🚨 SINAIS DE ALERTA (Indicam solução NÃO PRONTA)

Se QUALQUER um desses aparecer, a solução **NÃO ESTÁ PRONTA**:

```
❌ Log mostra "Error" ou "TypeError" após deploy
❌ Mensagem "db.query is not a function"
❌ HTTP status 401, 403, 500 em logs
❌ "Erro ao buscar" ou "Error ao conectar"
❌ "Nenhuma venda para processar" COM erro acima (não é sucesso)
❌ Credenciais não configuradas em Railway Variables
❌ SELECT COUNT retorna 0 quando esperado > 0
❌ API retornando 401 Unauthorized
❌ Erro de constraint no banco (UNIQUE, FOREIGN KEY)
❌ Código novo rodando mas ainda com erro do código antigo
```

---

## 📋 TEMPLATE DE VALIDAÇÃO

**COPIAR E PREENCHER ANTES DE APRESENTAR SOLUÇÃO:**

```markdown
# VALIDAÇÃO DE SOLUÇÃO

## Informações
- **Feature:** [Nome da funcionalidade implementada]
- **Data:** [Data e hora da validação]
- **Deployment ID:** [ID do deploy no Railway]
- **Commit:** [Hash do commit no GitHub]

## Checklist de Validação

### ✅ Passo 1: Logs
- [ ] Verificados logs dos últimos 30 minutos
- [ ] Nenhum erro (TypeError, Error, Failed) encontrado
- [ ] Timestamp dos logs é POSTERIOR ao deploy
- [ ] Mensagens de sucesso esperadas estão presentes

**Logs relevantes:**
```
[Log aqui]
```

### ✅ Passo 2: Credenciais
- [ ] BORA_USER configurado em Railway Variables
- [ ] BORA_PASS configurado em Railway Variables
- [ ] Teste de API retornou 200 OK
- [ ] Dados recebidos da API

**Teste realizado:**
```
curl -u ${BORA_USER}:${BORA_PASS} [URL] → Status 200
```

### ✅ Passo 3: Resposta da API
- [ ] Status code = 200
- [ ] Response contém dados (não vazio)
- [ ] Estrutura de dados correta
- [ ] Nenhum erro na resposta

**Response sample:**
```json
[Incluir amostra aqui]
```

### ✅ Passo 4: Banco de Dados
- [ ] Tabelas existem e estão acessíveis
- [ ] SELECT COUNT > 0 (dados inseridos)
- [ ] Dados têm valores corretos
- [ ] Timestamps são recentes

**Query executada:**
```sql
SELECT COUNT(*) FROM transacoes;
→ Resultado: [número]
```

### ✅ Passo 5: Teste Manual
- [ ] Ação foi executada sem erro
- [ ] Logs mostram execução completa
- [ ] Dados aparecem no banco
- [ ] Cálculos (se aplicável) estão corretos

**Resultado do teste:**
```
POST /api/sync/vendas
→ Status: 200
→ Dados inseridos: X registros
→ Sem erros nos logs
```

## Conclusão

**STATUS:** 
- [ ] ✅ PRONTO PARA PRODUÇÃO (todos os checkboxes marcados)
- [ ] ❌ NÃO PRONTO - Motivo: [descrever qual validação falhou]

**Detalhes dos problemas encontrados (se aplicável):**
```
[Listar o que falhou e por quê]
```
```

---

## 🎯 PROCESSO OBRIGATÓRIO DE IMPLEMENTAÇÃO

1. **Implementar** solução no código
2. **Fazer commit** no GitHub
3. **Deploy** para Railway
4. **ESPERAR 2-3 MINUTOS** para primeira execução
5. **Verificar TODOS os 5 passos de validação** (em ordem)
6. **PREENCHER template** de validação acima
7. **SOMENTE SE todos os checkboxes = ✅**: apresentar como funcional
8. **SE qualquer checkbox = ❌**: 
   - Voltar ao código
      - Identificar exato o problema (não "acho que é cache")
         - Corrigir
            - Repetir de novo desde passo 1

            ---

            ## 📌 REGRA OURO

            > **"Nunca apresento solução como pronta sem PROVA nos logs e banco de dados de que funciona de verdade. Se há erro, sou honesto e digo exatamente qual é, onde aparece, e por que ainda não funciona."**

            ---

            ## 🔄 Revisão desta Skill

            - **Criada:** 7 de Maio de 2026
            - **Última atualização:** 7 de Maio de 2026
            - **Aplicável a:** Todos os projetos, especialmente Move Comissões
            - **Revisar se:** Há novo padrão de erro sistemático
            
