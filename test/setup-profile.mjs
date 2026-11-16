#!/usr/bin/env node
/**
 * 测试 profile 搭建脚本（幂等）——默认创建/校正 `$DSH_HOME/profiles/dualtest`。
 *
 * 为什么单独写脚本而不是复制 profiles/web：
 *   - profiles/web 与 profiles/tauri 是用户真实配置，禁止读写其内容；
 *   - dualtest 只允许由本脚本从「骨架」生成，保证 e2e 可重复、可重置。
 *
 * 用法：
 *   node test/setup-profile.mjs                 # 不存在则创建；已存在则只补齐缺失骨架
 *   node test/setup-profile.mjs --reset         # 先整目录删除再重建（e2e 用）
 *   node test/setup-profile.mjs --profile dualtest
 *   node test/setup-profile.mjs --print         # 只打印目标路径与现状，不改盘
 *
 * 安全护栏：只允许在 `$DSH_HOME/profiles/<name>` 下操作，且拒绝 tauri/web/desktop
 * 这类真实 profile —— 脚本在错误参数下必须拒绝执行，而不是靠调用者自觉。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

/** 真实 profile 名，任何脚本都不得重置。 */
const RESERVED_PROFILES = new Set(['tauri', 'web', 'desktop'])

/** 每个 DSH profile 的最小骨架；bundles 至少要 base + web-app 才能起 `dsh web`。 */
const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const WORKSPACE_YAML = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

const PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`

function parseArgs(argv) {
  const options = { profile: 'dualtest', reset: false, print: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') options.profile = argv[++i]
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--reset') options.reset = true
    else if (arg === '--print') options.print = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node test/setup-profile.mjs [--profile <name>] [--reset] [--print] [--json]')
      process.exit(0)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  const home = fromEnv && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
  return resolve(home)
}

/** 校验 profile 名与目标路径，返回 { name, dshHome, profileDir }。 */
function resolveTargets(profileName) {
  const name = String(profileName ?? '').trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`非法 profile 名：${JSON.stringify(profileName)}`)
  if (RESERVED_PROFILES.has(name.toLowerCase())) {
    throw new Error(`拒绝操作真实 profile "${name}"：本脚本只允许操作测试 profile（如 dualtest）`)
  }
  const dshHome = resolveDshHome()
  const profilesDir = join(dshHome, 'profiles')
  const profileDir = resolve(profilesDir, name)
  // 防目录穿越：解析后必须仍是 profiles/<name> 的直接子目录。
  if (!profileDir.startsWith(profilesDir + sep) || dirname(profileDir) !== profilesDir) {
    throw new Error(`拒绝操作 profiles 目录之外的路径：${profileDir}`)
  }
  return { name, dshHome, profilesDir, profileDir }
}

/** 读 package.json；不存在或损坏返回 null。 */
function readManifest(profileDir) {
  const file = join(profileDir, 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 生成骨架 manifest：保留已有 dependencies（--reset 时为空）。 */
function buildManifest(name, previous) {
  const manifest = {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: previous?.dependencies && typeof previous.dependencies === 'object' ? previous.dependencies : {},
    dsh: {
      profile: {
        bundles: REQUIRED_BUNDLES.slice(),
        patchReload: 'live',
      },
    },
  }
  return manifest
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 补齐 bundle 选择（保留用户/其他脚本新增的 bundle，只追加缺失的必需项）。 */
function ensureBundles(manifest) {
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const added = []
  for (const name of REQUIRED_BUNDLES) {
    if (!bundles.includes(name)) {
      bundles.push(name)
      added.push(name)
    }
  }
  manifest.dsh.profile.bundles = bundles
  manifest.dsh.profile.patchReload ??= 'live'
  return added
}

export function setupProfile({ profile = 'dualtest', reset = false, print = false, json = false } = {}) {
  const { name, dshHome, profileDir } = resolveTargets(profile)
  const existsBefore = existsSync(profileDir)
  const actions = []

  if (print) {
    const manifest = readManifest(profileDir)
    const info = {
      dshHome,
      profile: name,
      profileDir,
      exists: existsBefore,
      bundles: manifest?.dsh?.profile?.bundles ?? null,
      dependencies: manifest?.dependencies ?? null,
    }
    if (json) console.log(JSON.stringify(info, null, 2))
    else {
      console.log(`DSH_HOME   : ${dshHome}`)
      console.log(`profile    : ${name}`)
      console.log(`目录       : ${profileDir} (${existsBefore ? '存在' : '不存在'})`)
      console.log(`bundles    : ${info.bundles ? info.bundles.join(', ') : '(无 package.json)'}`)
      console.log(`依赖       : ${info.dependencies ? Object.keys(info.dependencies).join(', ') || '(空)' : '(无 package.json)'}`)
    }
    return info
  }

  if (reset && existsBefore) {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
    actions.push(`已删除旧 profile 目录：${profileDir}`)
  }

  ensureDir(profileDir)

  const manifestFile = join(profileDir, 'package.json')
  const previous = existsSync(manifestFile) ? readManifest(profileDir) : null
  let manifest = previous
  if (!manifest) {
    manifest = buildManifest(name, null)
    actions.push('写入 package.json 骨架')
  } else {
    const added = ensureBundles(manifest)
    if (added.length > 0) actions.push(`package.json 追加必需 bundle：${added.join(', ')}`)
    if (manifest.name !== `dsh-profile-${name}`) {
      manifest.name = `dsh-profile-${name}`
      actions.push(`package.json name 校正为 dsh-profile-${name}`)
    }
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    if (manifest.dsh.profile.patchReload === undefined) manifest.dsh.profile.patchReload = 'live'
  }
  // 重置时把 bundles 精确收敛到骨架（避免残留插件 bundle 影响首启）。
  if (reset) {
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    manifest.dsh.profile.bundles = REQUIRED_BUNDLES.slice()
    manifest.dsh.profile.patchReload = 'live'
    manifest.dependencies = {}
    actions.push('重置 bundles 为骨架（base + web-app）')
  }
  writeJson(manifestFile, manifest)

  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (reset || !existsSync(patchFile)) {
    writeFileSync(patchFile, `${PATCH_HEADER}[]\n`, 'utf8')
    actions.push('写入最小 cordis.patch.yml（[]）')
  }

  const workspaceFile = join(profileDir, 'pnpm-workspace.yaml')
  if (reset || !existsSync(workspaceFile)) {
    writeFileSync(workspaceFile, WORKSPACE_YAML, 'utf8')
    actions.push('写入 pnpm-workspace.yaml')
  }

  const info = {
    dshHome,
    profile: name,
    profileDir,
    created: reset || !existsBefore,
    actions,
  }
  if (json) console.log(JSON.stringify(info, null, 2))
  else {
    console.log(`[setup-profile] profile=${name} dir=${profileDir}`)
    if (actions.length === 0) console.log('  骨架已完整，无需改动')
    for (const action of actions) console.log(`  - ${action}`)
  }
  return info
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    setupProfile(options)
  } catch (error) {
    console.error(`[setup-profile] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// 仅在被直接执行时运行，便于测试或其他脚本 import。
const invokedDirectly = process.argv[1] && isAbsolute(process.argv[1])
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false
if (invokedDirectly) main()

export { PLUGIN_ROOT, resolveTargets, RESERVED_PROFILES }
