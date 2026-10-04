/**
 * 图标文件的格式判定 —— 由扩展名**和文件头魔数**共同决定。
 *
 * ## 为什么需要读魔数
 *
 * 实测踩过的真实坑：一个文件扩展名是 `.ico`，但内容其实是 PNG（自动化脚本复制时原样保留了
 * 源扩展名）。COM 接受它、回读也成功，但 Explorer 渲染成**空白图标**。只看扩展名会把这种
 * 文件判为可用，于是用户点一下就得到白图标。
 *
 * 判定规则：
 * - `.exe` / `.dll` —— 合法的"程序自带图标"引用（`IconLocation` 可指向可执行文件）；
 * - `.ico` 且文件头为 `00 00 01 00` —— 唯一能被 Explorer 渲染的图片格式；
 * - 其余一律不可用。**`.png` 是最容易踩的坑**：COM 接受、回读成功、显示空白。
 *
 * @module dsh-plugin-app-icon-manager/icon-file
 */

import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';

/** 可作为图标来源的可执行文件类型。 */
const EXECUTABLE_EXTENSIONS = Object.freeze(['.exe', '.dll']);

/**
 * 判断一个文件是否真的是 ICO（校验文件头，而不只看扩展名）。
 *
 * ICO 头 4 字节为 `00 00 01 00`（reserved=0, type=1）。
 * @param {string} path - 文件路径。
 * @returns {boolean} 是否为真正的 ICO。
 */
export function isRealIco(path) {
  try {
    const header = Buffer.alloc(4);
    const fd = openSync(path, 'r');
    try {
      if (readSync(fd, header, 0, 4, 0) < 4) return false;
    } finally {
      closeSync(fd);
    }
    return header[0] === 0x00 && header[1] === 0x00 && header[2] === 0x01 && header[3] === 0x00;
  } catch {
    return false;
  }
}

/**
 * 判定一个图标文件能否被 Explorer 正确渲染。
 * @param {string} path - 图标文件的绝对路径。
 * @returns {{ usable: boolean, extension: string, reason: string | null }} 判定结果。
 */
export function describeIconFile(path) {
  const extension = extname(path).toLowerCase();
  if (EXECUTABLE_EXTENSIONS.includes(extension)) {
    return { usable: true, extension, reason: null };
  }
  if (extension !== '.ico') {
    return {
      usable: false,
      extension,
      reason:
        `Explorer 只渲染 .ico 图标；${extension || '(无扩展名)'} 会被 COM 接受并回读成功，` +
        '但显示为空白图标。',
    };
  }
  if (!existsSync(path)) {
    return { usable: false, extension, reason: `图标文件不存在: ${path}` };
  }
  if (!isRealIco(path)) {
    return {
      usable: false,
      extension,
      reason: '扩展名是 .ico，但文件内容不是 ICO（可能是改了名的 PNG），Explorer 会显示为空白。',
    };
  }
  return { usable: true, extension, reason: null };
}
