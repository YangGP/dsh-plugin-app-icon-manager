/**
 * lib/client.js（设置页 bundle）的装载测试。
 *
 * 这个文件没有构建步骤，是给浏览器 `window.__ModuleLoader__` 用的经典脚本，
 * 所以在 Node 里直接 import 会因为没有 `window` 而抛错。本测试提供最小装载器，
 * 验证的是**真实装载协议**：脚本能否注册、工厂能否取到 React、返回的插件对象是否
 * 声明了正确的 `inject`、`apply` 能否完成 slot 注册。
 *
 * React 用一个只够创建元素树的极简替身——本测试关心的是装载与注册，不是渲染效果。
 *
 * @module test-client-bundle
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./lib/client.js', import.meta.url));
const source = readFileSync(scriptPath, 'utf8');

let failures = 0;
function check(ok, label) {
  console.log((ok ? '  OK   ' : '  FAIL ') + label);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// 极简 React 替身：createElement 只记录类型与 props
// ---------------------------------------------------------------------------
function createElement(type, props, ...children) {
  return { $$typeof: 'react.element', type, props: { ...(props ?? {}), children: children.flat() } };
}

const reactShim = {
  createElement,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  // useRef 需要一个**可变**的 current：组件用它在 onChange/onClick 里读回 <input type="file">。
  // 返回固定对象即可满足装载与首次渲染测试。
  useRef: (init) => ({ current: init === undefined ? null : init }),
};

// ---------------------------------------------------------------------------
// document 垫片：apply() 会往 head 注入一个 <style>
// ---------------------------------------------------------------------------
const headChildren = [];
const document = {
  head: {
    appendChild(node) {
      headChildren.push(node);
      node.parentNode = this;
      return node;
    },
    removeChild(node) {
      const i = headChildren.indexOf(node);
      if (i !== -1) headChildren.splice(i, 1);
      node.parentNode = null;
      return node;
    },
  },
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      attrs: {},
      textContent: '',
      parentNode: null,
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      getAttribute(name) {
        return this.attrs[name] ?? null;
      },
    };
  },
};

// ---------------------------------------------------------------------------
// window.__ModuleLoader__ 装载器替身
// ---------------------------------------------------------------------------
const registry = new Map();
const loaded = [];
const window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry);
      registry.set(entry.id, entry);
    },
  },
};

const requireShim = (name) => {
  if (name === 'react') return reactShim;
  throw new Error('unexpected require: ' + name);
};

// 执行脚本（等价于浏览器把 <script src> 加载进来）。
// `document` 必须以全局形式可见，所以通过 Function 形参注入。
new Function('window', 'document', source)(window, document);

console.log('=== 装载协议 ===');
check(loaded.length === 1, '脚本注册了一个模块（实际 ' + loaded.length + '）');

const entry = loaded[0];
check(entry && entry.id === 'dsh-plugin-app-icon-manager', 'id = dsh-plugin-app-icon-manager');
check(typeof entry.factory === 'function', 'factory 是函数');

const plugin = entry.factory(requireShim);
console.log('\n=== 导出的插件对象 ===');
check(plugin && plugin.name === 'dsh-plugin-app-icon-manager', 'name 正确');
check(typeof plugin.apply === 'function', 'apply 是函数');
check(Array.isArray(plugin.inject), 'inject 是数组');
check(
  plugin.inject.includes('slots') && plugin.inject.includes('locale'),
  'inject 含 slots 与 locale（实际: ' + JSON.stringify(plugin.inject) + '）',
);

// ---------------------------------------------------------------------------
// 跑一遍 apply，确认 slot 注册与词典注册都发生
// ---------------------------------------------------------------------------
console.log('\n=== apply() 行为 ===');
const effects = [];
const registeredSlots = [];
const dictionaries = [];
let injections = 0;

const ctx = {
  effect: (fn, label) => {
    const dispose = fn();
    effects.push({ label, dispose });
    return dispose;
  },
  locale: {
    register: (ns, dicts) => {
      dictionaries.push({ ns, dicts });
      return () => {};
    },
    bind: (ns) => (key) => ns + ':' + key,
  },
  slots: {
    inject: (name, cb) => {
      injections++;
      return cb();
    },
    register: (options, Component) => {
      registeredSlots.push({ options, Component });
      return () => {};
    },
  },
};

try {
  plugin.apply(ctx);
  check(true, 'apply() 未抛错');
} catch (error) {
  check(false, 'apply() 抛错: ' + error.message);
}

check(effects.length === 2, '注册了 2 个 effect（样式 + 词典），实际 ' + effects.length);
check(
  effects.some((e) => String(e.label).includes('styles')),
  '其中一个 effect 负责样式',
);
check(dictionaries.length === 1, '注册了 1 份词典');
check(
  dictionaries[0] && dictionaries[0].ns === 'settings.appIconManager',
  '词典命名空间 = settings.appIconManager',
);
check(
  dictionaries[0] && dictionaries[0].dicts.zh && dictionaries[0].dicts.en,
  '词典含 zh 与 en 两份',
);
check(injections === 1, 'slots.inject 被调用一次');
check(registeredSlots.length === 1, '注册了 1 个 slot');
check(headChildren.length === 1, '往 <head> 注入了一个 <style>');

const reg = registeredSlots[0] ?? { options: {}, Component: null };
console.log('\n=== slot 注册选项 ===');
console.log('  ' + JSON.stringify({ ...reg.options, label: undefined }, null, 2).replace(/\n/g, '\n  '));
check(reg.options.name === 'settings.section', 'name = settings.section（设置页区块）');
check(reg.options.id === 'dsh-plugin-app-icon-manager', 'id 正确');
check(typeof reg.options.order === 'number', 'order 是数字（' + reg.options.order + '）');
check(typeof reg.options.label === 'function', 'label 是函数（惰性取本地化标题）');
check(typeof reg.Component === 'function', '注册了 React 组件');
check(
  typeof reg.options.inject === 'function' && reg.options.inject().t !== undefined,
  'inject 提供了 t（组件拿得到本地化函数）',
);

// 组件能渲染出元素树（不抛错即可）
console.log('\n=== 组件渲染冒烟 ===');
try {
  const tree = reg.Component({ t: (k) => k });
  check(tree !== null && typeof tree === 'object', '首次渲染（加载中状态）返回元素树');
} catch (error) {
  check(false, '渲染抛错: ' + error.message);
}

// 用真实字典渲染，确认上传区块所需的文案键都存在
// （字典缺键时 t() 会回落成键名，界面会出现 "uploadPick" 这种原文，必须挡住）
console.log('\n=== 上传区块的文案键 ===');
let capturedDict = null;
const dictionaryCtx = {
  // effect 必须**真的执行**回调并返回其清理函数：locale.register 就包在 effect 里，
  // 回调不跑就捕获不到词典（这里踩过一次）。
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: {
    register: (ns, dict) => {
      capturedDict = dict;
      return () => {};
    },
    bind: () => (key) => key,
  },
  slots: { inject: () => {}, register: () => {} },
};
try {
  plugin.apply(dictionaryCtx);
} catch (error) {
  check(false, 'apply 抛错: ' + error.message);
}

const uploadKeys = [
  'upload', 'uploadPick', 'uploadHint', 'uploadClear', 'uploadName', 'uploadNamePlaceholder',
  'uploadWillConvert', 'uploadAddOnly', 'uploadAddOnlyHint', 'uploadAndApply',
  'uploadAndApplyHint', 'uploadDone', 'uploadDoneApplied', 'uploadFail', 'uploadTooBig',
  'uploadReadFail',
];
if (capturedDict === null) {
  check(false, '未能捕获 locale.register 的词典');
} else {
  for (const lang of ['zh', 'en']) {
    const dict = capturedDict[lang] ?? {};
    const missing = uploadKeys.filter((key) => typeof dict[key] !== 'string' || dict[key] === '');
    check(
      missing.length === 0,
      lang + ' 词典含全部上传文案' + (missing.length ? '，缺: ' + missing.join(', ') : ''),
    );
  }
  // 两份词典键集合必须一致，否则某语言下会出现回落成键名的原文
  const zhKeys = Object.keys(capturedDict.zh ?? {});
  const enKeys = Object.keys(capturedDict.en ?? {});
  const asymmetry = [
    ...zhKeys.filter((key) => !enKeys.includes(key)),
    ...enKeys.filter((key) => !zhKeys.includes(key)),
  ];
  check(asymmetry.length === 0, 'zh / en 词典键完全对称' + (asymmetry.length ? '，差异: ' + asymmetry.join(', ') : ''));
}

console.log('');
console.log(failures === 0 ? '全部通过' : failures + ' 项失败');
process.exitCode = failures === 0 ? 0 : 1;
