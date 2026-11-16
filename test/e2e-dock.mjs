#!/usr/bin/env node
/**
 * 无头 Edge（CDP）端到端断言 + 截图工具 —— verify 用。
 *
 * 为什么不用 `msedge --headless=new --screenshot`：
 *   DSH Web 是 SPA，`--screenshot` 在 load 事件瞬间截屏，此时 React 还没挂载
 *   composer/dock（实测截到的是空白骨架），而 `--virtual-time-budget` 会被
 *   页面里的轮询/WebSocket 拖住不退出。这里用 CDP：导航 → 轮询等待目标
 *   槽位出现并有内容 → 再 Page.captureScreenshot，结果稳定可断言。
 *
 * 用法：
 *   node test/e2e-dock.mjs <url> <out.png> [选项]
 *     --slot <name>      等待的 slot（默认 conversation.input.dock）
 *     --expect <text>    断言 slot innerHTML 或整页 innerText 含该文本（可重复）
 *     --wait <ms>        最长等待渲染时间（默认 20000）
 *     --width/--height   视口（默认 1500x1000）
 *     --eval <js>        截图前额外执行的表达式，结果打进 JSON
 *     --json             只输出一行 JSON（便于 PowerShell 解析）
 *
 * 退出码：0 = 全部断言通过；1 = 失败（仍会尽量保存截图与 JSON 诊断）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

function parseArgs(argv) {
  const options = {
    url: '',
    out: '',
    slot: 'conversation.input.dock',
    expect: [],
    wait: 20000,
    width: 1500,
    height: 1000,
    eval: '',
    preEval: '',
    preEvalFile: '',
    json: false,
    jsonOut: '',
  }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--slot') options.slot = argv[++i]
    else if (arg === '--expect') options.expect.push(argv[++i])
    else if (arg === '--wait') options.wait = Number(argv[++i])
    else if (arg === '--width') options.width = Number(argv[++i])
    else if (arg === '--height') options.height = Number(argv[++i])
    else if (arg === '--eval') options.eval = argv[++i]
    else if (arg === '--pre-eval') options.preEval = argv[++i]
    // 多行 JS 走 --pre-eval 传参时，PowerShell 5.1 交给原生进程的命令行会把换行
    // 截断（实测 SyntaxError: Unexpected end of input）；写文件再传路径最稳。
    else if (arg === '--pre-eval-file') options.preEvalFile = argv[++i]
    else if (arg === '--json') options.json = true
    else if (arg === '--json-out') options.jsonOut = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node test/e2e-dock.mjs <url> <out.png> [--slot name] [--expect text]... [--wait ms] [--json]')
      process.exit(0)
    } else rest.push(arg)
  }
  options.url = rest[0] ?? ''
  options.out = rest[1] ?? ''
  if (!options.url || !options.out) throw new Error('缺少 <url> 或 <out.png>')
  if (!options.preEval && options.preEvalFile) {
    options.preEval = readFileSync(options.preEvalFile, 'utf8')
  }
  return options
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 结束整棵 Edge 进程树：CDP 只能关主进程，子进程在 Windows 会残留。 */
function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  } catch { /* 尽力而为 */ }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(EDGE)) throw new Error(`找不到 Edge：${EDGE}`)

  const port = 9400 + Math.floor(Math.random() * 400)
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-edge-'))
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${options.width},${options.height}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let ws = null
  const result = { ok: false, checks: [], errors: [], slots: [], bootHasPlugin: null, textSample: '' }
  try {
    // 等 DevTools HTTP 端点就绪
    let version = null
    for (let i = 0; i < 100 && !version; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`)
        version = await res.json()
      } catch { await sleep(150) }
    }
    if (!version) throw new Error('DevTools 端点未就绪')
    ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((done, fail) => {
      ws.onopen = done
      ws.onerror = (event) => fail(new Error(`WebSocket 失败：${event?.message ?? 'unknown'}`))
    })

    let seq = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) bad(new Error(JSON.stringify(msg.error)))
        else ok(msg.result)
      }
    }
    const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
      const id = ++seq
      pending.set(id, { resolve: ok, reject: bad })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
    const evaluate = async (expression, sessionId) => {
      const reply = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }, sessionId)
      if (reply.exceptionDetails) {
        const text = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'eval 失败'
        throw new Error(`页面内表达式异常：${String(text).split('\n')[0]}`)
      }
      return reply.result?.value
    }

    const { targetId } = await send('Target.createTarget', { url: options.url })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', {
      width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId)

    // 等首屏 React 挂载后再执行 pre-eval（例如关掉「预览版说明」弹窗），
    // 否则弹窗会盖住 composer dock，截图断言会假阳性/假阴性。
    if (options.preEval) {
      const preDeadline = Date.now() + options.wait
      while (Date.now() < preDeadline) {
        try {
          if (await evaluate('Boolean(document.querySelector("#root") || document.body) && document.readyState === "complete"', sessionId)) break
        } catch { /* 页面还在导航，重试 */ }
        await sleep(200)
      }
      await sleep(800)
      result.preEvalResult = await evaluate(options.preEval, sessionId)
      await sleep(500)
    }

    // 轮询等待：目标槽位出现（有 outlet）或超时。
    const deadline = Date.now() + options.wait
    let slotFound = false
    while (Date.now() < deadline) {
      try {
        slotFound = await evaluate(
          `Boolean(document.querySelector(${JSON.stringify(`[data-slot="${options.slot}"]`)}))`,
          sessionId,
        )
      } catch { slotFound = false }
      if (slotFound) break
      await sleep(250)
    }
    // 槽位出现后，再给它一点时间挂载渲染。
    if (slotFound) await sleep(1200)

    const snapshot = await evaluate(`(() => {
      const slotEl = document.querySelector(${JSON.stringify(`[data-slot="${options.slot}"]`)});
      const slots = [...new Set([...document.querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot')))];
      const bootEntries = (globalThis.__DSH_BOOT__ && Array.isArray(globalThis.__DSH_BOOT__.entries))
        ? globalThis.__DSH_BOOT__.entries.map((entry) => entry.id) : null;
      return {
        slots,
        slotFound: Boolean(slotEl),
        slotHtml: slotEl ? slotEl.innerHTML : '',
        bodyText: document.body ? document.body.innerText : '',
        bootEntries,
      };
    })()`, sessionId)

    result.slots = snapshot.slots
    result.slotFound = snapshot.slotFound
    result.slotHtml = snapshot.slotHtml
    result.textSample = String(snapshot.bodyText ?? '').slice(0, 800)
    result.bootEntries = snapshot.bootEntries

    const checks = []
    checks.push({ name: `slot:${options.slot}`, ok: snapshot.slotFound, detail: snapshot.slotFound ? 'outlet 存在' : 'outlet 不存在' })
    for (const expected of options.expect) {
      const inSlot = String(snapshot.slotHtml ?? '').includes(expected)
      const inBody = String(snapshot.bodyText ?? '').includes(expected)
      checks.push({
        name: `expect:${expected}`,
        ok: inSlot || inBody,
        detail: inSlot ? '命中 slot' : inBody ? '命中 body' : '未找到',
      })
    }
    if (options.eval) {
      const evaluated = await evaluate(options.eval, sessionId)
      result.eval = evaluated
      checks.push({ name: 'eval', ok: evaluated !== undefined && evaluated !== null, detail: JSON.stringify(evaluated)?.slice(0, 500) ?? 'undefined' })
    }
    result.checks = checks
    result.ok = checks.every((check) => check.ok)

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
    const outPath = resolve(options.out)
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
    result.screenshot = outPath
    result.screenshotBytes = statSync(outPath).size
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error))
    result.ok = false
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    killTree(child.pid)
    await sleep(300)
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* ignore */ }
  }

  if (options.jsonOut) {
    // 为什么写文件：PowerShell 5.1 捕获原生命令 stdout 时按控制台 ANSI 编码解码，
    // JSON 里的中文（expect 断言名）会变乱码；让 Node 直接写 UTF-8 文件最稳。
    writeFileSync(resolve(options.jsonOut), JSON.stringify(result), 'utf8')
  }
  if (options.json) console.log(JSON.stringify(result))
  else {
    console.log(`[e2e-dock] url=${options.url}`)
    console.log(`  screenshot: ${result.screenshot ?? '(未生成)'} (${result.screenshotBytes ?? 0} bytes)`)
    console.log(`  slots: ${result.slots?.join(', ') || '(无)'}`)
    console.log(`  boot entries: ${result.bootEntries ? result.bootEntries.length : 'n/a'}`)
    for (const check of result.checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`)
    for (const error of result.errors) console.log(`  ERROR ${error}`)
    console.log(`RESULT: ${result.ok ? 'PASS' : 'FAIL'}`)
  }
  process.exitCode = result.ok ? 0 : 1
}

main().catch((error) => {
  console.error(`[e2e-dock] 致命错误：${error.message}`)
  process.exitCode = 1
})
