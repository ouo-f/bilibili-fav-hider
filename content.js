/**
 * b站收藏夹助手 · content script
 * 纯本地 DOM 过滤：不发网络请求、不读写 cookie、不调用B站接口，
 * 服务器感知不到本扩展存在 → 无风控风险。
 *
 * 规则存于 chrome.storage.sync 的 bvh_config = { rules, debug, hideNavPanel }
 *   - 文本行（文件夹名关键字）→ 主规则：侧栏条目、收藏弹窗、内容区标题都按名称匹配
 *   - 纯数字行（fid）         → 可选增强：地址栏直链 (?fid=xxx) 秒级拦截、空间页收藏夹卡片
 *
 * 公开收藏夹与B站自带的"私密收藏夹"都适用：两者在你自己登录的浏览器里渲染方式相同。
 *
 * 覆盖五处可见面（基于 2026-09 实测的B站 DOM 校准；manifest 已通配 *.bilibili.com）：
 *   1) 收藏页侧栏条目 .fav-sidebar-item（title 属性=文件夹名，无 fid，按名称匹配）
 *   2) 直链访问被隐藏收藏夹 → 重定向回收藏列表（fid 命中）；
 *      或右侧内容区标题按名称命中时隐藏整列（.favlist-main）
 *   3) 视频页"收藏"弹窗中的文件夹行（按名称，弹窗内条目同样不带 fid）
 *   4) 空间页收藏夹卡片等带 fid 的链接（旧版侧栏也走这条路径）
 *   5) 顶栏"收藏"悬浮面板（syncNavPanel 挂载帧前同步写入 + 过渡门控兜底）
 */
(() => {
  'use strict';

  // ===== B站改版导致失效时，只需调整这些常量 =====
  const FAVLINK_SEL = 'a[href*="favlist"]';      // 预筛；需再校验 pathname 含 /favlist，排除 spm 追踪参数误伤
  const SIDEBAR_ITEM_SEL = '.fav-sidebar-item';  // 收藏页侧栏条目（title 属性=文件夹名）
  const SIDEBAR_GROUP_SEL = '.fav-collapse .vui_collapse_item'; // 侧栏分组（创建的/收藏的/私密）
  const SIDEBAR_NAME_SEL = '.vui_ellipsis';      // 侧栏条目内文件夹名元素
  const CONTENT_TITLE_SEL = '.favlist-info-detail__title'; // 收藏页右侧内容区标题
  const DETAIL_HIDE_SEL = '.favlist-main,.fav-content-main,[class*="fav-content"]'; // 直链兜底隐藏的整列
  const DIALOG_SEL = '[role="dialog"],[class*="modal"],[class*="dialog"],[class*="pop"],[class*="collect"]'; // 弹层候选
  const MODAL_MARKS = ['新建收藏夹', '创建收藏夹']; // 收藏弹窗独有文案（比类名抗改版）
  const NAV_WRAP_SEL = '.v-popover-wrap';          // 页头悬浮入口的公共包裹层（B站 popover 组件）
  const NAV_TRIGGER_SEL = '.right-entry__item-trigger,.trigger-text'; // 入口文字元素
  const NAV_PANEL_SEL = '.v-popover';              // 悬浮面板本体
  const NAV_MARK_CLS = 'bvh-fav-nav';              // 兜底模式下给“收藏”入口打的类
  const NAV_STYLE_ID = 'bvh-nav-style';
  const NAV_CSS = `.${NAV_MARK_CLS} .v-popover{display:none!important}`; // 兜底：面板挂载即隐藏，无闪现
  const ATTR = 'data-bvh-hidden';                // 隐藏标记
  const ROW_MAX_H = 150;                         // “一行”元素最大高度(px)，防止向上合并出过大区域
  const CLIMB_MAX = 8;                           // rowOf 向上查找的最大层数
  const SCAN_MS = 200;                           // 扫描合并间隔(ms)，控制弹幕等高频突变下的开销

  let fids = new Set();
  let texts = [];
  let debug = false;
  let hideNavPanel = true;
  let scanTimer = 0;
  let navSig = '';
  let navSigAt = 0;
  let navWritesTimer = 0;

  const log = (...a) => { if (debug) console.log('[收藏夹隐藏]', ...a); };

  // ---------- 基础工具 ----------
  const isListContainer = (el) =>
    /^(UL|OL|MENU)$/.test(el.tagName) ||
    (/(list|nav|menu)/i.test(el.className || '') && !/item/i.test(el.className || ''));

  // 从链接/文本元素向上找到“整行”节点；stop 为弹窗根，防止爬出弹窗
  function rowOf(el, stop) {
    let cur = el;
    for (let i = 0; i < CLIMB_MAX; i++) {
      const p = cur.parentElement;
      if (!p || p === document.body || p === document.documentElement || p === stop) return cur;
      if (isListContainer(p)) return cur;
      if (p.clientHeight > ROW_MAX_H) return cur;
      cur = p;
    }
    return cur;
  }

  function hide(el, why) {
    if (!el || el === document.body || el === document.documentElement) return;
    if (el.hasAttribute(ATTR)) return;
    el.style.setProperty('display', 'none', 'important');
    el.setAttribute(ATTR, why);
    log('隐藏', why, el);
  }

  function unhideAll() {
    for (const el of document.querySelectorAll(`[${ATTR}]`)) {
      el.style.removeProperty('display');
      el.style.removeProperty('visibility');
      el.removeAttribute(ATTR);
    }
  }

  // 面板内专用：visibility 隐藏不改布局。display:none 会使面板收缩，
// 触发B站列表组件重渲染 → 新条目 → 再隐藏的死循环（实测日志连发160次），搅坏展开机制
  function hideSoft(el, why) {
    if (!el || el === document.body || el === document.documentElement) return;
    if (el.hasAttribute(ATTR)) return;
    el.style.setProperty('visibility', 'hidden', 'important');
    el.setAttribute(ATTR, why);
    log('隐藏(软)', why, el);
  }

  const hitText = (t) => !!t && texts.some((k) => t.includes(k));

  // ---------- 1) 收藏页侧栏条目（新版：div.fav-sidebar-item，title=文件夹名） ----------
  function scanSidebar() {
    if (!texts.length) return;
    for (const item of document.querySelectorAll(SIDEBAR_ITEM_SEL)) {
      if (item.hasAttribute(ATTR)) continue;
      const nameEl = item.querySelector(SIDEBAR_NAME_SEL);
      const name = ((item.getAttribute('title') || (nameEl || item).textContent) || '').trim();
      if (hitText(name)) hide(item, 'side:' + name);
    }
    // 分组内条目全部被隐藏时，把分组标题一并隐藏（如“私密收藏”整组消失）
    for (const g of document.querySelectorAll(SIDEBAR_GROUP_SEL)) {
      const items = g.querySelectorAll(SIDEBAR_ITEM_SEL);
      if (!items.length || g.hasAttribute(ATTR)) continue;
      let all = true;
      for (const it of items) if (!it.hasAttribute(ATTR)) { all = false; break; }
      if (all) hide(g, 'group');
    }
  }

  // ---------- 2) 直链 (?fid=xxx) 与内容区标题 ----------
  function scanDetail() {
    if (!location.pathname.includes('/favlist')) return;
    const m = location.search.match(/[?&]fid=(\d+)/);
    if (m && fids.has(m[1])) {
      // fid 命中：重定向回收藏列表；本会话已重定向过（SPA 又自动选回该文件夹）则退化为隐藏内容区
      if (!sessionStorage.getItem('bvh_r_' + m[1])) {
        sessionStorage.setItem('bvh_r_' + m[1], '1');
        const uid = (location.pathname.match(/^\/(\d+)/) || [])[1];
        log('直链命中 fid=' + m[1] + '，重定向回收藏列表');
        location.replace(uid ? `https://space.bilibili.com/${uid}/favlist` : 'https://www.bilibili.com/');
        return;
      }
    }
    if (!texts.length) return;
    const t = document.querySelector(CONTENT_TITLE_SEL);
    const name = (t ? t.textContent : '').trim();
    if (hitText(name)) {
      for (const el of document.querySelectorAll(DETAIL_HIDE_SEL)) hide(el, 'detail:' + name);
    }
  }

  // ---------- 3) 视频页收藏弹窗：按特征文案定位弹窗，再按名称隐藏行 ----------
  function scanModal() {
    if (!texts.length) return;
    for (const dlg of document.querySelectorAll(DIALOG_SEL)) {
      // 顶栏悬浮面板不是收藏弹窗：面板内的“新建收藏夹”按钮会误触此逻辑，
      // 且行归并可能爬升到面板祖先上，用内联样式永久压住面板 → 悬停再也无法展开
      if (dlg.closest('.v-popover-wrap')) continue;
      const txt = dlg.textContent || '';
      if (!MODAL_MARKS.some((mk) => txt.includes(mk))) continue;
      for (const leaf of dlg.querySelectorAll('*')) {
        if (leaf.childElementCount) continue;
        const t = (leaf.textContent || '').trim();
        if (!hitText(t)) continue;
        hide(rowOf(leaf, dlg), 'modal:' + t);
      }
    }
  }

  // ---------- 4) 带 fid 的收藏夹链接（空间页卡片/旧版侧栏），同时按链接文本兜底 ----------
  function scanFavLinks() {
    for (const a of document.querySelectorAll(FAVLINK_SEL)) {
      // 顶栏悬浮面板内的条目统一交给 scanNavPanel（带过渡门控），此处跳过避免过渡期写入
      if (a.closest(NAV_WRAP_SEL)) continue;
      let u = null;
      try { u = new URL(a.href, location.origin); } catch (_) { continue; }
      const isFavPath = u.pathname.includes('/favlist') || u.hash.includes('/favlist');
      if (!isFavPath) continue; // 排除 spm_id_from=...favlist... 追踪参数的误伤
      const fid = u.searchParams.get('fid') || (u.hash.match(/fid=(\d+)/) || [])[1] || null;
      if (fid && fids.has(fid)) { hide(rowOf(a), 'fid:' + fid); continue; }
      if (texts.length) {
        const t = (a.textContent || '').trim();
        if (hitText(t)) hide(rowOf(a), 'text:' + t);
      }
    }
  }

  // ---------- 5) 顶栏“收藏”悬浮面板：左侧一列收藏夹名 + 右侧视频预览 ----------
  function navFavWrap() {
    // 入口文字可能带数字角标（如“收藏 3”），去掉数字再比对，避免精确匹配落空
    for (const wrap of document.querySelectorAll(NAV_WRAP_SEL)) {
      const trig = wrap.querySelector(NAV_TRIGGER_SEL);
      if (!trig) continue;
      if ((trig.textContent || '').replace(/\d+/g, '').trim() !== '收藏') continue;
      return wrap;
    }
    return null;
  }

  // CSS 规则全程注入，靠类开关：兜底模式下面板一挂载即被隐藏，无悬停闪现
  function ensureNavCss() {
    if (document.getElementById(NAV_STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = NAV_STYLE_ID;
    st.textContent = NAV_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // 面板内写入（精准结构，2026-09 用户导出实测）：左列 .tab-item 条目 + 右侧预览区联动
  function applyNavHides(panel) {
    const nav = panel.querySelector('.favorite-panel-popover__nav');
    if (!nav) return;
    let hiddenCount = 0;
    for (const tab of nav.querySelectorAll('.tab-item')) {
      const name = ((tab.querySelector('.tab-item__title') || {}).textContent || '').trim();
      if (!name || !hitText(name) || tab.hasAttribute(ATTR)) continue;
      hideSoft(tab, 'nav:' + name);
      hiddenCount++;
    }
    if (hiddenCount) log('面板内隐藏了', hiddenCount, '个收藏夹');
    // 选中的收藏夹被隐藏时，右侧预览区展示的就是它的视频 → 软隐藏预览区（切换到未隐藏收藏夹后自动恢复）
    const preview = panel.querySelector('.favorite-panel-popover__content');
    if (!preview) return;
    const activeName = ((nav.querySelector('.tab-item--active .tab-item__title') || {}).textContent || '').trim();
    if (activeName && hitText(activeName)) {
      if (!preview.hasAttribute(ATTR)) { hideSoft(preview, 'navpreview'); log('选中项命中隐藏规则，隐藏其视频预览区'); }
    } else if (preview.getAttribute(ATTR) === 'navpreview') {
      preview.style.removeProperty('visibility');
      preview.removeAttribute(ATTR);
      log('切换到未隐藏收藏夹，恢复预览区');
    }
  }

  // 同步路径：在观察器回调（微任务阶段，早于下一帧渲染）直接写入，
  // 面板第一帧出现时条目就已隐形——展开动画期间也看不到。
  // 安全性：写入只触及子元素(.tab-item)且用不改布局的 visibility；
  // 展开动画类只作用在面板根节点，互不干扰（旧版事故均源于祖先误写/display 抖动/归并错层）。
  function syncNavPanel() {
    const wrap = navFavWrap();
    if (!wrap) return;
    if (hideNavPanel) { wrap.classList.add(NAV_MARK_CLS); return; }
    if (!texts.length) return;
    const panel = wrap.querySelector(NAV_PANEL_SEL);
    if (panel) applyNavHides(panel);
  }

  function scanNavPanel() {
    ensureNavCss();
    const wrap = navFavWrap();
    if (!wrap) return;
    if (hideNavPanel) {
      // 兜底：入口打类 → 面板挂载即被 CSS 隐藏
      wrap.classList.add(NAV_MARK_CLS);
      return;
    }
    wrap.classList.remove(NAV_MARK_CLS);
    const panel = wrap.querySelector(NAV_PANEL_SEL);
    if (!panel || !texts.length) return;
    // 兜底扫描路径：常规场景已由 syncNavPanel 在挂载帧前写入，此处仅覆盖
    // 规则变更等无新突变的时机；仍保留过渡门控作为保守兜底。
    const sig = panel.className + '|' + (panel.getAttribute('style') || '');
    const now = Date.now();
    if (/-(enter|leave)-(from|active|to)/.test(panel.className)) { navSig = sig; navSigAt = now; }
    if (sig !== navSig) { navSig = sig; navSigAt = now; }
    const wait = navSigAt + 150 - now;
    if (wait > 0) {
      // 保证到点复检（页面此后无突变也要能写入）
      if (!navWritesTimer) navWritesTimer = setTimeout(() => { navWritesTimer = 0; scan(); }, wait + 30);
      return;
    }
    if (/-(enter|leave)-(from|active|to)/.test(panel.className)) { navSigAt = now; return; }
    applyNavHides(panel);
  }

  function scan() {
    try { scanSidebar(); scanDetail(); scanModal(); scanFavLinks(); scanNavPanel(); }
    catch (e) { log('扫描出错', e); }
  }

  // ---------- 配置与调度 ----------
  function applyConfig(cfg) {
    const list = cfg && Array.isArray(cfg.rules) ? cfg.rules : [];
    fids = new Set();
    texts = [];
    for (const raw of list) {
      const s = String(raw).trim();
      if (!s) continue;
      if (/^\d+$/.test(s)) fids.add(s);
      else texts.push(s);
    }
    debug = !!(cfg && cfg.debug);
    // 顶栏收藏面板：默认精准隐藏（只藏命中的条目）；勾选兜底开关才整体隐藏面板
    hideNavPanel = !!(cfg && cfg.hideNavPanel);
    log('规则更新', { fids: [...fids], texts, debug, hideNavPanel });
    unhideAll();
    scan();
  }

  // B站是 SPA，内容动态渲染；弹幕等高频突变用定时器合并，扫描本身只有几个轻量 querySelectorAll
  const mo = new MutationObserver(() => {
    // 面板挂载的同一微任务里同步隐藏（早于下一帧渲染），连展开动画期间都不可见
    try { syncNavPanel(); } catch (e) { log('同步面板写入出错', e); }
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, SCAN_MS);
  });
  // class 与 style 都要监听：B站切换收藏夹选中态只改类名；面板显隐靠内联 display 切换
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });

  // 调试/测试钩子（仅存在于扩展隔离环境，网页脚本接触不到）：
  // 控制台（Context 切到本扩展）可执行 __bvhTest.apply({rules:['关键字'],debug:true})
  window.__bvhTest = { apply: applyConfig };

  chrome.storage.sync.get({ bvh_config: { rules: [], debug: false, hideNavPanel: false } }, (cfg) => applyConfig(cfg.bvh_config));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.bvh_config) applyConfig(changes.bvh_config.newValue);
  });
})();
