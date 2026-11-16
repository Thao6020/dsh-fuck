<#
.SYNOPSIS
  把 dsh-fxxk 安装进指定 DSH profile（备份 → pnpm add → bundles 追加 → 启动校验 → 失败回滚）。

.DESCRIPTION
  为什么脚本要做三件事而不是一条命令：
    - `dsh plugin --profile <p> add <路径>` 只等价于在 profile 目录里执行 pnpm add，
      它只把包放进 package.json 的 dependencies 和 node_modules 链接，**不会**把包名
      加进 dsh.profile.bundles；没有 bundles 这一层，插件的 cordis.patch.yml 与
      client 半侧都不会被宿主加载（实测）。
    - 安装前必须备份 package.json / pnpm-lock.yaml / cordis.patch.yml，因为 pnpm 会
      改写它们；插件激活失败时要能原样回滚。
    - 装完要真的起一次宿主，看到 /dsh-fxxk/api 返回 ok:true 才算成功。
      宿主对单个插件 apply 抛错是「warning: 1 entry did not activate」，不会整体
      启动失败，所以必须主动 grep 日志判断激活结果。

.PARAMETER Profile
  目标 profile 名，必填、无默认值（刻意如此：绝不能默认落到 tauri 上）。
  测试用 dualtest；真实装配由维护者显式传入。

.PARAMETER PluginRoot
  插件根目录（含 package.json），默认脚本上一级目录。

.PARAMETER DshCmd
  dsh.cmd 路径，默认自动探测（$env:DSH_CMD → %LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd → PATH）。

.PARAMETER ApiPath
  插件 HTTP API 路径，默认 /dsh-fxxk/api。

.PARAMETER BootCheckPort
  启动校验用的端口，默认 3099。

.PARAMETER SkipBootCheck
  跳过「起宿主 + API 校验」这一步（不推荐）。

.PARAMETER ForceBootCheck
  profile 是 tauri 时默认跳过启动校验（避免和正在运行的桌面 GUI 抢状态），
  加这个开关强制校验。

.EXAMPLE
  powershell -File scripts/install.ps1 -Profile dualtest
.EXAMPLE
  powershell -File scripts/install.ps1 -Profile tauri -PluginRoot "C:\path\to\plugin"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Profile,

  [string]$PluginRoot,

  [string]$DshCmd,

  [string]$ApiPath = '/dsh-fxxk/api',

  [string]$PluginName = '',

  [int]$BootCheckPort = 3099,

  [switch]$SkipBootCheck,

  [switch]$ForceBootCheck
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 日志小工具
function Write-Step([string]$Message) { Write-Host "[install] $Message" }
function Write-Ok([string]$Message) { Write-Host "[install] OK   $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "[install] WARN $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "[install] FAIL $Message" -ForegroundColor Red }
function Write-Detail([string]$Message) { Write-Host "           $Message" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 路径探测
function Resolve-PluginRoot {
  param([string]$Candidate)
  if ($Candidate -and $Candidate.Trim() -ne '') {
    return (Resolve-Path -LiteralPath $Candidate).Path
  }
  $fromScript = Join-Path $PSScriptRoot '..'
  return (Resolve-Path -LiteralPath $fromScript).Path
}

function Resolve-Dsh {
  param([string]$Candidate)
  if ($Candidate -and (Test-Path -LiteralPath $Candidate)) { return (Resolve-Path -LiteralPath $Candidate).Path }
  if ($env:DSH_CMD -and (Test-Path -LiteralPath $env:DSH_CMD)) { return (Resolve-Path -LiteralPath $env:DSH_CMD).Path }
  $fromLocal = Join-Path $env:LOCALAPPDATA 'deepseek-harness\bin\dsh.cmd'
  if (Test-Path -LiteralPath $fromLocal) { return $fromLocal }
  $command = Get-Command 'dsh' -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw '找不到 dsh.cmd（试过 -DshCmd、$env:DSH_CMD、%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd、PATH）'
}

function Resolve-Node {
  $command = Get-Command 'node' -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    'E:\nodejs\node.exe'
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw '找不到 node.exe（DSH 本身要求 Node，请检查 PATH）'
}

function Resolve-DshHome {
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return (Resolve-Path -LiteralPath $env:DSH_HOME).Path }
  return (Join-Path $env:USERPROFILE '.dsh')
}

function Read-Utf8Json {
  param([string]$Path)
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  return ($text | ConvertFrom-Json)
}

# 用 node 改 package.json：PowerShell 5.1 的 ConvertTo-Json 会改格式/转义非 ASCII，
# 这里交给 node 的 JSON.stringify(…, null, 2) 保持 2 空格与键顺序。
function Set-BundleSelected {
  param(
    [string]$ManifestPath,
    [string]$PackageName,
    [string]$Node
  )
  $script = @'
const fs = require('fs')
const file = process.argv[2]
const name = process.argv[3]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
const changed = !bundles.includes(name)
if (changed) bundles.push(name)
manifest.dsh.profile.bundles = bundles
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(changed ? 'added' : 'present')
'@
  $tempScript = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-fxxk-bundles-{0}.js" -f ([System.Guid]::NewGuid().ToString('N')))
  try {
    [System.IO.File]::WriteAllText($tempScript, $script, (New-Object System.Text.UTF8Encoding($false)))
    $output = & $Node $tempScript $ManifestPath $PackageName 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("node 修改 bundles 失败：" + ($output -join ' ')) }
    return ($output -join '').Trim()
  } finally {
    Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
  }
}

function Get-PortOwners {
  param([int]$Port)
  try {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    return @()
  }
}

# PowerShell 5.1 的 Start-Process 重定向句柄不允许并发读取，宿主还在写日志时
# 直接 ReadAllText 会抛 "being used by another process"；用 FileShare.ReadWrite 读。
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

function Stop-ProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -and $ProcessId -gt 0) {
    & cmd.exe /c "taskkill /T /F /PID $ProcessId" 2>&1 | Out-Null
  }
}

# 调 dsh.cmd 不能直接 `& $dsh args...`：插件路径带空格、圆括号、中文时，
# PowerShell 5.1 交给 cmd 的二次解析会把 `(1)` / 路径拆坏（实测报
# `\自用插件 was unexpected at this time`）。统一用 cmd.exe + `call "<dsh>" ...`
# 的显式命令行，并由 cmd 自己解析（引号由我们负责），stdout/stderr 重定向到文件。
function Invoke-DshCommand {
  param(
    [string[]]$DshArguments,
    [string]$WorkDir = ''
  )
  $quoted = @()
  foreach ($argument in $DshArguments) {
    $quoted += ('"{0}"' -f ([string]$argument).Replace('"', '""'))
  }
  $argumentLine = '/c call "{0}" {1}' -f $dsh, ($quoted -join ' ')
  $tempOut = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-cmd-{0}.out.log" -f ([System.Guid]::NewGuid().ToString('N')))
  $tempErr = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-cmd-{0}.err.log" -f ([System.Guid]::NewGuid().ToString('N')))
  try {
    $startArgs = @{
      FilePath               = 'cmd.exe'
      ArgumentList           = $argumentLine
      Wait                   = $true
      PassThru               = $true
      WindowStyle            = 'Hidden'
      RedirectStandardOutput = $tempOut
      RedirectStandardError  = $tempErr
    }
    if ($WorkDir -and $WorkDir.Trim() -ne '') { $startArgs.WorkingDirectory = $WorkDir }
    $process = Start-Process @startArgs
    $encoding = [System.Text.Encoding]::GetEncoding(0)  # 系统 ANSI（本机 GBK），cmd/pnpm 输出用这个编码
    $stdout = ''
    $stderr = ''
    if (Test-Path -LiteralPath $tempOut) { $stdout = [System.IO.File]::ReadAllText($tempOut, $encoding) }
    if (Test-Path -LiteralPath $tempErr) { $stderr = [System.IO.File]::ReadAllText($tempErr, $encoding) }
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      Output   = (($stdout + $stderr).Trim())
    }
  } finally {
    Remove-Item -LiteralPath $tempOut, $tempErr -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- 主流程
$PluginRoot = Resolve-PluginRoot -Candidate $PluginRoot
$dsh = Resolve-Dsh -Candidate $DshCmd
$node = Resolve-Node
$dshHome = Resolve-DshHome
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $Profile)
$manifestPath = Join-Path $profileDir 'package.json'

Write-Step "plugin   : $PluginRoot"
Write-Step "profile  : $Profile  ($profileDir)"
Write-Step "dsh      : $dsh"
Write-Step "DSH_HOME : $dshHome"

if (-not (Test-Path -LiteralPath $profileDir)) {
  throw ("profile 不存在：$profileDir`n  测试 profile 请先运行：node test/setup-profile.mjs --profile $Profile")
}
$pluginManifestPath = Join-Path $PluginRoot 'package.json'
if (-not (Test-Path -LiteralPath $pluginManifestPath)) {
  throw "插件根目录缺 package.json：$pluginManifestPath"
}
$pluginManifest = Read-Utf8Json -Path $pluginManifestPath
$packageName = $PluginName
if (-not $packageName -or $packageName.Trim() -eq '') { $packageName = $pluginManifest.name }
if (-not $packageName) { throw '无法确定插件包名（package.json 的 name 为空且未传 -PluginName）' }
Write-Step "package  : $packageName@$($pluginManifest.version)"

if ($Profile -eq 'tauri') {
  Write-Warn '目标 profile 是 tauri（真实桌面 GUI）。本脚本只做备份/安装/可选校验，不会改 profiles/tauri 以外的东西。'
}

# ---------------------------------------------------------------- 1. 备份
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $profileDir (Join-Path '.dsh-fxxk-backup' $stamp)
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$backupFiles = @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml')
$existed = @{}
foreach ($name in $backupFiles) {
  $source = Join-Path $profileDir $name
  $existed[$name] = Test-Path -LiteralPath $source
  if ($existed[$name]) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $backupDir $name) -Force
  }
}
$meta = [ordered]@{
  createdAt   = (Get-Date).ToString('o')
  profile     = $Profile
  pluginRoot  = $PluginRoot
  packageName = $packageName
  version     = $pluginManifest.version
  existed     = $existed
}
[System.IO.File]::WriteAllText(
  (Join-Path $backupDir 'install.json'),
  ($meta | ConvertTo-Json -Depth 5),
  (New-Object System.Text.UTF8Encoding($false))
)
Write-Ok "已备份 profile 清单到：$backupDir"

# ---------------------------------------------------------------- 2. 安装依赖
Write-Step "执行：dsh plugin --profile $Profile add `"$PluginRoot`""
$addResult = Invoke-DshCommand -DshArguments @('plugin', '--profile', $Profile, 'add', $PluginRoot)
$addExit = $addResult.ExitCode
if ($addResult.Output -ne '') { $addResult.Output -split "`r?`n" | ForEach-Object { Write-Detail $_ } }
if ($addExit -ne 0) {
  throw "pnpm add 失败（exit=$addExit），见上方输出；备份在 $backupDir"
}
$current = Read-Utf8Json -Path $manifestPath
$dependencyValue = $current.dependencies.$packageName
if (-not $dependencyValue) {
  throw "pnpm add 后 package.json dependencies 里没有 $packageName"
}
Write-Ok "依赖已写入：$packageName -> $dependencyValue"

# ---------------------------------------------------------------- 3. bundles 选择
$bundleResult = Set-BundleSelected -ManifestPath $manifestPath -PackageName $packageName -Node $node
if ($bundleResult -eq 'added') {
  Write-Ok "已把 $packageName 追加进 dsh.profile.bundles"
} else {
  Write-Ok "$packageName 已在 dsh.profile.bundles 中（幂等）"
}

# ---------------------------------------------------------------- 4. 启动校验
$shouldBootCheck = -not $SkipBootCheck
if ($Profile -eq 'tauri' -and -not $ForceBootCheck) {
  $shouldBootCheck = $false
  Write-Warn 'tauri profile 默认跳过启动校验（避免和正在运行的桌面 GUI 共用 DSH_HOME 时互相干扰）；需要时加 -ForceBootCheck。'
}

if (-not $shouldBootCheck) {
  Write-Warn '已跳过启动校验。安装结果需要宿主重启/刷新后才会生效。'
  Write-Host ''
  Write-Ok "INSTALL PASS（未做启动校验）  profile=$Profile  backup=$backupDir"
  exit 0
}

$outDir = Join-Path $PluginRoot 'test\out'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$bootOut = Join-Path $outDir ("install-boot-{0}.out.log" -f $stamp)
$bootErr = Join-Path $outDir ("install-boot-{0}.err.log" -f $stamp)
$bootPidFile = Join-Path $outDir ("install-boot-{0}.pid" -f $stamp)

$ownerPids = Get-PortOwners -Port $BootCheckPort
if ($ownerPids.Count -gt 0) {
  throw ("启动校验端口 $BootCheckPort 已被占用（PID: " + ($ownerPids -join ',') + "）。换端口 -BootCheckPort 或先清理。")
}

$startedProcess = $null
$bootFailure = $null
try {
  Write-Step "启动校验：dsh --profile $Profile --port $BootCheckPort --no-open"
  $arguments = '/c call "{0}" --profile {1} --port {2} --no-open' -f $dsh, $Profile, $BootCheckPort
  $startedProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList $arguments -RedirectStandardOutput $bootOut -RedirectStandardError $bootErr -PassThru -WindowStyle Hidden
  $startedProcess.Id | Out-File -LiteralPath $bootPidFile -Encoding ascii

  $deadline = (Get-Date).AddSeconds(90)
  $tokenUrl = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $logText = Read-SharedText -Path $bootOut
    $match = [regex]::Match($logText, 'http://127\.0\.0\.1:\d+/\?token=([A-Za-z0-9_\-]+)')
    if ($match.Success) { $tokenUrl = $match.Value; break }
    if ($startedProcess.HasExited) { break }
  }
  if (-not $tokenUrl) {
    $errText = Read-SharedText -Path $bootErr
    throw ("宿主在 90 秒内没有打印带 token 的 URL（可能启动失败）。stderr：`n" + $errText.Trim())
  }
  Write-Ok "宿主已启动：$tokenUrl"

  # 激活检测：宿主对单个插件失败只打 warning。
  $errTextAll = Read-SharedText -Path $bootErr
  if ($errTextAll -match 'did not activate') {
    throw ("插件没有激活（宿主日志出现 did not activate）：`n" + $errTextAll.Trim())
  }

  $baseUrl = ($tokenUrl -replace '/\?token=.*$', '')
  $apiUrl = $baseUrl + $ApiPath
  $api = $null
  for ($i = 0; $i -lt 20; $i = $i + 1) {
    try {
      $api = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 10
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $api) { throw "GET $ApiPath 没有返回 JSON（路由未注册或宿主未就绪）" }
  if (-not $api.ok) { throw "GET $ApiPath 返回 ok=false：$($api | ConvertTo-Json -Depth 5 -Compress)" }
  Write-Ok ("GET " + $ApiPath + " -> ok:true（插件已激活）")

  $page = Invoke-WebRequest -Uri $tokenUrl -UseBasicParsing -TimeoutSec 20
  if ($page.Content -notmatch ('"id":"' + [regex]::Escape($packageName) + '"')) {
    throw "页面 __DSH_BOOT__ 里没有 $packageName（client 半侧未进入 boot graph）"
  }
  Write-Ok "页面 boot graph 含 $packageName（client 半侧已注册）"
}
catch {
  $bootFailure = $_
  Write-Fail $_.Exception.Message
}
finally {
  if ($startedProcess) { Stop-ProcessTree -ProcessId $startedProcess.Id }
  Start-Sleep -Milliseconds 500
  foreach ($ownerPid in (Get-PortOwners -Port $BootCheckPort)) { Stop-ProcessTree -ProcessId $ownerPid }
}

if ($bootFailure) {
  # ------------------------------------------------------------ 5. 回滚
  Write-Warn '安装/激活失败，开始回滚备份……'
  foreach ($name in $backupFiles) {
    $target = Join-Path $profileDir $name
    $backupFile = Join-Path $backupDir $name
    if ($existed[$name]) {
      Copy-Item -LiteralPath $backupFile -Destination $target -Force
      Write-Detail "已恢复 $name"
    } elseif (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Force
      Write-Detail "已删除安装过程新增的 $name"
    }
  }
  Write-Step '同步 node_modules（pnpm install，尽力而为）……'
  $repairResult = Invoke-DshCommand -DshArguments @('plugin', '--profile', $Profile, 'install')
  if ($repairResult.Output -ne '') { $repairResult.Output -split "`r?`n" | ForEach-Object { Write-Detail $_ } }
  if ($repairResult.ExitCode -ne 0) { Write-Warn "pnpm install 退出码 $($repairResult.ExitCode)，node_modules 可能未完全同步" }
  Write-Fail ("INSTALL FAIL：已回滚到 $backupDir 的备份状态。日志：" + $bootOut + ' / ' + $bootErr)
  exit 1
}

Write-Host ''
Write-Ok "INSTALL PASS  profile=$Profile  package=$packageName"
Write-Detail "备份目录：$backupDir"
Write-Detail "启动日志：$bootOut"
Write-Detail "错误日志：$bootErr"
Write-Detail '后续：宿主重启 / 刷新页面后 dock 出现「双模式」控制条。'
exit 0
