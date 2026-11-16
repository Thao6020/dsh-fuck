#!/usr/bin/env node
/**
 * dsh-fxxk 客户端 SSR 预览生成器。
 *
 * 为什么要有这个文件：client.js 是浏览器 bundle（没有 ESM 导出），无法在 Node 里直接
 * import。这里伪造 window.__ModuleLoader__ 截获工厂函数，再伪造 ctx.slots / ctx.effect /
 * document 跑一遍 apply()，从而同时验证：
 *   1. 模块形态（id、inject、工厂只 require('react')）；
 *   2. 两个槽位注册参数：
 *        conversation.input.left / dsh-fxxk-trigger / order 10（工具条小图标按钮）
 *        conversation.input.dock / dsh-fxxk-panel  / order 30（composer 上方设置面板）
 *   3. 按钮与面板共享同一份模块级 store（改 store 后两个组件的 SSR 同时变化）；
 *   4. 样式标签注入与清理（ctx.effect disposer 能移除 <style>），且 CSS 只含 .dshf- 前缀、
 *      没有 fixed/sticky 定位；
 *   5. 用真实 React 做 SSR：收起态（只有图标按钮）与展开态（完整设置面板），
 *      以及生产路径（无预览变量）不报错。
 *
 * 产物（test/out/）：
 *   dock-collapsed.html  默认收起：工具条只有小图标按钮（模式开启时高亮）
 *   dock-open.html       点开后：面板在 composer 上方文档流内展开
 *   preview.html / preview-default.html  —— 上面两个页面的别名（向后兼容）
 *
 * 运行：node test/client-preview.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const outDir = path.join(here, 'out')
const clientPath = path.join(pluginRoot, 'client.js')

/* ---------------------------------------------------------------- React 定位 */

/**
 * 预览需要真实 react + react-dom/server。本机没有把 react-dom 装到插件目录，
 * 按候选清单找第一处同时含 react 与 react-dom 的 node_modules（可用
 * DSH_FXXK_REACT_ROOT 显式覆盖）。
 */
function resolveReactRoot() {
  const candidates = [
    process.env.DSH_FXXK_REACT_ROOT,
    join(homedir(), '.dsh', 'profiles', 'tauri', 'node_modules'),
    join(homedir(), '.dsh', 'profiles', 'node_modules'),
    join(homedir(), 'Desktop', 'vul', 'artex-src', 'web', 'node_modules'),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'node_modules').replace(/\\/g, '/') : '',
    ...String(process.env.NODE_PATH || '')
      .split(';')
      .filter(Boolean),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, '/').replace(/\/+$/, '')
    const hasReact = fs.existsSync(path.join(normalized, 'react', 'package.json'))
    const hasReactDom = fs.existsSync(path.join(normalized, 'react-dom', 'package.json'))
    if (hasReact && hasReactDom) return normalized
  }
  throw new Error(
    '找不到同时包含 react 与 react-dom 的 node_modules。\n' +
      '请设置 DSH_FXXK_REACT_ROOT=<含 react 与 react-dom 的 node_modules 目录> 后重试。',
  )
}

const reactRoot = resolveReactRoot()
const reactRequire = createRequire(path.join(reactRoot.replace(/\//g, path.sep), '__dsh_fxxk_preview__.cjs'))
const React = reactRequire('react')
const ReactDOMServer = reactRequire('react-dom/server')
const { renderToStaticMarkup } = ReactDOMServer
const h = React.createElement

/* ---------------------------------------------------------------- 断言框架 */

const results = []
function check(name, run) {
  try {
    run()
    results.push({ name, ok: true })
    console.log(`  \u2713 ${name}`)
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
    console.error(`  \u2717 ${name} — ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/* ------------------------------------------------------- 加载 client.js */

const clientCode = fs.readFileSync(clientPath, 'utf8')

/**
 * 在受控环境里执行 client.js，拿到工厂返回值。
 * @param {object|undefined} previewData 为 undefined 时模拟生产环境（无预览变量）
 */
function loadClient(previewData) {
  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
  }
  if (previewData !== undefined) fakeWindow.__DSH_FXXK_PREVIEW__ = previewData

  // client.js 顶层只通过 window.__ModuleLoader__.load 注册工厂，用 Function 包一层即可执行。
  const run = new Function('window', `${clientCode}\n//# sourceURL=dsh-fxxk/client.js`)
  run(fakeWindow)

  assert(captured, 'client.js 没有调用 window.__ModuleLoader__.load')
  assert(typeof captured.factory === 'function', 'load 的 factory 不是函数')

  const requires = []
  const factoryRequire = (id) => {
    requires.push(id)
    if (id === 'react') return React
    throw new Error(`client.js 只允许 require('react')，实际 require 了 ${JSON.stringify(id)}`)
  }
  const mod = captured.factory(factoryRequire)
  assert(mod && typeof mod.apply === 'function', 'factory 必须返回 { inject, apply }')
  assert(mod.__store && typeof mod.__store.getSnapshot === 'function', 'factory 需要暴露 __store（预览/单测用）')
  return { entry: captured, mod, requires, window: fakeWindow }
}

/* --------------------------------------------------- 伪造宿主 ctx 跑 apply */

/**
 * 伪造最小宿主：ctx.effect / ctx.slots.inject / ctx.slots.register / document。
 * document.hidden 故意设为 true，避免生产实例在 Node SSR 里真的去 fetch / 轮询。
 */
function mountInFakeHost(instance) {
  const styleTags = []
  const registrations = []
  const disposers = []

  const fakeDocument = {
    hidden: true,
    head: {
      append(node) {
        styleTags.push(node)
      },
    },
    createElement(tagName) {
      return {
        tagName,
        textContent: '',
        attributes: {},
        isConnected: true,
        removed: false,
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        remove() {
          this.removed = true
          this.isConnected = false
        },
      }
    },
  }

  const ctx = {
    effect(callback) {
      disposers.push(callback())
    },
    slots: {
      inject(name, callback) {
        assert(
          name === 'conversation.input.left' || name === 'conversation.input.dock',
          `意外槽位：${JSON.stringify(name)}（只允许 conversation.input.left / conversation.input.dock）`,
        )
        callback()
      },
      register(descriptor, component) {
        registrations.push({ descriptor, component })
        return () => {}
      },
    },
  }

  const previousDocument = globalThis.document
  globalThis.document = fakeDocument
  try {
    instance.mod.apply(ctx)
  } finally {
    globalThis.document = previousDocument
  }

  return { styleTags, registrations, disposers }
}

/* ------------------------------------------------------------- CSS 自检 */

/** 收集所有选择器，断言全部以 .dshf- 开头（不污染宿主）。 */
function assertScopedCss(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectorGroups = []
  const pattern = /([^{}]+)\{/g
  let match
  while ((match = pattern.exec(withoutComments)) !== null) {
    const selector = match[1].trim()
    if (!selector || selector.startsWith('@')) continue
    selectorGroups.push(selector)
  }
  assert(selectorGroups.length > 0, 'CSS 里没有解析到任何选择器')

  for (const group of selectorGroups) {
    for (const single of group.split(',')) {
      const clean = single.trim()
      if (!clean) continue
      assert(clean.startsWith('.dshf'), `CSS 出现了非 dshf- 前缀选择器：${clean}`)
    }
  }
  assert(!/position\s*:\s*(fixed|sticky)\b/i.test(withoutComments), 'CSS 不允许 fixed/sticky 定位（会被 composer 裁切）')
}

/* ------------------------------------------------------- 宿主主题 token */

/*
 * 预览页不是真实宿主，必须把宿主 DSH 0.2.x 的主题变量补上，否则 client.css 只能吃到
 * fallback 颜色。下列取值来自宿主前端 CSS 的真实主题（light / dark），保持变量名一致，
 * 这样预览截图与真实宿主观感接近。预览页按宿主习惯把变量挂在 body 上。
 */
const HOST_TOKENS_LIGHT = `
body{
  --dsw-alias-bg-base:#ffffff;
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-bg-layer-2:#ffffff;
  --dsw-alias-bg-layer-3:#ffffff;
  --dsw-alias-bg-overlay:#e9ecf2;
  --dsw-alias-border-l1:#0000000a;
  --dsw-alias-border-l2:#0000001a;
  --dsw-alias-border-l3:#0000001f;
  --dsw-alias-border-l4:#00000029;
  --dsw-alias-brand-primary:#0f1115;
  --dsw-alias-label-primary:#0f1115;
  --dsw-alias-label-secondary:#61666b;
  --dsw-alias-label-tertiary:#81858c;
  --dsw-alias-label-caption:#adb2b8;
  --dsw-alias-label-dimmed:#e1e5ee;
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-interactive-bg-hover:#2631480f;
  --dsw-alias-interactive-bg-active:#2631481a;
  --dsw-alias-state-business-primary:#4176e6;
  --dsw-alias-state-success-primary:#22c55e;
  --dsw-alias-state-error-primary:#ec1313;
  --dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);
  --dsw-alias-button-primary-hover:#43454a;
  --dsw-alias-link:#4176e6;
  --dsw-alias-switch-thumb:#ffffff;
  --dsw-specific-input-major:#ffffff;
}
`

const HOST_TOKENS_DARK = `
body[data-ds-dark-theme]{
  --dsw-alias-bg-base:#151517;
  --dsw-alias-bg-layer-1:#232324;
  --dsw-alias-bg-layer-2:#2c2c2e;
  --dsw-alias-bg-layer-3:#353638;
  --dsw-alias-bg-overlay:#61666b;
  --dsw-alias-border-l1:#ffffff0f;
  --dsw-alias-border-l2:#ffffff1f;
  --dsw-alias-border-l3:#ffffff29;
  --dsw-alias-border-l4:#ffffff33;
  --dsw-alias-brand-primary:#f9fafb;
  --dsw-alias-label-primary:#f9fafb;
  --dsw-alias-label-secondary:#cfd3d6;
  --dsw-alias-label-tertiary:#adb2b8;
  --dsw-alias-label-caption:#81858c;
  --dsw-alias-label-dimmed:#43454a;
  --dsw-alias-label-primary-foreground:#0f1115;
  --dsw-alias-interactive-bg-hover:#ffffff14;
  --dsw-alias-interactive-bg-active:#ffffff24;
  --dsw-alias-state-business-primary:#7aaaff;
  --dsw-alias-state-success-primary:#22c55e;
  --dsw-alias-state-error-primary:#f25a5a;
  --dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);
  --dsw-alias-button-primary-hover:#ebeef2;
  --dsw-alias-link:#7aaaff;
  --dsw-alias-switch-thumb:#adb2b8;
  --dsw-specific-input-major:#2c2c2e;
}
`

/** 预览页自身的排版样式（只服务于截图，不属于 client.js）。 */
const PREVIEW_PAGE_CSS = `
html,body{margin:0;padding:0}
body{min-height:100vh;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#0f1115);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:13px;line-height:1.5}
.pv-shell{max-width:980px;margin:0 auto;padding:28px 20px 56px;display:flex;flex-direction:column;gap:14px}
.pv-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pv-head-title{margin:0;font-size:13px;font-weight:400;color:var(--dsw-alias-label-secondary,#61666b)}
.pv-head-title strong{color:var(--dsw-alias-label-primary,#0f1115);font-weight:600}
.pv-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 10px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2,#0000001a);color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;line-height:20px}
.pv-pill-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e)}
.pv-session{display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#ffffff);
  border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:16px;padding:16px 16px 10px;box-shadow:0 8px 30px rgba(0,0,0,.05)}
.pv-transcript{display:flex;flex-direction:column;gap:10px;min-height:116px;padding-bottom:18px}
.pv-bubble{max-width:74%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.6}
.pv-bubble-user{align-self:flex-end;background:var(--dsw-alias-interactive-bg-active,#2631481a)}
.pv-bubble-bot{align-self:flex-start;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-primary,#0f1115)}
.pv-dock{width:100%;padding:0 0 8px}
.pv-dock:empty{display:none}
.pv-composer{border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:16px;padding:10px 12px 10px;
  background:var(--dsw-alias-bg-layer-1,#ffffff);box-shadow:0 2px 10px rgba(0,0,0,.04)}
.pv-composer-input{display:flex;align-items:center;min-height:36px;padding:0 4px 6px;color:var(--dsw-alias-label-caption,#adb2b8)}
.pv-composer-tools{display:flex;align-items:center;gap:8px;padding-top:8px;margin-top:2px;
  border-top:1px solid var(--dsw-alias-border-l1,#0000000a);color:var(--dsw-alias-label-caption,#adb2b8);font-size:12px}
.pv-tool{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#0000001a);white-space:nowrap}
.pv-tool-permission{color:var(--dsw-alias-label-secondary,#61666b)}
.pv-tool-icon{display:inline-flex;align-items:center;justify-content:center;min-height:24px;min-width:24px}
.pv-grow{flex:1 1 auto}
.pv-tool-send{background:var(--dsw-alias-brand-primary,#0f1115);border-color:var(--dsw-alias-brand-primary,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff)}
.pv-foot{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c)}
.pv-foot code{font-family:Consolas,"Cascadia Mono",monospace;font-size:11px;padding:1px 5px;border-radius:4px;
  background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-secondary,#61666b)}
`

/* --------------------------------------------------------- 预览数据 */

/** 收起态预览数据：破甲开启（演示小按钮高亮 + 状态点），面板收起。 */
const PREVIEW_COLLAPSED = {
  ok: true,
  state: {
    version: 1,
    breakArmor: true,
    reverse: false,
    userName: 'THao',
    addressEverySentence: true,
    language: 'auto',
    customBreakArmor: '',
    customReverse: '',
    reverseTools: { ida: '', x64dbg: '', ghidra: '' },
    showStatus: true,
  },
  meta: {
    version: '0.1.0',
    skills: [
      { name: 'rev-workflow', description: '逆向总流程与交付标准' },
      { name: 'rev-pe-recon', description: 'PE / EXE 静态侦察' },
      { name: 'rev-ida', description: 'IDA Pro 静态分析' },
      { name: 'rev-x64dbg', description: 'x64dbg 动态调试' },
      { name: 'rev-unpack', description: '壳 / 混淆识别与脱壳' },
      { name: 'rev-dotnet-unity', description: '.NET / Unity il2cpp 逆向' },
      { name: 'rev-patch', description: '补丁 / 注册机 / license 校验分析' },
      { name: 'rev-malware', description: '恶意样本分析' },
    ],
    skillsMounted: false,
    promptBytes: 4210,
    promptFilesOk: true,
    runtime: { node: 'v24.0.0', home: '$DSH_HOME' },
  },
  ui: { settingsOpen: false, expandAdvanced: false },
}

/** 展开态预览数据：两个模式都开、面板展开、补充指令区默认展开。 */
const PREVIEW_OPEN = {
  ok: true,
  state: {
    version: 1,
    breakArmor: true,
    reverse: true,
    userName: 'THao',
    addressEverySentence: true,
    language: 'auto',
    customBreakArmor: '',
    customReverse: '',
    reverseTools: {
      ida: 'C:\\Program Files\\IDA Pro 9.3\\ida64.exe',
      x64dbg: '',
      ghidra: '',
    },
    showStatus: true,
  },
  meta: {
    version: '0.1.0',
    skills: [
      { name: 'rev-workflow', description: '逆向总流程与交付标准' },
      { name: 'rev-pe-recon', description: 'PE / EXE 静态侦察' },
      { name: 'rev-ida', description: 'IDA Pro 静态分析' },
      { name: 'rev-x64dbg', description: 'x64dbg 动态调试' },
      { name: 'rev-unpack', description: '壳 / 混淆识别与脱壳' },
      { name: 'rev-dotnet-unity', description: '.NET / Unity il2cpp 逆向' },
      { name: 'rev-patch', description: '补丁 / 注册机 / license 校验分析' },
      { name: 'rev-malware', description: '恶意样本分析' },
    ],
    skillsMounted: true,
    promptBytes: 8214,
    promptFilesOk: true,
    runtime: { node: 'v24.0.0', home: '$DSH_HOME' },
  },
  ui: { settingsOpen: true, expandAdvanced: true },
}

/* -------------------------------------------------------- 页面模板 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 拼出预览页：模拟 composer 工具条（「完全权限」之后是 input.left 按钮，
 * 上方是 input.dock 面板）。
 * @param {{triggerMarkup: string, panelMarkup: string, clientCss: string, title: string, note: string}} options
 */
function buildPreviewPage({ triggerMarkup, panelMarkup, clientCss, title, note }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style data-host-tokens-light>${HOST_TOKENS_LIGHT}</style>
<style data-host-tokens-dark>${HOST_TOKENS_DARK}</style>
<style data-preview-page>${PREVIEW_PAGE_CSS}</style>
<!-- 下面这段就是 client.js 里 clientCss 常量的真实内容（从 apply() 注入的 <style> 里取出） -->
<style data-dsh-fxxk>${clientCss}</style>
</head>
<body>
<div class="pv-shell">
  <div class="pv-head">
    <p class="pv-head-title"><strong>dsh-fxxk</strong> · composer 预览</p>
    <span class="pv-pill"><span class="pv-pill-dot" aria-hidden="true"></span>SSR 静态预览</span>
  </div>
  <div class="pv-session">
    <div class="pv-transcript">
      <div class="pv-bubble pv-bubble-user">帮我看看这个 EXE 的注册校验逻辑，直接给结论。</div>
      <div class="pv-bubble pv-bubble-bot">收到。先做静态侦察（PE 头 / 导入 / 字符串），再进动态调试验证关键分支……</div>
    </div>
    <!-- conversation.input.dock outlet：composer 上方的整行，面板在这里文档流内展开 -->
    <div class="pv-dock" data-slot="conversation.input.dock">${panelMarkup}</div>
    <div class="pv-composer">
      <div class="pv-composer-input">给 DeepSeek 发送消息…</div>
      <div class="pv-composer-tools">
        <span class="pv-tool pv-tool-permission">完全权限</span>
        <!-- conversation.input.left outlet：紧跟「完全权限」按钮之后 -->
        <span class="pv-tool-icon" data-slot="conversation.input.left">${triggerMarkup}</span>
        <span class="pv-grow"></span>
        <span class="pv-tool">模型</span>
        <span class="pv-tool pv-tool-send">发送</span>
      </div>
    </div>
  </div>
  <div class="pv-foot">
    <span>${escapeHtml(note)}</span>
    <span>槽位：<code>conversation.input.left</code>(order 10) + <code>conversation.input.dock</code>(order 30)</span>
    <span>数据来源：<code>window.__DSH_FXXK_PREVIEW__</code>（不访问网络）</span>
    <span>深色：<code>/?theme=dark</code></span>
  </div>
</div>
<script>
// 预览页小工具：?theme=dark 时切到宿主的深色主题（宿主用 body[data-ds-dark-theme] 标记）。
try {
  if (new URLSearchParams(location.search).get('theme') === 'dark') {
    document.body.dataset.dsDarkTheme = '1'
  }
} catch (error) {
  /* 预览页的装饰逻辑，失败也不影响 UI */
}
</script>
</body>
</html>
`
}

/* ------------------------------------------------------------ 主流程 */

function renderComponent(component) {
  return renderToStaticMarkup(h(component))
}

function main() {
  console.log(`[dsh-fxxk] 客户端 SSR 预览`)
  console.log(`  client.js : ${clientPath}`)
  console.log(`  react     : ${React.version} @ ${reactRoot}`)
  console.log(`  react-dom : ${ReactDOMServer.version || '?'}`)

  fs.mkdirSync(outDir, { recursive: true })

  // ---- 1. 收起态实例（面板关闭，破甲开启） ----
  const collapsedInstance = loadClient(PREVIEW_COLLAPSED)
  const collapsedHost = mountInFakeHost(collapsedInstance)
  const collapsedTrigger = collapsedHost.registrations.find(
    (item) => item.descriptor.name === 'conversation.input.left',
  )
  const collapsedPanel = collapsedHost.registrations.find(
    (item) => item.descriptor.name === 'conversation.input.dock',
  )

  check('模块 id 是 dsh-fxxk', () => {
    assert(collapsedInstance.entry.id === 'dsh-fxxk', `实际 id 是 ${JSON.stringify(collapsedInstance.entry.id)}`)
  })
  check('inject 只声明 slots', () => {
    assert(
      Array.isArray(collapsedInstance.mod.inject) &&
        collapsedInstance.mod.inject.length === 1 &&
        collapsedInstance.mod.inject[0] === 'slots',
      `实际 inject 是 ${JSON.stringify(collapsedInstance.mod.inject)}`,
    )
  })
  check('工厂只 require("react")', () => {
    assert(
      collapsedInstance.requires.length === 1 && collapsedInstance.requires[0] === 'react',
      `实际 require 列表是 ${JSON.stringify(collapsedInstance.requires)}`,
    )
  })
  check('注册了 conversation.input.left（按钮，order 10）', () => {
    assert(collapsedTrigger, '缺少 conversation.input.left 注册')
    assert(collapsedTrigger.descriptor.id === 'dsh-fxxk-trigger', `id=${collapsedTrigger.descriptor.id}`)
    assert(collapsedTrigger.descriptor.order === 10, `order=${collapsedTrigger.descriptor.order}`)
    assert(typeof collapsedTrigger.component === 'function', '按钮组件不是函数组件')
  })
  check('注册了 conversation.input.dock（面板，order 30）', () => {
    assert(collapsedPanel, '缺少 conversation.input.dock 注册')
    assert(collapsedPanel.descriptor.id === 'dsh-fxxk-panel', `id=${collapsedPanel.descriptor.id}`)
    assert(collapsedPanel.descriptor.order === 30, `order=${collapsedPanel.descriptor.order}`)
    assert(typeof collapsedPanel.component === 'function', '面板组件不是函数组件')
  })
  check('只有两个槽位注册，且不再注册旧槽位', () => {
    assert(collapsedHost.registrations.length === 2, `注册数量是 ${collapsedHost.registrations.length}`)
    const slots = collapsedHost.registrations.map((item) => item.descriptor.name).join(',')
    assert(slots === 'conversation.input.left,conversation.input.dock', `槽位列表是 ${slots}`)
  })
  check('样式标签 data-dsh-fxxk 注入且内容非空', () => {
    assert(collapsedHost.styleTags.length === 1, `样式标签数量是 ${collapsedHost.styleTags.length}`)
    const tag = collapsedHost.styleTags[0]
    assert(tag.tagName === 'style', `标签名是 ${tag.tagName}`)
    assert(tag.attributes['data-dsh-fxxk'] === '', '缺少 data-dsh-fxxk 属性')
    assert(tag.textContent.length > 2000, `样式过短：${tag.textContent.length}`)
    assert(/var\(--dsw-alias-/.test(tag.textContent), '样式没有使用宿主主题变量')
  })

  const clientCss = collapsedHost.styleTags[0].textContent
  check('CSS 全部为 .dshf- 前缀且无 fixed/sticky', () => assertScopedCss(clientCss))
  check('CSS 含按钮/面板样式，且 UI 不再出现「双模式」', () => {
    assert(clientCss.includes('.dshf-trigger'), 'CSS 缺少 .dshf-trigger')
    assert(clientCss.includes('.dshf-panel'), 'CSS 缺少 .dshf-panel')
    assert(!clientCode.includes('双模式'), 'client.js 里不应再有「双模式」（UI 文案要求）')
    assert(!clientCss.includes('双模式'), 'CSS 里不应出现「双模式」')
  })

  // ---- 2. 收起态 SSR：只有小按钮，面板不渲染 ----
  const collapsedTriggerMarkup = renderComponent(collapsedTrigger.component)
  const collapsedPanelMarkup = renderComponent(collapsedPanel.component)

  check('收起态 SSR：按钮有 aria-label / aria-expanded=false / 状态点 / 无文字', () => {
    assert(collapsedTriggerMarkup.includes('aria-label="dsh-fxxk 插件设置"'), '缺少 aria-label')
    assert(collapsedTriggerMarkup.includes('aria-expanded="false"'), '收起态 aria-expanded 应为 false')
    assert(collapsedTriggerMarkup.includes('dshf-trigger'), '缺少 dshf-trigger class')
    assert(collapsedTriggerMarkup.includes('dshf-trigger-on'), '破甲开启时按钮应高亮（dshf-trigger-on）')
    assert(collapsedTriggerMarkup.includes('dshf-trigger-dot'), '模式开启时应显示状态点')
    assert(!collapsedTriggerMarkup.includes('>破甲<'), '工具条按钮里不应出现「破甲」文字')
    assert(!collapsedTriggerMarkup.includes('>逆向<'), '工具条按钮里不应出现「逆向」文字')
    assert(!collapsedTriggerMarkup.includes('双模式'), '工具条按钮里不应出现「双模式」文字')
    // title 里的「插件设置（破甲 / 逆向）」是悬停提示（lead 指定），不算工具条可见文字
    assert(collapsedTriggerMarkup.includes('title="插件设置（破甲 / 逆向）"'), '按钮 title 应为「插件设置（破甲 / 逆向）」')
  })
  check('收起态 SSR：面板渲染为空（open=false）', () => {
    assert(collapsedPanelMarkup === '', `面板应为空字符串，实际长度 ${collapsedPanelMarkup.length}`)
  })

  // ---- 3. 共享 store：改一次 store，两个组件的 SSR 同时变化 ----
  check('按钮与面板共享同一份 store（setState 后两边同步）', () => {
    const events = []
    const unsubscribe = collapsedInstance.mod.__store.subscribe((snapshot) => {
      events.push(snapshot.open)
    })
    collapsedInstance.mod.__store.setState((prev) => Object.assign({}, prev, { open: true }))
    unsubscribe()

    assert(events.length === 1 && events[0] === true, `订阅回调次数/内容异常：${JSON.stringify(events)}`)

    const reopenedTrigger = renderComponent(collapsedTrigger.component)
    const reopenedPanel = renderComponent(collapsedPanel.component)
    assert(reopenedTrigger.includes('aria-expanded="true"'), 'setState 后按钮 aria-expanded 未同步')
    assert(reopenedTrigger.includes('dshf-trigger-open'), 'setState 后按钮缺少展开态样式')
    assert(reopenedPanel.length > 500, `setState 后面板仍是空的（长度 ${reopenedPanel.length}）`)
    assert(reopenedPanel.includes('插件设置') && reopenedPanel.includes('dsh-fxxk'), '面板缺少插件标识')

    // 再关回去，确认方向可逆
    collapsedInstance.mod.__store.setState((prev) => Object.assign({}, prev, { open: false }))
    assert(renderComponent(collapsedPanel.component) === '', '再次关闭后面板没有变回空')
    assert(renderComponent(collapsedTrigger.component).includes('aria-expanded="false"'), '再次关闭后按钮未同步')
  })

  // ---- 4. 展开态实例（独立 store）：完整面板 SSR ----
  const openInstance = loadClient(PREVIEW_OPEN)
  const openHost = mountInFakeHost(openInstance)
  const openTrigger = openHost.registrations.find((item) => item.descriptor.name === 'conversation.input.left')
  const openPanel = openHost.registrations.find((item) => item.descriptor.name === 'conversation.input.dock')
  const openTriggerMarkup = renderComponent(openTrigger.component)
  const openPanelMarkup = renderComponent(openPanel.component)

  check('展开态 SSR：按钮 aria-expanded=true + 两个开关都高亮', () => {
    assert(openTriggerMarkup.includes('aria-expanded="true"'), 'aria-expanded 应为 true')
    assert(openTriggerMarkup.includes('dshf-trigger-on'), '逆向/破甲开启时按钮应高亮')
  })
  check('展开态 SSR：面板含全部字段与文案', () => {
    assert(openPanelMarkup.includes('插件设置'), '缺少面板标题「插件设置」')
    assert(openPanelMarkup.includes('收起'), '缺少「收起」按钮')
    for (const text of [
      '破甲',
      '逆向',
      '称呼',
      '每句开头加称呼',
      '输出语言',
      '跟随',
      '中文',
      'English',
      '破甲补充指令',
      '逆向补充指令',
      '逆向工具路径',
      'IDA',
      'x64dbg',
      'Ghidra',
      '保存',
      '重置',
      '重新载入',
    ]) {
      assert(openPanelMarkup.includes(text), `缺少文案：${text}`)
    }
    assert(/aria-pressed="true"/.test(openPanelMarkup), '开启的模式 chip 缺少 aria-pressed=true')
    assert(!openPanelMarkup.includes('双模式'), '面板里不应出现「双模式」')
  })
  check('展开态 SSR：面板不含 fixed 定位与内联 onclick', () => {
    assert(!/position:\s*fixed/i.test(openPanelMarkup), 'markup 里出现了 fixed 定位')
    assert(!/onclick=/i.test(openPanelMarkup), 'SSR markup 不应包含内联 onclick')
  })

  // ---- 5. 生产实例：没有 __DSH_FXXK_PREVIEW__ ----
  const productionInstance = loadClient(undefined)
  const productionHost = mountInFakeHost(productionInstance)
  const productionTrigger = productionHost.registrations.find(
    (item) => item.descriptor.name === 'conversation.input.left',
  )
  const productionPanel = productionHost.registrations.find(
    (item) => item.descriptor.name === 'conversation.input.dock',
  )

  check('生产路径（无预览变量）apply 不报错且注册两个槽位', () => {
    assert(productionHost.registrations.length === 2, `注册数量是 ${productionHost.registrations.length}`)
    assert(productionHost.styleTags.length === 1, `样式标签数量是 ${productionHost.styleTags.length}`)
    assert(productionInstance.mod.__store.getSnapshot().preview === false, '生产路径 preview 应为 false')
  })
  check('生产路径 SSR：默认收起，只有按钮', () => {
    const markup = renderComponent(productionTrigger.component)
    assert(markup.includes('aria-expanded="false"'), '默认 aria-expanded 应为 false')
    assert(renderComponent(productionPanel.component) === '', '生产路径默认面板应为空')
  })

  // ---- 6. 生命周期：disposer 移除样式标签 / 停轮询，重复 apply 会重建 ----
  check('ctx.effect disposer 能移除样式标签', () => {
    assert(productionHost.disposers.length === 2, `disposer 数量是 ${productionHost.disposers.length}（样式 + 数据生命周期）`)
    for (const dispose of productionHost.disposers) dispose()
    assert(productionHost.styleTags[0].removed === true, '样式标签没有被移除')
  })

  const remountInstance = loadClient(undefined)
  const remountHost = mountInFakeHost(remountInstance)
  check('dispose 之后重新 apply 会重建样式标签', () => {
    assert(remountHost.styleTags.length === 1, `重建后样式标签数量是 ${remountHost.styleTags.length}`)
    assert(remountHost.styleTags[0].textContent === clientCss, '重建的样式内容不一致')
    for (const dispose of remountHost.disposers) dispose()
  })

  // ---- 7. 输出预览 HTML ----
  const collapsedHtml = buildPreviewPage({
    triggerMarkup: collapsedTriggerMarkup,
    panelMarkup: '',
    clientCss,
    title: 'dsh-fxxk · composer 收起态预览',
    note: '默认收起：工具条「完全权限」右侧只有一个小图标按钮（破甲开启 → 高亮 + 状态点）',
  })
  const openHtml = buildPreviewPage({
    triggerMarkup: openTriggerMarkup,
    panelMarkup: openPanelMarkup,
    clientCss,
    title: 'dsh-fxxk · composer 展开态预览',
    note: '点开后：设置面板在 composer 上方文档流内展开，含破甲 / 逆向开关与全部个性化字段',
  })

  fs.writeFileSync(path.join(outDir, 'dock-collapsed.html'), collapsedHtml, 'utf8')
  fs.writeFileSync(path.join(outDir, 'dock-open.html'), openHtml, 'utf8')
  // 旧文件名保留为别名，避免其他脚本/习惯引用失效。
  fs.writeFileSync(path.join(outDir, 'preview.html'), openHtml, 'utf8')
  fs.writeFileSync(path.join(outDir, 'preview-default.html'), collapsedHtml, 'utf8')

  check('预览 HTML 写出成功且不含「双模式」', () => {
    for (const name of ['dock-collapsed.html', 'dock-open.html']) {
      const written = fs.readFileSync(path.join(outDir, name), 'utf8')
      assert(written.includes('data-slot="conversation.input.left"'), `${name} 缺少 input.left outlet`)
      assert(written.includes('data-slot="conversation.input.dock"'), `${name} 缺少 input.dock outlet`)
      assert(written.includes(clientCss.slice(0, 120)), `${name} 没有内联 client.js 的样式`)
      assert(!written.includes('双模式'), `${name} 不应出现「双模式」`)
    }
    const collapsedWritten = fs.readFileSync(path.join(outDir, 'dock-collapsed.html'), 'utf8')
    assert(!collapsedWritten.includes('插件设置</span>'), '收起态不应渲染面板标题')
    const openWritten = fs.readFileSync(path.join(outDir, 'dock-open.html'), 'utf8')
    assert(openWritten.includes('插件设置'), '展开态应渲染面板标题')
  })

  const failed = results.filter((item) => !item.ok)
  console.log('')
  console.log(`[dsh-fxxk] 输出：`)
  console.log(`  ${path.join(outDir, 'dock-collapsed.html')}`)
  console.log(`  ${path.join(outDir, 'dock-open.html')}`)
  console.log('')
  if (failed.length > 0) {
    console.error(`[dsh-fxxk] FAIL：${failed.length}/${results.length} 项断言失败`)
    for (const item of failed) console.error(`  - ${item.name}: ${item.message}`)
    process.exitCode = 1
    return
  }
  console.log(`[dsh-fxxk] PASS：${results.length}/${results.length} 项检查通过`)
}

main()
