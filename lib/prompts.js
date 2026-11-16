/**
 * dsh-fxxk 提示词拼装。
 *
 * 设计要点：
 * - `buildPromptText(state, assets)` 是纯函数：assets 已经是读进来的文本
 *   （`{ breakArmor, reverse }`），单测不需要碰磁盘。
 * - `readPromptAssets(pluginRoot, previous)` 负责读盘，按 mtime+size 复用上次
 *   结果，避免每次 assemble 都做真实 IO；reload 时传 null 强制重读。
 * - 任何文件缺失/超限都降级为一段「文件缺失」说明文本，绝不抛错让
 *   systemPrompt.assemble 崩掉。
 */

import fs from 'node:fs'
import path from 'node:path'

/** prompts/ 下的两个内容文件。 */
export const PROMPT_FILES = Object.freeze({
  breakArmor: 'break-armor.md',
  reverse: 'reverse.md',
})

/** 单个提示词文件上限：防止误放的超大文件拖慢每一次 assemble。 */
const MAX_PROMPT_BYTES = 512 * 1024

/** 工具路径留空时的统一文案（与 SPEC 第 4.2 节一致）。 */
export const MISSING_TOOL_TEXT = '未配置，按默认安装位置探测'

export function promptDir(pluginRoot) {
  return path.join(pluginRoot, 'prompts')
}

/**
 * 读取两套人格提示词。返回结构同时给 buildPromptText 和 API meta 用。
 * @param {string} pluginRoot - 插件根目录
 * @param {object|null} [previous] - 上次的返回值；mtime/size 未变时直接复用文本
 */
export function readPromptAssets(pluginRoot, previous = null) {
  const dir = promptDir(pluginRoot)
  const prev = previous && typeof previous === 'object' ? previous : null
  const assets = {
    breakArmor: '',
    reverse: '',
    ok: true,
    missing: [],
    errors: [],
    mtimes: {},
    sizes: {},
    dir,
  }

  for (const [key, file] of Object.entries(PROMPT_FILES)) {
    const abs = path.join(dir, file)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch (error) {
      assets.ok = false
      assets.missing.push(file)
      if (error && error.code !== 'ENOENT') assets.errors.push(`${file}: ${errorMessage(error)}`)
      continue
    }
    if (!stat.isFile()) {
      assets.ok = false
      assets.missing.push(file)
      continue
    }
    if (stat.size > MAX_PROMPT_BYTES) {
      assets.ok = false
      assets.errors.push(`${file}: 超过 ${MAX_PROMPT_BYTES} 字节上限，已跳过`)
      continue
    }
    const cached = prev
      && prev.mtimes
      && prev.mtimes[key] === stat.mtimeMs
      && prev.sizes
      && prev.sizes[key] === stat.size
      && typeof prev[key] === 'string'
    if (cached) {
      assets[key] = prev[key]
      assets.mtimes[key] = stat.mtimeMs
      assets.sizes[key] = stat.size
      continue
    }
    try {
      assets[key] = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')
      assets.mtimes[key] = stat.mtimeMs
      assets.sizes[key] = stat.size
    } catch (error) {
      assets.ok = false
      assets.errors.push(`${file}: ${errorMessage(error)}`)
    }
  }

  return assets
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

/** 只替换我们自己声明的占位符，其余 `{{...}}` 原样保留（section 设了 interpolate:false）。 */
function fillPlaceholders(text, values) {
  let out = String(text)
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value)
  }
  return out
}

function normalizeUser(state) {
  const raw = typeof state?.userName === 'string' ? state.userName.trim() : ''
  return raw ? raw.slice(0, 40) : 'THao'
}

function clampCustom(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed
}

/** 语言行：未知值一律当 auto，避免注入空行。 */
export function languageLine(language) {
  if (language === 'zh') return '输出语言：中文（代码/标识符/命令保持原样）'
  if (language === 'en') return 'Output language: English'
  return '输出语言跟随用户'
}

/**
 * 拼装最终注入文本。两模式全关返回空串（完全不注入）。
 * @param {object} state - 归一化后的设置状态
 * @param {{breakArmor?: string, reverse?: string}} [assets] - 已读取的人格文件正文
 * @returns {string}
 */
export function buildPromptText(state, assets = {}) {
  const s = state && typeof state === 'object' ? state : {}
  const breakArmor = s.breakArmor === true
  const reverse = s.reverse === true
  if (!breakArmor && !reverse) return ''

  const userName = normalizeUser(s)
  const parts = []

  parts.push([
    '## 插件设置面板（dsh-fxxk）',
    `当前：破甲模式=${breakArmor ? '开' : '关'}；逆向模式=${reverse ? '开' : '关'}；用户称呼=${userName}`,
  ].join('\n'))

  if (breakArmor) {
    const body = typeof assets?.breakArmor === 'string' ? assets.breakArmor : ''
    if (body.trim()) {
      parts.push(fillPlaceholders(body.trim(), { user: userName }))
    } else {
      parts.push('（降级：破甲人格文件 prompts/break-armor.md 缺失或不可读，本次只应用模式开关与补充指令。）')
    }
    const custom = clampCustom(s.customBreakArmor)
    if (custom) parts.push(`## 破甲补充指令\n${custom}`)
  }

  if (reverse) {
    const body = typeof assets?.reverse === 'string' ? assets.reverse : ''
    const tools = s.reverseTools && typeof s.reverseTools === 'object' ? s.reverseTools : {}
    const toolText = (value) => {
      if (typeof value !== 'string') return MISSING_TOOL_TEXT
      const trimmed = value.trim()
      return trimmed || MISSING_TOOL_TEXT
    }
    if (body.trim()) {
      parts.push(fillPlaceholders(body.trim(), {
        user: userName,
        ida: toolText(tools.ida),
        x64dbg: toolText(tools.x64dbg),
        ghidra: toolText(tools.ghidra),
      }))
    } else {
      parts.push('（降级：逆向人格文件 prompts/reverse.md 缺失或不可读，本次只应用模式开关与补充指令。）')
    }
    const custom = clampCustom(s.customReverse)
    if (custom) parts.push(`## 逆向补充指令\n${custom}`)
  }

  if (s.addressEverySentence === true) {
    parts.push([
      '## 输出称呼约束',
      `每句话的句首都必须以「${userName}」称呼用户，例如「${userName}，……」。代码块、命令、JSON、表格与文件名内部不加称呼；不要用其他称呼替换。`,
    ].join('\n'))
  }

  parts.push(languageLine(s.language))

  return parts.join('\n\n').trim()
}
