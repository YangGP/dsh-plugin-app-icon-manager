# 排查记录与技术参考

主 [README](README.md) 只讲怎么用。这里分两部分：

- **技术参考**（第一~三节）：目录结构、HTTP 端点、开发约定 —— 改动本插件前先看这些
- **排查记录**（第四~九节）：踩过的坑与已排除的假设，避免重复走弯路

---

## 一、目录结构

```
dsh-plugin-app-icon-manager/
├── package.json           # 清单（exports / dsh.bundle / dsh.client / icon）
├── cordis.patch.yml       # 挂载声明 + 配置
├── icon.svg               # 插件卡片图标
├── locale/{en,zh}.json    # 卡片标题描述
├── lib/
│   ├── index.js           # 宿主入口：发现 / 切换 / 重置 / 上传 / 诊断
│   ├── icon-file.js       # 图标可写性判定（扩展名 + 文件头魔数）
│   ├── image-to-ico.js    # 上传的图片 → 多尺寸 .ico（调 Python/Pillow）
│   ├── image-to-ico.py    # 转换脚本本体（须纯 ASCII）
│   ├── ui.js              # HTTP 数据端点
│   ├── client.js          # 设置页区块（React.createElement，无构建步骤）
│   ├── cli.mjs            # 命令行入口（list / add / set / reset-* / doctor）
│   ├── shortcut.js        # 调 PowerShell COM 的封装
│   └── shortcut.ps1       # .lnk 图标读写助手（纯 ASCII）
├── test-client-bundle.mjs # 设置页 bundle 的装载协议测试（npm test）
├── fix-icon.cmd / .ps1    # 白图标修复 / 还原（须用户自行运行）
├── diagnostic/            # 诊断图标（红底白圈蓝点）
├── icons/                 # 图标库：⚠️ 只有 .ico 会被 Explorer 渲染
└── .state/shortcuts.json  # 原始值 + 历史栈，运行时生成
```

**`appIcons` 服务方法**：
`libraryDir` `library` `resolve` `discover` `shortcuts` `state` `stateFile`
`upload` `apply` `defaultIcon` `resetToDefault` `resetToPrevious` `describe`

`describe()` 与 `discover()` 的分工见第九节「插件激活期不能 spawn 子进程」。

## 二、HTTP 端点

由 `lib/ui.js` 注册，设置页通过同源 HTTP 调用：

| 路径 | 作用 |
| --- | --- |
| `GET  /dsh-app-icon-manager/state` | 图标库 + 快捷方式 + `historyDepth` / `previous` |
| `GET  /dsh-app-icon-manager/icon?name=` | 图标文件本体（预览） |
| `POST /dsh-app-icon-manager/upload` | 上传图片 → 转 `.ico` 入库 |
| `POST /dsh-app-icon-manager/apply` | 切换，体 `{ "name": "<图标名>" }` |
| `POST /dsh-app-icon-manager/reset-default` | 回客户端自带图标 |
| `POST /dsh-app-icon-manager/reset-previous` | 回上一次图标 |

- `icon` 只接受图标库内的名字（`?name=../../../package.json` 返回 404）
- 普通请求体超 64 KiB 断开；`upload` 单独放宽到 16 MiB（base64 膨胀 4/3），
  宿主侧再按**解码后**的真实字节数检查 10 MB 上限
- `upload` 体：`{ data: <base64 或 data URL>, fileName?, name?, overwrite?, apply? }`；
  `apply: true` 时入库后立即切换，响应带 `applied: boolean`
- 设置页**界面本体**不在这些端点里：由 DSH 框架供给到 `/plugins/dsh-plugin-app-icon-manager/client.js`
- `reset-previous` 的返回带 `skipped: { path, current, original }[]`，列出无可回退历史而未改动的项

## 三、开发约定

从 DSH 实测得到的硬规则，改动本插件时必须遵守：

1. **`index.js` 只导出一套形式**：`export function apply(ctx, config)` + 可选 `export const name`。
   另一种形式是默认导出 Service 类，两者不可混用。
2. 资源注册放在 `apply()` 内；服务依赖用 `ctx.inject([...])`，**不要**用同步 `ctx.get`（原因见第九节）。
3. `ctx.set()` 只能覆盖同一 fiber 已注册的服务；初次注册必须用 `ctx.provide()`。
4. `.ps1` 含中文注释时必须是 **UTF-8 带 BOM**；纯 ASCII 则无要求。改过带 BOM 的 `.ps1` 后要补回 BOM
   （见第八节）。`.cmd` 与 `image-to-ico.py` 保持纯 ASCII。
5. **不要用 PowerShell 改本项目含中文的 UTF-8 文件**（会被按 ANSI 读入再写回，整份乱码，见第七节）。
6. 设置页改 `lib/client.js` 后刷新页面即生效；宿主侧（`index.js` / `ui.js`）需重启 DSH。
7. **上传的图片必须先转 `.ico` 再入库**——`IconLocation` 只认 `.ico`，直接放 PNG 会显示空白图标
   （见第四节成因 1）。转换能力来自 DSH 自带的 Python + Pillow，走环境变量 + 文件通信，
   与 `shortcut.js` 同一个理由（管道在沙箱下 `EPERM`）。

---

## 四、图标显示为空白（两个独立成因）

「白图标」有**两个互不相同的原因**，只解决其中一个仍会看到空白。

### 成因 1：`IconLocation` 指向非 `.ico` 文件

COM 的 `WScript.Shell` 会接受 `.png` 作为 `IconLocation`，`Save()` 成功、回读校验也通过
——**但 Explorer 的图标渲染器不认 PNG，静默回退成空白**。因为写接口"成功"了，很难发现。

**定位手段**：生成一个红底白圈蓝点的**真 `.ico`** 诊断图标并应用 → 立刻正常显示。
同一条路径下 PNG 白、ICO 正常，于是锁定格式差异。

防护：写入前用 `lib/icon-file.js` 拦截非 `.ico`，并读文件头魔数（`00 00 01 00`）识破
"`.ico` 外壳装 PNG"这种伪装——扩展名会骗人。

### 成因 2：图标不在 `stableDir` 里

**图标必须复制到 `stableDir`（默认 `%USERPROFILE%\.dsh\app-icons`）才能正常渲染。**

同一张图标（内容哈希相同），只有引用位置不同：

> 下表用 `probe.ico` 表示当时用于对照的那张图标（内容哈希相同，只有引用位置不同）。
> 这些测试图标已从仓库移除，仅保留一个示例 `dsh-icon-v3.ico`。

| 写入的 `IconLocation` | 含空格 | 结果 |
| --- | --- | --- |
| `%USERPROFILE%\.dsh\app-icons\probe.ico,0` | 否 | ✅ 正常（彩色像素 1055） |
| DSH 启动器 `.exe,0`（程序自带图标） | 是 | ✅ 正常 |
| `%USERPROFILE%\.dsh\plugins\app-icon-manager\icons\…`（无空格 junction） | 否 | ❌ 空白 |
| `%TEMP%\dsh-…\dsh-icon-fresh\…`（C 盘全新目录） | 否 | ❌ 空白 |
| `<插件目录>\icons\probe.ico,0`（本机含空格） | 是 | ❌ 空白 |

**逐项排除的假设**：

| 假设 | 反证 |
| --- | --- |
| 图标文件损坏 | 对照用的 `.ico` 与用户原先自备的同内容图标 SHA256 全同；直接解码 256×256、63428 不透明像素 |
| 路径含空格 | 无空格的 junction 路径、C 盘全新目录**同样空白**；含空格的 `D:\Program Files\…Harness.exe` 正常 |
| 盘符差异（C:/D:） | C 盘全新目录也失败 |
| 目录是否已存在 / 是否 junction | 两种情况下都有成功与失败 |
| `.png` 不受支持 | 那是**成因 1**，与本条无关 |

**真因未查明。** 唯一可复现的规律是"只有落在 `stableDir` 里的图标能正常显示"，
底层机制（图标缓存？缩略图缓存？该目录的某种既有状态？）没有找到证据，因此不做推测。
要继续查需要动 Explorer 进程（重启 / 清缓存 / 监控句柄），代价高且不保证有结果。

### 定位方法论（重要）

必须**同时**用两个接口测量：

- `IShellItemImageFactory` —— Explorer 实际使用的接口（走缩略图缓存）
- `SHGetFileInfo` —— 图标提取 API

两者结论不一致正是"文件正常但显示空白"的特征。**只看 `SHGetFileInfo` 会得出"全部正常"的
错误结论**——本项目因此多绕了两轮。

判读方法：`IShellItemImageFactory` 返回 48×48、全不透明但**彩色像素为 0**，即空白图；
彩色像素 > 100 才算正常。

---

## 五、设置页按钮一直不出现

两个原因叠加，都由运行期探针定位（在 `apply()` 与 `inject` 回调里写诊断文件，
再用 headless 实例 `dsh --profile desktop --port <n> --no-open` 启动并直接请求端点）。

### 坑 1：路由前缀不能带结尾斜杠

webserver 的匹配规则是：

```js
if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
```

前缀若写成 `/dsh-app-icon-manager/`，条件就变成要求 pathname 以 `//` 开头，**永远匹配不上**，
表现为所有端点稳定 404。正确写法：`path: '/dsh-app-icon-manager'`。

### 坑 2：服务依赖必须用 `ctx.inject`

探针实测：`apply()` 执行时 `ctx.get('webServer')` 返回 `undefined`，服务尚未就绪。
用它判断会让界面被永久跳过。`ctx.inject(['webServer'], cb)` 会让插件进入等待，
服务出现后再运行回调并重新激活。

---

## 六、浮层方案为何废弃

早先版本向索引页注入一个浮在右下角的悬浮面板，已弃用。原因是它要与别的浮层挂件
（余额小鲸鱼挂件）抢屏幕角落，而这类挂件会在 `document` 上注册**捕获阶段**监听：

```js
document.addEventListener('pointerdown', unlock, true)
document.addEventListener('click', refresh, true)
```

捕获阶段先于冒泡执行，本插件在自身节点上做的冒泡隔离**拦不住它**，表现为
「点我的按钮却点到了下面的东西」。放进设置页就没有这个冲突。

设置页区块的注册方式是 DSH 第三方插件的标准做法（参考 `dsh-disk-manager`）：
`lib/client.js` 以经典脚本注册到 `window.__ModuleLoader__`，工厂内 `require('react')`，
再通过 `ctx.slots.register({ name: 'settings.section', ... })` 挂上。
脚本由 **DSH 框架自动供给**到 `/plugins/<包名>/client.js`，宿主侧无需注册脚本路由。

---

## 七、安装：路径不能含空格

`dsh plugin` 内部用 `spawnSync('pnpm', args, { shell: true })`，args 在 cmd.exe 这一层会被
**按空格重新拆分**。实测现象（以含空格的 `<插件目录>` 为例）：

```
# 传入 link:"<插件目录>"（该目录名含空格）
+ my link:D:/my                                                  ← 路径被空格切成两半
+ plugin link:work\dsh-plugin-app-icon-manager                    ← 剩下半截
```

第一条指向不存在的目录，是**幽灵依赖**，会破坏 profile 加载。
`file:./子目录` 形式同样不行（pnpm 以 profile 目录为基准解析）。

解法：经由无空格的目录联接（junction）传入。

```powershell
$plugin = '<插件目录>'                                    # 本机含空格，故走 junction
$link   = Join-Path $env:USERPROFILE '.dsh\plugins\app-icon-manager'
cmd /c mklink /J "$link" "$plugin"
dsh plugin --profile desktop add "link:$link"
```

出问题的恢复步骤：

```powershell
$p = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
pnpm --dir $p remove Deepseek dsh-plugin-app-icon-manager
# pnpm 不会删悬空 junction，要手动删链接本身（单层，不递归）
cmd /c rmdir "$p\node_modules\Deepseek"
cmd /c rmdir "$p\node_modules\dsh-plugin-app-icon-manager"
```

---

## 八、编码规则（都踩过）

| 文件类型 | 规则 | 后果 |
| --- | --- | --- |
| `.ps1` 含中文 | 必须 **UTF-8 带 BOM** | 无 BOM 会被 PowerShell 5.1 按 ANSI 解码，`param()` 报 `Unexpected token ')'` |
| `.ps1` 纯 ASCII | 无要求 | — |
| `.cmd` | 纯 ASCII | 批处理按 ANSI 代码页解析 |
| 其他源文件 | UTF-8 无 BOM | — |

**不要用 PowerShell 改本项目含中文的 UTF-8 文件**：`Get-Content -Raw` 按 ANSI 读入、
`Set-Content -Encoding UTF8` 写回，会把整个文件变成乱码（本项目 README 曾因此被毁一次）。

**用 edit 工具改带 BOM 的 `.ps1` 后要补回 BOM**——该工具写出的是无 BOM 的 UTF-8。
补 BOM 并校验语法：

```powershell
$f = 'fix-icon.ps1'
$t = [System.IO.File]::ReadAllText($f, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($f, $t, (New-Object System.Text.UTF8Encoding($true)))
$e = $null; $k = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f), [ref]$k, [ref]$e) | Out-Null
"错误数: " + $e.Count
```

⚠️ 遇到含 `銆?` 这类乱码的**假语法错误**，先查 BOM，别去改代码。

---

## 九、其他坑

### `Array.isArray` 不足以判断"历史为空"

给 `history` 做向后兼容补全时，最初写成：

```js
history: Array.isArray(record?.history) ? record.history : [applied]   // ✗
```

空数组也是 `Array`，于是"历史被清空但当前仍是切换值"的记录拿不到补全，表现为
「重置回上次图标」在明明可回退时被判为无可回退、按钮置灰。正确写法要同时判空：
`history.length === 0 && applied !== original` 才补。

### 插件激活期不能 spawn 子进程

`apply()` 里曾调用 `describe()`，而它会 spawn PowerShell（约 0.4s）。激活期阻塞宿主可能
拖住 Electron 的启动握手（`ready` 消息没有超时保护）。现已拆开：`describe()` 零成本、
`discover()` 才 spawn，且只在用户主动触发时调用。

### `fix-icon.ps1` 需要 `-ExecutionPolicy Bypass`

本机 `LocalMachine = RemoteSigned`，脚本无数字签名，直接运行会被拒绝
（`is not digitally signed`）。`fix-icon.cmd` 会替你带上该开关。

### 图标缓存清理在本机不可行

即使先停 Explorer，`iconcache*.db` 仍全部被占用（系统索引 / 安全软件持有句柄），删不掉。
`fix-icon.cmd` 的 `recreate` 动作因此改为"删除并重建快捷方式 + 换新图标路径"来绕开缓存。
