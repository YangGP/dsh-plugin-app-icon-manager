#!/usr/bin/env node
/**
 * DSH 应用图标管理器 —— 命令行入口。
 *
 * 插件本身没有界面：它注册的是 Cordis 服务 `appIcons`，只能被代码调用。本文件让你
 * 直接从终端完成「查看 / 切换 / 还原」，不需要写任何插件代码。
 *
 * 用法：
 *   node lib/cli.mjs list                 列出图标库
 *   node lib/cli.mjs shortcuts            列出指向 DSH 的快捷方式及当前图标
 *   node lib/cli.mjs set <图标名>          切换图标（会先记录原始值）
 *   node lib/cli.mjs set <图标名> --yes    跳过确认
 *   node lib/cli.mjs restore              还原到原始图标
 *   node lib/cli.mjs restore --yes        跳过确认
 *   node lib/cli.mjs doctor               诊断（表面可管理性、状态文件）
 *   node lib/cli.mjs help                 显示帮助
 *
 * 说明：本文件是**独立**运行的——它加载 lib/index.js 得到服务实现，不依赖 DSH 是否
 * 正在运行。但 DSH 若要自己调用该服务，仍需重启后才会加载最新代码。
 *
 * @module dsh-plugin-app-icon-manager/cli
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { apply as applyPlugin, name as pluginName } from './index.js';

/** @returns {object} 装载插件后得到的 `appIcons` 服务。 */
function loadService() {
  let service;
  const ctx = {
    provide: (_serviceName, value) => {
      service = value;
      return () => {};
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  applyPlugin(ctx, {});
  if (service === undefined) throw new Error('插件未注册 appIcons 服务');
  return service;
}

/**
 * 打印带缩进的多行文本。
 * @param {string} label - 标签。
 * @param {string} value - 内容。
 */
function line(label, value) {
  stdout.write(`${label}${value}\n`);
}

/**
 * 在动磁盘前征求确认；非交互环境（无 TTY）默认取消，避免脚本里误改。
 * @param {string} question - 提示语。
 * @returns {Promise<boolean>} 是否继续。
 */
async function confirm(question) {
  if (!stdin.isTTY) {
    stdout.write('当前不是交互终端，未确认即取消。加 --yes 可跳过确认。\n');
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** 列出图标库。 */
function cmdList(service) {
  const icons = service.library();
  line('图标库目录: ', service.libraryDir());
  if (icons.length === 0) {
    stdout.write('（空）把 .ico/.png/.jpg/.jpeg/.webp 放进该目录即可被识别\n');
    return;
  }
  stdout.write(`共 ${String(icons.length)} 个：\n`);
  for (const icon of icons) {
    stdout.write(`  ${icon.name.padEnd(20)} ${String(icon.bytes).padStart(9)} B  ${icon.file}\n`);
  }
}

/** 列出指向 DSH 的快捷方式。 */
function cmdShortcuts(service) {
  const { shortcuts, error } = service.shortcuts();
  if (error !== null) {
    stdout.write(`发现过程出错: ${error}\n`);
    return;
  }
  if (shortcuts.length === 0) {
    stdout.write('没有找到指向 DSH 的快捷方式。\n');
    return;
  }
  const state = service.state().shortcuts;
  const defaultIcon = service.defaultIcon();
  stdout.write(`共 ${String(shortcuts.length)} 个：\n`);
  for (const item of shortcuts) {
    stdout.write(`  ${item.path}\n`);
    stdout.write(`      当前图标     ${item.iconLocation ?? '(未知)'}\n`);
    const record = state[item.path];
    if (record?.original) {
      stdout.write(`      最初图标     ${record.original}\n`);
    }
    const stack = record?.history ?? [];
    stdout.write(
      stack.length > 0
        ? `      上次图标     ${stack[stack.length - 1]}   （可回退 ${String(stack.length)} 层）\n`
        : '      上次图标     （无可回退历史）\n',
    );
  }
  stdout.write(`\n重置目标：客户端自带 = ${defaultIcon}\n`);
}

/**
 * 把一个图片文件转成 `.ico` 加入图标库（与设置页的上传功能等价）。
 *
 * 命令行也能用，方便批量导入：`node lib/cli.mjs add <图片路径> [图标名]`
 */
async function cmdAdd(service, filePath, name, skipConfirm) {
  if (filePath === undefined || filePath === '') {
    stdout.write('用法: node lib/cli.mjs add <图片路径> [图标名]\n');
    stdout.write('支持 PNG / JPEG / GIF / BMP / WebP / TIFF，最大 10 MB，会转成多尺寸 .ico。\n');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(filePath)) {
    stdout.write(`文件不存在: ${filePath}\n`);
    process.exitCode = 2;
    return;
  }

  const stat = statSync(filePath);
  stdout.write(`将把以下文件转成 .ico 并加入图标库：\n`);
  stdout.write(`  ${filePath}  (${String(Math.round(stat.size / 1024))} KB)\n`);
  if (name !== undefined && name !== '') stdout.write(`  图标名: ${name}\n`);

  if (!skipConfirm && !(await confirm('\n确认加入？'))) {
    stdout.write('已取消，未做任何改动。\n');
    return;
  }

  const result = service.upload({
    data: readFileSync(filePath).toString('base64'),
    fileName: basename(filePath),
    name,
  });
  if (result.ok !== true) {
    stdout.write(`\n加入失败: ${result.reason ?? '未知原因'}\n`);
    process.exitCode = 1;
    return;
  }
  const icon = result.icon;
  stdout.write(`\n已加入图标库：\n`);
  stdout.write(`  图标名    ${icon.name}\n`);
  stdout.write(`  文件      ${icon.file}\n`);
  stdout.write(`  大小      ${String(icon.bytes)} B\n`);
  stdout.write(
    `  源图      ${icon.source.format} ${String(icon.source.width)}x${String(icon.source.height)}\n`,
  );
  stdout.write(`  内含尺寸  ${icon.sizes.join(' / ')}\n`);
  stdout.write(`\n用 node lib/cli.mjs set ${icon.name} 即可应用。\n`);
}

/** 切换图标。 */
async function cmdSet(service, iconName, skipConfirm) {  if (iconName === undefined || iconName === '') {
    stdout.write('用法: node lib/cli.mjs set <图标名>\n先运行 list 查看可用图标名。\n');
    process.exitCode = 2;
    return;
  }
  const resolved = service.resolve(iconName);
  if (resolved === undefined) {
    stdout.write(`图标库里没有「${iconName}」。\n先运行 list 查看可用图标名。\n`);
    process.exitCode = 2;
    return;
  }
  const { shortcuts } = service.shortcuts();
  stdout.write(`将把 ${String(shortcuts.length)} 个快捷方式的图标设为:\n  ${resolved}\n\n`);
  for (const item of shortcuts) stdout.write(`  ${item.path}\n`);
  stdout.write('\n若首次切换，这些快捷方式的当前图标会被记录为原始值，供 restore 还原。\n');

  if (!skipConfirm && !(await confirm('确认切换？'))) {
    stdout.write('已取消，未做任何改动。\n');
    return;
  }

  const result = service.apply(iconName);
  if (result.ok !== true) {
    stdout.write(`失败: ${result.reason ?? '未知原因'}\n`);
    process.exitCode = 1;
    return;
  }
  stdout.write(`\n已切换 ${String(result.applied?.length ?? 0)} 个：\n`);
  for (const item of result.applied ?? []) {
    stdout.write(`  ${item.changed ? '已更新' : '无需改动'}  ${item.path}\n`);
  }
  if ((result.recordedOriginals?.length ?? 0) > 0) {
    stdout.write('\n已记录原始图标:\n');
    for (const item of result.recordedOriginals ?? []) {
      stdout.write(`  ${item.original}   ← ${item.path}\n`);
    }
  }
}

/**
 * 重置回**客户端自带**的图标。
 *
 * 与 `cmdResetPrevious` 是两个不同的目标：本命令固定写 DSH 启动器自带的图标，
 * 不依赖任何记录，任何时刻都能执行。
 */
async function cmdResetDefault(service, skipConfirm) {
  const { shortcuts } = service.shortcuts();
  const defaultIcon = service.defaultIcon();
  if (shortcuts.length === 0) {
    stdout.write('没有找到指向 DSH 的快捷方式。\n');
    return;
  }

  stdout.write(`将把 ${String(shortcuts.length)} 个快捷方式写回客户端自带图标：\n  ${defaultIcon}\n`);
  for (const item of shortcuts) stdout.write(`  ${item.path}\n`);

  if (!skipConfirm && !(await confirm('\n确认重置？'))) {
    stdout.write('已取消，未做任何改动。\n');
    return;
  }

  const result = service.resetToDefault();
  stdout.write('\n');
  for (const item of result.applied ?? []) {
    stdout.write(`  ${item.changed ? '已重置' : '无需改动'}  ${item.path}\n`);
  }
  if (result.ok === true) stdout.write('\n重置完成。\n');
  else process.exitCode = fail(result);
}

/**
 * 重置回**上一次**的图标（撤销最近一次切换）。
 *
 * 目标值是各自的历史栈顶；在旧记录上会向后兼容地回到最初的图标。
 */
async function cmdResetPrevious(service, skipConfirm) {
  const { shortcuts } = service.shortcuts();
  const state = service.state().shortcuts;
  if (shortcuts.length === 0) {
    stdout.write('没有找到指向 DSH 的快捷方式。\n');
    return;
  }

  const backable = shortcuts.filter((s) => (state[s.path]?.history ?? []).length > 0);
  if (backable.length === 0) {
    stdout.write('没有可回退的上一次图标（当前已是记录的初始状态）。\n');
    return;
  }

  stdout.write(`将回退 ${String(backable.length)} 个快捷方式：\n`);
  for (const item of backable) {
    const stack = state[item.path].history;
    stdout.write(`  ${item.path}\n      → ${stack[stack.length - 1]}\n`);
  }

  if (!skipConfirm && !(await confirm('\n确认回退？'))) {
    stdout.write('已取消，未做任何改动。\n');
    return;
  }

  const result = service.resetToPrevious();
  stdout.write('\n');
  for (const item of result.restored ?? []) {
    stdout.write(`  ${item.changed ? '已回退' : '无需改动'}  ${item.path}\n`);
  }
  for (const item of result.skipped ?? []) {
    stdout.write(`  已跳过  ${item.path}（无可回退历史）\n`);
  }
  if (result.ok === true) stdout.write('\n回退完成。\n');
  else process.exitCode = fail(result);
}

/** 写操作的统一失败收尾。 */
function fail(result) {
  stdout.write(`\n未全部完成: ${result.reason ?? '有写入失败的项目'}\n`);
  return 1;
}

/** 诊断。 */
function cmdDoctor(service) {
  const described = service.describe();
  // 明细要现读磁盘，只能通过 discover() 拿——CLI 是用户主动触发的，可以承担这次 PowerShell 调用。
  const live = service.discover();
  line('插件            ', `${described.plugin}  (${pluginName})`);
  line('平台            ', described.platform);
  line('插件根目录      ', described.packageRoot);
  line('DSH 启动器      ', described.dshExecutable);
  line('图标库          ', `${described.library.dir}  共 ${String(described.library.count)} 个`);
  line(
    '快捷方式        ',
    `${String(live.shortcuts.length)} 个指向 DSH（发现错误: ${String(live.error)}）；已记录待还原 ${String(described.shortcuts.count)} 个`,
  );
  line('状态文件        ', service.stateFile());
  stdout.write('\n图标表面可管理性:\n');
  for (const [key, value] of Object.entries(described.surfaces)) {
    const flags = [value.manageable ? '可管理' : '不可管理'];
    if ('implemented' in value) flags.push(value.implemented ? '已实现' : '未实现');
    stdout.write(`  ${key.padEnd(20)} ${flags.join(' / ')}`);
    if (value.reason !== undefined) stdout.write(`  —— ${value.reason}`);
    stdout.write('\n');
  }
}

const HELP = `DSH 应用图标管理器 —— 命令行

  node lib/cli.mjs list                列出图标库
  node lib/cli.mjs shortcuts           列出指向 DSH 的快捷方式及当前图标
  node lib/cli.mjs add <图片> [名字]    上传图片，转成 .ico 加入图标库
  node lib/cli.mjs set <图标名>         切换图标（会记录历史以便回退）
  node lib/cli.mjs reset-default       重置回客户端自带图标（随时可用）
  node lib/cli.mjs reset-previous      重置回上一次的图标（撤销最近一次切换）
  node lib/cli.mjs doctor              诊断
  node lib/cli.mjs help                显示本帮助

  加 --yes 可跳过确认（用于脚本）。

注意: 切换会同时作用于所有指向 DSH 的快捷方式（桌面 / 开始菜单 / 任务栏）。
`;

const [command = 'help', ...rest] = process.argv.slice(2);
const skipConfirm = rest.includes('--yes');
const positional = rest.filter((argument) => !argument.startsWith('--'));

try {
  const service = loadService();
  switch (command) {
    case 'list':
      cmdList(service);
      break;
    case 'shortcuts':
      cmdShortcuts(service);
      break;
    case 'add':
      await cmdAdd(service, positional[0], positional[1], skipConfirm);
      break;
    case 'set':
      await cmdSet(service, positional[0], skipConfirm);
      break;
    case 'reset-default':
      await cmdResetDefault(service, skipConfirm);
      break;
    case 'reset-previous':
      await cmdResetPrevious(service, skipConfirm);
      break;
    case 'doctor':
      cmdDoctor(service);
      break;
    case 'help':
    case '--help':
    case '-h':
      stdout.write(HELP);
      break;
    default:
      stdout.write(`未知命令: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
} catch (error) {
  stdout.write(`执行出错: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
