# memory-md 中文路径 slug 塌缩缺陷与修复方案

> 面向：`dsh-memory-md` 组件维护者
> 影响文件：`src/codebuddy-port.mjs`
> 严重程度：中（数据隔离失效，不丢数据但会混存）

---

## 一、问题

`getCompressedWorkDir()` 会把路径中所有非 ASCII 字符整体删除，导致**任何含中文的路径都塌缩成 `d`**。

### 复现代码

```js
// dsh-memory-md/src/codebuddy-port.mjs:61-68
export function getCompressedWorkDir(cwd) {
  let normalized = String(cwd)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1')
  normalized = normalized.replace(/^\/+/, '')
  return normalized.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/g, '').toLowerCase()
}
```

### 实测结果

直接调用该导出函数，输入与输出：

| 输入路径 | 实际输出 | 期望 |
|---|---|---|
| `D:\workspaces\ai` | `d-workspaces-ai` | ✅ 正确 |
| `C:\Users\user\dsh` | `c-users-user-dsh` | ✅ 正确 |
| `D:\坚果云工作日志` | **`d`** | ❌ 应为 `d-坚果云工作日志` |
| `D:\测试中文路径` | **`d`** | ❌ 应为 `d-测试中文路径` |
| `D:\项目A\SubDir` | **`d-a-subdir`** | ❌ 应为 `d-项目a-subdir` |

复现命令：

```bash
node --input-type=module -e "
import { getCompressedWorkDir } from 'file:///path/to/dsh-memory-md/src/codebuddy-port.mjs';
console.log(getCompressedWorkDir('D:' + String.fromCharCode(92) + '测试中文路径'));
"
# 输出: d
```

---

## 二、根因

问题出在这一行的字符类上：

```js
.replace(/[^A-Za-z0-9]+/g, '-')
```

`[^A-Za-z0-9]` 的含义是「**所有非 ASCII 字母数字**」。它把中文、日文、韩文、emoji 等一并视为「分隔符」，
而且因为是 `+`（贪婪匹配连续段），一整段中文会被**合并成一个 `-`**，随后：

1. 末尾的 `-` 被 `.replace(/-+$/g, '')` 去掉
2. 结果只剩盘符字母 `d`

所以 `D:\测试中文路径` 与 `D:\坚果云工作日志` 会得到**完全相同**的 `d`。

---

## 三、影响

### 1. 不同项目共用同一个记忆作用域（核心风险）

`~/.dsh/memory-md/d/` 会同时承载所有中文路径项目的记忆。
在 A 项目里写的记忆，去 B 项目开会话时仍会被加载，**跨项目污染**。

### 2. 记忆无法按项目隔离，也难以人工排查

目录名 `d` 不含任何项目信息，无法从目录名判断它属于哪个项目。

### 3. 现有 `~/.dsh/memory-md/d/` 目录疑似就是该缺陷的产物

用户环境中该目录存在 2 条记忆，命名形态与其来源路径无法对应。

### 4. 与官方 DSH 的会话目录命名策略不一致

DSH 官方 `projectKey()`（`dsh-session-persistence-jsonl/lib/index.js:873-894`）对中文
使用 `~XXXX` 转义，是可逆的：

```
D:\坚果云工作日志  →  --D-~575A~679C~4E91-~5DE5~4F5C~65E5~5FD7--
```

memory-md 的塌缩行为与之相差较大，排查问题时两套目录名无法互相对照。

---

## 四、修复方案

### 方案 A（推荐）：保留中文

把「非 ASCII 视为分隔符」改为「**只把路径分隔符当分隔符**」，其余非 ASCII 原样保留。

```js
export function getCompressedWorkDir(cwd) {
  let s = String(cwd).replace(/\\/g, '/')
  s = s.replace(/^([A-Za-z]):/, '$1')     // D:  ->  D
  s = s.replace(/:/g, '-')                // 其余冒号也转 -
  s = s.replace(/\/+/g, '-')              // 路径分隔符 -> -
  s = s.replace(/-+/g, '-')               // 连续横线压成一个
  s = s.replace(/^-+|-+$/g, '')           // 去掉首尾横线
  s = s.toLowerCase()                     // 英文小写，中文不受影响
  s = s.replace(/[<>"|?*]/g, '')          // 仅剔除文件名非法字符
  s = s.replace(/[\u0000-\u001f]/g, '')   // 控制字符
  return s
}
```

**效果**：

| 输入 | 输出 |
|---|---|
| `D:\workspaces\ai` | `d-workspaces-ai`（与旧行为一致，不影响现有 ASCII 目录） |
| `D:\测试中文路径` | `d-测试中文路径` |
| `D:\坚果云工作日志` | `d-坚果云工作日志` |
| `D:\项目A\SubDir` | `d-项目a-subdir` |

**优点**：可读、不撞车、ASCII 路径行为完全不变（无迁移负担）。

**缺点**：不可逆（无法从 slug 精确还原原始大小写路径，这一点与现状相同）。

### 方案 B：使用官方 `~XXXX` 转义

与 DSH 官方 `projectKey()` 对齐，中文转成 `~575A` 形式。

**优点**：可逆、100% 无撞车、与官方会话目录风格统一。
**缺点**：目录名极长（一个汉字 5 字符），人工阅读困难；且**所有现有 ASCII 目录也要改格式**（`d-workspaces-ai` → `--D-workspaces-ai--`），需要迁移。

### 方案 C：哈希兜底（不推荐单独使用）

在保留中文的基础上，若 slug 超长或含特殊字符，追加路径哈希短码：

```js
const h = createHash('sha1').update(cwd).digest('hex').slice(0, 8)
return `${slug.slice(0, 60)}-${h}`
```

适用于「宁可丑陋也要绝对不撞车」的场景，但会让目录名更难读。

---

## 五、推荐做法

**采用方案 A**。理由：

1. ASCII 路径输出完全不变，**现有目录无需迁移**，修复风险最低
2. 中文路径得到人类可读的名字，符合用户直觉
3. 撞车风险从「所有中文项目共用一个 `d`」降到正常水平

如果后续希望做到绝对可逆，可以再叠加方案 B 的转义或方案 C 的哈希。

---

## 六、配套修改

### 1. 更新文档注释

`src/codebuddy-port.mjs:53-60` 的注释写着「规则：绝对路径的盘符与分隔符转 `-`，整体小写」，
需补充「中文等非 ASCII 字符原样保留」及示例。

### 2. 检查是否还有其他地方依赖旧 slug

建议全仓搜索 `getCompressedWorkDir` 的所有调用点，确认无逻辑依赖「slug 一定只含 `[a-z0-9-]`」：

```bash
grep -rn "getCompressedWorkDir\|slug" src/ test/
```

重点检查：
- 诊断文件名构造（`src/summarize.mjs`）是否对 slug 做了字符假设
- 测试用例中是否有断言 `d` 这类塌缩结果的快照（如有需同步更新）

### 3. 补充回归测试

现有测试未覆盖中文路径。建议新增：

```js
test('中文路径不应塌缩', () => {
  assert.equal(getCompressedWorkDir('D:\\测试中文路径'), 'd-测试中文路径')
  assert.equal(getCompressedWorkDir('D:\\坚果云工作日志'), 'd-坚果云工作日志')
  // 不同中文路径必须产出不同 slug（防塌缩回归）
  assert.notEqual(
    getCompressedWorkDir('D:\\项目甲'),
    getCompressedWorkDir('D:\\项目乙'),
  )
})
```

最后一条是关键：**只要两个不同路径产出相同 slug，就说明缺陷复发了**。

---

## 七、迁移说明

修复后，**已有的 `d` 目录不会被自动改名**，其中的记忆仍留在 `d/` 下。

若需要归位，可按以下步骤手工处理：

1. 先确认 `~/.dsh/memory-md/d/memory/` 下的每条记忆原本属于哪个项目（读正文判断）
2. 为对应项目路径新建作用域目录，目录名用修复后的 `getCompressedWorkDir` 结果
3. 把条目文件与 `MEMORY.md` 中对应索引行一起搬过去
4. 确认无误后再删除 `d/`

> 建议在修复上线前先备份整个 `~/.dsh/memory-md/` 目录。

---

## 附：本次核查依据

| 结论 | 依据 |
|---|---|
| memory-md 用 `[^A-Za-z0-9]+` 处理路径 | `dsh-memory-md/src/codebuddy-port.mjs:61-68`（源码原文） |
| 中文路径塌缩成 `d` | 直接 import 该函数实测，见第一节表格 |
| 官方 DSH 对中文用 `~XXXX` 转义 | `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:873-894` |
| 官方转义为可逆编码 | 同文件 846 行注释：injective over ALL JS (UTF-16) strings |
| 环境中存在真实中文转义样本 | `~/.dsh/sessions/--D-~575A~679C~4E91-~5DE5~4F5C~65E5~5FD7--`，解码为「坚果云工作日志」 |
