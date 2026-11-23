# Navegação autorizada na nuvem

As tarefas rodam no GitHub Actions. Cada execução começa por uma API ou leitura HTTPS, usa Chromium no runner para tarefas com JavaScript e pode usar Browserless se houver uma necessidade cadastrada. A tarefa `browserless-smoke` existe para verificar especificamente a conexão remota com uma leitura do endpoint de teste HTTPBingo.

## Primeiro acesso pelo iPhone

1. Abra o repositório privado no Safari e entre no GitHub.
2. Na aba **Actions**, toque em **Verificar infraestrutura** para rodar os testes ou em **Navegação autorizada** para executar uma tarefa.
3. Toque em **Run workflow**, escolha a branch padrão e use `direct-smoke` na primeira navegação. Se o botão estiver oculto, use **Solicitar Site para Computador** no Safari. É necessário ter acesso de gravação ao repositório.
4. Abra a execução mais recente para ler **Summary** e acompanhar ou cancelar o job.

| ID | O que verifica |
| --- | --- |
| `direct-smoke` | HTTP direto a um endpoint público de teste do HTTPBingo |
| `api-smoke` | A API pública do GitHub Status |
| `browser-smoke` | Chromium no runner para validar o cabeçalho da página de teste |
| `browserless-smoke` | Uma sessão Playwright remota dedicada a verificar a conexão |

## Configuração de uma vez

1. Abra **Billing and licensing → Budgets and alerts** na conta do GitHub. Confirme que o uso excedente de **GitHub Actions** está bloqueado, por ausência de meio de pagamento ou por um orçamento com limite de US$ 0 e **Stop usage when budget limit is reached**. Marque a confirmação de limite no formulário ao iniciar cada workflow.
2. Para usar Browserless, confirme a assinatura **Free** e o saldo no painel do Browserless. Na tela **Secrets** do repositório, crie `BROWSERLESS_TOKEN` e cole ali a chave gerada no provedor. Guarde o valor exclusivamente nesse campo.
3. Na aba **Variables** do repositório, configure `BROWSERLESS_FREE_CONFIRMED=true` e `BROWSERLESS_ENABLED=true`. Para alterar a região, use `BROWSERLESS_REGION` com `sfo`, `lon` ou `ams`. Deixe `BROWSERLESS_ENABLED` vazio ou defina `false` para desligar.
4. Execute `browserless-smoke` uma vez com **Permitir Browserless nesta execução** marcado. Se o pré-teste de acesso falhar, confira o código no resumo e o saldo no painel do provedor.

O plano gratuito do Browserless rejeita sessões ao esgotar a franquia. Uma sessão com menos de 30 segundos consome, em condições normais, uma unidade da franquia. As verificações de cobrança dependem das configurações reais dos provedores. As variáveis registram a verificação do responsável e a chamada de leitura à API Usage valida o acesso do token antes da sessão. Revise as condições se a conta ou o plano mudar.

## Adicionar tarefas

Adicione um ID a `src/tasks.mjs`. Use `kind: 'json'` com um campo e valores permitidos, `kind: 'html'` com um marcador esperado, ou `kind: 'browser'` com um seletor e texto esperado. Em uma tarefa de navegador, declare `resources` quando houver recursos HTTPS adicionais. Todas as URLs devem ser canônicas e aprovadas. Habilite `allowBrowserless: true` na tarefa se ela puder usar o serviço quando o Chromium do runner estiver indisponível.

Para desafios reais, o resultado `challenge_requires_authorized_access` indica que é preciso obter uma rota aprovada pelo titular ou concluir a verificação manual. O fluxo mantém uma única tentativa em caso de desafio, 401, 403, 429 ou redirecionamento. A infraestrutura pode verificar a integração do seu site com Turnstile e reCAPTCHA v2 em uma página de teste com as chaves oficiais dos provedores.

## Testes

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npx --no-install playwright-core install --with-deps chromium
node src/cli.mjs direct-smoke
node src/cli.mjs api-smoke
node src/cli.mjs browser-smoke
npm run test:captcha -- --service-only
npm run test:captcha
```

`npm test` é determinístico e não usa Browserless. `npm run test:captcha` inicia uma página própria em localhost e consulta os serviços de teste oficiais. A opção `--service-only` valida as APIs Siteverify com dados de teste. O teste de widgets requer que o Chromium confie no certificado TLS dos provedores ou no certificado do proxy do runner. Use `CHROMIUM_EXECUTABLE_PATH` para um Chromium já instalado e, se o ambiente de execução exigir proxy, preserve suas variáveis de rede e habilite `NODE_USE_ENV_PROXY=1` antes de iniciar Node.

## Integração MCP

O Browserless hospeda um MCP autenticado para o Codex CLI e app. O Codex Cloud desta sessão alcançou o endpoint e recebeu HTTP 401, e a integração não estava registrada no ambiente. O fluxo Playwright via Actions mantém as opções de uso, a credencial e os limites no próprio repositório.

- [MCP Browserless para Codex](https://docs.browserless.io/mcp/clients/codex)
- [Consumo e Usage API do Browserless](https://docs.browserless.io/overview/unit-consumption)
- [Orçamentos no GitHub](https://docs.github.com/en/billing/how-tos/set-up-budgets)
- [Execução manual no GitHub Actions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [Chaves de teste do Turnstile](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
- [Chaves de teste do reCAPTCHA](https://developers.google.com/recaptcha/docs/faq/)
