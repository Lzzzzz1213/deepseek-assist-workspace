/* ============================================================
   DeepSeek协助工作区 · 安全 Markdown 消息渲染模块
   作用域：web/markdown.js，只服务主代码传入的 class="wr-markdown" 容器。
   依赖：页面已提前加载本地 markdown-it 15.0.3 UMD（global window.markdownit 为函数）。
        只调用 parser.parse(text, {}) 取 token，不调用 render()，不使用其 HTML 输出。
   安全基线：不使用 innerHTML / outerHTML / insertAdjacentHTML / DOMParser；
        不生成可执行 HTML；无动态脚本、无事件属性；文本一律 textContent / createTextNode；
        元素标签只来自固定 allowlist（token.tag 仅用于 h1-h6 校验）；不复制任意 attrs。
   对外接口：window.WorkroomMarkdown = {
        render(container, raw, options),
        renderPreview(container, raw, options)
      }
        options.onCopyLink(url)：用户点击链接/图片复制按钮时回调，宿主负责剪贴板与提示。
        renderPreview 为长消息折叠态预览；完整解析语义后只生成开头有界 DOM。
        本模块不发起网络请求、不跳转、不执行内容。
   ============================================================ */
(function (global) {
  'use strict';

  var MD_OPTIONS = { html: false, breaks: true, linkify: false, typographer: false, maxNesting: 32 };
  var CTRL = /[\u0000-\u001F\u007F]/;
  var HEADING = /^h([1-6])$/;
  var LANG_WORD = /^[A-Za-z0-9_+#.\-]{1,24}$/;
  var TASK = /^\[( |x|X)\]\s+/;
  var ALIGN_CLASS = {
    'text-align:left': 'wr-md-al-left',
    'text-align:center': 'wr-md-al-center',
    'text-align:right': 'wr-md-al-right'
  };

  /* 预览预算按 walk 实际访问的 token 与 textContent 字符数计算。 */
  var PREVIEW_MAX_TOKENS = 300;
  var PREVIEW_MAX_CHARS = 1200;

  /* 只缓存 parse 后的只读 tokens；不缓存 DOM、options 或回调。 */
  var CACHE_MAX_ENTRIES = 32;
  var CACHE_MAX_CHARS = 1024 * 1024;
  var tokenCache = new Map();
  var tokenCacheChars = 0;

  /* 固定 allowlist：token.type → 允许创建的元素标签与 class */
  var OPEN_TAGS = {
    paragraph_open: ['p', 'wr-md-p'],
    blockquote_open: ['blockquote', 'wr-md-quote'],
    bullet_list_open: ['ul', 'wr-md-ul'],
    ordered_list_open: ['ol', 'wr-md-ol'],
    list_item_open: ['li', 'wr-md-li'],
    table_open: ['table', 'wr-md-table'],
    thead_open: ['thead', 'wr-md-thead'],
    tbody_open: ['tbody', 'wr-md-tbody'],
    tr_open: ['tr', 'wr-md-tr'],
    th_open: ['th', 'wr-md-th'],
    td_open: ['td', 'wr-md-td'],
    strong_open: ['strong', 'wr-md-strong'],
    em_open: ['em', 'wr-md-em'],
    s_open: ['s', 'wr-md-s']
  };

  var parser = null;

  function getParser() {
    if (parser) return parser;
    try {
      if (typeof global.markdownit === 'function') parser = global.markdownit(MD_OPTIONS);
    } catch (err) {
      parser = null;
    }
    return parser;
  }

  function elem(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function textNode(value) {
    return document.createTextNode(value == null ? '' : String(value));
  }

  function attr(token, name) {
    if (!token || typeof token.attrGet !== 'function') return '';
    var value = token.attrGet(name);
    return value == null ? '' : String(value);
  }

  /* 仅接受绝对 http/https、无控制字符、无 username/password 的 URL，其余一律返回 '' */
  function safeUrl(raw) {
    var value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || value.length > 2048 || CTRL.test(value)) return '';
    var parsed;
    try { parsed = new URL(value); } catch (err) { return ''; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  }

  /* 复制按钮：无 href，点击只回调宿主，不跳转 */
  function copyButton(url, ctx, cls, label) {
    var button = elem('button', cls);
    button.type = 'button';
    button.title = url + ' · 点击复制链接';
    if (label) button.textContent = label;
    button.addEventListener('click', function () {
      if (typeof ctx.onCopyLink === 'function') ctx.onCopyLink(url);
    });
    return button;
  }

  function alignClass(token) {
    var style = attr(token, 'style').trim().toLowerCase();
    return ALIGN_CLASS[style] || '';
  }

  /* 开标签 → 元素；未知开标签返回 null（透明容器，内容仍按文本落地） */
  function openFrame(token, ctx) {
    if (token.type === 'table_open') {
      var box = elem('div', 'wr-md-table-scroll');
      var table = elem('table', 'wr-md-table');
      box.appendChild(table);
      return { box: box, node: table };
    }
    if (token.type === 'heading_open') {
      var matched = HEADING.exec(String(token.tag || ''));
      var level = matched ? matched[1] : '1';
      var heading = elem('h' + level, 'wr-md-h wr-md-h' + level);
      return { box: heading, node: heading };
    }
    if (token.type === 'link_open') {
      var href = safeUrl(attr(token, 'href'));
      if (href) {
        var link = copyButton(href, ctx, 'wr-md-link', '');
        return { box: link, node: link };
      }
      var plain = elem('span', 'wr-md-plain-link');
      return { box: plain, node: plain };
    }
    var spec = OPEN_TAGS[token.type];
    if (!spec) return null;
    var node = elem(spec[0], spec[1]);
    if (token.type === 'th_open' || token.type === 'td_open') {
      var align = alignClass(token);
      if (align) node.className = spec[1] + ' ' + align;
    }
    if (token.type === 'ordered_list_open') {
      var start = attr(token, 'start');
      if (/^\d{1,9}$/.test(start)) node.setAttribute('start', String(Number(start)));
    }
    return { box: node, node: node };
  }

  /* 截到预算内，且不把尾部 Unicode 代理对切成两半。 */
  function clipText(value, limit) {
    var text = value == null ? '' : String(value);
    if (limit <= 0) return '';
    if (text.length <= limit) return text;
    var end = limit;
    var last = text.charCodeAt(end - 1);
    var next = text.charCodeAt(end);
    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--;
    return text.slice(0, end);
  }

  /* 完整 render 返回原文；renderPreview 在此扣除可见字符预算。 */
  function visibleText(value, ctx) {
    var text = value == null ? '' : String(value);
    if (!ctx.preview) return text;
    var clipped = clipText(text, ctx.preview.chars);
    ctx.preview.chars -= clipped.length;
    return clipped;
  }

  /* fence / code_block：原样保留 token.content，恒暗、可横向滚动、不执行 */
  function codeBlock(token, ctx) {
    var wrap = elem('div', 'wr-md-code');
    var info = String(token.info || '').trim();
    var first = info ? info.split(/\s+/)[0] : '';
    if (first && LANG_WORD.test(first)) {
      var label = elem('span', 'wr-md-code-label');
      label.textContent = visibleText(first, ctx);
      if (label.textContent) wrap.appendChild(label);
    }
    var pre = elem('pre');
    var code = elem('code');
    code.textContent = visibleText(token.content, ctx);
    pre.appendChild(code);
    wrap.appendChild(pre);
    return wrap;
  }

  /* 图片：不创建 img，只显示替代文字；合法 URL 附复制按钮，不加载任何网络内容 */
  function imageNode(token, ctx) {
    var alt = String(token.content || '');
    if (!alt && token.children && token.children[0] && typeof token.children[0].content === 'string') {
      alt = token.children[0].content;
    }
    var href = safeUrl(attr(token, 'src'));
    // 图片可能嵌在链接里，避免在外层复制按钮中再嵌套交互控件。
    var canCopy = href && !ctx.top().closest('button');
    if (ctx.preview) {
      var overhead = 5 + (canCopy ? 4 : 0); /* “[图片：” + “]” + 可选“复制链接” */
      if (ctx.preview.chars < overhead) return null;
      alt = clipText(alt, ctx.preview.chars - overhead);
      ctx.preview.chars -= overhead + alt.length;
    }
    var wrap = elem('span', 'wr-md-image');
    wrap.appendChild(textNode('[图片：' + alt + ']'));
    if (canCopy) wrap.appendChild(copyButton(href, ctx, 'wr-md-copy', '复制链接'));
    return wrap;
  }

  function appendLeaf(token, ctx) {
    var parent = ctx.top();
    switch (token.type) {
      case 'inline':
        walk(token.children || [], ctx);
        return;
      case 'text':
        parent.appendChild(textNode(visibleText(token.content, ctx)));
        return;
      case 'code_inline':
        var code = elem('code', 'wr-md-code-inline');
        code.textContent = visibleText(token.content, ctx);
        parent.appendChild(code);
        return;
      case 'softbreak':
      case 'hardbreak':
        parent.appendChild(elem('br'));
        return;
      case 'hr':
        parent.appendChild(elem('hr', 'wr-md-hr'));
        return;
      case 'fence':
      case 'code_block':
        parent.appendChild(codeBlock(token, ctx));
        return;
      case 'image':
        var image = imageNode(token, ctx);
        if (image) parent.appendChild(image);
        return;
      default:
        if (typeof token.content === 'string' && token.content) {
          var span = elem('span', 'wr-md-unknown');
          span.textContent = visibleText(token.content, ctx);
          parent.appendChild(span);
        }
        return;
    }
  }

  /*
    按 token 顺序行走，开/闭用栈处理；紧凑列表的隐藏段落只跳过标签、保留 inline 内容。
    preview 模式下 token/字符预算贯穿顶层 tokens、inline.children 与代码内容；
    预算耗尽时停止生成新 DOM，已进入的节点保留在合法父节点中。
  */
  function walk(tokens, ctx) {
    for (var i = 0; i < tokens.length; i++) {
      if (ctx.preview && (ctx.preview.tokens <= 0 || ctx.preview.chars <= 0)) return;
      var token = tokens[i];
      if (ctx.preview) ctx.preview.tokens--;
      if (token.hidden && (token.type === 'paragraph_open' || token.type === 'paragraph_close')) {
        if (token.nesting === 1) {
          ctx.stack.push({ node: ctx.top(), own: false });
        } else if (ctx.stack.length > 1 && ctx.stack[ctx.stack.length - 1].own === false) {
          ctx.stack.pop();
        }
        continue;
      }
      if (token.nesting === 1) {
        var frame = openFrame(token, ctx);
        if (frame) {
          ctx.top().appendChild(frame.box);
          ctx.stack.push({ node: frame.node, own: true });
        } else {
          ctx.stack.push({ node: ctx.top(), own: false });
        }
        continue;
      }
      if (token.nesting === -1) {
        if (ctx.stack.length > 1) ctx.stack.pop();
        continue;
      }
      appendLeaf(token, ctx);
    }
  }

  /* 任务列表：首段开头 [ ] / [x] 显示只读 disabled 复选框，不改源文本，不改其他文字 */
  function decorateTasks(container) {
    var items = container.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      var host = items[i];
      if (host.firstChild && host.firstChild.nodeType === 1 && host.firstChild.tagName === 'P') {
        host = host.firstChild;
      }
      var node = host.firstChild;
      if (!node || node.nodeType !== 3) continue;
      var matched = TASK.exec(node.data);
      if (!matched) continue;
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.disabled = true;
      box.checked = matched[1].toLowerCase() === 'x';
      box.className = 'wr-md-task-cb';
      box.setAttribute('aria-label', box.checked ? '已完成' : '未完成');
      node.data = node.data.slice(matched[0].length);
      host.insertBefore(box, node);
    }
  }

  /* 解析器缺失或被禁止内容导致异常时回退纯文本；预览回退同样受长度预算约束 */
  function plainFallback(container, source, limit) {
    container.textContent = '';
    var box = elem('div', 'wr-md-plain');
    box.textContent = limit == null ? source : clipText(source, limit);
    container.appendChild(box);
  }

  /*
    共享 parse 缓存：LRU 最多 32 项，源字符串合计最多 1048576 个 UTF-16 码元。
    命中时移到队尾；单条超过字符预算仍可正常解析，但不会进入缓存。
    缓存 tokens 只读，renderPreview 不剪裁 token.content / inline.children。
  */
  function cachedParse(active, source) {
    var hit = tokenCache.get(source);
    if (hit) {
      tokenCache.delete(source);
      tokenCache.set(source, hit);
      return hit.tokens;
    }
    var tokens = active.parse(source, {});
    if (!Array.isArray(tokens)) throw new Error('token 列表异常');
    if (source.length <= CACHE_MAX_CHARS) {
      while (tokenCache.size && (tokenCache.size >= CACHE_MAX_ENTRIES || tokenCacheChars + source.length > CACHE_MAX_CHARS)) {
        var oldestKey = tokenCache.keys().next().value;
        var oldest = tokenCache.get(oldestKey);
        tokenCache.delete(oldestKey);
        tokenCacheChars -= oldest.chars;
      }
      tokenCache.set(source, { tokens: tokens, chars: source.length });
      tokenCacheChars += source.length;
    }
    return tokens;
  }

  function makeContext(container, options, preview) {
    var copier = null;
    if (options && typeof options.onCopyLink === 'function') copier = options.onCopyLink;
    var ctx = { onCopyLink: copier, stack: [{ node: container, own: true }], preview: preview };
    ctx.top = function () { return ctx.stack[ctx.stack.length - 1].node; };
    return ctx;
  }

  function render(container, raw, options) {
    if (!container) return;
    var source = raw == null ? '' : String(raw);
    container.textContent = '';
    var ctx = makeContext(container, options, null);
    try {
      var active = getParser();
      if (!active) throw new Error('markdown-it 未加载');
      var tokens = cachedParse(active, source);
      walk(tokens, ctx);
      decorateTasks(container);
    } catch (err) {
      plainFallback(container, source, null);
    }
  }

  function renderPreview(container, raw, options) {
    if (!container) return;
    var source = raw == null ? '' : String(raw);
    container.textContent = '';
    var ctx = makeContext(container, options, { tokens: PREVIEW_MAX_TOKENS, chars: PREVIEW_MAX_CHARS });
    try {
      var active = getParser();
      if (!active) throw new Error('markdown-it 未加载');
      var tokens = cachedParse(active, source);
      walk(tokens, ctx);
      decorateTasks(container);
    } catch (err) {
      plainFallback(container, source, PREVIEW_MAX_CHARS);
    }
  }

  global.WorkroomMarkdown = { render: render, renderPreview: renderPreview };
})(window);
