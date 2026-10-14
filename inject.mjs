// inject.mjs — 会话导出 Markdown 前端注入
// 导出 exportInjectHtml 字符串, 由 index.js 通过 tapIndex 注入到 index.html </head> 前
// 包含: <style>(按钮样式) + <script> IIFE(MutationObserver + 按钮 + fetch ZIP + 解压 + 转 MD + 下载)
//
// 核心思路: 复用官方 dsh-session-log-export 的 /api/session.export route (返回 ZIP, 内含 canonical JSONL log),
// 前端 fetch 拿 ZIP blob → 浏览器原生 DecompressionStream('deflate-raw') 解压 → 迷你 ZIP 解析器找 session*.jsonl → 按 V4 event type 转 Markdown → Blob 下载。
// 零 npm 依赖, 不读 zstd (官方已用 persistence read handle 解好放进 ZIP), 不碰 persistence。
// CSS 类全部加 dsh-export- 前缀; 按钮挂到官方"更多操作"按钮 (aria-label=更多操作/More actions) 旁。

export const exportInjectHtml = `
<style id="dsh-export-style">
.dsh-export-btn {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 9999;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 36px;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, #d8e0ec);
  border-radius: 18px;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsh-alias-label-primary, #1a2f45);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  font-family: inherit;
  box-shadow: 0 2px 8px rgba(0,0,0,0.14);
  transition: background .12s ease, color .12s ease, box-shadow .12s ease;
  user-select: none;
  backdrop-filter: blur(6px);
}
.dsh-export-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  box-shadow: 0 4px 12px rgba(0,0,0,0.18);
}
.dsh-export-btn:active {
  background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.10));
}
.dsh-export-btn:disabled {
  cursor: default;
  opacity: .6;
}
.dsh-export-btn[data-state="loading"] {
  color: var(--dsw-alias-brand-primary, #2f6fed);
}
.dsh-export-btn[data-state="success"] {
  color: #2f9e44;
}
.dsh-export-btn[data-state="error"] {
  color: var(--dsw-alias-state-error-primary, #d6453e);
}
.dsh-export-toast {
  position: fixed;
  z-index: 10001;
  right: 16px;
  bottom: 16px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsh-alias-label-primary, #1a2f45);
  border: 1px solid var(--dsw-alias-border-l2, #d8e0ec);
  box-shadow: 0 8px 24px rgba(0,0,0,0.16);
  font-family: inherit;
  font-size: 13px;
  max-width: 360px;
  backdrop-filter: blur(6px);
}
.dsh-export-toast[data-kind="error"] {
  border-color: var(--dsw-alias-state-error-primary, #d6453e);
  color: var(--dsh-alias-state-error-primary, #d6453e);
}
.dsh-export-toast[data-kind="success"] {
  border-color: #2f9e44;
  color: #2f9e44;
}
</style>
<script>
(function() {
  console.log('[dsh-export] 脚本已加载, 监听"归档会话"菜单项注入"导出 Markdown" / "导出 PDF"');
  // 官方 route: /api/session.export?sessionId=<id>&includeDescendants=true|false (document-relative)
  var EXPORT_ROUTE = '/api/session.export';
  // media 条目扩展名 → mime 兜底表 (真实 mime 优先取 block.attachment.mediaType)
  var MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  // 16x16 菜单图标 (与官方菜单 svg viewBox="0 0 16 16" 匹配, stroke 继承 currentColor)
  var ICON_MD = '<path d="M8 2v7" stroke="currentColor" stroke-linecap="round"/><polyline points="5 6 8 9 11 6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M2 12h12" stroke="currentColor" stroke-linecap="round"/>';
  var ICON_PDF = '<rect x="2.5" y="6" width="11" height="6" rx="1" fill="none" stroke="currentColor"/><path d="M5 6V3h6v3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10h6" fill="none" stroke="currentColor" stroke-linecap="round"/>';
  var inFlight = new Set(); // 正在导出的 sessionId, 防重复点击

  // ========== 找"归档对话"菜单项, 在其后注入"导出 Markdown" + "导出 PDF" ==========
  // 会话行菜单里有"归档会话"项; 克隆它的 itemWrap, 把两个导出项插到归档项后面。菜单是 React 渲染的, 每次打开都重建,
  // 所以 MutationObserver 持续监听重新注入 (用 data 标记避免重复)。
  function mountMenuItems() {
    var items = findArchiveMenuItems();
    for (var i = 0; i < items.length; i++) {
      try { injectExportItems(items[i]); } catch (e) { console.warn('[dsh-export] 注入失败:', e); }
    }
  }

  function findArchiveMenuItems() {
    var items = [];
    var seen = new Set();
    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      var t = (sp.textContent || '').trim();
      if (t !== '归档会话' && t !== '取消归档') continue;
      var item = sp.closest ? (sp.closest('[role="menuitem"], [role="menuitemradio"], li') || sp.closest('button')) : null;
      if (!item) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      if (item.dataset.dshHandled === '1') continue;
      items.push(item);
    }
    return items;
  }

  // 一次注入两个菜单项 (导出 Markdown + 导出 PDF)。两个 clone 都以原始 itemWrap 为源,
  // 第二个不能以第一个 clone 为源 (否则会带上 dshExportItem 标记)。
  function injectExportItems(archiveItem) {
    archiveItem.dataset.dshHandled = '1';
    var itemWrap = archiveItem.closest('div') || archiveItem.parentElement;
    if (!itemWrap || !itemWrap.parentNode) return;
    var ref = injectMenuItem(archiveItem, itemWrap, '导出 Markdown', ICON_MD, 'md', itemWrap);
    injectMenuItem(archiveItem, itemWrap, '导出 PDF', ICON_PDF, 'pdf', ref);
  }

  // 从原始 itemWrap 克隆一个菜单项: 换图标 + 换文字 + 去快捷键 + 绑点击, 插到 refNode 后面
  function injectMenuItem(archiveItem, itemWrap, label, iconSvgPath, kind, refNode) {
    // 外层 div.itemWrap 才是菜单行的布局单元 (position:relative), 必须整行克隆,
    // 否则两个 button 会挤在同一个 itemWrap 里, 结构与其他菜单项不一致。
    var clone = itemWrap.cloneNode(true);
    clone.dataset.dshExportItem = '1';
    var oldBtn = clone.querySelector('[data-dsh-handled]');
    if (oldBtn) oldBtn.removeAttribute('data-dsh-handled');
    var btn = clone.querySelector('button[role="menuitem"]') || clone.querySelector('button') || clone;
    if (btn.id) btn.id = '';
    btn.dataset.dshExportItem = '1';
    // 替换 svg 图标路径, 16x16 viewBox 匹配, 与其它菜单项完全对齐
    var svgs = clone.querySelectorAll('svg');
    for (var s = 0; s < svgs.length; s++) {
      svgs[s].innerHTML = iconSvgPath;
    }
    var shortcuts = clone.querySelectorAll('[class*="shortcut"], [class*="Shortcut"]');
    for (var k = 0; k < shortcuts.length; k++) shortcuts[k].remove();
    // 改文字: 优先命中 label span (CSS module 类名含 itemLabel), 兜底改首个文本节点
    var labelEl = clone.querySelector('[class*="itemLabel"]');
    if (labelEl) {
      labelEl.textContent = label;
    } else {
      var walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
      var first = walker.nextNode();
      if (first) { first.nodeValue = label; var rest; while ((rest = walker.nextNode())) rest.nodeValue = ''; }
      else clone.textContent = label;
    }
    btn.dataset.dshLabel = label;
    btn.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      onClickExport(btn, archiveItem, kind);
    });
    itemWrap.parentNode.insertBefore(clone, refNode.nextSibling);
    return clone;
  }

  async function onClickExport(itemEl, sourceItem, kind) {
    if (itemEl.dataset.dshLoading === '1') return;
    var sid = findSessionIdFromFiber(sourceItem) || findSessionIdFromFiber(itemEl) || getSessionId();
    if (!sid) { showToast('未能定位当前 Session ID, 请打开一个对话后再试', 'error'); return; }
    if (inFlight.has(sid)) return;
    inFlight.add(sid);
    var label = itemEl.dataset.dshLabel || '导出';
    setItemState(itemEl, 'loading', '导出中...');
    try {
      if (kind === 'pdf') {
        await exportSessionPdf(sid);
      } else {
        await exportSessionMarkdown(sid);
      }
      setItemState(itemEl, 'success', '✓ 已导出');
      setTimeout(function() { setItemState(itemEl, 'idle', label); }, 2000);
    } catch (err) {
      console.error('[dsh-export] 导出失败:', err);
      setItemState(itemEl, 'error', '✗ 失败');
      showToast('导出失败: ' + (err && err.message || String(err)), 'error');
      setTimeout(function() { setItemState(itemEl, 'idle', label); }, 3000);
    } finally {
      inFlight.delete(sid);
    }
  }

  // Markdown 导出: 与 PDF 共用同一套"极简问答对"(只有用户输入 + 该轮最后一条助手可见回复),
  // 不再导出工具调用 / 工具结果 / 系统提示 / 思考过程。
  async function exportSessionMarkdown(sessionId) {
    var res = await fetch(EXPORT_ROUTE + '?sessionId=' + encodeURIComponent(sessionId) + '&includeDescendants=false', { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var bytes = new Uint8Array(await res.arrayBuffer());
    var logText = await extractSessionLogText(bytes);
    if (!logText) throw new Error('ZIP 内未找到 session 日志文件');
    // 传空 mediaMap: Markdown 只出文字, 图片位置留 [图片] 占位, 不做 base64 内嵌
    var parsed = jsonlToBlocks(logText, new Map(), sessionId);
    if (!parsed.blocks.length) throw new Error('该会话没有可导出的用户消息或助手回复');
    downloadMarkdown(renderMarkdown(parsed.meta, parsed.blocks), 'session-' + sanitizeFilename(sessionId) + '.md');
  }

  function setItemState(el, state, text) {
    el.dataset.dshState = state;
    el.dataset.dshLoading = state === 'loading' ? '1' : '';
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var first = walker.nextNode();
    if (first) { first.nodeValue = text; var rest; while((rest = walker.nextNode())) rest.nodeValue = ''; }
    else el.textContent = text;
  }

  function getSessionId() {
    // 策略1 URL
    var m = location.pathname.match(/session[/-]([A-Za-z0-9_-]{6,})/i);
    if (m) return m[1];
    var q = new URLSearchParams(location.search).get('sessionId');
    if (q) return q;
    // 策略2 输入框
    var ed = document.querySelector('[contenteditable="true"][data-composer-placeholder]') || document.querySelector('[contenteditable="true"]');
    if (ed) {
      var sid = findSessionIdFromFiber(ed);
      if (sid) return sid;
    }
    // 策略3 主区域
    var roots = document.querySelectorAll('[role="log"], [class*="conversation"], [class*="session"], main, [class*="chat"]');
    for (var i = 0; i < roots.length; i++) {
      var sid2 = findSessionIdFromFiber(roots[i]);
      if (sid2) return sid2;
    }
    return null;
  }

  function findSessionIdFromFiber(el) {
    for (var n = el; n; n = n.parentElement) {
      var keys = n ? Object.getOwnPropertyNames(n) : [];
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber') === 0 || keys[i].indexOf('__reactInternal') === 0) {
          var fiber = n[keys[i]];
          var sid = walkFiber(fiber);
          if (sid) return sid;
        }
      }
      for (var j = 0; j < keys.length; j++) {
        if (keys[j].indexOf('__reactProps$') === 0) {
          var p = n[keys[j]];
          if (p && (p.sessionId || p.sessionId === 0)) return String(p.sessionId);
        }
      }
    }
    return null;
  }

  function walkFiber(fiber) {
    for (var i = 0, f = fiber; i < 40 && f; i++, f = f.return) {
      var p = f.memoizedProps;
      if (!p) continue;
      if (p.sessionId || p.sessionId === 0) return String(p.sessionId);
      if (p.session && p.session.id) return String(p.session.id);
    }
    return null;
  }

  function extractSessionLogText(bytes) {
    // ZIP 迷你解析器: EOCD → 读 Central Directory 找根 session*.jsonl, 本地解 deflate
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1; var minScan = Math.max(0, bytes.length - 65536);
    for (var i = bytes.length - 22; i >= minScan; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.resolve(null);
    var cdOffset = dv.getUint32(eocd + 16, true);
    var cdCount = dv.getUint16(eocd + 10, true);
    var p = cdOffset;
    var logEntry = null;
    for (var k = 0; k < cdCount; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) continue;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var localOff = dv.getUint32(p + 42, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var cname = '';
      for (var c = 0; c < nameLen; c++) cname += String.fromCharCode(bytes[p + 46 + c]);
      if (cname.indexOf('/') === -1 && /^session(\\.v\\d+)?\\.jsonl$/i.test(cname)) {
        var lo = localOff;
        if (dv.getUint32(lo, true) === 0x04034b50) {
          var lNameLen = dv.getUint16(lo + 26, true);
          var lExtraLen = dv.getUint16(lo + 28, true);
          var dataOff = lo + 30 + lNameLen + lExtraLen;
          var compBytes = bytes.subarray(dataOff, dataOff + compSize);
          var dec = method === 0 ? Promise.resolve(compBytes) : (method === 8 ? inflateRaw(compBytes) : null);
          if (dec) {
            logEntry = dec;
            break;
          }
        }
      }
      p += 46 + nameLen + extraLen + dv.getUint16(p + 32, true);
    }
    if (!logEntry) return Promise.resolve(null);
    return logEntry.then(function(d) { return new TextDecoder('utf-8').decode(d); });
  }

  function inflateRaw(compBytes) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('浏览器不支持 DecompressionStream'));
    var ds = new DecompressionStream('deflate-raw');
    var w = ds.writable.getWriter();
    var r = ds.readable.getReader();
    w.write(compBytes).then(function() { w.close(); }).catch(function(e) { r.cancel(e); });
    return new Promise(function(resolve, reject) {
      var arr = [];
      (function pump() {
        r.read().then(function(it) {
          if (it.done) {
            var total = 0; for(var i=0;i<arr.length;i++) total += arr[i].length;
            var out = new Uint8Array(total);
            var o = 0; for(var j=0;j<arr.length;j++) { out.set(arr[j], o); o += arr[j].length; }
            resolve(out);
          } else {
            arr.push(it.value);
            pump();
          }
        }).catch(reject);
      })();
    });
  }

  function jsonlToMarkdown(text, fallbackId) {
    var lines = text.split('\\n');
    var md = [];
    var sid = fallbackId;
    var createdAt = ''; var cwd = '';
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      var ev;
      try { ev = JSON.parse(l); } catch (e) { continue; }
      if (!ev || typeof ev !== 'object') continue;
      // header line
      if (ev.type === 'session') {
        if (ev.id) sid = String(ev.id);
        if (ev.createdAt) createdAt = String(ev.createdAt);
        if (ev.cwd) cwd = String(ev.cwd);
        continue;
      }
      // dispatch per type
      var t = ev.type;
      var d = ev.data || {};
      if (t === 'user/message' || t === 'assistant/message' || t === 'system/message' || t === 'developer/message') {
        var role3 = t.split('/')[0];
        var icon = role3 === 'user' ? '👤 User' : role3 === 'assistant' ? '🤖 Assistant' : role3 === 'system' ? '🖥️ System Prompt' : '🛠️ Developer';
        var msg3 = d.message || (d.content ? {content:d.content} : d);
        var cnt = extractContent(msg3);
        if (!cnt) continue;
        var part = '## ' + icon + '\\n\\n' + cnt;
        if (t === 'assistant/message' && (d.usage || ev.usage)) part += '\\n\\n<sub>tokens: ' + JSON.stringify(d.usage||ev.usage) + '<\/sub>';
        md.push(part);
      } else if (t === 'tool/call') {
        md.push('### 🔧 Tool Call: \`' + (d.name||ev.name||'?') + '\`\\n\\n\`callId: ' + (d.callId||ev.callId||'?') + '\`\\n\\n\`\`\`json\\n' + prettyJson(d.arguments||ev.arguments) + '\\n\`\`\`');
      } else if (t === 'tool/result') {
        var tr = '### 🔧 Tool Result';
        if (d.error||ev.error) tr += ' (ERROR: ' + (d.error.name||'?') + ')';
        var trc = extractContent(d.message||ev.message||d);
        if (!trc) continue;
        md.push(tr + '\\n\\n' + trc);
      } else if (t === 'agent/inbox/spliced') {
        var ins = d.inserted||[];
        for (var j = 0; j < ins.length; j++) {
          var m = ins[j];
          if (!m || !m.content) continue;
          var role = m.role||'user';
          var icon2 = role === 'user' ? '👤 User' : role === 'assistant' ? '🤖 Assistant' : '🛠️ ' + role;
          var blocks = Array.isArray(m.content) ? m.content : [{type:'text', text: String(m.content)}];
          var t2 = blocksToText(blocks);
          md.push('## ' + icon2 + '\\n\\n' + (t2||'_(空)_'));
        }
      } else if (!(t === 'permission/preset' || t === 'sandbox/mode' || t === 'approval/policy' || t === 'agent-preset/selected' || t === 'session/title' || t === 'session/title-llm-request' || t === 'session/end-seed' || t === 'session/end' || t === 'turn/start' || t === 'turn/end' || t === 'step/start' || t === 'step/end' || t === 'request/header' || t === 'request/context' || t === 'assistant/attempt')) {
        md.push('[unknown event type: ' + t + ']\\n\`\`\`json\\n' + safeJson(ev) + '\\n\`\`\`');
      }
    }
    var out = [];
    out.push('# Session ' + sid);
    out.push('');
    if (createdAt) out.push('- Created: ' + createdAt);
    if (cwd) out.push('- Workspace: \`' + cwd + '\`');
    out.push(''); out.push('---'); out.push('');
    return out.concat(md).join('\\n\\n');
  }

  function extractContent(msg) {
    if (msg == null) return '_(空)_';
    if (typeof msg === 'string') return msg;
    if (typeof msg.content === 'string') return msg.content;
    if (typeof msg.text === 'string') return msg.text;
    if (Array.isArray(msg.content)) return blocksToText(msg.content);
    if (Array.isArray(msg)) return blocksToText(msg);
    var parts = [];
    if (Array.isArray(msg.content)) parts.push(blocksToText(msg.content));
    if (Array.isArray(msg.toolCalls)) {
      for (var i = 0; i < msg.toolCalls.length; i++) {
        var tc = msg.toolCalls[i];
        parts.push('\\n\\n**Tool Call: \`' + (tc.name||(tc.function&&tc.function.name)||'?') + '\`**\\n\`\`\`json\\n' + prettyJson(tc.arguments || (tc.function&&tc.function.arguments)) + '\\n\`\`\`');
      }
    }
    if (parts.length) return parts.join('');
    return '\`\`\`json\\n' + safeJson(msg) + '\\n\`\`\`';
  }

  function blocksToText(arr) {
    var s = [];
    for (var i=0;i<arr.length;i++) {
      var b = arr[i];
      if (!b||typeof b!=='object') continue;
      var t = b.type||b.kind;
      if (t === 'text' || (b.text && !t)) {
        if (typeof b.text === 'string') s.push(b.text);
      } else if (t === 'tool_use') {
        s.push('\\n\\n**Tool Use: \`' + (b.name||'?') + '\`**\\n\`\`\`json\\n' + prettyJson(b.input||b.arguments) + '\\n\`\`\`');
      } else if (t === 'tool_result' || t === 'toolResult') {
        var rc = b.content;
        if (Array.isArray(rc)) s.push('\\n\\n**Tool Result:**\\n' + blocksToText(rc));
        else if (typeof rc === 'string') s.push('\\n\\n**Tool Result:**\\n' + rc);
        else s.push('\\n\\n**Tool Result:**\\n\`\`\`json\\n' + safeJson(b) + '\\n\`\`\`');
      } else if (t === 'image' || t === 'image_url') {
        s.push('\\n\\n_[图片: ' + (b.source&&b.source.media_type || b.image_url&&b.image_url.url || 'omitted') + ']_');
      } else if (t === 'thinking' || t === 'reasoning') {
        if (typeof b.thinking === 'string') s.push('<details><summary>思考过程<\/summary>\\n\\n' + b.thinking + '\\n\\n<\/details>');
        else if (typeof b.text === 'string') s.push('<details><summary>思考过程<\/summary>\\n\\n' + b.text + '\\n\\n<\/details>');
      } else {
        s.push('\\n\\n\`\`\`json\\n' + safeJson(b) + '\\n\`\`\`');
      }
    }
    return s.join('');
  }

  function prettyJson(x) {
    if (x == null) return '';
    if (typeof x === 'string') { try { return JSON.stringify(JSON.parse(x), null, 2); } catch(e) { return x; } }
    try { return JSON.stringify(x, null, 2); } catch(e) { return String(x); }
  }

  function safeJson(x) { try { return JSON.stringify(x, null, 2); } catch(e) { return String(x); } }

  function downloadMarkdown(text, filename) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = u; a.download = filename; a.click();
    setTimeout(function() { URL.revokeObjectURL(u); }, 1000);
  }

  function sanitizeFilename(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0,64);
  }

  function showToast(msg, kind) {
    var existing = document.querySelector('.dsh-export-toast');
    if (existing) existing.remove();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    var t = document.createElement('div');
    t.className = 'dsh-export-toast';
    t.dataset.kind = kind || 'info';
    t.textContent = msg;
    document.body.appendChild(t);
    toastTimer = setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 4000);
  }
  var toastTimer = null;

  // ========== PDF 导出: 只导"用户输入 + 助手最终输出", 不含思考过程 / 工具调用 / 系统提示 ==========

  // ZIP → { logText, mediaMap: Map<attachmentId, {mime, bytes}> }
  // includeDescendants=false 时 media/* 全部是根 log 引用的图; base64 编码推迟到渲染期。
  async function extractSessionBundle(bytes) {
    var entries = readZipEntries(bytes);
    var logEntry = null;
    for (var i = 0; i < entries.length; i++) {
      var n = entries[i].name;
      if (n.indexOf('/') !== -1) continue;      // 跳过 subagents/ 与 media/
      if (n.indexOf('session') !== 0) continue;
      if (n.slice(-6) !== '.jsonl') continue;
      logEntry = entries[i];
      break;
    }
    if (!logEntry) throw new Error('ZIP 内未找到 session 日志文件');
    var logText = bytesToText(await readEntryData(bytes, logEntry));
    var mediaMap = new Map();
    for (var j = 0; j < entries.length; j++) {
      var mn = entries[j].name;
      if (mn.indexOf('media/') !== 0) continue;
      // attachmentId 可能含 ':' (如 sha256:...), 用 lastIndexOf('.') 还原 ID
      var dot = mn.lastIndexOf('.');
      if (dot <= 6) continue;
      var id = mn.slice(6, dot);
      var ext = mn.slice(dot + 1).toLowerCase();
      try {
        var data = await readEntryData(bytes, entries[j]);
        mediaMap.set(id, { mime: MIME_BY_EXT[ext] || 'application/octet-stream', bytes: data });
      } catch (e) {
        console.warn('[dsh-export] media 条目解压失败, 跳过:', mn, e);
      }
    }
    return { logText: logText, mediaMap: mediaMap };
  }

  // ZIP 中央目录 → 条目数组 (name / method / compSize / localOff)
  function readZipEntries(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    var minScan = Math.max(0, bytes.length - 65536);
    for (var i = bytes.length - 22; i >= minScan; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP: 找不到 EOCD');
    var p = dv.getUint32(eocd + 16, true);
    var count = dv.getUint16(eocd + 10, true);
    var out = [];
    for (var k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var name = '';
      for (var c = 0; c < nameLen; c++) name += String.fromCharCode(bytes[p + 46 + c]);
      out.push({
        name: name,
        method: dv.getUint16(p + 10, true),
        compSize: dv.getUint32(p + 20, true),
        localOff: dv.getUint32(p + 42, true)
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function readEntryData(bytes, entry) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var lo = entry.localOff;
    if (dv.getUint32(lo, true) !== 0x04034b50) return Promise.reject(new Error('ZIP: local header 损坏'));
    var lNameLen = dv.getUint16(lo + 26, true);
    var lExtraLen = dv.getUint16(lo + 28, true);
    var dataOff = lo + 30 + lNameLen + lExtraLen;
    var comp = bytes.subarray(dataOff, dataOff + entry.compSize);
    if (entry.method === 0) return Promise.resolve(comp);
    if (entry.method === 8) return inflateRaw(comp);
    return Promise.reject(new Error('ZIP: 不支持的压缩方法 ' + entry.method));
  }

  function bytesToText(b) { return new TextDecoder('utf-8').decode(b); }

  // JSONL → { meta, blocks }, blocks 只有 {role:'user'|'assistant', text, images}
  // JSONL → { meta, blocks }: 排成"问答对" —— 每条用户输入后面只跟该轮**最后一条**助手可见回复。
  // 配对边界用 turn/end; 日志末尾再收尾 flush 一次, 这样被打断 / 未结束的回合也不会丢内容。
  function jsonlToBlocks(jsonlText, mediaMap, fallbackId) {
    var lines = jsonlText.split('\\n');
    var blocks = [];
    var meta = { sessionId: fallbackId, createdAt: '', cwd: '' };
    var cache = {};
    var seenUserIds = {};      // 用户消息 id → 已导出 (spliced 与 user/message 是同一个 id)
    var pendUsers = [];        // 本轮待配对的用户输入 (可能有多条)
    var lastAssistant = null;  // 本轮最后一条助手可见回复 (工具轮里的过渡文本会被后来的覆盖)
    function flush() {
      for (var u = 0; u < pendUsers.length; u++) blocks.push(pendUsers[u]);
      pendUsers = [];
      if (lastAssistant) { blocks.push(lastAssistant); lastAssistant = null; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var ev;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'session') {
        if (ev.id) meta.sessionId = String(ev.id);
        if (ev.createdAt) meta.createdAt = String(ev.createdAt);
        if (ev.cwd) meta.cwd = String(ev.cwd);
        continue;
      }
      if (ev.type === 'turn/end') { flush(); continue; }
      var block = eventToBlocks(ev, mediaMap, cache, seenUserIds);
      if (!block) continue;
      var list = Array.isArray(block) ? block : [block];
      for (var j = 0; j < list.length; j++) {
        if (list[j].role === 'user') pendUsers.push(list[j]);
        else lastAssistant = list[j];
      }
    }
    flush();
    return { meta: meta, blocks: blocks };
  }

  // 只认 user/message 与 assistant/message (以及被拼接进来的用户输入); 其余事件一律不导出。
  // 两条过滤规则来自真实日志:
  //   1) 用户消息必须 source.kind === 'user' —— runtime-context / skill-catalog / time-context
  //      (以及工作区指令) 这类系统注入也走 user/message, 不滤掉就会冒充用户提问;
  //   2) 同一条用户消息在 agent/inbox/spliced 与 user/message 里各记一次(**同一个 message id**),
  //      用 seenUserIds 去重, 否则每句提问都会出现两遍。
  function eventToBlocks(ev, mediaMap, cache, seenUserIds) {
    var t = ev.type;
    var d = ev.data || {};
    if (t === 'user/message') {
      if (!isUserAuthored(d.source)) return null;
      if (!claimUserMessage(d.id, seenUserIds)) return null;
      var cp = extractContentParts({ content: d.content }, mediaMap, cache);
      if (!cp.text && cp.images.length === 0) return null;
      return { role: 'user', text: cp.text, images: cp.images };
    }
    if (t === 'assistant/message') {
      var ca = extractContentParts(d.message || (d.content ? { content: d.content } : d), mediaMap, cache);
      if (!ca.text && ca.images.length === 0) return null;
      return { role: 'assistant', text: ca.text, images: ca.images };
    }
    if (t === 'agent/inbox/spliced') {
      var out = [];
      var ins = d.inserted || [];
      for (var i = 0; i < ins.length; i++) {
        var m = ins[i];
        if (!m || !m.content) continue;
        if ((m.role || 'user') !== 'user') continue;
        if (!isUserAuthored(m.source)) continue;
        if (!claimUserMessage(m.id, seenUserIds)) continue;
        var bl = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
        var cp2 = blocksToParts(bl, mediaMap, cache);
        if (!cp2.text && cp2.images.length === 0) continue;
        out.push({ role: 'user', text: cp2.text, images: cp2.images });
      }
      return out.length ? out : null;
    }
    return null;
  }

  // 真的是用户敲进来的消息: source.kind === 'user'; source 缺失时保守放行(兼容旧日志/其它形态)
  function isUserAuthored(src) {
    if (!src || typeof src !== 'object') return true;
    return src.kind === 'user';
  }

  // 同一条用户消息只导出一次 (spliced 与 user/message 共用同一个 message id)
  function claimUserMessage(id, seen) {
    if (id == null) return true;
    var key = String(id);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }

  function extractContentParts(msg, mediaMap, cache) {
    if (msg == null) return { text: '', images: [] };
    if (typeof msg === 'string') return { text: msg, images: [] };
    if (typeof msg.content === 'string') return { text: msg.content, images: [] };
    if (typeof msg.text === 'string') return { text: msg.text, images: [] };
    if (Array.isArray(msg.content)) return blocksToParts(msg.content, mediaMap, cache);
    if (Array.isArray(msg)) return blocksToParts(msg, mediaMap, cache);
    return { text: '', images: [] };
  }

  // 只取 text 与 image; thinking/reasoning/tool_use/tool_result/file/未知 block 全部丢弃
  function blocksToParts(blocks, mediaMap, cache) {
    var texts = [];
    var imgs = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      var t = b.type || b.kind;
      if (t === 'text' || (typeof b.text === 'string' && !t)) {
        if (typeof b.text === 'string' && b.text) texts.push(b.text);
      } else if (t === 'image') {
        // V4 真实形态: {type:'image', attachment:{attachmentId, mediaType, ...}}
        var att = b.attachment || {};
        var id = att.attachmentId;
        var entry = id == null ? undefined : mediaMap.get(String(id));
        if (entry && entry.bytes) {
          imgs.push(toDataUrl(String(id), att.mediaType || entry.mime || 'image/png', entry.bytes, cache));
        } else {
          texts.push('[图片]');
        }
      }
    }
    return { text: texts.join('\\n\\n'), images: imgs };
  }

  function bytesToBase64(bytes) {
    // 分块避免 String.fromCharCode 参数过多 / 大数组栈溢出
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // 同一 attachmentId 只编码一次
  function toDataUrl(id, mime, bytes, cache) {
    if (!cache[id]) cache[id] = 'data:' + mime + ';base64,' + bytesToBase64(bytes);
    return cache[id];
  }

  // 所有动态文本必须转义, 否则用户消息里的 </div> 会破坏 srcdoc 排版
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Markdown 极简对话: 与 PDF 共用同一份 blocks, 只有标题 / 角色 / 文本 / 图片占位
  function renderMarkdown(meta, blocks) {
    var out = ['# Session ' + meta.sessionId, ''];
    if (meta.createdAt) out.push('- Created: ' + meta.createdAt);
    if (meta.cwd) out.push('- Workspace: ' + meta.cwd);
    if (meta.createdAt || meta.cwd) out.push('');
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var isUser = b.role === 'user';
      out.push(isUser ? '## 👤 用户' : '## 🤖 助手');
      out.push('');
      if (b.text) out.push(b.text);
      for (var k = 0; k < b.images.length; k++) out.push('![图片](' + b.images[k] + ')');
      out.push('');
    }
    return out.join('\\n');
  }

  // 打印专用 HTML: A4 + 中文字体栈 + 保留换行
  function renderPdfHtml(meta, blocks) {
    // 注意: 下面所有结构标签都必须拆开写 ('<sty' + 'le>' 这种)。
    // 原因: 本串是注入到页面里的脚本正文, 而其他插件的 tapIndex 会拿正则去匹配"第一个 head
    // 结束标签", 把它们的脚本元素插在那个位置。所以我们的脚本正文里一旦出现结构标签字样
    // (字符串里不行, 注释里也不行), 别人的内容就会被引进我们的脚本内部, 让脚本元素提前闭合,
    // 剩下的 JS 会被浏览器当成页面文本渲染出来。test-inject.mjs 用"锚点劫持"用例守住这条约束。
    var h = '';
    h += '<!doctype html><html lang="zh-CN">';
    h += '<meta charset="utf-8">';
    h += '<title>session-' + escapeHtml(meta.sessionId) + '</title>';
    h += '<sty' + 'le>';
    h += '@page { size: A4; margin: 18mm 16mm; }';
    h += 'body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.6; color: #1a2f45; }';
    h += 'h1 { font-size: 17pt; margin: 0 0 4mm; }';
    h += '.meta { color: #667; font-size: 9.5pt; margin-bottom: 6mm; border-bottom: 1px solid #d8e0ec; padding-bottom: 3mm; }';
    h += '.msg { margin: 0 0 6mm; page-break-inside: avoid; }';
    h += '.role { font-weight: 600; font-size: 10pt; margin-bottom: 1.5mm; }';
    h += '.role.user { color: #2f6fed; }';
    h += '.role.assistant { color: #2f9e44; }';
    h += '.text { white-space: pre-wrap; word-break: break-word; }';
    h += 'img { max-width: 100%; max-height: 80mm; margin: 2mm 0; border: 1px solid #d8e0ec; border-radius: 2mm; }';
    h += '</sty' + 'le>';
    h += '<h1>Session ' + escapeHtml(meta.sessionId) + '</h1>';
    var metaLine = '';
    if (meta.createdAt) metaLine += 'Created: ' + escapeHtml(meta.createdAt);
    if (meta.cwd) metaLine += (metaLine ? ' · ' : '') + 'Workspace: ' + escapeHtml(meta.cwd);
    h += '<div class="meta">' + metaLine + '</div>';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var isUser = b.role === 'user';
      h += '<div class="msg"><div class="role ' + (isUser ? 'user' : 'assistant') + '">' + (isUser ? '👤 用户' : '🤖 助手') + '</div>';
      if (b.text) h += '<div class="text">' + escapeHtml(b.text) + '</div>';
      for (var k = 0; k < b.images.length; k++) {
        h += '<img src="' + b.images[k] + '" alt="">';
      }
      h += '</div>';
    }
    h += '</htm' + 'l>';
    return h;
  }

  // PDF 导出: fetch ZIP(不含子代理) → 解 log + media → 只取用户输入与助手最终输出 → 隐藏 iframe 打印
  async function exportSessionPdf(sessionId) {
    var res = await fetch(EXPORT_ROUTE + '?sessionId=' + encodeURIComponent(sessionId) + '&includeDescendants=false', { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var bytes = new Uint8Array(await res.arrayBuffer());
    var bundle = await extractSessionBundle(bytes);
    var parsed = jsonlToBlocks(bundle.logText, bundle.mediaMap, sessionId);
    if (!parsed.blocks.length) throw new Error('该会话没有可导出的用户消息或助手回复');
    var html = renderPdfHtml(parsed.meta, parsed.blocks);
    // 隐藏 iframe: srcdoc 无网络请求、继承同源, contentWindow.print() 可用; 不用 window.open 以免被弹窗拦截
    var iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
    showToast('已打开打印对话框，请选择"另存为 PDF"', 'info');
    iframe.onload = function() {
      setTimeout(function() {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print(); // 同步阻塞至对话框关闭
        } catch (e) {
          console.error('[dsh-export] 打印失败:', e);
        } finally {
          setTimeout(function() { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 60000);
        }
      }, 300);
    };
  }

  mountMenuItems(); // 立即尝试一次 (菜单可能已打开)
  var debounceTimer = null;
  var ob = new MutationObserver(function() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(function() {
      debounceTimer = null;
      mountMenuItems();
    }, 100);
  });
  ob.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(function() { ob.disconnect(); }, 30 * 60 * 1000);
})();
<\/script>
`
