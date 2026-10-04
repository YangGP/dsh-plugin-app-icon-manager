/**
 * 把上传的位图转换成 Windows `.ico`：在 Node 与 Pillow 之间做一次受控的进程调用。
 *
 * ## 为什么需要转换
 *
 * 快捷方式的 `IconLocation` **只认 `.ico`**。COM 会毫无怨言地接受 `.png`，
 * `Save()` 成功、回读校验也通过，但 Explorer 静默显示**空白图标**。
 * 用户上传的多半是 PNG/JPG，所以必须在写入前转成 `.ico`。
 *
 * ## 为什么用 Pillow 而不是自己写编码器
 *
 * 手写 ICO 编码器是可行的（BMP 条目格式简单），但要正确处理多尺寸缩放、
 * 透明通道、JPEG 解码、EXIF 方向、WebP 等格式，等于重造一个图像库。
 * DSH 自带 Python + Pillow（实测 12.3.0），直接用它更可靠。
 *
 * ## 为什么用环境变量 + 文件传递参数
 *
 * 与 `shortcut.js` 同一个理由：管道在受限沙箱下会 `EPERM`，文件通道没有这个约束；
 * 参数走 JSON 文件则完全绕开命令行引号与空格问题（路径可能含空格与非 ASCII）。
 *
 * @module dsh-plugin-app-icon-manager/image-to-ico
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 转换脚本路径（与本模块同目录）。 */
const HELPER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'image-to-ico.py');

/** 单次转换的超时上限（毫秒）。大图解码偏慢，给足余量。 */
const CONVERT_TIMEOUT_MS = 60_000;

/** 生成的 ICO 尺寸集合；256 是 Windows 大图标，24 见于部分资源管理器视图。 */
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 环境变量名：与 image-to-ico.py 的约定保持一致。 */
const REQUEST_ENV = 'DSH_ICO_REQUEST';
const RESULT_ENV = 'DSH_ICO_RESULT';

/**
 * 解析 Python 解释器路径。
 *
 * DSH 自带一个 Python 运行时，优先用它；其次回落到 PATH 里的 `python`。
 * 结果会缓存，避免每次上传都做一轮文件系统探测。
 * @returns {string | null} python 可执行文件路径，找不到返回 null。
 */
let cachedPython;
function pythonPath() {
  if (cachedPython !== undefined) return cachedPython;

  const candidates = [];
  // DSH 运行时的标准位置（本机实测）。
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  candidates.push(join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'));
  // 允许显式覆盖。
  if (typeof process.env.DSH_PYTHON === 'string' && process.env.DSH_PYTHON !== '') {
    candidates.unshift(process.env.DSH_PYTHON);
  }

  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) {
      cachedPython = candidate;
      return cachedPython;
    }
  }
  // 最后尝试 PATH（开发机可能没装 DSH 运行时）。
  cachedPython = 'python';
  return cachedPython;
}

/**
 * 检查转换能力是否可用，供界面提前给出提示。
 * @returns {{ available: boolean, python: string, reason?: string }} 探测结果。
 */
export function conversionAvailability() {
  const python = pythonPath();
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-ico-probe-'));
  const resultPath = join(workDir, 'result.json');
  try {
    const probe = spawnSync(python, ['-c', `import PIL;open(r"${resultPath}","w").write(PIL.__version__)`], {
      stdio: 'ignore',
      timeout: 20_000,
      windowsHide: true,
    });
    if (!existsSync(resultPath)) {
      return {
        available: false,
        python,
        reason: probe.error?.message ?? `Python 未在超时内响应（退出码 ${String(probe.status)}）`,
      };
    }
    return { available: true, python, version: readFileSync(resultPath, 'utf8').trim() };
  } catch (error) {
    return { available: false, python, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 把源图片转换成 ICO 并写入 `targetPath`。
 * @param {string} sourcePath - 源图片（PNG/JPG/WebP/GIF/BMP… 由 Pillow 决定）。
 * @param {string} targetPath - 目标 `.ico` 路径。
 * @returns {{ ok: boolean, width?: number, height?: number, bytes?: number, sizes?: number[][], reason?: string }}
 */
export function convertToIco(sourcePath, targetPath) {
  if (!existsSync(HELPER_SCRIPT)) return { ok: false, reason: `转换脚本缺失: ${HELPER_SCRIPT}` };

  const workDir = mkdtempSync(join(tmpdir(), 'dsh-ico-'));
  const requestPath = join(workDir, 'request.json');
  const resultPath = join(workDir, 'result.json');
  try {
    writeFileSync(
      requestPath,
      JSON.stringify({ source: sourcePath, target: targetPath, sizes: ICON_SIZES }),
      'utf8',
    );

    const spawned = spawnSync(pythonPath(), [HELPER_SCRIPT], {
      env: { ...process.env, [REQUEST_ENV]: requestPath, [RESULT_ENV]: resultPath },
      stdio: 'ignore',
      timeout: CONVERT_TIMEOUT_MS,
      windowsHide: true,
    });

    if (!existsSync(resultPath)) {
      const reason =
        spawned.error?.message ??
        (spawned.status === null
          ? `转换未在 ${String(CONVERT_TIMEOUT_MS)} ms 内结束`
          : `转换进程退出码 ${String(spawned.status)}，未产出结果文件`);
      return { ok: false, reason };
    }

    const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (parsed.ok !== true) return { ok: false, reason: parsed.error ?? '转换失败' };
    return {
      ok: true,
      width: parsed.width,
      height: parsed.height,
      bytes: parsed.bytes,
      sizes: parsed.sizes,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
