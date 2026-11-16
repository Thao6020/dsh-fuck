/**
 * dsh-fuck —— 浏览器半侧（手写 client bundle，无构建、无外部依赖）。
 *
 * 形态与宿主外壳一致：window.__ModuleLoader__.load({ id, factory })。
 * 只从浏览器模块表取 react；不 import 任何 DSH Client 包，所以这里没有
 * import/export，也没有 JSX —— 全部用 React.createElement 写。
 *
 * 界面结构（实测 DSH 0.2.2-rc.1 的 outlet）：
 *   1. conversation.input.left  order 10 —— 工具条上的小图标按钮（在「完全权限」按钮右侧），
 *      无文字，只显示 ◐ 图标 + 状态点；点一下展开/收起插件设置面板。
 *   2. conversation.input.dock  order 30 —— composer 上方的整行区域，设置面板在这里
 *      于文档流内展开（破甲 / 逆向 开关 + 全部个性化字段）。
 *   3. 两个组件共享模块级 store（getSnapshot/subscribe/setState），open 状态与宿主数据
 *      只有一份，按钮的 aria-expanded 与面板的显示永远同步。
 *
 * 数据：GET / POST 相对路径 /dsh-fuck/api；2000ms 轮询（页面隐藏时跳过）、
 * visibilitychange 立即刷新；乐观更新 + 失败回滚；错误提示。
 * 预览钩子：window.__DSH_FUCK_PREVIEW__ 存在时直接用它做初始状态，不 fetch、不轮询。
 * 约定：所有 class 都带 dshfk- 前缀；颜色只用 var(--dsw-alias-*, fallback)；
 * 面板禁止 fixed/sticky 定位；组件内部任何 fetch 都 try/catch，失败不清空已有状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fuck',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------------------ 常量 */

    const API_PATH = '/dsh-fuck/api'
    const POLL_INTERVAL_MS = 2000
    const USER_NAME_MAX = 40
    const CUSTOM_MAX = 4000
    const TOOL_PATH_MAX = 500
    const STATUS_CLEAR_MS = 4000
    const PANEL_ID = 'dshfk-settings-panel'

    /** 与宿主 lib/settings.js 的 DEFAULTS 保持一致的客户端副本（防 GET 失败时白屏）。 */
    const DEFAULTS = Object.freeze({
      version: 1,
      breakArmor: false,
      reverse: false,
      userName: 'THao',
      addressEverySentence: true,
      language: 'auto',
      customBreakArmor: '',
      customReverse: '',
      reverseTools: Object.freeze({ ida: '', x64dbg: '', ghidra: '' }),
      showStatus: true,
    })

    const LANGUAGES = Object.freeze([
      { value: 'auto', label: '跟随' },
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' },
    ])

    /* ------------------------------------------------------ 规范化工具 */

    const asString = (value, fallback) =>
      typeof value === 'string' ? value : fallback === undefined ? '' : fallback

    const asBool = (value, fallback) =>
      typeof value === 'boolean' ? value : fallback === undefined ? false : fallback

    const clip = (value, max) => asString(value).slice(0, max)

    const asLanguage = (value) => (value === 'zh' || value === 'en' ? value : 'auto')

    /** 把任意来源（宿主响应 / 预览数据）的 state 收敛成组件能安全消费的形状。 */
    function normalizeState(raw) {
      const src = raw && typeof raw === 'object' ? raw : {}
      const tools = src.reverseTools && typeof src.reverseTools === 'object' ? src.reverseTools : {}
      return {
        version: 1,
        breakArmor: asBool(src.breakArmor, false),
        reverse: asBool(src.reverse, false),
        userName: clip(src.userName, USER_NAME_MAX) || DEFAULTS.userName,
        addressEverySentence: asBool(src.addressEverySentence, true),
        language: asLanguage(src.language),
        customBreakArmor: clip(src.customBreakArmor, CUSTOM_MAX),
        customReverse: clip(src.customReverse, CUSTOM_MAX),
        reverseTools: {
          ida: clip(tools.ida, TOOL_PATH_MAX),
          x64dbg: clip(tools.x64dbg, TOOL_PATH_MAX),
          ghidra: clip(tools.ghidra, TOOL_PATH_MAX),
        },
        showStatus: asBool(src.showStatus, true),
      }
    }

    /** meta 只用于面板底部的小字信息，缺字段就不显示，绝不因此报错。 */
    function normalizeMeta(raw) {
      if (!raw || typeof raw !== 'object') return null
      const skills = Array.isArray(raw.skills)
        ? raw.skills
            .filter((item) => item && typeof item.name === 'string')
            .map((item) => ({ name: item.name, description: asString(item.description) }))
        : []
      const runtime = raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : {}
      return {
        version: asString(raw.version),
        skills,
        skillsMounted: asBool(raw.skillsMounted, false),
        promptBytes: typeof raw.promptBytes === 'number' ? raw.promptBytes : null,
        promptFilesOk: asBool(raw.promptFilesOk, true),
        runtime: {
          node: asString(runtime.node),
          home: asString(runtime.home),
        },
      }
    }

    /** 提取预览数据；生产环境返回 null（window.__DSH_FUCK_PREVIEW__ undefined）。 */
    function readPreview() {
      try {
        if (typeof window === 'undefined') return null
        const value = window.__DSH_FUCK_PREVIEW__
        return value && typeof value === 'object' ? value : null
      } catch {
        return null
      }
    }

    function formatClock(date) {
      const d = date || new Date()
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    /** 把人话错误收敛成一句用户能看懂的中文。 */
    function friendlyError(error) {
      const message = error && error.message ? String(error.message) : String(error || '')
      if (/failed to fetch|fetch failed|network|load failed|econn|socket|aborted|timed? ?out/i.test(message)) {
        return '无法连接宿主（插件未加载？）'
      }
      return message || '未知错误'
    }

    /** POST 一个 op，返回已解析的 JSON；非 2xx / ok:false 一律抛出。 */
    async function postOp(payload) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || !data || data.ok !== true) {
        const reason = data && data.error ? String(data.error) : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return data
    }

    /* ------------------------------------------------------------ 样式 */

    /*
     * 只允许 .dshfk- 前缀的选择器（避免污染宿主），颜色全部走主题 token。
     * 面板在文档流内展开：这里刻意不含任何 position:fixed/sticky ——
     * conversation.input.dock 位于 composer 内部（fixed 后代的包含块），
     * fixed 面板会被输入框裁切，所以只能顺流向下撑开。
     */
    const CSS = `
.dshfk-trigger{position:relative;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;box-sizing:border-box;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font-family:inherit;font-size:14px;line-height:1;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}
.dshfk-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.dshfk-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}
.dshfk-trigger-on{color:var(--dsw-alias-brand-primary,#0f1115)}
.dshfk-trigger-open{border-color:var(--dsw-alias-border-l2,#0000001a);background:var(--dsw-alias-interactive-bg-active,#2631481a)}
.dshfk-trigger-icon{display:block;transform:translateY(-0.5px)}
.dshfk-trigger-dot{position:absolute;right:2px;bottom:2px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-layer-1,#fff)}
.dshfk-trigger-err .dshfk-trigger-dot{background:var(--dsw-alias-state-error-primary,#ec1313)}
.dshfk-panel{display:flex;flex-direction:column;gap:10px;width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 2px rgba(0,0,0,.04);color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:1.5;font-family:inherit;text-align:left}
.dshfk-panel *{box-sizing:border-box}
.dshfk-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshfk-head-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);user-select:none}
.dshfk-head-tag{font-size:11px;line-height:16px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#0000001a);color:var(--dsw-alias-label-tertiary,#81858c);font-family:Consolas,"Cascadia Mono",monospace;user-select:none}
.dshfk-grow{flex:1 1 auto;min-width:4px}
.dshfk-close{appearance:none;-webkit-appearance:none;font-family:inherit;font-size:12px;line-height:18px;padding:1px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#0000000a);background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap}
.dshfk-close:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.dshfk-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}
.dshfk-chip{appearance:none;-webkit-appearance:none;font-family:inherit;font-size:12px;line-height:18px;padding:2px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#0000001a);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;user-select:none;white-space:nowrap;transition:background .15s ease,border-color .15s ease,color .15s ease}
.dshfk-chip:hover{border-color:var(--dsw-alias-border-l3,#0000001f);color:var(--dsw-alias-label-primary,#0f1115)}
.dshfk-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}
.dshfk-chip-on,.dshfk-chip-on:hover{background:var(--dsw-alias-brand-primary,#0f1115);border-color:var(--dsw-alias-brand-primary,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
.dshfk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 14px;align-items:start}
.dshfk-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshfk-field-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c);user-select:none}
.dshfk-input{width:100%;min-width:0;font-family:inherit;font-size:12px;line-height:18px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#0000001a);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);outline:none}
.dshfk-input::placeholder{color:var(--dsw-alias-label-caption,#adb2b8)}
.dshfk-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 18%,transparent)}
.dshfk-textarea{width:100%;min-width:0;min-height:56px;font-family:inherit;font-size:12px;line-height:18px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#0000001a);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);outline:none;resize:vertical}
.dshfk-textarea::placeholder{color:var(--dsw-alias-label-caption,#adb2b8)}
.dshfk-textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 18%,transparent)}
.dshfk-check{display:inline-flex;align-items:center;gap:8px;min-height:28px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;user-select:none}
.dshfk-checkbox{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary,#0f1115);cursor:pointer}
.dshfk-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:999px;background:var(--dsw-alias-bg-layer-2,transparent);align-self:flex-start}
.dshfk-seg-btn{appearance:none;-webkit-appearance:none;font-family:inherit;font-size:12px;line-height:16px;padding:2px 10px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap}
.dshfk-seg-btn:hover{color:var(--dsw-alias-label-primary,#0f1115)}
.dshfk-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}
.dshfk-seg-btn-on,.dshfk-seg-btn-on:hover{background:var(--dsw-alias-interactive-bg-active,#2631481a);color:var(--dsw-alias-label-primary,#0f1115);font-weight:500}
.dshfk-collapse{border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dshfk-collapse[open]{padding-bottom:8px}
.dshfk-summary{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;user-select:none;list-style:none}
.dshfk-summary::-webkit-details-marker{display:none}
.dshfk-summary::before{content:'\\25B8';flex:none;font-size:10px;line-height:18px;color:var(--dsw-alias-label-caption,#adb2b8);transition:transform .15s ease}
.dshfk-collapse[open]>.dshfk-summary::before{transform:rotate(90deg)}
.dshfk-collapse[open]>.dshfk-summary{color:var(--dsw-alias-label-primary,#0f1115)}
.dshfk-body{margin-top:6px}
.dshfk-tools{display:flex;flex-direction:column;gap:6px;min-width:0;margin:0;padding:0;border:0}
.dshfk-legend{padding:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c)}
.dshfk-tools-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 12px}
.dshfk-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#0000000a)}
.dshfk-btn{appearance:none;-webkit-appearance:none;font-family:inherit;font-size:12px;line-height:18px;padding:4px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#0000000a);background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap;transition:background .15s ease,color .15s ease,border-color .15s ease}
.dshfk-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.dshfk-btn:active{background:var(--dsw-alias-interactive-bg-active,#2631481a)}
.dshfk-btn:disabled{opacity:.5;cursor:default}
.dshfk-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}
.dshfk-btn-primary,.dshfk-btn-primary:hover{background:var(--dsw-alias-button-primary-fill,#0f1115);border-color:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
.dshfk-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#43454a);border-color:var(--dsw-alias-button-primary-hover,#43454a)}
.dshfk-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshfk-status-ok{color:var(--dsw-alias-state-success-primary,#22c55e)}
.dshfk-status-err{color:var(--dsw-alias-state-error-primary,#ec1313)}
.dshfk-meta{display:flex;flex-wrap:wrap;gap:2px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#adb2b8)}
.dshfk-meta-item{white-space:nowrap}
`

    /* --------------------------------------------------- 共享 store */

    /**
     * 为什么要有 store：小按钮在 conversation.input.left，面板在 conversation.input.dock，
     * 是两个独立的槽位渲染点。open 状态、宿主数据、表单草稿必须只有一份，
     * 否则 aria-expanded 与面板显示会不同步。这里用一个极小订阅模型 + useSyncExternalStore。
     */
    function createStore(initialState) {
      let state = initialState
      const listeners = new Set()
      return {
        getSnapshot() {
          return state
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** updater 可以是函数 (prev) => next，也可以是浅合并对象。 */
        setState(updater) {
          const next =
            typeof updater === 'function'
              ? updater(state)
              : Object.assign({}, state, updater)
          if (!next || next === state) return
          state = next
          for (const listener of Array.from(listeners)) {
            try {
              listener(state)
            } catch {
              /* 单个订阅者异常不应影响其他订阅者 */
            }
          }
        },
      }
    }

    /** React 18+ 用 useSyncExternalStore；更老版本退回 useState + subscribe。 */
    function useStore(store) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      }
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot)
      React.useEffect(() => store.subscribe((next) => setSnapshot(next)), [store])
      return snapshot
    }

    /* ------------------------------------------------- store 初始化 */

    const previewData = readPreview()
    const previewUi =
      previewData && previewData.ui && typeof previewData.ui === 'object' ? previewData.ui : {}
    const initialHostState = previewData ? normalizeState(previewData.state) : normalizeState(DEFAULTS)

    const store = createStore({
      preview: Boolean(previewData),
      open: previewUi.settingsOpen === true,
      expandAdvanced: previewUi.expandAdvanced === true,
      host: {
        state: initialHostState,
        meta: previewData ? normalizeMeta(previewData.meta) : null,
        loaded: Boolean(previewData), // 预览视为已就绪；生产等第一次 GET
      },
      draft: initialHostState,
      dirty: false,
      status: null, // { kind: 'ok'|'err'|'busy', text }
      connError: null,
    })

    /* ---------------------------------------------- 运行时（非 React） */

    const runtime = {
      started: false,
      timer: null,
      busy: false,
      fetching: false,
      writeSeq: 0,
      statusTimer: null,
      onVisibility: null,
    }

    /** 设置状态文案；'ok' 自动淡出，避免面板里一直挂着旧提示。 */
    function setStatus(next) {
      if (runtime.statusTimer) {
        clearTimeout(runtime.statusTimer)
        runtime.statusTimer = null
      }
      store.setState((prev) => Object.assign({}, prev, { status: next }))
      if (next && next.kind === 'ok' && typeof setTimeout === 'function') {
        runtime.statusTimer = setTimeout(() => {
          runtime.statusTimer = null
          store.setState((prev) => {
            if (prev.status && prev.status.kind === 'ok' && prev.status.text === next.text) {
              return Object.assign({}, prev, { status: null })
            }
            return prev
          })
        }, STATUS_CLEAR_MS)
      }
    }

    /** 用宿主响应刷新「服务器真相」；未编辑时同步表单草稿，避免覆盖用户输入。 */
    function acceptSnapshot(data) {
      const nextState = normalizeState(data.state)
      store.setState((prev) =>
        Object.assign({}, prev, {
          host: { state: nextState, meta: normalizeMeta(data.meta), loaded: true },
          draft: prev.dirty ? prev.draft : nextState,
        }),
      )
    }

    /** GET 一次；失败只标记连接错误，绝不清空已有状态。 */
    async function refresh() {
      const snapshot = store.getSnapshot()
      if (snapshot.preview) return
      if (typeof document === 'undefined') return
      if (document.hidden) return // 页面隐藏时不打扰
      if (runtime.busy) return // 有写请求在飞时不抢跑
      if (runtime.fetching) return // 同一时间只允许一个 GET
      runtime.fetching = true
      const writeSeq = runtime.writeSeq
      try {
        const response = await fetch(API_PATH, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        if (!data || data.ok !== true) throw new Error((data && data.error) || '响应格式异常')
        // 请求期间若有写操作完成，这份快照可能已经过期，丢弃以免回退用户刚做的修改。
        if (runtime.writeSeq !== writeSeq) return
        acceptSnapshot(data)
        store.setState((prev) => (prev.connError ? Object.assign({}, prev, { connError: null }) : prev))
      } catch (error) {
        store.setState((prev) => Object.assign({}, prev, { connError: friendlyError(error) }))
      } finally {
        runtime.fetching = false
      }
    }

    /** 统一的写操作：乐观更新 → POST → 成功用响应覆盖、失败回滚并提示。 */
    async function runOp(op, optimisticPatch, okText) {
      if (runtime.busy) return null
      runtime.busy = true
      const previousHost = store.getSnapshot().host
      if (optimisticPatch) {
        store.setState((prev) =>
          Object.assign({}, prev, {
            host: Object.assign({}, prev.host, {
              state: Object.assign({}, prev.host.state, optimisticPatch),
            }),
          }),
        )
      }
      setStatus({ kind: 'busy', text: '正在写入宿主…' })
      try {
        const data = await postOp(op)
        acceptSnapshot(data)
        store.setState((prev) => Object.assign({}, prev, { connError: null }))
        setStatus({ kind: 'ok', text: okText || `已更新 ${formatClock()}` })
        return data
      } catch (error) {
        const message = friendlyError(error)
        store.setState((prev) =>
          Object.assign({}, prev, {
            host: previousHost, // 失败回滚乐观更新
            connError: /无法连接宿主/.test(message) ? message : prev.connError,
          }),
        )
        setStatus({ kind: 'err', text: message })
        return null
      } finally {
        runtime.busy = false
        runtime.writeSeq += 1 // 让写操作之前发出的 GET 快照作废
      }
    }

    /* --------------------------------------------------- 数据生命周期 */

    function start() {
      if (runtime.started) return
      if (typeof document === 'undefined') return // SSR / Node 环境不轮询
      if (store.getSnapshot().preview) return // 预览钩子：零网络
      runtime.started = true
      refresh()
      runtime.timer = setInterval(() => {
        refresh()
      }, POLL_INTERVAL_MS)
      runtime.onVisibility = () => {
        if (!document.hidden) refresh()
      }
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', runtime.onVisibility)
      }
    }

    function stop() {
      runtime.started = false
      if (runtime.timer) {
        clearInterval(runtime.timer)
        runtime.timer = null
      }
      if (runtime.onVisibility && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', runtime.onVisibility)
      }
      runtime.onVisibility = null
      if (runtime.statusTimer) {
        clearTimeout(runtime.statusTimer)
        runtime.statusTimer = null
      }
    }

    /* ------------------------------------------------------- 交互动作 */

    function toggleOpen() {
      store.setState((prev) => Object.assign({}, prev, { open: !prev.open }))
      // 打开面板时若还没成功拉过数据，立即补一次（不靠 2s 轮询）。
      if (store.getSnapshot().open && !store.getSnapshot().preview && !store.getSnapshot().host.loaded) refresh()
    }

    function patchDraft(patch) {
      store.setState((prev) =>
        Object.assign({}, prev, {
          draft: Object.assign({}, prev.draft, patch),
          dirty: true,
        }),
      )
    }

    function patchTool(key, value) {
      const tools = store.getSnapshot().draft.reverseTools
      patchDraft({ reverseTools: Object.assign({}, tools, { [key]: value }) })
    }

    function toggleMode(key) {
      const label = key === 'breakArmor' ? '破甲模式' : '逆向模式'
      const nextValue = !store.getSnapshot().host.state[key]
      if (store.getSnapshot().preview) {
        // 预览模式：只改本地展示，绝不写宿主。
        store.setState((prev) =>
          Object.assign({}, prev, {
            host: Object.assign({}, prev.host, {
              state: Object.assign({}, prev.host.state, { [key]: nextValue }),
            }),
          }),
        )
        setStatus({ kind: 'ok', text: `预览模式：${label}${nextValue ? '已开启' : '已关闭'}（不会写入宿主）` })
        return
      }
      runOp(
        { op: 'toggle', key },
        { [key]: nextValue },
        `${label}${nextValue ? '已开启' : '已关闭'} ${formatClock()}`,
      )
    }

    async function save() {
      const draft = store.getSnapshot().draft
      const patch = {
        breakArmor: draft.breakArmor,
        reverse: draft.reverse,
        userName: draft.userName.slice(0, USER_NAME_MAX),
        addressEverySentence: draft.addressEverySentence,
        language: draft.language,
        customBreakArmor: draft.customBreakArmor.slice(0, CUSTOM_MAX),
        customReverse: draft.customReverse.slice(0, CUSTOM_MAX),
        reverseTools: {
          ida: draft.reverseTools.ida.slice(0, TOOL_PATH_MAX),
          x64dbg: draft.reverseTools.x64dbg.slice(0, TOOL_PATH_MAX),
          ghidra: draft.reverseTools.ghidra.slice(0, TOOL_PATH_MAX),
        },
        showStatus: draft.showStatus,
      }
      if (store.getSnapshot().preview) {
        const nextState = normalizeState(patch)
        store.setState((prev) =>
          Object.assign({}, prev, {
            host: Object.assign({}, prev.host, { state: nextState }),
            draft: nextState,
            dirty: false,
          }),
        )
        setStatus({ kind: 'ok', text: '预览模式：设置已暂存（不会写入宿主）' })
        return
      }
      const data = await runOp({ op: 'set', patch }, null, `已保存 ${formatClock()}`)
      if (data) {
        store.setState((prev) =>
          Object.assign({}, prev, {
            draft: normalizeState(data.state), // 服务端可能做了裁剪，回填规范化结果
            dirty: false,
          }),
        )
      }
    }

    async function reset() {
      if (store.getSnapshot().preview) {
        const nextState = normalizeState(DEFAULTS)
        store.setState((prev) =>
          Object.assign({}, prev, {
            host: Object.assign({}, prev.host, { state: nextState }),
            draft: nextState,
            dirty: false,
          }),
        )
        setStatus({ kind: 'ok', text: '预览模式：已重置为默认值（不会写入宿主）' })
        return
      }
      const data = await runOp({ op: 'reset' }, null, '已重置为默认值')
      if (data) {
        store.setState((prev) => Object.assign({}, prev, { draft: normalizeState(data.state), dirty: false }))
      }
    }

    async function reload() {
      const snapshot = store.getSnapshot()
      if (snapshot.preview) {
        store.setState((prev) => Object.assign({}, prev, { draft: prev.host.state, dirty: false }))
        setStatus({ kind: 'ok', text: '预览模式：没有宿主可重新载入' })
        return
      }
      const data = await runOp({ op: 'reload' }, null, '已重新载入提示词与技能')
      if (data) {
        store.setState((prev) => Object.assign({}, prev, { draft: normalizeState(data.state), dirty: false }))
      }
    }

    /* ------------------------------------------------------------ 组件 */

    /**
     * 工具条小按钮：图标 + 状态点，无文字。
     * 注册在 conversation.input.left（紧跟「完全权限」按钮之后）。
     */
    function DualTrigger() {
      const snapshot = useStore(store)
      const modeState = snapshot.host.state
      const anyModeOn = modeState.breakArmor || modeState.reverse
      const hasError = Boolean(snapshot.connError)
      const classes = ['dshfk-trigger']
      if (anyModeOn) classes.push('dshfk-trigger-on')
      if (snapshot.open) classes.push('dshfk-trigger-open')
      if (hasError) classes.push('dshfk-trigger-err')

      return h(
        'button',
        {
          type: 'button',
          className: classes.join(' '),
          'aria-label': 'dsh-fuck 插件设置',
          'aria-expanded': snapshot.open ? 'true' : 'false',
          'aria-controls': PANEL_ID,
          'data-dsh-fuck-trigger': '',
          title: hasError ? '插件设置（破甲 / 逆向）｜无法连接宿主（插件未加载？）' : '插件设置（破甲 / 逆向）',
          onClick: toggleOpen,
        },
        h('span', { className: 'dshfk-trigger-icon', 'aria-hidden': true }, '◐'),
        anyModeOn || hasError ? h('span', { className: 'dshfk-trigger-dot', 'aria-hidden': true }) : null,
      )
    }

    /**
     * 设置面板：渲染在 conversation.input.dock（composer 上方整行），
     * 只有 open 时才输出内容；open 状态来自共享 store。
     */
    function DualPanel() {
      const snapshot = useStore(store)
      if (!snapshot.open) return null

      const host = snapshot.host
      const draft = snapshot.draft
      const modeState = host.state

      const statusText = snapshot.status
        ? snapshot.status.text
        : snapshot.connError
          ? snapshot.connError
          : snapshot.preview
            ? '预览模式：静态数据，不连接宿主'
            : host.loaded
              ? '已连接宿主'
              : '正在连接宿主…'
      const statusKind = snapshot.status ? snapshot.status.kind : snapshot.connError ? 'err' : 'info'
      const statusClass =
        statusKind === 'ok'
          ? 'dshfk-status dshfk-status-ok'
          : statusKind === 'err'
            ? 'dshfk-status dshfk-status-err'
            : 'dshfk-status'

      const metaBits = []
      if (host.meta) {
        if (host.meta.version) metaBits.push(`v${host.meta.version}`)
        if (host.meta.skills.length > 0 || host.meta.skillsMounted) {
          metaBits.push(`逆向技能 ${host.meta.skills.length} 个${host.meta.skillsMounted ? '（已挂载）' : '（未挂载）'}`)
        }
        if (host.meta.promptBytes !== null) metaBits.push(`提示词 ${host.meta.promptBytes} B`)
        if (host.meta.runtime && host.meta.runtime.node) metaBits.push(`Node ${host.meta.runtime.node}`)
      }
      if (snapshot.preview) metaBits.push('预览数据（SSR）')

      const head = h(
        'div',
        { className: 'dshfk-head' },
        h('span', { className: 'dshfk-head-title' }, '插件设置'),
        h('span', { className: 'dshfk-head-tag' }, 'dsh-fuck'),
        h(
          'button',
          {
            type: 'button',
            className: modeState.breakArmor ? 'dshfk-chip dshfk-chip-on' : 'dshfk-chip',
            'aria-pressed': modeState.breakArmor ? 'true' : 'false',
            title: '破甲模式：不拒答、直接交付（注入破甲人格提示词）',
            onClick: () => toggleMode('breakArmor'),
          },
          '破甲',
        ),
        h(
          'button',
          {
            type: 'button',
            className: modeState.reverse ? 'dshfk-chip dshfk-chip-on' : 'dshfk-chip',
            'aria-pressed': modeState.reverse ? 'true' : 'false',
            title: '逆向模式：二进制 / EXE / 移动端逆向工作流（注入逆向人格 + 动态挂载逆向技能）',
            onClick: () => toggleMode('reverse'),
          },
          '逆向',
        ),
        h('span', { className: 'dshfk-grow', 'aria-hidden': true }),
        h(
          'button',
          { type: 'button', className: 'dshfk-close', title: '收起插件设置', 'aria-label': '收起插件设置', onClick: toggleOpen },
          '收起',
        ),
      )

      const languageSeg = h(
        'div',
        { className: 'dshfk-seg', role: 'group', 'aria-label': '输出语言' },
        LANGUAGES.map((item) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              className: draft.language === item.value ? 'dshfk-seg-btn dshfk-seg-btn-on' : 'dshfk-seg-btn',
              'aria-pressed': draft.language === item.value ? 'true' : 'false',
              title: `输出语言：${item.label}`,
              onClick: () => patchDraft({ language: item.value }),
            },
            item.label,
          ),
        ),
      )

      return h(
        'div',
        {
          className: 'dshfk-panel',
          id: PANEL_ID,
          role: 'region',
          'aria-label': 'dsh-fuck 插件设置',
          'data-dsh-fuck-panel': '',
        },
        head,
        h(
          'div',
          { className: 'dshfk-grid' },
          h(
            'label',
            { className: 'dshfk-field' },
            h('span', { className: 'dshfk-field-label' }, '称呼'),
            h('input', {
              className: 'dshfk-input',
              type: 'text',
              value: draft.userName,
              maxLength: USER_NAME_MAX,
              placeholder: DEFAULTS.userName,
              spellCheck: false,
              'aria-label': '用户称呼',
              title: `注入提示词时使用的称呼（最多 ${USER_NAME_MAX} 字）`,
              onChange: (event) => patchDraft({ userName: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'dshfk-field' },
            h('span', { className: 'dshfk-field-label' }, '输出语言'),
            languageSeg,
          ),
          h(
            'label',
            { className: 'dshfk-field' },
            h('span', { className: 'dshfk-field-label' }, '每句加称呼'),
            h(
              'span',
              { className: 'dshfk-check', title: '开启后要求模型在每句句首加称呼（代码块内不加）' },
              h('input', {
                className: 'dshfk-checkbox',
                type: 'checkbox',
                checked: draft.addressEverySentence,
                'aria-label': '每句开头加称呼',
                onChange: (event) => patchDraft({ addressEverySentence: event.target.checked }),
              }),
              '每句开头加称呼',
            ),
          ),
        ),
        h(
          'details',
          { className: 'dshfk-collapse', open: snapshot.expandAdvanced ? true : undefined },
          h('summary', { className: 'dshfk-summary' }, '破甲补充指令'),
          h(
            'div',
            { className: 'dshfk-body' },
            h('textarea', {
              className: 'dshfk-textarea',
              value: draft.customBreakArmor,
              maxLength: CUSTOM_MAX,
              rows: 3,
              placeholder: '可选：追加到破甲人格之后的补充要求（例如交付格式、必须给出的验证步骤）',
              'aria-label': '破甲补充指令',
              title: `破甲模式补充指令，最多 ${CUSTOM_MAX} 字`,
              onChange: (event) => patchDraft({ customBreakArmor: event.target.value }),
            }),
          ),
        ),
        h(
          'details',
          { className: 'dshfk-collapse', open: snapshot.expandAdvanced ? true : undefined },
          h('summary', { className: 'dshfk-summary' }, '逆向补充指令'),
          h(
            'div',
            { className: 'dshfk-body' },
            h('textarea', {
              className: 'dshfk-textarea',
              value: draft.customReverse,
              maxLength: CUSTOM_MAX,
              rows: 3,
              placeholder: '可选：追加到逆向人格之后的补充要求（例如样本目录、优先工具、报告格式）',
              'aria-label': '逆向补充指令',
              title: `逆向模式补充指令，最多 ${CUSTOM_MAX} 字`,
              onChange: (event) => patchDraft({ customReverse: event.target.value }),
            }),
          ),
        ),
        h(
          'fieldset',
          { className: 'dshfk-tools' },
          h('legend', { className: 'dshfk-legend' }, '逆向工具路径（留空则按默认安装位置探测）'),
          h(
            'div',
            { className: 'dshfk-tools-grid' },
            h(
              'label',
              { className: 'dshfk-field' },
              h('span', { className: 'dshfk-field-label' }, 'IDA'),
              h('input', {
                className: 'dshfk-input',
                type: 'text',
                value: draft.reverseTools.ida,
                maxLength: TOOL_PATH_MAX,
                placeholder: '如 C:\\Program Files\\IDA Pro 9.3\\ida64.exe',
                spellCheck: false,
                'aria-label': 'IDA 路径',
                title: 'IDA Pro 可执行文件路径，最多 500 字',
                onChange: (event) => patchTool('ida', event.target.value),
              }),
            ),
            h(
              'label',
              { className: 'dshfk-field' },
              h('span', { className: 'dshfk-field-label' }, 'x64dbg'),
              h('input', {
                className: 'dshfk-input',
                type: 'text',
                value: draft.reverseTools.x64dbg,
                maxLength: TOOL_PATH_MAX,
                placeholder: '如 D:\\x64dbg\\release\\x64\\x64dbg.exe',
                spellCheck: false,
                'aria-label': 'x64dbg 路径',
                title: 'x64dbg 可执行文件路径，最多 500 字',
                onChange: (event) => patchTool('x64dbg', event.target.value),
              }),
            ),
            h(
              'label',
              { className: 'dshfk-field' },
              h('span', { className: 'dshfk-field-label' }, 'Ghidra'),
              h('input', {
                className: 'dshfk-input',
                type: 'text',
                value: draft.reverseTools.ghidra,
                maxLength: TOOL_PATH_MAX,
                placeholder: '如 C:\\ghidra\\support\\analyzeHeadless.bat',
                spellCheck: false,
                'aria-label': 'Ghidra 路径',
                title: 'Ghidra headless 脚本路径，最多 500 字',
                onChange: (event) => patchTool('ghidra', event.target.value),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshfk-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshfk-btn dshfk-btn-primary',
              title: snapshot.dirty ? '保存设置并立即生效（下一轮模型请求就会带上）' : '保存设置（当前没有未保存修改）',
              onClick: save,
            },
            '保存',
          ),
          h(
            'button',
            { type: 'button', className: 'dshfk-btn', title: '恢复出厂默认值（会写回宿主设置文件）', onClick: reset },
            '重置',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshfk-btn',
              title: '重新读取提示词与逆向技能文件，并丢弃未保存修改',
              onClick: reload,
            },
            '重新载入',
          ),
          h('span', { className: statusClass, role: 'status', 'aria-live': 'polite', title: statusText }, statusText),
        ),
        metaBits.length > 0
          ? h(
              'div',
              { className: 'dshfk-meta' },
              metaBits.map((text, index) => h('span', { key: index, className: 'dshfk-meta-item' }, text)),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------ 入口 */

    /** 样式标签模块级记录：重复 apply（HMR）时只保留一份。 */
    let styleTag = null

    function installStyle(ctx) {
      try {
        if (typeof document === 'undefined') return
        if (!styleTag || !styleTag.isConnected) {
          styleTag = document.createElement('style')
          styleTag.setAttribute('data-dsh-fuck', '')
          styleTag.textContent = CSS
          document.head.append(styleTag)
        }
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            if (styleTag) styleTag.remove()
            styleTag = null
          })
        }
      } catch (error) {
        // 样式失败不该阻止槽位注册；只是会退化成无样式。
        try {
          console.warn('[dsh-fuck] style injection failed:', error)
        } catch {
          /* ignore */
        }
      }
    }

    function apply(ctx) {
      installStyle(ctx)

      // 轮询、visibilitychange 与插件生命周期绑定：apply 时启动，dispose 时清理。
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            start()
            return () => stop()
          })
        } else {
          start()
        }
      } catch (error) {
        try {
          console.warn('[dsh-fuck] data lifecycle failed:', error)
        } catch {
          /* ignore */
        }
      }

      try {
        // 工具条小按钮：紧跟「完全权限」按钮（conversation.input.permission）之后。
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'dsh-fuck-trigger', order: 10 },
            DualTrigger,
          ),
        )
        // composer 上方整行：设置面板（order 30，排在 Chat 的 queue dock 之后）。
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'dsh-fuck-panel', order: 30 },
            DualPanel,
          ),
        )
      } catch (error) {
        try {
          console.warn('[dsh-fuck] slot registration failed:', error)
        } catch {
          /* ignore */
        }
      }
    }

    // __store 仅供 SSR 预览与单测读取（宿主只消费 inject/apply，额外字段无害）。
    return { inject: ['slots'], apply, __store: store }
  },
})
