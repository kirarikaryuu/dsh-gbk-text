# dsh-gbk-text

[![test](https://github.com/kirarikaryuu/dsh-gbk-text/actions/workflows/test.yml/badge.svg)](https://github.com/kirarikaryuu/dsh-gbk-text/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.5-4d6bfe.svg)](#兼容性)

**修好 DeepSeek Harness 打开 GBK 文件时的「该格式文件暂时无法预览」。**

一个宿主侧小插件：文件不是合法 UTF-8 时，让合成文件系统按 GB18030（GBK / GB2312 的超集）解码，内置侧栏预览、Markdown、代码、表格渲染器因此都能正常显示中文 Windows 的文本文件。

```
之前：打开 GBK 的 .txt  →  「该格式文件暂时无法预览」
之后：打开 GBK 的 .txt  →  第一行：这是一个 GBK 编码的文本文件。
```

## 快速开始

```powershell
# 1. 安装（桌面端自带的启动器允许对 desktop profile 使用 plugin 子命令）
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'C:/path/to/dsh-gbk-text'

# 2. 确认 bundle 已登记
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles

# 3. 打开一个 GBK 文件；新装的 bundle 走 HMR 热生效，改代码后才需要重启
```

界面里也行：侧栏 **Plugins** → *安装第三方插件* → 粘贴本目录绝对路径。

## 问题出在哪

DSH 的文件系统层是「只认 UTF-8」的：`@deepseek-ai/dsh-fs-local` 用 `TextDecoder("utf-8", { fatal: true })` 解码，遇到第一个非法字节就抛 `FS_NOT_TEXT`。侧栏文档预览正是走这条路（`workspaceFiles.read` → `fs.streamText`），所以渲染还没开始，字节就被拒了——纯文本、Markdown、代码全都一样，跟扩展名无关。界面只显示一句笼统的「该格式文件暂时无法预览」，把真正的原因藏起来了。

## 工作原理

包住合成 `fs` 服务的两个文本读取方法 `readText` / `streamText`：

```js
// 伪代码：先走原实现，只有被 UTF-8 拒绝时才回退
try   { return await original.readText(target, signal) }        // UTF-8 / UTF-16 BOM 不变
catch (e) {
  if (e.code !== 'FS_NOT_TEXT') throw e                          // 其它错误照旧
  return decodeText(await readBytes(target), ['gb18030'])        // 回退解码
}
```

1. **先走原实现**：UTF-8（有无 BOM）和带 BOM 的 UTF-16 行为完全不变，本来能打开的文件不受影响。
2. **只有**后端以 `FS_NOT_TEXT` 拒绝时，才读字节并按 **GB18030** 解码。
3. 解出来不像文本就**保持拒绝**：含 NUL、控制字符密集的仍判为二进制，压缩包 / 图片 / 可执行文件的行为和以前一致。

因为修在文件系统这一层，一次注册同时修好所有消费者：侧栏预览（纯文本、Markdown、代码、CSV/TSV）、文件树，以及任何通过 `ctx.fs` 读文本的插件。

## 读写边界

| 动作 | 会不会发生 |
|---|---|
| 读文件（`readBytes` / `readText` / `streamText`） | **会**，仅在你打开/读取文件时 |
| 写文件（`writeText` / `editText`） | **不会**。写回仍走字节精确的原生路径，GBK 文件不会被静默转成 UTF-8 |
| 网络请求 / 子进程 / 动态安装依赖 | **不会**。零运行时依赖 |
| 遮蔽模型工具（`read` / `write` / `edit`） | **不会**。与 dsh-fs-encoding 可共存 |
| 修改 `app.asar` 或前端 bundle | **不会**。纯宿主插件，重启即恢复 |

## 兼容性

- 在 Windows + DSH `0.2.1-rc.5`（desktop profile）上端到端验证；CI 用 Node 20 跑单测。
- 依赖宿主 `TextDecoder` 的 legacy 编码支持。Electron 与 Node 官方构建都带完整 ICU，因此 `gb18030` / `big5` / `shift_jis` 可用；精简 ICU 的运行时会在加载时自动跳过不支持的编码，不会崩。
- 与 [dsh-fs-encoding](https://github.com/MrWeiCodes/dsh-fs-encoding) 同装无冲突：它管模型工具，本插件只管预览用的读取缝。

## 配置

默认**只启用 GB18030**，这是刻意的：GB18030 几乎能解任何字节对，自动去试 Big5 / Shift-JIS 只会把它们的文件显示成「看起来像中文」的乱码，比诚实地拒绝更糟。

| 键 | 默认 | 作用 |
|---|---|---|
| `encodings` | `[gb18030]` | **替换**回退清单，顺序即优先级 |
| `excludeEncodings` | `[]` | 从**默认清单**里去掉几个；`encodings` 一旦显式设置，本键被忽略 |

```yaml
- id: dsh-gbk-text
  name: dsh-gbk-text
  config:
    # 需要繁体/日文时再开，顺序即优先级
    encodings: [gb18030, big5, shift_jis]
    # 或者只去掉默认里的某一项（以后新增的默认编码仍会生效）
    # excludeEncodings: [gb18030]
```

不认识的编码名会被忽略，不会拖垮所有文本读取；把默认清单全部排除等于关掉回退，行为回到原生 UTF-8 拒绝。

## 已知取舍

- **只修读取，不修写入**：写入语义仍由原生路径和 dsh-fs-encoding 决定，本插件不参与。
- **默认只认 GB18030**：Big5 / Shift-JIS 文件会显示成乱码，除非显式配置。
- **回退要整读文件**：上限 8 MiB，更大的文件维持原生 UTF-8 拒绝。
- **编码是猜的**：短文件若字节在多种旧编码下都合法，可能猜错；GB18030 放第一位是因为中文 Windows 上它最常见。
- **不显示检测结果**：内置预览没有「当前编码」的位置，本插件也不改前端，所以不会在标题栏告诉你猜到了什么。

## 常见问题

**为什么不直接在 dsh-fs-encoding 里修？**
它接管的是模型面向的工具（`read` / `write` / `edit` / `grep`），刻意不替换 `ctx.fs`；而预览走的是 `ctx.fs`。两者是不同的层。

**为什么不做成客户端预览插件？**
客户端预览器按扩展名抢占内置渲染器：一旦接管 `.md` / `.json` / 源码，Markdown 渲染和语法高亮都会退化成纯文本。修在 fs 层没有这个代价。

**会不会把我的文件改坏？**
不会写文件。即使以后加写入，也不会沿用「猜测的编码」写回。

**打开还是「无法预览」？**
按顺序排查：文件是否 > 8 MiB；是否根本不是 GB18030（试试 `encodings`）；bundle 是否真的登记在 `dsh.profile.bundles` 里，以及装完是否重启过。

**想临时关掉？**
配置 `excludeEncodings: [gb18030]`（等于不启用回退），或直接从 Plugins 页卸载。

## 开发与测试

```bash
node test/verify.mjs   # 19 项检查，零依赖
```

| 路径 | 内容 |
|---|---|
| `index.js` | 解码器 + `fs` 包装器 |
| `cordis.patch.yml` | bundle 挂载行 |
| `test/verify.mjs` | 内嵌字节夹具的单测（UTF-8 / BOM / UTF-16LE / GBK / Big5 / Shift-JIS / 二进制 / 包装器 / 配置 / 卸载还原） |
| `locale/`、`icon.svg` | 插件管理器里的标题、描述与图标 |

## 参考与致谢

设计与文档结构参考了下列项目；**没有复制任何代码**，实现为本仓库原创：

- [MrWeiCodes/dsh-fs-encoding](https://github.com/MrWeiCodes/dsh-fs-encoding) —— 其 README 对「DSH 文件系统缝只认 UTF-8」的分析是定位本问题的关键线索；`excludeEncodings` 的配置语义（只排除、不冻结清单）直接沿用；「宁可失败，不可猜错」的默认取舍也来自它的判断。
- [ax2/dsh-win-native](https://github.com/ax2/dsh-win-native) —— 「只读承诺」表格的写法。
- [ZHIUY666/dsh-file-preview](https://github.com/ZHIUY666/dsh-file-preview) —— 「已知取舍」章节的写法；其 BOM → UTF-8 → GBK 的回退顺序与本插件一致（各自独立实现）。
- [liguobao/dsh-file-viewer](https://github.com/liguobao/dsh-file-viewer) —— Compatibility 与 Security notes 的组织方式。

## English

**Fixes “Preview is not available for this file type yet” for GBK-encoded files in DeepSeek Harness.** The host's filesystem seam decodes text with a strict UTF-8 `TextDecoder` and throws `FS_NOT_TEXT` on the first invalid byte, so the sidebar preview can never show a GBK file. This plugin wraps `fs.readText` / `fs.streamText`: the original read is tried first (UTF-8 and BOM-marked UTF-16 are untouched), and only an `FS_NOT_TEXT` refusal triggers a GB18030 decode, still refusing anything that does not look like text. Because the fix sits at the filesystem seam, the plain-text, Markdown, code and table renderers all recover at once; writes are never touched.

Install from the GUI (Plugins → install a third-party plugin → absolute path) or with `dsh plugin --profile <name> add /absolute/path/to/dsh-gbk-text`. Only GB18030 is enabled by default; add Big5 / Shift-JIS via `config.encodings` (order = priority), or drop one with `config.excludeEncodings`. Fallback reads are capped at 8 MiB. Complementary to dsh-fs-encoding, which governs the model-facing tools and never touches `ctx.fs`. Verified with 19 dependency-free unit checks plus an end-to-end read inside a real DSH host on Windows (DSH `0.2.1-rc.5`).

## License

MIT
