# Verificação visual da v0.1

final result: passed

- **Desktop, 1448 × 1086.** O cabeçalho mostra o logótipo oficial completo sem endereço do site. A expedição e os materiais ficam à esquerda e a pré-visualização de texto à direita.
- **Telemóvel, 393 × 852.** O símbolo oficial, o separador vertical e «Packing List» partilham o mesmo alinhamento central. Os cartões são verticais e os atalhos ficam no fundo. O cabeçalho branco acompanha o fundo da imagem original.
- **Imagem e ícones.** Os PNG do logótipo usam os píxeis do original do GitHub e conservam o perfil de cor. As variantes do ícone mantêm as proporções do ficheiro fornecido. O Chromium carregou o favicon, o ícone Apple e os dois ícones do manifesto nos tamanhos declarados, com caminhos relativos ao projeto.
- **Validação funcional.** Passaram os oito testes Node e os fluxos em Chromium para desktop e mobile. Verifiquei seis larguras entre 320 e 1448 px. O axe-core não detetou violações a 393 e 1448 px. A instalação nativa em telemóvel fica por validar.
- **Capturas da revisão.** Os estados inicial e de demonstração aprovada foram capturados em Chromium com a configuração regional portuguesa. As imagens desta sessão estão em `/workspace/scratch/granitrans-review`, fora do repositório.
