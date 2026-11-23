# Automação de navegação

## Estratégia

- Confirme a autorização do titular para a tarefa e para cada URL. Cadastre tarefas e recursos HTTPS exatos em `src/tasks.mjs`, com uma verificação do conteúdo esperado.
- Priorize API oficial ou uma leitura HTTP direta. Use Chromium no runner quando a tarefa exigir DOM ou JavaScript. Habilite fallback ao Browserless para uma tarefa somente se o Chromium do runner estiver indisponível e a tarefa precisar dele.
- Trate CAPTCHA, negação de acesso e rate limit como resultado da execução. Para um site próprio, use API autorizada, acesso de serviço permitido pelo titular ou um ambiente de teste com as chaves oficiais do provedor. Encerre a tarefa se o usuário precisar completar uma verificação.
- Mantenha as tarefas compartilhadas como leituras. Cadastre a URL canônica em vez de seguir redirecionamentos. Declare os recursos do navegador necessários, incluindo scripts e folhas de estilo. Revise as alterações no fluxo e no registro de tarefas por PR.

## Operação

- Rode `npm ci --ignore-scripts` e `npm test` ao alterar o projeto. Exercite os workflows com `actionlint` quando disponível.
- Os workflows rodam por acionamento manual na branch padrão do repositório privado. Marque `confirm_free_limit` na execução somente após verificar o bloqueio de gastos adicionais no GitHub.
- Browserless exige `allow_browserless` e `confirm_browserless_free` na execução, validação pela API de uso e `BROWSERLESS_TOKEN` no GitHub Secrets.
- Limite o acesso direto a duas tentativas e o navegador a uma sessão Browserless por execução. As sessões fecham ao terminar e o serviço tem um teto de 25 segundos. Mantenha as execuções em série e o limite do job em cinco minutos.
- Leia o resumo no GitHub Actions. Registre status, etapa e códigos de erro controlados. Mantenha credenciais, URLs de conexão autenticadas, cookies, dados de página e mensagens brutas do cliente fora dos logs.
