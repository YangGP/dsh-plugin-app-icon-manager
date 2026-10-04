/**
 * DSH 应用图标管理器 —— 宿主侧功能插件。
 *
 * 管理 DeepSeek Harness 应用自身的图标，支持在图标库中切换并**还原到原始图标**。
 *
 * ## 关键架构约束（决定了本插件能做什么、不能做什么）
 *
 * 本插件运行在 DSH 的 Cordis 宿主进程中。该进程由 `@deepseek-ai/dsh-desktop-host`
 * 以 `ELECTRON_RUN_AS_NODE` 方式启动，是 Electron 主进程的子进程：
 *
 * - Electron 窗口 / 任务栏 / 托盘图标由主进程在**启动时**从安装目录的打包资源读取
 *   并持有，宿主进程无法在运行时替换。因此"改 DSH 自身的任务栏图标"没有运行时接口，
 *   本插件也不去改写安装目录里的程序文件。
 * - 可落地的表面是**外部壳层数据**：指向 DSH 的 Windows 快捷方式（.lnk）的图标位置。
 *   本插件实现的就是这一条。
 *
 * ## 已实测确认的行为
 *
 * - 自定义 `.ico` 可经 COM 精确写入并回读；切换在系统层面真实生效；
 * - `IconLocation = ''` 会被 COM 以 ArgumentException 拒绝，所以"还原"是把**记录下来的
 *   原始值**写回去，而不是清空字段；
 * - COM **不校验图标文件是否存在**——写入不存在的路径也会"成功"，产生坏图标。因此
 *   写入前必须在 Node 侧校验文件存在且扩展名受支持；
 * - 调用 PowerShell 必须带 `-ExecutionPolicy Bypass`，否则本机 `RemoteSigned` 策略会拒绝。
 *
 * ## 接口约定（来自随包发布的 host-plugin 参考文档）
 *
 * `index.js` 只导出一套形式：函数式插件导出 `apply(ctx, config)`，可附带
 * `export const name`。一切资源注册都发生在 `apply()` 内。
 *
 * @module dsh-plugin-app-icon-manager
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { describeIconFile } from './icon-file.js';
import { convertToIco } from './image-to-ico.js';
import { readShortcuts, writeShortcutIcons } from './shortcut.js';
import { installUi } from './ui.js';

/** Cordis 插件名（Loader 身份标识）。 */
export const name = 'app-icon-manager';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 允许出现在**图标库目录里**的扩展名（供枚举用）。
 *
 * 注意这是"可放进图标库"的格式，不等于"可写入 IconLocation"的格式：
 * ⚠️ 实测结论是**只有 `.ico` 能被 Explorer 渲染**。COM 会毫无怨言地接受 `.png` 并让回读
 * 校验通过，但 Explorer 的图标渲染器不认 PNG，会静默回退成**空白图标**。这个坑排查了很久
 * （文件正常、路径正常、快捷方式已重建，图标却始终是白的），最后靠应用一个 `.ico` 诊断图标
 * 才定位。可写性判定统一由 `icon-file.js` 提供，与 Web 面板共用同一套结论。
 */
const ICON_EXTENSIONS = Object.freeze(['.ico', '.png', '.jpg', '.jpeg', '.webp']);

/**
 * 允许**上传**的源图片格式。
 *
 * 比 `ICON_EXTENSIONS` 宽：上传的源文件是什么格式无所谓，反正会转成 `.ico` 再入库。
 * 扫描文件头魔数来判定，**不信任扩展名**（用户可能把 PNG 改名成 `.jpg`）。
 */
const UPLOAD_SIGNATURES = Object.freeze([
  { format: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { format: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { format: 'GIF', bytes: [0x47, 0x49, 0x46, 0x38] },
  { format: 'BMP', bytes: [0x42, 0x4d] },
  // WebP: RIFF....WEBP，需同时校验偏移 0 与 8
  { format: 'WEBP', bytes: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  // TIFF（Pillow 也支持，顺便放行）
  { format: 'TIFF-LE', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { format: 'TIFF-BE', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
]);

/** 上传体积上限（字节）。超过这个大小的 base64 请求体会被端点直接拒绝。 */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** 插件自有状态文件，记录每个快捷方式的原始图标，作为还原依据。 */
const STATE_FILE = join(PACKAGE_ROOT, '.state', 'shortcuts.json');

/** 快捷方式辅助脚本；纯 ASCII，原因见该文件头部说明。 */
const HELPER_SCRIPT = join(PACKAGE_ROOT, 'lib', 'shortcut.ps1');

/** 配置默认值；`cordis.patch.yml` 的 config 会覆盖它们。 */
const DEFAULT_CONFIG = Object.freeze({
  libraryDir: 'icons',
  applyOnStart: false,
  dshExecutable: 'D:\\Program Files\\DSH\\DeepSeek Harness.exe',
  // 图标写入 IconLocation 前复制到这里，**保留原文件名**。
  // 为什么必须复制：实测只有落在这个目录里的图标能被 Explorer 正常渲染，直接引用
  // 插件图标库会显示为空白图标；空格、盘符、目录新旧、junction 均已逐项排除，真因未查明。
  // 相对用户主目录解析（用户主目录不含空格）。
  stableDir: '.dsh\\app-icons',
  // 「重置回客户端图标」时写入的默认图标。空字符串表示取 dshExecutable 的索引 0，
  // 即 DSH 启动器自带的图标——这也是「默认的样子」最自然的解释。
  defaultIcon: '',
});

/**
 * 读取 config 中的字符串项，非法值回落到默认值。
 * @param {unknown} value - 待校验的配置值。
 * @param {string} fallback - 默认值。
 * @returns {string} 合法的字符串配置。
 */
function stringConfig(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * 读取 config 中的布尔项。
 * @param {unknown} value - 待校验的配置值。
 * @param {boolean} fallback - 默认值。
 * @returns {boolean} 合法的布尔配置。
 */
function booleanConfig(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 把图标位置字符串拆成路径与索引。
 *
 * `.lnk` 的 IconLocation 形如 `C:\a\b.ico,0`；索引可省略。
 * @param {string | null} location - 原始 IconLocation。
 * @returns {{ path: string, index: number | null }} 拆分结果。
 */
function parseIconLocation(location) {
  if (typeof location !== 'string' || location === '') return { path: '', index: null };
  const comma = location.lastIndexOf(',');
  if (comma === -1) return { path: location, index: null };
  const index = Number.parseInt(location.slice(comma + 1), 10);
  if (!Number.isInteger(index)) return { path: location, index: null };
  return { path: location.slice(0, comma), index };
}

/**
 * 组装标准形式的 IconLocation 字符串。
 * @param {string} file - 图标文件或可执行文件路径。
 * @param {number} index - 图标索引。
 * @returns {string} `路径,索引`。
 */
function formatIconLocation(file, index) {
  return `${file},${String(index)}`;
}

/**
 * 校验一个图标位置字符串是否可以安全写入。
 *
 * 三层校验都是必需的：
 * 1. **存在性**——COM 不校验目标是否存在，写入不存在的路径会静默产生坏图标；
 * 2. **扩展名**——只有 `.ico` 能被 Explorer 渲染，`.png` 会被 COM 接受并回读成功却显示空白；
 * 3. **文件头**——扩展名可能是骗人的（.ico 里装着 PNG），必须读魔数确认。
 *
 * 第 2、3 层由共享模块 `icon-file.js` 实现，与 Web 面板使用同一套判定，避免两处结论不一致。
 * @param {string} location - 待写入的 IconLocation。
 * @returns {string | null} 合法时返回 null，否则返回原因。
 */
function validateIconLocation(location) {
  const { path } = parseIconLocation(location);
  if (path === '') return 'icon location is empty';
  if (!existsSync(path)) return `icon file does not exist: ${path}`;
  const verdict = describeIconFile(path);
  return verdict.usable ? null : verdict.reason;
}

/**
 * 把图标复制到 `stableDir`（**保留原文件名**），返回副本路径。
 *
 * ## 为什么必须复制
 *
 * 实测确证：**只有落在 `stableDir` 里的图标能被 Explorer 正常渲染**，直接引用插件图标库
 * 会显示为空白图标。对比数据（同一张 `.ico`，内容哈希相同）：
 *
 * | 路径 | 含空格 | 结果 |
 * | --- | --- | --- |
 * | `%USERPROFILE%\.dsh\app-icons\<图标名>.ico` | 否 | 正常 |
 * | DSH 启动器 `.exe`（程序自带图标） | 是 | 正常 |
 * | `<插件目录>\icons\<图标名>.ico` | 是 | **空白** |
 * | `%USERPROFILE%\.dsh\plugins\<包名>\icons\…`（无空格 junction） | 否 | **空白** |
 * | `%TEMP%\dsh-…\dsh-icon-fresh\…`（C 盘全新目录） | 否 | **空白** |
 *
 * 「路径含空格」这个早期结论已被推翻——无空格的 junction 与 C 盘全新目录同样空白。
 * 空格、盘符、目录新旧、junction 都逐项排除过，真因未查明。详见 INVESTIGATION.md。
 *
 * ## 命名
 *
 * 保留原文件名（`my-icon.ico` → `my-icon.ico`），而不是早先的时间戳（`dsh-2026….ico`）：
 * 时间戳会在每次切换时留下一个新文件，堆出一串看不出含义的副本。
 * 内容相同的文件会复用，不重复复制。
 * @param {string} sourcePath - 图标库中的源文件。
 * @param {string} targetDir - 不含空格的稳定目录；空字符串表示原地引用（不推荐，见上）。
 * @returns {{ path: string } | { error: string }} 最终要写入的路径，或失败原因。
 */
function stageIcon(sourcePath, targetDir) {
  if (targetDir === '') return { path: sourcePath };
  try {
    mkdirSync(targetDir, { recursive: true });
    const destination = join(targetDir, basename(sourcePath));
    // 内容相同就复用，避免每次切换都重写一遍。
    let same = false;
    try {
      same = readFileSync(sourcePath).equals(readFileSync(destination));
    } catch {
      same = false;
    }
    if (!same) copyFileSync(sourcePath, destination);
    return { path: destination };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 按文件头魔数判断上传数据的格式。
 *
 * **不信任扩展名**：用户可能把 `.png` 改名成 `.jpg`，或把别的文件改名成 `.png`。
 * 真正的判定依据只能是字节内容。
 * @param {Buffer} buffer - 上传的原始字节。
 * @returns {string | null} 识别出的格式名，无法识别返回 null。
 */
function detectImageFormat(buffer) {
  for (const signature of UPLOAD_SIGNATURES) {
    const matches = signature.bytes.every((byte, index) => buffer[index] === byte);
    if (!matches) continue;
    if (signature.extra !== undefined) {
      const { offset, bytes } = signature.extra;
      const extraMatches = bytes.every((byte, index) => buffer[offset + index] === byte);
      if (!extraMatches) continue;
    }
    return signature.format;
  }
  return null;
}

/**
 * Windows 保留设备名（`CON` / `NUL` / `COM1`…）。
 *
 * 实测澄清：**加了扩展名之后这些名字是可用的**——`CON.ico` 能正常写入，
 * 裸的 `CON` 才会被当作设备而失败。所以这里只是保险，不是必需；
 * 撞上时加个前缀，代价为零而避免了任何版本/环境差异。
 */
const RESERVED_NAMES = Object.freeze(
  new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_, index) => `COM${String(index + 1)}`),
    ...Array.from({ length: 9 }, (_, index) => `LPT${String(index + 1)}`),
  ]),
);

/**
 * 把用户提供的名字清理成安全的文件名主干。
 *
 * 去掉路径分隔符与 Windows 非法字符，防止 `../../x` 之类的名字逃出图标库目录。
 * @param {string} raw - 原始名字（通常是上传文件名去掉扩展名）。
 * @returns {string} 可安全用作文件名的字符串，可能为空。
 */
function sanitizeIconName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/]/gu, '-') // 路径分隔符
    .replace(/[:*?"<>|]/gu, '') // Windows 非法字符
    .replace(/[\u0000-\u001f]/gu, '') // 控制字符
    .replace(/^[.\-\s]+/u, '') // 前导点/横线/空白：避免隐藏文件、`..`、以及被当成命令行选项
    .replace(/[.\s]+$/u, '') // 结尾的点与空白：实测 Windows 不会改名，但去掉更整齐
    .trim()
    .slice(0, 64);
  if (RESERVED_NAMES.has(cleaned.toUpperCase())) return `icon-${cleaned}`;
  return cleaned;
}

/**
 * 在图标库目录里为 `name` 找一个不冲突的 `.ico` 文件名。
 * @param {string} dir - 图标库目录。
 * @param {string} name - 已清理的名字主干。
 * @returns {string} 可用的文件名（含 `.ico`）。
 */
function uniqueIconFileName(dir, name) {
  const base = name === '' ? 'icon' : name;
  if (!existsSync(join(dir, `${base}.ico`))) return `${base}.ico`;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${String(index)}.ico`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${base}-${String(Date.now())}.ico`;
}

/**
 * 解析图标库的绝对路径；相对路径一律相对插件根目录，避免依赖进程 cwd。
 * @param {string} dir - 配置中的图标库目录。
 * @returns {string} 绝对路径。
 */
function resolveLibraryDir(dir) {
  return resolve(PACKAGE_ROOT, dir);
}

/**
 * 枚举图标库中的候选图标文件。读取失败不抛错：图标库为空是合法状态。
 * @param {string} dir - 图标库绝对路径。
 * @returns {{ name: string, file: string, bytes: number }[]} 按名称排序的条目。
 */
function scanLibrary(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const icons = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!ICON_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue;
    const file = join(dir, entry.name);
    try {
      icons.push({ name: basename(entry.name, extname(entry.name)), file, bytes: statSync(file).size });
    } catch {
      continue;
    }
  }
  icons.sort((a, b) => a.name.localeCompare(b.name));
  return icons;
}

/**
 * 按名称或文件名查找图标库中的图标。
 * @param {{ name: string, file: string }[]} icons - 图标库条目。
 * @param {string} key - 图标名（不含扩展名）或完整文件名。
 * @returns {{ name: string, file: string } | undefined} 命中的条目。
 */
function findIcon(icons, key) {
  const wanted = key.trim().toLowerCase();
  return icons.find(
    (icon) => icon.name.toLowerCase() === wanted || basename(icon.file).toLowerCase() === wanted,
  );
}

/**
 * 读取状态文件。
 *
 * 顺带做两处向后兼容补全（老版本没有 `history` 字段）：
 *
 * 1. `applied` 缺失时用 `original` 兜底，避免 `undefined` 参与比较；
 * 2. `history` **缺失或为空**、且当前值不等于 `original` 时，补成 `[original]`。
 *    语义是"当前这个图标是切换来的，再往前一步就是最初的样子"，因此
 *    「重置回上次图标」在旧记录上也能工作一次（回到最初）。
 *
 * ⚠️ 注意第 2 条不能写成 `Array.isArray(record.history) ? record.history : ...`——
 * 空数组也是 Array，会漏掉"历史被清空但当前仍是切换值"这种记录（实测踩到过：
 * 于是「重置回上次图标」在明明可回退的情况下被判为无可回退、按钮置灰）。
 * @returns {{ shortcuts: Record<string, { original: string, applied: string, appliedAt: string, history: string[] }> }}
 */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const raw = parsed?.shortcuts ?? {};
    const shortcuts = {};
    for (const [path, record] of Object.entries(raw)) {
      const original = typeof record?.original === 'string' ? record.original : '';
      const applied = typeof record?.applied === 'string' ? record.applied : original;
      const stored = Array.isArray(record?.history) ? record.history.filter((v) => typeof v === 'string') : [];
      let history = stored;
      if (history.length === 0 && applied !== '' && applied !== original) history = [original];
      shortcuts[path] = {
        original,
        applied,
        appliedAt: record?.appliedAt ?? '',
        history,
      };
    }
    return { shortcuts };
  } catch {
    return { shortcuts: {} };
  }
}

/**
 * 写入状态文件，目录不存在时创建。
 * @param {{ shortcuts: Record<string, unknown> }} state - 待写入状态。
 * @returns {string | null} 成功返回 null，失败返回原因。
 */
function writeState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 读取快捷方式辅助脚本正文；失败返回 null，避免插件加载直接崩溃。
 * @returns {string | null} 脚本正文。
 */
function loadHelperScript() {
  try {
    return readFileSync(HELPER_SCRIPT, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 装载图标管理器：注册 `appIcons` 服务。
 *
 * `ctx.provide()` 的 disposer 绑定在本插件 fiber 上，插件停止或更新时服务自动撤销。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} [config] - 来自配置树的行配置。
 */
export function apply(ctx, config) {
  const options = {
    libraryDir: resolveLibraryDir(stringConfig(config?.libraryDir, DEFAULT_CONFIG.libraryDir)),
    applyOnStart: booleanConfig(config?.applyOnStart, DEFAULT_CONFIG.applyOnStart),
    dshExecutable: resolve(stringConfig(config?.dshExecutable, DEFAULT_CONFIG.dshExecutable)),
    // stableDir 留空 = 不复制，直接用图标库里的原文件（默认）。
    // 配置时要给一个**绝对路径或不含空格的相对用户主目录的路径**，因为它的用途正是
    // "把图标放到一个稳定且不含空格的位置"。
    stableDir: (() => {
      const configured = stringConfig(config?.stableDir, DEFAULT_CONFIG.stableDir);
      if (configured === '') return '';
      return resolve(process.env.USERPROFILE ?? PACKAGE_ROOT, configured);
    })(),
  };

  // 「默认图标」= 显式配置的 defaultIcon，未配置时取 DSH 启动器自带的索引 0。
  // 指向 .exe 是 Windows 的标准做法，还原后就是"没有自定义过"的样子。
  const defaultIconLocation = (() => {
    const configured = stringConfig(config?.defaultIcon, DEFAULT_CONFIG.defaultIcon);
    return configured === '' ? `${options.dshExecutable},0` : configured;
  })();

  /**
   * 把图标位置写入每一条快捷方式，并按需更新状态文件。
   *
   * `apply` 与两个重置动作的写入部分一致，只有"目标值怎么来"不同，
   * 所以统一走这里，避免多处逻辑漂移。
   * @param {string} location - 要写入的 IconLocation。
   * @param {{ pushHistory: boolean }} behavior - 是否把**写入前**的图标压入历史。
   *   切换图标时用 true（这样"重置回上次图标"才有依据）；重置动作本身用 false
   *   （重置不应该污染历史，否则连点两次重置会来回横跳）。
   * @returns {{ ok: boolean, reason?: string, applied?: object[], recordedOriginals?: object[] }}
   */
  function writeIconToAll(location, behavior) {
    const script = loadHelperScript();
    if (script === null) return { ok: false, reason: `helper script missing: ${HELPER_SCRIPT}` };

    const invalid = validateIconLocation(location);
    if (invalid !== null) return { ok: false, reason: invalid };

    const { shortcuts, error } = discoverShortcuts();
    if (error !== null) return { ok: false, reason: error };
    if (shortcuts.length === 0) {
      return { ok: false, reason: `no shortcut pointing at ${options.dshExecutable} was found` };
    }

    const state = readState();
    const recorded = [];
    const now = new Date().toISOString();
    for (const entry of shortcuts) {
      const existing = state.shortcuts[entry.path];
      const previous = entry.iconLocation ?? '';

      if (existing === undefined) {
        // 首次记录：original 从此固定，之后不再改动（这样"重置回最初"始终可回溯）。
        state.shortcuts[entry.path] = {
          original: previous,
          applied: location,
          appliedAt: now,
          history: behavior.pushHistory && previous !== '' ? [previous] : [],
        };
        recorded.push({ path: entry.path, original: previous });
      } else {
        // 把写入前的值压入历史；与栈顶相同则不重复压（切换回同一个图标无意义）。
        if (behavior.pushHistory && previous !== '') {
          const stack = Array.isArray(existing.history) ? existing.history : [];
          if (stack[stack.length - 1] !== previous) stack.push(previous);
          existing.history = stack;
        }
        existing.applied = location;
        existing.appliedAt = now;
      }
    }
    const stateError = writeState(state);
    if (stateError !== null) return { ok: false, reason: `cannot write state: ${stateError}` };

    const written = writeShortcutIcons(
      script,
      shortcuts.map((entry) => ({ path: entry.path, iconLocation: location })),
    );
    const failures = (written.entries ?? []).filter((entry) => entry.error !== null);
    return {
      ok: failures.length === 0,
      reason: failures.length === 0 ? undefined : failures.map((f) => `${f.path}: ${f.error}`).join('; '),
      iconLocation: location,
      applied: (written.entries ?? []).map((entry) => ({
        path: entry.path,
        iconLocation: entry.iconLocation,
        changed: entry.changed,
      })),
      recordedOriginals: recorded,
    };
  }

  /**
   * 找出指向 DSH 的快捷方式。
   *
   * 先按文件名粗筛，再用 COM 读取 TargetPath 精确确认指向本应用的启动器。目标不匹配的
   * 一律不改写，避免误伤同名的其他快捷方式。
   * @returns {{ shortcuts: object[], error: string | null }} 已确认的快捷方式。
   */
  function discoverShortcuts() {
    const script = loadHelperScript();
    if (script === null) return { shortcuts: [], error: `helper script missing: ${HELPER_SCRIPT}` };

    const candidates = [];
    const searchDirs = [
      join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      join(process.env.APPDATA ?? '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
      join(process.env.USERPROFILE ?? '', 'Desktop'),
      join(process.env.PUBLIC ?? '', 'Desktop'),
    ].filter((dir) => dir !== '' && existsSync(dir));

    for (const dir of searchDirs) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of entries) {
        if (!file.isFile() || extname(file.name).toLowerCase() !== '.lnk') continue;
        if (!/deepseek|harness|dsh/i.test(file.name)) continue;
        candidates.push(join(dir, file.name));
      }
    }

    const entries = readShortcuts(script, candidates);
    const matched = entries.filter(
      (entry) =>
        entry.exists &&
        typeof entry.targetPath === 'string' &&
        resolve(entry.targetPath) === options.dshExecutable,
    );
    return { shortcuts: matched, error: null };
  }

  /**
   * 图标管理器对外接口。
   *
   * `apply` / `restore` 会写磁盘（快捷方式与插件状态文件），其余为纯读取。
   */
  const appIcons = {
    /** @returns {string} 图标库绝对路径。 */
    libraryDir: () => options.libraryDir,
    /** @returns {{ name: string, file: string, bytes: number }[]} 当前图标库条目。 */
    library: () => scanLibrary(options.libraryDir),
    /**
     * 解析一个图标名到磁盘文件。
     * @param {string} key - 图标名或文件名。
     * @returns {string | undefined} 图标绝对路径；不存在时为 undefined。
     */
    resolve: (key) => findIcon(scanLibrary(options.libraryDir), String(key))?.file,
    /**
     * 枚举指向 DSH 的快捷方式及其当前图标。
     *
     * ⚠️ 本方法会 spawn PowerShell（约 2 秒），**只能在用户主动触发时调用**
     * （面板打开、CLI 命令、apply/restore 内部）。绝不可在插件激活路径上调用。
     * @returns {{ shortcuts: object[], error: string | null }} 快捷方式明细。
     */
    discover: () => discoverShortcuts(),
    /** @returns {{ shortcuts: object[], error: string | null }} `discover()` 的别名。 */
    shortcuts: () => discoverShortcuts(),
    /** @returns {{ shortcuts: Record<string, object> }} 已记录的原始图标（还原依据）。 */
    state: () => readState(),
    /** @returns {string} 状态文件路径。 */
    stateFile: () => STATE_FILE,

    /**
     * 把某个图标应用到所有指向 DSH 的快捷方式。
     *
     * 写入前会先记录每个快捷方式的原始图标，且只记录第一次——连续切换时不会把中间态
     * 当成原始态，因此 `restore()` 总能回到最初的值。
     * @param {string | { file: string, index?: number }} icon - 图标库中的名字，或显式文件与索引。
     * @returns {{ ok: boolean, reason?: string, applied?: object[], recordedOriginals?: object[] }} 结果。
     */
    apply(icon) {
      let sourceFile;
      let index = 0;
      if (typeof icon === 'string') {
        const found = findIcon(scanLibrary(options.libraryDir), icon);
        if (found === undefined) return { ok: false, reason: `icon not found in library: ${icon}` };
        sourceFile = found.file;
      } else if (icon !== null && typeof icon === 'object' && typeof icon.file === 'string') {
        sourceFile = icon.file;
        index = Number.isInteger(icon.index) ? icon.index : 0;
      } else {
        return { ok: false, reason: 'icon must be a library name or { file, index }' };
      }

      // 只接受 .ico：Explorer 不渲染 .png（COM 却会接受，导致难以发现的空白图标）。
      const precheck = validateIconLocation(formatIconLocation(sourceFile, index));
      if (precheck !== null) return { ok: false, reason: precheck };

      // 默认直接用图标库里的原文件；只有配置了 stableDir 才复制一份过去。
      const staged = stageIcon(sourceFile, options.stableDir);
      if (staged.error !== undefined) {
        return { ok: false, reason: `cannot stage icon to ${options.stableDir}: ${staged.error}` };
      }

      // 把写入前的图标压入历史（pushHistory: true），这样「重置回上次图标」才有依据。
      return writeIconToAll(formatIconLocation(staged.path, index), { pushHistory: true });
    },

    /** @returns {string} 「重置回默认图标」写入的值（DSH 启动器自带的图标）。 */
    defaultIcon: () => defaultIconLocation,

    /**
     * 把上传的图片转成 `.ico` 并存入图标库。
     *
     * 为什么必须转换：`IconLocation` 只认 `.ico`。用户上传的多半是 PNG/JPG，
     * 直接入库虽然能预览，但应用到快捷方式后 Explorer 会显示**空白图标**
     * （COM 会接受、Save 会成功、回读也通过，所以这个坑极难发现）。
     *
     * @param {object} input - 上传内容。
     * @param {string} input.data - base64 编码的图片字节（可含 `data:` 前缀，会被剥掉）。
     * @param {string} [input.fileName] - 原始文件名，用于推导默认图标名。
     * @param {string} [input.name] - 用户指定的图标名；省略时从 fileName 推导。
     * @param {boolean} [input.overwrite] - 同名时是否覆盖（默认 false，自动加 -2 后缀）。
     * @returns {{ ok: boolean, reason?: string, icon?: object }} 结果。
     */
    upload({ data, fileName, name, overwrite } = {}) {
      if (typeof data !== 'string' || data === '') {
        return { ok: false, reason: '请求缺少图片数据' };
      }

      // 浏览器 FileReader 会给 data URL，剥掉前缀只留 base64。
      const payload = data.startsWith('data:') ? (data.split(',')[1] ?? '') : data;
      let buffer;
      try {
        buffer = Buffer.from(payload, 'base64');
      } catch {
        return { ok: false, reason: 'base64 解码失败' };
      }
      if (buffer.length === 0) return { ok: false, reason: '图片数据为空' };
      if (buffer.length > UPLOAD_MAX_BYTES) {
        const mb = (UPLOAD_MAX_BYTES / 1024 / 1024).toFixed(0);
        return { ok: false, reason: `图片超过 ${mb} MB 上限` };
      }

      // 按魔数判定格式，而不是扩展名。
      const format = detectImageFormat(buffer);
      if (format === null) {
        return {
          ok: false,
          reason: '无法识别的图片格式（支持 PNG / JPEG / GIF / BMP / WebP / TIFF）',
        };
      }
      const truncated = format.startsWith('TIFF'); // 上面用于匹配，这里归一到人类可读名
      const formatLabel = truncated ? 'TIFF' : format;

      const dir = options.libraryDir;
      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
        return { ok: false, reason: `无法创建图标库目录: ${String(error)}` };
      }

      // 名字优先级：显式 name > 上传文件名（去扩展名）> icon
      const rawName =
        typeof name === 'string' && name.trim() !== ''
          ? name
          : basename(String(fileName ?? ''), extname(String(fileName ?? '')));
      const cleanName = sanitizeIconName(rawName);

      let targetName;
      if (overwrite === true && cleanName !== '' && existsSync(join(dir, `${cleanName}.ico`))) {
        targetName = `${cleanName}.ico`;
      } else {
        targetName = uniqueIconFileName(dir, cleanName);
      }
      const targetPath = join(dir, targetName);

      // 源图先落到临时文件：Pillow 需要一个真实路径，且临时文件被沙箱允许。
      let tempPath = null;
      try {
        const stamp = `${String(Date.now())}-${String(process.pid)}`;
        tempPath = join(tmpdir(), `dsh-upload-${stamp}${extname(String(fileName ?? '')) || '.img'}`);
        writeFileSync(tempPath, buffer);

        const converted = convertToIco(tempPath, targetPath);
        if (converted.ok !== true) {
          // 转换失败时清掉可能的半成品，避免图标库里出现坏文件。
          try {
            if (existsSync(targetPath)) rmSync(targetPath, { force: true });
          } catch {
            /* 清理失败不影响错误上报 */
          }
          return { ok: false, reason: `转换失败: ${converted.reason ?? '未知原因'}` };
        }

        const iconName = basename(targetPath, '.ico');
        return {
          ok: true,
          icon: {
            name: iconName,
            file: targetPath,
            bytes: converted.bytes ?? statSync(targetPath).size,
            source: { format: formatLabel, width: converted.width, height: converted.height },
            sizes: (converted.sizes ?? []).map((pair) => pair[0]),
            replaced: targetName === `${cleanName}.ico`,
          },
        };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        if (tempPath !== null) {
          try {
            rmSync(tempPath, { force: true });
          } catch {
            /* 临时文件清理失败不阻塞上传结果 */
          }
        }
      }
    },

    /**
     * 重置为**客户端自己的图标**（DSH 启动器自带的那个）。
     *
     * 不依赖任何记录：无论之前是什么、有没有切换过，一律指向启动器图标，
     * 也就是"从未自定义过"的样子。因此任何时刻都可点，可反复点。
     * 不压历史——重置动作不应污染历史，否则连点两次会来回横跳。
     * @returns {{ ok: boolean, reason?: string, applied?: object[] }} 结果。
     */
    resetToDefault() {
      return writeIconToAll(defaultIconLocation, { pushHistory: false });
    },

    /**
     * 重置为**上一次的图标**（撤销最近一次变化）。
     *
     * 目标值按优先级取：
     * 1. 历史栈顶（最近一次切换前的图标）——真正的"上次"；
     * 2. 历史为空但当前值不等于 original 时，取 original——即回到最初；
     * 3. 历史为空且当前值已等于 original → 报告"没有上一次"，不做写入。
     *
     * 栈顶若已失效（文件被删等）则继续向前找，找到第一个可用的。
     * @returns {{ ok: boolean, reason?: string, restored?: object[], skipped?: object[] }} 结果。
     */
    resetToPrevious() {
      const script = loadHelperScript();
      if (script === null) return { ok: false, reason: `helper script missing: ${HELPER_SCRIPT}` };

      // 直接枚举快捷方式：状态文件可能没有记录（例如从未切换过），此时也要给出明确原因。
      const { shortcuts, error } = discoverShortcuts();
      if (error !== null) return { ok: false, reason: error };
      if (shortcuts.length === 0) {
        return { ok: false, reason: `no shortcut pointing at ${options.dshExecutable} was found` };
      }

      const state = readState();
      const items = [];
      const noHistory = [];

      for (const entry of shortcuts) {
        const record = state.shortcuts[entry.path];
        const current = entry.iconLocation ?? '';
        const stack = Array.isArray(record?.history) ? record.history : [];

        // 从栈顶往前找第一个可用的历史值。
        let target;
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (validateIconLocation(stack[i]) === null) {
            target = stack[i];
            break;
          }
        }
        // 没有可用历史时退回 original（前提是当前值确实不同于它，否则无事可做）。
        if (target === undefined && record?.original && current !== record.original) {
          if (validateIconLocation(record.original) === null) target = record.original;
        }

        if (target === undefined) {
          noHistory.push({ path: entry.path, current, original: record?.original ?? null });
          continue;
        }
        items.push({ path: entry.path, iconLocation: target });
      }

      if (items.length === 0) {
        return {
          ok: false,
          reason: '没有上一次的图标可回退（当前已是记录的初始状态）',
          skipped: noHistory,
        };
      }

      // 重置本身不再压历史（pushHistory: false）。
      // 这里不能复用 writeIconToAll：每条快捷方式的目标值各不相同（各自的历史栈顶）。
      const written = writeShortcutIcons(script, items);
      const failures = (written.entries ?? []).filter((entry) => entry.error !== null);

      // 回退成功后把用掉的那一层历史弹出，避免连点两次回到同一个值。
      if (failures.length === 0) {
        for (const item of items) {
          const record = state.shortcuts[item.path];
          if (!record || !Array.isArray(record.history)) continue;
          const idx = record.history.lastIndexOf(item.iconLocation);
          if (idx !== -1) record.history.splice(idx, 1);
          record.applied = item.iconLocation;
          record.appliedAt = new Date().toISOString();
        }
        writeState(state);
      }

      return {
        ok: failures.length === 0,
        reason:
          failures.length === 0 ? undefined : failures.map((f) => `${f.path}: ${f.error}`).join('; '),
        restored: (written.entries ?? []).map((entry) => ({
          path: entry.path,
          iconLocation: entry.iconLocation,
          changed: entry.changed,
        })),
        skipped: noHistory,
      };
    },

    /**
     * 探测各图标表面的可管理性，供调用方决定后续动作。
     *
     * ⚠️ 本方法**故意不枚举快捷方式**。枚举需要 spawn PowerShell（约 2 秒），而 `apply()`
     * 在第 461 行调用过它——插件激活期间阻塞宿主会卡住启动握手，实测导致 DSH 无法启动。
     * 因此这里只做零成本的本地读取；需要快捷方式明细请调用 `discover()`。
     * @returns {object} 可 JSON 序列化的诊断结果。
     */
    describe() {
      const library = scanLibrary(options.libraryDir);
      const state = readState();
      return {
        plugin: name,
        packageRoot: PACKAGE_ROOT,
        platform: process.platform,
        dshExecutable: options.dshExecutable,
        library: {
          dir: options.libraryDir,
          count: library.length,
          icons: library.map((icon) => ({ name: icon.name, file: icon.file, bytes: icon.bytes })),
        },
        shortcuts: {
          error: null,
          count: Object.keys(state.shortcuts).length,
          items: Object.entries(state.shortcuts).map(([path, record]) => ({
            path,
            iconLocation: record.applied ?? null,
            original: record.original ?? null,
          })),
        },
        surfaces: {
          /**
           * Electron 主进程在启动时读取打包资源并持有窗口/任务栏/托盘图标，
           * 宿主进程无法在运行时替换。这是平台能力边界，不是待办事项。
           */
          electronWindowIcon: {
            manageable: false,
            reason: 'held by the Electron main process at launch',
          },
          /** 指向 DSH 的快捷方式：win32 上已实现。 */
          shortcutIcon: {
            manageable: process.platform === 'win32',
            implemented: process.platform === 'win32',
          },
          /** 独立托盘辅助进程图标：尚未实现。 */
          helperTrayIcon: { manageable: false, implemented: false },
        },
      };
    },
  };

  ctx.provide('appIcons', appIcons);

  // ⚠️ 启动日志必须走零成本路径（`describe()` 现在只读本地文件）。
  // 它绝不 spawn PowerShell：激活期阻塞宿主会卡住 Electron 的启动握手。
  let described;
  try {
    described = appIcons.describe();
  } catch {
    described = { library: { dir: options.libraryDir, count: 0 }, shortcuts: { count: 0 } };
  }
  ctx.logger.info(
    `${name}: 图标库 ${described.library.dir}（${String(described.library.count)} 个图标）已就绪`,
  );
  if (options.applyOnStart) {
    ctx.logger.info(`${name}: applyOnStart 已开启；本版本不会在启动时自动改写快捷方式`);
  }

  // Web 界面：没有 webServer 服务时静默降级，插件其余功能不受影响。
  //
  // 用 `ctx.inject` 而不是同步的 `ctx.get('webServer')`：`apply()` 执行时 webServer 服务
  // 可能尚未就绪，`ctx.get` 会返回 undefined 而导致界面被永久跳过。inject 会让本插件进入
  // 等待，待服务出现后再运行回调并重新激活。
  //
  // 整个装载过程再包一层 try/catch：插件激活抛错绝不能影响 DSH 启动。
  if (booleanConfig(config?.ui, true)) {
    try {
      ctx.inject(['webServer'], (uiCtx) => {
        try {
          installUi(uiCtx, appIcons);
        } catch (error) {
          ctx.logger.error(
            `${name}: 装载 Web 界面失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    } catch (error) {
      ctx.logger.error(
        `${name}: 注册 Web 界面依赖失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    ctx.logger.info(`${name}: 配置 ui=false，未装载 Web 界面`);
  }
}
