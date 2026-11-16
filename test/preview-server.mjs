#!/usr/bin/env node
/**
 * dsh-fuck 预览服务器。
 *
 * 作用：不启动真实 DSH 宿主，也能用无头 Edge 截图 / 手工检查 dock UI。
 *   1. 静态服务 test/out：/dock-collapsed.html（首页默认，工具条只有小图标按钮）、
 *      /dock-open.html（设置面板展开）、旧别名 /preview.html、/preview-default.html。
 *   2. mock 掉 GET/POST /dsh-fuck/api：内存状态，支持 set / toggle / reset / reload，
 *      响应形状与宿主 lib/api.js 的契约一致（{ok,state,meta}）。
 *
 * 运行：node test/preview-server.mjs
 *       node test/preview-server.mjs --selftest   # 起服务→自测接口→退出（CI 用）
 * 端口：默认 127.0.0.1:3097，可用 DSH_FUCK_PREVIEW_PORT 覆盖。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, 'out')
const HOST = '127.0.0.1'
const PORT = Number(process.env.DSH_FUCK_PREVIEW_PORT || 3097)
const API_PATH = '/dsh-fuck/api'
const MAX_BODY_BYTES = 64 * 1024

/* ---------------------------------------------------------------- 状态 */

/** 与宿主 lib/settings.js 的 DEFAULTS 对齐。 */
const DEFAULTS = {
  version: 1,
  breakArmor: false,
  reverse: false,
  userName: 'THao',
  addressEverySentence: true,
  language: 'auto',
  customBreakArmor: '',
  customReverse: '',
  reverseTools: { ida: '', x64dbg: '', ghidra: '' },
  showStatus: true,
}

const SKILLS = [
  { name: 'rev-workflow', description: '逆向总流程与交付标准' },
  { name: 'rev-pe-recon', description: 'PE / EXE 静态侦察' },
  { name: 'rev-ida', description: 'IDA Pro 静态分析' },
  { name: 'rev-x64dbg', description: 'x64dbg 动态调试' },
  { name: 'rev-unpack', description: '壳 / 混淆识别与脱壳' },
  { name: 'rev-dotnet-unity', description: '.NET / Unity il2cpp 逆向' },
  { name: 'rev-patch', description: '补丁 / 注册机 / license 校验分析' },
  { name: 'rev-malware', description: '恶意样本分析' },
]

const clampString = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

/** 模拟宿主对 patch 的逐字段校验/回退，保证 mock 与真实行为一致。 */
function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const tools = source.reverseTools && typeof source.reverseTools === 'object' ? source.reverseTools : {}
  const language = source.language === 'zh' || source.language === 'en' ? source.language : 'auto'
  return {
    version: 1,
    breakArmor: source.breakArmor === true,
    reverse: source.reverse === true,
    userName: clampString(source.userName, 40) || DEFAULTS.userName,
    addressEverySentence: typeof source.addressEverySentence === 'boolean' ? source.addressEverySentence : true,
    language,
    customBreakArmor: clampString(source.customBreakArmor, 4000),
    customReverse: clampString(source.customReverse, 4000),
    reverseTools: {
      ida: clampString(tools.ida, 500),
      x64dbg: clampString(tools.x64dbg, 500),
      ghidra: clampString(tools.ghidra, 500),
    },
    showStatus: typeof source.showStatus === 'boolean' ? source.showStatus : true,
  }
}

let state = normalizeState(DEFAULTS)

function buildMeta() {
  const promptBytes = (state.breakArmor ? 4200 : 0) + (state.reverse ? 3800 : 0)
  return {
    version: '0.1.0',
    modes: { breakArmor: state.breakArmor, reverse: state.reverse },
    userName: state.userName,
    language: state.language,
    skills: SKILLS,
    skillsMounted: state.reverse,
    promptBytes,
    promptFilesOk: true,
    runtime: { node: process.version, home: '$DSH_HOME' },
    preview: true,
  }
}

/* ------------------------------------------------------------ HTTP 工具 */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体超过 64KB'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/* --------------------------------------------------------------- API */

async function handleApi(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, state, meta: buildMeta() })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }

  let payload
  try {
    const raw = await readBody(req)
    payload = JSON.parse(raw)
  } catch (error) {
    const status = error && error.statusCode ? error.statusCode : 400
    sendJson(res, status, { ok: false, error: status === 413 ? '请求体超过 64KB' : 'JSON 解析失败' })
    return
  }

  if (!payload || typeof payload !== 'object' || typeof payload.op !== 'string') {
    sendJson(res, 400, { ok: false, error: '缺少 op' })
    return
  }

  try {
    switch (payload.op) {
      case 'set': {
        const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
        state = normalizeState(Object.assign({}, state, patch, {
          reverseTools: Object.assign({}, state.reverseTools, patch.reverseTools || {}),
        }))
        break
      }
      case 'toggle': {
        const key = payload.key
        if (key !== 'breakArmor' && key !== 'reverse') {
          sendJson(res, 400, { ok: false, error: 'key 必须是 breakArmor 或 reverse' })
          return
        }
        state = Object.assign({}, state, { [key]: !state[key] })
        break
      }
      case 'reset': {
        state = normalizeState(DEFAULTS)
        break
      }
      case 'reload': {
        // mock 没有真实文件可重读，原样返回即可（真实宿主会重读 prompts / skills）。
        break
      }
      default:
        sendJson(res, 400, { ok: false, error: `未知 op：${payload.op}` })
        return
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    return
  }

  sendJson(res, 200, { ok: true, state, meta: buildMeta() })
}

/* ------------------------------------------------------------ 静态文件 */

function serveStatic(pathname, req, res) {
  // 首页默认给「收起态」：最接近插件装好后的默认外观（工具条只有小图标按钮）。
  let relative = pathname === '/' ? '/dock-collapsed.html' : pathname
  try {
    relative = decodeURIComponent(relative)
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request')
    return
  }

  const target = path.resolve(outDir, `.${relative}`)
  // 目录穿越防护：解析后的绝对路径必须仍在 test/out 内。
  if (target !== outDir && !target.startsWith(outDir + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return
  }

  fs.stat(target, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`404 ${relative}\n先运行 node test/client-preview.mjs 生成预览 HTML。`)
      return
    }
    const type = MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-length': stat.size,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(target).pipe(res)
  })
}

/* --------------------------------------------------------------- 服务器 */

const server = http.createServer((req, res) => {
  let pathname
  try {
    pathname = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`).pathname
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request')
    return
  }

  if (pathname === API_PATH) {
    handleApi(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    })
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    res.end('method not allowed')
    return
  }
  serveStatic(pathname, req, res)
})

function startServer() {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, () => {
      console.log('[dsh-fuck] 预览服务器已启动')
      console.log(`  收起态   : http://${HOST}:${PORT}/dock-collapsed.html`)
      console.log(`  展开态   : http://${HOST}:${PORT}/dock-open.html`)
      console.log(`  首页     : http://${HOST}:${PORT}/（= 收起态）`)
      console.log(`  深色     : http://${HOST}:${PORT}/dock-open.html?theme=dark`)
      console.log(`  mock API : http://${HOST}:${PORT}${API_PATH}`)
      console.log('  Ctrl+C 退出')
      resolve()
    })
  })
}

function stopServer() {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/* ------------------------------------------------------------- 自检模式 */

async function selftest() {
  await startServer()
  const base = `http://${HOST}:${PORT}`
  const failures = []
  const check = async (name, run) => {
    try {
      await run()
      console.log(`  \u2713 ${name}`)
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
      console.error(`  \u2717 ${name} — ${error.message}`)
    }
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  try {
    await check('GET /dsh-fuck/api 返回 ok=true + state + meta', async () => {
      const response = await fetch(`${base}${API_PATH}`)
      assert(response.ok, `HTTP ${response.status}`)
      const data = await response.json()
      assert(data.ok === true, 'ok !== true')
      assert(data.state && data.state.breakArmor === false, '缺 state 或默认值不对')
      assert(Array.isArray(data.meta.skills) && data.meta.skills.length >= 8, 'meta.skills 不足 8 个')
      assert(response.headers.get('cache-control') === 'no-store', '缺少 no-store')
    })

    await check('POST toggle 翻转破甲并回写状态', async () => {
      const response = await fetch(`${base}${API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'toggle', key: 'breakArmor' }),
      })
      const data = await response.json()
      assert(response.ok && data.ok === true, `HTTP ${response.status}`)
      assert(data.state.breakArmor === true, 'breakArmor 没有翻转')
    })

    await check('POST set 写入称呼/语言/工具路径', async () => {
      const response = await fetch(`${base}${API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'set',
          patch: {
            userName: '测试者',
            language: 'zh',
            reverse: true,
            reverseTools: { ida: 'C:/Tools/ida64.exe' },
          },
        }),
      })
      const data = await response.json()
      assert(response.ok && data.ok === true, `HTTP ${response.status}`)
      assert(data.state.userName === '测试者', 'userName 没写进去')
      assert(data.state.language === 'zh', 'language 没写进去')
      assert(data.state.reverseTools.ida === 'C:/Tools/ida64.exe', 'ida 路径没写进去')
      assert(data.meta.skillsMounted === true, 'reverse 开启后 skillsMounted 应为 true')
    })

    await check('POST reset 恢复默认值', async () => {
      const response = await fetch(`${base}${API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'reset' }),
      })
      const data = await response.json()
      assert(response.ok && data.ok === true, `HTTP ${response.status}`)
      assert(data.state.breakArmor === false && data.state.reverse === false, 'reset 后模式没有关闭')
      assert(data.state.userName === 'THao', 'reset 后 userName 不是默认值')
    })

    await check('非法 op / 非法 JSON 返回 400', async () => {
      const badOp = await fetch(`${base}${API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'nope' }),
      })
      assert(badOp.status === 400, `非法 op 状态码是 ${badOp.status}`)
      const badJson = await fetch(`${base}${API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      })
      assert(badJson.status === 400, `非法 JSON 状态码是 ${badJson.status}`)
    })

    await check('GET / 返回收起态页面（工具条只有小图标按钮）', async () => {
      const response = await fetch(`${base}/`)
      assert(response.ok, `HTTP ${response.status}`)
      const html = await response.text()
      assert(html.includes('data-dsh-fuck') && html.includes('dshfk-trigger'), '页面缺少样式或小按钮')
      assert(html.includes('data-slot="conversation.input.left"'), '页面缺少 input.left outlet')
      assert(html.includes('data-slot="conversation.input.dock"'), '页面缺少 input.dock outlet')
      assert(!html.includes('data-dsh-fuck-panel'), '收起态不应渲染设置面板')
      assert(!html.includes('双模式'), '页面不应再出现「双模式」')
    })

    await check('GET /dock-open.html 返回展开态页面（含设置面板）', async () => {
      const response = await fetch(`${base}/dock-open.html`)
      assert(response.ok, `HTTP ${response.status}`)
      const html = await response.text()
      assert(html.includes('dshfk-panel') && html.includes('插件设置'), '展开态缺少设置面板')
      assert(html.includes('dshfk-trigger'), '展开态缺少工具条小按钮')
      assert(html.includes('保存') && html.includes('重新载入'), '展开态缺少操作按钮')
    })

    await check('GET /preview-default.html 别名仍然可用', async () => {
      const response = await fetch(`${base}/preview-default.html`)
      assert(response.ok, `HTTP ${response.status}`)
      const html = await response.text()
      assert(html.includes('dshfk-trigger'), '页面缺少小按钮')
    })

    await check('目录穿越被拒绝', async () => {
      const response = await fetch(`${base}/../SPEC.md`)
      assert(response.status === 403 || response.status === 404, `状态码是 ${response.status}`)
    })

    await check('PUT 返回 405', async () => {
      const response = await fetch(`${base}${API_PATH}`, { method: 'PUT' })
      assert(response.status === 405, `状态码是 ${response.status}`)
    })
  } finally {
    await stopServer()
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`[dsh-fuck] preview-server 自检 FAIL：${failures.length} 项失败`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('[dsh-fuck] preview-server 自检 PASS')
}

/* --------------------------------------------------------------- 启动 */

if (process.argv.includes('--selftest')) {
  selftest().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  startServer().catch((error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`[dsh-fuck] 端口 ${PORT} 已被占用。先关掉旧进程，或设置 DSH_FUCK_PREVIEW_PORT 换端口。`)
    } else {
      console.error(error)
    }
    process.exitCode = 1
  })
  const shutdown = () => {
    stopServer().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
