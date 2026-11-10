// 把「中文正文 + 裸 LaTeX 源码」混排的 docx，渲染成一份排版好的 HTML 文档
// 公式用 MathJax 预渲染成内嵌 SVG，产物完全自包含、离线可读、可直接打印成 PDF
import fs from 'node:fs';
import zlib from 'node:zlib';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

/* ================= ZIP ================= */

function readZipEntry(buf, matcher) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip / docx');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (matcher(name)) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      return method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

/* ================= 抽取段落 ================= */

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractParagraphs(xml) {
  const start = xml.indexOf('<w:body>');
  const end = xml.lastIndexOf('</w:body>');
  const body = xml.slice(start, end < 0 ? xml.length : end);
  const chunks = body.split(/<w:p(?=[\s>])/).slice(1);
  const out = [];

  for (const ch of chunks) {
    let text = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
    let m;
    while ((m = re.exec(ch)) !== null) {
      if (m[1] !== undefined) text += decodeXml(m[1]);
      else if (m[0].startsWith('<w:tab')) text += '  ';
      else text += '\n';
    }
    if (!text.trim()) continue;

    // 标题启发：首段 / 短 / 不含 LaTeX 命令 / 以编号开头
    const style = (ch.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
    const isHeadingStyle = /^(Heading|Title|Subtitle|\d)$/i.test(style);
    out.push({ text: text.trim(), style, isHeadingStyle });
  }
  return out;
}

/* ================= 切分中英 + 识别 LaTeX ================= */

const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
// 注意：故意不含 + - * / 这些，避免把「1 列截距 + 8 个特征」误判成公式
const MATH_SIGN = /[=<>≈≠≤≥≡±×÷∑∏∫√∞∈∉⊂⊃⊆⊇∪∩→←↔⇒⇔↦∂∇]/;

function isMathToken(s) {
  const t = s.trim();
  if (!t) return false;
  if (/\\[a-zA-Z]+/.test(t)) return true;                       // 含 LaTeX 命令
  if (/[\^_]\s*(\{|\\|[A-Za-z0-9])/.test(t)) return true;        // 上下标
  if (MATH_SIGN.test(t) && /[A-Za-z0-9\\]/.test(t)) return true; // 关系符 + 操作数
  if (/^[A-Za-z]$/.test(t)) return true;                         // 单个字母变量
  return false;
}

function splitInline(text) {
  const raw = [];
  let i = 0;
  while (i < text.length) {
    const isC = CJK_RE.test(text[i]);
    let j = i;
    while (j < text.length && CJK_RE.test(text[j]) === isC) j++;
    raw.push({ cjk: isC, s: text.slice(i, j) });
    i = j;
  }

  // 合并：非中文片段若是公式则成 math 段，否则当普通文字
  const segs = [];
  for (const t of raw) {
    if (t.cjk) { segs.push({ type: 'text', s: t.s }); continue; }
    if (isMathToken(t.s)) segs.push({ type: 'math', s: t.s.trim() });
    else segs.push({ type: 'text', s: t.s });
  }

  // 相邻文字合并
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.type === 'text' && s.type === 'text') last.s += s.s;
    else merged.push({ ...s });
  }
  return merged;
}

// 整段就是一个公式？→ 块级展示
function isWholeMath(segs) {
  const meaningful = segs.filter(s => s.s.trim());
  if (!meaningful.length) return false;
  return meaningful.every(s => s.type === 'math');
}

/* ================= MathJax 渲染 ================= */

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texInput = new TeX({ packages: AllPackages });
const svgOutput = new SVG({ fontCache: 'none' });
const mjDoc = mathjax.document('', { InputJax: texInput, OutputJax: svgOutput });

let mathCount = 0;
const mathErrors = [];

function renderTeX(src, display) {
  let html;
  try {
    const node = mjDoc.convert(src, { display, em: 17, ex: 8, containerWidth: 700 });
    html = adaptor.outerHTML(node);
  } catch (e) {
    mathErrors.push({ src, msg: e.message });
    return `<code class="tex-fallback">${escapeHtml(src)}</code>`;
  }
  mathCount++;
  if (/data-mjx-error|merror/.test(html)) {
    mathErrors.push({ src, msg: html.match(/data-mjx-error="([^"]*)"/)?.[1] || '渲染出错' });
    return `<code class="tex-fallback" title="此公式渲染失败">${escapeHtml(src)}</code>`;
  }
  // 统一挂上类名，方便控制间距
  html = html.replace(/^<mjx-container/, '<mjx-container class="mjx"');
  return html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= 生成 HTML ================= */

function buildHtml(paras, meta) {
  const blocks = [];
  let headingDone = false;

  for (const p of paras) {
    const segs = splitInline(p.text);
    const whole = isWholeMath(segs);

    const isTitle = !headingDone &&
      (p.isHeadingStyle || (p.text.length <= 60 && !/\\/.test(p.text)));

    // 块级公式：整段一个公式
    if (whole) {
      const tex = segs.filter(s => s.s.trim()).map(s => s.s.trim()).join(' ');
      blocks.push(`<div class="eq">${renderTeX(tex, true)}</div>`);
      continue;
    }

    const inner = segs.map(s => s.type === 'math'
      ? `<span class="mi">${renderTeX(s.s, false)}</span>`
      : escapeHtml(s.s)
    ).join('');

    if (isTitle) {
      headingDone = true;
      blocks.push(`<h1>${inner}</h1>`);
    } else {
      blocks.push(`<p>${inner}</p>`);
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>
:root{
  --ink:#1c1f26;
  --ink-2:#444b57;
  --muted:#8b929e;
  --rule:#e3e5ea;
  --paper:#ffffff;
  --bg:#f4f3f0;
  --serif:"Source Han Serif SC","Noto Serif CJK SC","Songti SC","STSong","SimSun",Georgia,serif;
  --sans:"Inter","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font-family:var(--serif);font-size:17.5px;line-height:2.05;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
.page{
  max-width:760px;margin:0 auto;background:var(--paper);
  padding:72px 76px 64px;
  box-shadow:0 1px 2px rgba(20,22,28,.04),0 12px 40px rgba(20,22,28,.06);
  min-height:100vh;
}
h1{
  font-family:var(--sans);font-size:25px;font-weight:700;line-height:1.45;
  letter-spacing:-.005em;margin:0 0 30px;padding-bottom:18px;
  border-bottom:1px solid var(--rule);color:var(--ink);
}
p{margin:0 0 1.05em;text-indent:2em;text-align:justify}
p:last-child{margin-bottom:0}

/* 行内公式 */
.mi{margin:0 .16em;white-space:nowrap}
.mi mjx-container,.mi svg{vertical-align:baseline}

/* 块级公式 */
.eq{
  margin:1.5em 0 1.7em;text-align:center;text-indent:0;
  overflow-x:auto;overflow-y:hidden;padding:2px 0;
}
.eq svg{max-width:100%;height:auto}

.tex-fallback{
  font-family:"JetBrains Mono","Cascadia Code",Consolas,monospace;
  font-size:.82em;background:#fdf1ef;color:#a8342a;
  padding:2px 6px;border-radius:4px;white-space:pre-wrap;
}

/* 页面底注 */
.colophon{
  margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);
  font-family:var(--sans);font-size:12.5px;line-height:1.9;color:var(--muted);
}
.colophon b{font-weight:600;color:var(--ink-2)}

@media (max-width:820px){
  body{background:var(--paper);font-size:17px;line-height:1.95}
  .page{max-width:none;padding:34px 22px 40px;box-shadow:none;min-height:auto}
  h1{font-size:21px;margin-bottom:22px;padding-bottom:14px}
  .eq{margin:1.4em 0}
}

@media print{
  body{background:#fff;font-size:11.5pt;line-height:1.95}
  .page{max-width:none;padding:0;box-shadow:none;min-height:auto}
  h1{page-break-after:avoid}
  .eq{page-break-inside:avoid;overflow:visible}
  p{orphans:2;widows:2}
  .colophon{page-break-inside:avoid}
  @page{size:A4;margin:22mm 20mm}
}
</style>
</head>
<body>
<div class="page">
${blocks.join('\n')}
<div class="colophon">
  源文件 <b>${escapeHtml(meta.source)}</b> · 共 <b>${meta.paras}</b> 段 · 渲染公式 <b>${meta.math}</b> 处<br>
  公式由 MathJax 预渲染为内嵌 SVG，本文件不依赖网络，可直接打开、打印或另存为 PDF。
</div>
</div>
</body>
</html>`;
}

/* ================= 同时导出一份 Markdown ================= */

function buildMarkdown(paras) {
  const lines = [];
  let headingDone = false;
  for (const p of paras) {
    const segs = splitInline(p.text);
    const whole = isWholeMath(segs);
    const isTitle = !headingDone &&
      (p.isHeadingStyle || (p.text.length <= 60 && !/\\/.test(p.text)));

    if (whole) {
      const tex = segs.filter(s => s.s.trim()).map(s => s.s.trim()).join(' ');
      lines.push('$$' + tex + '$$');
      continue;
    }
    const body = segs.map(s => s.type === 'math' ? '$' + s.s + '$' : s.s).join('').trim();
    if (!body) continue;
    if (isTitle) { headingDone = true; lines.push('# ' + body); }
    else lines.push(body);
  }
  return lines.join('\n\n') + '\n';
}

/* ================= 主流程 ================= */

const src = process.argv[2];
const outFile = process.argv[3] || 'rendered.html';
if (!src) {
  console.error('用法: node build-doc.mjs <输入.docx> [输出.html]');
  process.exit(1);
}

const buf = fs.readFileSync(src);
const xml = readZipEntry(buf, n => /^word\/document\d*\.xml$/.test(n));
if (!xml) throw new Error('docx 里找不到 word/document.xml');

const paras = extractParagraphs(xml);
console.log('段落数:', paras.length);

const title = paras[0] ? paras[0].text.replace(/\\[a-zA-Z]+/g, '').slice(0, 60) : '文档';
const html = buildHtml(paras, {
  title,
  source: src.split(/[\\/]/).pop(),
  paras: paras.length,
  math: mathCount
});

fs.writeFileSync(outFile, html);
console.log('公式渲染:', mathCount, '处');
if (mathErrors.length) {
  console.log('渲染失败:', mathErrors.length, '处');
  for (const e of mathErrors) console.log('  ✗', e.src.slice(0, 70), '→', e.msg);
}
console.log('输出:', outFile, '(', (html.length / 1024).toFixed(1), 'KB )');

const mdFile = outFile.replace(/\.html?$/i, '.md');
fs.writeFileSync(mdFile, buildMarkdown(paras));
console.log('输出:', mdFile);
