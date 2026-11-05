// Carimbo de versão: roda no build do Cloudflare Pages (build command: node tools/carimbo.mjs).
// Põe ?v=<commit> em todo CSS/JS local referenciado no HTML e nos imports entre módulos.
// Motivo: a zona cjc.pics manda o navegador guardar CSS/JS por 4 h; sem carimbo, depois de
// publicar o celular juntava HTML novo com CSS/JS velho e a página quebrava.
// Localmente não precisa rodar (sem carimbo tudo funciona igual).
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const raiz = new URL('..', import.meta.url).pathname;
const versao = (process.env.CF_PAGES_COMMIT_SHA || process.env.VERSAO || String(Date.now())).slice(0, 10);
const ignorar = new Set(['.git', 'node_modules', 'tools', '.github']);

function arquivos(dir) {
  return readdirSync(dir).flatMap((nome) => {
    if (ignorar.has(nome)) return [];
    const caminho = join(dir, nome);
    return statSync(caminho).isDirectory() ? arquivos(caminho) : [caminho];
  });
}

const local = String.raw`(?!https?:|\/\/|data:)`;
const emHtml = new RegExp(String.raw`((?:href|src)=")(${local}[^"?#]+?\.(?:css|js))(?:\?v=[^"]*)?(")`, 'g');
const emJs = new RegExp(String.raw`(from\s+')(\.\.?\/[^'?#]+?\.js)(?:\?v=[^']*)?(')`, 'g');

let total = 0;
for (const arq of arquivos(raiz)) {
  const tipo = extname(arq);
  if (tipo !== '.html' && tipo !== '.js') continue;
  const antes = readFileSync(arq, 'utf8');
  const re = tipo === '.html' ? emHtml : emJs;
  const depois = antes.replace(re, (_, a, caminho, b) => { total++; return `${a}${caminho}?v=${versao}${b}`; });
  if (depois !== antes) writeFileSync(arq, depois);
}
console.log(`carimbo ${versao}: ${total} referências`);
