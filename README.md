# Espelho PIN — versão 2

Aplicação estática para GitHub Pages. Mantém PeerJS Cloud para sinalização e WebRTC para comunicação direta entre projetor e dispositivos dos alunos.

## Publicação no GitHub Pages

1. Faça backup do repositório atual.
2. Copie `index.html`, `css/`, `js/` e este `README.md` para a raiz do repositório `jhonatasProf/espelho`.
3. Faça commit na branch configurada no GitHub Pages.
4. Aguarde a publicação e teste primeiro com dois dispositivos na mesma rede.
5. Depois teste com o projetor na rede da escola e um celular usando dados móveis.

## Melhorias desta versão

- Transferência de arquivos e slides em blocos de 16 KB, com indicador de progresso e controle básico de fila do canal.
- Reconstrução do arquivo no projetor e validação de tamanho total (60 MB).
- Validação mais rigorosa de URLs e correção da identificação dos domínios do YouTube.
- PIN gerado com `crypto.getRandomValues`.
- Tentativa de reconexão da sinalização PeerJS e mensagens de erro mais claras.
- Código separado em HTML, CSS e JavaScript, sem dependência de servidor próprio para hospedar a interface.

## Sobre conexões entre redes diferentes (TURN)

A configuração atual mantém STUN do Google. STUN ajuda na travessia de NAT, mas não garante conexão em redes que bloqueiam tráfego ponto a ponto. Para aumentar a compatibilidade, configure um serviço TURN com credenciais temporárias.

O JavaScript aceita uma lista adicional em `window.ESPelhoIceServers`, definida antes de `js/app.js`. **Não publique credenciais permanentes de TURN no repositório.** O ideal é obter credenciais temporárias de um endpoint seguro. O TURN ainda precisa ser contratado/configurado e testado; esta versão não inventa um servidor TURN nem promete conexão garantida em todas as redes.

## Limites e observações

- Tamanho máximo total por transferência: 60 MB.
- A transferência em blocos reduz o risco de mensagens grandes, mas não elimina limitações de rede, memória do navegador ou políticas da escola.
- A aprovação de participantes continua ativada por padrão. Mantenha-a ativada em aulas.
- A transmissão de câmera/tela depende do navegador, das permissões e de HTTPS.
- GitHub Pages hospeda os arquivos estáticos; não fornece backend para emitir credenciais TURN.

## Testes recomendados

1. Abrir a página no computador e selecionar **Este é o projetor**.
2. Abrir no celular e conectar usando o PIN.
3. Aprovar a conexão no projetor.
4. Enviar imagem, PDF, vídeo e um conjunto de imagens como slides.
5. Testar mensagens, links, navegação dos slides e transmissão de câmera/tela.
6. Repetir com celular em dados móveis. Se conectar na mesma rede, mas falhar em redes diferentes, é forte indicação de que será necessário TURN ou liberação de tráfego pela rede escolar.
