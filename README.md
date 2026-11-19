# Granitrans — Packing List v0.1

Aplicação web para preparar, conferir e exportar packing lists para os armazéns em França. Usa HTML, CSS e JavaScript, com ícones servidos localmente. Requer um navegador moderno.

## Pré-visualizar

A partir do diretório que contém a pasta `granitrans-packing-lists`, execute:

```sh
python3 -m http.server 8000
```

Abra `http://localhost:8000/granitrans-packing-lists/`. Se a cópia local tiver outro nome, use esse nome no endereço. Os caminhos relativos também permitem servir o projeto em `/granitrans-packing-lists/` no GitHub Pages.

## Preparar uma expedição

1. Confirme a data de carregamento. Toque nos destinos pela ordem da rota. Pode retirar um destino e voltar a selecioná-lo para o colocar no fim. Use **Outro destino/armazém** para introduzir os nomes adicionais.
2. Selecione guias JPG, PNG ou PDF, ou fotografe cada guia com a opção **Fotografar guia**. Pode remover ficheiros antes de exportar. As guias ficam na memória do separador durante a sessão.
3. Adicione os materiais no cartão de cada destino. Registe as designações, acabamentos, referências e observações nos campos correspondentes. A revisão mostra totais separados por unidade. No TXT, só são somadas linhas com o mesmo destino, unidade, descrição completa e observações.
4. Reveja a pré-visualização e selecione **Aprovar TXT**. Use **Gerar TXT** para descarregar o ficheiro em UTF-8. Qualquer alteração à data, à rota, à introdução ou aos materiais exige nova aprovação.
5. Use **Partilhar TXT** quando o navegador num contexto seguro suportar partilha de ficheiros. Para enviar por email, a alternativa **Partilhar por email** prepara uma mensagem para `mralo@granitrans.pt`. Anexe o TXT descarregado se o cliente de email não o tiver recebido através da partilha e envie a mensagem no próprio cliente.

O botão **Carregar dados fictícios** está disponível numa expedição vazia. Durante a demonstração, a interface e a pré-visualização identificam os dados fictícios e os controlos de aprovação, exportação e partilha ficam desativados. **Limpar dados fictícios** pede confirmação antes de descartar as alterações da demonstração e abrir uma expedição vazia. Atualizar ou fechar a página limpa a sessão.

## Código e testes

- `index.html` e `styles.css` definem a interface responsiva.
- `app.mjs` gere a sessão, a revisão, a exportação e a partilha.
- `packing-list.mjs` contém as regras de rota, validação, agregação e geração de texto.
- `guides.mjs` verifica os ficheiros selecionados e devolve objetos `File` para a sessão da interface. Uma futura integração poderá passar esses ficheiros, após ação explícita, a um serviço autenticado do lado do servidor. As credenciais do serviço e a validação dos ficheiros recebidos pertencem ao servidor. A versão atual trabalha localmente e não faz pedidos a uma API.

Execute os testes com Node.js 20 ou posterior:

```sh
node --test
```

Os testes de navegador usam Python e Playwright com Chromium. Com essas dependências instaladas, execute `python3 -B -m unittest discover -s tests -v`. Os testes servem a aplicação no caminho `/granitrans-packing-lists/`.

Os ícones são do Bootstrap Icons 1.13.1, com a licença em `assets/bootstrap-icons.LICENSE`.

## Identidade visual

O cabeçalho usa o logótipo oficial fornecido em `Logotipo GRANITRANS.png`. O ficheiro para desktop exclui o endereço do site. No telemóvel, o cabeçalho usa apenas o recorte do símbolo oficial ao lado do separador e do título.

O ícone fornecido em `icon_GTR_width_800.png` é usado no favicon, no atalho iOS e nos tamanhos 192 × 192 e 512 × 512 do manifesto. O manifesto tem caminhos relativos ao projeto. A opção de adicionar ao ecrã principal depende do navegador e de servir a aplicação num contexto seguro.
