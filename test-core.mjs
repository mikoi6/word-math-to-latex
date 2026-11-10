// 单独验证 HTML 里的核心逻辑（OMML → LaTeX + ZIP 解包）
// 用极简 DOM 模拟浏览器，不需要联网安装任何依赖
import fs from 'node:fs';
import zlib from 'node:zlib';

const html = fs.readFileSync('C:/Users/35118/WorkBuddy/2026-11-10-15-43-47/word-math-to-latex.html', 'utf8');
const m = html.match(/<script id="core">([\s\S]*?)<\/script>/);
if (!m) throw new Error('未找到 core 脚本');
const coreCode = m[1];

/* ---------- 迷你 DOM ---------- */
class MiniNode {
  constructor(name, attrs, nsMap) {
    this.nodeName = name;
    this.localName = name.includes(':') ? name.split(':').pop() : name;
    const prefix = name.includes(':') ? name.split(':')[0] : '';
    this.namespaceURI = nsMap[prefix] || null;
    this.attrs = attrs;
    this.children = [];
    this.textContent = '';
    this.parentNode = null;
    this._ns = nsMap;
  }
  getAttribute(q) {
    const a = this.attrs.find(x => x.name === q);
    return a ? a.value : null;
  }
  getAttributeNS(ns, local) {
    for (const a of this.attrs) {
      const pref = a.name.includes(':') ? a.name.split(':')[0] : '';
      const loc = a.name.includes(':') ? a.name.split(':').pop() : a.name;
      if (loc === local && this._ns[pref] === ns) return a.value;
    }
    return null;
  }
}

class MiniDoc {
  constructor() { this.children = []; }
  getElementsByTagNameNS(ns, local) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (c.localName === local && (!ns || c.namespaceURI === ns)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  getElementsByTagName(tag) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (tag === '*' || c.localName === tag) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

function decodeEnt(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseXml(str) {
  str = str.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const doc = new MiniDoc();
  const root = new MiniNode('#document', [], {});
  doc.children.push(root);
  const stack = [{ node: root, ns: {} }];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let mm;
  while ((mm = re.exec(str)) !== null) {
    const [, close, name, attrStr, selfClose, text] = mm;
    if (text !== undefined) {
      if (text.trim()) stack[stack.length - 1].node.textContent += decodeEnt(text);
      continue;
    }
    if (close) { stack.pop(); continue; }
    const attrs = [];
    const are = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = are.exec(attrStr || '')) !== null) {
      attrs.push({ name: am[1], value: am[2] !== undefined ? am[2] : am[3] });
    }
    const ns = Object.assign({}, stack[stack.length - 1].ns);
    for (const a of attrs) {
      if (a.name.startsWith('xmlns:')) ns[a.name.slice(6)] = a.value;
      if (a.name === 'xmlns') ns[''] = a.value;
    }
    const node = new MiniNode(name, attrs, ns);
    stack[stack.length - 1].node.children.push(node);
    node.parentNode = stack[stack.length - 1].node;
    if (!selfClose) stack.push({ node, ns });
  }
  return doc;
}

globalThis.DOMParser = class { parseFromString(s) { return parseXml(s); } };

/* ---------- 载入 core ---------- */
const win = {};
new Function('window', 'globalThis', coreCode)(win, globalThis);
const C = win.MathCore;
if (!C) throw new Error('MathCore 未导出');

/* ---------- OMML 用例 ---------- */
const W = C.W_NS, M = C.M_NS;
const wrapDoc = inner => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:m="${M}"><w:body>${inner}</w:body></w:document>`;

const cases = [
  ['行内根式 + 中文混排',
    `<w:p><w:r><w:t>由勾股定理</w:t></w:r><m:oMath><m:r><m:t>a</m:t></m:r><m:r><m:t>=</m:t></m:r><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSup><m:e><m:r><m:t>b</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>+</m:t></m:r><m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:e></m:rad></m:oMath><w:r><w:t>可得。</w:t></w:r></w:p>`],

  ['公式内部的中文（条件式）',
    `<w:p><m:oMath><m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/><m:sepChr m:val=""/></m:dPr><m:e><m:r><m:t>当</m:t></m:r><m:r><m:t>x</m:t></m:r><m:r><m:t>&gt;0</m:t></m:r><m:r><m:t>时</m:t></m:r></m:e></m:d></m:oMath></w:p>`],

  ['下标 sSub',
    `<w:p><m:oMath><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub></m:oMath></w:p>`],

  ['上下标 sSubSup（∑ 作基）',
    `<w:p><m:oMath><m:sSubSup><m:e><m:r><m:t>\u2211</m:t></m:r></m:e><m:sub><m:r><m:t>k</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup></m:sSubSup></m:oMath></w:p>`],

  ['分式 + 求和（undOvr）',
    `<w:p><m:oMath><m:nary><m:naryPr><m:chr m:val="\u2211"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup><m:e><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:sSup><m:e><m:r><m:t>i</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:den></m:f></m:e></m:nary></m:oMath></w:p>`],

  ['积分（naryPr 为空，默认 ∫）',
    `<w:p><m:oMath><m:nary><m:naryPr/><m:sub><m:r><m:t>0</m:t></m:r></m:sub><m:sup><m:r><m:t>1</m:t></m:r></m:sup><m:e><m:r><m:t>x</m:t></m:r></m:e></m:nary></m:oMath></w:p>`],

  ['方括号定界符',
    `<w:p><m:oMath><m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e><m:r><m:t>0,1</m:t></m:r></m:e></m:d></m:oMath></w:p>`],

  ['函数 sin',
    `<w:p><m:oMath><m:func><m:fName><m:r><m:t>sin</m:t></m:r></m:fName><m:e><m:r><m:t>x</m:t></m:r></m:e></m:func></m:oMath></w:p>`],

  ['极限 limLow',
    `<w:p><m:oMath><m:func><m:fName><m:limLow><m:e><m:r><m:t>lim</m:t></m:r></m:e><m:lim><m:r><m:t>x\u21920</m:t></m:r></m:lim></m:limLow></m:fName><m:e><m:r><m:t>f(x)</m:t></m:r></m:e></m:func></m:oMath></w:p>`],

  ['重音 hat', `<w:p><m:oMath><m:acc><m:accPr><m:chr m:val="\u0302"/></m:accPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:acc></m:oMath></w:p>`],

  ['上划线 bar', `<w:p><m:oMath><m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e><m:r><m:t>AB</m:t></m:r></m:e></m:bar></m:oMath></w:p>`],

  ['矩阵 2x2',
    `<w:p><m:oMath><m:m><m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:mr><m:mr><m:e><m:r><m:t>c</m:t></m:r></m:e><m:e><m:r><m:t>d</m:t></m:r></m:e></m:mr></m:m></m:oMath></w:p>`],

  ['希腊字母 + 集合符号 + 正体 sty=p',
    `<w:p><m:oMath><m:r><m:t>\u03b1</m:t></m:r><m:r><m:t>\u2208</m:t></m:r><m:r><m:t>\u211d</m:t></m:r><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>max</m:t></m:r></m:oMath></w:p>`],

  ['块级公式 oMathPara',
    `<w:p><m:oMathPara><m:oMath><m:r><m:t>E</m:t></m:r><m:r><m:t>=</m:t></m:r><m:r><m:t>m</m:t></m:r><m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara></w:p>`],

  ['纯文字段落', `<w:p><w:r><w:t>这一段没有公式，只是普通说明文字。</w:t></w:r></w:p>`],

  ['文字含 LaTeX 特殊字符', `<w:p><w:r><w:t>变量名 a_b 与 50% 的 # 号</w:t></w:r></w:p>`],

  ['多 run 拼接的英文标识符',
    `<w:p><m:oMath><m:sSub><m:e><m:r><m:t>v</m:t></m:r></m:e><m:sub><m:r><m:t>max</m:t></m:r></m:sub></m:sSub><m:r><m:t>=</m:t></m:r><m:r><m:t>-1</m:t></m:r></m:oMath></w:p>`]
];

let fail = 0;
for (const [name, body] of cases) {
  try {
    const r = C.convertXml(wrapDoc(body));
    const md = C.formatAll(r, 'markdown');
    const tex = C.formatAll(r, 'latex');
    console.log('■ ' + name);
    console.log('  MD : ' + md.replace(/\n/g, '\\n'));
    if (md !== tex) console.log('  TEX: ' + tex.replace(/\n/g, '\\n'));
  } catch (e) {
    fail++;
    console.log('■ ' + name + '  ✗ ' + e.message);
  }
}

/* ---------- 段落统计 ---------- */
console.log('\n--- 段落统计 ---');
const demo = C.convertXml(wrapDoc(
  `<w:p><w:r><w:t>只有文字</w:t></w:r></w:p>
   <w:p><w:r><w:t>有</w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>
   <w:p><w:r><w:t> </w:t></w:r></w:p>`
));
console.log('段落数:', demo.paras.length, '(应为 2，末尾纯空白段被丢弃)');
console.log('含公式段:', demo.paras.filter(p => p.mathCount > 0).length);

/* ---------- ZIP 解包 ---------- */
console.log('\n--- ZIP / docx 解包 ---');

function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const block = Buffer.concat([lh, nameBuf, comp]);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));

    locals.push(block);
    offset += block.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

const xmlIn = wrapDoc('<w:p><w:r><w:t>来自 zip 的段落</w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>');
const zipBuf = makeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: xmlIn },
  { name: 'word/styles.xml', data: '<styles/>' }
]);
const ab = zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);

const entry = C.unzipFind(ab, n => /^word\/document\d*\.xml$/.test(n));
console.log('命中条目:', entry && entry.name, '| 压缩方式:', entry && entry.method);
const back = await C.unzipEntry(entry);
console.log('解压长度一致:', back === xmlIn, '(', back.length, 'vs', xmlIn.length, ')');
const fromZip = C.formatAll(C.convertXml(back), 'markdown');
console.log('解压后转换:', fromZip);

try {
  C.unzipFind(ab, n => n === 'not/exist.xml');
  console.log('未命中时返回: null ✓');
  C.unzipFind(new Uint8Array([1, 2, 3, 4, 5]).buffer, () => true);
  console.log('✗ 非 zip 竟未报错');
} catch (e) {
  console.log('非 zip 文件报错正常:', e.message);
}

console.log('\n失败用例:', fail);
