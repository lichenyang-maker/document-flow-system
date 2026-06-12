$ErrorActionPreference = "SilentlyContinue"
$mysql = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"

$passwords = @('root', 'mysql', 'password', 'admin', '12345678', 'letmein', 'root123', 'root123456', 'admin123')

foreach ($pwd in $passwords) {
    $result = & $mysql -u root -p"$pwd" -e "SELECT 'OK' as test;" 2>&1
    if ($result -match "OK") {
        Write-Host "SUCCESS: Password found: $pwd"
        exit 0
    }
}

Write-Host "FAILED: No valid password found"
exit 1
