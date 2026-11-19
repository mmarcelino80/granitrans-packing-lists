# Verificação visual da v0.1

final result: blocked

A revisão da identidade visual aguarda os ficheiros originais do logótipo e do ícone da aplicação. As imagens são visíveis na conversa. Os ficheiros não estavam disponíveis no ambiente de desenvolvimento. O cabeçalho mostra texto simples no desktop e apenas o título no telemóvel.

- **Desktop, 1448 × 1086.** Verifiquei a expedição e os materiais à esquerda, a pré-visualização em texto monoespaçado à direita e as ações por baixo do editor. Comparei os estados inicial e de demonstração com o mockup desktop. Os seletores começam desmarcados e a rota aparece após uma seleção.
- **Telemóvel, 393 × 852.** Verifiquei os cartões verticais, a grelha de destinos, a seleção de guias e os atalhos inferiores. A comparação usou o conteúdo da aplicação na referência, excluindo a moldura do dispositivo.
- **Validação funcional.** Os testes em Chromium abrangeram rato e toque, seleção e remoção de guias, edição e validação de materiais, exportação UTF-8, email preparado e a chamada de partilha com uma API simulada. Verifiquei seis larguras entre 320 e 1448 px e executei axe-core a 393 e 1448 px.
- **Manifesto.** O Chromium leu o manifesto e resolveu o identificador, o endereço de arranque e o âmbito para `/granitrans-packing-lists/`. A instalação em telemóvel aguarda a integração e validação do ícone.
- **Capturas da revisão.** O estado inicial e a demonstração aprovada foram capturados em Chromium com a configuração regional portuguesa. As imagens desta sessão estão em `/workspace/scratch/granitrans-review`, fora do repositório.
