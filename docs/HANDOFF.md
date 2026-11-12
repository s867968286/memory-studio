# memory-studio 交接文档

> 生成时间：2026-10-17
> 用途：新对话继续开发本工具时的完整上下文

---

## 一、项目是什么

`memory-md` 记忆文件的**独立查看与编辑工具**。

它不集成进 DSH 插件、不引入第三方依赖，只按 `~/.dsh/memory-md/` 的数据格式做一个顺手的图形界面，
解决「在资源管理器里翻记忆文件不方便」的问题。

- 位置：`D:\path\to\memory-studio`
- 启动：双击 `start.bat`，或 `node server.js`
- 地址：http://127.0.0.1:7788
- 依赖：只需 Node.js（本机 v24），**零 npm 依赖**

### 文件构成

| 文件 | 行数 | 作用 |
|---|---|---|
| `server.js` | ~980 | 后端，Node 内置模块实现 |
| `public/index.html` | ~200 | 页面结构 |
| `public/app.js` | ~1480 | 前端逻辑（含 Markdown 渲染、弹窗、拖拽、日记） |
| `public/style.css` | ~790 | 样式（白色主题） |
| `start.bat` | - | 双击启动 + 自动开浏览器 |
| `README.md` | - | 用法说明 |
| `FIX-CJK-SLUG.md` | - | 给 memory-md 插件的中文路径修复文档 |

> `layout-preview.html`（布局原型）已被正式实现取代，仅留根目录一份备查，**不在 `public/` 下**，不对外提供。

---

## 二、记忆文件格式

```
~/.dsh/memory-md/
├── settings.json            # 插件自身配置，本工具不读写
├── global/                  # 全局作用域
│   ├── MEMORY.md            # 索引
│   └── memory/
│       └── feedback_xxx.md  # 条目
└── d-workspaces-xxx/        # 各工作区作用域，结构同上
```

### 条目文件

```markdown
---
name: 标题
description: 一句话描述
type: feedback        # user | feedback | project | reference
---

正文
```

### 索引文件 `MEMORY.md`

```markdown
# MEMORY.md

- [标题](memory/文件名.md) — 描述
```

**作用域目录名规则**（与 memory-md 插件 `getCompressedWorkDir()` 逐行一致）：

- 反斜杠统一成正斜杠，去掉盘符冒号，去掉开头斜杠
- 除 `[A-Za-z0-9]` 与 `\u0080-\uFFFF`（中文等非 ASCII）外，一切字符折成 `-`
  - **注意 `.` 和 `_` 也会折成 `-`**（`v1.3.0` → `v1-3-0`），这是为了与插件一致
- 连续 `-` 压成一个，去掉首尾 `-`，英文转小写

```
D:\workspaces\ai        →  d-workspaces-ai
D:\workspaces\v1.3.0    →  d-workspaces-v1-3-0
D:\测试中文路径           →  d-测试中文路径
```

---

## 三、已实现功能

### 浏览

- 作用域列表：global 固定置顶，其余按**字母顺序**
- 三栏布局：作用域 / 条目 / 内容
- 条目列表带时间（今天显示 `15:30`，昨天显示「昨天」，更早显示 `10/12`）
- Markdown 渲染：标题、列表、代码块、引用、链接、粗体

### 搜索

- 跨作用域搜索：标题 / 描述 / 正文 / 文件名
- 搜索框内嵌范围切换按钮：「当前作用域」⇄「全部作用域」
- 结果中显示条目所属作用域

### 布局

三种模式（顶栏 `▦` 按钮切换，选择存 localStorage）：

| 模式 | 说明 |
|---|---|
| 三栏 | 作用域 / 列表 / 内容 并排 |
| 列表 + 预览 | 隐藏作用域栏 |
| 仅列表 | 点开才显示内容，带返回按钮 |

- 列宽可拖拽（A、B 两列之间各有分隔条），**双击复位**
- 宽度存 localStorage，切换布局时自动校正，保证内容栏至少 360px
- 窄屏自动降级：<1080px 隐藏作用域栏，<820px 变单栏

### 编辑

- 新建 / 编辑 / 删除条目
- 新建时可选是否写入索引
- 删除时二选一：**只删索引**（文件保留）或 **索引与文件一起删**
- 批量操作：收录 / 移出 / 移动 / 删除
- 移动条目到其他作用域（重名自动加后缀，索引状态跟随）
- 输入本地路径新建工作区（自动推导作用域名）

### 索引管理

- **未索引**是允许的合法状态，列表有「○ 未索引」徽标，可单独筛选
- 单条收录 / 移出索引
- 「索引维护」按钮（顶栏）：主动执行，可整理已有索引或把未索引文件全部收录
- **不会每次点击都弹窗确认**，不一致只在计数上体现

### 日记查看（2026-10-17 新增，只读）

顶栏「记忆 / 日记」切换，`state.area` 控制。

- **数据源**：`<作用域>/.journal/YYYY-MM-DD.md`，与 `memory/`、`MEMORY.md` 同级
- **作用域栏**：日记模式下显示的是**天数**（无日记显示 `—` 并置灰）
- **日期轴（B 栏）**：按日期倒序，带「今天 / 昨天 / 周几」，可筛全部 / 本周 / 本月
- **正文（C 栏）**：**直接渲染原始 Markdown**（`# 日期` + `## 时间` + `- 条目`），
  不做卡片化改造 —— 曾试过时间轴卡片，内容一多反而不好读，已回退
- **操作**：上/下一天翻页、复制当天原文（Markdown 原格式）、跨作用域搜索日记正文
- **只读**：没有任何写接口。插件把日记定位为「只写不读」的留痕
  （`dsh-memory-md/src/store.mjs:200`），且插件侧已移除 `/api/journal/<date>`（`routes.mjs:117`）

### 安全

- 只写 `MEMORY_ROOT` 下的内容，作用域名与文件名都做白名单校验，`../` 会被拒绝
- 任何写操作前备份到 `~/.dsh/memory-md/.memory-studio-backup/`（**每文件每天最多一份**）
- 只监听 `127.0.0.1`

---

## 四、API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回数据目录 |
| GET | `/api/scopes` | 作用域列表（含条目数） |
| GET | `/api/entries?scope=` | 某作用域全部条目（含 `indexed` 状态） |
| GET | `/api/all` | 全量条目，供跨作用域搜索 |
| GET | `/api/index-status?scope=` | 索引一致性：孤儿 / 失效引用 / 重复 |
| GET | `/api/scope-preview?path=` | 预览路径会生成什么作用域名（不创建） |
| POST | `/api/entry` | 新建条目（`indexed: false` 则只建文件） |
| PUT | `/api/entry` | 修改条目 |
| DELETE | `/api/entry` | 删除，`mode`: `both` \| `index` \| `file` |
| POST | `/api/index-entry` | 单条收录进索引 |
| POST | `/api/unindex-entry` | 单条从索引移除（文件保留） |
| POST | `/api/move-entry` | 移动到其他作用域 |
| POST | `/api/batch` | 批量操作，`action`: `delete` \| `move` \| `index` \| `unindex` |
| POST | `/api/scope` | 由路径创建工作区 |
| POST | `/api/rebuild-index` | 整理索引，`includeOrphans: true` 时收录未索引文件 |
| GET | `/api/journal-days?scope=` | 某作用域的日记日期列表（新→旧） |
| GET | `/api/journal-day?scope=&date=` | 某天的日记，按 `## 时间` 切分成 sections |
| GET | `/api/journal-search?q=&scope=` | 搜索日记正文；不给 scope 则跨全部作用域 |

`GET /api/scopes` 的每个作用域现在还带 `journalDays`（日记天数）。

### 后端关键函数（server.js）

| 函数 | 行号 | 说明 |
|---|---|---|
| `parseEntry` | 41 | 解析 frontmatter |
| `serializeEntry` | 65 | 生成文件内容 |
| `indexLine` | 74 | 生成索引行 |
| `parseIndex` | 99 | **解析索引（有坑，见第五节）** |
| `listScopes` | 145 | 作用域列表与排序 |
| `readEntries` | 174 | 读取条目（附 `indexed` 状态） |
| `rebuildIndex` | 274 | 整理索引，默认保留未索引状态 |
| `indexSingle` / `unindexSingle` | 317 / 344 | 单条索引增删 |
| `deleteEntry` | 482 | 删除（三种模式） |
| `moveEntry` | 513 | 跨作用域移动 |
| `batchOperate` | 550 | 批量操作 |
| `slugFromPath` | 600 | 路径转作用域名（对齐插件） |

---

## 五、踩过的坑（新功能要注意）

### 1. 索引解析：标题含方括号曾导致重复写入

**现象**：某条记忆标题含 `byte[]`，界面上永远显示「未索引」，点收录提示成功但状态不变，
索引文件里同一行被重复写入 7 份。

**根因**：旧正则 `/^-\s*\[([^\]]*)\]\((memory\/[^)]+)\)/` 的 `[^\]]*` 会在标题的
第一个 `]` 处截断，整行解析失败。于是「是否已存在」永远判否，每次都追加。

**现在的写法**（与插件 `store.mjs` 的 `indexLineTargets` 一致）：

```js
/^-\s*\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\((memory\/[^)]+)\)\s*[—–-]?\s*(.*)$/
```

标题里**最多允许一对方括号**，描述里的链接不会被误切。

> ⚠️ **不要改成从右往左取最后一个 `](`**。描述里出现 `](memory/b.md)` 是自然写法，
> 那样会切错，导致写乙时把甲的行顶掉、删乙时连带删甲。
>
> 已知限制：标题含**多组**方括号（如 `a[b]c[d]`）会显式不匹配，该条显示未索引但不产生重复行。

### 2. 列宽/布局改动后要检查网格列数

三栏布局用的是 5 列网格（含两个 0 宽的分隔条）：

```css
body[data-view="three"] .layout {
  grid-template-columns: var(--w-nav) 0 var(--w-list) 0 minmax(0, 1fr);
}
```

DOM 子元素顺序必须严格对应：`#paneNav` → `.gutter-nav` → `#paneList` → `.gutter-list` → `#paneDetail`。
**调整结构时列数必须同步改**，否则布局会错位。

### 3. 内容区滚动：`#view` 必须有 flex

`.detail-body` 靠 `flex: 1 + overflow-y: auto` 滚动，前提是父容器 `#view` 有
`display: flex; flex-direction: column; flex: 1; min-height: 0`。
漏掉时高度被内容撑开、`overflow` 失效、**滚动条不出现**，超出部分还会被 `.pane` 的
`overflow: hidden` 直接裁掉。（这个 bug 真实发生过一次）

### 4. 不要用浏览器原生弹窗

全部用自定义 `showModal()` / `showAlert()`（`public/app.js`）。

### 5. Windows 命令行测试中文会乱码

用 `curl` 发中文 JSON 时，控制台按 GBK 送出，服务端收到的是 `EF BF BD`（替换字符）。
**测试请用 Node 脚本发 fetch**，不要用 curl 传中文。

### 5.9 新增并列区块后，全局选择器会撞车

给日记加了一块 `.pane-head .filters` 之后，记忆模式原有的
`document.querySelector('.filters')`（在 `renderFilters()` 里）取到的变成了**日记那组**
—— 里面没有 `[data-filter]` 按钮，`allBtn.innerHTML` 直接抛 `Cannot set properties of null`。

后果比想象的大：异常冒泡到 `loadEntries` 的 catch，**状态栏显示「读取失败」**，
而且「全部 / 未索引」上的条数不再刷新（停在「全部」「未索引」没有数字）。

**规则：凡是在文档里 querySelector 通用 class 的地方，必须先把查找范围限定到所属容器**，
例如 `$('memoryListHead').querySelector('.filters')`。新增第二种同类区块时尤其要查一遍。

### 5.95 新增内容面板必须补 flex，否则滚动失效

`#view`、`#editor` 都写了 `display:flex; flex-direction:column; flex:1; min-height:0`，
新增的 `#journalView` **一开始漏了**，导致 `.detail-body` 的高度被内容撑开、
`overflow-y:auto` 失效、**滚动条不出现**（与第五节第 3 条是同一个坑，复发了一次）。

**规则：任何新增的「内容面板」元素，必须和 `#view` 同列进那条 CSS 规则。**

### 6. 日期校验不能用 toISOString 做回比

`ensureJournalDate()` 最初写成「`new Date(s + 'T00:00:00')` 再取 `toISOString().slice(0,10)`
回比」，结果**东八区的每个合法日期都被判非法** —— `toISOString` 按 UTC 换算，
本地 `2026-09-30 00:00` 会变成 `2026-09-29T16:00Z`，回比必然不相等。

现在改成逐字段比对年月日（`getFullYear/getMonth/getDate`），只拦截 `2026-02-31` 这类越界日期。

### 7. edit 失败时可能已经写入

用 `tools.edit` 改代码时，若**替换文本本身有 JS 语法错误**（例如被反引号/模板字符串提前截断），
报错信息是「Expression expected」之类的 **程序编译错误**，但它可能**已经写入了一次**。
表现为：报错后内容其实在里面，再改反而找不到 old_string。
**改完一定要 grep 或 read 确认实际落盘内容**，不要凭报错判断没写进去。

### 8. bash 多层转义容易把代码写坏

用 `python heredoc` / `node -e` 改含反斜杠的 JS 代码时，`\\` 极易被吃掉，
曾把 `'\\'` 写成 `'\'`、把注释里的 `D:\workspaces\ai` 写成 `D:\workspaces` + 响铃符 `\a`。
**建议：先写到临时文件再用 node 读入替换**，写完必须 `node --check` 校验。

### 9. 作用域名白名单必须与 slug 生成规则同步

`slugFromPath()` 早就允许中文（`[^A-Za-z0-9\u0080-\uFFFF]+` 之外才折成 `-`），
所以会出现中文目录名如 `d-坚果云-工作日志`。但 `scopeDir()` 的校验正则原来只放
`[A-Za-z0-9._-]`，结果是**左侧能列出这个作用域、一点击就 400 报「非法的作用域名」**。
**两处字符集必须一致**：校验串改成 `/^[A-Za-z0-9._\u0080-\uFFFF-]+$/`。
安全上仍成立——`/ \ :` 与 Windows 保留字符都在 ASCII 段，被排除；`..` 由后面的
`path.resolve` 前缀校验兜底（`.`/`..` 另有显式判断）。

---

## 六、与 memory-md 插件的关系

### 已同步

| 项 | 状态 |
|---|---|
| 作用域目录名规则 | ✅ 逐行对齐 `getCompressedWorkDir()`，9 个用例逐字符一致 |
| 索引解析规则 | ✅ 采用插件 `indexLineTargets()` 的同一套正则 |

### 曾发现并已由用户修复的插件缺陷

1. **中文路径塌缩**：原 `[^A-Za-z0-9]+` 把中文全吃掉，`D:\测试中文路径` → `d`，
   所有中文项目共用一个作用域。已改为 `[^A-Za-z0-9\u0080-\uFFFF]+`。
   详细方案见项目根目录 `FIX-CJK-SLUG.md`。
2. **索引解析方括号 bug**：见第五节第 1 条。

### 仍需注意

- 工具**绕过 DSH 直接改文件**。日常写入仍建议走 `memory_md_save`，
  本工具适合批量整理、比对去重、查索引漂移这类对话里做不了的操作。
- 插件的 `settings.json` 不归本工具管。

---

## 七、当前数据状态

> 原记录的是本机真实作用域与条目统计（涉及具体项目信息），上传公开仓库前已脱敏移除。
> 运行时通过 `GET /api/scopes` 可随时查看实际的条目数与索引数。

判读要点（与真实数据无关的通用规则）：

> 「条目 > 索引」差值是历史上的未索引文件，属于**正常状态**，不是错误。
> `d` 作用域是插件中文塌缩缺陷的产物，通常留空、不再使用。

---

## 八、下一步可能的开发方向

用户提到「开新对话再开新功能」，以下是未做但提过的：

> 已完成（2026-10-17）：日记查看功能已实现，见第三节「日记查看」。


1. **跨作用域「全部记忆」总览**（曾在布局原型中演示，未实现）
   - 卡片显示规模：总数 / 未索引 / 失效引用 / 疑似重复
   - 列出需要处理的条目，点击跳转
   - 价值：`global` 里已知有 3 组标题几乎重复的条目，在列表里几乎发现不了
2. **重复记忆检测**：标题/描述相似度比对，辅助合并
3. **列宽按布局模式分别记忆**（现在三种模式共用一套宽度）
4. 交接时遗留：`layout-preview.html` 可删除

---

## 九、如何验证改动

```bash
cd D:/path/to/memory-studio
node --check server.js              # 后端语法
node --check public/app.js          # 前端语法
node server.js                      # 启动后访问 http://127.0.0.1:7788
```

**测试注意事项**：

- 用**临时作用域**做隔离测试（`POST /api/scope` 传 `D:/tmp-xxx`），测完删除
- 不要直接拿真实记忆做破坏性测试
- 测试中文内容一律用 Node 脚本发请求，不用 curl
- 改完后检查所有 `$('元素id')` 在 HTML 里都存在（曾因删元素漏改导致运行时错误）

---

## 十、服务进程

当前后端运行在后台（端口 7788）。新对话中若端口被占用，先确认旧进程：

```bash
curl -s http://127.0.0.1:7788/api/health
```

返回 `{"ok":true,...}` 说明已在运行，直接访问即可，不必重复启动。
