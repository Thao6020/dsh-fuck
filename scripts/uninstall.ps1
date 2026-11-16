<#
.SYNOPSIS
  从指定 DSH profile 卸载 dsh-fxxk（移除 bundles 选择 + pnpm 依赖），可选恢复安装前备份。

.DESCRIPTION
  卸载顺序刻意是「先备份当前状态 → 再移除 bundles 选择 → 再 pnpm remove」：
    - bundles 决定宿主是否加载插件；只 pnpm remove 而留着 bundles，宿主会报
      「entry did not activate / 找不到包」，所以必须先改 package.json。
    - 先备份当前 profile 清单，卸载本身也可逆（备份目录会打印出来）。
    - `-RestoreBackup` 直接用安装时留下的 .dsh-fxxk-backup/<stamp> 覆盖回
      package.json / pnpm-lock.yaml / cordis.patch.yml，再 pnpm install 同步
      node_modules（等价于「回到安装前」）。
  用户设置文件 $DSH_HOME/dsh-fxxk/settings.json 不会被删除（重装不丢状态是产品约定）；
  需要清空请手动删。

.PARAMETER Profile
  目标 profile 名，必填、无默认值（绝不能默认落到 tauri 上）。

.PARAMETER RestoreBackup
  安装备份目录路径（.dsh-fxxk-backup/<stamp>），提供时走「恢复备份」而不是普通卸载。

.PARAMETER RestoreLatest
  使用该 profile 下最新的 .dsh-fxxk-backup/<stamp>/install.json 备份。

.PARAMETER KeepDependency
  只移除 bundles 选择，保留 package.json 依赖（罕见；调试用）。

.EXAMPLE
  powershell -File scripts/uninstall.ps1 -Profile dualtest
.EXAMPLE
  powershell -File scripts/uninstall.ps1 -Profile tauri -RestoreLatest
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Profile,

  [string]$DshCmd,

  [string]$Node,

  [string]$PluginName = 'dsh-fxxk',

  [string]$RestoreBackup,

  [switch]$RestoreLatest,

  [switch]$KeepDependency
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "[uninstall] $Message" }
function Write-Ok([string]$Message) { Write-Host "[uninstall] OK   $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "[uninstall] WARN $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "[uninstall] FAIL $Message" -ForegroundColor Red }
function Write-Detail([string]$Message) { Write-Host "             $Message" -ForegroundColor DarkGray }

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
  param([string]$Candidate)
  if ($Candidate -and (Test-Path -LiteralPath $Candidate)) { return (Resolve-Path -LiteralPath $Candidate).Path }
  $command = Get-Command 'node' -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    'E:\nodejs\node.exe'
  )
  foreach ($item in $candidates) {
    if ($item -and (Test-Path -LiteralPath $item)) { return $item }
  }
  throw '找不到 node.exe'
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

# 从 dsh.profile.bundles 移除包名（用 node 保格式，理由同 install.ps1）。
function Remove-BundleSelected {
  param(
    [string]$ManifestPath,
    [string]$PackageName,
    [string]$NodePath
  )
  $script = @'
const fs = require('fs')
const file = process.argv[2]
const name = process.argv[3]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
const bundles = manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
  ? manifest.dsh.profile.bundles : []
const next = bundles.filter((entry) => entry !== name)
const changed = next.length !== bundles.length
if (changed) manifest.dsh.profile.bundles = next
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(changed ? 'removed' : 'absent')
'@
  $tempScript = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-fxxk-unbundles-{0}.js" -f ([System.Guid]::NewGuid().ToString('N')))
  try {
    [System.IO.File]::WriteAllText($tempScript, $script, (New-Object System.Text.UTF8Encoding($false)))
    $output = & $NodePath $tempScript $ManifestPath $PackageName 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("node 修改 bundles 失败：" + ($output -join ' ')) }
    return ($output -join '').Trim()
  } finally {
    Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
  }
}

# 调 dsh.cmd 不能直接 `& $dsh args...`：插件路径带空格/圆括号/中文时，cmd 的二次
# 解析会把参数拆坏（实测 `\自用插件 was unexpected at this time`）。统一走
# cmd.exe + `call "<dsh>" ...`，引号由脚本负责。
function Invoke-DshCommand {
  param([string[]]$DshArguments)
  $quoted = @()
  foreach ($argument in $DshArguments) {
    $quoted += ('"{0}"' -f ([string]$argument).Replace('"', '""'))
  }
  $argumentLine = '/c call "{0}" {1}' -f $dsh, ($quoted -join ' ')
  $tempOut = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-cmd-{0}.out.log" -f ([System.Guid]::NewGuid().ToString('N')))
  $tempErr = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-cmd-{0}.err.log" -f ([System.Guid]::NewGuid().ToString('N')))
  try {
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList $argumentLine -Wait -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $tempOut -RedirectStandardError $tempErr
    $encoding = [System.Text.Encoding]::GetEncoding(0)
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
$dsh = Resolve-Dsh -Candidate $DshCmd
$nodePath = Resolve-Node -Candidate $Node
$dshHome = Resolve-DshHome
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $Profile)
$manifestPath = Join-Path $profileDir 'package.json'

Write-Step "profile  : $Profile  ($profileDir)"
Write-Step "dsh      : $dsh"

if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile 不存在：$profileDir" }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "profile 缺 package.json：$manifestPath" }

$backupRoot = Join-Path $profileDir '.dsh-fxxk-backup'

# ---------------------------------------------------------------- 分支：恢复备份
$restoreDir = $null
if ($RestoreLatest) {
  if (-not (Test-Path -LiteralPath $backupRoot)) { throw "没有备份目录：$backupRoot" }
  $latest = Get-ChildItem -LiteralPath $backupRoot -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'install.json') } |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if (-not $latest) { throw "备份目录里没有含 install.json 的备份：$backupRoot" }
  $restoreDir = $latest.FullName
} elseif ($RestoreBackup -and $RestoreBackup.Trim() -ne '') {
  if (-not (Test-Path -LiteralPath $RestoreBackup)) { throw "备份目录不存在：$RestoreBackup" }
  $restoreDir = (Resolve-Path -LiteralPath $RestoreBackup).Path
}

if ($restoreDir) {
  Write-Step "恢复备份：$restoreDir"
  foreach ($name in @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml')) {
    $source = Join-Path $restoreDir $name
    $target = Join-Path $profileDir $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination $target -Force
      Write-Ok "已恢复 $name"
    } elseif (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Force
      Write-Ok "已删除备份中不存在的 $name"
    }
  }
  Write-Step '同步 node_modules（pnpm install）……'
  $repairResult = Invoke-DshCommand -DshArguments @('plugin', '--profile', $Profile, 'install')
  if ($repairResult.Output -ne '') { $repairResult.Output -split "`r?`n" | ForEach-Object { Write-Detail $_ } }
  if ($repairResult.ExitCode -ne 0) {
    Write-Fail "pnpm install 失败（exit=$($repairResult.ExitCode)）。手动执行：dsh plugin --profile $Profile install"
    exit 1
  }
  Write-Host ''
  Write-Ok "RESTORE PASS  profile=$Profile  已回到备份时点：$restoreDir"
  Write-Detail '宿主重启 / 刷新页面后生效。'
  exit 0
}

# ---------------------------------------------------------------- 普通卸载
# 先备份当前状态，卸载也可逆。
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $backupRoot $stamp
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$existed = @{}
foreach ($name in @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml')) {
  $source = Join-Path $profileDir $name
  $existed[$name] = Test-Path -LiteralPath $source
  if ($existed[$name]) { Copy-Item -LiteralPath $source -Destination (Join-Path $backupDir $name) -Force }
}
$before = Read-Utf8Json -Path $manifestPath
$dependencyBefore = $null
if ($before.dependencies) { $dependencyBefore = $before.dependencies.$PluginName }
$meta = [ordered]@{
  createdAt      = (Get-Date).ToString('o')
  action         = 'uninstall'
  profile        = $Profile
  packageName    = $PluginName
  dependency     = $dependencyBefore
  existed        = $existed
}
[System.IO.File]::WriteAllText(
  (Join-Path $backupDir 'install.json'),
  ($meta | ConvertTo-Json -Depth 5),
  (New-Object System.Text.UTF8Encoding($false))
)
Write-Ok "卸载前状态已备份：$backupDir"

$bundleResult = Remove-BundleSelected -ManifestPath $manifestPath -PackageName $PluginName -NodePath $nodePath
if ($bundleResult -eq 'removed') { Write-Ok "已从 dsh.profile.bundles 移除 $PluginName" }
else { Write-Warn "$PluginName 本来就不在 dsh.profile.bundles 中（幂等）" }

$removedDependency = $false
if ($KeepDependency) {
  Write-Warn '按 -KeepDependency 保留 package.json 依赖（只移除了 bundles 选择）。'
} elseif ($dependencyBefore) {
  Write-Step "执行：dsh plugin --profile $Profile remove $PluginName"
  $removeResult = Invoke-DshCommand -DshArguments @('plugin', '--profile', $Profile, 'remove', $PluginName)
  $removeExit = $removeResult.ExitCode
  if ($removeResult.Output -ne '') { $removeResult.Output -split "`r?`n" | ForEach-Object { Write-Detail $_ } }
  if ($removeExit -ne 0) {
    Write-Warn "pnpm remove 失败（exit=$removeExit）；package.json 依赖可能需要手动清理。"
  } else {
    $removedDependency = $true
  }
} else {
  Write-Warn "$PluginName 不在 package.json dependencies 中（可能已卸载）。"
}

$after = Read-Utf8Json -Path $manifestPath
$stillDependency = $false
if ($after.dependencies) { $stillDependency = [bool]$after.dependencies.$PluginName }

if ($removedDependency -and -not $stillDependency) {
  Write-Host ''
  Write-Ok "UNINSTALL PASS  profile=$Profile  package=$PluginName"
  Write-Detail "卸载前备份：$backupDir"
  Write-Detail '用户设置 $DSH_HOME/dsh-fxxk/settings.json 保留（重装不丢）。'
  Write-Detail '宿主重启 / 刷新页面后 dock 消失。'
  exit 0
}

Write-Fail ("UNINSTALL FAIL：依赖可能仍残留（stillDependency=$stillDependency）。备份：$backupDir")
exit 1
