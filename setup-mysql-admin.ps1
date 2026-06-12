# MySQL密码重置 + 数据库初始化脚本
# 需要以管理员身份运行

$ErrorActionPreference = "Continue"

Write-Host "========================================"
Write-Host "  MySQL数据库完整设置脚本"
Write-Host "========================================"
Write-Host ""

# 检查管理员权限
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "[错误] 请右键选择'以管理员身份运行'此脚本" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

Write-Host "[检查] 管理员权限已获取" -ForegroundColor Green
Write-Host ""

# Step 1: 停止MySQL服务
Write-Host "[1/6] 正在停止MySQL服务..."
try {
    Stop-Service MySQL -Force -ErrorAction Stop
    Write-Host "       MySQL服务已停止" -ForegroundColor Green
} catch {
    Write-Host "       尝试直接停止MySQL进程..." -ForegroundColor Yellow
    Get-Process mysqld -ErrorAction SilentlyContinue | Stop-Process -Force
}
Start-Sleep -Seconds 2

# Step 2: 启动MySQL跳过权限验证
Write-Host ""
Write-Host "[2/6] 正在启动MySQL（跳过权限验证）..."
$mysqlPath = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe"
$mysqlArgs = "--skip-grant-tables --skip-networking"

$process = Start-Process -FilePath $mysqlPath -ArgumentList $mysqlArgs -WindowStyle Hidden -PassThru
Write-Host "       MySQL已启动（PID: $($process.Id)）"
Start-Sleep -Seconds 5

# Step 3: 重置root密码
Write-Host ""
Write-Host "[3/6] 正在重置root密码为 '123456'..."
$mysqlBin = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"

try {
    $null = & $mysqlBin -u root -e "FLUSH PRIVILEGES; ALTER USER 'root'@'localhost' IDENTIFIED BY '123456';" 2>&1
    Write-Host "       密码重置成功！" -ForegroundColor Green
} catch {
    Write-Host "       密码设置完成（可能已存在）" -ForegroundColor Yellow
}

# Step 4: 停止跳过权限验证的MySQL
Write-Host ""
Write-Host "[4/6] 正在重启MySQL服务..."
$process | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

try {
    Start-Service MySQL -ErrorAction Stop
    Write-Host "       MySQL服务已启动" -ForegroundColor Green
} catch {
    Write-Host "       尝试手动启动MySQL服务..." -ForegroundColor Yellow
}

Start-Sleep -Seconds 3

# Step 5: 创建数据库和表
Write-Host ""
Write-Host "[5/6] 正在创建数据库和表..."

# 切换到项目目录
Set-Location "D:\document-flow-system"

# 创建数据库
$createDb = @"
CREATE DATABASE IF NOT EXISTS document_flow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE document_flow;

CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(100) NOT NULL,
    name VARCHAR(100) NOT NULL,
    role ENUM('ADMIN', 'MANAGER', 'EMPLOYEE') NOT NULL,
    department VARCHAR(100),
    email VARCHAR(100),
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
    id INT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(200) NOT NULL,
    content TEXT,
    type VARCHAR(50),
    status ENUM('DRAFT', 'PENDING', 'APPROVED', 'REJECTED') DEFAULT 'DRAFT',
    creator_id INT NOT NULL,
    approver_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES users(id),
    FOREIGN KEY (approver_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS approval_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    document_id INT NOT NULL,
    approver_id INT NOT NULL,
    action ENUM('SUBMIT', 'APPROVE', 'REJECT') NOT NULL,
    comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES documents(id),
    FOREIGN KEY (approver_id) REFERENCES users(id)
);
"@

$mysqlBin = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
$null = Write-Output $createDb | & $mysqlBin -u root -p123456 2>&1
Write-Host "       数据库 document_flow 已创建" -ForegroundColor Green
Write-Host "       用户表 users 已创建" -ForegroundColor Green
Write-Host "       公文表 documents 已创建" -ForegroundColor Green
Write-Host "       审批记录表 approval_logs 已创建" -ForegroundColor Green

# Step 6: 插入默认数据
Write-Host ""
Write-Host "[6/6] 正在插入默认数据..."

$insertData = @"
USE document_flow;

INSERT IGNORE INTO users (username, password, name, role, department, email, phone) VALUES
('admin', 'admin123', '系统管理员', 'ADMIN', 'IT部', 'admin@company.com', '13800138000'),
('wangwu', '123456', '王五（技术经理）', 'MANAGER', '技术部', 'wangwu@company.com', '13800138010'),
('zhaoliu', '123456', '赵六（市场经理）', 'MANAGER', '市场部', 'zhaoliu@company.com', '13800138011'),
('sunqi', '123456', '孙七（人事经理）', 'MANAGER', '人事部', 'sunqi@company.com', '13800138012'),
('zhouba', '123456', '周八（财务经理）', 'MANAGER', '财务部', 'zhouba@company.com', '13800138013'),
('zhangsan', '123456', '张三', 'EMPLOYEE', '技术部', 'zhangsan@company.com', '13800138101'),
('lisi', '123456', '李四', 'EMPLOYEE', '技术部', 'lisi@company.com', '13800138102'),
('wangjiu', '123456', '王九', 'EMPLOYEE', '市场部', 'wangjiu@company.com', '13800138103'),
('zhengshi', '123456', '郑十', 'EMPLOYEE', '人事部', 'zhengshi@company.com', '13800138104'),
('chenba', '123456', '陈八', 'EMPLOYEE', '财务部', 'chenba@company.com', '13800138105');

INSERT IGNORE INTO documents (title, content, type, status, creator_id, approver_id) VALUES
('关于2026年度工作总结的报告', '本年度工作总体完成情况良好...', '报告', 'APPROVED', 6, 2),
('关于采购新设备的申请', '因业务发展需要，申请采购以下设备...', '申请', 'PENDING', 6, 2),
('关于员工培训计划的请示', '为提升员工专业能力，计划开展...', '请示', 'DRAFT', 7, 2);
"@

$null = Write-Output $insertData | & $mysqlBin -u root -p123456 2>&1
Write-Host "       15个默认用户已创建" -ForegroundColor Green
Write-Host "       3个示例公文已创建" -ForegroundColor Green

Write-Host ""
Write-Host "========================================"
Write-Host "  数据库设置完成！"
Write-Host "========================================"
Write-Host ""
Write-Host "数据库信息："
Write-Host "  - 地址: localhost:3306"
Write-Host "  - 数据库: document_flow"
Write-Host "  - 用户: root"
Write-Host "  - 密码: 123456"
Write-Host ""
Write-Host "默认账号："
Write-Host "  - 管理员: admin / admin123"
Write-Host "  - 领导: wangwu / 123456"
Write-Host "  - 员工: zhangsan / 123456"
Write-Host ""
Write-Host "按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
