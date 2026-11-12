'use strict';

/* ============================================================
 * memory-studio 前端逻辑
 * ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  scopes: [],
  currentScope: null,
  entries: [],
  allEntries: [],
  selected: null,
  mode: 'view', // view | edit | create
  query: '',
  editingFile: null,
  filter: 'all', // all | unindexed
  batchMode: false,
  picked: [],
  indexStatus: null,
  view: 'three', // three | preview | list
  searchAll: false, // 搜索范围：false=当前作用域，true=全部作用域

  // ---- 日记（只读）----
  area: 'memory', // memory | journal —— 看的是记忆还是日记（区别于上面 state.mode 的编辑态）
  journalDays: [], // 当前作用域的日期列表（新→旧）
  journalDate: null, // 当前打开的日期
  journalHits: [], // 日记搜索命中的批次
  journalRange: 'all', // all | week | month
};

// ---------------------------------------------------------------- HTTP

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- 工具

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/** 更新列表栏头部的状态信息（原先的状态栏已移除） */
function setStatus(msg) {
  const el = $('listMeta');
  if (el) el.textContent = msg || '';
}

/** 列表右上角的时间，风格接近邮件客户端 */
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------------------------------------------------------------- 自定义弹窗

/**
 * 统一的弹窗实现，替代浏览器自带 alert / confirm。
 *
 * opts:
 *   title    标题
 *   html     正文（HTML 片段，调用方自行转义）
 *   choices  [{ value, title, desc, danger }] 单选组；不给则只是确认
 *   okText   确认按钮文字
 *   cancelText 取消按钮文字（false 表示隐藏）
 * 返回 Promise：确认时给出所选 value（无 choices 时为 true），取消为 null。
 */
function showModal(opts) {
  return new Promise((resolve) => {
    const root = $('modalRoot');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';

    const choicesHtml = opts.choices
      ? `<div class="modal-choice">${opts.choices
          .map(
            (c, i) => `
        <label class="choice${c.danger ? ' danger' : ''}">
          <input type="radio" name="modal-choice" value="${esc(c.value)}" ${i === 0 ? 'checked' : ''}>
          <span>
            <div class="ct">${esc(c.title)}</div>
            ${c.desc ? `<div class="cd">${esc(c.desc)}</div>` : ''}
          </span>
        </label>`,
          )
          .join('')}</div>`
      : '';

    mask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">${esc(opts.title || '')}</div>
        <div class="modal-body">
          ${opts.html || ''}
          ${choicesHtml}
          ${opts.note ? `<div class="note">${opts.note}</div>` : ''}
        </div>
        <div class="modal-foot">
          ${opts.cancelText === false ? '' : `<button class="btn" data-act="cancel">${esc(opts.cancelText || '取消')}</button>`}
          <button class="btn ${opts.danger ? 'danger' : 'primary'}" data-act="ok">${esc(opts.okText || '确定')}</button>
        </div>
      </div>`;

    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      mask.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) {
        e.preventDefault();
        const picked = mask.querySelector('input[name="modal-choice"]:checked');
        close(opts.choices ? (picked ? picked.value : null) : true);
      }
    };

    mask.querySelector('[data-act="cancel"]')?.addEventListener('click', () => close(null));
    mask.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const picked = mask.querySelector('input[name="modal-choice"]:checked');
      close(opts.choices ? (picked ? picked.value : null) : true);
    });
    mask.querySelector('[data-act="ok"]').focus();
    document.addEventListener('keydown', onKey);
    root.appendChild(mask);
  });
}

/** 纯提示，只有一个确定按钮 */
function showAlert(title, html, note) {
  return showModal({ title, html, note, okText: '知道了', cancelText: false });
}

/** 极简 Markdown 渲染：够用即可，不引入第三方库 */
function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listType = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    // 代码块
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara(); closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const line = raw;

    if (!line.trim()) { flushPara(); closeList(); continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const lv = Math.min(h[1].length, 4);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }

    // 引用
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }

    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }

    closeList();
    para.push(line.trim());
  }

  flushPara();
  closeList();
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  return out.join('\n');
}

function inline(s) {
  let t = esc(s);
  // 行内代码优先，避免内部被当粗体处理
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return t;
}

const TYPE_LABEL = {
  user: 'user',
  feedback: 'feedback',
  project: 'project',
  reference: 'reference',
};

// ---------------------------------------------------------------- 数据加载

async function loadScopes() {
  const data = await api('/api/scopes');
  state.scopes = data.scopes || [];
  $('rootPath').textContent = data.root || '';
  $('rootPath').title = '数据目录：' + (data.root || '');
  $('scopeCount').textContent = `${state.scopes.length} 个`;
  renderScopes();
}

function renderScopes() {
  const box = $('scopes');
  box.innerHTML = '';
  for (const s of state.scopes) {
    const div = document.createElement('div');
    const isJournal = state.area === 'journal';
    const noJournal = isJournal && !s.journalDays;
    div.className =
      'scope' + (s.name === state.currentScope ? ' active' : '') + (noJournal ? ' dim' : '');
    div.innerHTML = `<span class="nm">${esc(s.label)}</span><span class="n">${
      isJournal ? (s.journalDays || '—') : s.count
    }</span>`;
    div.title = isJournal
      ? s.journalDays
        ? `${s.name} · ${s.journalDays} 天日记`
        : `${s.name} · 没有日记`
      : s.name;
    div.onclick = () => selectScope(s.name);
    box.appendChild(div);
  }
}

async function selectScope(name) {
  state.currentScope = name;
  state.selected = null;
  state.journalDate = null;
  state.journalHits = [];
  renderScopes();
  if (state.area === 'journal') {
    if (state.query.trim()) await searchJournalRemote();
    else await loadJournalDays();
    // 换作用域后收起旧内容，避免看到上一个作用域的日记
    $('journalView').classList.add('hidden');
    $('empty').classList.remove('hidden');
    document.body.classList.remove('showing-detail');
    updateBackButton();
    return;
  }
  await loadEntries();
}

async function loadEntries() {
  if (!state.currentScope) return;
  try {
    const [data, idx] = await Promise.all([
      api(`/api/entries?scope=${encodeURIComponent(state.currentScope)}`),
      api(`/api/index-status?scope=${encodeURIComponent(state.currentScope)}`).catch(() => null),
    ]);
    state.entries = data.entries || [];
    state.indexStatus = idx;
    renderList();
    // 条数只显示在筛选按钮上（全部 / 未索引），状态栏不再重复
    renderFilters();
    setStatus('');
  } catch (err) {
    toast(err.message, 'err');
    setStatus('');
  }
}

/** 索引维护：只在用户主动点击时执行 */
async function openIndexTools() {
  const idx = state.indexStatus;
  if (!idx) return;
  const orphans = idx.orphans.length;
  const dangling = idx.dangling.length;

  const choices = [
    { value: 'refresh', title: '整理现有索引', desc: '清理失效引用与重复行，刷新标题描述。未索引的文件保持未索引。' },
  ];
  if (orphans) {
    choices.push({
      value: 'include',
      title: `把 ${orphans} 个未索引文件全部收录`,
      desc: '将它们写入 MEMORY.md 索引。',
    });
  }

  const picked = await showModal({
    title: '索引维护',
    html: `<div>当前作用域：<strong>${esc(state.currentScope)}</strong></div>
      <div style="margin-top:6px">未被索引的文件：<strong>${orphans}</strong> 个 · 失效引用：<strong>${dangling}</strong> 条</div>`,
    choices,
    okText: '执行',
    note: '执行前会备份原 MEMORY.md。未索引是允许的状态，这里不会自动改动它。',
  });
  if (!picked) return;

  try {
    const r = await api('/api/rebuild-index', {
      method: 'POST',
      body: JSON.stringify({ scope: state.currentScope, includeOrphans: picked === 'include' }),
    });
    toast(
      picked === 'include'
        ? `已收录 ${r.added} 条，索引共 ${r.total} 条`
        : `索引已整理，共 ${r.total} 条`,
      'ok',
    );
    await loadScopesForCurrent();
    await loadEntries();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------- 列表渲染

function visibleEntries() {
  const q = state.query.trim().toLowerCase();
  let pool;
  if (!q) {
    pool = state.entries.map((e) => ({ ...e, _scope: state.currentScope }));
  } else {
    pool = state.searchAll && state.allEntries.length
      ? state.allEntries
      : state.entries.map((e) => ({ ...e, _scope: state.currentScope }));
    pool = pool.filter((e) => {
      const hay = `${e.name}\n${e.description}\n${e.body}\n${e.type}\n${e.file}\n${e._scope || e.scope}`.toLowerCase();
      return hay.includes(q);
    });
  }
  // 未索引筛选只在当前作用域内生效（跨作用域搜索时不区分）
  if (state.filter === 'unindexed') {
    pool = pool.filter((e) => e.indexed === false);
  }
  return pool;
}

/** 刷新筛选按钮上的计数 */
function renderFilters() {
  // 必须限定在记忆列表头部内：日记模式也有一组 .filters，
  // 用 document.querySelector 会取到日记那组，里面的 [data-filter] 取不到就会抛错，
  // 进而让 loadEntries 整个进 catch、状态显示「读取失败」。
  const box = $('memoryListHead')?.querySelector('.filters');
  if (!box) return;
  const total = state.entries.length;
  const unindexed = state.entries.filter((e) => e.indexed === false).length;
  const allBtn = box.querySelector('[data-filter="all"]');
  const unBtn = box.querySelector('[data-filter="unindexed"]');
  allBtn.innerHTML = `全部<span class="c">${total}</span>`;
  unBtn.innerHTML = `未索引<span class="c">${unindexed}</span>`;
  allBtn.classList.toggle('active', state.filter === 'all');
  unBtn.classList.toggle('active', state.filter === 'unindexed');
  unBtn.classList.toggle('unindexed-warn', unindexed > 0);
}

function renderList() {
  const box = $('list');
  const items = visibleEntries();
  box.innerHTML = '';

  if (!items.length) {
    const msg = state.filter === 'unindexed'
      ? '该作用域下没有未索引的条目'
      : state.query ? '没有匹配的条目' : '该作用域下没有记忆条目';
    box.innerHTML = `<div style="padding:20px 14px;color:#6b7280;font-size:13px">${msg}</div>`;
    return;
  }

  for (const e of items) {
    const scope = e._scope || e.scope;
    const div = document.createElement('div');
    const active = state.selected && state.selected.scope === scope && state.selected.file === e.file;
    const picked = isPicked(scope, e.file);
    div.className = 'item' + (active ? ' active' : '') + (picked ? ' picked' : '');
    const scopeTag = state.query && e._scope && e._scope !== state.currentScope
      ? `<span class="badge">${esc(e._scope === 'global' ? 'global' : e._scope)}</span>`
      : '';
    const unTag = e.indexed === false ? '<span class="badge unindexed">未索引</span>' : '';
    const checkbox = state.batchMode
      ? `<input type="checkbox" ${picked ? 'checked' : ''} data-scope="${esc(scope)}" data-file="${esc(e.file)}">`
      : '';
    div.innerHTML = `
      <div class="sel">
        ${checkbox}
        <div class="txt">
          <div class="row1">
            <span class="t">${esc(e.name || e.file)}</span>
            <span class="time">${esc(fmtTime(e.mtime))}</span>
          </div>
          <div class="d">${esc(e.description || e.body.slice(0, 120))}</div>
          <div class="tagline">
            <span class="badge" data-t="${esc(e.type)}">${esc(e.type || '未标注')}</span>
            ${unTag}
            ${scopeTag}
          </div>
        </div>
      </div>`;
    div.onclick = (ev) => {
      if (ev.target.tagName === 'INPUT') {
        togglePick(scope, e.file, ev.target.checked);
        return;
      }
      if (state.batchMode) {
        togglePick(scope, e.file, !isPicked(scope, e.file));
        return;
      }
      selectEntry(scope, e.file);
    };
    box.appendChild(div);
  }
  renderBatchBar();
}

// ---------------------------------------------------------------- 批量选择

function isPicked(scope, file) {
  return state.picked.some((p) => p.scope === scope && p.file === file);
}

function togglePick(scope, file, on) {
  const idx = state.picked.findIndex((p) => p.scope === scope && p.file === file);
  if (on && idx < 0) state.picked.push({ scope, file });
  if (!on && idx >= 0) state.picked.splice(idx, 1);
  renderList();
}

function renderBatchBar() {
  const bar = $('batchBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !state.batchMode);
  $('btnBatchMode').classList.toggle('on', state.batchMode);
  $('batchInfo').textContent = `已选 ${state.picked.length} 项`;
  bar.querySelectorAll('[data-batch]').forEach((b) => {
    if (b.dataset.batch === 'cancel') return;
    b.disabled = state.picked.length === 0;
  });
}

function toggleBatchMode() {
  state.batchMode = !state.batchMode;
  state.picked = [];
  renderList();
}

// ---------------------------------------------------------------- 列宽拖拽

const COL_DEFAULT = { nav: 220, list: 340 };
const COL_MIN = { nav: 150, list: 220 };
// 内容列至少要保留的宽度
const DETAIL_MIN = 360;

function getColWidths() {
  const root = document.documentElement;
  const nav = parseInt(getComputedStyle(root).getPropertyValue('--w-nav'), 10);
  const list = parseInt(getComputedStyle(root).getPropertyValue('--w-list'), 10);
  return {
    nav: Number.isFinite(nav) ? nav : COL_DEFAULT.nav,
    list: Number.isFinite(list) ? list : COL_DEFAULT.list,
  };
}

function setColWidths({ nav, list }) {
  const root = document.documentElement;
  if (nav != null) root.style.setProperty('--w-nav', nav + 'px');
  if (list != null) root.style.setProperty('--w-list', list + 'px');
}

function saveColWidths() {
  try {
    localStorage.setItem('memory-studio:widths', JSON.stringify(getColWidths()));
  } catch { /* 忽略隐私模式等存储异常 */ }
}

function restoreColWidths() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('memory-studio:widths') || 'null');
  } catch { saved = null; }
  if (!saved || typeof saved !== 'object') return;
  const clamp = (v, k) => Math.max(COL_MIN[k], Number(v) || COL_DEFAULT[k]);
  setColWidths({ nav: clamp(saved.nav, 'nav'), list: clamp(saved.list, 'list') });
}

/** 让拖拽后的列宽不超过可用空间（给内容列留足最小宽度） */
function clampForView(key, width) {
  const layout = document.querySelector('.layout');
  if (!layout) return width;
  const total = layout.clientWidth;
  const cur = getColWidths();

  // 仅在「三栏」下，两列同时可见，需要互相让位；其余视图里被拖的那列是唯一的侧栏
  let reserved = 0;
  if (state.view === 'three') {
    reserved = key === 'nav' ? cur.list : cur.nav;
  }

  const max = Math.max(COL_MIN[key], total - reserved - DETAIL_MIN);
  return Math.min(Math.max(COL_MIN[key], width), max);
}

function initGutters() {
  document.querySelectorAll('.gutter').forEach((gutter) => {
    const key = gutter.dataset.gutter; // nav | list

    const onMove = (ev) => {
      const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const layout = document.querySelector('.layout');
      const rect = layout.getBoundingClientRect();
      let width;
      if (key === 'nav') {
        width = x - rect.left;
      } else {
        // list 分隔条：宽度 = 指针位置 - 作用域列宽（三栏时才有作用域列）
        const navW = state.view === 'three' ? getColWidths().nav : 0;
        width = x - rect.left - navW;
      }
      width = clampForView(key, Math.round(width));
      setColWidths(key === 'nav' ? { nav: width } : { list: width });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      gutter.classList.remove('dragging');
      document.body.classList.remove('w-resizing');
      saveColWidths();
    };

    const onDown = (ev) => {
      ev.preventDefault();
      gutter.classList.add('dragging');
      document.body.classList.add('w-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    };

    gutter.addEventListener('mousedown', onDown);
    gutter.addEventListener('touchstart', onDown, { passive: false });

    // 双击复位该列默认宽度
    gutter.addEventListener('dblclick', () => {
      setColWidths(key === 'nav' ? { nav: COL_DEFAULT.nav } : { list: COL_DEFAULT.list });
      saveColWidths();
    });
  });
}

// ---------------------------------------------------------------- 视图模式

/** 应用视图模式：three（三栏）/ preview（右侧预览）/ list（仅列表） */
function applyView(view) {
  state.view = view;
  document.body.dataset.view = view;
  localStorage.setItem('memory-studio:view', view);
  updateLayoutMenu();
  updateBackButton();
  // 三栏/预览下内容常驻；仅列表下只有打开条目才显示内容
  if (view === 'list' && !state.selected) {
    document.body.classList.remove('showing-detail');
  }
  // 切换视图后按新布局校正列宽，避免内容列被挤没
  const cur = getColWidths();
  setColWidths({
    nav: clampForView('nav', cur.nav),
    list: clampForView('list', cur.list),
  });
}

function updateLayoutMenu() {
  const menu = $('layoutMenu');
  if (!menu) return;
  menu.querySelectorAll('.menu-item[data-view]').forEach((it) => {
    it.setAttribute('aria-checked', String(it.dataset.view === state.view));
  });
}

/** 切换搜索范围：当前作用域 <-> 全部作用域 */
function toggleSearchScope() {
  state.searchAll = !state.searchAll;
  const btn = $('scopeToggle');
  btn.textContent = state.searchAll ? '全部作用域' : '当前作用域';
  btn.classList.toggle('all', state.searchAll);
  btn.title = state.searchAll ? '正在跨全部作用域搜索，点击改为仅当前作用域' : '仅搜索当前作用域，点击改为全部作用域';
  // 切回单作用域时清掉全量缓存，避免数据过期
  if (!state.searchAll) state.allEntries = [];
  onSearchInput();
}

/** 当前是否处于「列表/内容二选一」的窄模式 */
function isSinglePane() {
  if (state.view === 'list') return true;
  return window.matchMedia('(max-width: 820px)').matches;
}

function updateBackButton() {
  const show = isSinglePane() && document.body.classList.contains('showing-detail');
  // 日记模式有自己的返回按钮，记忆的返回按钮在其隐藏时由 CSS 决定显示
  const btn = $('btnBack');
  if (btn) btn.classList.toggle('hidden', !show || state.area === 'journal');
  const jBtn = $('btnJournalBack');
  if (jBtn) jBtn.classList.toggle('hidden', !show || state.area !== 'journal');
}

// ---------------------------------------------------------------- 详情 / 编辑

function showView() {
  $('empty').classList.add('hidden');
  $('editor').classList.add('hidden');
  $('view').classList.remove('hidden');
  document.body.classList.add('showing-detail');
  updateBackButton();
}

function showEditor() {
  $('empty').classList.add('hidden');
  $('view').classList.add('hidden');
  $('editor').classList.remove('hidden');
  document.body.classList.add('showing-detail');
  updateBackButton();
}

/** 回到列表（仅列表模式/窄屏下用） */
function backToList() {
  document.body.classList.remove('showing-detail');
  updateBackButton();
}

async function selectEntry(scope, file) {
  try {
    const data = await api(`/api/entries?scope=${encodeURIComponent(scope)}`);
    const entry = (data.entries || []).find((e) => e.file === file);
    if (!entry) throw new Error('条目不存在（可能已被删除）');
    state.selected = entry;
    state.mode = 'view';
    renderList();
    renderDetail(entry);
    showView();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderDetail(e) {
  $('eType').textContent = e.type || '未标注';
  $('eType').dataset.t = e.type || '';
  $('eScope').textContent = e.scope;
  $('eFile').textContent = `memory/${e.file}`;
  $('eName').textContent = e.name || e.file;
  $('eDesc').textContent = e.description || '';
  $('eBody').innerHTML = renderMarkdown(e.body);

  // 索引状态标记 + 切换按钮文案
  const unTag = $('eUnindexed');
  const btn = $('btnIndexToggle');
  if (e.indexed === false) {
    unTag.classList.remove('hidden');
    unTag.textContent = '未索引';
    btn.textContent = '收录进索引';
    btn.title = '把这条写入 MEMORY.md 索引';
  } else {
    unTag.classList.add('hidden');
    btn.textContent = '移出索引';
    btn.title = '只从索引移除，文件保留';
  }
}

/** 单向切换某条目的索引状态 */
async function toggleIndexed() {
  const e = state.selected;
  if (!e) return toast('请先选择一个条目', 'err');

  const adding = e.indexed === false;
  const btn = $('btnIndexToggle');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = adding ? '收录中…' : '移出中…';

  try {
    const r = await api(adding ? '/api/index-entry' : '/api/unindex-entry', {
      method: 'POST',
      body: JSON.stringify({ scope: e.scope, file: e.file }),
    });

    // 后端用 changed 表示「索引文件是否真的被改写」
    if (r.changed === false) {
      toast(adding ? '该条目本来就在索引里，无需改动' : '该条目本来就不在索引里', '');
    } else {
      toast(adding ? '已收录进索引' : '已从索引移除，文件保留', 'ok');
    }

    await loadEntries();
    await selectEntry(e.scope, e.file);

    // 操作后校验：状态确实翻转了才算成功
    const now = state.selected;
    if (now && (now.indexed === false) === adding) {
      toast('操作已提交，但索引状态未按预期改变，请检查 MEMORY.md', 'err');
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    if (!btn.textContent || btn.textContent.includes('中…')) btn.textContent = oldText;
  }
}

function openEditor(mode) {
  state.mode = mode;
  const e = state.selected;

  if (mode === 'edit' && e) {
    $('editorTitle').textContent = '编辑条目';
    $('fName').value = e.name;
    $('fDesc').value = e.description;
    $('fType').value = e.type || 'feedback';
    $('fBody').value = e.body;
    state.editingFile = e.file;
    $('fIndexed').checked = e.indexed !== false;
    $('fIndexed').disabled = true; // 编辑时用详情页的收录/移出按钮，避免两处语义重叠
    $('fIndexedWrap').title = '索引状态请用详情页的「收录进索引 / 移出索引」按钮切换';
  } else {
    $('editorTitle').textContent = `新建条目 · ${state.currentScope}`;
    $('fName').value = '';
    $('fDesc').value = '';
    $('fType').value = 'feedback';
    $('fBody').value = '';
    state.editingFile = null;
    $('fIndexed').checked = true;
    $('fIndexed').disabled = false;
    $('fIndexedWrap').title = '取消勾选则只建文件、不写入索引';
  }
  $('saveHint').textContent = '';
  showEditor();
  $('fName').focus();
}

async function saveEntry() {
  const payload = {
    name: $('fName').value.trim(),
    description: $('fDesc').value.trim(),
    type: $('fType').value,
    body: $('fBody').value,
  };
  if (!payload.name) return toast('标题不能为空', 'err');
  if (!payload.description) return toast('描述不能为空', 'err');

  try {
    $('saveHint').textContent = '保存中…';
    if (state.mode === 'create') {
      payload.indexed = $('fIndexed').checked;
      const r = await api('/api/entry', {
        method: 'POST',
        body: JSON.stringify({ scope: state.currentScope, ...payload }),
      });
      toast(r.indexed === false ? `已创建 ${r.file}（未进索引）` : `已创建 ${r.file}`, 'ok');
      await loadScopesForCurrent();
      await loadEntries();
      await selectEntry(state.currentScope, r.file);
    } else {
      await api('/api/entry', {
        method: 'PUT',
        body: JSON.stringify({ scope: state.selected.scope, file: state.editingFile, ...payload }),
      });
      toast('已保存', 'ok');
      await loadEntries();
      await selectEntry(state.selected.scope, state.editingFile);
    }
    $('saveHint').textContent = '';
  } catch (err) {
    $('saveHint').textContent = '';
    toast(err.message, 'err');
  }
}

async function deleteEntry() {
  const e = state.selected;
  if (!e) return;

  // 顺序即默认值（showModal 勾选第一项）：危险但常用的「一起删除」放最前
  const choices = [
    {
      value: 'both',
      title: '索引和文件一起删除',
      desc: '同时删除索引行与记忆文件，不可从界面恢复。',
      danger: true,
    },
  ];
  if (e.indexed !== false) {
    choices.push({
      value: 'index',
      title: '只删除索引',
      desc: '从 MEMORY.md 移除这一行，记忆文件保留（变成「未索引」状态）。',
    });
  }

  const mode = await showModal({
    title: '删除记忆',
    html: `<div>确定要处理这条记忆吗？</div>
      <div style="margin-top:8px;font-weight:500;color:#1f2328">${esc(e.name || e.file)}</div>
      <span class="path">${esc(e.scope)} / memory/${esc(e.file)}</span>`,
    choices,
    okText: '删除',
    danger: true,
    note: '删除文件前会备份到 .memory-studio-backup。',
  });
  if (!mode) return;

  try {
    await api('/api/entry', {
      method: 'DELETE',
      body: JSON.stringify({ scope: e.scope, file: e.file, mode }),
    });
    toast(mode === 'index' ? '已从索引移除，文件保留' : '索引与文件已删除', 'ok');
    if (mode === 'index') {
      // 文件还在，重新选中它并刷新状态
      await loadEntries();
      await selectEntry(e.scope, e.file);
      return;
    }
    state.selected = null;
    showView();
    $('empty').classList.remove('hidden');
    $('view').classList.add('hidden');
    await loadScopesForCurrent();
    await loadEntries();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function loadScopesForCurrent() {
  const keep = state.currentScope;
  await loadScopes();
  if (keep) {
    state.currentScope = keep;
    renderScopes();
  }
}

// ---------------------------------------------------------------- 搜索

let searchTimer;
async function onSearchInput() {
  state.query = $('search').value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    // 日记模式走日记搜索接口，与记忆搜索完全分开
    if (state.area === 'journal') {
      await searchJournalRemote();
      return;
    }
    if (state.query.trim() && state.searchAll && !state.allEntries.length) {
      setStatus('加载全部作用域…');
      try {
        const data = await api('/api/all');
        state.allEntries = data.entries || [];
      } catch (err) {
        toast(err.message, 'err');
        state.allEntries = [];
      }
    }
    renderList();
    if (state.query.trim()) {
      setStatus(`搜索 “${state.query}” · ${visibleEntries().length} 条命中`);
    } else {
      setStatus('');
      loadEntries();
    }
  }, 180);
}

// ---------------------------------------------------------------- 日记（只读）
//
// 日记是 <作用域>/.journal/YYYY-MM-DD.md：H1 为日期，每个 ## HH:MM:SS 是一次写入批次，
// 批次内是 - 开头的留痕条目。这里只做查看，不提供任何写操作。

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 相对日期：今天 / 昨天 / 周几 */
function fmtJournalDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const now = new Date();
  const day = 86400000;
  const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - dt) / day);
  const wd = WEEKDAY[dt.getDay()];
  if (diff === 0) return { main: '今天', sub: `${m}月${d}日 · ${wd}` };
  if (diff === 1) return { main: '昨天', sub: `${m}月${d}日 · ${wd}` };
  if (dt.getFullYear() === now.getFullYear()) return { main: `${m}月${d}日`, sub: wd };
  return { main: `${y}年${m}月${d}日`, sub: wd };
}

function switchArea(area) {
  if (state.area === area) return;
  state.area = area;
  try { localStorage.setItem('memory-studio:area', area); } catch { /* 隐私模式忽略 */ }
  document.querySelectorAll('.mode-tab').forEach((b) => {
    const on = b.dataset.mode === area;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });

  const isJournal = area === 'journal';
  $('memoryListHead').classList.toggle('hidden', isJournal);
  $('journalListHead').classList.toggle('hidden', !isJournal);
  $('list').classList.toggle('hidden', isJournal);
  $('journalList').classList.toggle('hidden', !isJournal);

  // 日记模式下与记忆无关的操作按钮收起
  $('btnNew').classList.toggle('hidden', isJournal);
  $('btnIndexTools').classList.toggle('hidden', isJournal);
  $('search').placeholder = isJournal ? '搜索日记…' : '搜索记忆…';
  $('scopeToggle').title = state.searchAll
    ? '正在跨全部作用域搜索，点击改为仅当前作用域'
    : '仅搜索当前作用域，点击改为全部作用域';

  state.query = '';
  $('search').value = '';
  state.selected = null;
  state.journalDate = null;

  renderScopes();
  if (isJournal) {
    ['view', 'editor'].forEach((id) => $(id).classList.add('hidden'));
    $('journalView').classList.add('hidden');
    $('empty').classList.remove('hidden');
    document.body.classList.remove('showing-detail');
    updateBackButton();
    loadJournalDays();
  } else {
    $('journalView').classList.add('hidden');
    $('empty').classList.remove('hidden');
    document.body.classList.remove('showing-detail');
    updateBackButton();
    loadEntries();
  }
}

async function loadJournalDays() {
  if (!state.currentScope) return;
  $('journalMeta').textContent = '读取中…';
  try {
    const data = await api(`/api/journal-days?scope=${encodeURIComponent(state.currentScope)}`);
    state.journalDays = data.days || [];
    renderJournalDays();
  } catch (err) {
    toast(err.message, 'err');
    $('journalMeta').textContent = '读取失败';
  }
}

/** 当前时间筛选下可见的日期 */
function visibleJournalDays() {
  let days = state.journalDays;
  if (state.journalRange === 'week' || state.journalRange === 'month') {
    const now = new Date();
    let since;
    if (state.journalRange === 'week') {
      // 周一为一周起点
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const shift = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - shift);
      since = ymd(d);
    } else {
      since = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
    }
    days = days.filter((x) => x.date >= since);
  }
  return days;
}

function renderJournalDays() {
  const box = $('journalList');
  const days = visibleJournalDays();
  box.innerHTML = '';
  renderJournalFilters();
  $('journalMeta').textContent = `${days.length} 天`;

  if (!days.length) {
    const msg = state.journalDays.length ? '该时间范围内没有日记' : '该作用域还没有日记';
    box.innerHTML = `<div style="padding:20px 14px;color:#6b7280;font-size:13px">${msg}</div>`;
    return;
  }

  for (const d of days) {
    const rel = fmtJournalDate(d.date);
    const div = document.createElement('div');
    div.className = 'item' + (state.journalDate === d.date ? ' active' : '');
    div.innerHTML = `
      <div class="sel">
        <div class="txt">
          <div class="row1">
            <span class="t">${esc(rel.main)}</span>
            <span class="time">${esc(d.date.slice(0, 4))}</span>
          </div>
          <div class="d">${esc(rel.sub)}</div>
        </div>
      </div>`;
    div.onclick = () => openJournalDay(d.date);
    box.appendChild(div);
  }
}

function renderJournalFilters() {
  document.querySelectorAll('[data-jrange]').forEach((b) => {
    b.classList.toggle('active', b.dataset.jrange === state.journalRange);
  });
}

/** 搜索日记时把命中批次排成列表 */
function renderJournalHits() {
  const box = $('journalList');
  box.innerHTML = '';
  const hits = state.journalHits;
  $('journalMeta').textContent = `${hits.length} 处命中`;
  if (!hits.length) {
    box.innerHTML = '<div style="padding:20px 14px;color:#6b7280;font-size:13px">没有匹配的日记</div>';
    return;
  }
  for (const h of hits) {
    const rel = fmtJournalDate(h.date);
    const div = document.createElement('div');
    div.className = 'item' + (state.journalDate === h.date ? ' active' : '');
    const scopeTag = h.scope !== state.currentScope
      ? `<span class="badge">${esc(h.scope === 'global' ? 'global' : h.scope)}</span>`
      : '';
    div.innerHTML = `
      <div class="sel">
        <div class="txt">
          <div class="row1">
            <span class="t">${esc(rel.main)} · ${esc(h.stamp)}</span>
          </div>
          <div class="d">${esc(h.snippet)}</div>
          <div class="tagline">${scopeTag}</div>
        </div>
      </div>`;
    div.onclick = () => {
      if (h.scope !== state.currentScope) {
        state.currentScope = h.scope;
        renderScopes();
      }
      openJournalDay(h.date);
    };
    box.appendChild(div);
  }
}

async function openJournalDay(date) {
  if (!state.currentScope) return;
  try {
    const data = await api(
      `/api/journal-day?scope=${encodeURIComponent(state.currentScope)}&date=${encodeURIComponent(date)}`,
    );
    state.journalDate = date;
    renderJournalDays();
    if (state.query.trim()) renderJournalHits();
    renderJournalDay(data);
    $('empty').classList.add('hidden');
    $('view').classList.add('hidden');
    $('editor').classList.add('hidden');
    $('journalView').classList.remove('hidden');
    document.body.classList.add('showing-detail');
    updateBackButton();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderJournalDay(data) {
  const rel = fmtJournalDate(data.date);
  $('jTitle').textContent = `${data.date} · ${rel.sub}`;
  $('jMeta').textContent = `${data.batches} 个批次 · ${data.notes} 条留痕 · ${fmtSize(data.size)}`;
  $('jFile').textContent = `${data.scope}/${data.path}`;

  // 上/下一天按钮按当前作用域的全部日期定位（不受时间筛选影响）
  const idx = state.journalDays.findIndex((d) => d.date === data.date);
  $('btnJournalPrev').disabled = idx < 0 || idx >= state.journalDays.length - 1;
  $('btnJournalNext').disabled = idx <= 0;

  // 直接按原始 Markdown 展示（# 日期 + ## 时间 + - 条目），不做卡片化改造
  const box = $('jBody');
  if (!data.sections.length) {
    box.innerHTML = '<div class="muted small">这一天还没有写入任何批次。</div>';
    return;
  }
  const text = [`# ${data.date}`, ...data.sections.map((s) => `## ${s.stamp}\n${s.body}`)].join('\n\n');
  box.innerHTML = renderMarkdown(text);
}

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}

/** 在日期轴上前后翻页 */
function stepJournalDay(delta) {
  const idx = state.journalDays.findIndex((d) => d.date === state.journalDate);
  if (idx < 0) return;
  const next = state.journalDays[idx + delta];
  if (next) openJournalDay(next.date);
}

async function copyJournalDay() {
  if (!state.journalDate) return;
  try {
    const data = await api(
      `/api/journal-day?scope=${encodeURIComponent(state.currentScope)}&date=${encodeURIComponent(state.journalDate)}`,
    );
    const text = [`# ${data.date}`, ...data.sections.map((s) => `## ${s.stamp}\n${s.body}`)].join('\n\n');
    await navigator.clipboard.writeText(text);
    toast('已复制当天日记', 'ok');
  } catch (err) {
    toast('复制失败：' + err.message, 'err');
  }
}

/** 日记搜索（当前作用域或全部作用域，由搜索框内的范围按钮决定） */
async function searchJournalRemote() {
  const q = state.query.trim();
  if (!q) {
    state.journalHits = [];
    $('journalMeta').textContent = '';
    return renderJournalDays();
  }
  try {
    const scopeParam = state.searchAll ? '' : `&scope=${encodeURIComponent(state.currentScope)}`;
    const data = await api(`/api/journal-search?q=${encodeURIComponent(q)}${scopeParam}`);
    state.journalHits = data.hits || [];
    renderJournalHits();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------- 初始化

async function init() {
  // 恢复上次的列宽与布局选择
  initGutters();
  restoreColWidths();
  const savedView = localStorage.getItem('memory-studio:view');
  applyView(['three', 'preview', 'list'].includes(savedView) ? savedView : 'three');

  // 恢复上次的区域（记忆 / 日记）；switchArea 在首次加载前调用会读不到作用域，
  // 所以这里只改状态与按钮外观，真正的列表加载放在作用域就绪之后
  const savedArea = localStorage.getItem('memory-studio:area');
  if (savedArea === 'journal') {
    state.area = 'journal';
  }

  try {
    const h = await api('/api/health');
    if (!h.rootExists) {
      toast('数据目录不存在：' + h.root, 'err');
    }
    $('rootPath').textContent = h.root;
    const restoreJournal = state.area === 'journal';
    state.area = 'memory';
    await loadScopes();
    if (!state.scopes.length) {
      setStatus('没有找到任何作用域');
      return;
    }
    await selectScope(state.scopes[0].name);
    if (restoreJournal) switchArea('journal');
  } catch (err) {
    toast(err.message, 'err');
  }
}

window.addEventListener('resize', updateBackButton);

// ---------------------------------------------------------------- 移动到其他作用域

async function chooseTargetScope(title, excludeScope) {
  const options = state.scopes.filter((s) => s.name !== excludeScope);
  if (!options.length) {
    await showAlert('没有可用的目标作用域', '<div>当前只有一个作用域，无法移动。</div>');
    return null;
  }
  const choices = options.map((s) => ({
    value: s.name,
    title: s.label,
    desc: `${s.count} 条`,
  }));
  return showModal({
    title,
    html: '<div>选择目标作用域：</div>',
    choices,
    okText: '移动',
  });
}

async function moveCurrentEntry() {
  const e = state.selected;
  if (!e) return;
  const toScope = await chooseTargetScope('移动记忆', e.scope);
  if (!toScope) return;
  try {
    const r = await api('/api/move-entry', {
      method: 'POST',
      body: JSON.stringify({ scope: e.scope, file: e.file, toScope, keepIndexed: e.indexed !== false }),
    });
    toast(r.renamed ? `已移动到 ${r.toScope}（重名，已改名为 ${r.toFile}）` : `已移动到 ${r.toScope}`, 'ok');
    await loadScopesForCurrent();
    await loadEntries();
    await selectEntry(r.toScope, r.toFile);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------- 批量执行

async function runBatch(action) {
  if (!state.picked.length) return;
  const items = [...state.picked];
  let opts = {};

  if (action === 'delete') {
    const hasIndexed = items.some((it) => {
      const found = state.entries.find((e) => e.file === it.file && (e._scope || e.scope) === it.scope);
      return found && found.indexed !== false;
    });
    // 顺序即默认值：把「一起删除」放最前
    const choices = [
      { value: 'both', title: '索引和文件一起删除', desc: `${items.length} 个文件将被删除。`, danger: true },
    ];
    if (hasIndexed) {
      choices.push({ value: 'index', title: '只删除索引', desc: '从 MEMORY.md 移除这些行，文件全部保留。' });
    }
    opts.mode = await showModal({
      title: `批量删除 ${items.length} 项`,
      html: '<div>请选择删除方式：</div>',
      choices,
      okText: '删除',
      danger: true,
      note: '删除文件前会备份到 .memory-studio-backup。',
    });
    if (!opts.mode) return;
  } else if (action === 'move') {
    const toScope = await chooseTargetScope(`批量移动 ${items.length} 项`);
    if (!toScope) return;
    opts.toScope = toScope;
  } else {
    const label = { index: '收录进索引', unindex: '移出索引' }[action];
    const ok = await showModal({
      title: `批量${label}`,
      html: `<div>将对选中的 <strong>${items.length}</strong> 项执行「${label}」。</div>`,
      okText: '执行',
    });
    if (!ok) return;
  }

  try {
    const r = await api('/api/batch', {
      method: 'POST',
      body: JSON.stringify({ action, items, ...opts }),
    });
    if (r.failed) {
      await showAlert(
        `完成 ${r.ok} / ${r.total} 项`,
        `<div>有 ${r.failed} 项失败：</div><div class="note">${r.results
          .filter((x) => !x.ok)
          .map((x) => `${esc(x.file)}：${esc(x.error)}`)
          .join('<br>')}</div>`,
      );
    } else {
      toast(`已完成 ${r.ok} 项`, 'ok');
    }
    state.picked = [];
    await loadScopesForCurrent();
    await loadEntries();
    if (action === 'delete' && opts.mode !== 'index') {
      state.selected = null;
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------- 由路径创建工作区

/** 专门的路径输入弹窗（需要读取输入框内容，故单独实现） */
function promptScopePath() {
  return new Promise((resolve) => {
    const root = $('modalRoot');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">新建工作区（作用域）</div>
        <div class="modal-body">
          <div>输入本地路径，按 memory-md 规则生成作用域名：</div>
          <div class="field"><input id="scopePathInput" type="text" placeholder="D:\\workspaces\\my-project" autocomplete="off" spellcheck="false"></div>
          <div id="scopePreview" class="note">作用域名将显示在这里</div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">创建</button>
        </div>
      </div>`;
    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      mask.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter') { e.preventDefault(); close(mask.querySelector('#scopePathInput').value.trim()); }
    };
    const input = mask.querySelector('#scopePathInput');
    const preview = mask.querySelector('#scopePreview');

    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const v = input.value.trim();
      if (!v) { preview.textContent = '作用域名将显示在这里'; return; }
      timer = setTimeout(async () => {
        try {
          const r = await api(`/api/scope-preview?path=${encodeURIComponent(v)}`);
          preview.textContent = r.ok ? `作用域名：${r.scope}` : r.error;
        } catch {
          preview.textContent = '无法解析该路径';
        }
      }, 200);
    });

    mask.querySelector('[data-act="cancel"]').onclick = () => close(null);
    mask.querySelector('[data-act="ok"]').onclick = () => close(input.value.trim());
    document.addEventListener('keydown', onKey);
    root.appendChild(mask);
    input.focus();
  });
}

async function doCreateScope() {
  const p = await promptScopePath();
  if (!p) return;
  try {
    const r = await api('/api/scope', { method: 'POST', body: JSON.stringify({ path: p }) });
    toast(r.existed ? `工作区已存在：${r.scope}` : `已创建：${r.scope}`, 'ok');
    await loadScopes();
    await selectScope(r.scope);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------- 事件绑定

// 布局切换菜单
$('btnLayout').onclick = (ev) => {
  ev.stopPropagation();
  $('layoutMenu').classList.toggle('hidden');
};
document.addEventListener('click', (ev) => {
  const menu = $('layoutMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (!ev.target.closest('.layout-switch')) menu.classList.add('hidden');
});
document.querySelectorAll('.menu-item').forEach((it) => {
  it.onclick = () => {
    applyView(it.dataset.view);
    $('layoutMenu').classList.add('hidden');
  };
});

$('btnBack').onclick = backToList;

// ---- 日记 ----
document.querySelectorAll('.mode-tab').forEach((b) => {
  b.onclick = () => switchArea(b.dataset.mode);
});
document.querySelectorAll('[data-jrange]').forEach((b) => {
  b.onclick = () => {
    state.journalRange = b.dataset.jrange;
    if (state.query.trim()) renderJournalHits();
    else renderJournalDays();
  };
});
$('btnJournalBack').onclick = backToList;
$('btnJournalPrev').onclick = () => stepJournalDay(-1);
$('btnJournalNext').onclick = () => stepJournalDay(1);
$('btnJournalCopy').onclick = copyJournalDay;

$('btnNew').onclick = () => {
  if (!state.currentScope) return toast('请先选择一个作用域', 'err');
  openEditor('create');
};
$('btnNewScope').onclick = doCreateScope;
$('btnEdit').onclick = () => openEditor('edit');
$('btnMove').onclick = moveCurrentEntry;
$('btnIndexToggle').onclick = toggleIndexed;
$('btnSave').onclick = saveEntry;
$('btnCancel').onclick = () => {
  if (state.selected) {
    renderDetail(state.selected);
    showView();
  } else {
    $('editor').classList.add('hidden');
    $('empty').classList.remove('hidden');
  }
};
$('btnDelete').onclick = deleteEntry;
$('btnBatchMode').onclick = toggleBatchMode;
document.querySelectorAll('[data-filter]').forEach((b) => {
  b.onclick = () => {
    state.filter = b.dataset.filter;
    renderFilters();
    renderList();
  };
});
document.querySelectorAll('[data-batch]').forEach((b) => {
  b.onclick = () => {
    const act = b.dataset.batch;
    if (act === 'cancel') return toggleBatchMode();
    runBatch(act);
  };
});
$('search').addEventListener('input', onSearchInput);
$('scopeToggle').onclick = toggleSearchScope;

document.addEventListener('keydown', (evt) => {
  if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'k') {
    evt.preventDefault();
    $('search').focus();
  }
  if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 's') {
    if ((state.mode === 'edit' || state.mode === 'create') && !$('editor').classList.contains('hidden')) {
      evt.preventDefault();
      saveEntry();
    }
  }
  if (evt.key === 'Escape') {
    if (!$('editor').classList.contains('hidden')) $('btnCancel').click();
  }
});

$('btnIndexTools').onclick = openIndexTools;

init();
