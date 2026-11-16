/**
 * dsh-fuck — 宿主半侧入口。
 *
 * 职责（SPEC 第 4 节）：
 *   1. 读写 $DSH_HOME/dsh-fuck/settings.json（lib/settings.js）
 *   2. 注册 `dsh-fuck:modes` systemPrompt section，按当前开关动态注入提示词
 *   3. 注册 /dsh-fuck/api，供会话内 dock 读取 / 切换状态
 *   4. 逆向模式打开时把 skills/ 里的技能注册进 ctx.skills，关闭即卸载
 *   5. `/dual` 命令（可选服务，缺失则跳过）
 *
 * 为什么提示词正文每次 assemble 现算：两模式可在会话中途即时开关，宿主不需要
 * 重启；文件读取用 mtime 缓存，assemble 里只有两次 stat，不会变成重 IO。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as settings from './lib/settings.js'
import * as prompts from './lib/prompts.js'
import * as skills from './lib/skills.js'
import * as api from './lib/api.js'

export const name = 'dsh-fuck'

/**
 * 必需服务：提示词注入与 HTTP 路由。
 * skills / commands 是可选的，用 ctx.inject 动态等待，不能放进这里，
 * 否则宿主缺任一服务时整个插件都不会加载。
 */
export const inject = ['systemPrompt', 'webServer']

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))

/** 模块级活动实例：宿主 reload 重复 apply 时复用，避免重复 section（重名会抛）。 */
let active = null

/** 两模式都不是纯开关时也要能工作：所有状态变更统一走这里。 */
export function apply(ctx, config = {}) {
  if (active) {
    // 重复 apply（HMR / 配置重载）：不重复挂 section 与路由，只刷新一次文件缓存
    active.refresh()
    return
  }

  const cfg = config && typeof config === 'object' ? config : {}
  const pluginRoot = typeof cfg.pluginRoot === 'string' && cfg.pluginRoot.trim()
    ? path.resolve(cfg.pluginRoot.trim())
    : PLUGIN_ROOT
  const homeDir = settings.resolveHomeDir(cfg.homeDir)
  const log = createLogger(ctx)

  let state = settings.loadState(homeDir, cfg.defaults)
  let assets = prompts.readPromptAssets(pluginRoot, null)
  let scanned = skills.scanSkills(pluginRoot, (message) => log.warn(message))
  const skillsState = skills.emptySkillsState()
  let skillsCtx = null

  if (!assets.ok) log.warn(`[dsh-fuck] 提示词文件未就绪（${assets.missing.join(', ') || assets.errors.join('; ')}），注入会走降级文本`)

  // ---- 状态读取 / 变更 ----------------------------------------------------

  function currentMeta() {
    let promptBytes = 0
    try {
      promptBytes = Buffer.byteLength(buildPromptTextSafe(), 'utf8')
    } catch {
      promptBytes = 0
    }
    return api.buildMeta(state, {
      skills: skillsState.mounted,
      skillsMounted: skillsState.enabled === true && skillsState.ready === true,
      promptBytes,
      promptFilesOk: assets.ok !== false,
    })
  }

  function buildPromptTextSafe() {
    try {
      return prompts.buildPromptText(state, assets)
    } catch (error) {
      // assemble 期间抛错会让整轮模型请求失败，这里必须兜住
      log.warn(`[dsh-fuck] 拼装提示词失败：${errorMessage(error)}`)
      return ''
    }
  }

  /**
   * 解析 skills 服务：优先用 ctx.inject 回调给的子 ctx（真触发了就是最准的），
   * 否则用 ctx.get() 反射层兜底；都不行返回 null。
   *
   * 为什么不能直接 `ctx.skills`：真实 cordis 里未 inject 的服务属性读取会抛
   * `cannot get property ... without inject`；直接 duck-type `ctx.register` 同样会抛。
   * 所以一律走 skills.getService 的全 try/catch 路径。
   */
  function resolveSkillsRegistry() {
    if (skillsCtx) {
      const viaInject = skills.getService(skillsCtx, 'skills', ['register'])
      if (viaInject) return viaInject
    }
    return skills.getService(ctx, 'skills', ['register']) || null
  }

  /**
   * 同步技能挂载状态。**绝不抛**：服务不可用时降级为「技能未挂载」，
   * 让 API 的 toggle 永远能成功返回（state 与磁盘一致，meta 如实降级）。
   */
  function syncMounted() {
    try {
      const registry = resolveSkillsRegistry()
      return skills.syncSkills(registry || ctx, skillsState, state.reverse === true, {
        skills: scanned.skills,
        // 显式传 service（null = 已确认不可用），避免 syncSkills 再对 ctx 做属性探测
        service: registry,
        log: (message) => log.warn(message),
      })
    } catch (error) {
      // 兜底：技能同步绝不允许打断设置保存 / API 响应
      log.warn(`[dsh-fuck] 同步技能失败（已降级为未挂载）：${errorMessage(error)}`)
      return { mounted: false, count: 0, serviceReady: false, changed: false, reason: 'sync-error' }
    }
  }

  function commit(nextState) {
    state = settings.normalizeState(nextState, state)
    let saved = true
    try {
      settings.saveState(homeDir, state)
    } catch (error) {
      // 写盘失败只降级为内存态：用户刚点的开关至少在当前进程里生效
      saved = false
      log.warn(`[dsh-fuck] 保存设置失败：${errorMessage(error)}`)
    }
    // 状态已经落盘；技能同步是附属能力，失败只 warn，不能把 API 变成 500
    syncMounted()
    return { state, meta: currentMeta(), saved }
  }

  /** 合并 patch：reverseTools 是子对象，不能整块覆盖（否则会丢另外两个路径）。 */
  function mergePatch(patch) {
    const next = { ...state, ...patch }
    if (patch && patch.reverseTools && typeof patch.reverseTools === 'object' && !Array.isArray(patch.reverseTools)) {
      next.reverseTools = { ...state.reverseTools, ...patch.reverseTools }
    }
    return next
  }

  /**
   * 真实宿主内自检：调用一次 `ctx.systemPrompt.assemble()`，确认本插件注册的
   * `dsh-fuck:modes` section 真的进了 assembly。
   *
   * 为什么必须自己 catch：这个接口是给最终验证用的，assemble 受会话/预设/其他
   * 插件影响，任何异常都只能变成 `error` 字段，不能把宿主或验证脚本带崩。
   */
  async function runSelfTest() {
    const empty = {
      sectionPresent: false,
      sectionChars: 0,
      sectionHead: '',
      promptChars: 0,
      error: null,
    }
    try {
      const promptService = ctx.systemPrompt
      if (!promptService || typeof promptService.assemble !== 'function') {
        return { ...empty, error: 'systemPrompt.assemble 不可用（宿主版本不支持）' }
      }
      const assembly = await promptService.assemble()
      const sections = Array.isArray(assembly && assembly.sections) ? assembly.sections : []
      const own = sections.find((section) => section && section.name === 'dsh-fuck:modes')
      const sectionText = own && typeof own.text === 'string' ? own.text : ''
      // promptChars 近似整份系统提示词：sections 原文按 renderPrompt 的规则用空行拼接。
      // 真正的 renderPrompt 还会对其他 section 做变量插值，这里只求数量级证据。
      const promptChars = sections
        .map((section) => (section && typeof section.text === 'string' ? section.text : ''))
        .filter((text) => text.length > 0)
        .join('\n\n')
        .length
      return {
        sectionPresent: Boolean(own),
        sectionChars: sectionText.length,
        // 前 120 字符、换行压成空格，方便 curl 输出单行阅读
        sectionHead: sectionText.slice(0, 120).replace(/[\r\n]+/g, ' '),
        promptChars,
        error: null,
      }
    } catch (error) {
      return { ...empty, error: errorMessage(error) }
    }
  }

  const deps = {
    get: async () => ({ state, meta: currentMeta() }),
    set: async (patch) => commit(mergePatch(patch)),
    toggle: async (key) => {
      if (key !== 'breakArmor' && key !== 'reverse') {
        throw new Error(`不支持切换的键：${key || '(缺失)'}（仅 breakArmor / reverse）`)
      }
      return commit({ ...state, [key]: state[key] !== true })
    },
    reset: async () => commit(settings.cloneDefaults()),
    reload: async () => {
      // 强制重读：用户在内容目录里改了 md 后点「重新载入」
      assets = prompts.readPromptAssets(pluginRoot, null)
      scanned = skills.scanSkills(pluginRoot, (message) => log.warn(message))
      syncMounted()
      return { state, meta: currentMeta() }
    },
    // 真实宿主内自检（/dsh-fuck/api?selftest=1 或 {op:'selftest'}）
    selftest: async () => runSelfTest(),
  }

  // ---- systemPrompt section ----------------------------------------------

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-fuck:modes',
    order: 5100,
    // 人格正文里可能出现 {{...}}，不能被宿主的变量插值解释
    interpolate: false,
    text: () => buildPromptTextSafe(),
  }))

  // ---- HTTP API -----------------------------------------------------------

  ctx.effect(() => {
    const dispose = api.registerApi(ctx, deps)
    return typeof dispose === 'function' ? dispose : () => {}
  })

  // ---- 可选服务：skills ---------------------------------------------------

  installOptional(ctx, ['skills'], (inner) => {
    skillsCtx = inner
    syncMounted()
    return () => {
      if (skillsCtx === inner) skillsCtx = null
      skills.disposeMounted(skillsState)
    }
  }, log)

  // 服务可能在 apply 前就已就绪，或 inject 回调是异步触发的；这里主动同步一次，
  // 重复调用由 fingerprint 保证幂等（reverse 关闭时只是空操作）。
  syncMounted()

  // ---- 可选服务：commands（/dual） ----------------------------------------

  installOptional(ctx, ['commands'], (inner) => {
    const dispose = inner.commands.register({
      name: 'dual',
      description: '插件设置面板：查看或切换破甲 / 逆向模式（/dual status|break on|off|rev on|off|reset）',
      input: { hint: '[status|break on|off|rev on|off|reset]' },
      handler: ({ rawInput }) => handleDualCommand(String(rawInput ?? '')),
    })
    return typeof dispose === 'function' ? dispose : undefined
  }, log)

  // ---- 生命周期 ------------------------------------------------------------

  ctx.effect(() => () => {
    skills.disposeMounted(skillsState)
    skillsCtx = null
    if (active && active.ctx === ctx) active = null
    log.info('[dsh-fuck] unmounted')
  })

  const runtime = {
    ctx,
    // 重复 apply 时刷新磁盘内容（技能/提示词可能在内容 teammate 更新后变了）
    refresh() {
      assets = prompts.readPromptAssets(pluginRoot, null)
      scanned = skills.scanSkills(pluginRoot, (message) => log.warn(message))
      syncMounted()
    },
  }
  active = runtime

  // ---- /dual 命令实现 ------------------------------------------------------

  function statusText() {
    const mountedText = skillsState.mounted.length > 0
      ? `已挂载 ${skillsState.mounted.length} 个`
      : skillsState.enabled === true && skillsState.ready !== true
        ? '技能服务不可用'
        : '未挂载'
    return [
      `破甲模式：${state.breakArmor ? '开' : '关'}`,
      `逆向模式：${state.reverse ? '开' : '关'}`,
      `输出语言：${state.language === 'zh' ? '中文' : state.language === 'en' ? 'English' : '跟随用户'}`,
      `称呼：${state.userName}（每句加称呼=${state.addressEverySentence ? '是' : '否'}）`,
      `逆向技能：${mountedText}`,
      '设置文件：$DSH_HOME/dsh-fuck/settings.json',
    ].join('\n')
  }

  function handleDualCommand(raw) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    const verb = tokens[0] || ''
    const arg = (tokens[1] || '').toLowerCase()
    try {
      if (!verb || verb === 'status') {
        return { kind: 'success', text: statusText() }
      }
      if (verb === 'break' || verb === 'rev') {
        const key = verb === 'break' ? 'breakArmor' : 'reverse'
        if (arg === 'on' || arg === 'off') {
          commit({ ...state, [key]: arg === 'on' })
        } else if (!arg) {
          commit({ ...state, [key]: !state[key] })
        } else {
          return { kind: 'error', text: `用法：/dual ${verb} on|off` }
        }
        return { kind: 'success', text: statusText() }
      }
      if (verb === 'reset') {
        commit(settings.cloneDefaults())
        return { kind: 'success', text: `已恢复默认设置。\n${statusText()}` }
      }
      return { kind: 'error', text: `未知子命令：${verb}\n用法：/dual status | break on|off | rev on|off | reset` }
    } catch (error) {
      return { kind: 'error', text: errorMessage(error) }
    }
  }

  log.info(`[dsh-fuck] mounted (breakArmor=${state.breakArmor}, reverse=${state.reverse}, skills=${skillsState.mounted.length})`)
}

/** 安装可选服务注入；回调返回值作为清理函数绑定到该 fiber 上。 */
function installOptional(ctx, services, body, log) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(services, (inner) => {
      try {
        const cleanup = body(inner)
        if (typeof cleanup === 'function' && inner && typeof inner.effect === 'function') {
          inner.effect(() => cleanup)
        }
      } catch (error) {
        // 可选服务（skills/commands）装配失败不应让宿主崩溃，只记一条日志
        log.warn(`[dsh-fuck] 可选服务 ${services.join(',')} 装配失败：${errorMessage(error)}`)
      }
    })
  } catch (error) {
    log.warn(`[dsh-fuck] 注入可选服务 ${services.join(',')} 失败：${errorMessage(error)}`)
  }
}

/** 宿主 logger 优先，缺失/异常时退回 console（debug 不落地，避免刷屏）。 */
function createLogger(ctx) {
  let logger = null
  try {
    logger = ctx && typeof ctx.logger === 'function' ? ctx.logger('dsh-fuck') : null
  } catch {
    logger = null
  }
  const emit = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') {
        logger[level](message)
        return
      }
    } catch {
      /* logger 自己坏了也不能影响插件 */
    }
    if (level === 'warn' || level === 'error') console.warn(message)
    else if (level === 'info') console.log(message)
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    debug: (message) => emit('debug', message),
    error: (message) => emit('error', message),
  }
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
