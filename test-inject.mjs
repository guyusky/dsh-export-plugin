/**
 * inject.mjs 回归测试: 内联脚本语法 + jsdom 真实菜单注入 + PDF 内容过滤
 *
 * 用法: node test-inject.mjs
 *
 * 为什么需要它: inject.mjs 把内联 JS 放在外层模板字面量里, 有两个历史上真实踩过的坑——
 *   1) 内联 JS 里的 \n / 正则 \. \d 必须写成 \\n / \\. \\d, 否则外层模板字面量会先把它们
 *      转成真换行 / 丢掉转义, 注入后整个 IIFE 语法错误, 菜单项完全不出现;
 *   2) 菜单行结构是 div.itemWrap > button[role=menuitem] > span.itemLabel, 必须克隆 itemWrap。
 * 另外 PDF 的导出范围是"只要用户输入 + 助手最终输出, 不要思考过程", 这里用真实 JSONL 断言。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const FILE = new URL('./inject.mjs', import.meta.url)
const src = readFileSync(FILE, 'utf8')

let failed = 0
const fail = (msg) => { console.log('FAIL: ' + msg); failed++ }

// ---------- 1. 模板字面量内的反斜杠序列 ----------
const marker = 'export const exportInjectHtml = `'
const regionStart = src.indexOf(marker) + marker.length
const region = src.slice(regionStart, src.lastIndexOf('`'))
const counts = {}
for (const mm of region.matchAll(/\\([\s\S])/g)) {
  const c = mm[1]
  const k = c === '\n' ? '<LF>' : c
  counts[k] = (counts[k] || 0) + 1
}
console.log('反斜杠序列:', JSON.stringify(counts))
for (const bad of ['n', '.', 'd']) {
  if (counts[bad]) fail(`模板字面量内还有单反斜杠 \\${bad} x${counts[bad]} (必须写成 \\\\${bad})`)
}

// ---------- 2. 内联脚本语法 ----------
const mod = await import(pathToFileURL(FILE.pathname.slice(1)).href + '?t=' + Date.now())
const html = mod.exportInjectHtml
const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) {
  fail('注入串里找不到 <script> 标签')
  console.log('FAIL')
  process.exit(1)
}
const body = m[1]
try {
  new vm.Script(body, { filename: 'inline.js' })
  console.log('内联脚本语法 OK, 长度 =', body.length)
} catch (e) {
  fail('内联脚本语法错误: ' + e.message)
  const lm = (e.stack || '').match(/inline\.js:(\d+)/)
  if (lm) {
    const lines = body.split('\n')
    const n = Number(lm[1])
    for (let i = Math.max(0, n - 2); i < Math.min(lines.length, n + 1); i++) console.log('  ' + (i + 1) + ' | ' + lines[i])
  }
}

// ---------- 2b. 脚本文本里不得出现结构锚点字面量 ----------
// 这些字面量会劫持 harness tapIndex 链上其他插件的插入锚点 (它们用 /<\/head>/i 找第一个
// </head>), 导致别人的 <script> 被插进我们的脚本内部 → </script> 提前闭合 → 我们的 JS
// 被浏览器当 HTML 渲染到页面上。所以源码里必须拆开写 ('<sty' + 'le>')。
for (const anchor of ['</head', '<head', '</body', '<body', '</style', '<style', '</script', '<script']) {
  if (body.includes(anchor)) fail(`脚本文本里出现了结构锚点字面量 ${anchor} (必须拆开写, 否则会劫持其他插件的注入锚点)`)
}


// ---------- jsdom ----------
let JSDOM = null
for (const root of ['D:/deepseek-harness/package.json', '../package.json', './package.json']) {
  try { JSDOM = createRequire(root)('jsdom').JSDOM; break } catch { /* 换下一个解析根 */ }
}
if (!JSDOM) {
  console.log('SKIP: 未找到 jsdom (行为测试跳过)')
  console.log(failed === 0 ? 'PASS: 静态校验通过' : `FAIL: ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

// 真实菜单结构: div.itemWrap > button[role=menuitem] > span.itemIcon(svg) + span.itemLabel + span.shortcut
// 类名用 CSS module 哈希风格, 以验证 [class*=...] 选择器真的能命中
const menu = `<div class="list" role="menu">
  <div class="_itemWrap_a1b2c_1">
    <button type="button" role="menuitem" class="_item_a1b2c_2">
      <span class="_itemIcon_a1b2c_3"><svg viewBox="0 0 16 16"><path d="M1 1h2"/></svg></span>
      <span class="_itemLabel_a1b2c_4">置顶会话</span>
      <span aria-hidden="true" class="_shortcut_a1b2c_5"><kbd>Ctrl+P</kbd></span>
    </button>
  </div>
  <div class="_itemWrap_a1b2c_1">
    <button type="button" role="menuitem" class="_item_a1b2c_2">
      <span class="_itemIcon_a1b2c_3"><svg viewBox="0 0 16 16"><path d="M1 1h2"/></svg></span>
      <span class="_itemLabel_a1b2c_4">归档会话</span>
      <span aria-hidden="true" class="_shortcut_a1b2c_5"><kbd>Ctrl+Shift+A</kbd></span>
    </button>
  </div>
  <div class="_itemWrap_a1b2c_1">
    <button type="button" role="menuitem" class="_item_a1b2c_2">
      <span class="_itemIcon_a1b2c_3"><svg viewBox="0 0 16 16"><path d="M1 1h2"/></svg></span>
      <span class="_itemLabel_a1b2c_4">分叉会话</span>
    </button>
  </div>
</div>`

const OPTS = { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' }
const page = (scriptBody) => '<!doctype html><html><body>' + menu + '<script>' + scriptBody + '</scr' + 'ipt></body></html>'

// ---------- 3. 菜单注入 ----------
{
  const dom = new JSDOM(page(body), OPTS)
  await new Promise(r => setTimeout(r, 300))
  const doc = dom.window.document
  const buttons = [...doc.querySelectorAll('button[role="menuitem"]')]
  const texts = buttons.map(b => (b.textContent || '').trim())
  console.log('menuitem 文本:', JSON.stringify(texts))
  for (const label of ['导出 Markdown', '导出 PDF']) {
    const target = buttons.find(b => (b.textContent || '').trim() === label)
    if (!target) { fail(`未注入 "${label}"`); continue }
    const wraps = [...doc.querySelectorAll('div[class*="itemWrap"]')]
    const wrap = target.closest('div[class*="itemWrap"]')
    const idx = wraps.indexOf(wrap)
    const prevLabel = wraps[idx - 1] ? wraps[idx - 1].querySelector('[class*="itemLabel"]') : null
    const prevText = prevLabel ? (prevLabel.textContent || '').trim() : ''
    if (!(prevText === '归档会话' || prevText === '导出 Markdown')) fail(`${label} 位置不对 (前一行: ${prevText})`)
    if (wrap && wrap.querySelectorAll('button[role="menuitem"]').length !== 1) fail(`${label} 未独占 itemWrap`)
    if (!target.querySelector('[class*="itemLabel"]')) fail(`${label} 未通过 itemLabel 改文字`)
    if (target.querySelector('[class*="shortcut"]')) fail(`${label} 快捷键 span 未移除`)
  }
  if (texts.indexOf('导出 Markdown') + 1 !== texts.indexOf('导出 PDF')) fail('导出 Markdown / 导出 PDF 顺序不对')
  dom.window.close()
}

// ---------- 4. PDF 内容过滤 (插桩暴露内部函数, 不污染生产代码) ----------
{
  const MARK = 'window.__dshExportTest = { jsonlToBlocks: jsonlToBlocks, renderPdfHtml: renderPdfHtml, renderMarkdown: renderMarkdown };'
  const cut = body.lastIndexOf('})();')
  const instrumented = body.slice(0, cut) + MARK + '\n' + body.slice(cut)
  const dom = new JSDOM(page(instrumented), OPTS)
  await new Promise(r => setTimeout(r, 300))
  const T = dom.window.__dshExportTest
  if (!T) {
    fail('插桩失败: 取不到内部函数')
  } else {
    const USER_CONTENT = [
      { type: 'text', text: '用户问题 <b>加粗</b> & 符号' },
      { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } },
    ]
    const jsonl = [
      JSON.stringify({ type: 'session', id: 's-test', createdAt: '2026-10-13T00:00:00Z', cwd: 'D:/demo' }),
      // 第 1 轮: 真实用户输入在 inbox/spliced 与 user/message 里各记一次(**同一个 id**) → 只应出一条;
      //   系统注入 (runtime-context / time-context / skill-catalog) 也走 user/message → 全部丢弃。
      //   (这两种形态都取自真实会话日志)
      JSON.stringify({ type: 'agent/inbox/spliced', data: { inserted: [
        { role: 'user', id: 'u1', source: { kind: 'user' }, content: USER_CONTENT },
      ] } }),
      JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
      JSON.stringify({ type: 'user/message', data: { role: 'user', id: 'u1', source: { kind: 'user' }, content: USER_CONTENT } }),
      JSON.stringify({ type: 'user/message', data: { role: 'user', id: 'ctx1', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '运行时上下文不该出现' }] } }),
      JSON.stringify({ type: 'user/message', data: { role: 'user', id: 'ctx2', source: { kind: 'time-context' }, content: [{ type: 'text', text: '时间上下文不该出现' }] } }),
      JSON.stringify({ type: 'user/message', data: { role: 'user', id: 'ctx3', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '技能目录不该出现' }] } }),
      JSON.stringify({ type: 'assistant/attempt', data: { message: { content: [{ type: 'text', text: '半途草稿不该出现' }] } } }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '中间过渡回复不该出现' }] } } }),
      JSON.stringify({ type: 'tool/call', data: { name: 'Bash', arguments: { cmd: '不该出现' } } }),
      JSON.stringify({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具结果不该出现' }] } } }),
      JSON.stringify({ type: 'system/message', data: { message: { content: [{ type: 'text', text: '系统提示不该出现' }] } } }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [
        { type: 'thinking', thinking: '内部推理不该出现' },
        { type: 'text', text: '助手最终答案' },
        { type: 'tool_use', name: 'Read', input: { file: '不该出现' } },
      ] } } }),
      JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
      // 第 2 轮
      JSON.stringify({ type: 'user/message', data: { role: 'user', id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二个问题' }] } }),
      JSON.stringify({ type: 'developer/message', data: { message: { content: [{ type: 'text', text: '开发者提示不该出现' }] } } }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二个答案' }] } } }),
      JSON.stringify({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }),
      // 第 3 轮: 没有 turn/end (被打断) → 收尾 flush 也要导出
      JSON.stringify({ type: 'user/message', data: { role: 'user', id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: '第三个问题' }] } }),
      JSON.stringify({ type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '被打断的答案' }] } } }),
    ].join('\n')

    const parsed = T.jsonlToBlocks(jsonl, new Map(), 'fallback')
    console.log('PDF blocks:', JSON.stringify(parsed.blocks.map(b => b.role)))
    const roles = parsed.blocks.map(b => b.role).join(',')
    if (roles !== 'user,assistant,user,assistant,user,assistant') {
      fail(`PDF 应是 3 组问答对 (user,assistant ×3), 实际: ${roles}`)
    }

    const out = T.renderPdfHtml(parsed.meta, parsed.blocks)
    for (const s of ['用户问题', '助手最终答案', '第二个问题', '第二个答案', '第三个问题', '被打断的答案', 's-test', 'D:/demo']) {
      if (!out.includes(s)) fail(`PDF HTML 缺少内容: ${s}`)
    }
    for (const s of ['内部推理不该出现', '半途草稿不该出现', '中间过渡回复不该出现', '工具结果不该出现', '系统提示不该出现', '开发者提示不该出现', '运行时上下文不该出现', '时间上下文不该出现', '技能目录不该出现']) {
      if (out.includes(s)) fail(`PDF HTML 泄漏了不该导出的内容: ${s}`)
    }
    if (!out.includes('&lt;b&gt;加粗&lt;/b&gt;')) fail('HTML 未转义 (用户文本里的标签会破坏排版)')
    if (!out.includes('&amp; 符号')) fail('HTML 未转义 & 符号')
    if (!out.includes('[图片]')) fail('mediaMap 缺图时未输出占位')

    // mediaMap 命中时应内嵌 data URL
    const mediaMap = new Map([['img-1', { mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }]])
    const parsed2 = T.jsonlToBlocks(jsonl, mediaMap, 'x')
    const out2 = T.renderPdfHtml(parsed2.meta, parsed2.blocks)
    if (!out2.includes('<img src="data:image/png;base64,')) fail('mediaMap 命中时未内嵌图片 data URL')
    if (out2.includes('[图片]')) fail('mediaMap 命中时仍输出缺图占位')

    // ---- Markdown 导出: 与 PDF 同一套极简问答对 ----
    const md = T.renderMarkdown(parsed.meta, parsed.blocks)
    if (!md.includes('## 👤 用户') || !md.includes('## 🤖 助手')) fail('Markdown 缺少角色标题')
    for (const s of ['用户问题', '助手最终答案', '第二个问题', '第二个答案', '第三个问题', '被打断的答案', 's-test', 'D:/demo']) {
      if (!md.includes(s)) fail(`Markdown 缺少内容: ${s}`)
    }
    for (const s of ['内部推理不该出现', '半途草稿不该出现', '中间过渡回复不该出现', '工具结果不该出现', '系统提示不该出现', '开发者提示不该出现', '运行时上下文不该出现', '时间上下文不该出现', '技能目录不该出现', '🔧', '### ']) {
      if (md.includes(s)) fail(`Markdown 泄漏了不该导出的内容: ${s}`)
    }
    if (!md.includes('[图片]')) fail('Markdown 未输出图片占位')

    // 生成的 PDF 文档本身要能被浏览器正常解析出 head/body (我们刻意不写字面 head/body 标签)
    const pdfDom = new JSDOM(out)
    const pdfDoc = pdfDom.window.document
    if (!pdfDoc.querySelector('style')) fail('PDF HTML 解析后没有 style 元素')
    if (!(pdfDoc.body.textContent || '').includes('助手最终答案')) fail('PDF HTML 解析后正文缺失')
    if ((pdfDoc.body.textContent || '').includes('内部推理不该出现')) fail('PDF HTML 解析后仍含思考过程')
    pdfDom.window.close()
  }
  dom.window.close()
}

// ---------- 5. 注入锚点不被劫持 (复现历史事故) ----------
if (JSDOM) {
  // 模拟真实情形: 我们的内容已在页面里, 之后另一个插件用 /<\/head>/i 找"第一个 </head>"
  // 插入自己的 <script>。若我们的脚本文本里含 </head>, 锚点就会落在我们脚本内部。
  const withOurs = '<!doctype html><html><head><script>globalThis["__DSH_BOOT__"]={}</script>'
    + html + '</head><body></body></html>'
  const anchor = /<\/head>/i.exec(withOurs)
  if (anchor === null) fail('劫持模拟: 测试页没有 </head>')
  else {
    const foreign = '<script>globalThis.__otherPlugin = 1</script>'
    const spliced = withOurs.slice(0, anchor.index) + foreign + withOurs.slice(anchor.index)
    const dom = new JSDOM(spliced, OPTS)
    const scripts = [...dom.window.document.querySelectorAll('script')]
    const mine = scripts.find(s => (s.textContent || '').includes('[dsh-export]'))
    if (!mine) fail('劫持模拟: 我们的脚本消失了')
    else if (mine.textContent.length !== body.length) fail(`劫持模拟: 我们的脚本被截断 (${mine.textContent.length} != ${body.length}) —— 脚本文本里混入了结构锚点`)
    if ((dom.window.document.body.textContent || '').includes('exportSessionPdf')) fail('劫持模拟: JS 泄漏成了页面文本')
    dom.window.close()
  }
}

// ---------- 6. injectAll 取最后一个 </head> 作锚点 ----------
if (JSDOM) {
  const { injectAll } = await import(
    pathToFileURL(new URL('./index.js', import.meta.url).pathname.slice(1)).href + '?t=' + Date.now()
  )
  // 前一个插件的内容里含有 </head> 字样 —— 用第一个匹配就会插进它的脚本内部
  const evil = '<!doctype html><html><head><script>var x = "</head>";</script></head><body></body></html>'
  const out = injectAll(evil)
  const idxOurs = out.indexOf('dsh-export-style')
  const idxEvil = out.indexOf('var x =')
  if (idxOurs < 0) fail('injectAll: 内容没被注入')
  else if (idxOurs < idxEvil) fail('injectAll: 内容被插到了前一个插件脚本之前 (锚点应取最后一个 </head>)')
  const dom = new JSDOM(out, OPTS)
  const mine = [...dom.window.document.querySelectorAll('script')].find(s => (s.textContent || '').includes('[dsh-export]'))
  if (!mine || mine.textContent.length !== body.length) fail('injectAll: 解析后我们的脚本被截断')
  dom.window.close()
}

console.log(failed === 0 ? 'PASS: 全部校验通过' : `FAIL: ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
