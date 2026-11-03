# dsh-gbk-text

**修好 DeepSeek Harness 打开 GBK 文件时的「该格式文件暂时无法预览」。**

一个宿主侧小插件：当文件不是合法 UTF-8 时，让合成文件系统按 GB18030（GBK / GB2312 的超集）解码，于是内置的侧栏预览、Markdown、代码、表格渲染器都能正常显示中文 Windows 的文本文件。

```
之前：打开 GBK 的 .txt  →  「该格式文件暂时无法预览」
之后：打开 GBK 的 .txt  →  第一行：这是一个 GBK 编码的文本文件。
```

---

## 问题出在哪

DSH 的文件系统层是「只认 UTF-8」的：`@deepseek-ai/dsh-fs-local` 用 `TextDecoder("utf-8", { fatal: true })` 解码，遇到第一个非法字节就抛 `FS_NOT_TEXT`。侧栏文档预览正是走这条路（`workspaceFiles.read` → `fs.streamText`），所以在渲染开始之前字节就被拒了——纯文本、Markdown、代码全都一样，跟扩展名无关。界面上只显示一句笼统的「该格式文件暂时无法预览」，把真正的原因藏起来了。

## 插件做了什么

它包住合成 `fs` 服务的两个文本读取方法 `readText` / `streamText`：

1. **先走原实现**。UTF-8（有无 BOM 都行）和带 BOM 的 UTF-16 行为完全不变，本来能打开的文件一点不受影响。
2. **只有**后端以 `FS_NOT_TEXT` 拒绝时，才读字节并按 **GB18030** 解码。
3. 解出来不像文本就**保持拒绝**：含 NUL、控制字符密集的仍判为二进制，压缩包 / 图片 / 可执行文件的行为和以前一致。

因为修在文件系统这一层，一次注册就同时修好所有消费者：侧栏预览（纯文本、Markdown、代码、CSV/TSV）、文件树，以及任何通过 `ctx.fs` 读文本的插件。**写路径完全不碰**，不会把 GBK 文件悄悄改写成 UTF-8。

## 安装

本包是标准 DSH bundle（声明了 `dsh.bundle.patch`），从本地目录安装即可。

**桌面端（界面）**：侧栏 **Plugins** → *安装第三方插件* → 粘贴本目录的绝对路径。

**桌面端（命令行）**：桌面运行时自带启动器，允许对保留的 `desktop` profile 使用 `plugin` 子命令：

```powershell
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'C:/path/to/dsh-gbk-text'
```

**其它 profile：**

```bash
dsh plugin --profile <name> add /absolute/path/to/dsh-gbk-text
```

安装器会在 profile 里跑 pnpm，然后把 bundle 追加进 `dsh.profile.bundles`。**新装**的 bundle 通过 HMR 热生效；装好后再改插件代码，需要重启应用才会加载新模块。

卸载：界面 Plugins 页移除，或

```bash
dsh plugin --profile <name> remove dsh-gbk-text
```

若 `dsh.profile.bundles` 里还留着条目，一并删掉。

## 配置

默认**只启用 GB18030**，这是刻意的：GB18030 几乎能解任何字节对，自动去试 Big5 / Shift-JIS 只会把它们的文件显示成「看起来像中文」的乱码，比诚实地拒绝更糟。

确实需要时，在插件行上加编码列表（顺序即优先级）：

```yaml
- id: dsh-gbk-text
  name: dsh-gbk-text
  config:
    encodings: [gb18030, big5, shift_jis, euc-kr, windows-1251, windows-1252]
```

不认识的编码名会被忽略，不会拖垮所有文本读取。

## 限制

- 回退路径会把整个文件读进内存，上限 **8 MiB**；更大的文件维持原有的 UTF-8 拒绝（那类文件整读也不划算）。
- 编码是猜的。短文件如果字节在多种旧编码下都合法，可能猜错；GB18030 放第一位是因为中文 Windows 上它最常见。
- 只读。写回仍走字节精确的写路径，GBK 文件不会被静默转成 UTF-8。

## 和 dsh-fs-encoding 的关系

[MrWeiCodes/dsh-fs-encoding](https://github.com/MrWeiCodes/dsh-fs-encoding) 管的是**模型面向的工具**（`read` / `write` / `edit` / `grep`），对非 UTF-8 读取刻意 fail-loud（`autoGuessEncoding: false`），以保护字节级往返。它不碰 `ctx.fs`，所以修不了预览。

两者互补，可以同时装：本插件只修**预览和其它消费者用的读取缝**，从不遮蔽任何工具。如果你也想让 agent 的 `read` 工具自动解码，把 dsh-fs-encoding 配置里的 `autoGuessEncoding` 改成 `true`。

## 验证

```bash
node test/verify.mjs
```

17 项检查、零依赖：UTF-8 / BOM / UTF-16LE 直通、GBK 解码、Big5/Shift-JIS 的既定回退行为、显式编码、二进制与 NUL 拒绝、空文件，以及包装器（readText、streamText、UTF-8 不受影响、二进制仍拒绝、配置生效、卸载后还原原方法）。

除单测外，还在真实 DSH 宿主里做过端到端验证：用一个自检插件调用真实的 `ctx.fs.readText` / `streamText` 读 GBK 文件——加载本插件时读出正确中文，把该行禁用后报 `FS_NOT_TEXT: invalid UTF-8 text`。在 Windows 上针对 DSH `0.2.1-rc.5` 验证。

## English

**Fixes “Preview is not available for this file type yet” for GBK-encoded files in DeepSeek Harness.** The host's filesystem seam decodes text with a strict UTF-8 `TextDecoder` and throws `FS_NOT_TEXT` on the first invalid byte, so the sidebar preview can never show a GBK file. This plugin wraps `fs.readText` / `fs.streamText`: the original read is tried first (UTF-8 and BOM-marked UTF-16 are untouched), and only an `FS_NOT_TEXT` refusal triggers a GB18030 decode, still refusing anything that does not look like text. Because the fix sits at the filesystem seam, the plain-text, Markdown, code and table renderers all recover at once; writes are never touched.

Install from the GUI (Plugins → install a third-party plugin → absolute path) or with `dsh plugin --profile <name> add /absolute/path/to/dsh-gbk-text`. Only GB18030 is enabled by default; add Big5 / Shift-JIS via the row's `config.encodings` (order = priority). Fallback reads are capped at 8 MiB. Complementary to [dsh-fs-encoding](https://github.com/MrWeiCodes/dsh-fs-encoding), which governs the model-facing tools and never touches `ctx.fs`. Verified with 17 dependency-free unit checks plus an end-to-end read inside a real DSH host on Windows (DSH `0.2.1-rc.5`).

## License

MIT
