$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $username = Read-Host 'Choose CampusX dashboard username'
    $securePassword = Read-Host 'Choose dashboard password (12+ characters)' -AsSecureString
    $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
        $env:DASHBOARD_SETUP_USERNAME = $username
        $env:DASHBOARD_SETUP_PASSWORD = $plainPassword
        node .\scripts\create-dashboard-credentials.js
        if ($LASTEXITCODE -ne 0) { throw 'Credential generation failed.' }
    }
    finally {
        if ($passwordPtr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
        }
        Remove-Item Env:DASHBOARD_SETUP_USERNAME -ErrorAction SilentlyContinue
        Remove-Item Env:DASHBOARD_SETUP_PASSWORD -ErrorAction SilentlyContinue
        $plainPassword = $null
    }
}
finally {
    Pop-Location
}
