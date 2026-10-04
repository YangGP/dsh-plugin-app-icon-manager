# dsh-plugin-app-icon-manager

DeepSeek Harness 应用图标管理插件（v0.2.0）。

管理**指向 DSH 的 Windows 快捷方式**的图标——桌面 / 开始菜单 / 任务栏三处一起切换、
记录历史、随时重置。界面在 **设置 → 应用图标管理**。

---

## 一、能力边界

| 图标表面 | 可管理 | 说明 |
| --- | --- | --- |
| 快捷方式（桌面 / 开始菜单 / 任务栏） | ✅ | 本插件实现，改 `.lnk` 的 `IconLocation` |
| Electron 窗口 / 任务栏图标 | ❌ | 主进程启动时固定；宿主进程（`ELECTRON_RUN_AS_NODE`）没有 `BrowserWindow` / `Tray`，IPC 协议里也无对应消息 |
| 系统托盘图标 | ❌ | 同上，插件触达不到已有的托盘对象 |

## 二、使用

**设置页**：重启 DSH 后刷新页面 → 设置 → 应用图标管理。

- **上传图标**：选择或拖入图片，自动转成多尺寸 `.ico` 入库；可勾选"上传并应用"一步到位
  （支持 PNG / JPEG / GIF / BMP / WebP / TIFF，≤ 10 MB）
- 图标库网格：点一下即切到所有 DSH 快捷方式
- **重置回客户端图标**：写回 DSH 自带图标，随时可点
- **重置回上次图标**：撤销最近一次切换（无历史时置灰）
- **确认图标**：重新读盘刷新

**命令行**：`<插件目录>` 指本插件所在目录。

```powershell
cd <插件目录>
node lib/cli.mjs list                 # 图标库
node lib/cli.mjs shortcuts            # 当前 / 最初 / 上次图标
node lib/cli.mjs add <图片> [名字]     # 上传图片，转 .ico 入库
node lib/cli.mjs set <图标名>          # 切换（记录历史）
node lib/cli.mjs reset-default        # 回客户端自带图标
node lib/cli.mjs reset-previous       # 回上一次图标
node lib/cli.mjs doctor               # 诊断
```

非交互环境不会误改，脚本里加 `--yes` 跳过确认。

**代码调用**：

```js
const icons = ctx.get('appIcons')
icons.upload({ data: base64, fileName: 'logo.png', name: 'my-icon' })  // 上传并转换
icons.apply('my-icon')         // 切换
icons.resetToDefault()         // 回客户端图标
icons.resetToPrevious()        // 回上一次
icons.discover()               // 快捷方式明细（spawn PowerShell，约 0.4s）
```

> 图标库默认只有一个示例图标 `dsh-icon-v3`。上传的图片会自动转成多尺寸 `.ico` 存入
> `icons/`，文件名（不含扩展名）就是它的图标名。手工放入的 `.ico` 同样被识别。

### 为什么上传的图片要转换

快捷方式的 `IconLocation` **只认 `.ico`**。COM 会毫无怨言地接受 `.png`，`Save()` 成功、
回读校验也通过，但 Explorer 静默显示**空白图标**。所以上传一律先转成多尺寸
`.ico`（16/24/32/48/64/128/256）再入库，非正方形图片居中补透明边而不是拉伸。

转换用 **DSH 自带的 Python + Pillow**（实测 12.3.0 可用），通过环境变量 + 文件与宿主通信。
若该运行时不存在，上传会返回明确的错误而不是写出一个坏图标。

## 三、配置

`cordis.patch.yml` 的 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `libraryDir` | `icons` | 图标库目录（相对插件根目录）。库里的 `.ico` 才可应用 |
| `stableDir` | `.dsh\app-icons` | 图标写入前复制到此并保留原文件名（相对用户主目录）。**见下方警告** |
| `dshExecutable` | `D:\Program Files\DSH\DeepSeek Harness.exe` | 判定快捷方式归属：`TargetPath` 须等于它 |
| `defaultIcon` | *(空)* | 「重置回客户端图标」写入值；空 = `dshExecutable,0` |
| `applyOnStart` | `false` | 仅打日志，不自动应用 |
| `ui` | `true` | 是否注册设置页区块 |

### ⚠️ `stableDir` 不要设为空

**图标必须落在 `stableDir` 里才能被 Explorer 渲染；直接引用插件图标库会显示为空白图标。**
实测对照（同一张 `.ico`，内容哈希相同）：

| 图标位置 | 结果 |
| --- | --- |
| `%USERPROFILE%\.dsh\app-icons\<图标名>.ico` | ✅ 正常 |
| DSH 启动器（`.exe` 自带的图标） | ✅ 正常 |
| `%USERPROFILE%\.dsh\plugins\app-icon-manager\icons\…`（无空格 junction） | ❌ 空白 |
| `%TEMP%\dsh-…\dsh-icon-fresh\…`（C 盘全新目录） | ❌ 空白 |
| `<插件目录>\icons\…`（本机含空格） | ❌ 空白 |

空格、盘符、目录新旧、junction 均已逐项排除。真因未查明。

## 四、许可

MIT

---

改动本插件前请先读 [INVESTIGATION.md](INVESTIGATION.md)：里面记录了目录结构、HTTP 端点、
服务方法、开发约定（含 `.ps1` 的 BOM 规则这个必踩的坑），以及全部排查过程与已排除的假设。
