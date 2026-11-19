# Ativar a leitura de guias com IA

A aplicação estática continua no GitHub Pages. A leitura de guias é opcional e requer um Cloudflare Worker, Cloudflare Access e um projeto OpenAI API. A configuração entregue mantém a leitura desativada. Os passos seguintes destinam-se a quem administra estas contas.

## 1. Preparar os acessos

- **Cloudflare**. Use uma conta com permissões para Workers, Durable Objects e Zero Trust. Escolha um subdomínio dedicado numa zona ativa na Cloudflare, como `packing-api.example.com`.
- **GitHub Pages**. Anote o endereço da aplicação e a sua origem exata. Para `https://mmarcelino80.github.io/granitrans-packing-lists/`, a origem é `https://mmarcelino80.github.io`. Se o Pages usar domínio próprio, use a origem que aparece no navegador. Os projetos servidos no mesmo hostname partilham a mesma origem mesmo que tenham caminhos distintos.
- **Utilizadores**. Defina um ou dois endereços de email autorizados pela Granitrans. Use os mesmos endereços no Access e na variável privada `ALLOWED_EMAILS`.
- **OpenAI**. Crie um projeto API dedicado, confirme a faturação e crie uma chave desse projeto com acesso à API Responses. Um plano ChatGPT e a faturação da API são geridos separadamente. Guarde a chave no gestor de segredos usado pela equipa. [Projetos da API OpenAI](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects)

## 2. Criar a aplicação Cloudflare Access

1. No painel **Zero Trust**, abra **Access controls → Applications → Add an application → Self-hosted**.
2. Adicione o hostname público dedicado e use o caminho exato `/auth`. Mantenha `/extract` fora desta política de caminho para o navegador poder fazer o preflight CORS. O Worker valida o token de sessão em cada pedido a `/extract`.
3. Crie uma política **Allow** com a regra **Include → Emails** limitada aos endereços da equipa. Selecione o método de início de sessão pretendido. O **One-time PIN** permite validar o email dos utilizadores através de um código enviado pela Cloudflare.
4. Nas definições da aplicação Access, copie o **Application Audience (AUD)**. Anote também o domínio da equipa no formato `nome-da-equipa.cloudflareaccess.com`.

A proteção segue o caminho definido na aplicação Access. Use o hostname dedicado na configuração do Worker e mantenha os endereços `workers.dev` e de pré-visualização desativados. [Caminhos no Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) · [One-time PIN](https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/one-time-pin/)

## 3. Configurar o Worker com a extração desativada

1. Abra `worker/wrangler.toml`. Mantenha `EXTRACTION_ENABLED` a `"false"`. Preencha `APP_ORIGIN`, `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD`. Use o hostname da equipa sem prefixo `https://` em `ACCESS_TEAM_DOMAIN`. A origem do Pages deve incluir o esquema `https://` e excluir caminho e barra final.
2. Mantenha a configuração do Durable Object de quotas incluída no ficheiro. Os valores iniciais são 10 pedidos de extração por utilizador e 20 no total por dia. Ajuste `QUOTA_PER_USER_DAILY` e `QUOTA_GLOBAL_DAILY` de acordo com o volume autorizado.
3. Com Node.js instalado, instale as dependências do Worker, autentique a CLI Wrangler na conta certa e publique a configuração inicial do Worker. Associe o hostname dedicado em **Workers & Pages → Worker → Settings → Domains & Routes → Add → Custom Domain**.

Na raiz do repositório, execute os comandos seguintes para a publicação manual do Worker.

```sh
npm ci --prefix worker
npm --prefix worker run build
npx wrangler@4 login
npx wrangler@4 deploy --config worker/wrangler.toml
```

O Durable Object é criado pela migração incluída no ficheiro. O domínio personalizado usa HTTPS gerido pela Cloudflare. [Domínios de Workers](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) · [CLI Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

## 4. Guardar os segredos

Execute um comando de cada vez e forneça o valor no pedido interativo. A lista de emails é separada por vírgulas. Para `SESSION_SECRET`, gere 32 bytes aleatórios ou mais num gestor de segredos e use a sua representação em hexadecimal.

```sh
npx wrangler@4 secret put OPENAI_API_KEY --config worker/wrangler.toml
npx wrangler@4 secret put SESSION_SECRET --config worker/wrangler.toml
npx wrangler@4 secret put ALLOWED_EMAILS --config worker/wrangler.toml
```

Mantenha a chave, o segredo de assinatura e os endereços autorizados fora do HTML, de `extraction-config.mjs`, do Git e das mensagens. [Segredos do Cloudflare Worker](https://developers.cloudflare.com/workers/configuration/secrets/)

## 5. Testar e ativar manualmente

1. **Localmente.** Execute `node --test` e os testes Playwright indicados no README. Os testes simulam os fornecedores e usam dados fictícios.
2. **Antes de autorizar a leitura.** Aceda a `https://packing-api.example.com/auth` em janela privada e confirme que o Access apresenta autenticação. Teste um endereço fora da lista e confirme a recusa. Estes passos dispensam pedidos à OpenAI.
3. **Worker.** Depois de rever a configuração, altere `EXTRACTION_ENABLED` para `"true"` e repita `npx wrangler@4 deploy --config worker/wrangler.toml`.
4. **Ligação.** Antes de apontar a interface ao Worker, teste o preflight a partir da origem do Pages. Confirme `204` e `Access-Control-Allow-Origin` igual à origem configurada. Repita com uma origem diferente e confirme a recusa. O teste CORS não envia guias nem usa a OpenAI.
5. **Pages.** Defina `extractionWorkerUrl` em `extraction-config.mjs` com a origem do Worker, por exemplo `https://packing-api.example.com`, e faça passar essa mudança pelo processo de publicação aprovado para o GitHub Pages.
6. **Primeira leitura.** Com um endereço autorizado, abra o Pages, selecione a rota e anexe uma guia fictícia pequena. Escolha **Analisar guias** e autorize a sessão na janela Access. Verifique que o resultado aparece para revisão, que as linhas podem ser corrigidas e que só as linhas aceites passam para a expedição. Confirme que o TXT continua a exigir aprovação depois da revisão. Este teste usa a API e consome uma chamada.
7. **Falhas e recuperação.** Confirme que cancelar a autenticação mantém a edição manual disponível. Teste um ficheiro com tipo inválido ou acima de 10 MiB. Confira a resposta ao limite diário num ambiente de testes com quotas reduzidas, caso precise de a validar.

Pode testar o preflight com este comando, substituindo o hostname do Worker e a origem se forem diferentes.

```sh
curl -i -X OPTIONS 'https://packing-api.example.com/extract' \
  -H 'Origin: https://mmarcelino80.github.io' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type,x-guide-name,x-guide-request'
```

Se a janela mostrar erro de login ou for bloqueada, permita janelas deste site e verifique o hostname, o AUD e a política de emails. Se a leitura falhar após login, confirme `APP_ORIGIN`, a configuração do Worker e a disponibilidade do projeto OpenAI. Uma indicação de quota significa que há de esperar pelo próximo dia UTC ou continuar a editar manualmente. Evite repetir uma leitura sem necessidade, pois os pedidos admitidos contam para a quota.

Para parar a leitura, publique o Worker com `EXTRACTION_ENABLED="false"` e retire o endereço de `extraction-config.mjs` na próxima atualização do Pages. Para remover um utilizador, atualize a política Access e a lista privada. Alterar `SESSION_SECRET` invalida os tokens já emitidos.

## Recuperar um lote após uma falha

1. Ao regressar do login, confirme a lista de anexos. A aplicação verifica a seleção antes de cada envio. As guias removidas antes do início do pedido ficam fora do lote. Retirar uma guia depois de o pedido começar não recolhe os dados já enviados. Para incluir guias anexadas depois de iniciar a análise, selecione **Analisar guias** novamente.
2. Se parte do lote falhar, mantenha o separador aberto. As guias concluídas ficam na revisão. Pode corrigir ou excluir linhas durante a espera. Ao selecionar **Analisar guias** para repetir, só seguem as guias por concluir. As novas linhas são acrescentadas à revisão com as correções e confirmações anteriores preservadas.
3. Se perder a ligação ou receber uma resposta inconclusiva, a aplicação reutiliza o identificador reservado à tentativa durante a janela segura de 24 horas. O Worker recusa uma tentativa já admitida sem gastar mais quota nem repetir o pedido à OpenAI. O Worker não guarda o resultado para o reenviar. Após essa recusa ou após o fim da janela segura, a aplicação deixa de reenviar a guia nessa sessão. Use **Conferir guias manualmente** para resolver as guias por concluir e mantenha as linhas já recebidas.
4. Após uma rejeição explícita da OpenAI ou uma resposta sem extração utilizável, pode repetir a guia numa nova tentativa. A admissão dessa tentativa pode consumir quota. Se o login expirar antes de o Worker aceitar a repetição, volte a autenticar-se. A aplicação conserva o identificador, porque a expiração da sessão não confirma o resultado de um envio anterior. A aprovação e a importação dos resultados ficam bloqueadas até concluir a análise ou confirmar a conferência manual das guias pendentes.

Os resultados locais e as correções mantêm-se até fechar ou recarregar o separador. Separadores diferentes mantêm sessões e identificadores de tentativa independentes. A proteção do Worker destina-se à repetição da mesma tentativa.

## Tratamento dos ficheiros

Ao selecionar **Analisar guias**, as guias novas são enviadas para o Worker e para a API OpenAI. As cópias idênticas e as guias já importadas na sessão são ignoradas. A sessão de extração dura até 15 minutos e o navegador mantém o respetivo token em memória. Cada análise aceita até cinco guias. O Worker verifica o tipo de ficheiro, limita cada guia a 10 MiB e cada PDF a 10 páginas, mantém as contagens da quota no Durable Object e envia o pedido à API Responses com `store: false` e um máximo de 12 000 tokens de saída por guia. Os resultados permanecem em revisão até o utilizador confirmar as linhas.

O Worker processa os ficheiros em memória. A compilação remove chamadas de consola e a observabilidade está desativada. O Durable Object guarda as contagens diárias e identificadores derivados por hash de contas e tentativas admitidas. A proteção contra repetições abrange o dia UTC corrente e o anterior, e os registos mais antigos são substituídos quando é admitida uma nova tentativa. Os ficheiros e resultados de análise não são guardados no Worker. As imagens estão limitadas a 12 000 píxeis por lado e 36 megapíxeis.

A opção `store: false` controla o armazenamento do estado da resposta pela API. A retenção aplicável a monitorização de abuso e outros tratamentos segue o contrato e as definições do projeto OpenAI. Confirme as condições da Granitrans antes de usar guias comerciais. [Controlos de dados da API OpenAI](https://platform.openai.com/docs/guides/your-data) · [Envio de PDFs](https://platform.openai.com/docs/guides/pdf-files)

## Custos e limites

- **OpenAI.** A leitura usa o snapshot `gpt-4.1-mini-2025-04-14`, escolhido pelo custo, pelo suporte a imagens e PDFs e pelas saídas estruturadas. As fotografias são analisadas em alta resolução e a revisão humana continua obrigatória. Os preços de referência da família são USD 0,40 por milhão de tokens de entrada e USD 1,60 por milhão de tokens de saída, com tarifa separada para entrada em cache. Uma guia hipotética com 8 000 tokens de entrada e 1 000 de saída custaria cerca de USD 0,0048. A 20 guias iguais por dia durante 30 dias, seriam cerca de USD 2,88 de API. O custo real varia com tamanho, resolução, páginas, conteúdo e resposta. Consulte os valores atuais antes da ativação. [Preços da API OpenAI](https://openai.com/api/pricing/) · [Modelo GPT-4.1 mini](https://platform.openai.com/docs/models/gpt-4.1-mini)
- **Cloudflare.** A Cloudflare disponibiliza planos Free para Zero Trust e Workers. A utilização de Workers e de Durable Objects com SQLite pode caber nas franquias gratuitas; verifique especialmente o limite de CPU por pedido com imagens e PDFs maiores. Workers Paid começa em USD 5 por mês, com franquias e cobrança adicional por uso. O domínio próprio pode ter um custo separado. [Cloudflare Zero Trust](https://www.cloudflare.com/plans/zero-trust-services/) · [Preços dos Workers](https://developers.cloudflare.com/workers/platform/pricing/) · [Preços dos Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- **Controlo.** A quota atómica no Worker limita o número de guias admitidas, com reposição às 00:00 UTC. O orçamento do projeto OpenAI serve para alertas de consumo. Verifique o consumo após os primeiros testes e ajuste os limites ao volume real. [Orçamento do projeto OpenAI](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects)
