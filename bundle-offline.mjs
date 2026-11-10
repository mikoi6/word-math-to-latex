// 把 KaTeX（JS + CSS + 字体）内嵌进单文件 HTML，实现彻底断网可用
import fs from 'node:fs';
import path from 'node:path';

const HTML = 'word-math-to-latex.html';
const DIST = 'node_modules/katex/dist';

let html = fs.readFileSync(HTML, 'utf8');

if (html.includes('id="katex-js"')) {
  console.log('已内嵌过，跳过');
  process.exit(0);
}

/* ---------- 1. CSS + 字体转 base64 ---------- */

let css = fs.readFileSync(path.join(DIST, 'katex.min.css'), 'utf8');
let fontCount = 0;

css = css.replace(
  /src:url\(fonts\/([^)]+?)\.woff2\)\s*format\("woff2"\)(?:,url\(fonts\/[^)]+\)\s*format\("woff"\))?(?:,url\(fonts\/[^)]+\)\s*format\("truetype"\))?/g,
  (_m, name) => {
    const file = path.join(DIST, 'fonts', name + '.woff2');
    const b64 = fs.readFileSync(file).toString('base64');
    fontCount++;
    return `src:url(data:font/woff2;base64,${b64}) format("woff2")`;
  }
);

if (fontCount === 0) throw new Error('没有匹配到字体引用，CSS 结构可能变了');

/* ---------- 2. JS ---------- */

const js = fs.readFileSync(path.join(DIST, 'katex.min.js'), 'utf8');
if (js.includes('</script')) throw new Error('katex.min.js 含 </script，不能内嵌');

/* ---------- 3. 替换 CDN 引用 ---------- */

const linkRe = /<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^"]+"[^>]*>/;
const scriptRe = /<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^"]+"[^>]*><\/script>/;

if (!linkRe.test(html)) throw new Error('找不到 KaTeX CSS 引用');
if (!scriptRe.test(html)) throw new Error('找不到 KaTeX JS 引用');

html = html.replace(linkRe, () => '<style id="katex-css">' + css + '</style>');
html = html.replace(scriptRe, () => '<script id="katex-js">' + js + '</' + 'script>');

fs.writeFileSync(HTML, html);

const kb = (n) => (n / 1024).toFixed(0) + 'KB';
console.log('字体内嵌', fontCount, '个');
console.log('CSS', kb(css.length), '| JS', kb(js.length), '| HTML 总大小', kb(html.length));
