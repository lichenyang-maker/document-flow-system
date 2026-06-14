# auto-push.ps1 - 自动检测文件变更并推送到 GitHub
# 使用 FileSystemWatcher 高效监听文件变化（无需轮询）
#
# 安装开机自启:
#   右键 install-autopush.bat → "以管理员身份运行"
#
# 手动启动:
#   powershell -ExecutionPolicy Bypass -File "auto-push.ps1"
#
# 卸载:
#   schtasks /delete /tn "DocumentFlowAutoPush" /f

param(
    [switch]$Install,
    [switch]$Uninstall
)

$watchDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $watchDir "auto-push.log"

function Write-Log {
    param($msg)
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$time $msg" | Out-File -FilePath $logFile -Append -Encoding UTF8
}

# ===== 安装计划任务 =====
if ($Install) {
    $taskName = "DocumentFlowAutoPush"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoLogo -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
        Write-Host "✅ 计划任务 '$taskName' 已创建！"
        Write-Host "   日志: $logFile"
        Write-Host "   开机后自动运行，后台无窗口"
    } catch {
        Write-Host "❌ 安装失败: $_"
        Write-Host "   请以管理员身份运行此脚本"
    }
    return
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName "DocumentFlowAutoPush" -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "✅ 已卸载"
    return
}

# ===== 主逻辑 =====
Write-Log "🚀 自动推送启动 (监听模式)"
Write-Log "📁 $watchDir"

# 忽略列表
$ignoredPatterns = @(
    '\\node_modules\\', '\\.git\\', '\\.codebuddy\\',
    '\\server_(out|err|_output|_error)\.txt$',
    '\\auto-push\.log$', '\\.db$', '\\.db-journal$', '\\.db-wal$', '\\.db-shm$'
)

function Should-Ignore {
    param($path)
    foreach ($p in $ignoredPatterns) {
        if ($path -match $p) { return $true }
    }
    return $false
}

# 设置文件监听器
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $watchDir
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName -bor `
    [System.IO.NotifyFilters]::LastWrite -bor `
    [System.IO.NotifyFilters]::DirectoryName
$watcher.InternalBufferSize = 65536  # 64KB 减少丢事件

$global:hasChanges = $false
$global:changeTimer = $null

# 变更事件处理
$scriptBlock = {
    $path = $Event.SourceEventArgs.FullPath
    $name = $Event.SourceEventArgs.Name
    if (Should-Ignore $path) { return }
    $global:hasChanges = $true
}

# 注册事件
Register-ObjectEvent -InputObject $watcher -EventName Changed -Action $scriptBlock -SupportEvent > $null
Register-ObjectEvent -InputObject $watcher -EventName Created -Action $scriptBlock -SupportEvent > $null
Register-ObjectEvent -InputObject $watcher -EventName Deleted -Action $scriptBlock -SupportEvent > $null
Register-ObjectEvent -InputObject $watcher -EventName Renamed -Action $scriptBlock -SupportEvent > $null

$watcher.EnableRaisingEvents = $true

Write-Log "👂 开始监听文件变化..."

while ($true) {
    Start-Sleep -Seconds 5

    if ($global:hasChanges) {
        $global:hasChanges = $false

        # 防抖：等待 8 秒确保文件写完
        Start-Sleep -Seconds 8

        # 再检查一次是否有新变更（防抖期间又来了变化）
        if ($global:hasChanges) {
            $global:hasChanges = $false
            Start-Sleep -Seconds 5
        }

        try {
            Push-Location $watchDir

            $changed = & git status --porcelain 2>$null
            if (-not $changed) { Pop-Location; continue }

            Write-Log "📦 检测到变更"

            & git add -A 2>$null
            $staged = & git diff --cached --name-only 2>$null

            if ($staged) {
                $msg = "auto: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
                & git commit -m $msg 2>$null
                $result = & git push origin main 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Log "✅ 推送成功"
                } else {
                    Write-Log "❌ 推送失败: $result"
                }
            }
            Pop-Location
            Start-Sleep -Seconds 10
        } catch {
            Write-Log "❌ 错误: $_"
        }
    }
}
