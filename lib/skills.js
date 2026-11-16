/**
 * dsh-fuck 逆向技能同步。
 *
 * 为什么不用 `ctx.skills.registerProvider`：我们只有 8 个静态 markdown，运行时
 * `register()` 更直接，disposer 就足以完成「关闭逆向模式即卸载」。
 *
 * 为什么扫描结果要算 fingerprint：宿主 reload / 用户点「重新载入」时都会调
 * syncSkills；指纹相同就保持现状（幂等），不同才整体卸载重挂，避免目录里
 * 改了正文却仍用旧内容。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SKILL_FILE = 'SKILL.md'
export const MAX_SKILL_BYTES = 256 * 1024

/** 与官方 @deepseek-ai/dsh-skill 的 isSkillName 一致。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name)
}

/**
 * 拆 YAML frontmatter。只支持本插件内容契约用到的极简子集：`---` 包围、
 * 单行 key: value、可选引号，不引入 YAML 依赖。
 * @returns {{head: string, body: string} | null}
 */
export function splitFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return null
  const afterOpen = text.slice(3)
  if (!/^\r?\n/.test(afterOpen)) return null
  const rest = afterOpen.replace(/^\r?\n/, '')
  const close = rest.match(/\r?\n---(?:\r?\n|$)/)
  if (!close || close.index === undefined) return null
  return {
    head: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  }
}

function yamlLineField(head, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm')
  const match = String(head || '').match(re)
  if (!match) return ''
  const value = match[1].trim()
  if (!value) return ''
  if (value === '|' || value === '>' || value === '|-' || value === '>-') return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try {
        return String(JSON.parse(value))
      } catch {
        return value.slice(1, -1)
      }
    }
    return value.slice(1, -1)
  }
  const comment = value.indexOf(' #')
  return (comment >= 0 ? value.slice(0, comment) : value).trim()
}

/** 严格布尔：只认 true/false（忽略大小写）；其余视为非法。 */
function yamlBoolField(head, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm')
  const match = String(head || '').match(re)
  if (!match) return { present: false, value: undefined, invalid: false }
  let value = match[1].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim()
  }
  const comment = value.indexOf(' #')
  if (comment >= 0) value = value.slice(0, comment).trim()
  const norm = value.toLowerCase()
  if (norm === 'true') return { present: true, value: true, invalid: false }
  if (norm === 'false') return { present: true, value: false, invalid: false }
  return { present: true, value: undefined, invalid: true }
}

/**
 * 解析一个 SKILL.md。
 * @returns {{ok: true, name: string, description: string, whenToUse: string, modelInvocable: boolean, userInvocable: boolean, content: string}
 *   | {ok: false, error: string}}
 */
export function parseSkillDocument(raw) {
  const parts = splitFrontmatter(raw)
  if (!parts) return { ok: false, error: '缺少 YAML frontmatter（须以 --- 包围）' }
  const name = yamlLineField(parts.head, 'name')
  if (!isSkillName(name)) return { ok: false, error: `frontmatter.name 不是 kebab-case：${name || '(缺失)'}` }
  const whenToUse = yamlLineField(parts.head, 'whenToUse')
  // description 缺失时不丢弃技能：用 whenToUse/name 兜底，至少还能被目录发现。
  const description = yamlLineField(parts.head, 'description') || whenToUse || name
  const disableModel = yamlBoolField(parts.head, 'disable-model-invocation')
  const userInvocable = yamlBoolField(parts.head, 'user-invocable')
  if (disableModel.invalid) return { ok: false, error: 'disable-model-invocation 必须是 true/false' }
  if (userInvocable.invalid) return { ok: false, error: 'user-invocable 必须是 true/false' }
  return {
    ok: true,
    name,
    description,
    whenToUse,
    modelInvocable: disableModel.value !== true,
    userInvocable: userInvocable.value !== false,
    content: parts.body.replace(/^\r?\n/, '').trimEnd(),
  }
}

/**
 * 扫描 `<pluginRoot>/skills/<id>/SKILL.md`。
 * 非法项记入 skipped（调用方决定是否打日志），永不抛错。
 * @param {string} pluginRoot
 * @param {(message: string) => void} [log]
 * @returns {{skills: Array<object>, skipped: Array<{file: string, reason: string}>}}
 */
export function scanSkills(pluginRoot, log = () => {}) {
  const root = path.join(String(pluginRoot || ''), 'skills')
  const skills = []
  const skipped = []
  const seen = new Set()
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { skills, skipped }
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)))

  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue
    const dirName = String(entry.name)
    if (dirName.startsWith('.')) continue
    const file = path.join(root, dirName, SKILL_FILE)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue // 没有 SKILL.md 的目录直接忽略，不算错误
    }
    if (!stat.isFile()) continue
    if (stat.size > MAX_SKILL_BYTES) {
      skipped.push({ file, reason: `超过 ${MAX_SKILL_BYTES} 字节上限` })
      log(`[dsh-fuck] 跳过技能 ${dirName}：文件超过 ${MAX_SKILL_BYTES} 字节`)
      continue
    }
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      skipped.push({ file, reason: errorMessage(error) })
      log(`[dsh-fuck] 跳过技能 ${dirName}：读取失败（${errorMessage(error)}）`)
      continue
    }
    const parsed = parseSkillDocument(raw)
    if (!parsed.ok) {
      skipped.push({ file, reason: parsed.error })
      log(`[dsh-fuck] 跳过技能 ${dirName}：${parsed.error}`)
      continue
    }
    if (parsed.name !== dirName) {
      log(`[dsh-fuck] 技能目录名与 frontmatter.name 不一致：${dirName} ≠ ${parsed.name}，以 frontmatter 为准`)
    }
    if (seen.has(parsed.name)) {
      skipped.push({ file, reason: `技能名重复：${parsed.name}` })
      log(`[dsh-fuck] 跳过重复技能 ${parsed.name}（${file}）`)
      continue
    }
    seen.add(parsed.name)
    skills.push({
      name: parsed.name,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      content: parsed.content,
      invocation: {
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
      },
      path: file,
    })
  }

  return { skills, skipped }
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

/** 技能内容的稳定指纹：名字 + 正文，顺序无关。 */
export function fingerprintSkills(skills) {
  const hash = crypto.createHash('sha1')
  const sorted = [...(Array.isArray(skills) ? skills : [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  for (const skill of sorted) {
    hash.update(String(skill.name))
    hash.update('\u0000')
    hash.update(String(skill.content ?? ''))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/** 空挂载状态；index.js / 测试都从它开始。 */
export function emptySkillsState() {
  return { mounted: [], fingerprint: '', ready: false, enabled: false }
}

/**
 * 安全取 cordis 服务，任何情况下都不抛。
 *
 * 为什么需要这个：cordis 的 ctx 是 Proxy，**读取未 inject 的服务属性会抛**
 * `cannot get property "xxx" without inject`；更隐蔽的是对 ctx 本身做
 * duck-typing（`typeof ctx.register === 'function'`）也会触发同样的错误——
 * `register` 会被当成服务名去解析。因此这里：
 *   ① 优先 `ctx.get(name)`（反射层，不要求 inject，dsh-purge 取 agentPresets 同款）
 *   ② 再 try 属性读取
 *   ③ 对拿到的值用 try 逐方法探测（服务本身也可能是会抛的代理）
 * 全部失败返回 undefined。
 *
 * @param {object} ctxLike - host ctx，或已经是某个服务对象
 * @param {string} name - 服务名，如 'skills'
 * @param {string[]} [methods] - 必须存在的方法名；缺一个就视为不可用
 */
export function getService(ctxLike, name, methods = []) {
  if (!ctxLike || typeof name !== 'string' || !name) return undefined
  const required = (Array.isArray(methods) ? methods : [methods]).filter((method) => typeof method === 'string')
  const usable = (candidate) => {
    if (!candidate) return false
    if (typeof candidate !== 'object' && typeof candidate !== 'function') return false
    for (const method of required) {
      try {
        if (typeof candidate[method] !== 'function') return false
      } catch {
        // 服务代理上取方法也会抛，视为不可用
        return false
      }
    }
    return true
  }
  try {
    if (typeof ctxLike.get === 'function') {
      const svc = ctxLike.get(name)
      if (usable(svc)) return svc
    }
  } catch {
    /* 未 inject / 反射层不可用，继续走属性兜底 */
  }
  try {
    const svc = ctxLike[name]
    if (usable(svc)) return svc
  } catch {
    /* cordis 代理属性读取会抛 */
  }
  return undefined
}

/**
 * 安全取 `skills` 服务。接受 ctx 或「已经是 skills 服务」两种入参，方便单测。
 * 注意 duck-type 必须包在 try 里：对真实 ctx 读 `.register` 会抛。
 */
export function resolveSkillsService(ctxLike) {
  if (!ctxLike) return null
  try {
    if (typeof ctxLike.register === 'function') return ctxLike
  } catch {
    // ctx 代理：读未知属性 = 取名为 register 的服务 → 抛
  }
  return getService(ctxLike, 'skills', ['register']) || null
}

/** 卸载全部已挂技能；返回卸载数量。重复调用安全。 */
export function disposeMounted(state) {
  const mounted = state && Array.isArray(state.mounted) ? state.mounted : []
  const count = mounted.length
  for (const entry of mounted) {
    try {
      if (typeof entry.dispose === 'function') entry.dispose()
    } catch (error) {
      // 单个 disposer 失败不能阻止其它技能卸载
      console.warn(`[dsh-fuck] 卸载技能失败 ${entry.name}：${errorMessage(error)}`)
    }
  }
  if (state) {
    state.mounted = []
    state.fingerprint = ''
    state.ready = false
  }
  return count
}

/**
 * 把逆向技能同步到宿主：enabled=true 挂载，false 卸载；重复调用幂等。
 *
 * @param {object} ctxLike - 宿主 ctx 或已经是 skills 服务
 * @param {{mounted: Array, fingerprint?: string, ready?: boolean, enabled?: boolean}} state - 可变挂载状态
 * @param {boolean} enabled - 是否挂载（通常取 state.reverse）
 * @param {{skills?: Array, service?: object|null, log?: (message: string) => void}} [options]
 *   service 显式传入已解析好的 skills 服务（null 表示确认不可用，不再探测 ctx）；
 *   不传才回退到 resolveSkillsService(ctxLike)。
 * @returns {{mounted: boolean, count: number, serviceReady: boolean, changed: boolean, reason?: string}}
 */
export function syncSkills(ctxLike, state, enabled, options = {}) {
  const target = state && typeof state === 'object' ? state : emptySkillsState()
  if (!Array.isArray(target.mounted)) target.mounted = []
  const log = typeof options.log === 'function' ? options.log : () => {}
  const list = Array.isArray(options.skills) ? options.skills : []
  const want = enabled === true
  target.enabled = want

  if (!want) {
    const disposed = disposeMounted(target)
    target.enabled = false
    return { mounted: false, count: 0, serviceReady: false, changed: disposed > 0 }
  }

  // service 显式传入时不再探测 ctx：调用方（index.js）已用 getService 安全解析过
  const service = Object.prototype.hasOwnProperty.call(options, 'service')
    ? options.service
    : resolveSkillsService(ctxLike)
  if (!service) {
    disposeMounted(target)
    target.enabled = true
    log('[dsh-fuck] skills 服务不可用：逆向模式仍生效，技能暂不挂载')
    return { mounted: false, count: 0, serviceReady: false, changed: false, reason: 'skills-service-missing' }
  }

  const fingerprint = fingerprintSkills(list)
  if (target.mounted.length > 0 && target.fingerprint === fingerprint) {
    target.ready = true
    target.enabled = true
    return { mounted: true, count: target.mounted.length, serviceReady: true, changed: false }
  }

  disposeMounted(target)
  target.ready = true
  target.enabled = true
  for (const skill of list) {
    try {
      const dispose = service.register({
        name: String(skill.name),
        description: String(skill.description ?? ''),
        ...(skill.whenToUse ? { whenToUse: String(skill.whenToUse) } : {}),
        content: String(skill.content ?? ''),
        invocation: skill.invocation && typeof skill.invocation === 'object'
          ? {
            modelInvocable: skill.invocation.modelInvocable !== false,
            userInvocable: skill.invocation.userInvocable !== false,
          }
          : { modelInvocable: true, userInvocable: true },
      })
      target.mounted.push({
        name: String(skill.name),
        description: String(skill.description ?? ''),
        whenToUse: skill.whenToUse ?? '',
        dispose: typeof dispose === 'function' ? dispose : null,
      })
    } catch (error) {
      log(`[dsh-fuck] 注册技能失败 ${skill.name}：${errorMessage(error)}`)
    }
  }
  target.fingerprint = fingerprint
  return { mounted: target.mounted.length > 0, count: target.mounted.length, serviceReady: true, changed: true }
}
