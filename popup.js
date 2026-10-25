const KEY = 'bvh_config';
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get({ [KEY]: { rules: [], debug: false, hideNavPanel: false } }, (cfg) => {
  $('rules').value = (cfg[KEY].rules || []).join('\n');
  $('debug').checked = !!cfg[KEY].debug;
  $('hideNav').checked = cfg[KEY].hideNavPanel === true;
});

$('save').addEventListener('click', () => {
  const rules = $('rules').value.split('\n').map((s) => s.trim()).filter(Boolean);
  chrome.storage.sync.set({ [KEY]: { rules, debug: $('debug').checked, hideNavPanel: $('hideNav').checked } }, () => {
    const tip = $('tip');
    tip.style.display = 'block';
    setTimeout(() => { tip.style.display = 'none'; }, 2000);
  });
});

// 诊断：一键导出顶栏面板结构（文本自动脱敏，链接/图片地址移除）
$('dump').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('bilibili.com')) {
    alert('请先切换到一个B站标签页（并悬停“收藏”让面板出现过）再使用此功能');
    return;
  }
  const extract = () => {
    const wrap = [...document.querySelectorAll('.v-popover-wrap')]
      .find(w => ((w.querySelector('.right-entry__item-trigger,.trigger-text') || {}).textContent || '').replace(/\d+/g, '').trim() === '收藏');
    if (!wrap) return { ok: false, reason: '未找到“收藏”入口（当前页面不是B站顶栏所在页面？）' };
    const panel = wrap.querySelector('.v-popover');
    if (!panel) return { ok: false, reason: '面板尚未挂载：请先悬停顶栏“收藏”让面板展开一次，再点本按钮' };
    const clone = panel.cloneNode(true);
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (t.textContent.trim()) t.textContent = '■'.repeat(Math.min(t.textContent.trim().length, 8));
    }
    clone.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        if (/^(href|src|srcset|data-|title|alt|aria-label)/i.test(attr.name)) el.removeAttribute(attr.name);
      }
    });
    return {
      ok: true,
      url: location.host + location.pathname,
      html: clone.outerHTML.slice(0, 20000),
      cls: panel.className,
    };
  };
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extract });
    const out = $('dumpOut');
    out.style.display = 'block';
    if (!result.ok) {
      out.value = result.reason;
      return;
    }
    const text = JSON.stringify(result, null, 1);
    out.value = text;
    try { await navigator.clipboard.writeText(text); out.value += '\n\n(已自动复制到剪贴板)'; } catch (_) {}
  } catch (e) {
    alert('导出失败：' + e.message);
  }
});
