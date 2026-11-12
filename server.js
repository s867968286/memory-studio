#!/usr/bin/env node
'use strict';

/**
 * memory-studio —— memory-md 记忆文件的独立查看/编辑工具
 *
 * 只读写 memory-md 插件生成的数据目录（默认 ~/.dsh/memory-md），
 * 不依赖 DSH 运行时，也不修改插件本身。
 *
 * 零第三方依赖，只用 Node 内置模块。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { URL } = require('node:url');

// ---------------------------------------------------------------- 配置

const ROOT_DIR = process.env.MEMORY_MD_ROOT || path.join(os.homedir(), '.dsh', 'memory-md');
const PORT = Number(process.env.PORT) || 7788;
const HOST = process.env.HOST || '127.0.0.1';
const BACKUP_DIR = path.join(ROOT_DIR, '.memory-studio-backup');

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference']);

// ---------------------------------------------------------------- 数据模型

/**
 * 记忆文件形如：
 *   ---
 *   name: 标题
 *   description: 一句话描述
 *   type: feedback
 *   ---
 *
 *   正文
 */
function parseEntry(text, filePath) {
  const normalized = text.replace(/\r\n/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    return { frontmatter: {}, body: normalized, raw: text, hasFrontmatter: false };
  }
  const frontmatter = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // 去掉成对的引号
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: m[2], raw: text, hasFrontmatter: true };
}

/** 生成文件内容，保持插件使用的 frontmatter 字段顺序 */
function serializeEntry(frontmatter, body) {
  const order = ['name', 'description', 'type'];
  const keys = [...order.filter((k) => k in frontmatter), ...Object.keys(frontmatter).filter((k) => !order.includes(k))];
  const head = keys.map((k) => `${k}: ${frontmatter[k]}`).join('\n');
  const cleanBody = body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return `---\n${head}\n---\n\n${cleanBody}\n`;
}

/** 索引行格式：- [标题](memory/文件名.md) — 描述 */
function indexLine(entry) {
  const title = entry.name || path.basename(entry.file, '.md');
  const desc = entry.description || '';
  return `- [${title}](memory/${entry.file}) — ${desc}`;
}

/**
 * 解析 MEMORY.md 索引。
 *
 * 与 memory-md 的 indexLineTargets() 用同一套匹配规则
 * （dsh-memory-md/src/store.mjs）。
 *
 * 曾用 `/^-\s*\[([^\]]*)\]\((memory\/[^)]+)\)/`：`[^\]]*` 遇上标题里的方括号
 * （实测最常见 `byte[]`）会在第一个 `]` 处截断，整行解析失败，于是
 * "是否已存在"永远判否、索引里堆出同一行的多份副本（实测 7 份）。
 *
 * 但也不能无条件从右往左取最后一个 `](` —— 描述里出现 `](memory/b.md)` 是自然写法：
 *
 *   - [甲](memory/a.md) — 见 ](memory/b.md) 那条
 *
 * 那样会取到 `memory/b.md`，导致写乙时把甲的行顶掉、删乙时连带删甲。
 *
 * 所以采用插件的折中：标题里**只允许一对**方括号（`byte[]`、`byte[1024]`），
 * 描述里的链接照旧看不见。标题含多组方括号时显式不匹配（不误伤别人的行）。
 */
function parseIndex(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  const re = /^-\s*\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\((memory\/[^)]+)\)\s*[—–-]?\s*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = re.exec(raw);
    if (!m) continue;
    const relPath = m[2];
    entries.push({
      lineNo: i,
      title: m[1],
      relPath,
      file: path.basename(relPath),
      description: (m[3] || '').trim(),
      raw,
    });
  }
  return { lines, entries };
}

// ---------------------------------------------------------------- 作用域扫描

function scopeDir(scope) {
  // scope 是目录名，必须防止路径穿越。
  // 字符集与 slugFromPath 保持一致：允许中文等非 ASCII（-￿），
  // 否则中文工作区的作用域能列出来、却一点就报「非法的作用域名」。
  // 路径分隔符（/  :）与 Windows 保留字符都在 ASCII 段，已被排除，不会穿越。
  if (!/^[A-Za-z0-9._\u0080-\uFFFF-]+$/.test(scope) || scope === '.' || scope === '..') {
    throw new Error('非法的作用域名: ' + scope);
  }
  const dir = path.join(ROOT_DIR, scope);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(ROOT_DIR) + path.sep)) {
    throw new Error('作用域越界: ' + scope);
  }
  return resolved;
}

function isScopeDir(dirPath) {
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return false;
    return fs.existsSync(path.join(dirPath, 'memory'));
  } catch {
    return false;
  }
}

async function listScopes() {
  let names;
  try {
    names = await fsp.readdir(ROOT_DIR);
  } catch {
    return [];
  }
  const result = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(ROOT_DIR, name);
    if (!isScopeDir(dir)) continue;
    let count = 0;
    try {
      const files = await fsp.readdir(path.join(dir, 'memory'));
      count = files.filter((f) => f.endsWith('.md')).length;
    } catch {
      count = 0;
    }
    result.push({
      name,
      count,
      journalDays: await countJournalDays(dir),
      label: name === 'global' ? '全局（global）' : name,
      isGlobal: name === 'global',
    });
  }
  // global 固定置顶，其余按名称字母顺序（不区分大小写，数字/符号自然排前）
  result.sort((a, b) => {
    if (a.isGlobal !== b.isGlobal) return a.isGlobal ? -1 : 1;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true });
  });
  return result;
}

// ---------------------------------------------------------------- 日记（.journal）
//
// 日记由 memory-md 插件写入 <作用域>/.journal/YYYY-MM-DD.md，格式固定：
//
//   # 2026-09-30          H1 是日期
//
//   ## 10:37:58           H2 是批次时间（每次 memory_md_journal 调用一批）
//   - 一条留痕
//   - 又一条
//
// 与记忆正文不同，日记没有 frontmatter、不进 MEMORY.md，插件自己也只写不读
// （见 dsh-memory-md/src/store.mjs 的 appendJournalEntries），
// 所以这里只做只读查看，不提供索引状态，也不做任何写操作。

const JOURNAL_DIR = '.journal';
const JOURNAL_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const JOURNAL_BLOCK_RE = /^\s{0,3}##\s+(.+?)\s*$/;

function journalDir(scope) {
  return path.join(scopeDir(scope), JOURNAL_DIR);
}

function ensureJournalDate(date) {
  const s = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('非法的日记日期: ' + s);
  // 不用 toISOString 校验：它按 UTC 换算，东八区的本地 00:00 会退成前一天，
  // 导致所有合法日期都被判非法。这里只检查月/日是否越界（如 2026-02-31）。
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new Error('非法的日记日期: ' + s);
  }
  return s;
}

async function listJournalDates(scope) {
  let files;
  try {
    files = await fsp.readdir(journalDir(scope));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const m = JOURNAL_FILE_RE.exec(f);
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .sort()
    .reverse();
}

async function countJournalDays(dir) {
  try {
    const files = await fsp.readdir(path.join(dir, JOURNAL_DIR));
    return files.filter((f) => JOURNAL_FILE_RE.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * 解析一天的日记内容。
 *
 * sections 保留每个批次的原文，批次切分只用于展示时间轴；
 * 首个 ## 之前的内容（日期标题行）不进入批次。
 * 认不出的行原样留在所属批次的 body 里，不会被丢弃。
 */
function parseJournal(text, date) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    const m = JOURNAL_BLOCK_RE.exec(line);
    if (m) {
      current = { stamp: m[1], notes: [], lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue; // 首个批次之前的内容（日期标题行）
    current.lines.push(line);
    const note = line.match(/^\s*[-*+]\s+(.*)$/);
    if (note) current.notes.push(note[1].trim());
  }

  for (const s of sections) {
    while (s.lines.length && !s.lines[s.lines.length - 1].trim()) s.lines.pop();
    while (s.lines.length && !s.lines[0].trim()) s.lines.shift();
    s.body = s.lines.join('\n');
    delete s.lines;
    s.noteCount = s.notes.length;
  }

  return {
    date,
    sections,
    batches: sections.length,
    notes: sections.reduce((n, s) => n + s.noteCount, 0),
  };
}

async function readJournalDay(scope, date) {
  const d = ensureJournalDate(date);
  const full = path.join(journalDir(scope), d + '.md');
  let text;
  try {
    text = await fsp.readFile(full, 'utf8');
  } catch {
    throw new Error('该作用域没有 ' + d + ' 的日记');
  }
  return {
    scope,
    ...parseJournal(text, d),
    size: Buffer.byteLength(text),
    path: JOURNAL_DIR + '/' + d + '.md',
  };
}

/** 日期轴：某作用域的全部日记日期，新到旧 */
async function listJournalDays(scope) {
  const dates = await listJournalDates(scope);
  return dates.map((date) => ({ date }));
}

/** 日记正文搜索；scope 为空时跨全部作用域 */
async function searchJournal(query, scope) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { hits: [] };
  const scopes = scope ? [{ name: scope }] : await listScopes();
  const hits = [];

  for (const s of scopes) {
    const dates = await listJournalDates(s.name);
    for (const date of dates) {
      let text;
      try {
        text = await fsp.readFile(path.join(journalDir(s.name), date + '.md'), 'utf8');
      } catch {
        continue;
      }
      for (const sec of parseJournal(text, date).sections) {
        const blob = sec.stamp + '\n' + sec.body;
        const at = blob.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        hits.push({
          scope: s.name,
          date,
          stamp: sec.stamp,
          snippet: snippetAround(blob, at, needle.length),
        });
      }
    }
  }
  hits.sort((a, b) => (a.date === b.date ? (a.stamp < b.stamp ? 1 : -1) : a.date < b.date ? 1 : -1));
  return { hits };
}

/** 取命中位置前后各 40 字作为片段 */
function snippetAround(text, at, len) {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + len + 40);
  const flat = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + flat + (end < text.length ? '…' : '');
}

async function readEntries(scope) {
  const dir = path.join(scopeDir(scope), 'memory');
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const indexed = await indexedFileSet(scope);
  const entries = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    try {
      const [text, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
      const parsed = parseEntry(text, full);
      entries.push({
        scope,
        file,
        path: full,
        name: parsed.frontmatter.name || '',
        description: parsed.frontmatter.description || '',
        type: parsed.frontmatter.type || '',
        body: parsed.body.trim(),
        hasFrontmatter: parsed.hasFrontmatter,
        indexed: indexed.has(file),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch (err) {
      entries.push({
        scope,
        file,
        path: full,
        name: '',
        description: '',
        type: '',
        body: '',
        error: String(err && err.message ? err.message : err),
        indexed: indexed.has(file),
        mtime: 0,
        size: 0,
      });
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

/** 读取某个作用域的索引状态：孤儿文件（未收录）与失效引用（指向不存在文件） */
async function indexStatus(scope) {
  const dir = scopeDir(scope);
  const indexFile = path.join(dir, 'MEMORY.md');
  let indexText = '';
  try {
    indexText = await fsp.readFile(indexFile, 'utf8');
  } catch {
    indexText = '';
  }
  const parsed = parseIndex(indexText);
  let files = [];
  try {
    files = (await fsp.readdir(path.join(dir, 'memory'))).filter((f) => f.endsWith('.md'));
  } catch {
    files = [];
  }
  const indexed = new Set(parsed.entries.map((e) => e.file));
  const fileSet = new Set(files);
  const orphans = files.filter((f) => !indexed.has(f));
  const dangling = parsed.entries.filter((e) => !fileSet.has(e.file)).map((e) => e.file);
  const duplicates = files.filter((f, i) => files.indexOf(f) !== i);
  return {
    total: files.length,
    indexedCount: parsed.entries.length,
    orphans,
    dangling,
    duplicates: [...new Set(duplicates)],
    indexExists: indexText.length > 0,
  };
}

/** 每个条目的索引状态，供列表标记与筛选 */
async function indexedFileSet(scope) {
  const indexFile = path.join(scopeDir(scope), 'MEMORY.md');
  let text = '';
  try {
    text = await fsp.readFile(indexFile, 'utf8');
  } catch {
    text = '';
  }
  return new Set(parseIndex(text).entries.map((e) => e.file));
}

/**
 * 重建索引。
 *
 * 默认【保留未索引状态】：只清理失效引用、刷新已有行的标题/描述，
 * 不把孤儿文件收进索引 —— 未索引是允许的合法状态。
 * 传 includeOrphans=true 时才把全部孤儿文件收录进来。
 */
async function rebuildIndex(scope, includeOrphans = false) {
  const dir = scopeDir(scope);
  const indexFile = path.join(dir, 'MEMORY.md');
  let oldText = '';
  try {
    oldText = await fsp.readFile(indexFile, 'utf8');
  } catch {
    oldText = '';
  }
  const parsed = parseIndex(oldText);
  const entries = await readEntries(scope);
  const byFile = new Map(entries.map((e) => [e.file, e]));

  // 保留原有顺序（但刷新标题/描述），失效引用与重复行丢弃
  const lines = [];
  const used = new Set();
  for (const item of parsed.entries) {
    const entry = byFile.get(item.file);
    if (!entry) continue;
    if (used.has(entry.file)) continue;
    used.add(entry.file);
    lines.push(indexLine(entry));
  }

  let added = 0;
  if (includeOrphans) {
    const rest = entries.filter((e) => !used.has(e.file)).sort((a, b) => a.mtime - b.mtime);
    for (const entry of rest) {
      lines.push(indexLine(entry));
      used.add(entry.file);
      added++;
    }
  }

  const content = `# MEMORY.md\n\n${lines.join('\n')}\n`;
  if (content !== oldText) {
    await backupFile(indexFile);
    await fsp.writeFile(indexFile, content, 'utf8');
  }
  return { added, total: lines.length, keptUnindexed: includeOrphans ? 0 : entries.length - used.size };
}

/** 把单个条目写进索引（不存在则追加） */
async function indexSingle(scope, file) {
  const dir = scopeDir(scope);
  const indexFile = path.join(dir, 'MEMORY.md');
  ensureEntryFile(scope, file);
  const entries = await readEntries(scope);
  const entry = entries.find((e) => e.file === file);
  if (!entry) throw new Error('条目不存在: ' + file);

  let oldText = '';
  try {
    oldText = await fsp.readFile(indexFile, 'utf8');
  } catch {
    oldText = '';
  }
  const parsed = parseIndex(oldText);
  if (parsed.entries.some((e) => e.file === file)) return { changed: false };

  const lines = oldText.trim() ? [...parsed.lines] : ['# MEMORY.md', ''];
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push(indexLine(entry));
  const content = lines.join('\n') + '\n';
  await backupFile(indexFile);
  await fsp.writeFile(indexFile, content, 'utf8');
  return { changed: true };
}

/** 从索引里移除某个文件的行（文件保留） */
async function unindexSingle(scope, file) {
  const dir = scopeDir(scope);
  const indexFile = path.join(dir, 'MEMORY.md');
  let oldText = '';
  try {
    oldText = await fsp.readFile(indexFile, 'utf8');
  } catch {
    return { changed: false };
  }
  const parsed = parseIndex(oldText);
  const keep = parsed.lines.filter((line) => {
    const m = line.match(/^-\s*\[[^\]]*\]\((memory\/[^)]+)\)/);
    return !(m && m[1] === `memory/${file}`);
  });
  if (keep.length === parsed.lines.length) return { changed: false };
  const content = keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  await backupFile(indexFile);
  await fsp.writeFile(indexFile, content, 'utf8');
  return { changed: true };
}

// ---------------------------------------------------------------- 备份

/**
 * 修改前备份。同一文件同一天只保留首次备份，
 * 避免连续编辑把备份目录撑爆（每份都是完整旧内容，够回滚用）。
 */
async function backupFile(target) {
  try {
    await fsp.stat(target);
    const day = new Date().toISOString().slice(0, 10);
    const rel = path.relative(ROOT_DIR, target).replace(/[\\/]/g, '__');
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `${rel}.${day}.bak`);
    if (fs.existsSync(dest)) return false;
    await fsp.copyFile(target, dest);
    return true;
  } catch {
    return false; // 文件不存在时无需备份
  }
}

// ---------------------------------------------------------------- 变更接口实现

async function createEntry(scope, payload) {
  const { name, description, type, body } = payload;
  if (!name || !name.trim()) throw new Error('name（标题）不能为空');
  if (!description || !description.trim()) throw new Error('description 不能为空');
  if (!VALID_TYPES.has(type)) throw new Error('type 必须是 user / feedback / project / reference 之一');

  const dir = scopeDir(scope);
  const memoryDir = path.join(dir, 'memory');
  await fsp.mkdir(memoryDir, { recursive: true });

  // 文件名由 title 生成：保留 Unicode，空格与标点转下划线，避免非法字符
  const safeName = name
    .trim()
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  let file = `${type}_${safeName}.md`;
  let n = 2;
  while (fs.existsSync(path.join(memoryDir, file))) {
    file = `${type}_${safeName}_${n++}.md`;
  }

  const content = serializeEntry(
    { name: name.trim(), description: description.trim(), type },
    body || '',
  );
  await fsp.writeFile(path.join(memoryDir, file), content, 'utf8');
  // 新建默认进索引；payload.indexed === false 时只建文件、不进索引
  if (payload.indexed !== false) await indexSingle(scope, file);
  return { file, scope, indexed: payload.indexed !== false };
}

async function updateEntry(scope, file, payload) {
  ensureEntryFile(scope, file);
  const full = path.join(scopeDir(scope), 'memory', file);
  const parsed = parseEntry(await fsp.readFile(full, 'utf8'), full);

  const next = { ...parsed.frontmatter };
  if (payload.name !== undefined) {
    if (!payload.name.trim()) throw new Error('name（标题）不能为空');
    next.name = payload.name.trim();
  }
  if (payload.description !== undefined) {
    if (!payload.description.trim()) throw new Error('description 不能为空');
    next.description = payload.description.trim();
  }
  if (payload.type !== undefined) {
    if (!VALID_TYPES.has(payload.type)) throw new Error('type 非法');
    next.type = payload.type;
  }
  const body = payload.body !== undefined ? payload.body : parsed.body;

  await backupFile(full);
  await fsp.writeFile(full, serializeEntry(next, body), 'utf8');
  // 只刷新它自己那一行，不顺手收录其它孤儿条目
  await refreshIndexLine(scope, file);
  return { file, scope };
}

/** 若该条目已在索引中，刷新它的标题/描述；未索引则保持未索引 */
async function refreshIndexLine(scope, file) {
  const dir = scopeDir(scope);
  const indexFile = path.join(dir, 'MEMORY.md');
  let oldText = '';
  try {
    oldText = await fsp.readFile(indexFile, 'utf8');
  } catch {
    return { changed: false };
  }
  const parsed = parseIndex(oldText);
  const hit = parsed.entries.find((e) => e.file === file);
  if (!hit) return { changed: false };

  const entries = await readEntries(scope);
  const entry = entries.find((e) => e.file === file);
  if (!entry) return { changed: false };

  const fresh = indexLine(entry);
  if (fresh === hit.raw) return { changed: false };
  const lines = [...parsed.lines];
  lines[hit.lineNo] = fresh;
  await backupFile(indexFile);
  await fsp.writeFile(indexFile, lines.join('\n').replace(/\s+$/, '') + '\n', 'utf8');
  return { changed: true };
}

/**
 * 删除条目。
 *
 * mode:
 *   'both'    —— 删除索引行 + 删除文件（默认，原来的行为）
 *   'index'   —— 只从索引移除，文件保留（文件变成"未索引"状态）
 *   'file'    —— 只删除文件，索引行一并清掉（否则会变成失效引用）
 */
async function deleteEntry(scope, file, mode = 'both') {
  ensureEntryFile(scope, file);
  const full = path.join(scopeDir(scope), 'memory', file);

  if (mode === 'index') {
    const r = await unindexSingle(scope, file);
    return { file, scope, mode, removedFile: false, removedIndex: r.changed };
  }

  await backupFile(full);
  await fsp.unlink(full);
  const r = await unindexSingle(scope, file);
  return { file, scope, mode, removedFile: true, removedIndex: r.changed };
}

function ensureEntryFile(scope, file) {
  if (!/^[^\\/]+\.md$/.test(file) || file.includes('..')) {
    throw new Error('非法的文件名: ' + file);
  }
  const full = path.join(scopeDir(scope), 'memory', file);
  if (!fs.existsSync(full)) throw new Error('条目不存在: ' + file);
  return full;
}

// ---------------------------------------------------------------- 移动

/**
 * 把条目移动到另一个作用域。
 * 目标作用域不存在时会报错（需先创建），避免手误写出新目录。
 * 目标已有同名文件时自动加后缀，不覆盖。
 */
async function moveEntry(fromScope, file, toScope, keepIndexed = true) {
  ensureEntryFile(fromScope, file);
  if (fromScope === toScope) throw new Error('源作用域与目标作用域相同');

  const targetDir = scopeDir(toScope);
  if (!isScopeDir(targetDir)) throw new Error(`目标作用域不存在: ${toScope}`);
  const targetMemory = path.join(targetDir, 'memory');
  await fsp.mkdir(targetMemory, { recursive: true });

  // 目标重名时加序号
  const parsedName = path.parse(file);
  let targetFile = file;
  let n = 2;
  while (fs.existsSync(path.join(targetMemory, targetFile))) {
    targetFile = `${parsedName.name}_${n++}${parsedName.ext}`;
  }

  const src = path.join(scopeDir(fromScope), 'memory', file);
  const dest = path.join(targetMemory, targetFile);
  await fsp.copyFile(src, dest);
  await fsp.unlink(src);

  await unindexSingle(fromScope, file);
  if (keepIndexed) await indexSingle(toScope, targetFile);
  else await unindexSingle(toScope, targetFile);

  return { fromScope, toScope, fromFile: file, toFile: targetFile, renamed: targetFile !== file };
}

// ---------------------------------------------------------------- 批量

/**
 * 批量操作。
 * action: 'delete' | 'move' | 'index' | 'unindex'
 * items: [{ scope, file }]
 * 删除沿用 mode：'index'（只删索引）/ 'both'（索引+文件）
 */
async function batchOperate(action, items, opts = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('没有选中任何条目');
  const results = [];
  for (const item of items) {
    try {
      if (action === 'delete') {
        const r = await deleteEntry(item.scope, item.file, opts.mode || 'both');
        results.push({ ...item, ok: true, detail: r });
      } else if (action === 'move') {
        if (!opts.toScope) throw new Error('缺少目标作用域');
        const r = await moveEntry(item.scope, item.file, opts.toScope, opts.keepIndexed !== false);
        results.push({ ...item, ok: true, detail: r });
      } else if (action === 'index') {
        ensureEntryFile(item.scope, item.file);
        await indexSingle(item.scope, item.file);
        results.push({ ...item, ok: true });
      } else if (action === 'unindex') {
        ensureEntryFile(item.scope, item.file);
        await unindexSingle(item.scope, item.file);
        results.push({ ...item, ok: true });
      } else {
        throw new Error('未知的批量操作: ' + action);
      }
    } catch (err) {
      results.push({ ...item, ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { action, total: results.length, ok: okCount, failed: results.length - okCount, results };
}

// ---------------------------------------------------------------- 按路径创建工作区（作用域）

/**
 * 由本地路径生成作用域名（工作区目录名）。
 *
 * **逐行对齐 memory-md 的 getCompressedWorkDir()**（src/codebuddy-port.mjs），
 * 包括它「保留非 ASCII（中文）」这一处有意偏离上游的改动。
 *
 * 规则：
 *   - 反斜杠统一成正斜杠，去掉盘符冒号，去掉开头斜杠
 *   - 除 [A-Za-z0-9] 与 -￿（中文等非 ASCII）之外的一切字符折成 "-"
 *     —— 注意 "." 和 "_" 也会被折成 "-"，这是为了与插件保持一致
 *   - 连续 "-" 压成一个，去掉首尾 "-"，英文转小写
 *
 * 例：
 *   D:\workspaces\ai        ->  d-workspaces-ai
 *   D:\workspaces\v1.3.0    ->  d-workspaces-v1-3-0
 *   D:\测试中文路径             ->  d-测试中文路径
 */
function slugFromPath(input) {
  let p = String(input || '').trim();
  if (!p) throw new Error('请填写本地路径');
  // 去掉包裹的引号（从资源管理器复制路径常带引号）
  p = p.replace(/^["']|["']$/g, '').trim();
  if (!p) throw new Error('路径无效');

  // 逐行对齐 memory-md 的 getCompressedWorkDir()
  // （src/codebuddy-port.mjs，含其「保留非 ASCII」的偏离上游改动）
  let s = p.replace(/\\/g, '/');
  s = s.replace(/^([A-Za-z]):/, '$1');
  s = s.replace(/^\/+/, '');
  const slug = s
    .replace(/[^A-Za-z0-9\u0080-\uFFFF]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  if (!slug) throw new Error('无法从路径推导出作用域名');
  return slug;
}

/** 创建作用域目录骨架，已存在时直接返回 */
async function createScope(inputPath) {
  const scope = slugFromPath(inputPath);
  const dir = scopeDir(scope);
  const existed = isScopeDir(dir);
  if (!existed) {
    await fsp.mkdir(path.join(dir, 'memory'), { recursive: true });
    const indexFile = path.join(dir, 'MEMORY.md');
    if (!fs.existsSync(indexFile)) {
      await fsp.writeFile(indexFile, '# MEMORY.md\n\n', 'utf8');
    }
  }
  return { scope, path: dir, existed };
}

// ---------------------------------------------------------------- HTTP

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(__dirname, 'public', name);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(__dirname, 'public') + path.sep)) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const content = await fsp.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const routes = {
  'GET /api/health': async () => ({
    ok: true,
    root: ROOT_DIR,
    port: PORT,
    rootExists: fs.existsSync(ROOT_DIR),
  }),

  'GET /api/scopes': async () => ({ root: ROOT_DIR, scopes: await listScopes() }),

  'GET /api/entries': async (_req, url) => {
    const scope = url.searchParams.get('scope');
    if (!scope) throw new Error('缺少 scope 参数');
    return { scope, entries: await readEntries(scope) };
  },

  'GET /api/all': async () => {
    // 全量汇总，供跨作用域搜索
    const scopes = await listScopes();
    const all = [];
    for (const s of scopes) {
      const entries = await readEntries(s.name);
      for (const e of entries) all.push(e);
    }
    return { entries: all };
  },

  'GET /api/index-status': async (_req, url) => {
    const scope = url.searchParams.get('scope');
    if (!scope) throw new Error('缺少 scope 参数');
    return await indexStatus(scope);
  },

  'POST /api/rebuild-index': async (body) => {
    if (!body.scope) throw new Error('缺少 scope 参数');
    // includeOrphans=true 时把未索引的文件也收录；默认保留未索引状态
    const result = await rebuildIndex(body.scope, body.includeOrphans === true);
    return { ok: true, ...result };
  },

  'POST /api/entry': async (body) => {
    if (!body.scope) throw new Error('缺少 scope 参数');
    return { ok: true, ...(await createEntry(body.scope, body)) };
  },

  'PUT /api/entry': async (body) => {
    if (!body.scope || !body.file) throw new Error('缺少 scope 或 file');
    return { ok: true, ...(await updateEntry(body.scope, body.file, body)) };
  },

  'DELETE /api/entry': async (body) => {
    if (!body.scope || !body.file) throw new Error('缺少 scope 或 file');
    const mode = body.mode || 'both';
    if (!['both', 'index', 'file'].includes(mode)) throw new Error('mode 必须是 both / index / file');
    return { ok: true, ...(await deleteEntry(body.scope, body.file, mode)) };
  },

  // 把某个未索引的文件收录进索引
  'POST /api/index-entry': async (body) => {
    if (!body.scope || !body.file) throw new Error('缺少 scope 或 file');
    return { ok: true, ...(await indexSingle(body.scope, body.file)) };
  },

  // 把某个已索引的文件从索引移除（文件保留）
  'POST /api/unindex-entry': async (body) => {
    if (!body.scope || !body.file) throw new Error('缺少 scope 或 file');
    ensureEntryFile(body.scope, body.file);
    return { ok: true, ...(await unindexSingle(body.scope, body.file)) };
  },

  // 移动单条到另一个作用域
  'POST /api/move-entry': async (body) => {
    if (!body.scope || !body.file || !body.toScope) throw new Error('缺少 scope / file / toScope');
    return { ok: true, ...(await moveEntry(body.scope, body.file, body.toScope, body.keepIndexed !== false)) };
  },

  // 批量操作
  'POST /api/batch': async (body) => {
    if (!body.action) throw new Error('缺少 action');
    return { ok: true, ...(await batchOperate(body.action, body.items, body)) };
  },

  // 由本地路径创建工作区（作用域）
  'POST /api/scope': async (body) => {
    return { ok: true, ...(await createScope(body.path)) };
  },

  // ---- 日记（只读）----
  // 某作用域的日记日期列表
  'GET /api/journal-days': async (_req, url) => {
    const scope = url.searchParams.get('scope');
    if (!scope) throw new Error('缺少 scope 参数');
    return { scope, days: await listJournalDays(scope) };
  },

  // 某一天的日记内容（按 ## 时间批次切分）
  'GET /api/journal-day': async (_req, url) => {
    const scope = url.searchParams.get('scope');
    const date = url.searchParams.get('date');
    if (!scope) throw new Error('缺少 scope 参数');
    if (!date) throw new Error('缺少 date 参数');
    return { ok: true, ...(await readJournalDay(scope, date)) };
  },

  // 搜索日记正文；不给 scope 则跨全部作用域
  'GET /api/journal-search': async (_req, url) => {
    const q = url.searchParams.get('q') || '';
    const scope = url.searchParams.get('scope');
    return await searchJournal(q, scope || null);
  },

  // 预览路径会生成什么作用域名（不创建）
  'GET /api/scope-preview': async (_req, url) => {
    const p = url.searchParams.get('path') || '';
    try {
      return { ok: true, scope: slugFromPath(p) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  if (url.pathname.startsWith('/api/')) {
    const handler = routes[key];
    if (!handler) return json(res, 404, { error: `未知接口: ${key}` });
    try {
      const body = req.method === 'GET' ? undefined : await readJsonBody(req);
      const result = await handler(body, url);
      json(res, 200, result);
    } catch (err) {
      json(res, 400, { error: String(err && err.message ? err.message : err) });
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const addr = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  memory-studio 已启动');
  console.log('  数据目录 : ' + ROOT_DIR);
  console.log('  ' + (fs.existsSync(ROOT_DIR) ? '目录状态 : 正常' : '目录状态 : 不存在！请先运行过 DSH 的 memory-md'));
  console.log('  访问地址 : ' + addr);
  console.log('');
  console.log('  关闭本窗口即退出。');
});
