/* 大肥鱼~一网打尽！ v1.0.0
 * 模糊识别评论区里「低等级 + @某人 + 长文模板 + 高频关键词」的疑似 AI 养鱼评论，
 * 命中后折叠到评论区顶部，可展开。
 * 运行在页面主世界（world: MAIN），通过拦截 B站评论接口拿到结构化数据。
 */
(function () {
  'use strict';
  if (window.__fishFolded) return;
  window.__fishFolded = true;

  // ---------- 配置 ----------
  const STORAGE_KEY = 'fishfilter.config';
  const DEFAULT_CONFIG = { threshold: 4.5, hide: true };
  const config = (() => {
    try {
      const c = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        threshold: typeof c.threshold === 'number' ? c.threshold : DEFAULT_CONFIG.threshold,
        hide: c.hide !== false,
      };
    } catch (_) {
      return { ...DEFAULT_CONFIG };
    }
  })();
  const saveConfig = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (_) {}
  };

  // ---------- 词库 ----------
  // 通用模板词与口癖，单个词只加少量分，靠组合过阈值。
  const KEYWORDS = [
    // 称呼/自称
    '主人', '本鱼', '本鲸', '小鲸鱼',
    // 工具圈通用模板
    '值得抄', '这套拆法', '拆法', '验收', '验收命令', '验收标准', '播放量门槛', '按播放量',
    '上下文仪表盘', '省 token', '省token', 'token 用量', 'token用量',
    '报告', '只收报告', '派活', '动手前', '会审', '子代理',
    '开源', '装完', '通用设置',
    '真实下载', '官方市场', '下载量', '余额挂件', '鲸鱼挂件', '两本日记', '生物钟',
    // 双人会审 / 验收话术
    '审方案', '不碰文件', '带超时', '超时和', '退出码', '怎么算干完',
    '两轮', '打回', '复核', '基线', '改动测试', '亲自过',
    '互审', '证据和反例', '不下结论', '看 diff', '记进本子', '本子', '独立会审', '编排',
    '派活前', '只交证据', '反例',
    // 推荐话术
    '值得看', '值得试', '给你挑', '帮你总结',
  ];
  // 真人也常用的词，降权为 1 分
  const WEAK_WORDS = new Set(['主人', '开源', '本鱼', '本鲸', '小鲸鱼']);
  // 按长度降序，用于长串优先去重
  const SORTED_KEYWORDS = [...KEYWORDS].sort((a, b) => b.length - a.length);
  const NAME_RE = /(?:大肥鱼|小肥鱼|肥鱼|鲸鲸|小鲸鱼|鲸鱼娘|鲸娘)/;

  // ---------- 打分 ----------
  function scoreComment(r) {
    const msg = (r.content && r.content.message) || '';
    const name = (r.member && r.member.uname) || '';
    const level = (r.member && r.member.level_info && r.member.level_info.current_level) || 0;
    let s = 0;
    const why = [];

    if (level <= 1) { s += 3; why.push('L' + level); }
    else if (level === 2) { s += 2.4; why.push('L2'); }
    else if (level === 3) { s += 1; why.push('L3'); }

    if (/^\s*@/.test(msg)) { s += 1; why.push('@开头'); }
    if (msg.length > 40) { s += 1; why.push('长文'); }
    if (msg.length > 100) s += 0.5;

    // 名字带鱼
    if (NAME_RE.test(name)) { s += 1.4; why.push('名字带鱼'); }

    // 长文里出现「大肥鱼」落款/自称
    if (msg.length > 40 && msg.indexOf('大肥鱼') !== -1) { s += 1.5; why.push('正文提鱼'); }

    // 按长度优先去重：长串命中后剔除其子串
    const hit = [];
    let kwScore = 0;
    let rest = msg.toLowerCase();
    for (const k of SORTED_KEYWORDS) {
      const kl = k.toLowerCase();
      if (rest.indexOf(kl) === -1) continue;
      hit.push(k);
      kwScore += WEAK_WORDS.has(k) ? 1 : 1.2;
      rest = rest.split(kl).join('\u0000');
    }
    if (hit.length) {
      s += Math.min(4, kwScore);
      why.push('模板词:' + hit.slice(0, 4).join('/'));
    }
    return { s, why };
  }

  // ---------- 命中收集 ----------
  const allComments = new Map(); // key -> {rpid, uname, level, mid, msg, why, score}（保留全部打分结果）
  const folded = new Map();      // 按当前阈值从 allComments 派生的折叠列表
  let panel = null;
  let panelList = null;
  let panelCount = null;
  let panelToggle = null;
  let lastHref = currentVideoId();

  function addHits(replies) {
    if (!Array.isArray(replies)) return false;
    let changed = false;
    for (const r of replies) {
      const { s, why } = scoreComment(r);
      const rpid = r.rpid != null ? String(r.rpid) : '';
      const msg = (r.content && r.content.message) || '';
      const key = rpid || ('m:' + ((r.member && r.member.mid) || '') + ':' + msg.slice(0, 18));
      if (allComments.has(key)) continue;
      allComments.set(key, {
        rpid: rpid,
        uname: (r.member && r.member.uname) || '?',
        level: (r.member && r.member.level_info && r.member.level_info.current_level) || 0,
        mid: String((r.member && r.member.mid) || ''),
        msg: msg,
        why: why,
        score: Math.round(s * 10) / 10,
      });
      changed = true;
    }
    if (changed) {
      rebuildFolded();
      renderPanel();
      scheduleScan();
    }
    return changed;
  }

  // 按当前阈值重建折叠列表
  function rebuildFolded() {
    folded.clear();
    for (const [k, v] of allComments) {
      if (v.score >= config.threshold) folded.set(k, v);
    }
  }

  // 阈值变更：重建、恢复旧的折叠、重扫
  function applyThreshold(v) {
    config.threshold = v;
    saveConfig();
    rebuildFolded();
    unhideAll();
    renderPanel();
    scheduleScan();
  }

  // ---------- 面板 ----------
  const STYLE = `
  .fish-folder{all:initial;display:block;margin:10px 0 12px;border:1px solid #e3e5e7;border-radius:10px;background:#fafbfc;font-family:inherit;font-size:13px;color:#18191c;overflow:hidden}
  .fish-folder *{box-sizing:border-box;font-family:inherit}
  .fish-folder-head{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;user-select:none;background:linear-gradient(90deg,#eef4ff,#f7f9ff)}
  .fish-folder-head:hover{background:linear-gradient(90deg,#e6eeff,#f2f5ff)}
  .fish-folder-title{font-weight:600;color:#0b5cff;display:flex;align-items:center;gap:6px;flex:1;min-width:0}
  .fish-folder-title .fish-count{color:#f25d8e;font-weight:700}
  .fish-folder-toggle,.fish-folder-recollapse{font-size:12px;color:#61666d;border:1px solid #d6d9dd;border-radius:999px;padding:2px 10px;background:#fff;white-space:nowrap;cursor:pointer}
  .fish-folder-body{display:none;padding:6px 10px 10px;max-height:340px;overflow:auto}
  .fish-folder.open .fish-folder-body{display:block}
  .fish-folder-sub{display:flex;align-items:center;gap:6px;font-size:12px;color:#9499a0;padding:2px 2px 6px}
  .fish-folder-sub input{width:48px;border:1px solid #d6d9dd;border-radius:6px;padding:2px 4px;font-size:12px}
  .fish-folder-sub label{display:flex;align-items:center;gap:4px;cursor:pointer}
  .fish-item{border-top:1px dashed #e5e7ea;padding:7px 2px 6px;line-height:1.5}
  .fish-item-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center;color:#61666d;font-size:12px;margin-bottom:3px}
  .fish-item-name{color:#18191c;font-weight:600}
  .fish-badge{background:#fff0f4;color:#f25d8e;border-radius:5px;padding:0 5px;font-size:11px}
  .fish-item-why{color:#0b5cff;background:#eef4ff;border-radius:5px;padding:0 5px;font-size:11px}
  .fish-item-msg{color:#3c3d3f;word-break:break-all;white-space:pre-wrap}
  .fish-folder-empty{color:#9499a0;padding:6px 2px;font-size:12px}
  @media (prefers-color-scheme: dark){
    .fish-folder{background:#1e1e21;border-color:#33353a;color:#e3e5e8}
    .fish-folder-head{background:linear-gradient(90deg,#23262e,#1e2128)}
    .fish-folder-head:hover{background:linear-gradient(90deg,#272b35,#22262e)}
    .fish-folder-title .fish-count{color:#ff8bb3}
    .fish-folder-toggle,.fish-folder-recollapse{background:#26282d;border-color:#3a3d43;color:#c0c4cc}
    .fish-item{border-top-color:#2c2e33}
    .fish-item-head{color:#a8adb5}
    .fish-item-name{color:#e3e5e8}
    .fish-badge{background:#3a2530;color:#ff8bb3}
    .fish-item-why{background:#232d45;color:#8fb2ff}
    .fish-item-msg{color:#c4c8cf}
    .fish-folder-sub{color:#7d8289}
    .fish-folder-sub input{background:#26282d;border-color:#3a3d43;color:#c0c4cc}
  }`;

  function injectStyle() {
    if (document.getElementById('fish-folder-style')) return;
    const st = document.createElement('style');
    st.id = 'fish-folder-style';
    st.textContent = STYLE;
    (document.head || document.documentElement).appendChild(st);
  }

  function buildPanel() {
    injectStyle();
    panel = document.createElement('div');
    panel.className = 'fish-folder';
    panel.innerHTML = `
      <div class="fish-folder-head">
        <div class="fish-folder-title">🐟 大肥鱼~一网打尽！ · 已折叠 <span class="fish-count">0</span> 条</div>
        <button type="button" class="fish-folder-recollapse" title="把手动展开的鱼全部重新折叠">全部折叠</button>
        <button type="button" class="fish-folder-toggle">展开</button>
      </div>
      <div class="fish-folder-body">
        <div class="fish-folder-sub">
          <span>阈值</span><input type="number" min="1" max="10" step="0.5">
          <label><input type="checkbox"> 隐藏原评论</label>
        </div>
        <div class="fish-folder-list"></div>
      </div>`;
    panelCount = panel.querySelector('.fish-count');
    panelList = panel.querySelector('.fish-folder-list');
    panelToggle = panel.querySelector('.fish-folder-toggle');
    const thrInput = panel.querySelector('.fish-folder-sub input[type=number]');
    const hideBox = panel.querySelector('.fish-folder-sub input[type=checkbox]');
    thrInput.value = String(config.threshold);
    hideBox.checked = config.hide;
    thrInput.addEventListener('change', () => {
      const v = parseFloat(thrInput.value);
      if (!isNaN(v) && v >= 1 && v <= 10) applyThreshold(v);
    });
    hideBox.addEventListener('change', () => {
      config.hide = hideBox.checked;
      saveConfig();
      unhideAll();
      scheduleScan();
    });
    panel.querySelector('.fish-folder-head').addEventListener('click', (e) => {
      if (e.target.closest('input,button.fish-folder-toggle,button.fish-folder-recollapse')) return;
      panel.classList.toggle('open');
      panelToggle.textContent = panel.classList.contains('open') ? '收起' : '展开';
    });
    panelToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('open');
      panelToggle.textContent = panel.classList.contains('open') ? '收起' : '展开';
    });
    panel.querySelector('.fish-folder-recollapse').addEventListener('click', (e) => {
      e.stopPropagation();
      recollapseAll();
    });
  }

  // 重新折叠所有手动展开过的评论
  function recollapseAll() {
    userOpenedKeys.clear();
    hiddenKeys.clear();
    try { scan(); } catch (_) {}
    scheduleScan();
  }

  function findHost() {
    // 新版评论区容器 <bili-comments>
    const custom = document.querySelector('bili-comments');
    if (custom) return custom;
    const list = document.querySelector('.reply-list, .sub-reply-list, .comment-list');
    if (list && list.parentElement) return list.parentElement;
    const app =
      document.querySelector('#commentapp') ||
      document.querySelector('.comment-container') ||
      document.querySelector('.bili-comments') ||
      document.querySelector('.reply-wrap');
    if (app) return app;
    return null;
  }

  function ensurePanel() {
    if (!panel) buildPanel();
    const host = findHost();
    if (!host) {
      // 兜底：悬浮在右下角
      if (!panel.isConnected) {
        panel.style.position = 'fixed';
        panel.style.right = '16px';
        panel.style.bottom = '70px';
        panel.style.width = '320px';
        panel.style.zIndex = '99999';
        document.body.appendChild(panel);
      }
      return;
    }
    const hostTag = (host.tagName || '').toLowerCase();
    if (hostTag === 'bili-comments') {
      // 插到 shadow 宿主前面，显示在评论区上方
      const parent = host.parentElement;
      if (!parent) return;
      panel.style.position = '';
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.width = '';
      panel.style.zIndex = '';
      if (panel.parentElement !== parent || panel.nextElementSibling !== host) {
        parent.insertBefore(panel, host);
      }
      return;
    }
    if (host.contains(panel)) return;
    panel.style.position = '';
    panel.style.right = '';
    panel.style.bottom = '';
    panel.style.width = '';
    panel.style.zIndex = '';
    const first = host.firstElementChild;
    if (first) host.insertBefore(panel, first);
    else host.appendChild(panel);
  }

  function renderPanel() {
    if (!panel) buildPanel();
    const entries = [...folded.entries()]
      .map(([key, f]) => Object.assign({ key: key }, f))
      .sort((a, b) => b.score - a.score);
    panelCount.textContent = String(entries.length);
    panelList.textContent = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'fish-folder-empty';
      empty.textContent = '这条视频的评论区看起来还挺干净。';
      panelList.appendChild(empty);
      return;
    }
    for (const e of entries) {
      const item = document.createElement('div');
      item.className = 'fish-item';
      const head = document.createElement('div');
      head.className = 'fish-item-head';
      const name = document.createElement('span');
      name.className = 'fish-item-name';
      name.textContent = e.uname;
      const lvl = document.createElement('span');
      lvl.className = 'fish-badge';
      lvl.textContent = 'L' + e.level + (e.mid ? ' · ' + e.mid : '');
      const why = document.createElement('span');
      why.className = 'fish-item-why';
      why.textContent = '分 ' + e.score + ' · ' + e.why.join(' / ');
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = '定位';
      jump.style.cssText =
        'margin-left:auto;font-size:11px;color:#0b5cff;border:1px solid #cfe0ff;background:#eef4ff;border-radius:5px;padding:0 7px;cursor:pointer;';
      jump.addEventListener('click', (ev) => {
        ev.stopPropagation();
        jumpTo(e.key);
      });
      head.appendChild(name);
      head.appendChild(lvl);
      head.appendChild(why);
      head.appendChild(jump);
      const msg = document.createElement('div');
      msg.className = 'fish-item-msg';
      msg.textContent = e.msg.length > 140 ? e.msg.slice(0, 140) + '…' : e.msg;
      item.appendChild(head);
      item.appendChild(msg);
      panelList.appendChild(item);
    }
  }

  // 滚动到该评论在原评论区的位置，不展开
  function jumpTo(key) {
    const f = folded.get(key);
    if (!f) return;
    const flash = (el) => {
      try {
        const prev = el.style.outline;
        el.style.outline = '2px solid #0b5cff';
        el.style.outlineOffset = '2px';
        setTimeout(() => {
          el.style.outline = prev;
          el.style.outlineOffset = '';
        }, 1200);
      } catch (_) {}
    };
    // 滚动结束后高亮；已在视口内则直接高亮
    const scrollAndFlash = (el) => {
      const r = el.getBoundingClientRect();
      const inView = r.top >= 0 && r.bottom > 0 && r.bottom <= window.innerHeight;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (inView) { flash(el); return; }
      let fired = false;
      const onArrive = () => {
        if (fired) return;
        fired = true;
        flash(el);
      };
      try { document.addEventListener('scrollend', onArrive, { once: true }); } catch (_) {}
      setTimeout(onArrive, 1600);
    };
    // 1) 已折叠：滚到占位条
    const arr = collapsedCards.get(key) || [];
    for (const entry of arr) {
      if (entry.bar && entry.bar.isConnected) {
        scrollAndFlash(entry.bar);
        return;
      }
    }
    // 2) 未折叠：按文本找卡片
    const probe = normText(f.msg).slice(0, 22);
    if (probe.length < 8) return;
    const nameProbe = normText(f.uname);
    for (const c of collectCommentCards()) {
      const t = cardText(c);
      if (t.indexOf(probe) !== -1 && (!nameProbe || t.indexOf(nameProbe) !== -1)) {
        scrollAndFlash(c);
        return;
      }
    }
  }

  // ---------- 隐藏原评论 ----------
  let scanTimer = 0;
  const hiddenKeys = new Set();

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      try { scan(); } catch (_) {}
    }, 600);
  }

  // 归一化：去掉表情代码、空白、标点
  function normText(s) {
    return String(s || '')
      .replace(/\[[^\[\]]{1,12}\]/g, '')
      .replace(/\s+/g, '')
      .replace(/[，。！？、,.!?;；:：""''（）()《》<>—–~～·…\-_]/g, '');
  }

  // ---------- 折叠 / 占位 / 恢复 ----------
  const userOpenedKeys = new Set();      // 用户主动点开过的条目，不再自动折叠
  const collapsedCards = new Map();      // key -> [{card, bar}]

  function parentOf(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null;
  }

  function closestThread(el) {
    let cur = el;
    while (cur) {
      const tag = (cur.tagName || '').toLowerCase();
      if (tag === 'bili-comment-thread-renderer') return cur;
      cur = parentOf(cur);
    }
    return null;
  }

  // 在元素子树（含 shadow）里找第一个满足条件的节点
  function deepFindCard(el, pred) {
    let found = null;
    const visit = (node) => {
      if (found || !node) return;
      if (node.nodeType === 1) {
        if (pred(node)) { found = node; return; }
        if (node.shadowRoot) visit(node.shadowRoot);
        for (const c of node.children) visit(c);
      } else if (node.nodeType === 11) {
        for (const c of node.childNodes) visit(c);
      }
    };
    visit(el);
    return found;
  }

  // 测量对齐缩进：优先对齐「共 N 条回复」入口，其次正文块
  function measureAlignLeft(card) {
    try {
      const cr = card.getBoundingClientRect();
      let target = null;
      const scope = card.parentElement;
      if (scope) {
        target = deepFindCard(scope, (n) => {
          const t = (n.textContent || '').trim();
          return /条回复|点击查看/.test(t) && n.children.length <= 4 && n.getBoundingClientRect().width > 0;
        });
      }
      if (!target) {
        target = deepFindCard(card, (n) => {
          const tag = (n.tagName || '').toLowerCase();
          const cls = String(n.className || '');
          return (tag === 'bili-rich-text' || /reply-content/.test(cls)) && n.getBoundingClientRect().width > 0;
        });
      }
      if (!target) return -1;
      return Math.max(0, Math.round(target.getBoundingClientRect().left - cr.left));
    } catch (_) {
      return -1;
    }
  }

  // 布局稳定后重新对齐占位条
  function alignBar(bar) {
    try {
      if (!bar || !bar.isConnected) return;
      const br = bar.getBoundingClientRect();
      let target = null;

      // 1) 本线程里的「共 N 条回复」或可见正文
      const scope = bar.parentElement;
      if (scope) {
        target = deepFindCard(scope, (n) => {
          const t = (n.textContent || '').trim();
          return /条回复|点击查看/.test(t) && n.children.length <= 6 && n.getBoundingClientRect().width > 0;
        });
        if (!target) {
          target = deepFindCard(scope, (n) => {
            const tag = (n.tagName || '').toLowerCase();
            return tag === 'bili-rich-text' && n.getBoundingClientRect().width > 0;
          });
        }
      }

      // 2) 兜底：用同评论区可见正文的缩进
      if (!target) {
        let host = null;
        let cur = bar;
        while (cur && !host) {
          const tag = (cur.tagName || '').toLowerCase();
          if (tag === 'bili-comments' || tag === 'comment-container' || tag === 'bili-comment-thread-renderer') host = cur;
          cur = parentOf(cur);
        }
        const root = host || document.body;
        target = deepFindCard(root, (n) => {
          const tag = (n.tagName || '').toLowerCase();
          return tag === 'bili-rich-text' && n.getBoundingClientRect().width > 0;
        });
      }

      if (!target) return;
      const pad = Math.max(0, Math.round(target.getBoundingClientRect().left - br.left));
      if (pad > 0) bar.style.paddingLeft = pad + 'px';
    } catch (_) {}
  }

  // 占位条：点「展开」恢复原文
  function makePlaceholder(key, indent) {
    const bar = document.createElement('div');
    bar.className = 'fish-collapsed-bar';
    bar.dataset.fishKey = key;
    const pad = indent >= 0 ? indent : 28;
    bar.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 28px;color:#9499a0;font-size:13px;border-bottom:1px solid #e5e7ea;' +
      'padding-left:' + pad + 'px;width:auto;';
    const txt = document.createElement('span');
    txt.textContent = '该内容已被折叠';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '展开';
    btn.style.cssText = 'font-size:12px;color:#61666d;border:1px solid #d6d9dd;border-radius:999px;padding:1px 10px;background:#fff;cursor:pointer;';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      userOpenedKeys.add(key);
      revealKey(key);
    });
    bar.appendChild(txt);
    bar.appendChild(btn);
    return bar;
  }

  function collapseCard(el, key) {
    if (!el || el.dataset.fishCollapsed) return;
    if (!el.parentNode) return;
    const indent = measureAlignLeft(el);
    const bar = makePlaceholder(key, indent);
    el.parentNode.insertBefore(bar, el);
    el.style.display = 'none';
    el.dataset.fishCollapsed = '1';
    el.dataset.fishHidden = '1';
    let arr = collapsedCards.get(key);
    if (!arr) { arr = []; collapsedCards.set(key, arr); }
    arr.push({ card: el, bar: bar });

    // 稍后重新对齐占位条
    setTimeout(() => { if (bar.isConnected) alignBar(bar); }, 300);
    setTimeout(() => { if (bar.isConnected) alignBar(bar); }, 1000);

    // 主评论折叠时，把这条评论线程里的楼中楼也一起收起
    const thread = closestThread(el);
    if (thread) {
      const hideEl = (n) => {
        if (!n || n === el) return;
        if (el.contains && el.contains(n)) return;
        if (n.dataset.fishRepliesCollapsed) return;
        n.style.display = 'none';
        n.dataset.fishRepliesCollapsed = '1';
        arr.push({ replies: n });
      };
      // 优先整块藏楼中楼容器
      const repliesBox = deepFindCard(thread, (n) => {
        const tag = (n.tagName || '').toLowerCase();
        return tag === 'bili-comment-replies-renderer' || tag === 'bili-comment-reply-renderer';
      });
      if (repliesBox) {
        hideEl(repliesBox);
      } else {
        // 兜底：逐个藏回复渲染器
        const walk = (root) => {
          if (!root || !root.querySelectorAll) return;
          for (const n of root.querySelectorAll('*')) {
            const tag = (n.tagName || '').toLowerCase();
            if (tag === 'bili-comment-replies-renderer' || tag === 'bili-comment-reply-renderer') hideEl(n);
            if (n.shadowRoot) walk(n.shadowRoot);
          }
        };
        walk(thread);
      }
    }
  }

  function revealKey(key) {
    const arr = collapsedCards.get(key) || [];
    for (const entry of arr) {
      try {
        if (entry.card && entry.card.isConnected) {
          entry.card.style.display = '';
          delete entry.card.dataset.fishCollapsed;
          delete entry.card.dataset.fishHidden;
        }
      } catch (_) {}
      try {
        if (entry.replies && entry.replies.isConnected) {
          entry.replies.style.display = '';
          delete entry.replies.dataset.fishRepliesCollapsed;
        }
      } catch (_) {}
      try {
        if (entry.bar && entry.bar.isConnected) entry.bar.remove();
      } catch (_) {}
    }
    collapsedCards.delete(key);
    hiddenKeys.delete(key);
  }

  // 深度取文本（含 Shadow DOM）
  function deepTextOf(el) {
    let out = '';
    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === 3) { out += node.nodeValue + ' '; return; } // 文本
      if (node.nodeType === 11) { // DocumentFragment（shadowRoot）
        for (const c of node.childNodes) visit(c);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style') return;
      if (node.shadowRoot) visit(node.shadowRoot);
      for (const c of node.childNodes) visit(c);
    };
    visit(el);
    return out;
  }

  // 收集评论卡片（穿透 shadow root）
  // 新版结构：bili-comment-thread-renderer > bili-comment-renderer
  function collectCommentCards() {
    const cards = [];
    const seen = new Set();
    const pick = (el) => {
      if (seen.has(el)) return;
      const tag = (el.tagName || '').toLowerCase();
      const cls = String(el.className || '');
      if (
        tag === 'bili-comment-renderer' ||
        /(^|[\s_-])(reply-item|comment-item|sub-reply-item)([\s_-]|$)/.test(cls)
      ) {
        seen.add(el);
        cards.push(el);
      }
    };
    const walk = (root) => {
      if (!root || !root.querySelectorAll) return;
      for (const el of root.querySelectorAll('*')) {
        pick(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    try { walk(document); } catch (_) {}
    return cards;
  }

  // 卡片文本缓存（8 秒过期）
  const textCache = new WeakMap();
  function cardText(el) {
    const c = textCache.get(el);
    const now = Date.now();
    if (c && now - c.at < 8000) return c.t;
    const t = normText(deepTextOf(el));
    textCache.set(el, { t, at: now });
    return t;
  }

  function scan() {
    if (!config.hide) return;
    if (!folded.size) return;

    const cards = collectCommentCards();
    if (!cards.length) return;

    for (const [key, f] of folded) {
      if (userOpenedKeys.has(key)) continue;
      const probe = normText(f.msg).slice(0, 22);
      if (probe.length < 8) continue;
      const nameProbe = normText(f.uname);

      const match = (c) => {
        if (c.style.display === 'none') return false;
        const t = cardText(c);
        if (t.indexOf(probe) === -1) return false;
        if (nameProbe && t.indexOf(nameProbe) === -1) return false;
        return true;
      };

      // 优先隐藏单条渲染器
      let target = null;
      for (const c of cards) {
        if ((c.tagName || '').toLowerCase() !== 'bili-comment-renderer') continue;
        if (match(c)) { target = c; break; }
      }
      if (!target) {
        for (const c of cards) {
          if ((c.tagName || '').toLowerCase() === 'bili-comment-renderer') continue;
          if (match(c)) { target = c; break; }
        }
      }
      if (target) {
        collapseCard(target, key);
        hiddenKeys.add(key);
      }
    }
  }

  function unhideAll() {
    for (const key of [...collapsedCards.keys()]) revealKey(key);
    const clear = (root) => {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('[data-fish-hidden]').forEach((el) => {
        el.style.display = '';
        delete el.dataset.fishHidden;
        delete el.dataset.fishCollapsed;
      });
      root.querySelectorAll('[data-fish-replies-collapsed]').forEach((el) => {
        el.style.display = '';
        delete el.dataset.fishRepliesCollapsed;
      });
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) clear(el.shadowRoot);
      });
    };
    try { clear(document); } catch (_) {}
    hiddenKeys.clear();
  }

  // ---------- 拦截评论接口 ----------
  function onPayload(payload) {
    try {
      if (!payload) return;
      if (payload.data && Array.isArray(payload.data.replies)) {
        addHits(payload.data.replies);
        if (Array.isArray(payload.data.top_replies)) addHits(payload.data.top_replies);
      }
      if (payload.data && Array.isArray(payload.data.hots)) {
        addHits(payload.data.hots);
      }
    } catch (_) {}
  }

  function hookFetch() {
    const origFetch = window.fetch;
    if (!origFetch) return;
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && (input.url || String(input));
        if (url && url.indexOf('/x/v2/reply') !== -1) {
          p.then((res) => {
            try {
              res.clone().json().then(onPayload).catch(() => {});
            } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  }

  function hookXHR() {
    const XHR = window.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try {
        this.__fishUrl = String(url || '');
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        if (this.__fishUrl && this.__fishUrl.indexOf('/x/v2/reply') !== -1) {
          this.addEventListener('load', () => {
            try {
              onPayload(JSON.parse(this.responseText));
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }

  // ---------- 生命周期 ----------
  // 按视频 ID 判断切换，排序变化不清空
  function currentVideoId() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : location.pathname;
  }

  function onNavigate() {
    const vid = currentVideoId();
    if (vid === lastHref) return;
    lastHref = vid;
    allComments.clear();
    folded.clear();
    hiddenKeys.clear();
    collapsedCards.clear();
    userOpenedKeys.clear();
    if (panel) {
      if (panel.isConnected && !panel.style.position) {
        // 页面内面板随评论区一起被替换
        panel.remove();
      }
      panel = null;
    }
    renderPanel();
  }

  // 尽早挂钩子，避免漏掉首屏评论接口
  hookFetch();
  hookXHR();

  function boot() {
    const mo = new MutationObserver(() => {
      onNavigate();
      ensurePanel();
      scheduleScan();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    ensurePanel();
    window.addEventListener('popstate', onNavigate);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // 调试：控制台输入 __fishStats() 可看「已折叠 / 已隐藏」数量
  window.__fishStats = () => ({ folded: folded.size, hidden: hiddenKeys.size });
})();
