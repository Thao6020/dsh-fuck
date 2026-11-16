#!/usr/bin/env node
/**
 * dsh-fxxk 插件静态体检 —— verify 用（SPEC §3 / §7）。
 *
 * 为什么不用 YAML 库解析 cordis.patch.yml：插件不允许引入 npm 依赖，宿主 profile
 * 的 patch 语法又只用到很小的子集（insert 列表 + id/name）。这里用纯文本断言
 * 「结构像 patch、插入项 id/name 与 package.json 对齐」，配合真实宿主 boot 的
 * 端到端验证（scripts/e2e-web.ps1）兜住语法错误。
 *
 * 用法：
 *   node test/check-plugin.mjs [--root <插件根>] [--json]
 * 退出码：0 = 全部通过；1 = 有 FAIL。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_SKILL_BYTES = 256 * 1024

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') options.root = resolve(argv[++i])
    else if (arg.startsWith('--root=')) options.root = resolve(arg.slice('--root='.length))
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node test/check-plugin.mjs [--root <plugin-root>] [--json]')
      process.exit(0)
    } else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function existsFile(file) {
  return existsSync(file) && statSync(file).isFile()
}

/**
 * 极简 patch 结构解析：只认「顶层数组 + - insert: + 缩进 id/name」这种宿主
 * 实际消费的形状，逐行扫，返回插入项列表与结构问题；不做通用 YAML。
 */
function parsePatch(text) {
  const problems = []
  const inserts = []
  const lines = text.split(/\r?\n/)
  let inInsert = false
  let current = null
  let sawTopLevel = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    // 顶层（无缩进）条目：`- insert:` 进入插入块，其它形态合法但不深入校验。
    if (indent === 0 && /^-\s*insert:\s*$/.test(trimmed)) {
      sawTopLevel = true
      inInsert = true
      current = null
      continue
    }
    if (indent === 0 && /^-\s+/.test(trimmed)) {
      sawTopLevel = true
      inInsert = false
      current = null
      continue
    }
    if (!inInsert) continue
    // 插入块内部（有缩进）：`- id: x` 开新条目，`name: y` 归到当前条目。
    const idMatch = /^-\s+id:\s*(.+)$/.exec(trimmed)
    if (idMatch) {
      current = { id: unquote(idMatch[1]), name: null }
      inserts.push(current)
      continue
    }
    const nameMatch = /^name:\s*(.+)$/.exec(trimmed)
    if (nameMatch && current) current.name = unquote(nameMatch[1])
  }
  if (!sawTopLevel) problems.push('文件里没有顶层 `- ` 条目（patch 应是 YAML 数组）')
  if (inserts.length === 0) problems.push('没有找到 `- insert:` 下的插件条目')
  for (const entry of inserts) {
    if (!entry.id) problems.push('insert 条目缺 id')
    if (!entry.name) problems.push(`insert 条目 ${entry.id ?? '(?)'} 缺 name`)
  }
  return { inserts, problems }
}

function unquote(value) {
  return String(value).trim().replace(/^['"]|['"]$/g, '')
}

/** 解析 SKILL.md frontmatter（只取简单 key: value 行，足够本插件用）。 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { fields: null, body: text }
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]] = unquote(kv[2])
  }
  return { fields, body: text.slice(match[0].length) }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = options.root
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail })

  // ---- package.json ------------------------------------------------------
  const manifestPath = join(root, 'package.json')
  let manifest = null
  if (!existsFile(manifestPath)) {
    add('package.json 存在', false, manifestPath)
  } else {
    try {
      manifest = readJson(manifestPath)
      add('package.json 可解析', true)
    } catch (error) {
      add('package.json 可解析', false, error.message)
    }
  }

  const packageName = manifest?.name
  if (manifest) {
    add('name 为 dsh-fxxk', manifest.name === 'dsh-fxxk', String(manifest.name))
    add('version 存在', typeof manifest.version === 'string' && manifest.version.length > 0, String(manifest.version))
    add('type=module', manifest.type === 'module', String(manifest.type))
    add('exports["."] 指向 index.js', manifest.exports?.['.'] === './index.js', String(manifest.exports?.['.']))
    add('exports["./client"] 指向 client.js', manifest.exports?.['./client'] === './client.js', String(manifest.exports?.['./client']))
    add('dsh.bundle.patch 声明', typeof manifest.dsh?.bundle?.patch === 'string', String(manifest.dsh?.bundle?.patch))
    add('dsh.client.platform=web', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
    add('dsh.client.immediately=true', manifest.dsh?.client?.immediately === true, String(manifest.dsh?.client?.immediately))
    add('dsh.client.inject 含 conversation UI',
      Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
      JSON.stringify(manifest.dsh?.client?.inject))
  }

  // ---- cordis.patch.yml --------------------------------------------------
  const patchPath = join(root, manifest?.dsh?.bundle?.patch ?? 'cordis.patch.yml')
  if (!existsFile(patchPath)) {
    add('cordis.patch.yml 存在', false, patchPath)
  } else {
    const patchText = readFileSync(patchPath, 'utf8')
    const parsed = parsePatch(patchText)
    add('cordis.patch.yml 结构可解析', parsed.problems.length === 0, parsed.problems.join('；'))
    const selfEntry = parsed.inserts.find((entry) => entry.name === packageName || entry.id === packageName)
    add('patch 插入自身 bundle', Boolean(selfEntry), JSON.stringify(parsed.inserts))
  }

  // ---- index.js（宿主入口）------------------------------------------------
  const indexFile = join(root, manifest?.exports?.['.']?.replace('./', '') ?? 'index.js')
  if (!existsFile(indexFile)) {
    add('index.js 存在', false, indexFile)
  } else {
    try {
      const module = await import(pathToFileURL(indexFile).href)
      add('index.js 导出 apply()', typeof module.apply === 'function', typeof module.apply)
      const inject = module.inject
      const injectOk = Array.isArray(inject) && inject.includes('systemPrompt') && inject.includes('webServer')
      add('index.js inject 含 systemPrompt/webServer', injectOk, JSON.stringify(inject))
    } catch (error) {
      add('index.js 可 import', false, error.message)
    }
  }

  // ---- client.js（浏览器半侧）--------------------------------------------
  const clientFile = join(root, 'client.js')
  if (!existsFile(clientFile)) {
    add('client.js 存在', false, clientFile)
  } else {
    const clientText = readFileSync(clientFile, 'utf8')
    add('client.js 调用 window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\s*\(/.test(clientText))
    add('client.js 只用 require("react")', /require\(\s*['"]react['"]\s*\)/.test(clientText))
    add('client.js 无 ESM import（浏览器端）', !/^\s*import\s/m.test(clientText))
    add('client.js 的 module id 等于包名',
      new RegExp(`id:\\s*['"]${String(packageName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(clientText),
      packageName)
    // 0.2.2-rc.1 只在 conversation.input.dock 有 outlet；composer.dock 没渲染点。
    add('client.js 注册 conversation.input.dock', /conversation\.input\.dock/.test(clientText))
    // 新版 UI：设置按钮在 conversation.input.left（工具条），面板在 input.dock。
    add('client.js 注册 conversation.input.left（设置按钮）', /conversation\.input\.left/.test(clientText))
    add('client.js 设置按钮 aria-label 含 dsh-fxxk/插件设置',
      /aria-label['"]?\s*:\s*['"][^'"]*(?:dsh-fxxk|插件设置)/.test(clientText))
    add('client.js 不使用无 outlet 的 composer.dock',
      !/ctx\.slots\.inject\(\s*['"]conversation\.composer\.dock['"]/.test(clientText))
    add('client.js 注入 <style data-dsh-fxxk>', /data-dsh-fxxk/.test(clientText))
  }

  // ---- 宿主 API 路径 -----------------------------------------------------
  const apiFiles = [join(root, 'lib', 'api.js'), join(root, 'index.js')].filter(existsFile)
  const apiText = apiFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
  add('宿主注册 /dsh-fxxk/api 路由', /\/dsh-fxxk\/api/.test(apiText))
  add('宿主注册 systemPrompt section', /systemPrompt\.section/.test(readFileSync(join(root, 'index.js'), 'utf8')))

  // ---- prompts -----------------------------------------------------------
  const promptSpecs = [
    { file: join(root, 'prompts', 'break-armor.md'), minBytes: 3000, placeholder: '{{user}}' },
    { file: join(root, 'prompts', 'reverse.md'), minBytes: 2500, placeholder: '{{user}}' },
  ]
  for (const spec of promptSpecs) {
    const label = `prompts/${spec.file.split(/[\\/]/).pop()}`
    if (!existsFile(spec.file)) {
      add(`${label} 存在`, false)
      continue
    }
    const bytes = statSync(spec.file).size
    const text = readFileSync(spec.file, 'utf8')
    add(`${label} 大小合理`, bytes >= spec.minBytes, `${bytes} bytes`)
    add(`${label} 保留 ${spec.placeholder} 占位符`, text.includes(spec.placeholder))
  }

  // ---- skills ------------------------------------------------------------
  const skillsDir = join(root, 'skills')
  if (!existsSync(skillsDir)) {
    add('skills/ 目录存在', false)
  } else {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    add('skills 数量 ≥ 8', dirs.length >= 8, `${dirs.length} 个`)
    let valid = 0
    const problems = []
    for (const dir of dirs) {
      const skillFile = join(skillsDir, dir.name, 'SKILL.md')
      if (!existsFile(skillFile)) {
        problems.push(`${dir.name}: 缺 SKILL.md`)
        continue
      }
      const bytes = statSync(skillFile).size
      if (bytes > MAX_SKILL_BYTES) problems.push(`${dir.name}: 超过 256KB`)
      const text = readFileSync(skillFile, 'utf8')
      const { fields, body } = parseFrontmatter(text)
      if (!fields) {
        problems.push(`${dir.name}: frontmatter 缺失`)
        continue
      }
      if (fields.name !== dir.name) problems.push(`${dir.name}: name=${fields.name ?? '(空)'} 与目录名不一致`)
      if (!KEBAB.test(fields.name ?? '')) problems.push(`${dir.name}: name 不是 kebab-case`)
      if (!fields.description) problems.push(`${dir.name}: 缺 description`)
      if (!fields.whenToUse) problems.push(`${dir.name}: 缺 whenToUse`)
      if (!body || body.trim().length < 500) problems.push(`${dir.name}: 正文过短`)
      if (problems.length === 0 || !problems.some((problem) => problem.startsWith(`${dir.name}:`))) valid += 1
    }
    add('每个 SKILL.md 的 frontmatter/目录名/正文合规', problems.length === 0, problems.join('；') || `${valid} 个通过`)
  }

  // ---- 输出 --------------------------------------------------------------
  const failed = checks.filter((check) => !check.ok)
  if (options.json) {
    console.log(JSON.stringify({ root, ok: failed.length === 0, checks }, null, 2))
  } else {
    console.log(`[check-plugin] root=${root}`)
    for (const check of checks) {
      console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
    }
    console.log(`RESULT: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} 项)`}  ${checks.length} 项检查`)
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`[check-plugin] 致命错误：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
