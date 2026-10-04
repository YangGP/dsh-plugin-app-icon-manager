/* DSH 应用图标管理器 —— Web 设置页。
 *
 * 装载方式（与 dsh-disk-manager 同款，是 DSH 第三方插件的标准做法）：
 * 以**经典脚本**注册到 `window.__ModuleLoader__`，工厂内用 `require('react')` 取 React。
 * 没有构建步骤，所以不能写 JSX，一律 `React.createElement`。
 *
 * 为什么不沿用原先的浮层方案：浮层要和别的挂件抢屏幕角落，而且那些挂件会在 document 上
 * 注册**捕获阶段**监听（捕获先于冒泡），本插件在自身节点上做的隔离拦不住它们，表现为
 * 「点我的按钮却点到了下面的东西」。放进设置页就没有这个冲突。
 *
 * 数据来自宿主已注册的同源 HTTP 端点（见 lib/ui.js）：
 *   GET  /dsh-app-icon-manager/state     图标库 + 快捷方式 + 默认图标
 *   POST /dsh-app-icon-manager/apply     切换图标
 *   POST /dsh-app-icon-manager/restore   重置图标（有记录回记录，无记录回默认）
 *   GET  /dsh-app-icon-manager/icon?name=<名字>   图标文件本体（预览用）
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-app-icon-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var API = '/dsh-app-icon-manager';
    var NS = 'settings.appIconManager';

    var zh = {
      nav: '应用图标管理',
      title: '应用图标管理',
      library: '图标库',
      libraryEmpty: '图标库里没有可用的图标。请把 .ico 文件放进插件目录的 icons/ 下。',
      skipped: '另有 {n} 个文件未显示（仅支持 .ico）：{names}',
      skippedHint: 'Explorer 不渲染 .png 等格式，选了会变成空白图标。',
      shortcuts: '快捷方式',
      noShortcuts: '没有找到指向 DSH 的快捷方式。',
      inUse: '使用中',
      resetDefault: '重置回客户端图标',
      resetDefaultTitle: '写回 DSH 客户端自带的图标（不依赖任何记录）',
      resetDefaultDone: '已写回客户端图标（{n} 个快捷方式）。',
      resetDefaultFail: '重置失败：',
      resetPrevious: '重置回上次图标',
      resetPreviousTitle: '撤销最近一次切换，回到上一次用的图标',
      resetPreviousDone: '已回到上次的图标（{n} 个快捷方式）。',
      resetPreviousSkipped: '其中 {n} 个没有可回退的历史，未改动。',
      resetPreviousFail: '重置失败：',
      noPrevious: '没有可回退的上一次图标',
      confirm: '确认图标',
      confirmHint: '重新读取磁盘上的实际状态并刷新本页',
      loading: '正在读取…',
      readFail: '读取状态失败：',
      applied: '已应用「{name}」到 {n} 个快捷方式。',
      applyFail: '切换失败：',
      previousLabel: '上次',
      note:
        '说明：切换会同时作用于所有指向 DSH 的快捷方式（桌面 / 开始菜单 / 任务栏）。' +
        '「重置回客户端图标」固定回到客户端自带图标，随时可点；' +
        '「重置回上次图标」撤销最近一次切换，可连续点击逐级回退。' +
        '窗口与任务栏图标由 Electron 在启动时固定，无法在运行时替换。',
      defaultIcon: '默认图标',
      upload: '上传图标',
      uploadPick: '选择图片，或把图片拖到这里',
      uploadHint: '支持 PNG / JPEG / GIF / BMP / WebP / TIFF，最大 10 MB。会自动转成多尺寸 .ico。',
      uploadClear: '重新选择',
      uploadName: '图标名',
      uploadNamePlaceholder: '留空则用文件名',
      uploadWillConvert: '将转成 .ico',
      uploadAddOnly: '只加入图标库',
      uploadAddOnlyHint: '入库后可在上方图标库里点击使用',
      uploadAndApply: '上传并应用',
      uploadAndApplyHint: '入库后立即切换到所有 DSH 快捷方式',
      uploadDone: '已加入图标库：「{name}」。',
      uploadDoneApplied: '已上传并应用「{name}」。',
      uploadFail: '上传失败：',
      uploadTooBig: '图片超过 10 MB 上限。',
      uploadReadFail: '读取文件失败，请重试。',
    };

    var en = {
      nav: 'App Icon Manager',
      title: 'App Icon Manager',
      library: 'Icon library',
      libraryEmpty: 'No usable icons. Put .ico files into the plugin icons/ directory.',
      skipped: '{n} more file(s) hidden (only .ico is supported): {names}',
      skippedHint: 'Explorer cannot render .png; picking one yields a blank icon.',
      shortcuts: 'Shortcuts',
      noShortcuts: 'No shortcuts pointing at DSH were found.',
      inUse: 'in use',
      resetDefault: 'Reset to client icon',
      resetDefaultTitle: 'Write back the icon bundled with the DSH client (needs no record)',
      resetDefaultDone: 'Wrote back the client icon ({n} shortcut(s)).',
      resetDefaultFail: 'Reset failed: ',
      resetPrevious: 'Reset to previous icon',
      resetPreviousTitle: 'Undo the most recent switch and go back to the previous icon',
      resetPreviousDone: 'Went back to the previous icon ({n} shortcut(s)).',
      resetPreviousSkipped: '{n} of them had no history to go back to and were left unchanged.',
      resetPreviousFail: 'Reset failed: ',
      noPrevious: 'No previous icon to go back to',
      confirm: 'Confirm',
      confirmHint: 'Re-read the actual state from disk and refresh this page',
      loading: 'Loading…',
      readFail: 'Failed to read state: ',
      applied: 'Applied "{name}" to {n} shortcut(s).',
      applyFail: 'Switch failed: ',
      previousLabel: 'previous',
      note:
        'Switching affects every shortcut pointing at DSH (desktop / Start Menu / taskbar). ' +
        '"Reset to client icon" always returns to the icon bundled with the client and can be ' +
        'used any time; "Reset to previous icon" undoes the latest switch and can be clicked ' +
        'repeatedly to step back. The window and taskbar icons are fixed by Electron at launch ' +
        'and cannot be replaced at runtime.',
      defaultIcon: 'Default icon',
      upload: 'Upload icon',
      uploadPick: 'Choose an image, or drop one here',
      uploadHint: 'PNG / JPEG / GIF / BMP / WebP / TIFF, up to 10 MB. Converted to a multi-size .ico.',
      uploadClear: 'Choose another',
      uploadName: 'Icon name',
      uploadNamePlaceholder: 'Defaults to the file name',
      uploadWillConvert: 'will become .ico',
      uploadAddOnly: 'Add to library',
      uploadAddOnlyHint: 'Added to the library; click it above to use it',
      uploadAndApply: 'Upload and apply',
      uploadAndApplyHint: 'Add to the library and switch every DSH shortcut to it',
      uploadDone: 'Added "{name}" to the library.',
      uploadDoneApplied: 'Uploaded and applied "{name}".',
      uploadFail: 'Upload failed: ',
      uploadTooBig: 'Image exceeds the 10 MB limit.',
      uploadReadFail: 'Could not read the file, please retry.',
    };

    var STYLES = [
      '.aim-wrap{max-width:720px;display:flex;flex-direction:column;gap:16px;',
      'color:var(--dsw-alias-label-primary)}',
      '.aim-group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.aim-group h3{margin:0 0 10px;font-size:13px;font-weight:600}',
      '.aim-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.aim-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.aim-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px}',
      '.aim-card{display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 6px;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer;',
      'transition:border-color .15s,background .15s}',
      '.aim-card:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
      '.aim-card:disabled{opacity:.5;cursor:default}',
      '.aim-card[data-active="1"]{border-color:var(--dsw-alias-state-business-primary);',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.aim-card img{width:40px;height:40px;object-fit:contain}',
      '.aim-name{font-size:11px;text-align:center;word-break:break-all;line-height:1.3}',
      '.aim-badge{font-size:10px;font-weight:700;',
      'color:var(--dsw-alias-state-business-primary)}',
      '.aim-list{display:flex;flex-direction:column;gap:8px}',
      '.aim-row{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);font-size:12px}',
      '.aim-row b{font-weight:600}',
      '.aim-row span{word-break:break-all;color:var(--dsw-alias-label-tertiary)}',
      '.aim-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.aim-btn{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'border-radius:6px;font:inherit;font-size:13px;cursor:pointer;',
      'display:inline-flex;align-items:center;justify-content:center;gap:6px}',
      '.aim-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
      '.aim-btn:disabled{opacity:.5;cursor:default}',
      '.aim-btn.primary{background:var(--dsw-alias-state-business-primary);',
      'border-color:var(--dsw-alias-state-business-primary);color:#fff}',
      '.aim-msg{font-size:12px;line-height:1.6;white-space:pre-wrap;min-height:18px}',
      '.aim-msg[data-kind="ok"]{color:var(--dsw-alias-state-business-primary)}',
      '.aim-msg[data-kind="err"]{color:#e05555}',
      '.aim-kv{font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.aim-upload{display:flex;flex-direction:column;gap:10px}',
      '.aim-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;',
      'padding:18px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);',
      'font-size:12px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s}',
      '.aim-drop:hover,.aim-drop[data-over="1"]{border-color:var(--dsw-alias-state-business-primary);',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.aim-drop b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.aim-field{display:flex;align-items:center;gap:8px;font-size:12px}',
      '.aim-field input[type="text"]{flex:1;height:30px;padding:0 10px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.aim-file{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.aim-preview{display:flex;align-items:center;gap:12px}',
      '.aim-preview img{width:48px;height:48px;object-fit:contain;border-radius:6px;',
      'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2)}',
    ].join('');

    /** 同源 HTTP 封装；非 2xx 或 ok:false 一律抛错，避免"假成功"。 */
    function api(path, options) {
      return fetch(API + path, options).then((response) =>
        response.json().then((body) => {
          if (!response.ok) throw new Error((body && body.reason) || 'HTTP ' + response.status);
          if (body && body.ok === false) throw new Error(body.reason || 'failed');
          return body;
        }),
      );
    }

    /**
     * 设置页主体。
     * 注册时通过 `inject` 把 `t`（本地化函数）传进来——组件本身拿不到插件闭包，
     * 这是 slots.register 约定的注入方式。
     */
    function IconSection(props) {
      var t = props.t || function (key) { return key; };
      var state = useState(null);
      var data = state[0];
      var setData = state[1];

      var loadState = useState(false);
      var loading = loadState[0];
      var setLoading = loadState[1];

      var msgState = useState({ text: '', kind: 'ok' });
      var msg = msgState[0];
      var setMsg = msgState[1];

      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      function reload() {
        setLoading(true);
        return api('/state')
          .then((next) => {
            setData(next);
            return next;
          })
          .catch((error) => {
            setMsg({ text: (data ? '' : '') + error.message, kind: 'err' });
            throw error;
          })
          .finally(() => setLoading(false));
      }

      useEffect(() => {
        var alive = true;
        setLoading(true);
        api('/state')
          .then((next) => {
            if (alive) setData(next);
          })
          .catch((error) => {
            if (alive) setMsg({ text: error.message, kind: 'err' });
          })
          .finally(() => {
            if (alive) setLoading(false);
          });
        return () => {
          alive = false;
        };
      }, []);

      /** 统一的后置处理：跑一个写操作，成功后重载状态并提示。 */
      function run(path, body, okText, failPrefix) {
        if (busy) return;
        setBusy(true);
        setMsg({ text: '', kind: 'ok' });
        api(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
          .then((result) => {
            setMsg({ text: okText(result), kind: 'ok' });
            return reload();
          })
          .catch((error) => {
            setMsg({ text: failPrefix + error.message, kind: 'err' });
          })
          .finally(() => setBusy(false));
      }

      // ---- 上传 ----
      // 文件选择、拖放、以及"上传后立即应用"都走同一个入口。
      // 图片在宿主侧被转成 .ico 再入库（IconLocation 只认 .ico，直接放 PNG 会显示空白）。
      var pickState = useState(null);
      var picked = pickState[0];
      var setPicked = pickState[1];

      var nameState = useState('');
      var uploadName = nameState[0];
      var setUploadName = nameState[1];

      var overState = useState(false);
      var dragOver = overState[0];
      var setDragOver = overState[1];

      var fileInput = React.useRef(null);

      /** 从文件名推导一个默认图标名（去扩展名）。 */
      function deriveName(fileName) {
        return String(fileName || '').replace(/\.[^.]+$/u, '');
      }

      /** 接收一个图片文件：读成 base64 并记下来，等用户确认。 */
      function acceptFile(file) {
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          setMsg({ text: t('uploadTooBig'), kind: 'err' });
          return;
        }
        setMsg({ text: '', kind: 'ok' });
        var reader = new FileReader();
        reader.onload = function () {
          setPicked({ name: file.name, size: file.size, data: String(reader.result || '') });
          setUploadName(deriveName(file.name));
        };
        reader.onerror = function () {
          setMsg({ text: t('uploadReadFail'), kind: 'err' });
        };
        reader.readAsDataURL(file);
      }

      /** 把选中的图片交给宿主转换并入库。 */
      function submitUpload(applyNow) {
        if (!picked || busy) return;
        setBusy(true);
        setMsg({ text: '', kind: 'ok' });
        api('/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            data: picked.data,
            fileName: picked.name,
            name: uploadName,
            apply: applyNow === true,
          }),
        })
          .then((result) => {
            var added = result.icon.name;
            setPicked(null);
            setUploadName('');
            if (fileInput.current) fileInput.current.value = '';
            setMsg({
              text: (applyNow === true && result.applied === true
                ? t('uploadDoneApplied')
                : t('uploadDone')
              ).replace('{name}', added),
              kind: 'ok',
            });
            return reload();
          })
          .catch((error) => {
            setMsg({ text: t('uploadFail') + error.message, kind: 'err' });
          })
          .finally(() => setBusy(false));
      }

      if (!data) {
        return h('div', { className: 'aim-wrap' }, [
          h('div', { className: 'aim-msg', 'data-kind': msg.kind }, loading ? t('loading') : msg.text),
        ]);
      }

      var icons = data.icons || [];
      var skipped = data.skippedIcons || [];
      var shortcuts = data.shortcuts || [];
      // 「重置回上次图标」只在真有可回退的历史时可用（历史层数由宿主下发）。
      // 注意不能用 original 是否存在来判断：original 一直存在，但当前值已等于它时无路可退。
      var canGoBack = shortcuts.some((s) => (s.historyDepth || 0) > 0);
      // 取任一条快捷方式的历史栈顶作为提示，展示"上次是哪个图标"。
      var previousLabel = (shortcuts.find((s) => s.previous) || {}).previous || '';

      return h('div', { className: 'aim-wrap' }, [
        // ---- 图标库 ----
        h('div', { className: 'aim-group', key: 'lib' }, [
          h('h3', null, t('library') + '（' + icons.length + '）'),
          icons.length === 0
            ? h('div', { className: 'aim-hint' }, t('libraryEmpty'))
            : h(
                'div',
                { className: 'aim-grid' },
                icons.map((icon) =>
                  h(
                    'button',
                    {
                      key: icon.name,
                      className: 'aim-card',
                      type: 'button',
                      'data-active': icon.inUse ? '1' : '0',
                      disabled: busy,
                      title: icon.name + '  (' + Math.round(icon.bytes / 1024) + ' KB)',
                      onClick: () =>
                        run(
                          '/apply',
                          { name: icon.name },
                          (r) => t('applied').replace('{name}', icon.name).replace('{n}', r.applied.length),
                          t('applyFail'),
                        ),
                    },
                    [
                      h('img', { key: 'img', src: icon.url, alt: icon.name }),
                      h('div', { key: 'name', className: 'aim-name' }, icon.name),
                      icon.inUse ? h('div', { key: 'badge', className: 'aim-badge' }, t('inUse')) : null,
                    ],
                  ),
                ),
              ),
          skipped.length
            ? h(
                'div',
                { className: 'aim-hint', style: { marginTop: 10 } },
                t('skipped')
                  .replace('{n}', skipped.length)
                  .replace(
                    '{names}',
                    skipped
                      .slice(0, 6)
                      .map((s) => s.name + (s.extension || ''))
                      .join('、'),
                  ) +
                  (skipped.length > 6 ? ' …' : '') +
                  ' ' +
                  t('skippedHint'),
              )
            : null,
        ]),

        // ---- 快捷方式 ----
        h('div', { className: 'aim-group', key: 'sc' }, [
          h('h3', null, t('shortcuts') + '（' + shortcuts.length + '）'),
          shortcuts.length === 0
            ? h('div', { className: 'aim-hint' }, t('noShortcuts'))
            : h(
                'div',
                { className: 'aim-list' },
                shortcuts.map((item) =>
                  h('div', { className: 'aim-row', key: item.path }, [
                    h('b', { key: 'n' }, item.name),
                    h('span', { key: 'i' }, item.iconLocation || '(未知)'),
                    item.original ? h('span', { key: 'o' }, '原始：' + item.original) : null,
                  ]),
                ),
              ),
          data.defaultIcon
            ? h('div', { className: 'aim-kv', style: { marginTop: 10 } }, t('defaultIcon') + '：' + data.defaultIcon)
            : null,
        ]),

        // ---- 上传 ----
        // 用户上传的多半是 PNG/JPG，而 IconLocation 只认 .ico（直接放 PNG 会显示空白），
        // 所以这里先交给宿主转换，再作为图标入库。
        h('div', { className: 'aim-group', key: 'up' }, [
          h('h3', null, t('upload')),
          h('div', { className: 'aim-upload' }, [
            h(
              'div',
              {
                key: 'drop',
                className: 'aim-drop',
                'data-over': dragOver ? '1' : '0',
                onClick: () => {
                  if (fileInput.current) fileInput.current.click();
                },
                onDragOver: (event) => {
                  event.preventDefault();
                  setDragOver(true);
                },
                onDragLeave: () => setDragOver(false),
                onDrop: (event) => {
                  event.preventDefault();
                  setDragOver(false);
                  var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
                  acceptFile(file);
                },
              },
              [
                h('b', { key: 'b' }, t('uploadPick')),
                h('span', { key: 's' }, t('uploadHint')),
              ],
            ),
            h('input', {
              key: 'input',
              ref: fileInput,
              type: 'file',
              accept: 'image/*',
              style: { display: 'none' },
              onChange: (event) => acceptFile(event.target.files && event.target.files[0]),
            }),
            picked
              ? h('div', { key: 'picked', className: 'aim-preview' }, [
                  h('img', { key: 'img', src: picked.data, alt: picked.name }),
                  h('div', { key: 'meta', style: { flex: 1, minWidth: 0 } }, [
                    h('div', { key: 'f', className: 'aim-file' }, picked.name),
                    h(
                      'div',
                      { key: 'sz', className: 'aim-file' },
                      Math.round(picked.size / 1024) + ' KB → ' + t('uploadWillConvert'),
                    ),
                  ]),
                  h(
                    'button',
                    {
                      key: 'clr',
                      className: 'aim-btn',
                      type: 'button',
                      disabled: busy,
                      onClick: () => {
                        setPicked(null);
                        setUploadName('');
                        if (fileInput.current) fileInput.current.value = '';
                      },
                    },
                    t('uploadClear'),
                  ),
                ])
              : null,
            picked
              ? h('label', { key: 'name', className: 'aim-field' }, [
                  h('span', { key: 'l' }, t('uploadName')),
                  h('input', {
                    key: 'i',
                    type: 'text',
                    value: uploadName,
                    placeholder: t('uploadNamePlaceholder'),
                    onChange: (event) => setUploadName(event.target.value),
                  }),
                ])
              : null,
            picked
              ? h('div', { key: 'go', className: 'aim-actions' }, [
                  h(
                    'button',
                    {
                      key: 'add',
                      className: 'aim-btn',
                      type: 'button',
                      disabled: busy,
                      title: t('uploadAddOnlyHint'),
                      onClick: () => submitUpload(false),
                    },
                    t('uploadAddOnly'),
                  ),
                  h(
                    'button',
                    {
                      key: 'apply',
                      className: 'aim-btn primary',
                      type: 'button',
                      disabled: busy,
                      title: t('uploadAndApplyHint'),
                      onClick: () => submitUpload(true),
                    },
                    t('uploadAndApply'),
                  ),
                ])
              : null,
          ]),
        ]),

        // ---- 操作 ----
        // 两个**不同目标**的重置，各自独立：
        //   「重置回客户端图标」= 固定写 DSH 启动器自带的图标，不依赖记录，随时可点；
        //   「重置回上次图标」  = 撤销最近一次变化，历史为空时置灰。
        h('div', { className: 'aim-actions', key: 'act' }, [
          h(
            'button',
            {
              key: 'resetDefault',
              className: 'aim-btn primary',
              type: 'button',
              disabled: busy,
              title: t('resetDefaultTitle') + (data.defaultIcon ? '\n' + data.defaultIcon : ''),
              onClick: () =>
                run(
                  '/reset-default',
                  undefined,
                  (r) => t('resetDefaultDone').replace('{n}', r.applied.length),
                  t('resetDefaultFail'),
                ),
            },
            t('resetDefault'),
          ),
          h(
            'button',
            {
              key: 'resetPrevious',
              className: 'aim-btn',
              type: 'button',
              disabled: busy || !canGoBack,
              title: canGoBack ? t('resetPreviousTitle') + (previousLabel ? '\n' + previousLabel : '') : t('noPrevious'),
              onClick: () =>
                run(
                  '/reset-previous',
                  undefined,
                  (r) =>
                    t('resetPreviousDone').replace('{n}', r.restored.length) +
                    (r.skipped && r.skipped.length
                      ? ' ' + t('resetPreviousSkipped').replace('{n}', r.skipped.length)
                      : ''),
                  t('resetPreviousFail'),
                ),
            },
            t('resetPrevious'),
          ),
          h(
            'button',
            {
              key: 'confirm',
              className: 'aim-btn',
              type: 'button',
              disabled: busy || loading,
              title: t('confirmHint'),
              onClick: () => {
                setMsg({ text: '', kind: 'ok' });
                reload().catch((error) => setMsg({ text: t('readFail') + error.message, kind: 'err' }));
              },
            },
            t('confirm'),
          ),
        ]),

        h('div', { className: 'aim-msg', key: 'msg', 'data-kind': msg.kind }, msg.text),
        h('div', { className: 'aim-note', key: 'note' }, t('note')),
      ]);
    }

    function apply(ctx) {
      ctx.effect(
        () => {
          var tag = document.createElement('style');
          tag.setAttribute('data-plugin', 'dsh-plugin-app-icon-manager');
          tag.textContent = STYLES;
          document.head.appendChild(tag);
          return () => {
            if (tag.parentNode) tag.parentNode.removeChild(tag);
          };
        },
        'app-icon-manager: styles',
      );

      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'app-icon-manager: dictionaries');
      var t = ctx.locale.bind(NS);

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-plugin-app-icon-manager',
            order: 215,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t: t }),
          },
          IconSection,
        ),
      );
    }

    module.exports = {
      name: 'dsh-plugin-app-icon-manager',
      inject: ['slots', 'locale'],
      apply: apply,
    };
    return module.exports;
  },
});
