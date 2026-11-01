$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3000'

Write-Host 'CampusX dashboard login smoke test' -ForegroundColor Cyan

$loginPage = Invoke-WebRequest -Uri "$base/login.html" -UseBasicParsing
if ($loginPage.StatusCode -ne 200 -or $loginPage.Content -notmatch 'login-form') {
    throw 'Login page did not load.'
}
Write-Host 'PASS login page is reachable' -ForegroundColor Green

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$credential = Get-Credential -Message 'Enter your CampusX dashboard username and password'
$body = @{
    username = $credential.UserName
    password = $credential.GetNetworkCredential().Password
} | ConvertTo-Json

$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -WebSession $session -ContentType 'application/json' -Body $body
if ($login.status -ne 'ok') { throw 'Login endpoint did not return status=ok.' }
Write-Host 'PASS credentials accepted and session cookie issued' -ForegroundColor Green

$me = Invoke-RestMethod -Uri "$base/auth/session" -WebSession $session
if ($me.status -ne 'ok') { throw 'Authenticated session check failed.' }
Write-Host "PASS authenticated session for $($me.user.username)" -ForegroundColor Green

$dashboard = Invoke-WebRequest -Uri "$base/dashboard" -WebSession $session -UseBasicParsing
if ($dashboard.StatusCode -ne 200 -or $dashboard.Content -notmatch 'Campus X') {
    throw 'Dashboard page did not load for authenticated user.'
}
Write-Host 'PASS protected dashboard page loaded' -ForegroundColor Green

$logout = Invoke-RestMethod -Method Post -Uri "$base/auth/logout" -WebSession $session
if ($logout.status -ne 'ok') { throw 'Logout failed.' }
Write-Host 'PASS logout endpoint cleared the session cookie' -ForegroundColor Green

try {
    Invoke-RestMethod -Uri "$base/auth/session" -WebSession $session | Out-Null
    throw 'Session remained valid after logout.'
}
catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -ne 401) { throw }
}
Write-Host 'PASS session is rejected after logout' -ForegroundColor Green
Write-Host 'Dashboard login smoke test passed.' -ForegroundColor Green
