# Testar a Granitrans v0.2 em privado no Windows

Comece por **Simulação**. A autenticação pode ser verificada separadamente. A **Extração real** fica reservada para um teste autorizado, com uma única guia fictícia por abertura. Esta preparação não inclui uma extração real.

## Instalar uma vez

1. Tenha o Microsoft Edge, o Git para Windows e o Python 3.10 ou posterior instalados. Recomenda-se Python 3.12 ou 3.13.
2. Se recebeu o pacote ZIP, extraia-o para uma pasta. Mantenha os ficheiros da pasta `tools` juntos e faça duplo clique em [Instalar Granitrans Teste.cmd](../tools/Instalar%20Granitrans%20Teste.cmd). A instalação descarrega a revisão aprovada e prepara as dependências do teste. Precisa de Internet nesta etapa.
3. Confirme no terminal que a preparação terminou. A instalação fixa a aplicação na revisão `2c1ac30`, na cópia isolada `%LOCALAPPDATA%\GranitransV02Teste\app-logistica`, e usa um ambiente Python próprio. Consulte o aviso do instalador se já existir uma cópia com alterações ou uma revisão diferente.

O instalador atua no seu computador. As configurações de GitHub Pages, Cloudflare Access e do Worker continuam a ser administradas pelo processo de publicação aprovado.

## Abrir a janela de teste

Faça duplo clique em [Abrir Granitrans Teste.cmd](../tools/Abrir%20Granitrans%20Teste.cmd) e escolha uma opção no terminal. Mantenha o terminal aberto enquanto usa a janela de teste.

| Opção | O que pode verificar | Acesso externo |
| --- | --- | --- |
| **1 — Simulação** | O fluxo de leitura fictícia, a revisão, as correções e a preparação do TXT. Prima Enter para escolher esta opção. | Os pedidos são servidos ou bloqueados localmente. |
| **2 — Autenticação** | Selecione **Verificar autenticação** na faixa de teste. Inicie sessão com um endereço autorizado e o PIN do Cloudflare Access. Confirme a mensagem «Identidade e sessão verificadas. Nenhuma guia foi enviada.». | A janela contacta o Worker e o Access. A extração fica bloqueada. |
| **3 — Extração real** | Depois de autorização, selecione um caso e escreva `EXTRAIR` no terminal. A janela anexa a guia escolhida. Confirme os destinos fictícios e selecione **Analisar guias**. | A janela permite um único pedido de extração real por abertura. O pedido pode consumir quota e ter custo. |

A janela temporária apresenta a faixa **Granitrans v0.2 — Ambiente de testes**, seguida do modo selecionado. O endereço mostrado é `https://mmarcelino80.github.io/granitrans-packing-lists/`. Só nessa sessão do navegador a aplicação vem da cópia local, com a origem HTTPS que o Worker admite. Os pedidos autorizados ao Worker e ao Access seguem para os serviços reais, com TLS e as respetivas políticas de acesso. Use o PIN diretamente na janela Cloudflare.

A opção **Extração real** precisa de uma autorização própria e de um Worker com extração e chave já configuradas. Escrever `EXTRAIR` habilita o envio daquela guia quando selecionar **Analisar guias**. O lançador verifica o formato, o tamanho e o hash do ficheiro selecionado, incluindo os bytes do pedido antes do envio.

## Plano de aceitação

Experimente primeiro os passos no modo de simulação. Comece com uma expedição vazia e anexe uma das três [guias fictícias incluídas](../tests/fixtures/gpt-6-luna/) em `%LOCALAPPDATA%\GranitransV02Teste\app-logistica\tests\fixtures\gpt-6-luna`. Compare os dados linha a linha com o [resultado esperado](../tests/fixtures/gpt-6-luna/expected.json). Registe um resultado por caso e por critério. A simulação valida a interface. A qualidade do modelo é avaliada quando executar o mesmo caso no modo de extração real autorizado.

| Caso | Destinos para a rota | O que verificar antes de corrigir |
| --- | --- | --- |
| **1 — foto-guia-espessura.png** | Braga → Negrais | Confirme a descarga física em Negrais e o destino final Loulé. O documento é em português. Confira as 3 chapas, os 12 mm na primeira linha e a ausência de espessura na segunda. |
| **2 — foto-guia-ilegivel.jpg** | Valence → Paris | Confirme o documento em português e francês. A quantidade tapada deve bloquear a aprovação. No desktop, consulte a guia, corrija o texto e confirme os avisos explicitamente. |
| **3 — guia-duas-paginas.pdf** | Coimbra → Santiago | Confira as duas páginas, os materiais destinados a Paris e Loulé e os totais documentais. O título e o texto de logística são em espanhol. |

No desktop, anexe os três ficheiros na mesma sessão e confira os três resultados independentes. Altere o texto de um resultado aprovado e verifique que a exportação fica bloqueada até voltar a aprovar. Compare o PDF com o texto final. No mobile, selecione Paris antes de analisar o JPG e confirme o aviso e a introdução bilingue.

## Registar tempo, resultado e custo

O terminal e o ficheiro local `%LOCALAPPDATA%\GranitransV02Teste\leituras.csv` registam o modo, a hora UTC, o caso fictício, o estado e a duração de `/extract`, incluindo o envio e a receção. O tempo de login fica fora dessa medição. Registe separadamente o resultado da conferência de cada caso. Guarde apenas o código do caso, o tempo, a contagem de critérios cumpridos e os nomes dos campos que precisam de revisão.

Para uma extração real autorizada, use o painel **Usage** da OpenAI na conta do projeto Granitrans. Filtre pelo projeto, pelo modelo `gpt-6-luna` e pelo período UTC do ensaio. Registe os totais de pedidos, tokens de entrada e saída e custo apresentado. Os tokens de raciocínio já contam na saída. Se o painel agregar vários pedidos no mesmo período, registe o total agregado e a contagem de pedidos. Associe um valor a uma guia apenas quando a janela de medição separar esse pedido. Mantenha os tempos do navegador separados do custo da API. [Painel de utilização da OpenAI API](https://help.openai.com/en/articles/10478918-api-usage-dashboard)

Guarde o CSV e as notas de aceitação no computador. Nas partilhas, limite-se a resultados agregados e identificadores de casos fictícios. Introduza os PINs na janela Cloudflare e mantenha os dados de sessão e documentos fora dos registos. Feche a janela de teste e o terminal no fim da sessão.
