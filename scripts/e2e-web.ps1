<#
.SYNOPSIS
  dsh-fxxk 端到端验证：重置测试 profile → 安装 → 起宿主 → API/页面/dock 断言 → 截图 → 清理。

.DESCRIPTION
  覆盖 SPEC §7 的 verify 链路：
    1. node test/check-plugin.mjs 静态体检；
    2. test/setup-profile.mjs 重置测试 profile（--reset，幂等）；
    3. scripts/install.ps1 安装（备份 + pnpm add + bundles）；
    4. dsh --profile <p> --port 3099 --no-open 起宿主，从 stdout 解析 token；
    5. GET /dsh-fxxk/api 断言 ok:true、state.breakArmor/reverse 为布尔；
    6. 页面 HTML 断言 __DSH_BOOT__ 含 "id":"dsh-fxxk"；
    7. POST toggle breakArmor / reverse 后 GET 断言状态、skills 挂载（9 个）、selftest 双模式文本；
    8. 无头 Edge（CDP）两态断言：
       - 收起态：`[data-slot="conversation.input.left"]` 里存在 dsh-fxxk 设置按钮（aria-label 含
         「dsh-fxxk」「插件设置」），截图 test/out/e2e-dock-collapsed.png；
       - 展开态：点击该按钮后面板挂载到 `[data-slot="conversation.input.dock"]`，断言面板含
         「破甲」「逆向」「保存」，截图 test/out/e2e-dock.png；
    9. finally：杀自己起的宿主进程树、恢复 $DSH_HOME/dsh-fxxk/settings.json、清 Edge 临时 profile。
  退出码 0 = 全 PASS；1 = 有 FAIL（日志与截图仍保留在 test/out/）。

  为什么用 CDP 而不是 `msedge --headless=new --screenshot`：DSH Web 是 SPA，
  --screenshot 在 load 事件瞬间截屏，React 还没挂载 dock；--virtual-time-budget
  又会被页面轮询/WebSocket 拖住不退出（实测卡死）。CDP 可以先等 slot 出现、
  断言 DOM，再截屏。

.PARAMETER Profile
  测试 profile 名，必填。为了不误伤真实配置，脚本拒绝 tauri / web / desktop。
  真实 tauri 装配后用 `node test/e2e-dock.mjs <3080 token URL> <png> --expect 插件设置 --slot conversation.input.left` 验证。

.EXAMPLE
  powershell -File scripts/e2e-web.ps1 -Profile dualtest
.EXAMPLE
  powershell -File scripts/e2e-web.ps1 -Profile dualtest -NoReset     # 保留已有安装
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Profile,

  [string]$PluginRoot,

  [string]$DshCmd,

  [int]$Port = 3099,

  [string]$ApiPath = '/dsh-fxxk/api',

  # 新版 UI：常驻控制栏取消。设置按钮（图标按钮）注册在 conversation.input.left，
  # 点击后面板出现在 conversation.input.dock（含 破甲/逆向/保存/重置/载入）。
  [string]$LeftSlot = 'conversation.input.left',

  [string[]]$LeftExpect = @('插件设置', 'dsh-fxxk'),

  [string]$Slot = 'conversation.input.dock',

  [string[]]$Expect = @('破甲', '逆向', '保存'),

  [switch]$NoReset,

  [switch]$NoScreenshot
)

$ErrorActionPreference = 'Stop'
$script:CheckResults = New-Object System.Collections.ArrayList
$script:Failed = 0

function Write-Step([string]$Message) { Write-Host "[e2e] $Message" }
function Write-Ok([string]$Message) { Write-Host "[e2e] OK   $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "[e2e] WARN $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "[e2e] FAIL $Message" -ForegroundColor Red }
function Write-Detail([string]$Message) { Write-Host "          $Message" -ForegroundColor DarkGray }

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  $null = $script:CheckResults.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
  if ($Ok) { Write-Ok $Name }
  else {
    $script:Failed = $script:Failed + 1
    Write-Fail ("$Name — " + $Detail)
  }
}

function Resolve-Dsh {
  param([string]$Candidate)
  if ($Candidate -and (Test-Path -LiteralPath $Candidate)) { return (Resolve-Path -LiteralPath $Candidate).Path }
  if ($env:DSH_CMD -and (Test-Path -LiteralPath $env:DSH_CMD)) { return (Resolve-Path -LiteralPath $env:DSH_CMD).Path }
  $fromLocal = Join-Path $env:LOCALAPPDATA 'deepseek-harness\bin\dsh.cmd'
  if (Test-Path -LiteralPath $fromLocal) { return $fromLocal }
  $command = Get-Command 'dsh' -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw '找不到 dsh.cmd（试过 -DshCmd、$env:DSH_CMD、%LOCALAPPDATA%、PATH）'
}

function Resolve-Node {
  $command = Get-Command 'node' -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
      'E:\nodejs\node.exe')) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw '找不到 node.exe'
}

function Resolve-DshHome {
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return (Resolve-Path -LiteralPath $env:DSH_HOME).Path }
  return (Join-Path $env:USERPROFILE '.dsh')
}

function Read-Utf8Text {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

# 宿主进程活着时它的 stdout/stderr 重定向文件一直被占用（PS 5.1 的句柄不共享读），
# 轮询 token / 读 stderr 必须用 FileShare.ReadWrite。
function Read-SharedText {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
      return $reader.ReadToEnd()
    } finally {
      $reader.Close()
      $stream.Close()
    }
  } catch {
    return ''
  }
}

function Get-PortOwners {
  param([int]$PortNumber)
  try { return @(Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) }
  catch { return @() }
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -and $ProcessId -gt 0) {
    & cmd.exe /c "taskkill /T /F /PID $ProcessId" 2>&1 | Out-Null
  }
}

# POST /dsh-fxxk/api：返回 HTTP 状态码 + 解析后的 body。
# 为什么不用 Invoke-RestMethod：它非 2xx 只抛异常，拿不到状态码和 {ok:false,error}
# 文本；而逆向模式回归 bug 的表现恰好是 HTTP 500 + JSON error，必须能断言出来。
function Invoke-ApiPost {
  param([string]$Url, [string]$JsonBody)
  try {
    $response = Invoke-WebRequest -Uri $Url -Method Post -ContentType 'application/json; charset=utf-8' -Body $JsonBody -UseBasicParsing -TimeoutSec 20
    $parsed = $null
    try { $parsed = $response.Content | ConvertFrom-Json } catch { }
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Body       = $parsed
      Raw        = [string]$response.Content
      Error      = ''
    }
  } catch {
    $status = 0
    $raw = ''
    $webResponse = $null
    try { $webResponse = $_.Exception.Response } catch { $webResponse = $null }
    if ($webResponse) {
      try { $status = [int]$webResponse.StatusCode } catch { }
      try {
        $stream = $webResponse.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $raw = $reader.ReadToEnd()
          $reader.Close()
        }
      } catch { }
    }
    $parsed = $null
    if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { } }
    return [pscustomobject]@{
      StatusCode = $status
      Body       = $parsed
      Raw        = $raw
      Error      = $_.Exception.Message
    }
  }
}

# meta.skills 是数组；PowerShell 对 null / 空数组的计数行为不同，统一走这里。
function Get-SkillCount {
  param($Meta)
  if (-not $Meta -or -not $Meta.skills) { return 0 }
  return @($Meta.skills).Count
}

# 跑一次 test/e2e-dock.mjs（无头 Edge + CDP）：可选 pre-eval（点弹窗 / 点设置按钮），
# 等 slot 出现、断言文本、截图。返回退出码 / 解析后的 JSON / 原始输出。
# 为什么用 --json-out 写文件：PowerShell 5.1 捕获原生命令 stdout 会按 ANSI 解码，
# JSON 里的中文断言名会乱码，读文件（UTF-8）才稳。
function Invoke-CdpCheck {
  param(
    [string]$CdpScript,
    [string]$Url,
    [string]$PngPath,
    [string]$JsonPath,
    [string]$SlotName,
    [string[]]$ExpectTexts = @(),
    [string]$PreEval = '',
    [string]$PreEvalFile = '',
    [int]$WaitMs = 25000
  )
  Remove-Item -LiteralPath $JsonPath -Force -ErrorAction SilentlyContinue
  $cdpArgs = @($CdpScript, $Url, $PngPath, '--slot', $SlotName, '--wait', "$WaitMs", '--json', '--json-out', $JsonPath)
  foreach ($text in $ExpectTexts) {
    if ($text -and $text.Trim() -ne '') { $cdpArgs += @('--expect', $text) }
  }
  # 多行 JS 走 --pre-eval 传参会被 PowerShell 5.1 截断（实测 SyntaxError: Unexpected end of input），
  # 统一用 --pre-eval-file 传文件路径。
  if ($PreEvalFile -and $PreEvalFile.Trim() -ne '') {
    $cdpArgs += @('--pre-eval-file', $PreEvalFile)
  } elseif ($PreEval -and $PreEval.Trim() -ne '') {
    $cdpArgs += @('--pre-eval', $PreEval)
  }
  # @(...) 包一层：node 只输出一行 JSON 时 PowerShell 会把它当标量字符串。
  $raw = @(& $node @cdpArgs 2>&1)
  $exitCode = $LASTEXITCODE
  $parsed = $null
  if (Test-Path -LiteralPath $JsonPath) {
    try { $parsed = ([System.IO.File]::ReadAllText($JsonPath, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json }
    catch { Write-Detail ("CDP JSON 解析失败：" + $_.Exception.Message) }
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Result = $parsed; Raw = $raw }
}

# 把一次 CDP 结果登记成检查项（slot 存在 / 每条文案 / 截图），返回是否全部通过。
function Register-CdpChecks {
  param(
    [string]$Label,
    $Cdp,
    [string]$SlotName,
    [string[]]$ExpectTexts = @(),
    [string]$PngPath
  )
  if (-not $Cdp.Result) {
    $Cdp.Raw | ForEach-Object { Write-Detail ($_ | Out-String).Trim() }
    Add-Check ("CDP " + $Label + " 断言") $false '得不到 JSON 结果（见上方输出）'
    Add-Check ("CDP " + $Label + " 截图已生成") $false $PngPath
    return $false
  }
  $allOk = $true
  if ($Cdp.Result.errors -and @($Cdp.Result.errors).Count -gt 0) {
    Write-Detail ("CDP " + $Label + " 错误：" + (@($Cdp.Result.errors) -join '；'))
  }
  Add-Check ("CDP " + $Label + " 页面加载成功") ($Cdp.ExitCode -eq 0) ("exit=" + $Cdp.ExitCode)
  if ($Cdp.ExitCode -ne 0) { $allOk = $false }
  Add-Check ("slot " + $SlotName + " 存在（" + $Label + "）") ([bool]$Cdp.Result.slotFound)
  if (-not [bool]$Cdp.Result.slotFound) { $allOk = $false }
  foreach ($text in $ExpectTexts) {
    if (-not $text -or $text.Trim() -eq '') { continue }
    $hit = @($Cdp.Result.checks | Where-Object { $_.name -eq ('expect:' + $text) })
    $itemOk = ($hit.Count -gt 0 -and [bool]$hit[0].ok)
    Add-Check ("CDP " + $Label + " 文案含「" + $text + "」") $itemOk
    if (-not $itemOk) { $allOk = $false }
  }
  Add-Check ("CDP " + $Label + " 截图已生成") ([bool]$Cdp.Result.screenshot -and (Test-Path -LiteralPath $Cdp.Result.screenshot)) ([string]$Cdp.Result.screenshot)
  return $allOk
}

# ---------------------------------------------------------------- 0. 参数/环境
$reserved = @('tauri', 'web', 'desktop')
if ($reserved -contains $Profile) {
  Write-Fail "拒绝在真实 profile '$Profile' 上跑 e2e（本脚本会重置 profile 并起第二个宿主）。"
  Write-Detail '真实装配后请用：node test/e2e-dock.mjs "<3080 token URL>" test/out/e2e-dock-tauri.png --slot conversation.input.left --expect 插件设置'
  exit 1
}

if (-not $PluginRoot -or $PluginRoot.Trim() -eq '') { $PluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path }
$PluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$dsh = Resolve-Dsh -Candidate $DshCmd
$node = Resolve-Node
$dshHome = Resolve-DshHome
$outDir = Join-Path $PluginRoot 'test\out'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$hostOut = Join-Path $outDir ("e2e-web-{0}.out.log" -f $stamp)
$hostErr = Join-Path $outDir ("e2e-web-{0}.err.log" -f $stamp)
$screenshotPath = Join-Path $outDir 'e2e-dock.png'
$collapsedScreenshotPath = Join-Path $outDir 'e2e-dock-collapsed.png'
$leftJsonFile = Join-Path $outDir 'e2e-dock-left.json'
$settingsPath = Join-Path $dshHome 'dsh-fxxk\settings.json'
$settingsBackup = $null
$settingsExisted = Test-Path -LiteralPath $settingsPath

$startedProcess = $null
$tokenUrl = $null
$baseUrl = $null
$teardownNeeded = $true

Write-Step "plugin  : $PluginRoot"
Write-Step "profile : $Profile"
Write-Step "dsh     : $dsh"
Write-Step "logs    : $hostOut"

try {
  # ------------------------------------------------------------ 1. 静态体检
  Write-Step '静态体检：node test/check-plugin.mjs'
  $checkOutput = & $node (Join-Path $PluginRoot 'test\check-plugin.mjs') 2>&1
  $checkExit = $LASTEXITCODE
  $checkOutput | ForEach-Object { Write-Detail ($_ | Out-String).Trim() }
  Add-Check 'check-plugin 静态体检' ($checkExit -eq 0) ("exit=" + $checkExit)

  # ------------------------------------------------------------ 2. setup profile
  if (-not $NoReset) {
    Write-Step "重置测试 profile：node test/setup-profile.mjs --profile $Profile --reset"
    $setupOutput = & $node (Join-Path $PluginRoot 'test/setup-profile.mjs') --profile $Profile --reset 2>&1
    $setupExit = $LASTEXITCODE
    $setupOutput | ForEach-Object { Write-Detail ($_ | Out-String).Trim() }
    Add-Check 'setup-profile 重置 profile' ($setupExit -eq 0) ("exit=" + $setupExit)
    if ($setupExit -ne 0) { throw 'profile 重置失败，终止 e2e' }
  } else {
    Write-Warn '按 -NoReset 跳过 profile 重置'
  }

  # ------------------------------------------------------------ 3. 安装
  Write-Step "安装插件：scripts/install.ps1 -Profile $Profile（跳过启动校验，本脚本自己起宿主）"
  $installScript = Join-Path $PSScriptRoot 'install.ps1'
  $installLog = Join-Path $outDir ("e2e-install-{0}.log" -f $stamp)
  $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $installRaw = & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $installScript -Profile $Profile -PluginRoot $PluginRoot -DshCmd $dsh -SkipBootCheck 2>&1
  $installExit = $LASTEXITCODE
  $installRaw | Tee-Object -FilePath $installLog | ForEach-Object { Write-Detail ($_ | Out-String).Trim() }
  Add-Check 'install.ps1 安装成功' ($installExit -eq 0) ("exit=" + $installExit)
  if ($installExit -ne 0) { throw '安装失败，终止 e2e' }

  # ------------------------------------------------------------ 4. 备份用户设置
  if ($settingsExisted) {
    $settingsBackup = Join-Path $outDir ("e2e-settings-backup-{0}.json" -f $stamp)
    Copy-Item -LiteralPath $settingsPath -Destination $settingsBackup -Force
    Write-Step "已备份 $DSH_HOME/dsh-fxxk/settings.json → $settingsBackup"
  }

  # ------------------------------------------------------------ 5. 端口检查
  $owners = Get-PortOwners -Port $Port
  if ($owners.Count -gt 0) {
    Add-Check "端口 $Port 空闲" $false ("已被 PID " + ($owners -join ',') + " 占用；请先清理再跑 e2e")
    throw "端口 $Port 被占用"
  }
  Add-Check "端口 $Port 空闲" $true

  # ------------------------------------------------------------ 6. 起宿主
  Write-Step "启动宿主：dsh --profile $Profile --port $Port --no-open"
  Remove-Item -LiteralPath $hostOut, $hostErr -Force -ErrorAction SilentlyContinue
  $arguments = '/c call "{0}" --profile {1} --port {2} --no-open' -f $dsh, $Profile, $Port
  $startedProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList $arguments -RedirectStandardOutput $hostOut -RedirectStandardError $hostErr -PassThru -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $logText = Read-SharedText -Path $hostOut
    $match = [regex]::Match($logText, 'http://127\.0\.0\.1:\d+/\?token=([A-Za-z0-9_\-]+)')
    if ($match.Success) { $tokenUrl = $match.Value; break }
    if ($startedProcess.HasExited) { break }
  }
  Add-Check '宿主启动并打印 token URL' ([bool]$tokenUrl) $(if ($tokenUrl) { $tokenUrl } else { '见日志：' + $hostOut })
  if (-not $tokenUrl) { throw '宿主未启动，终止 e2e' }

  $baseUrl = ($tokenUrl -replace '/\?token=.*$', '')

  # 激活失败检测：宿主对单个插件失败只打 warning: 1 entry did not activate。
  Start-Sleep -Milliseconds 1500
  $errText = Read-SharedText -Path $hostErr
  $activatedOk = ($errText -notmatch 'did not activate')
  Add-Check '宿主日志无 did not activate' $activatedOk $(if ($activatedOk) { '' } else { $errText.Trim() })

  # ------------------------------------------------------------ 7. API 断言
  Write-Step "GET $ApiPath（带 token）"
  $apiUrl = $baseUrl + $ApiPath
  $api = $null
  for ($i = 0; $i -lt 20; $i = $i + 1) {
    try { $api = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 10; break } catch { Start-Sleep -Milliseconds 500 }
  }
  $apiOk = $false
  $stateBreak = $null
  $stateReverse = $null
  if ($api) {
    $apiOk = [bool]$api.ok
    if ($api.state) { $stateBreak = $api.state.breakArmor; $stateReverse = $api.state.reverse }
  }
  Add-Check 'GET /dsh-fxxk/api 返回 ok:true' $apiOk
  Add-Check 'state.breakArmor 为布尔' ($stateBreak -is [bool]) ("值=" + $stateBreak)
  Add-Check 'state.reverse 为布尔' ($stateReverse -is [bool]) ("值=" + $stateReverse)

  # 页面 boot graph
  Write-Step 'GET 页面 HTML，断言 __DSH_BOOT__ 含 dsh-fxxk'
  $page = Invoke-WebRequest -Uri $tokenUrl -UseBasicParsing -TimeoutSec 20
  $bootOk = ($page.StatusCode -eq 200) -and ($page.Content -match '"id":"dsh-fxxk"')
  Add-Check '页面 HTTP 200' ($page.StatusCode -eq 200) ("status=" + $page.StatusCode)
  Add-Check 'boot graph 含 dsh-fxxk（client 半侧）' $bootOk

  # ------------------------------------------------------------ 8. 基线归零
  # $DSH_HOME/dsh-fxxk/settings.json 与 tauri/真实 GUI 共用，可能带着历史状态
  # （实测上一轮 tauri 测试留下 breakArmor=true）。先 reset 让后续断言确定成立；
  # finally 会恢复 e2e 开始前的 settings.json（或删除测试前不存在的）。
  Write-Step '基线 reset（消除历史 settings.json 状态影响）'
  $baselineReset = Invoke-ApiPost -Url $apiUrl -JsonBody '{"op":"reset"}'
  $baseline = $null
  try { $baseline = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 10 } catch { }
  $baselineOk = ($baselineReset.StatusCode -eq 200) -and ($baselineReset.Body -and [bool]$baselineReset.Body.ok) `
    -and $baseline -and (-not [bool]$baseline.state.breakArmor) -and (-not [bool]$baseline.state.reverse)
  if ($baseline) {
    $stateBreak = [bool]$baseline.state.breakArmor
    $stateReverse = [bool]$baseline.state.reverse
  }
  Add-Check '基线 reset 后两模式均为 false' $baselineOk ("status=" + $baselineReset.StatusCode + " break=" + $stateBreak + " reverse=" + $stateReverse)

  # ------------------------------------------------------------ 9. breakArmor 开关（非空注入证据）
  Write-Step 'POST toggle breakArmor → GET 断言翻转'
  $breakToggle = Invoke-ApiPost -Url $apiUrl -JsonBody '{"op":"toggle","key":"breakArmor"}'
  $toggleOk = ($breakToggle.StatusCode -eq 200) -and ($breakToggle.Body -and [bool]$breakToggle.Body.ok)
  $flippedOk = $false
  if ($toggleOk) {
    $afterToggle = $null
    try { $afterToggle = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 10 } catch { }
    if ($afterToggle) { $flippedOk = ([bool]$afterToggle.state.breakArmor) -eq (-not [bool]$stateBreak) }
  }
  Add-Check 'POST op=toggle breakArmor 成功（HTTP 200 + ok:true）' $toggleOk ("status=" + $breakToggle.StatusCode + " " + $breakToggle.Error)
  Add-Check 'toggle 后 state.breakArmor 翻转' $flippedOk

  # ------------------------------------------------------------ 9. 逆向模式回归（真实 bug 回归项）
  # 历史 bug（tauri 实机）：POST {"op":"toggle","key":"reverse"} → HTTP 500
  # {"ok":false,"error":"cannot get property \"register\" without inject"}，state 已写但
  # meta.skills=[] / skillsMounted=false（ctx.inject(['skills']) 回调在真实宿主没触发）。
  # 修复后必须：200 + reverse=true + 9 个技能挂载 + selftest 双模式文本都在。
  Write-Step '回归：POST toggle reverse → 技能挂载 9 → 双模式 selftest → reset → 连点幂等'
  $reverseToggle = Invoke-ApiPost -Url $apiUrl -JsonBody '{"op":"toggle","key":"reverse"}'
  $reverseResponseOk = ($reverseToggle.StatusCode -eq 200) `
    -and ($reverseToggle.Body -and [bool]$reverseToggle.Body.ok) `
    -and ($reverseToggle.Body.state -and [bool]$reverseToggle.Body.state.reverse)
  Add-Check 'POST toggle reverse 返回 HTTP 200 + ok:true + reverse=true' $reverseResponseOk `
    ("status=" + $reverseToggle.StatusCode + " error=" + $reverseToggle.Error + " body=" + $reverseToggle.Raw)

  $afterReverse = $null
  try { $afterReverse = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 15 } catch { Write-Detail ("GET 异常：" + $_.Exception.Message) }
  $reverseSkillsMounted = $false
  $reverseSkillsCount = 0
  if ($afterReverse -and $afterReverse.meta) {
    $reverseSkillsMounted = [bool]$afterReverse.meta.skillsMounted
    $reverseSkillsCount = Get-SkillCount -Meta $afterReverse.meta
  }
  Add-Check 'reverse 开启后 meta.skillsMounted=true' $reverseSkillsMounted
  Add-Check 'reverse 开启后 meta.skills 数量=9' ($reverseSkillsCount -eq 9) ("实际=" + $reverseSkillsCount)

  # 宿主内自检：真实调用一次 ctx.systemPrompt.assemble()，断言两模式都进了 section。
  $selftestOk = $false
  $selftestDetail = ''
  $selftestResponse = $null
  try { $selftestResponse = Invoke-RestMethod -Uri ($apiUrl + '?selftest=1') -Method Get -TimeoutSec 30 }
  catch { $selftestDetail = ("请求异常：" + $_.Exception.Message) }
  if ($selftestResponse) {
    $selftest = $selftestResponse.selftest
    $headText = ''
    if ($selftest -and $selftest.sectionHead) { $headText = [string]$selftest.sectionHead }
    $headPrefixed = $headText.StartsWith('## 插件设置面板（dsh-fxxk）')
    $hasBreakOn = $headText.Contains('破甲模式=开')
    $hasReverseOn = $headText.Contains('逆向模式=开')
    $noError = $true
    if ($selftest -and $selftest.error) { $noError = $false }
    $selftestOk = [bool]$selftestResponse.ok `
      -and ([bool]$selftest.sectionPresent) `
      -and ([int]$selftest.sectionChars -gt 0) `
      -and $headPrefixed -and $hasBreakOn -and $hasReverseOn -and $noError
    $selftestDetail = ("sectionPresent=" + $selftest.sectionPresent + " sectionChars=" + $selftest.sectionChars + `
      " headPrefix=" + $headPrefixed + " 破甲模式=开:" + $hasBreakOn + " 逆向模式=开:" + $hasReverseOn + `
      " error=" + $selftest.error)
  }
  Add-Check 'GET ?selftest=1 双模式 section 注入（含「破甲模式=开」「逆向模式=开」）' $selftestOk $selftestDetail

  # reset：两模式关闭 + 技能清空
  $resetResult = Invoke-ApiPost -Url $apiUrl -JsonBody '{"op":"reset"}'
  $afterReset = $null
  try { $afterReset = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 15 } catch { }
  $resetOk = $false
  $resetSkillsCount = -1
  if ($resetResult.StatusCode -eq 200 -and $resetResult.Body -and [bool]$resetResult.Body.ok -and $afterReset) {
    if ($afterReset.meta) { $resetSkillsCount = Get-SkillCount -Meta $afterReset.meta }
    $resetOk = (-not [bool]$afterReset.state.breakArmor) -and (-not [bool]$afterReset.state.reverse) -and ($resetSkillsCount -eq 0)
  }
  Add-Check 'POST reset 后两模式回 false 且 skills 清空' $resetOk ("status=" + $resetResult.StatusCode + " skills=" + $resetSkillsCount)

  # 幂等：连续两次 toggle reverse —— 第一次开并挂载，第二次关并卸载，均不报错。
  $firstIdemToggle = Invoke-ApiPost -Url $apiUrl -JsonBody '{"op":"toggle","key":"reverse"}'
  $afterFirstIdem = $null
  try { $afterFirstIdem = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 15 } catch { }
  $firstIdemOk = ($firstIdemToggle.StatusCode -eq 200) `
    -and ($firstIdemToggle.Body -and [bool]$firstIdemToggle.Body.ok) `
    -and $afterFirstIdem -and [bool]$afterFirstIdem.state.reverse `
    -and $afterFirstIdem.meta -and ([bool]$afterFirstIdem.meta.skillsMounted) `
    -and ((Get-SkillCount -Meta $afterFirstIdem.meta) -eq 9)

  $secondIdemToggle = Invoke-ApiPost -Url $apiUrl -JsonBody '{"op":"toggle","key":"reverse"}'
  $afterSecondIdem = $null
  try { $afterSecondIdem = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 15 } catch { }
  $secondIdemOk = ($secondIdemToggle.StatusCode -eq 200) `
    -and ($secondIdemToggle.Body -and [bool]$secondIdemToggle.Body.ok) `
    -and $afterSecondIdem -and (-not [bool]$afterSecondIdem.state.reverse) `
    -and $afterSecondIdem.meta -and ((Get-SkillCount -Meta $afterSecondIdem.meta) -eq 0)
  Add-Check 'reverse 连续 toggle 幂等（开→挂载 9，关→清空，均不报错）' ($firstIdemOk -and $secondIdemOk) `
    ("first=" + $firstIdemOk + " status=" + $firstIdemToggle.StatusCode + " second=" + $secondIdemOk + " status=" + $secondIdemToggle.StatusCode)

  # ------------------------------------------------------------ 10. CDP 两态断言 + 截图（新版 UI）
  # 新版 UI：常驻「双模式」控制栏取消；设置图标按钮在 conversation.input.left，
  # 点击后设置面板挂到 conversation.input.dock。
  if ($NoScreenshot) {
    Write-Warn '按 -NoScreenshot 跳过无头 Edge 断言/截图'
  } else {
    $cdpScript = Join-Path $PluginRoot 'test\e2e-dock.mjs'
    # 预览版说明弹窗会盖住 composer：先点掉「继续」。
    $dismissPreEval = "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='继续');if(b)b.click();return 'done'})()"

    # ---- 10a. 收起态：input.left 里应存在 dsh-fxxk 设置按钮（图标按钮，aria-label 含关键词）
    Write-Step ("收起态：断言 slot=" + $LeftSlot + " 含设置按钮（" + ($LeftExpect -join ' / ') + "）并截图")
    $collapsedCdp = Invoke-CdpCheck -CdpScript $cdpScript -Url $tokenUrl -PngPath $collapsedScreenshotPath `
      -JsonPath $leftJsonFile -SlotName $LeftSlot -ExpectTexts $LeftExpect -PreEval $dismissPreEval
    $null = Register-CdpChecks -Label '收起态' -Cdp $collapsedCdp -SlotName $LeftSlot -ExpectTexts $LeftExpect -PngPath $collapsedScreenshotPath

    # ---- 10b. 展开态：点按钮 → input.dock 面板出现并含 破甲/逆向/保存，截图保留展开状态
    # pre-eval 里先轮询等按钮渲染（最多 ~10s）再 click；e2e-dock 点击后还会等 slot 出现
    # 并额外 sleep 1.2s（> 要求的 ~800ms），足够面板完成挂载。
    Write-Step ("展开态：点击 " + $LeftSlot + " 的 dsh-fxxk 按钮 → 断言 " + $Slot + " 面板含 " + ($Expect -join ' / ') + " 并截图")
    $clickPreEvalFile = Join-Path $outDir 'e2e-click-preeval.js'
    $clickPreEvalSource = @'
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dismiss = () => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '继续');
    if (button) button.click();
  };
  const findSettingsButton = () => [...document.querySelectorAll('[aria-label]')].find((el) => {
    const label = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    return label.includes('dsh-fxxk') || label.includes('插件设置') || title.includes('插件设置') || title.includes('dsh-fxxk');
  });
  for (let i = 0; i < 40; i += 1) {
    dismiss();
    const button = findSettingsButton();
    if (button) {
      button.click();
      await sleep(200);
      return 'clicked:' + (button.getAttribute('aria-label') || button.getAttribute('title') || '(no-label)');
    }
    await sleep(250);
  }
  return 'button-not-found';
})()
'@
    [System.IO.File]::WriteAllText($clickPreEvalFile, $clickPreEvalSource, (New-Object System.Text.UTF8Encoding($false)))
    $expandedJsonFile = Join-Path $outDir 'e2e-dock.json'
    $expandedCdp = Invoke-CdpCheck -CdpScript $cdpScript -Url $tokenUrl -PngPath $screenshotPath `
      -JsonPath $expandedJsonFile -SlotName $Slot -ExpectTexts $Expect -PreEvalFile $clickPreEvalFile
    $null = Register-CdpChecks -Label '展开态' -Cdp $expandedCdp -SlotName $Slot -ExpectTexts $Expect -PngPath $screenshotPath
    if ($expandedCdp.Result -and $expandedCdp.Result.preEvalResult) {
      $clickResult = [string]$expandedCdp.Result.preEvalResult
      Add-Check '点击设置按钮成功（preEval 返回 clicked:*）' ($clickResult.StartsWith('clicked')) $clickResult
    } else {
      Add-Check '点击设置按钮成功（preEval 返回 clicked:*）' $false 'preEvalResult 缺失'
    }
  }
}
catch {
  Write-Fail ("e2e 异常中止：" + $_.Exception.Message)
  if ($script:Failed -eq 0) { $script:Failed = 1 }
}
finally {
  # ------------------------------------------------------------ 11. 清理
  Write-Step '清理：杀宿主进程树 / 恢复 settings / 删除 Edge 临时 profile'
  if ($startedProcess) { Stop-ProcessTree -ProcessId $startedProcess.Id }
  Start-Sleep -Milliseconds 500
  foreach ($ownerPid in (Get-PortOwners -Port $Port)) { Stop-ProcessTree -ProcessId $ownerPid }
  $leftOwners = Get-PortOwners -Port $Port
  Add-Check "端口 $Port 已释放" ($leftOwners.Count -eq 0) (($leftOwners -join ','))

  if ($settingsExisted) {
    if ($settingsBackup -and (Test-Path -LiteralPath $settingsBackup)) {
      Copy-Item -LiteralPath $settingsBackup -Destination $settingsPath -Force
      Write-Detail "已恢复 settings.json（$settingsBackup）"
    }
  } elseif (Test-Path -LiteralPath $settingsPath) {
    Remove-Item -LiteralPath $settingsPath -Force -ErrorAction SilentlyContinue
    Write-Detail '已删除 e2e 过程中新建的 settings.json（测试前不存在）'
  }

  Get-ChildItem -LiteralPath $outDir -Directory -Filter 'edge-profile-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- 11. 汇总
Write-Host ''
Write-Host '==== e2e 汇总 ====' -ForegroundColor Cyan
foreach ($result in $script:CheckResults) {
  if ($result.Ok) { Write-Host ("  PASS  " + $result.Name) -ForegroundColor Green }
  else { Write-Host ("  FAIL  " + $result.Name + "  " + $result.Detail) -ForegroundColor Red }
}
Write-Host ''
Write-Host "宿主 stdout : $hostOut"
Write-Host "宿主 stderr : $hostErr"
if (Test-Path -LiteralPath $screenshotPath) { Write-Host "截图(展开) : $screenshotPath" }
if (Test-Path -LiteralPath $collapsedScreenshotPath) { Write-Host "截图(收起) : $collapsedScreenshotPath" }

if ($script:Failed -eq 0) {
  Write-Host ''
  Write-Ok "E2E PASS  profile=$Profile  ($($script:CheckResults.Count) 项检查)"
  exit 0
}

Write-Host ''
Write-Fail ("E2E FAIL  profile=$Profile  ($script:Failed / $($script:CheckResults.Count) 项失败)")
exit 1
