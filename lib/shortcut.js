/**
 * 快捷方式（.lnk）图标读写：在 Node 与 PowerShell COM 之间做一次受控的进程调用。
 *
 * ## 为什么走 PowerShell 子进程
 *
 * Windows 没有 Node 原生的 .lnk 读写接口，而 .lnk 二进制格式含多种可选结构与
 * ID 列表，手写解析器风险高。`WScript.Shell` COM 对象就是系统自己的读写实现，
 * 经 PowerShell 调用最可靠——这也是 DSH 生态里同类插件（托盘类）采用的模式。
 *
 * ## 为什么用文件传递参数、用 base64 传递脚本
 *
 * 实测踩到的三个坑，决定了这里的调用形态：
 *
 * 1. **引号**：参数直接拼进命令行会被拆分/转义破坏。改为把脚本以 UTF-16LE 编码成
 *    base64 交给 `-EncodedCommand`，彻底绕开命令行引号规则。
 * 2. **执行策略**：本机 `LocalMachine` 策略为 `RemoteSigned`，直接 `-File` 跑脚本会被
 *    拒绝（"未对文件进行数字签名"），因此必须带 `-ExecutionPolicy Bypass`。
 * 3. **编码**：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 文件按 ANSI 解码，所以
 *    `shortcut.ps1` 保持纯 ASCII；脚本正文存文件便于阅读与语法检查，运行时再读取。
 *
 * 输入输出走临时文件而不是管道：管道在受限沙箱下会 `EPERM`，文件通道没有这个约束。
 * 临时文件只在系统 temp 目录创建，用完在 finally 中删除。
 *
 * @module dsh-plugin-app-icon-manager/shortcut
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 单次 PowerShell 调用的超时上限（毫秒）。 */
const POWERSHELL_TIMEOUT_MS = 20_000;

/** 环境变量名：与 shortcut.ps1 的约定保持一致。 */
const REQUEST_ENV = 'DSH_ICON_REQUEST';
const RESULT_ENV = 'DSH_ICON_RESULT';

/**
 * 把脚本正文编码为 `-EncodedCommand` 需要的 base64（UTF-16LE）。
 * @param {string} script - PowerShell 脚本正文。
 * @returns {string} base64 字符串。
 */
export function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 解析 PowerShell 可执行文件路径。
 *
 * 优先 `System32` 下的绝对路径：宿主进程的 PATH 未必包含 WindowsPowerShell 目录。
 * @returns {string} powershell.exe 路径。
 */
function powershellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (typeof systemRoot === 'string' && systemRoot !== '') {
    const absolute = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(absolute)) return absolute;
  }
  return 'powershell.exe';
}

/**
 * 执行一次快捷方式读/写。
 * @param {string} scriptText - shortcut.ps1 的内容。
 * @param {{ path: string, iconLocation?: string }[]} items - 待处理项。
 * @returns {{ ok: boolean, entries?: object[], error?: string }} 解析后的结果。
 */
export function runShortcutHelper(scriptText, items) {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-icon-'));
  const requestPath = join(workDir, 'request.json');
  const resultPath = join(workDir, 'result.json');
  try {
    writeFileSync(requestPath, JSON.stringify({ items }), 'utf8');
    const spawned = spawnSync(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodeCommand(scriptText),
      ],
      {
        env: { ...process.env, [REQUEST_ENV]: requestPath, [RESULT_ENV]: resultPath },
        stdio: 'ignore',
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
      },
    );

    if (!existsSync(resultPath)) {
      const reason =
        spawned.error?.message ??
        (spawned.status === null
          ? `PowerShell 未在 ${String(POWERSHELL_TIMEOUT_MS)} ms 内结束`
          : `PowerShell 退出码 ${String(spawned.status)}，未产出结果文件`);
      return { ok: false, entries: [], error: reason };
    }
    const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
    return { ok: parsed.ok === true, entries: parsed.entries ?? [], error: parsed.error };
  } catch (error) {
    return { ok: false, entries: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    // 结果已读入内存，临时目录必须删干净，避免每次调用都在 temp 留下残留。
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 读取快捷方式的当前状态（不写入）。
 * @param {string} scriptText - shortcut.ps1 的内容。
 * @param {string[]} paths - 待读取的 .lnk 路径。
 * @returns {{ path: string, exists: boolean, targetPath: string|null, iconLocation: string|null, error: string|null }[]}
 */
export function readShortcuts(scriptText, paths) {
  if (paths.length === 0) return [];
  const result = runShortcutHelper(
    scriptText,
    paths.map((path) => ({ path })),
  );
  return result.entries ?? [];
}

/**
 * 改写快捷方式的图标位置，并回读校验。
 *
 * 注意：`iconLocation` 必须是非空字符串。实测 `IconLocation = ''` 会被 COM 以
 * `ArgumentException` 拒绝，所以“还原”是把记录下来的原始值写回去，而不是清空。
 * @param {string} scriptText - shortcut.ps1 的内容。
 * @param {{ path: string, iconLocation: string }[]} items - 待写入项。
 * @returns {{ entries: object[], error?: string }} 写入结果。
 */
export function writeShortcutIcons(scriptText, items) {
  if (items.length === 0) return { entries: [] };
  return runShortcutHelper(scriptText, items);
}
