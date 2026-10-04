# DSH 应用图标 —— 一键修复 / 还原脚本
#
# 用途：当切换图标后 Windows 仍显示白图标时修复。
#
# 用法（推荐用 fix-icon.cmd 启动，它会自动带上 -ExecutionPolicy Bypass）：
#   fix-icon.cmd recreate   # 【最强】删除并重建快捷方式文件，换成 PNG 图标
#   fix-icon.cmd apply <图标名>  # 应用图标库里的某个图标（.png/.ico 均可）
#   fix-icon.cmd restore    # 还原到切换前的原始图标
#   fix-icon.cmd clear      # 只重建图标缓存
#
# 为什么需要 recreate：实测确认图标文件本身完全正常（shell 能渲染出 256x256、63428 个
# 不透明像素），快捷方式指向也正确，但 Explorer 仍显示白图标。两个原因叠加：
#   1) 图标位置不被 Explorer 接受时，图标显示为空白
#      -> 因此本脚本会把图标复制到 $env:USERPROFILE\.dsh\app-icons 再引用
#         （实测该位置可用；插件目录内的图标即使路径无空格也会显示空白，真因未查明）
#   2) Explorer 对原快捷方式文件持有陈旧状态
#      -> 因此「删除后重建」比「原地改写」更彻底
#
# 说明：本脚本必须由**你自己**运行。DSH 的 agent 工具受沙箱限制，对桌面和开始菜单
# 目录只有读权限，无法改写快捷方式。
#
# 编码：本文件是 UTF-8 **带 BOM**。Windows PowerShell 5.1 会把无 BOM 的 UTF-8 按 ANSI
# 解码，导致中文注释破坏 param 块解析（实测过）。带 BOM 才安全。

param(
  [ValidateSet('recreate', 'apply', 'restore', 'rebuild', 'clear', 'list')]
  [string]$Action = 'recreate',
  [string]$IconName = '',
  [string]$StateFile = "$PSScriptRoot\.state\shortcuts.json",
  [string]$UniqueIconName = 'dsh-current'
)

$ErrorActionPreference = 'Stop'

# 本插件管理的启动器；只有 TargetPath 指向它的快捷方式才会被改写。
$DshExe = 'D:\Program Files\DSH\DeepSeek Harness.exe'
$LibraryDir = Join-Path $PSScriptRoot 'icons'

# ⚠️ 图标文件必须放到这个目录再引用。不要改成插件目录内的路径。
#
# 实测：插件目录里的图标（无论路径是否含空格）都会让快捷方式显示**空白图标**；
# 只有复制到 $env:USERPROFILE\.dsh\app-icons 才正常。空格、盘符、目录新旧、junction
# 都已逐项排除，真因未查明。完整对照表见 INVESTIGATION.md。
$StableDir = Join-Path $env:USERPROFILE '.dsh\app-icons'

# 已知的原始图标（可选覆盖）。state 文件里的 original 可能被早先版本的 rebuild 覆盖过，
# 因此这里可保存一份权威记录，restore 时优先使用。
#
# 留空表示"从 state 文件读 original"；只有在 state 已不可信、需要硬指定时才填。
# 路径用 $env:USERPROFILE 拼，不要写死用户名。
$KnownOriginals = @{
  'Start Menu' = ''
  'TaskBar'    = ''
  'Desktop'    = ''
}

function Get-ShortcutKind([string]$Path) {
  if ($Path -like '*User Pinned\TaskBar*') { return 'TaskBar' }
  if ($Path -like '*Start Menu*') { return 'Start Menu' }
  return 'Desktop'
}

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "    !!  $Text" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# 重建 Windows 图标缓存
# 关键：iconcache 数据库文件被 Explorer 占用，必须在停掉 Explorer 之后再删，
# 否则删除会失败（表现为「无需清理或均被占用」），缓存也就不会真正重建。
# ---------------------------------------------------------------------------
function Rebuild-IconCache {
  Write-Step '重建 Windows 图标缓存'

  $hadExplorer = @(Get-Process explorer -ErrorAction SilentlyContinue).Count -gt 0
  if ($hadExplorer) {
    Write-Host '    停止 Explorer...'
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }

  $cacheDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
  $removed = 0
  $failed = 0
  if (Test-Path $cacheDir) {
    Get-ChildItem $cacheDir -Filter 'iconcache*.db' -Force -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        Remove-Item $_.FullName -Force -ErrorAction Stop
        $removed++
      } catch {
        $failed++
      }
    }
  }
  Write-Ok "已删除 iconcache 数据库 $removed 个（失败 $failed 个）"
  if ($failed -gt 0) {
    Write-Warn2 '有文件仍被占用，若图标依旧异常请重启电脑后再试一次'
  }

  # 通知 shell 重新读取图标
  $ie4uinit = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
  if (Test-Path $ie4uinit) {
    Start-Process -FilePath $ie4uinit -ArgumentList '-show' -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
    Write-Ok 'ie4uinit -show 完成'
  }

  if ($hadExplorer -and -not (Get-Process explorer -ErrorAction SilentlyContinue)) {
    Write-Host '    重新启动 Explorer...'
    Start-Process explorer.exe
    Start-Sleep -Seconds 3
  }
  Write-Ok '图标缓存重建完成'
}

# ---------------------------------------------------------------------------
# 读取快捷方式，按需改写图标
# ---------------------------------------------------------------------------
function Get-DshShortcuts {
  $appData = $env:APPDATA
  $userProfile = $env:USERPROFILE
  $dirs = @(
    (Join-Path $appData 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $appData 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
    (Join-Path $userProfile 'Desktop')
  )
  $shell = New-Object -ComObject WScript.Shell
  $found = @()
  foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) { continue }
    Get-ChildItem $dir -Filter *.lnk -File -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -notmatch 'deepseek|harness|dsh') { return }
      try {
        $sc = $shell.CreateShortcut($_.FullName)
        if ($sc.TargetPath -eq $DshExe) { $found += $_.FullName }
      } catch { }
    }
  }
  return , $found
}

# 删除并**重新创建**快捷方式文件。
# 与原地改写相比，这会换掉文件本身，Explorer 必须先丢弃对旧文件的任何持有状态，
# 因此能解决「文件内容正确但仍显示白图标」的情况。
function New-ShortcutFile([string]$Lnk, [string]$IconLocation) {
  $shell = New-Object -ComObject WScript.Shell
  $target = $DshExe
  $working = Split-Path $DshExe -Parent
  $args0 = ''
  $desc = ''

  # 先尽量保留原有属性（Arguments / Description），避免重建后行为变化
  if (Test-Path $Lnk) {
    try {
      $old = $shell.CreateShortcut($Lnk)
      if ($old.TargetPath) { $target = $old.TargetPath }
      if ($old.WorkingDirectory) { $working = $old.WorkingDirectory }
      if ($old.Arguments) { $args0 = $old.Arguments }
      if ($old.Description) { $desc = $old.Description }
    } catch { }
  }

  try {
    if (Test-Path $Lnk) { Remove-Item $Lnk -Force -ErrorAction Stop }
  } catch {
    Write-Warn2 ((Split-Path $Lnk -Leaf) + '  无法删除旧文件: ' + $_.Exception.Message)
    return $false
  }

  try {
    $sc = $shell.CreateShortcut($Lnk)
    $sc.TargetPath = $target
    if ($working) { $sc.WorkingDirectory = $working }
    if ($args0) { $sc.Arguments = $args0 }
    if ($desc) { $sc.Description = $desc }
    $sc.IconLocation = $IconLocation
    $sc.Save()
    $back = $shell.CreateShortcut($Lnk).IconLocation
    if ($back -eq $IconLocation) {
      Write-Ok ((Split-Path $Lnk -Leaf) + '  已重建 -> ' + $IconLocation)
      return $true
    }
    Write-Warn2 ((Split-Path $Lnk -Leaf) + '  重建后回读不一致: ' + $back)
    return $false
  } catch {
    Write-Warn2 ((Split-Path $Lnk -Leaf) + '  重建失败: ' + $_.Exception.Message)
    return $false
  }
}

function Set-ShortcutIcon([string]$Lnk, [string]$IconLocation) {
  $shell = New-Object -ComObject WScript.Shell
  try {
    $sc = $shell.CreateShortcut($Lnk)
    $sc.IconLocation = $IconLocation
    $sc.Save()
    $back = $shell.CreateShortcut($Lnk).IconLocation
    if ($back -eq $IconLocation) {
      Write-Ok ((Split-Path $Lnk -Leaf) + '  ->  ' + $IconLocation)
      return $true
    }
    Write-Warn2 ((Split-Path $Lnk -Leaf) + '  写入后回读不一致: ' + $back)
    return $false
  } catch {
    Write-Warn2 ((Split-Path $Lnk -Leaf) + '  写入失败: ' + $_.Exception.Message)
    return $false
  }
}

$shortcuts = Get-DshShortcuts
Write-Step ("找到 " + $shortcuts.Count + " 个指向 DSH 的快捷方式")
$shortcuts | ForEach-Object { Write-Host ('    ' + $_) }
Write-Host ''

function Save-State([hashtable]$AppliedMap) {
  $state = [ordered]@{ shortcuts = [ordered]@{} }
  if (Test-Path $StateFile) {
    try { $state = Get-Content -Raw $StateFile | ConvertFrom-Json } catch { }
  }
  foreach ($lnk in $shortcuts) {
    $kind = Get-ShortcutKind $lnk
    # $KnownOriginals 里没填（空串）时，沿用 state 里已有的 original
    $original = $KnownOriginals[$kind]
    $applied = $AppliedMap[$lnk]
    $existing = $state.shortcuts.$lnk
    # original 只在首次记录时写入：早先版本的 rebuild 曾把它覆盖掉，这里用权威表兜底
    if (-not [string]::IsNullOrEmpty($original)) {
      $originalValue = $original
    } elseif ($null -eq $existing -or [string]::IsNullOrEmpty($existing.original) -or
        $existing.original -like '*dsh-current-*') {
      # 既没有权威值、state 里也没有可用值 -> 用启动器自带图标，比留空安全
      $originalValue = "$DshExe,0"
    } else {
      $originalValue = $existing.original
    }
    $state.shortcuts | Add-Member -NotePropertyName $lnk -NotePropertyValue ([ordered]@{
      original = $originalValue
      applied = $applied
      appliedAt = (Get-Date).ToUniversalTime().ToString('o')
    }) -Force
  }
  $state | ConvertTo-Json -Depth 8 | Set-Content -Path $StateFile -Encoding UTF8
  Write-Ok '状态文件已更新'
}

function Find-LibraryIcon([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
  foreach ($ext in @('.png', '.ico', '.jpg', '.jpeg', '.webp')) {
    $candidate = Join-Path $LibraryDir ($Name + $ext)
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

# ---------------------------------------------------------------------------
if ($Action -eq 'list') {
  Write-Step '图标库内容'
  Get-ChildItem $LibraryDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.ico', '.png', '.jpg', '.jpeg', '.webp' } |
    Sort-Object Name | ForEach-Object {
      Write-Host ('    ' + $_.BaseName.PadRight(30) + $_.Length.ToString().PadLeft(9) + ' B  ' + $_.Name)
    }
  Write-Host ''
  Write-Step '快捷方式当前图标'
  $shell = New-Object -ComObject WScript.Shell
  foreach ($lnk in $shortcuts) {
    $icon = $shell.CreateShortcut($lnk).IconLocation
    Write-Host ('    ' + (Get-ShortcutKind $lnk).PadRight(11) + $icon)
  }
  exit 0
}

if ($Action -eq 'clear') {
  Rebuild-IconCache
  Write-Host ''
  Write-Host '完成。若仍显示白图标，请重启电脑。' -ForegroundColor Cyan
  exit 0
}

if ($Action -eq 'restore') {
  Write-Step '还原到原始图标（优先用 $KnownOriginals，留空则读 state）'
  $map = @{}
  $okCount = 0
  # 读一份 state，供 $KnownOriginals 留空时取 original
  $stateOriginals = @{}
  if (Test-Path $StateFile) {
    try {
      $s = Get-Content -Raw $StateFile | ConvertFrom-Json
      foreach ($lnk in $shortcuts) { $stateOriginals[$lnk] = $s.shortcuts.$lnk.original }
    } catch { }
  }
  foreach ($lnk in $shortcuts) {
    $kind = Get-ShortcutKind $lnk
    $icon = $KnownOriginals[$kind]
    if ([string]::IsNullOrEmpty($icon)) { $icon = $stateOriginals[$lnk] }
    if ([string]::IsNullOrEmpty($icon)) { $icon = "$DshExe,0" }
    Write-Host ('    ' + $kind + ' 原值 = ' + $icon)
    if (Set-ShortcutIcon $lnk $icon) { $okCount++; $map[$lnk] = $icon }
  }
  Save-State $map
  Rebuild-IconCache
  Write-Host ''
  Write-Host ("完成，已还原 $okCount 个快捷方式。") -ForegroundColor Cyan
  exit 0
}

# 把图标复制到已验证可用的稳定目录，并返回新路径。
# 实测：直接引用插件目录里的图标会显示为空白，必须复制到 $StableDir 再引用。
function Copy-ToStableDir([string]$SourcePath) {
  if (-not (Test-Path $StableDir)) {
    New-Item -ItemType Directory -Force -Path $StableDir | Out-Null
    Write-Ok ('已创建图标暂存目录: ' + $StableDir)
  }
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $name = 'dsh-' + $stamp + [System.IO.Path]::GetExtension($SourcePath)
  $dest = Join-Path $StableDir $name
  Copy-Item -LiteralPath $SourcePath -Destination $dest -Force
  Write-Ok ('图标已复制到: ' + $dest)
  Write-Host ('    （该路径不含空格，长度 ' + $dest.Length + ' 字符）')
  return $dest
}

# apply / recreate 共用的目标图标解析
$sourceIcon = $null
if ($Action -eq 'apply') {
  # 支持两种写法：图标库里的名字（例如 dsh-icon-v3），或一个图标文件的完整路径。
  # 完整路径让诊断更方便——可以直接应用任意位置的图标而无需先放进图标库。
  if ((Test-Path $IconName) -and $IconName -match '\.(ico|png|jpg|jpeg|webp)$') {
    $sourceIcon = (Resolve-Path $IconName).Path
    Write-Step ('应用指定文件: ' + $sourceIcon)
  } else {
    $sourceIcon = Find-LibraryIcon $IconName
    if ($null -eq $sourceIcon) {
      Write-Warn2 ("图标库里找不到「" + $IconName + "」，它也不是一个存在的图标文件路径")
      Write-Host '    先用 fix-icon.cmd list 看有哪些图标'
      exit 1
    }
    Write-Step ('应用图标: ' + (Split-Path $sourceIcon -Leaf))
  }
} else {
  # recreate：优先用 PNG。PNG 是完全不同的显示路径，能避开 .ico 解析差异。
  $png = Get-ChildItem $LibraryDir -Filter '*.png' -File -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending | Select-Object -First 1
  if ($png) {
    $sourceIcon = $png.FullName
    Write-Step ('重建快捷方式，使用 PNG 图标: ' + $png.Name)
  } else {
    if (Test-Path $StateFile) {
      $st = Get-Content -Raw $StateFile | ConvertFrom-Json
      $first = $shortcuts | Select-Object -First 1
      if ($first) { $sourceIcon = ($st.shortcuts.$first.applied -split ',')[0] }
    }
    if (-not $sourceIcon -or -not (Test-Path $sourceIcon)) {
      Write-Warn2 '找不到可用的 PNG 图标，且状态文件里也没有可用图标'
      exit 1
    }
    Write-Step ('重建快捷方式，沿用当前图标: ' + (Split-Path $sourceIcon -Leaf))
  }
}

# 关键一步：把图标搬到无空格目录，之后 IconLocation 只引用新路径
$targetIcon = Copy-ToStableDir $sourceIcon

$location = $targetIcon + ',0'
Write-Host ('    将写入 IconLocation = ' + $location)
$map = @{}
$okCount = 0
foreach ($lnk in $shortcuts) {
  $ok = if ($Action -eq 'recreate') {
    New-ShortcutFile $lnk $location
  } else {
    Set-ShortcutIcon $lnk $location
  }
  if ($ok) { $okCount++; $map[$lnk] = $location }
}

Save-State $map
Rebuild-IconCache

Write-Host ''
Write-Host ("完成，已处理 $okCount / " + $shortcuts.Count + " 个快捷方式。") -ForegroundColor Cyan
if ($okCount -lt $shortcuts.Count) {
  Write-Warn2 '有快捷方式未能写入成功，请把上面的输出发给我'
}
Write-Host '若仍显示白图标，请重启电脑（开机时 Explorer 会真正重建缓存）。' -ForegroundColor Cyan
