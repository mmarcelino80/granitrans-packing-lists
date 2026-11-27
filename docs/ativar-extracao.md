# Ativar a leitura de guias com IA

A aplicação estática continua no GitHub Pages. A leitura de guias é opcional e requer um Cloudflare Worker, Cloudflare Access e um projeto OpenAI API. A configuração entregue mantém a leitura desativada. Os passos seguintes destinam-se a quem administra estas contas.

## 1. Preparar os acessos

- **Cloudflare**. Use a conta do Worker existente `granitrans-packing-list-extraction`, com permissões para Workers, Durable Objects e Zero Trust. O endereço é `https://granitrans-packing-list-extraction.mmarcelino-pt.workers.dev`. Este fluxo usa o subdomínio `workers.dev` disponível na conta. [Endereços workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- **GitHub Pages**. Para `https://mmarcelino80.github.io/granitrans-packing-lists/`, a origem exata é `https://mmarcelino80.github.io`. Os projetos servidos no mesmo hostname partilham a mesma origem mesmo que tenham caminhos distintos.
- **Utilizadores**. Defina um ou dois endereços de email autorizados pela Granitrans. Use os mesmos endereços no Access e no segredo `ALLOWED_EMAILS`.

## 2. Rever o Cloudflare Access no Worker existente

1. No painel **Cloudflare → Workers & Pages**, selecione **granitrans-packing-list-extraction → Access**. Confirme a proteção de **All traffic** deste Worker, que abrange todos os caminhos no hostname `workers.dev`. Se precisar de a configurar, selecione **Protect this Worker behind Access → All traffic** e aplique a política da Granitrans.
2. Em **Zero Trust → Access controls → Applications**, edite a aplicação Access deste Worker da Granitrans. Use uma política **Allow → Include → Emails** limitada aos endereços da equipa. As políticas Allow são alternativas, pelo que outras regras que permitam toda a conta ou um domínio de email também concederiam acesso. Confirme que `/auth`, `/session-check` e `/extract` ficam sob a mesma aplicação Access e partilham o mesmo AUD. Uma aplicação específica por caminho tem precedência sobre a proteção do Worker. Limite as alterações ao Worker da Granitrans e à sua aplicação Access individual.
3. Se o **One-time PIN** ainda não estiver disponível, pode adicionar o método em **Zero Trust → Integrations → Identity providers → Add new identity provider → One-time PIN**. Selecione **One-time PIN** como método de login na aplicação Access da Granitrans. [Configurar o One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
4. Em **Zero Trust → Access controls → Applications → Edit → Additional settings**, copie **Application Audience (AUD) Tag** da aplicação que protege este Worker. Anote o domínio da equipa no formato `nome-da-equipa.cloudflareaccess.com`. [Localizar o AUD](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag)

A proteção aplica-se a `/auth`, `/session-check` e `/extract`. A aplicação do GitHub Pages abre uma janela no domínio do Worker para o login. A janela envia os ficheiros ao Worker na sua própria origem, com o cookie Access, e devolve o resultado à origem Pages autorizada. O JWT Access e o token de sessão de até 15 minutos têm de corresponder à mesma identidade em cada pedido de confirmação de sessão ou extração. O token de sessão fica na memória da janela. O fluxo funciona sem cookies de terceiros. [Cloudflare Access em Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

## 3. Preparar a configuração no Windows

Abra o PowerShell na raiz da cópia local do repositório. Tenha o Git para Windows e o Node.js 24 LTS com npm, ou uma versão LTS mais recente suportada pelo Wrangler. Confirme também que tem acesso à conta Cloudflare do Worker da Granitrans. [Git para Windows](https://git-scm.com/install/windows) · [Node.js](https://nodejs.org/en/download)

```powershell
Set-Location 'C:\caminho\granitrans-packing-lists'
git.exe --version
node.exe --version
npm.cmd --version
npx.cmd --version
```

O modelo público `worker/wrangler.toml` tem `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` vazios. Copie-o para `worker/wrangler.local.toml`, que o Git ignora. Se a cópia privada já existir, reveja-a e aplique as definições abaixo. O comando conserva uma cópia existente.

```powershell
if (-not (Test-Path -LiteralPath '.\worker\wrangler.local.toml')) {
  Copy-Item -LiteralPath '.\worker\wrangler.toml' -Destination '.\worker\wrangler.local.toml'
}
git.exe check-ignore 'worker/wrangler.local.toml'
if ($LASTEXITCODE -ne 0) { throw 'O Git tem de ignorar worker/wrangler.local.toml antes de o preencher.' }
notepad.exe '.\worker\wrangler.local.toml'
```

1. Preencha `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` apenas na cópia privada, com o domínio da equipa e o AUD da Granitrans. Use o hostname da equipa sem o prefixo `https://`.
2. Confirme as origens públicas `APP_ORIGIN = "https://mmarcelino80.github.io"` e `WORKER_ORIGIN = "https://granitrans-packing-list-extraction.mmarcelino-pt.workers.dev"`. As origens incluem `https://` e excluem caminho e barra final.
3. Confirme `name = "granitrans-packing-list-extraction"`, `workers_dev = true`, `preview_urls = false`, `EXTRACTION_ENABLED = "false"` e as opções que desativam a observabilidade e os registos de invocação.
4. Mantenha o Durable Object SQLite e as quotas de 25 pedidos por utilizador e 50 no total por dia UTC, definidas por `QUOTA_PER_USER_DAILY` e `QUOTA_GLOBAL_DAILY`. Estes são os limites máximos. Pode configurar valores inferiores.

Instale, teste e compile localmente no PowerShell.

```powershell
npm.cmd ci --prefix worker
if ($LASTEXITCODE -ne 0) { throw 'A instalação das dependências do Worker falhou.' }
npm.cmd --prefix worker test
if ($LASTEXITCODE -ne 0) { throw 'Os testes do Worker falharam.' }
npm.cmd --prefix worker run test:runtime
if ($LASTEXITCODE -ne 0) { throw 'O teste Workerd falhou.' }
npm.cmd --prefix worker run build
if ($LASTEXITCODE -ne 0) { throw 'A compilação do Worker falhou.' }
```

O teste Workerd usa um serviço de respostas fictícias no próprio processo. Reproduz a incompatibilidade da opção de redirecionamento anterior, verifica a sessão com extração desativada e confirma que o Worker recusa redirecionamentos do JWKS e da OpenAI. Corre localmente, sem segredos de produção, contas Cloudflare ou pedidos externos. No Windows, use a versão x64 dos pré-requisitos. [Plataformas Workerd](https://github.com/cloudflare/workerd#running-workerd)

## 4. Instalar o Worker após aprovação da publicação

Use exclusivamente `worker/wrangler.local.toml` nos comandos Wrangler, com a extração desativada. Autentique-se e confirme que a conta apresentada é a do Worker existente antes de publicar.

```powershell
npx.cmd --yes wrangler@4 login --config worker/wrangler.local.toml
npx.cmd --yes wrangler@4 whoami --config worker/wrangler.local.toml
```

```powershell
npx.cmd --yes wrangler@4 deploy --config worker/wrangler.local.toml
```

A migração configura o Durable Object SQLite quando necessário. Confirme no painel o nome do Worker, o hostname e a proteção Access da Granitrans. [CLI Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

Para criar `SESSION_SECRET`, gere 32 bytes aleatórios com o Node.js e envie a representação hexadecimal diretamente ao Wrangler pela entrada padrão. Isso mantém o valor fora do ecrã e do histórico de comandos. Se já existir um segredo válido, reutilize-o. A sua substituição termina as sessões emitidas anteriormente.

```powershell
node.exe -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | npx.cmd --yes wrangler@4 secret put SESSION_SECRET --config worker/wrangler.local.toml
```

Defina `ALLOWED_EMAILS` no pedido interativo seguinte, com um ou dois endereços autorizados separados por vírgula. Use os mesmos endereços da política Access da Granitrans.

```powershell
npx.cmd --yes wrangler@4 secret put ALLOWED_EMAILS --config worker/wrangler.local.toml
```

Para esta instalação, bastam os dois segredos acima. A chave OpenAI só será necessária na etapa de ativação. [Segredos do Cloudflare Worker](https://developers.cloudflare.com/workers/configuration/secrets/)

## 5. Verificar a sessão sem enviar guias

1. **Localmente.** Execute os testes Node e Workerd da secção 3, `node.exe --test` e os testes Playwright indicados no README. Os testes locais simulam os fornecedores e usam dados fictícios.
2. **Acesso permitido.** Com `EXTRACTION_ENABLED = "false"`, abra [a página de verificação do Worker](https://granitrans-packing-list-extraction.mmarcelino-pt.workers.dev/auth) numa janela privada. Use um email autorizado e introduza o PIN recebido. O Worker responde ao `POST /session-check` da janela com HTTP 200 e `{"authenticated":true}`. Confirme a mensagem «Identidade e sessão verificadas. Nenhuma guia foi enviada.». Esta verificação dispensa a OpenAI e a quota de guias.
3. **Acesso recusado.** Feche todas as janelas privadas, volte a abrir uma e teste um endereço fora da lista a que tenha acesso. A Cloudflare pode mostrar «A code has been emailed to you» mesmo quando não envia PIN. Confirme que o endereço não recebe PIN e não chega à página de verificação. Em **Zero Trust → Insights → Logs → Access authentication logs**, confirme a aplicação, o email e a política para a autenticação bem-sucedida. O Access regista a tentativa com One-time PIN depois da submissão de um código, pelo que um endereço bloqueado sem PIN pode não aparecer nessa lista. [Comportamento do One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/#log-in-with-otp) · [Registos de autenticação Access](https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/access-authentication-logs/)

O bloqueio de `favicon.ico` é esperado com a CSP restritiva de `/auth`. Para verificar a autenticação, confirme o POST a `/session-check` e a mensagem final da página.

Se `/auth` devolver 503, anote apenas o campo fixo `code` da resposta. Use-o para identificar a etapa antes de alterar a configuração.

| Código | Etapa a verificar |
| --- | --- |
| `app_origin_invalid`, `worker_origin_invalid`, `access_config_invalid` | Origens HTTPS, domínio do Access e AUD na configuração local. |
| `access_jwks_transport`, `access_jwks_http`, `access_jwks_redirect`, `access_jwks_invalid` | Consulta do JWKS pelo Worker, estado HTTP, redirecionamento ou formato JSON. |
| `access_rsa_import_failed`, `access_rsa_verify_failed` | Importação ou verificação RSA. |
| `access_allowlist_invalid` | Formato de `ALLOWED_EMAILS` na versão ativa. |
| `session_secret_invalid`, `session_crypto_failed` | Disponibilidade do segredo ou operação criptográfica da sessão. |

### Verificação CORS opcional

Mantenha **Bypass options requests to origin** desativado para a janela autenticada. Se precisar de testar ou suportar preflight CORS, vá a **Zero Trust → Access controls → Applications → Edit → Advanced settings → Cross-Origin Resource Sharing (CORS) settings** na aplicação da Granitrans. Ative **Bypass options requests to origin** e selecione **Save**. A opção substitui as configurações CORS existentes no Access e encaminha exclusivamente o preflight `OPTIONS` para o Worker. O `POST /extract` continua protegido pelo Access e pelo Worker, que exige o token de sessão e o JWT Cloudflare da mesma conta. [CORS no Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/#bypass-options-requests-to-origin)

Com a opção ativa, teste a origem Pages e uma origem diferente. Os comandos seguintes verificam o preflight sem enviar guias ou consumir quota.

```powershell
curl.exe -i -X OPTIONS 'https://granitrans-packing-list-extraction.mmarcelino-pt.workers.dev/extract' `
  -H 'Origin: https://mmarcelino80.github.io' `
  -H 'Access-Control-Request-Method: POST' `
  -H 'Access-Control-Request-Headers: authorization,content-type,x-guide-name,x-guide-request'

curl.exe -i -X OPTIONS 'https://granitrans-packing-list-extraction.mmarcelino-pt.workers.dev/extract' `
  -H 'Origin: https://outro.example' `
  -H 'Access-Control-Request-Method: POST' `
  -H 'Access-Control-Request-Headers: authorization,content-type,x-guide-name,x-guide-request'
```

- Para a origem Pages, confirme HTTP 204, `Access-Control-Allow-Origin: https://mmarcelino80.github.io` e `Access-Control-Allow-Credentials: true`.
- Para a outra origem, confirme HTTP 403 sem `Access-Control-Allow-Origin` nem `Access-Control-Allow-Credentials`.

Um preflight 204 verifica a aprovação CORS. Um `POST` entre sites ainda depende do cookie Access e das definições de privacidade do navegador. A janela autenticada evita essa dependência. [Cookies de autorização Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/#allow-third-party-cookies-in-the-browser)

## 6. Ativar a extração numa etapa posterior

Execute esta etapa quando for aprovada a ligação à API OpenAI. Use o projeto Granitrans, autorizado exclusivamente para `gpt-6-luna`. Confirme a faturação, o saldo e as condições dos créditos associados à subscrição do ChatGPT. A aplicação pode usar a faturação normal da API quando esses créditos terminarem. Guarde a chave no gestor de segredos e forneça-a apenas no pedido interativo do Wrangler. [Projetos da API OpenAI](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects)

```powershell
npx.cmd --yes wrangler@4 secret put OPENAI_API_KEY --config worker/wrangler.local.toml
```

1. Altere `EXTRACTION_ENABLED` para `"true"` em `worker/wrangler.local.toml` e publique com `npx.cmd --yes wrangler@4 deploy --config worker/wrangler.local.toml`.
2. No GitHub Pages, defina `extractionWorkerUrl` em `extraction-config.mjs` como `https://granitrans-packing-list-extraction.mmarcelino-pt.workers.dev`. Faça passar essa mudança pelo processo de publicação aprovado.
3. **Primeira leitura.** Com um endereço autorizado, abra o Pages, selecione a rota e teste as [guias fictícias de avaliação](../tests/fixtures/gpt-6-luna/) em JPG, PNG e PDF multipágina. Escolha **Analisar guias**, autorize a sessão e mantenha a janela Access aberta ao regressar à aplicação. Compare cada página, linha, total e aviso com o [resultado esperado](../tests/fixtures/gpt-6-luna/expected.json). Confirme que só as linhas aceites passam para a expedição e que o TXT continua a exigir aprovação. Registe a latência e os tokens usados. Cada guia enviada neste teste usa a API e pode ter custo.
4. **Falhas e recuperação.** Confirme em computador e telemóvel que cancelar a autenticação mantém a edição manual disponível. Teste o aviso se o navegador bloquear a janela ou a sessão expirar. Teste um ficheiro com tipo inválido ou acima de 10 MiB. Confira a resposta ao limite diário num ambiente de testes com quotas reduzidas, caso precise de a validar.

Se o login falhar, verifique o hostname, o AUD e a política de emails. Se a leitura falhar após o login, confirme `APP_ORIGIN`, `WORKER_ORIGIN`, a configuração do Worker e a disponibilidade do projeto OpenAI. Uma indicação de quota significa que pode voltar a tentar no próximo dia UTC ou continuar a editar manualmente. Os pedidos admitidos contam para a quota.

Para parar a leitura, coloque `EXTRACTION_ENABLED = "false"` em `worker/wrangler.local.toml`, publique com `npx.cmd --yes wrangler@4 deploy --config worker/wrangler.local.toml` e retire o endereço de `extraction-config.mjs` na próxima atualização do Pages. Para remover um utilizador, atualize a política Access e a lista privada. Alterar `SESSION_SECRET` invalida os tokens já emitidos.

## Recuperar um lote após uma falha

1. Ao regressar do login, confirme a lista de anexos. A aplicação verifica a seleção antes de cada envio. As guias removidas antes do início do pedido ficam fora do lote. Retirar uma guia depois de o pedido começar não recolhe os dados já enviados. Para incluir guias anexadas depois de iniciar a análise, selecione **Analisar guias** novamente.
2. Se parte do lote falhar, mantenha o separador aberto. As guias concluídas ficam na revisão. Pode corrigir ou excluir linhas durante a espera. Ao selecionar **Analisar guias** para repetir, só seguem as guias por concluir. As novas linhas são acrescentadas à revisão com as correções e confirmações anteriores preservadas.
3. Se perder a ligação ou receber uma resposta inconclusiva, a aplicação reutiliza o identificador reservado à tentativa durante a janela segura de 24 horas. O Worker recusa uma tentativa já admitida sem gastar mais quota nem repetir o pedido à OpenAI. O Worker não guarda o resultado para o reenviar. Após essa recusa ou após o fim da janela segura, a aplicação deixa de reenviar a guia nessa sessão. Use **Conferir guias manualmente** para resolver as guias por concluir e mantenha as linhas já recebidas.
4. Após uma rejeição explícita da OpenAI ou um erro de validação do resultado, pode repetir a guia numa nova tentativa. A admissão dessa tentativa pode consumir quota. Se o modelo atingir o limite de saída, divida o documento ou escolha a conferência manual. A aplicação rejeita mesmo um JSON parcial válido. Se o login expirar antes de o Worker aceitar a repetição, volte a autenticar-se. A aplicação conserva o identificador, porque a expiração da sessão não confirma o resultado de um envio anterior. A aprovação e a importação dos resultados ficam bloqueadas até concluir a análise ou confirmar a conferência manual das guias pendentes.

Os resultados locais e as correções mantêm-se até fechar ou recarregar o separador. Separadores diferentes mantêm sessões e identificadores de tentativa independentes. A proteção do Worker destina-se à repetição da mesma tentativa.

## Tratamento dos ficheiros

Ao selecionar **Analisar guias**, as guias novas são enviadas para o Worker e para a API OpenAI. As cópias idênticas e as guias já importadas na sessão são ignoradas. A sessão de extração dura até 15 minutos e a janela autenticada mantém o respetivo token em memória. Cada análise aceita até cinco guias. O Worker verifica o tipo de ficheiro, limita cada guia a 10 MiB e cada PDF a 10 páginas, mantém as contagens da quota no Durable Object e envia o pedido à Responses API com `store: false` e um máximo de 12 000 tokens de saída por guia, incluindo raciocínio. O limite do pedido à OpenAI é de 45 segundos e a aplicação aguarda até 55 segundos pela resposta da janela. Os resultados permanecem em revisão até o utilizador confirmar as linhas.

O Worker processa os ficheiros em memória. A compilação remove chamadas de consola e a observabilidade está desativada. O Durable Object guarda as contagens diárias e identificadores derivados por hash de contas e tentativas admitidas. A proteção contra repetições abrange o dia UTC corrente e o anterior, e os registos mais antigos são substituídos quando é admitida uma nova tentativa. Os ficheiros e resultados de análise não são guardados no Worker. As imagens estão limitadas a 12 000 píxeis por lado e 36 megapíxeis.

A opção `store: false` controla o armazenamento do estado da resposta pela API. A retenção aplicável a monitorização de abuso e outros tratamentos segue o contrato e as definições do projeto OpenAI. Confirme as condições da Granitrans antes de usar guias comerciais. [Controlos de dados da API OpenAI](https://platform.openai.com/docs/guides/your-data) · [Envio de PDFs](https://platform.openai.com/docs/guides/pdf-files)

## Custos e limites

- **Modelo.** O Worker usa exclusivamente `gpt-6-luna` com Structured Outputs e validação JSON local. A desativação de `gpt-4.1-mini-2025-04-14` está anunciada para 14 de janeiro de 2027. O esforço `medium` dá margem para associar linhas, páginas e totais em guias densas. As fotografias usam `detail: "original"` para conservar texto pequeno. Os PDFs multipágina seguem como `input_file` e cada página tem de surgir na resposta. A instrução de extração ignora a coluna «Esp» e exige que a espessura venha da descrição do artigo. Avalie `low` apenas depois de medir qualidade, consumo e latência com as mesmas guias. [Modelo GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) · [Descontinuações](https://developers.openai.com/api/docs/deprecations) · [Aviso no SDK da OpenAI](https://github.com/openai/openai-node/blob/master/src/resources/shared.ts#L56-L60)
- **OpenAI.** A tabela padrão da ficha oficial, confirmada pela Granitrans em 26 de novembro de 2026, indica USD 0,10 por milhão de tokens de entrada, USD 0,01 por milhão de tokens de entrada em cache, USD 0,125 por milhão em escritas de cache e USD 0,50 por milhão de saída. Os tokens de raciocínio contam como saída e já estão incluídos em `usage.output_tokens`. Uma guia hipotética com 8 000 tokens de entrada sem cache e 3 000 de saída (1 000 de JSON e 2 000 de raciocínio) custaria cerca de USD 0,0023. A 50 guias por dia durante 30 dias, seriam 1 500 guias e cerca de USD 3,45 de API, antes de créditos ou impostos. O custo real varia com o tamanho, a resolução, as páginas, o conteúdo e o raciocínio. [Modelo e preços GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) · [Tokens de raciocínio](https://developers.openai.com/api/docs/guides/reasoning)
- **Cloudflare.** A Cloudflare disponibiliza planos Free para Zero Trust e Workers. Workers Free inclui 100 000 pedidos diários por conta e até 10 ms de CPU por invocação. Os Durable Objects SQLite incluem 100 000 pedidos e 13 000 GB-s por dia, 5 milhões de leituras e 100 000 escritas de linhas por dia e 5 GB de armazenamento. Os limites diários repõem-se às 00:00 UTC e, quando atingidos, as operações afetadas devolvem erro. Meça o desempenho de imagens e PDFs representativos antes de ativar para uso comercial, pois a quota de guias não garante que caibam em 10 ms de CPU. Workers Paid começa em USD 5 por mês, com franquias e cobrança adicional por uso. [Cloudflare Zero Trust](https://www.cloudflare.com/plans/zero-trust-services/) · [Preços dos Workers](https://developers.cloudflare.com/workers/platform/pricing/) · [Preços dos Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- **Controlo.** A quota atómica no Worker limita o número de guias admitidas, com reposição às 00:00 UTC. O orçamento do projeto OpenAI serve para alertas de consumo. Verifique o consumo após os primeiros testes e ajuste os limites ao volume real. [Orçamento do projeto OpenAI](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects)
