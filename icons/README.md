# 图标库目录

插件从这里读取可用图标：

- 文件名（不含扩展名）就是图标名，插件通过它引用该图标
- ⚠️ 写入快捷方式时**只有 `.ico` 会被 Explorer 渲染**
- **不必手工准备 `.ico`**：在设置页「上传图标」选一张 PNG/JPG，插件会自动转成
  多尺寸 `.ico` 存进本目录

## 本目录内容

| 文件 | 说明 |
| --- | --- |
| `dsh-icon-v3.ico` | 示例图标（本项目开发时所用），可直接用来试 |
| `make-icon.ps1` | 生成不同尺寸 PNG 的辅助脚本，仅诊断用，可删 |

用法：

```js
const icons = ctx.get('appIcons')
icons.apply('dsh-icon-v3')   // 切换到这个图标
icons.resetToPrevious()      // 回到上一次用的图标
```

命令行等价写法：

```powershell
node lib/cli.mjs list                      # 看图标名
node lib/cli.mjs add logo.png my-icon      # 上传图片，转 .ico 入库
node lib/cli.mjs set my-icon               # 切换
```

## 支持哪些格式

| 用途 | 可用格式 | 说明 |
| --- | --- | --- |
| 写入快捷方式（本插件的主用途） | **仅 `.ico`** | 非 `.ico` 会被插件拒绝并给出原因 |
| 预览 / Web 界面展示 | `.png` / `.webp` | 建议 ≤ 256 KiB |

扫描时也会列出 `.png` / `.jpg` / `.webp`，但**应用时会失败**——这是有意为之：
早期版本允许写入 `.png`，结果 COM 接受、`Save()` 成功、回读校验也通过，
**但 Explorer 静默显示空白图标**，极难排查。现在改为提前拒绝。

## 注意

- 目录为空是合法状态，插件照常加载，只会报告 0 个图标。
- ⚠️ **图标不能直接从本目录引用**——插件会先复制到 `stableDir` 再写入快捷方式。
  原因见项目根目录的 [INVESTIGATION.md](../INVESTIGATION.md)。
- 本目录只存放**图标素材**；插件不会改写 DSH 安装目录里的任何文件，也不会改动这些源文件。
