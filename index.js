// dsh-export-plugin v0.2.0 · 会话导出 Markdown + PDF for DeepSeek Harness Web GUI
// 独立插件: 在会话行"更多"菜单的"归档会话"下方注入"导出 Markdown" / "导出 PDF" 两项,
// 复用官方 /api/session.export ZIP route, 前端解压 + 按 V4 event type 转 Markdown 下载,
// 或渲染打印专用 HTML 到隐藏 iframe 调 window.print 另存为 PDF。
// 纯前端注入 (无后端 endpoint), 零 npm 依赖, 不读 zstd, 不碰 persistence。
import { exportInjectHtml } from './inject.mjs'

export const name = 'dsh-export-plugin'

/**
 * 把导出项的 HTML + CSS + JS 注入到 index.html 的 `</head>` 之前。
 *
 * 锚点取**最后一个** `</head>` 而不是第一个: `webServer.tapIndex` 是链式的, 在我们之前运行的
 * 插件可能已经把内容(含脚本文本)插进来了; 若那段文本里恰好出现 `</head>` 字样, 用第一个匹配
 * 就会把我们的内容插进**别人的 `<script>` 内部**, 对方的 `</script>` 提前闭合后, 剩下的 JS
 * 会被浏览器当 HTML 渲染出来。取最后一个匹配总能落在文档实际的 head 结尾。
 * @param {string} html 原始 index.html
 * @returns {string} 注入后的 html
 */
export function injectAll(html) {
  const matches = [...html.matchAll(/<\/head>/gi)]
  if (matches.length === 0) return html + exportInjectHtml
  const at = matches[matches.length - 1].index
  return html.slice(0, at) + exportInjectHtml + html.slice(at)
}

export function apply(ctx) {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => {
        // 只注入前端, 不注册后端 route (纯前端方案)
        const disposeTap = httpCtx.webServer.tapIndex((html) => injectAll(html))
        return () => {
          try { disposeTap() } catch {}
        }
      },
      'dsh-export-plugin: 注入会话导出 Markdown / PDF 菜单项'
    )
  })
}
