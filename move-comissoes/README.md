# Move Comissões

Plataforma web para gestão de comissões de vendedores — integrada com a API Bora MVNO.

## Estrutura

```
move-comissoes/
├── backend/          ← Node.js + Express + SQLite
│   ├── index.js      ← servidor principal + cron sync
│   ├── db.js         ← banco de dados SQLite
│   ├── bora.js       ← integração API Bora
│   ├── routes/
│   │   ├── auth.js   ← login
│   │   ├── admin.js  ← usuários, planos, sync
│   │   └── relatorio.js ← relatórios e comissões
│   └── middleware/
│       └── auth.js   ← JWT
├── frontend/
│   ├── index.html    ← login
│   ├── admin.html    ← painel admin/gerente
│   ├── vendedor.html ← painel vendedor
│   └── assets/
│       ├── style.css
│       └── api.js
└── railway.json
```

## Deploy no Railway

1. Criar novo projeto no Railway
2. Conectar este repositório
3. Configurar variáveis de ambiente:
   ```
   PORT=3000
   JWT_SECRET=<chave-secreta-longa>
   BORA_EMAIL=<email-da-conta-bora>
   BORA_SENHA=<senha-da-conta-bora>
   DB_PATH=/app/data/data.db
   ```
4. Adicionar volume persistente montado em `/app/data`
5. Deploy automático

## Primeiro acesso

- URL: `https://seu-app.railway.app`
- Email: `admin@move.com`
- Senha: `admin123`
- **TROQUE A SENHA IMEDIATAMENTE após o primeiro login**

## Configuração inicial

1. **Cadastrar planos e comissões** (aba Planos & Comissões)
   - Nome do plano deve ser IGUAL ao que aparece no relatório Bora
   - Ex: `CELULAR 10GB`, `CELULAR 24GB`, `CELULAR 50GB`
2. **Cadastrar vendedores** (aba Vendedores)
   - Nome deve ser IGUAL ao campo VENDEDOR do relatório Bora
3. **Sincronizar** (aba Sincronização → Sincronizar Agora)
   - Ou aguardar sync automático (a cada hora)

## Nota sobre a API Bora

O PDF da Bora não documenta um endpoint de listagem geral de transações.
Duas opções para sync de dados:
1. **Import manual**: exportar o Excel do painel Bora e fazer upload na aba Sincronização
2. **API automática**: quando a Bora fornecer o endpoint de relatório, configurar em `backend/bora.js` função `fetchVendasPeriodo()`

## Perfis

| Perfil | Acesso |
|--------|--------|
| admin | Tudo: usuários, planos, sync, relatórios |
| gerente | Relatórios de todos os vendedores |
| vendedor | Apenas próprias transações e comissões |
