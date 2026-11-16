/**
 * `/dsh-fuck/api` HTTP 桥。
 *
 * 为什么鉴权只做 Origin/Host：插件跑在本机宿主进程里，路由只监听回环地址；
 * 真正的攻击面是「用户浏览器里另一个页面跨源打这个端口」，所以 loopback
 * 放行、非 loopback 才要求 Origin 与 Host 同源。业务 deps 由 index.js 注入，
 * 这里只做协议层：方法、body 上限、JSON 形状、错误码。
 *
 * 客户端契约：相对路径 GET，返回 { ok, state, meta }；POST 四种 op。
 */

const MAX_BODY_BYTES = 64 * 1024
export const API_PATH = '/dsh-fuck/api'

/**
 * 判断请求是否要触发「真实宿主内自检」。
 * GET /dsh-fuck/api?selftest=1 与 POST {op:'selftest'} 等价；GET 用 query 是为了
 * 让验证脚本一条 curl 就能拿到证据（exact 路由若把 query 也算进 path，POST 兜底）。
 */
export function wantsSelftest(req) {
  const url = req && typeof req.url === 'string' ? req.url : ''
  if (!url) return false
  try {
    const flag = new URL(url, 'http://127.0.0.1').searchParams.get('selftest')
    return flag === '1' || flag === 'true'
  } catch {
    return /[?&]selftest=(?:1|true)(?:&|$)/.test(url)
  }
}

/** 固定自检响应形状；坏值一律收成安全类型，避免验证脚本踩 undefined。 */
export function normalizeSelftest(value) {
  const v = value && typeof value === 'object' ? value : {}
  return {
    sectionPresent: v.sectionPresent === true,
    sectionChars: Number.isFinite(v.sectionChars) ? v.sectionChars : 0,
    sectionHead: typeof v.sectionHead === 'string' ? v.sectionHead : '',
    promptChars: Number.isFinite(v.promptChars) ? v.promptChars : 0,
    error: typeof v.error === 'string' && v.error ? v.error : null,
  }
}

/**
 * 执行自检。**自检接口不能反过来影响宿主**：deps 抛错也只回 ok:true +
 * error 字段，绝不 500/400，调用方永远拿得到一份结构化结果。
 */
async function runSelftest(deps) {
  try {
    if (!deps || typeof deps.selftest !== 'function') {
      return normalizeSelftest({ error: '宿主未提供 selftest 能力' })
    }
    return normalizeSelftest(await deps.selftest())
  } catch (error) {
    return normalizeSelftest({ error: errorMessage(error) })
  }
}

/** 统一的 JSON 响应（no-store，防止 WebView 缓存开关状态）。 */
export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  }
  res.writeHead(status, headers)
  res.end(body)
}

/**
 * 来源校验。回环一律放行（官方桌面端 Origin 常是 app:// 或 null）；
 * 非回环要求 Origin 与 Host 同源。
 */
export function isOriginAllowed(req) {
  const remote = req && req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  const loopback = remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1'
    || remote === '::ffff:7f00:1'
    || remote === ''
  const host = req && req.headers && typeof req.headers.host === 'string' ? req.headers.host : ''
  const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
  const origin = req && req.headers ? req.headers.origin : undefined

  if (loopback) return true
  if (hostLocal) {
    if (origin === undefined || origin === '' || origin === 'null') return true
    if (typeof origin === 'string' && /^app:/i.test(origin)) return true
    try {
      const originHost = new URL(origin).host
      if (originHost === host || originHost === '') return true
    } catch {
      /* app:// 之外的非法 URL 走下面的同源判断 */
    }
  }
  if (typeof origin !== 'string' || origin === '') return false
  try {
    const originHost = new URL(origin).host
    return originHost !== '' && originHost === host
  } catch {
    return false
  }
}

/**
 * 读请求体（上限 64KB）。超限时停止累积并拒绝，错误带 code 供 413 判断。
 * @returns {Promise<string>}
 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > limit) {
        const error = new Error('request body too large')
        error.code = 'BODY_TOO_LARGE'
        fail(error)
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

/**
 * 组装 GET 响应里的 meta。skills 只暴露 name/description，不泄露本机路径。
 * @param {object} state - 归一化状态
 * @param {{skills?: Array, skillsMounted?: boolean, promptBytes?: number, promptFilesOk?: boolean}} [extras]
 */
export function buildMeta(state, extras = {}) {
  const s = state && typeof state === 'object' ? state : {}
  const skills = Array.isArray(extras.skills) ? extras.skills : []
  return {
    version: typeof s.version === 'number' ? s.version : 1,
    modes: {
      breakArmor: s.breakArmor === true,
      reverse: s.reverse === true,
    },
    userName: typeof s.userName === 'string' ? s.userName : '',
    language: typeof s.language === 'string' ? s.language : 'auto',
    skills: skills.map((skill) => ({
      name: String(skill && skill.name ? skill.name : ''),
      description: String(skill && skill.description ? skill.description : ''),
    })),
    skillsMounted: extras.skillsMounted === true,
    promptBytes: Number.isFinite(extras.promptBytes) ? extras.promptBytes : 0,
    promptFilesOk: extras.promptFilesOk !== false,
    runtime: {
      node: process.version,
      // 只暴露 $DSH_HOME 这一层符号，不把本机盘符/用户名带进浏览器
      home: '$DSH_HOME',
    },
  }
}

async function dispatch(deps, request) {
  const op = typeof request.op === 'string' ? request.op.trim() : ''
  switch (op) {
    case 'set': {
      const patch = request.patch
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('op=set 需要 patch 对象')
      }
      return deps.set(patch)
    }
    case 'toggle':
      return deps.toggle(String(request.key ?? ''))
    case 'reset':
      return deps.reset()
    case 'reload':
      return deps.reload()
    case 'selftest':
      // 交给 handleApi 统一成 {ok:true, selftest}，不附带 state/meta
      return { selftest: await runSelftest(deps) }
    default:
      throw new Error(`未知 op：${op || '(缺失)'}（支持 set/toggle/reset/reload/selftest）`)
  }
}

/**
 * 协议层主处理。deps 形状：
 *   get(): Promise<{state, meta}>
 *   set(patch), toggle(key), reset(), reload(): Promise<{state, meta}>
 *   selftest(): Promise<{sectionPresent, sectionChars, sectionHead, promptChars, error}>
 */
export async function handleApi(deps, req, res) {
  const method = req && typeof req.method === 'string' ? req.method.toUpperCase() : ''
  if (!method) {
    sendJson(res, 400, { ok: false, error: 'bad request' })
    return
  }
  if (!isOriginAllowed(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
    return
  }

  try {
    if (method === 'GET') {
      // 自检：?selftest=1（POST {op:'selftest'} 走下面的 dispatch）
      if (wantsSelftest(req)) {
        sendJson(res, 200, { ok: true, selftest: await runSelftest(deps) })
        return
      }
      const result = await deps.get()
      sendJson(res, 200, { ok: true, state: result.state, meta: result.meta })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed (GET/POST only)' })
      return
    }

    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      const tooLarge = error && error.code === 'BODY_TOO_LARGE'
      sendJson(res, tooLarge ? 413 : 400, { ok: false, error: errorMessage(error) })
      return
    }

    let request
    try {
      request = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      sendJson(res, 400, { ok: false, error: 'JSON body 必须是对象' })
      return
    }

    const result = await dispatch(deps, request)
    if (result && typeof result === 'object' && result.selftest !== undefined) {
      sendJson(res, 200, { ok: true, selftest: result.selftest })
      return
    }
    sendJson(res, 200, { ok: true, state: result.state, meta: result.meta })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) })
  }
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

/** 同一 ctx 只允许挂一次路由：重复 apply 的幂等兜底。 */
const mountedRoutes = new WeakMap()

/**
 * 注册路由。必须在 `ctx.effect(() => registerApi(ctx, deps))` 里调用，
 * effect 回收时自动摘路由。
 * @returns {(() => void) | null} disposer；服务缺失时返回 null
 */
export function registerApi(ctx, deps) {
  const existing = mountedRoutes.get(ctx)
  if (existing) return existing

  const webServer = safeService(ctx, 'webServer', ['register'])
  if (!webServer) {
    console.warn('[dsh-fuck] webServer 服务不可用，/dsh-fuck/api 未挂载')
    return null
  }

  const handler = (req, res) => {
    // 返回 Promise 便于单测 await；真实宿主忽略返回值
    return Promise.resolve(handleApi(deps, req, res)).catch((error) => {
      try {
        sendJson(res, 400, { ok: false, error: errorMessage(error) })
      } catch {
        /* 响应可能已经发过 */
      }
    })
  }

  let dispose = null
  try {
    dispose = webServer.register({ kind: 'exact', path: API_PATH, handler })
  } catch (error) {
    console.warn(`[dsh-fuck] 注册 /dsh-fuck/api 失败：${errorMessage(error)}`)
    return null
  }

  let disposed = false
  const wrapped = () => {
    if (disposed) return
    disposed = true
    mountedRoutes.delete(ctx)
    try {
      if (typeof dispose === 'function') dispose()
    } catch (error) {
      console.warn(`[dsh-fuck] 摘除 /dsh-fuck/api 失败：${errorMessage(error)}`)
    }
  }
  mountedRoutes.set(ctx, wrapped)
  return wrapped
}

/**
 * 安全取 cordis 服务：未注入时读 ctx 属性会抛（`cannot get property ... without
 * inject`），拿到的值也可能是读方法就抛的服务代理。因此：①ctx.get() 优先
 * ②属性读取包 try ③对候选值逐方法探测也包 try。任何一步失败都返回 undefined。
 * @param {object} ctx
 * @param {string} name
 * @param {string[]} [methods] - 必须具备的方法名
 */
function safeService(ctx, name, methods = []) {
  if (!ctx || typeof name !== 'string' || !name) return undefined
  const required = (Array.isArray(methods) ? methods : [methods]).filter((method) => typeof method === 'string')
  const usable = (candidate) => {
    if (!candidate) return false
    if (typeof candidate !== 'object' && typeof candidate !== 'function') return false
    for (const method of required) {
      try {
        if (typeof candidate[method] !== 'function') return false
      } catch {
        return false
      }
    }
    return true
  }
  try {
    if (typeof ctx.get === 'function') {
      const svc = ctx.get(name)
      if (usable(svc)) return svc
    }
  } catch {
    /* 未注入 / 反射层不可用 */
  }
  try {
    const svc = ctx[name]
    if (usable(svc)) return svc
  } catch {
    /* 代理属性读取会抛 */
  }
  return undefined
}
