/**
 * dsh-fuck 设置存储：`$DSH_HOME/dsh-fuck/settings.json`
 *
 * 为什么所有字段都在 normalizeState 里逐项校验：设置既来自浏览器 POST，也可能
 * 被用户手工改过。宿主只信任自己的默认值，任何脏字段（null、超长、非法枚举、
 * 类型错乱）都回退到默认或截断，绝不让一个坏字段把 /dsh-fuck/api 打成 500。
 *
 * 为什么用「临时文件 + rename」：开关会高频写盘，进程被强杀时不能留下半截
 * JSON；rename 在 Windows 上走 MoveFileEx(REPLACE_EXISTING)，是原子的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const STATE_VERSION = 1

/** 字段长度上限，与客户端输入框的 maxlength 保持一致。 */
export const LIMITS = Object.freeze({
  userName: 40,
  custom: 4000,
  toolPath: 500,
})

export const LANGUAGES = Object.freeze(['auto', 'zh', 'en'])

/** 完整默认值。导出为只读，调用方要副本用 cloneDefaults()。 */
export const DEFAULTS = Object.freeze({
  version: STATE_VERSION,
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

/** 深拷贝一份默认值，避免调用方改动共享对象。 */
export function cloneDefaults() {
  return {
    ...DEFAULTS,
    reverseTools: { ...DEFAULTS.reverseTools },
  }
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 单行文本：trim 后为空则回退，超长截断。 */
function asText(value, fallback, max) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** 多行文本：允许为空串，只做 trim + 截断（保留换行）。 */
function asCustomText(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > LIMITS.custom ? trimmed.slice(0, LIMITS.custom) : trimmed
}

/** 工具路径允许为空串（表示「未配置」）。 */
function asToolPath(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length > LIMITS.toolPath ? trimmed.slice(0, LIMITS.toolPath) : trimmed
}

function asLanguage(value, fallback) {
  return LANGUAGES.includes(value) ? value : fallback
}

/** 把任意 base（可能是用户 config 传进来的默认值）规整成可信的兜底层。 */
function fallbackOf(base) {
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : {}
  const tools = b.reverseTools && typeof b.reverseTools === 'object' && !Array.isArray(b.reverseTools)
    ? b.reverseTools
    : {}
  return {
    breakArmor: asBool(b.breakArmor, DEFAULTS.breakArmor),
    reverse: asBool(b.reverse, DEFAULTS.reverse),
    userName: asText(b.userName, DEFAULTS.userName, LIMITS.userName),
    addressEverySentence: asBool(b.addressEverySentence, DEFAULTS.addressEverySentence),
    language: asLanguage(b.language, DEFAULTS.language),
    customBreakArmor: asCustomText(b.customBreakArmor, DEFAULTS.customBreakArmor),
    customReverse: asCustomText(b.customReverse, DEFAULTS.customReverse),
    reverseTools: {
      ida: asToolPath(tools.ida, ''),
      x64dbg: asToolPath(tools.x64dbg, ''),
      ghidra: asToolPath(tools.ghidra, ''),
    },
    showStatus: asBool(b.showStatus, DEFAULTS.showStatus),
  }
}

/**
 * 逐字段校验并回退。未知键被丢弃，返回值永远是完整状态对象。
 * @param {unknown} raw - 磁盘或网络来的原始数据。
 * @param {object} [base] - 第二层默认值（插件 config 里的初始值），缺省用 DEFAULTS。
 */
export function normalizeState(raw, base = DEFAULTS) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const f = fallbackOf(base)
  const toolsSource = source.reverseTools && typeof source.reverseTools === 'object' && !Array.isArray(source.reverseTools)
    ? source.reverseTools
    : null
  return {
    version: STATE_VERSION,
    breakArmor: asBool(source.breakArmor, f.breakArmor),
    reverse: asBool(source.reverse, f.reverse),
    userName: asText(source.userName, f.userName, LIMITS.userName),
    addressEverySentence: asBool(source.addressEverySentence, f.addressEverySentence),
    language: asLanguage(source.language, f.language),
    customBreakArmor: asCustomText(source.customBreakArmor, f.customBreakArmor),
    customReverse: asCustomText(source.customReverse, f.customReverse),
    reverseTools: toolsSource
      ? {
        ida: asToolPath(toolsSource.ida, f.reverseTools.ida),
        x64dbg: asToolPath(toolsSource.x64dbg, f.reverseTools.x64dbg),
        ghidra: asToolPath(toolsSource.ghidra, f.reverseTools.ghidra),
      }
      : { ...f.reverseTools },
    showStatus: asBool(source.showStatus, f.showStatus),
  }
}

/** 解析 $DSH_HOME：环境变量优先，回退 ~/.dsh（与官方宿主一致）。 */
export function defaultHomeDir() {
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return env || path.join(os.homedir(), '.dsh')
}

export function resolveHomeDir(homeDir) {
  const explicit = typeof homeDir === 'string' ? homeDir.trim() : ''
  return explicit || defaultHomeDir()
}

/** 本插件的数据目录：`$DSH_HOME/dsh-fuck`。 */
export function stateDir(homeDir) {
  return path.join(resolveHomeDir(homeDir), 'dsh-fuck')
}

/** 设置文件绝对路径：`$DSH_HOME/dsh-fuck/settings.json`。 */
export function statePath(homeDir) {
  return path.join(stateDir(homeDir), 'settings.json')
}

/** 损坏文件尽量备份，失败也不影响降级（best effort）。 */
function backupCorrupt(file) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.renameSync(file, `${file}.bak-${stamp}`)
    return `${file}.bak-${stamp}`
  } catch {
    return null
  }
}

/**
 * 读取状态。缺文件 → 默认值；损坏 → 备份后用默认值；任何异常都不抛。
 * @param {string} [homeDir] - $DSH_HOME，缺省走环境变量/用户目录。
 * @param {object} [configDefaults] - 插件 config 提供的初始默认值（可部分字段）。
 * @returns {object} 归一化后的完整状态
 */
export function loadState(homeDir, configDefaults) {
  const base = normalizeState(configDefaults, DEFAULTS)
  const file = statePath(homeDir)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return base
    const backup = backupCorrupt(file)
    console.warn(`[dsh-fuck] 读取设置失败（${file}）：${errorMessage(error)}；已用默认值${backup ? `，原文件备份为 ${backup}` : ''}`)
    return base
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json 顶层不是对象')
    }
    return normalizeState(parsed, base)
  } catch (error) {
    const backup = backupCorrupt(file)
    console.warn(`[dsh-fuck] settings.json 已损坏：${errorMessage(error)}；已用默认值${backup ? `，原文件备份为 ${backup}` : ''}`)
    return base
  }
}

/**
 * 原子写回状态（自动建目录）。返回实际写入的归一化状态。
 * @throws 写盘失败时抛错，由调用方决定是否只保留内存态。
 */
export function saveState(homeDir, state) {
  const normalized = normalizeState(state)
  const file = statePath(homeDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = `${JSON.stringify(normalized, null, 2)}\n`
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件可能根本没建成 */
    }
    throw error
  }
  return normalized
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
