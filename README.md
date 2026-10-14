# dsh-my-export-plugin · 会话导出 Markdown + PDF

在 dsh 会话行"更多"菜单里,于"归档会话"下方注入两项:

- **导出 Markdown** —— 与 PDF 同一套**极简问答对**（只有用户输入 + 该轮最后一条助手可见回复）转成 `.md` 下载。
- **导出 PDF** —— 只取**用户输入 + 该轮最后一条助手可见回复**(文字与图片),排成干净的问答对,A4 排版后经系统打印对话框"另存为 PDF"。

## 设计

复用官方 `dsh-session-log-export` 包的 `/api/session.export` route(返回 ZIP,内含 canonical JSONL log + `media/<attachmentId>.<ext>` 图片),前端 fetch 拿 ZIP → 浏览器原生 `DecompressionStream('deflate-raw')` 解压 → 迷你 ZIP 解析器找根 `session*.jsonl`(PDF 再解 `media/*`)→ 按 V4 event type 转换 → `.md` 下载,或渲染打印专用 HTML 到隐藏 `iframe srcdoc` 并调 `contentWindow.print()`。

**纯前端注入,零 npm 依赖,不读 zstd**(官方已用 persistence read handle 把 log 解好放进 ZIP),不碰 persistence。PDF 走 `window.print` 而不是 jsPDF/pdfMake:零依赖、中文用系统字体、图片与 CSS 排版交给浏览器。

## PDF 导出范围

| 事件 / 内容 | 是否导出 |
|---|---|
| `user/message` 且 `source.kind === 'user'`(真实用户输入,含图片) | ✅ |
| `agent/inbox/spliced` 里 role=user 的插入消息 | ✅ 与上一条是**同一个 message id**,按 id 去重只出一次 |
| `runtime-context` / `time-context` / `skill-catalog` / 工作区指令等**系统注入** | ❌ 它们也走 `user/message`,按 `source.kind` 滤掉 |
| `assistant/message` 的 `text` block | ✅ 但**每轮只留最后一条** |
| `assistant/message` 的 `image` block | ✅ |
| 同一轮里工具调用前后的**过渡说明文本** | ❌ 被该轮最后一条覆盖 |
| `thinking` / `reasoning` block(思考过程) | ❌ |
| `tool_use` / `tool_result` / `tool/call` / `tool/result` | ❌ |
| `system/message` / `developer/message` | ❌ |
| `assistant/attempt`(半途草稿、流式分片) | ❌ |
| 子代理会话(`includeDescendants=false`) | ❌ |
| 未知/其它事件类型 | ❌ |

即 PDF 是一份干净的"我问了什么 / 最终答了什么"记录,不含模型内部过程。配对规则:以 `turn/end` 作为一轮的边界,把该轮的用户输入与**最后一条**助手可见回复排成一组;日志末尾再收尾 flush 一次,所以被打断 / 未正常结束的回合也不会丢内容。用户消息里的图片会内嵌到 PDF(缺图时输出 `[图片未随会话导出]` 占位)。

> **为什么必须"按 id 去重 + 按 source.kind 过滤"**(来自真实会话日志的教训):
> 同一条用户输入在 `agent/inbox/spliced` 与 `user/message` 里**各记一次、共用同一个 message id**,
> 不去重就会每句提问出现两遍;而 `runtime-context`、`time-context`、`skill-catalog`、工作区指令
> (如 CLAUDE.md,实测上万字符)也是 `user/message`,不按 `source.kind === 'user'` 过滤就会**冒充用户提问**
> 混进 PDF。两者叠加曾是 PDF 里"重复提问 + 莫名其妙的成段内容"的直接原因。

## 导出的 Markdown 结构

Markdown 与 PDF **共用同一套"极简问答对"**（同一份 `jsonlToBlocks` 输出），只有标题、角色、正文和图片占位：

```
# Session <id>

- Created: <createdAt>
- Workspace: <cwd>

## 👤 用户

<用户消息>

## 🤖 助手

<助手回复（保留 Markdown 代码块与列表）>

## 👤 用户

…（每轮如此）
```

不再包含工具调用 / 工具结果 / 系统提示词 / 思考过程 / 上下文注入 / 未知事件的 JSON dump。图片位置输出 `[图片]` 占位（Markdown 不做 base64 内嵌，避免文件膨胀）。

实测（同一会话 `session-5494db1e`）：**旧导出 146,662 字节 → 新导出 3,208 字节**（约 2.2%）。

> 需要**完整会话日志**（含工具调用、系统提示词）时，用会话菜单里官方 `dsh-session-log-export` 提供的导出项，它仍会给出完整的 ZIP/日志。

## 菜单挂载的真实 DOM

官方菜单行由 `@deepseek-ai/dsh-client-ui-primitives` 的 `MenuItemButton` 渲染(类名是 CSS module 哈希):

```html
<div class="itemWrap">
  <div class="separator" role="separator"></div>   <!-- 可选: 分组线 -->
  <button type="button" role="menuitem" class="item">
    <span class="itemIcon"><svg/></span>
    <span class="itemLabel">归档会话</span>
    <span class="shortcut">…</span>
  </button>
</div>
```

注入做法:按文本 `归档会话` / `取消归档` 找到 `[role="menuitem"]`,再取它的外层 `div.itemWrap`,**克隆整个 `itemWrap`**(不是只克隆 button——`.itemWrap` 是 `position:relative` 的整行单元,只克隆 button 会让两个 button 挤在同一个包裹层里),然后改 `itemLabel` 文字、替换 svg 图标、移除 `shortcut`、绑定 click,依次插到原行后面(Markdown 在前、PDF 在后)。

## 文件

- `index.js` — apply 注入,通过 `webServer.tapIndex` 把 HTML 注入 `</head>` 前
- `inject.mjs` — 导出 `exportInjectHtml` 字符串,含 CSS + JS IIFE(两个导出项 + ZIP 解析 + MD/PDF 两条转换链)
- `cordis.patch.yml` — 插件 bundle 声明
- `package.json` — 包配置
- `test-inject.mjs` — 回归测试(见下)

## 安装

```bash
npx @deepseek-ai/dsh plugin --profile web add D:\dsh-code\export-plugin
```

插件以**目录链接**安装(profile 的 `dsh-my-export-plugin` → `link:D:/dsh-code/export-plugin`),改 `inject.mjs` / `index.js` 后**只需重启 dsh**(`npx @deepseek-ai/dsh web`),不必重新 add;改 `package.json` 结构字段需重新 add。

> `inject.mjs` 的注入串在服务启动时随模块加载定格,重启前改动不会生效。

## 自测(改完 inject.mjs 先跑这个)

```bash
node test-inject.mjs
```

它做六件事:

1. 断言外层模板字面量里**没有残留的单反斜杠** `\n` / `\.` / `\d`;
2. 提取内联 `<script>` 并编译,捕获语法错误并打印出错行;
3. 断言**脚本文本里没有任何结构锚点字面量**(head / body / style / script 的开合标签字样);
4. 用 jsdom + 真实菜单 DOM 结构,验证"导出 Markdown"与"导出 PDF"依次插在"归档会话"之后、各自独占一个 `itemWrap`、用 `itemLabel` 改文字、移除了 `shortcut`;
5. 用真实 JSONL 断言导出内容:只产出 `user` + `assistant` 三组问答对;思考过程 / 工具调用 / 工具结果 / system / developer 文本 / 三种系统注入(runtime-context、time-context、skill-catalog)都**不得出现**;同一条用户消息(spliced + user/message 共用 id)只出一次;HTML 已转义、图片按 `mediaMap` 内嵌或占位、生成的 PDF 文档能被正常解析;**Markdown 渲染器同样断言**问答结构、内容齐全且无角色外的泄漏;
6. **锚点劫持回归**:模拟"另一个插件用正则找第一个 head 结束标签、插入它自己的脚本元素",断言我们的脚本仍完整、JS 没有泄漏成页面文本;并断言 `index.js` 的 `injectAll` 取的是**最后一个** head 结束标签。

> **两个必踩的坑(都真实发生过)**
>
> 1. **转义坑**:内联 JS 写在外层模板字面量里,里面的 `\n`、正则 `\.` `\d` 必须写成 `\\n`、`\\.`、`\\d`,并且**不要在内联 JS 里再用反引号模板**。漏写会让注入后的脚本报 `Invalid or unexpected token`,整个 IIFE 不执行 —— 表现为**菜单项完全不出现**。
> 2. **锚点劫持坑**:`webServer.tapIndex` 是链式的,各插件都用正则找**第一个** head 结束标签来插入自己的内容。如果我们注入的**脚本文本**(字符串里、注释里都算)出现 `</head>` 这类结构标签字样,排在后面的插件就会把它的脚本元素插进我们的脚本内部,它的闭合标签会提前终止我们的脚本,**剩下的 JS 被浏览器当页面文本渲染到页面上**(按钮消失 + 页面顶部出现一大段源码)。所以 PDF 渲染里的结构标签全部拆开写:`'<sty' + 'le>'`、`'</he' + 'ad>'` 这样;`index.js` 也改成锚定最后一个 head 结束标签。`test-inject.mjs` 的第 3、6 项守住这两点。

## 技术要点

- **菜单挂载**:MutationObserver 监听 DOM,文本匹配"归档会话"菜单项,克隆其 `itemWrap` 注入两项;`data-dsh-handled` 防重,React 每次重建菜单后重新注入
- **sessionId 获取**:React fiber 往上遍历找 `props.sessionId`,降级到 URL / 输入框 fiber 扫描
- **ZIP 解析**:自写迷你解析器读 EOCD + Central Directory + Local Header,用浏览器原生 `DecompressionStream` 解 deflate(方法 8)/ store(方法 0);`media/<attachmentId>.<ext>` 用 `lastIndexOf('.')` 还原 ID
- **event 转换**：只认 `user/message`(且 `source.kind === 'user'`,并按 message id 去重)与 `assistant/message` 与 spliced 的 user 消息;block 层只取 `text` 与 `image`,其余(thinking/tool_use/tool_result/file/未知)全部丢弃;再以 `turn/end` 为边界排成"用户输入 → 该轮最后一条助手回复"的问答对(末尾收尾 flush,打断的回合不丢)。**Markdown 与 PDF 共用这一份 blocks**,只是渲染器不同(`renderMarkdown` / `renderPdfHtml`)
- **PDF 图片**:image block 真实形态为 `{type:'image', attachment:{attachmentId, mediaType,…}}`,与 ZIP 条目按 `attachmentId` 对应;mime 优先取 `attachment.mediaType`;base64 分块编码(≤0x8000)、同一图只编码一次
- **PDF 渲染**:打印专用 HTML 内联 CSS(A4 / 中文字体栈 / 保留换行 / 图片 `max-width:100%`),所有动态文本经 `escapeHtml` 转义

## 依赖

依赖官方 `dsh-session-log-export` 包提供的 `/api/session.export` route(dsh 默认 bundle 自带)。

## 风险

- 菜单 DOM 结构升级后挂载失效 → MutationObserver 容错 + 30 分钟超时;改版后先跑 `test-inject.mjs`
- 脚本文本里出现结构标签字样会劫持链上其他插件的注入锚点 → 结构标签一律拼接写法,由 `test-inject.mjs` 第 3/6 项守住
- V4 event 格式升级 → MD 路径未知 event type 原样保留到 `json` 代码块;PDF 路径未知类型直接忽略(可接受,PDF 本就是精简版)
- 大 session(>50 轮)内存占用 → 一次性读 ZIP,当前够用
- PDF 图片多导致文件大 / 打印慢 → 默认单图 ≤4MB、20 图/消息;CSS 限制显示高度
- PDF 需要用户在打印对话框里选"另存为 PDF"(浏览器沙箱限制,无法一键直存)
