/**
 * 图标管理器的宿主侧数据接口 + 设置页区块的装载。
 *
 * ## 界面在哪
 *
 * 界面本体是**设置页里的一个区块**（设置 → 应用图标管理），由 `lib/client.js` 提供；
 * 该文件经 package.json 的 `dsh.client` 声明，由 **DSH 框架自动供给**到
 * `/plugins/dsh-plugin-app-icon-manager/client.js`，宿主侧无需自己注册脚本路由。
 * 参考实现：`dsh-disk-manager`（同一套 `window.__ModuleLoader__` + `slots` 契约）。
 *
 * 历史：早先版本是向索引页注入一个浮层脚本。已弃用，因为浮层要与别的挂件抢屏幕角落，
 * 而那些挂件会在 `document` 上注册**捕获阶段**监听（捕获先于冒泡），本插件在自身节点上
 * 做的隔离拦不住它们，表现为「点我的按钮却点到了下面的东西」。放进设置页没有这个冲突。
 *
 * ## 本文件负责什么
 *
 * 只注册同源 HTTP 数据端点，供设置页里的 React 组件读写：
 * `/state`、`/icon`、`/apply`、`/restore`。
 *
 * @module dsh-plugin-app-icon-manager/ui
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { describeIconFile } from './icon-file.js';

/** 路由前缀；本插件的所有 HTTP 端点都在其下。 */
const ROUTE_PREFIX = '/dsh-app-icon-manager';

/** 图标文件的 MIME 类型。 */
const ICON_MIME = Object.freeze({
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 可序列化的响应体。
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/**
 * 写一个文本响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {string} text - 响应正文。
 * @param {string} contentType - 内容类型。
 */
function sendText(res, status, text, contentType) {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

/** 普通请求体的上限（字节）。上传图片走单独的上限，见 `UPLOAD_BODY_LIMIT`。 */
const BODY_LIMIT = 64 * 1024;

/**
 * 上传请求体的上限（字节）。
 *
 * 图片以 base64 放在 JSON 里，体积约为原图的 4/3；宿主侧 `upload()` 还会再按
 * 解码后的真实字节数检查一次。这里留出 base64 膨胀的余量。
 */
const UPLOAD_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * 读取请求体并解析为 JSON。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @param {number} [limit] - 体积上限（字节）。
 * @returns {Promise<object | null>} 解析结果；解析失败或超限返回 null。
 */
function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // 超过上限直接断开，避免被撑爆内存。
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw === '' ? {} : JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * 拆出图标位置里的文件路径。
 * @param {string} location - `路径,索引` 形式。
 * @returns {string} 文件路径部分。
 */
function iconLocationFile(location) {
  const comma = location.lastIndexOf(',');
  if (comma === -1) return location;
  return Number.isInteger(Number.parseInt(location.slice(comma + 1), 10))
    ? location.slice(0, comma)
    : location;
}

/**
 * 汇总客户端渲染所需的全部数据。
 *
 * 判断“某个图标是否正在使用”的依据是**磁盘上的真实图标位置**（`shortcuts[].iconLocation`），
 * 而不是状态文件里的 `applied` 字段——后者只是记录，前者才是事实。
 * @param {object} appIcons - 图标管理器服务。
 * @returns {object} 可 JSON 序列化的界面数据。
 */
function readUiState(appIcons) {
  const described = appIcons.describe();
  // 快捷方式明细要现读磁盘，只能通过 `discover()` 拿到——它会 spawn PowerShell（约 2 秒）。
  // 本函数只由 `/state` 端点触发（用户打开面板时），不在插件激活路径上，因此安全。
  const live = appIcons.discover();
  const inUse = new Set(
    live.shortcuts
      .map((item) => iconLocationFile(item.iconLocation ?? ''))
      .filter((path) => path !== ''),
  );
  const recorded = appIcons.state().shortcuts;

  // 直接在宿主侧过滤掉非 .ico：浏览器根本收不到它们，比"发过去再隐藏"更彻底。
  // 判定与主入口共用同一套逻辑（扩展名 + 文件头魔数）——注意扩展名可能骗人，
  // 有的文件叫 .ico 但内容是 PNG，Explorer 会渲染成空白。
  const usable = [];
  const skipped = [];
  for (const icon of described.library.icons) {
    const verdict = describeIconFile(icon.file);
    if (verdict.usable) {
      usable.push({
        name: icon.name,
        bytes: icon.bytes,
        url: `${ROUTE_PREFIX}/icon?name=${encodeURIComponent(icon.name)}`,
        inUse: inUse.has(icon.file),
      });
    } else {
      skipped.push({ name: icon.name, extension: verdict.extension, reason: verdict.reason });
    }
  }

  return {
    libraryDir: appIcons.libraryDir(),
    /** 「重置回默认图标」会写入的值（DSH 启动器自带的图标）。 */
    defaultIcon: appIcons.defaultIcon(),
    icons: usable,
    /** 被跳过的非 .ico 文件；界面用它提示"有几个文件未显示"。 */
    skippedIcons: skipped,
    shortcuts: live.shortcuts.map((item) => ({
      path: item.path,
      name: item.path.split(/[\\/]/).pop() ?? item.path,
      iconLocation: item.iconLocation,
      original: recorded[item.path]?.original ?? null,
      /** 可回退的历史层数；> 0 时「重置回上次图标」才有意义。 */
      historyDepth: (recorded[item.path]?.history ?? []).length,
      /** 历史栈顶，供界面直接展示"上次是哪个图标"。 */
      previous: (recorded[item.path]?.history ?? []).slice(-1)[0] ?? null,
    })),
    discoverError: live.error,
    surfaces: described.surfaces,
  };
}

/**
 * 注册设置页所需的数据端点。
 *
 * 所有注册都通过 `ctx.effect` 绑定在本插件 fiber 上，停止或更新时自动撤销。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} appIcons - 已注册的图标管理器服务。
 */
export function installUi(ctx, appIcons) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    // 没有 Web 服务的组合（例如 headless）下没有界面可挂，插件其余功能照常工作。
    ctx.logger.info('app-icon-manager: 没有可用的 webServer 服务，跳过 Web 界面');
    return;
  }

  // 只注册数据端点。界面本体已改为**设置页区块**（`lib/client.js`，经 package.json 的
  // `dsh.client` 声明由 DSH 框架自动供给到 /plugins/<name>/client.js），不再向索引页
  // 注入浮层脚本。原因：浮层要和别的挂件抢屏幕角落，而它们会在 document 上注册捕获阶段
  // 监听（捕获先于冒泡），本插件在自身节点上做的隔离拦不住，表现为「点我的按钮却点到了
  // 下面的东西」。放进设置页就没有这个冲突。
  //
  // ⚠️ 前缀**不能带结尾斜杠**。webserver 的匹配规则是
  // `pathname !== prefix && !pathname.startsWith(prefix + '/')`，
  // 若 prefix 写成 `/dsh-app-icon-manager/`，就变成要求以 `//` 开头，永远匹配不上
  // （表现为所有端点稳定 404）。
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;

        // 供给图标文件本体，供浏览器预览。只接受图标库内的名字，不接受任意路径。
        if (pathname === `${ROUTE_PREFIX}/icon`) {
          const target = appIcons.resolve(url.searchParams.get('name') ?? '');
          if (target === undefined || !existsSync(target)) {
            sendText(res, 404, 'icon not found', 'text/plain; charset=utf-8');
            return;
          }
          const stat = statSync(target);
          res.writeHead(200, {
            'content-type': ICON_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
            'content-length': String(stat.size),
            'cache-control': 'no-store',
          });
          createReadStream(target).pipe(res);
          return;
        }

        if (pathname === `${ROUTE_PREFIX}/state`) {
          sendJson(res, 200, readUiState(appIcons));
          return;
        }

        if (pathname === `${ROUTE_PREFIX}/apply`) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, reason: 'apply 需要 POST' });
            return;
          }
          const body = await readJsonBody(req);
          if (body === null || typeof body.name !== 'string') {
            sendJson(res, 400, { ok: false, reason: '请求体需要 { name: string }' });
            return;
          }
          sendJson(res, 200, appIcons.apply(body.name));
          return;
        }

        // 上传图片：转成 .ico 后存入图标库
        if (pathname === `${ROUTE_PREFIX}/upload`) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, reason: 'upload 需要 POST' });
            return;
          }
          const body = await readJsonBody(req, UPLOAD_BODY_LIMIT);
          if (body === null) {
            sendJson(res, 413, { ok: false, reason: '请求体过大或不是合法 JSON' });
            return;
          }
          const result = appIcons.upload({
            data: body.data,
            fileName: body.fileName,
            name: body.name,
            overwrite: body.overwrite === true,
          });
          // 可选：上传后直接切换过去，省掉用户再点一次
          if (result.ok === true && body.apply === true) {
            const applied = appIcons.apply(result.icon.name);
            result.applied = applied.ok === true;
            if (applied.ok !== true) result.applyReason = applied.reason;
          }
          sendJson(res, result.ok === true ? 200 : 400, result);
          return;
        }

        // 重置回 DSH 启动器自带的图标（不依赖任何记录，随时可点）
        if (pathname === `${ROUTE_PREFIX}/reset-default`) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, reason: 'reset-default 需要 POST' });
            return;
          }
          sendJson(res, 200, appIcons.resetToDefault());
          return;
        }

        // 重置回上一次的图标（撤销最近一次变化）
        if (pathname === `${ROUTE_PREFIX}/reset-previous`) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, reason: 'reset-previous 需要 POST' });
            return;
          }
          sendJson(res, 200, appIcons.resetToPrevious());
          return;
        }

        sendJson(res, 404, { ok: false, reason: `未知端点: ${pathname}` });
      },
    }),
  );

  ctx.logger.info(
    `app-icon-manager: Web 界面已挂载在 ${ROUTE_PREFIX}/，页面右下角会出现「图标管理」按钮（刷新页面即可看到）`,
  );
}
