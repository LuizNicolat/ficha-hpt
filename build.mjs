// Monta o app em um único index.html (parser embutido).
//   docs/index.html  -> versão para o GitHub Pages (PWA instalável)
//   artifact.html    -> mesma tela, sem o esqueleto <html> (usada no preview do Claude)
import fs from 'fs';

const parser = fs.readFileSync('parser.js', 'utf8').replace(/^export /gm, '');
const app = fs.readFileSync('src/app.html', 'utf8').replace('/*PARSER*/', () => parser);

fs.writeFileSync('artifact.html', app);

const corte = app.indexOf('<main');
const head = app.slice(0, corte);
const corpo = app.slice(corte);
const pwa = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1d58c9">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-192.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}[hidden]{display:none!important}img{max-width:100%}</style>
${head}</head>
<body>
${corpo}
<script>
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
</script>
</body>
</html>
`;
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/index.html', pwa);
console.log('ok: docs/index.html e artifact.html');
