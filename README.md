# Rainbow Pub — cardápio e pedidos na mesa

Site do **Rainbow Pub** (Rua Professor Pedro Bernardo, 20 · Centro · Uberlândia-MG): cardápio pelo celular, comanda e pedido direto da mesa, com conferência por GPS de que o cliente está dentro do bar, e painel da equipe com pedidos ao vivo, cardápio editável e relatórios.

**No ar:** https://rainbowpub.cjc.pics · painel: https://rainbowpub.cjc.pics/adm/

## Como funciona
- **Letreiro:** o arco do "A" do logo é um neon que acende faixa por faixa; cada uma das 6 faixas é uma seção do cardápio (e vira a navegação).
- **Comanda:** o carrinho é a comanda de papel do balcão. O cliente põe o nome e onde está (mesa, balcão, sinuca…); ao mandar, a comanda ganha um carimbo com o número e o andamento ao vivo (Recebido → Preparando → Pronto → Entregue). O pagamento continua no balcão.
- **Anti-fraude por GPS:** o pedido só sai se o celular estiver dentro do raio do bar. As regras do Firestore conferem de novo no servidor (caixa de lat/lng gravada pelo painel), então não adianta burlar a página.
- **Painel (`/adm/`):** login da equipe (sem cadastro público), pedidos ao vivo com som, botão "recebendo pedidos", cardápio (preço, esgotado, foto, ordem), dados do bar e do GPS, relatórios por noite com CSV e impressão.

## Segurança
- Sem cadastro público (desligado no Firebase Auth). Painel só para contas que estão na coleção `equipe/{uid}` do Firestore.
- **Pessoa nova na equipe:** criar o usuário em Authentication e depois um documento `equipe/<UID>` com o campo `email` (pelo console do Firestore).
- Cardápio, textos e fotos: leitura pública, escrita só da equipe. Pedidos: qualquer um cria (com GPS dentro do raio e formato fechado); só a equipe lista e altera.

## Técnica
HTML, CSS e JavaScript puros (ES modules), sem build. Firebase Auth + Firestore (projeto `rainbowpub-ecd71`, São Paulo), fotos em base64 no Firestore. Hospedagem no Cloudflare Pages (push na `main` publica). O build do Pages roda `node tools/carimbo.mjs`, que põe `?v=<commit>` em todo CSS/JS e nos imports: a zona cjc.pics guarda CSS/JS por 4 h no navegador, e sem o carimbo o celular misturava HTML novo com CSS/JS velho depois de publicar.

- `index.html`, `css/site.css`, `js/cardapio.js` — cardápio público
- `adm/` — painel da equipe
- `js/base.js` — utilidades e o cardápio inicial (também é a reserva se o Firestore não responder)
- `firestore.rules` — regras (publicar com `firebase deploy --only firestore:rules --project rainbowpub-ecd71`)

Feito por [Davi Castro](https://davicjc.com).
