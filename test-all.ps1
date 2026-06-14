# ========================================
# 公文流转系统 - 全功能测试脚本
# ========================================
$ErrorActionPreference = "Continue"
$base = "http://localhost:3000"
$pass = 0
$fail = 0
$results = @()

function Test($name, $result, $details) {
    if ($result) {
        $global:pass++
        Write-Host "  [PASS] $name" -ForegroundColor Green
        $global:results += "[PASS] $name"
    } else {
        $global:fail++
        Write-Host "  [FAIL] $name - $details" -ForegroundColor Red
        $global:results += "[FAIL] $name - $details"
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  公文流转系统 - 全功能测试" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# ========================================
# Part 1: 飞书 API 测试 (不依赖服务器)
# ========================================
Write-Host "--- Part 1: 飞书 API 凭证测试 ---" -ForegroundColor Yellow

$feishuResult = node -e "
const axios = require('axios');
(async () => {
    try {
        const r = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
            { app_id: 'cli_aaa152828fb95bda', app_secret: '61tkmvxLdXZ2Tx0m4AgZFez4CC0xvzjx' },
            { headers: {'Content-Type':'application/json'}, timeout:10000 });
        if (r.data.code === 0) {
            console.log('TOKEN_OK');
            const token = r.data.tenant_access_token;
            // 测试发送消息到群
            const msg = await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
                { receive_id: 'oc_a30a910385446ce307f8eb5436050ad1', msg_type: 'text',
                  content: JSON.stringify({text:'【系统测试】公文流转系统全功能测试 - 飞书消息发送正常'}) },
                { headers: {Authorization:'Bearer '+token,'Content-Type':'application/json'}, timeout:10000 });
            if (msg.data.code === 0) {
                console.log('SEND_OK');
            } else {
                console.log('SEND_FAIL:' + msg.data.code + ':' + msg.data.msg);
            }
        } else {
            console.log('TOKEN_FAIL:' + r.data.code + ':' + r.data.msg);
        }
    } catch(e) {
        console.log('ERROR:' + e.message);
    }
})();
" 2>&1

Write-Host "  飞书测试输出: $feishuResult"
if ($feishuResult -match "TOKEN_OK") {
    Test "飞书 Tenant Token 获取" $true ""
} else {
    Test "飞书 Tenant Token 获取" $false $feishuResult
}
if ($feishuResult -match "SEND_OK") {
    Test "飞书消息发送" $true ""
} else {
    Test "飞书消息发送" $false $feishuResult
}

# ========================================
# Part 2: 启动服务器
# ========================================
Write-Host "`n--- Part 2: 启动服务器 ---" -ForegroundColor Yellow

$server = Start-Process -FilePath "node" -ArgumentList "server-sqlite.js" -PassThru -NoNewWindow -RedirectStandardOutput "server_test_out.txt" -RedirectStandardError "server_test_err.txt"
Start-Sleep -Seconds 4

# 检查服务器是否启动
try {
    $health = Invoke-RestMethod -Uri "$base/health" -Method Get -TimeoutSec 5
    Test "服务器启动 (健康检查)" $true "$($health | ConvertTo-Json -Compress)"
    Write-Host "  健康检查响应: $($health | ConvertTo-Json -Compress)"
} catch {
    Test "服务器启动 (健康检查)" $false $_.Exception.Message
    Write-Host "  服务器可能未启动，尝试继续..." -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}

# ========================================
# Part 3: 页面路由测试
# ========================================
Write-Host "`n--- Part 3: 页面路由测试 ---" -ForegroundColor Yellow

$pages = @(
    @{name="首页"; path="/"},
    @{name="AI聊天"; path="/chat"},
    @{name="飞书"; path="/feishu"},
    @{name="飞书聊天"; path="/feishu-chat"}
)

foreach ($p in $pages) {
    try {
        $res = Invoke-WebRequest -Uri "$base$($p.path)" -Method Get -TimeoutSec 5
        Test "页面: $($p.name)" ($res.StatusCode -eq 200) "Status: $($res.StatusCode)"
    } catch {
        Test "页面: $($p.name)" $false $_.Exception.Message
    }
}

# ========================================
# Part 4: 登录 + Token 测试
# ========================================
Write-Host "`n--- Part 4: 登录 API 测试 ---" -ForegroundColor Yellow

$token = $null
$loginBody = @{username="admin";password="admin123"} | ConvertTo-Json
try {
    $loginRes = Invoke-RestMethod -Uri "$base/api/public/login" -Method Post -Body $loginBody -ContentType "application/json" -TimeoutSec 5
    if ($loginRes.token) {
        $token = $loginRes.token
        Test "登录 (admin)" $true "token: $($token.Substring(0,20))..."
    } else {
        Test "登录 (admin)" $false ($loginRes | ConvertTo-Json -Compress)
    }
} catch {
    Test "登录 (admin)" $false $_.Exception.Message
}

$headers = @{Authorization="Bearer $token"; "Content-Type"="application/json"}

# 用户信息
if ($token) {
    try {
        $me = Invoke-RestMethod -Uri "$base/api/auth/me" -Headers $headers -TimeoutSec 5
        Test "获取用户信息" ($me.username -eq "admin") "username: $($me.username)"
    } catch {
        Test "获取用户信息" $false $_.Exception.Message
    }
}

# ========================================
# Part 5: 统计 API 测试
# ========================================
Write-Host "`n--- Part 5: 统计 API 测试 ---" -ForegroundColor Yellow

if ($token) {
    try {
        $stats = Invoke-RestMethod -Uri "$base/api/stats" -Headers $headers -TimeoutSec 5
        Test "系统统计" ($stats -ne $null) ($stats | ConvertTo-Json -Compress)
    } catch {
        Test "系统统计" $false $_.Exception.Message
    }

    try {
        $balance = Invoke-RestMethod -Uri "$base/api/stats/balance" -Headers $headers -TimeoutSec 5
        Test "假期余额" ($balance -ne $null) ($balance | ConvertTo-Json -Compress)
    } catch {
        Test "假期余额" $false $_.Exception.Message
    }

    try {
        $myLeave = Invoke-RestMethod -Uri "$base/api/stats/my-leave" -Headers $headers -TimeoutSec 5
        Test "我的请假" ($myLeave -ne $null) ($myLeave | ConvertTo-Json -Compress)
    } catch {
        Test "我的请假" $false $_.Exception.Message
    }

    try {
        $pending = Invoke-RestMethod -Uri "$base/api/stats/pending" -Headers $headers -TimeoutSec 5
        Test "待审批列表" ($pending -ne $null) ($pending | ConvertTo-Json -Compress)
    } catch {
        Test "待审批列表" $false $_.Exception.Message
    }

    # 自然语言统计查询
    $queries = @("balance", "my-leave", "pending", "docs")
    foreach ($q in $queries) {
        try {
            $qr = Invoke-RestMethod -Uri "$base/api/stats/query" -Headers $headers -Method Post -Body (@{query=$q} | ConvertTo-Json) -TimeoutSec 10
            Test "自然语言查询: $q" ($qr -ne $null) "OK"
        } catch {
            Test "自然语言查询: $q" $false $_.Exception.Message
        }
    }
}

# ========================================
# Part 6: 公文 API 测试
# ========================================
Write-Host "`n--- Part 6: 公文 API 测试 ---" -ForegroundColor Yellow

if ($token) {
    try {
        $docs = Invoke-RestMethod -Uri "$base/api/docs" -Headers $headers -TimeoutSec 5
        Test "公文列表" ($docs -ne $null) "count: $($docs.Count)"
    } catch {
        Test "公文列表" $false $_.Exception.Message
    }

    try {
        $newDoc = @{title="【测试】测试公文";content="这是自动测试创建的公文";type="通知";priority="普通"} | ConvertTo-Json
        $docRes = Invoke-RestMethod -Uri "$base/api/docs" -Headers $headers -Method Post -Body $newDoc -TimeoutSec 5
        Test "创建公文" ($docRes -ne $null) "id: $($docRes.id)"
    } catch {
        Test "创建公文" $false $_.Exception.Message
    }
}

# ========================================
# Part 7: 请假 API 测试
# ========================================
Write-Host "`n--- Part 7: 请假 API 测试 ---" -ForegroundColor Yellow

if ($token) {
    try {
        $leaves = Invoke-RestMethod -Uri "$base/api/leave" -Headers $headers -TimeoutSec 5
        Test "请假列表" ($leaves -ne $null) "count: $($leaves.Count)"
    } catch {
        Test "请假列表" $false $_.Exception.Message
    }

    try {
        $leaveStats = Invoke-RestMethod -Uri "$base/api/leave/stats" -Headers $headers -TimeoutSec 5
        Test "请假统计" ($leaveStats -ne $null) ($leaveStats | ConvertTo-Json -Compress)
    } catch {
        Test "请假统计" $false $_.Exception.Message
    }

    try {
        $newLeave = @{type="年假";start_date="2026-06-20";end_date="2026-06-21";days=2;reason="【测试】自动测试创建"} | ConvertTo-Json
        $leaveRes = Invoke-RestMethod -Uri "$base/api/leave" -Headers $headers -Method Post -Body $newLeave -TimeoutSec 5
        Test "创建请假" ($leaveRes -ne $null) "id: $($leaveRes.id)"
    } catch {
        Test "创建请假" $false $_.Exception.Message
    }
}

# ========================================
# Part 8: AI 智能体 API 测试
# ========================================
Write-Host "`n--- Part 8: AI 智能体 API 测试 ---" -ForegroundColor Yellow

if ($token) {
    try {
        $agents = Invoke-RestMethod -Uri "$base/api/agents" -TimeoutSec 5
        Test "智能体列表" ($agents.agents -ne $null -and $agents.agents.Count -gt 0) "count: $($agents.agents.Count)"
    } catch {
        Test "智能体列表" $false $_.Exception.Message
    }

    # AI 对话 (简单问题,快速)
    try {
        $chatBody = @{agentId="general";message="你好";context=@()} | ConvertTo-Json
        $chatRes = Invoke-RestMethod -Uri "$base/api/agents/chat" -Headers $headers -Method Post -Body $chatBody -TimeoutSec 30
        Test "AI 对话 (general)" ($chatRes.reply -ne $null -or $chatRes.success -eq $true) "reply length: $($chatRes.reply.Length)"
    } catch {
        Test "AI 对话 (general)" $false $_.Exception.Message
    }

    # 意图分类
    try {
        $classifyBody = @{message="我想请年假3天"} | ConvertTo-Json
        $classifyRes = Invoke-RestMethod -Uri "$base/api/agents/classify" -Headers $headers -Method Post -Body $classifyBody -TimeoutSec 15
        Test "意图分类" ($classifyRes.intent -ne $null) "intent: $($classifyRes.intent)"
    } catch {
        Test "意图分类" $false $_.Exception.Message
    }

    # 数据分析 Agent
    try {
        $dataBody = @{agentId="data";message="我的假期余额是多少";context=@()} | ConvertTo-Json
        $dataRes = Invoke-RestMethod -Uri "$base/api/agents/chat" -Headers $headers -Method Post -Body $dataBody -TimeoutSec 30
        Test "AI 对话 (data agent)" ($dataRes.reply -ne $null -or $dataRes.success -eq $true) "OK"
    } catch {
        Test "AI 对话 (data agent)" $false $_.Exception.Message
    }
}

# ========================================
# Part 9: 飞书集成 API 测试
# ========================================
Write-Host "`n--- Part 9: 飞书集成 API 测试 ---" -ForegroundColor Yellow

try {
    $feishuConfig = Invoke-RestMethod -Uri "$base/api/feishu/config" -TimeoutSec 5
    Test "飞书配置" ($feishuConfig -ne $null) ($feishuConfig | ConvertTo-Json -Compress)
} catch {
    Test "飞书配置" $false $_.Exception.Message
}

if ($token) {
    try {
        $bindings = Invoke-RestMethod -Uri "$base/api/feishu/bindings" -Headers $headers -TimeoutSec 5
        Test "飞书绑定列表" ($bindings -ne $null) "count: $($bindings.Count)"
    } catch {
        Test "飞书绑定列表" $false $_.Exception.Message
    }

    # 通知配置
    try {
        $notifyConfig = Invoke-RestMethod -Uri "$base/api/notify/config" -Headers $headers -TimeoutSec 5
        Test "通知配置" ($notifyConfig -ne $null) ($notifyConfig | ConvertTo-Json -Compress)
    } catch {
        Test "通知配置" $false $_.Exception.Message
    }
}

# ========================================
# Part 10: 多智能体协作 API 测试
# ========================================
Write-Host "`n--- Part 10: 多智能体协作 API 测试 ---" -ForegroundColor Yellow

if ($token) {
    try {
        $modes = Invoke-RestMethod -Uri "$base/api/agents/collaboration/modes" -TimeoutSec 5
        Test "协作模式列表" ($modes.modes -ne $null) "count: $($modes.modes.Count)"
    } catch {
        Test "协作模式列表" $false $_.Exception.Message
    }

    try {
        $planBody = @{task="分析最近请假数据并生成报告";mode="sequential"} | ConvertTo-Json
        $planRes = Invoke-RestMethod -Uri "$base/api/agents/collaboration/plan" -Headers $headers -Method Post -Body $planBody -TimeoutSec 30
        Test "协作计划生成" ($planRes.plan -ne $null -or $planRes.success -eq $true) "OK"
    } catch {
        Test "协作计划生成" $false $_.Exception.Message
    }
}

# ========================================
# Part 11: 停止服务器
# ========================================
Write-Host "`n--- 停止服务器 ---" -ForegroundColor Yellow

if ($server) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Write-Host "  服务器已停止"
}

# ========================================
# 总结
# ========================================
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  测试完成" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  通过: $pass" -ForegroundColor Green
Write-Host "  失败: $fail" -ForegroundColor Red
Write-Host "  总计: $($pass + $fail)" -ForegroundColor White

if ($fail -eq 0) {
    Write-Host "`n  [OK] 所有测试通过!" -ForegroundColor Green
} else {
    Write-Host "`n  [WARN] 有 $fail 个测试失败" -ForegroundColor Yellow
    Write-Host "  失败列表:" -ForegroundColor Yellow
    foreach ($r in $results) {
        if ($r -match "\[FAIL\]") {
            Write-Host "    $r" -ForegroundColor Red
        }
    }
}

# 输出到文件
$results | Out-File -FilePath "test-all-results.txt" -Encoding utf8
Write-Host "`n  详细结果已保存到 test-all-results.txt" -ForegroundColor White
