<#
.SYNOPSIS
    Standalone Wan2GP MCP Server launcher for a Pinokio installation.

.DESCRIPTION
    Validated for the WanGP native MCP launch pattern:
      python wgp.py --mcp --mcp-transport streamable-http --mcp-host <IP> --mcp-port <PORT> --mcp-allow-read-file-system

    Features:
    - Uses the Python executable inside Wan2GP's Pinokio virtual environment.
    - Auto-detects the local Tailscale IPv4 address, falling back to 127.0.0.1
      on a machine that is not on a tailnet.
    - Starts Wan2GP as a hidden background process with timestamped logs.
    - Records and verifies process identity before stopping it.
    - Detects port conflicts.
    - Enables MCP filesystem reads, which clients that send reference images by
      path require; pass -NoFilesystemReads to leave them disabled.
    - Provides Start, Stop, Restart, Status, Validate, Copy URL, and Log actions.

    Default Wan2GP folder:
      C:\pinokio\api\wan.git\app
#>

[CmdletBinding()]
param(
    [ValidateSet("Menu", "Start", "Stop", "Restart", "Status", "Validate")]
    [string]$Action = "Menu",

    # Pinokio's default install location. Set WAN2GP_PATH to point elsewhere
    # without editing this script or passing the argument every time.
    [string]$Wan2GPPath = $(if ($env:WAN2GP_PATH) { $env:WAN2GP_PATH } else { "C:\pinokio\api\wan.git\app" }),

    [ValidateRange(1, 65535)]
    [int]$Port = 7866,

    # Blank: bind the auto-detected Tailscale IPv4 address, or 127.0.0.1 when
    # this machine is not on a tailnet.
    # 0.0.0.0: listen on all interfaces.
    # 127.0.0.1: local access only.
    [string]$BindAddress = "",

    [ValidateRange(10, 900)]
    [int]$StartupTimeoutSeconds = 180,

    # WanGP made server file paths opt-in. A client that hands it a reference
    # image by path - a character photograph, a carried-over frame - has every
    # job refused without them, so they are on unless this is passed.
    [switch]$NoFilesystemReads,

    [switch]$NoPause
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$LauncherVersion = "1.4"
$LauncherDataPath = Join-Path $env:LOCALAPPDATA "Wan2GP-MCP-Launcher"
$StateFile = Join-Path $LauncherDataPath "wan2gp-mcp-state.json"
$CurrentLogFile = Join-Path $LauncherDataPath "current-log.txt"

# The prefixed spelling, because this launcher goes through wgp.py. Running
# shared\mcp_server.py directly takes the bare --allow-read-file-system.
$FilesystemReadsFlag = "--mcp-allow-read-file-system"

# Pinokio renames this folder between Wan2GP versions — the v12.45 upgrade moved
# "env" to "venv" — so the launcher looks rather than assumes. Newest layout
# first, so an install carrying both folders picks the current one.
$PythonCandidatePaths = @(
    "venv\Scripts\python.exe",
    "env\Scripts\python.exe",
    ".venv\Scripts\python.exe"
)

function Write-Banner {
    Clear-Host
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "             Wan2GP MCP Launcher v$LauncherVersion" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Ensure-DataFolder {
    if (-not (Test-Path -LiteralPath $LauncherDataPath -PathType Container)) {
        New-Item -ItemType Directory -Path $LauncherDataPath -Force | Out-Null
    }
}

function Test-IPv4Address {
    param([string]$Address)

    if ([string]::IsNullOrWhiteSpace($Address)) {
        return $false
    }

    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) {
        return $false
    }

    return $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
}

function Test-TailscaleIPv4 {
    param([string]$Address)

    if (-not (Test-IPv4Address -Address $Address)) {
        return $false
    }

    $parsed = [System.Net.IPAddress]::Parse($Address)
    $bytes = $parsed.GetAddressBytes()

    # Tailscale IPv4 addresses are allocated from 100.64.0.0/10.
    return ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127)
}

function Get-TailscaleCliPath {
    $command = Get-Command "tailscale.exe" -ErrorAction SilentlyContinue
    if ($command) {
        if ($command.PSObject.Properties.Name -contains "Path" -and $command.Path) {
            return $command.Path
        }
        if ($command.PSObject.Properties.Name -contains "Source" -and $command.Source) {
            return $command.Source
        }
    }

    $commonPaths = @(
        "C:\Program Files\Tailscale\tailscale.exe",
        "C:\Program Files (x86)\Tailscale\tailscale.exe"
    )

    foreach ($candidate in $commonPaths) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

function Get-LocalTailscaleIPv4 {
    $tailscaleExe = Get-TailscaleCliPath

    if ($tailscaleExe) {
        try {
            $result = @(& $tailscaleExe ip -4 2>$null)
            foreach ($line in $result) {
                $candidate = ([string]$line).Trim()
                if (Test-TailscaleIPv4 -Address $candidate) {
                    return $candidate
                }
            }
        }
        catch {
            # Fall through to Windows adapter discovery.
        }
    }

    $getNetIpAddress = Get-Command "Get-NetIPAddress" -ErrorAction SilentlyContinue
    if ($getNetIpAddress) {
        try {
            $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                Where-Object {
                    $_.AddressState -ne "Invalid" -and
                    (Test-TailscaleIPv4 -Address ([string]$_.IPAddress))
                }

            $firstAddress = $addresses | Select-Object -First 1
            if ($firstAddress) {
                return ([string]$firstAddress.IPAddress).Trim()
            }
        }
        catch {
            # A clear error is raised below.
        }
    }

    throw "A local Tailscale IPv4 address could not be detected. Confirm Tailscale is connected, or pass -BindAddress with the address to listen on."
}

# Null rather than an error when there is no tailnet: Tailscale is how this
# machine is reached, not something the server needs to run.
function Find-LocalTailscaleIPv4 {
    try {
        return Get-LocalTailscaleIPv4
    }
    catch {
        return $null
    }
}

function Resolve-BindConfiguration {
    $localTailscaleIp = $null

    if ([string]::IsNullOrWhiteSpace($BindAddress)) {
        $localTailscaleIp = Find-LocalTailscaleIPv4
        if ($localTailscaleIp) {
            return @{
                BindAddress      = $localTailscaleIp
                AdvertiseAddress = $localTailscaleIp
                TailscaleAddress = $localTailscaleIp
            }
        }

        # Loopback rather than a refusal to start: a machine with no tailnet can
        # still serve a client on the same PC, which is the common case.
        Write-Host "[WARN] No Tailscale IPv4 address was found, so the server will listen on 127.0.0.1 only." -ForegroundColor Yellow
        Write-Host "       Pass -BindAddress <ip> to listen somewhere reachable from another machine." -ForegroundColor Yellow
        return @{
            BindAddress      = "127.0.0.1"
            AdvertiseAddress = "127.0.0.1"
            TailscaleAddress = $null
        }
    }

    $requestedAddress = $BindAddress.Trim()
    if (-not (Test-IPv4Address -Address $requestedAddress)) {
        throw "The bind address '$requestedAddress' is not a valid IPv4 address."
    }

    if ($requestedAddress -eq "0.0.0.0") {
        # Only the URL to hand a client. Binding every interface cannot depend on
        # Tailscale being present.
        $localTailscaleIp = Find-LocalTailscaleIPv4
        return @{
            BindAddress      = $requestedAddress
            AdvertiseAddress = $(if ($localTailscaleIp) { $localTailscaleIp } else { "127.0.0.1" })
            TailscaleAddress = $localTailscaleIp
        }
    }

    if ($requestedAddress -eq "127.0.0.1") {
        return @{
            BindAddress      = $requestedAddress
            AdvertiseAddress = $requestedAddress
            TailscaleAddress = $null
        }
    }

    # A server can only bind to an address assigned to this PC.
    $getNetIpAddress = Get-Command "Get-NetIPAddress" -ErrorAction SilentlyContinue
    if ($getNetIpAddress) {
        $localMatch = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $requestedAddress -ErrorAction SilentlyContinue
        if (-not $localMatch) {
            throw "The bind address '$requestedAddress' is not assigned to this PC."
        }
    }

    return @{
        BindAddress      = $requestedAddress
        AdvertiseAddress = $requestedAddress
        TailscaleAddress = $(if (Test-TailscaleIPv4 -Address $requestedAddress) { $requestedAddress } else { $null })
    }
}

function Get-PythonSearchPaths {
    param([string]$AppPath)

    return @($PythonCandidatePaths | ForEach-Object { Join-Path $AppPath $_ })
}

function Resolve-PythonExe {
    param([string]$AppPath)

    foreach ($candidate in Get-PythonSearchPaths -AppPath $AppPath) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

function Get-Paths {
    $appPath = [System.IO.Path]::GetFullPath($Wan2GPPath)

    return @{
        AppPath        = $appPath
        # Null when no virtual environment was found; callers report the search.
        PythonExe      = Resolve-PythonExe -AppPath $appPath
        PythonSearched = Get-PythonSearchPaths -AppPath $appPath
        WgpScript      = Join-Path $appPath "wgp.py"
        McpServer      = Join-Path $appPath "shared\mcp_server.py"
        ConfigFile     = Join-Path $appPath "wgp_config.json"
    }
}

function Assert-Prerequisites {
    param([hashtable]$Paths)

    if (-not (Test-Path -LiteralPath $Paths.AppPath -PathType Container)) {
        throw "Wan2GP folder was not found: $($Paths.AppPath)"
    }
    if (-not $Paths.PythonExe) {
        $searched = ($Paths.PythonSearched | ForEach-Object { "  $_" }) -join "`n"
        throw "No virtual-environment Python was found under $($Paths.AppPath).`nLooked for:`n$searched`nPinokio renames this folder between Wan2GP versions. If yours is elsewhere, run the launcher with -Wan2GPPath pointing at the folder that contains it."
    }
    if (-not (Test-Path -LiteralPath $Paths.WgpScript -PathType Leaf)) {
        throw "Wan2GP entry script was not found: $($Paths.WgpScript)"
    }
    if (-not (Test-Path -LiteralPath $Paths.McpServer -PathType Leaf)) {
        throw "Wan2GP's MCP adapter was not found: $($Paths.McpServer). Update Wan2GP before using MCP mode."
    }
}

function Test-Wan2GPMcpArguments {
    param([hashtable]$Paths)

    $requiredTokens = @(
        "--mcp",
        "--mcp-transport",
        "--mcp-host",
        "--mcp-port"
    )

    $content = Get-Content -LiteralPath $Paths.WgpScript -Raw
    $missing = @()

    foreach ($token in $requiredTokens) {
        if ($content.IndexOf($token, [System.StringComparison]::Ordinal) -lt 0) {
            $missing += $token
        }
    }

    return $missing
}

# Older Wan2GP builds predate the option, and passing one argparse does not know
# stops the server booting at all - worse than the refusals it would prevent.
function Test-FilesystemReadsSupported {
    param([hashtable]$Paths)

    $content = Get-Content -LiteralPath $Paths.WgpScript -Raw
    return $content.IndexOf($FilesystemReadsFlag, [System.StringComparison]::Ordinal) -ge 0
}

function Get-PythonVersion {
    param([hashtable]$Paths)

    $output = @(& $Paths.PythonExe --version 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "The Pinokio Python executable returned exit code $LASTEXITCODE."
    }

    return (($output | Select-Object -First 1) -as [string]).Trim()
}

function Get-ListenerForPort {
    param([int]$TargetPort)

    $getNetTcpConnection = Get-Command "Get-NetTCPConnection" -ErrorAction SilentlyContinue
    if ($getNetTcpConnection) {
        try {
            $connection = Get-NetTCPConnection -State Listen -LocalPort $TargetPort -ErrorAction Stop |
                Select-Object -First 1

            if ($connection) {
                return @{
                    Pid          = [int]$connection.OwningProcess
                    LocalAddress = [string]$connection.LocalAddress
                    LocalPort    = [int]$connection.LocalPort
                }
            }
        }
        catch {
            # No listener, or cmdlet did not return a usable result.
        }
    }

    try {
        $lines = @(& netstat.exe -ano -p tcp 2>$null)
        $pattern = "^\s*TCP\s+(\S+):$TargetPort\s+\S+\s+LISTENING\s+(\d+)\s*$"

        foreach ($line in $lines) {
            if ([string]$line -match $pattern) {
                return @{
                    Pid          = [int]$Matches[2]
                    LocalAddress = [string]$Matches[1]
                    LocalPort    = $TargetPort
                }
            }
        }
    }
    catch {
        # Return no result.
    }

    return $null
}

function Test-TcpEndpoint {
    param(
        [string]$Address,
        [int]$TargetPort
    )

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync($Address, $TargetPort)

        if (-not $task.Wait(1000)) {
            $client.Dispose()
            return $false
        }

        $connected = $client.Connected
        $client.Dispose()
        return $connected
    }
    catch {
        return $false
    }
}

function Save-LauncherState {
    param(
        [System.Diagnostics.Process]$Process,
        [hashtable]$Paths,
        [hashtable]$Network,
        [string]$StdoutLog,
        [string]$StderrLog
    )

    $state = [ordered]@{
        LauncherVersion   = $LauncherVersion
        Pid               = $Process.Id
        ProcessStartUtc   = $Process.StartTime.ToUniversalTime().ToString("o")
        PythonExe         = $Paths.PythonExe
        WgpScript         = $Paths.WgpScript
        BindAddress       = $Network.BindAddress
        AdvertiseAddress  = $Network.AdvertiseAddress
        Port              = $Port
        StdoutLog         = $StdoutLog
        StderrLog         = $StderrLog
        CreatedUtc        = (Get-Date).ToUniversalTime().ToString("o")
    }

    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
    Set-Content -LiteralPath $CurrentLogFile -Value $StdoutLog -Encoding UTF8
}

function Read-LauncherState {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    }
    catch {
        Write-Host "The launcher state file was invalid and has been removed." -ForegroundColor Yellow
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Test-ManagedProcessIdentity {
    param(
        [object]$State,
        [System.Diagnostics.Process]$Process
    )

    try {
        $expectedStart = [DateTime]::Parse([string]$State.ProcessStartUtc).ToUniversalTime()
        $actualStart = $Process.StartTime.ToUniversalTime()

        if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 2) {
            return $false
        }
    }
    catch {
        return $false
    }

    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($Process.Id)" -ErrorAction Stop
        if (-not $cim) {
            return $false
        }

        $expectedPython = [System.IO.Path]::GetFullPath([string]$State.PythonExe)
        $actualPython = [string]$cim.ExecutablePath

        if ($actualPython -and -not $actualPython.Equals($expectedPython, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }

        $commandLine = [string]$cim.CommandLine
        if ($commandLine) {
            if ($commandLine.IndexOf("--mcp", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                return $false
            }

            $scriptName = [System.IO.Path]::GetFileName([string]$State.WgpScript)
            if ($commandLine.IndexOf($scriptName, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                return $false
            }
        }
    }
    catch {
        # Start time plus PID still protects against most stale-PID reuse.
        # Do not fail only because CIM inspection is unavailable.
    }

    return $true
}

function Get-ManagedProcess {
    Ensure-DataFolder
    $state = Read-LauncherState

    if (-not $state) {
        return $null
    }

    $pidValue = 0
    if (-not [int]::TryParse([string]$state.Pid, [ref]$pidValue)) {
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    if (-not (Test-ManagedProcessIdentity -State $state -Process $process)) {
        Write-Host "A stale process record was detected. The launcher will not stop PID $pidValue." -ForegroundColor Yellow
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    return @{
        Process = $process
        State   = $state
    }
}

function Get-CurrentLogPath {
    $state = Read-LauncherState
    if ($state -and $state.StdoutLog -and (Test-Path -LiteralPath ([string]$state.StdoutLog) -PathType Leaf)) {
        return [string]$state.StdoutLog
    }

    if (Test-Path -LiteralPath $CurrentLogFile -PathType Leaf) {
        $path = (Get-Content -LiteralPath $CurrentLogFile -Raw).Trim()
        if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $path
        }
    }

    return $null
}

function Get-CurrentErrorLogPath {
    $state = Read-LauncherState
    if ($state -and $state.StderrLog -and (Test-Path -LiteralPath ([string]$state.StderrLog) -PathType Leaf)) {
        return [string]$state.StderrLog
    }

    return $null
}

function Get-EndpointFromStateOrConfiguration {
    $managed = Get-ManagedProcess
    if ($managed) {
        return "http://$($managed.State.AdvertiseAddress):$($managed.State.Port)/mcp"
    }

    $network = Resolve-BindConfiguration
    return "http://$($network.AdvertiseAddress):$Port/mcp"
}

function Show-Status {
    Ensure-DataFolder
    $managed = Get-ManagedProcess

    if ($managed) {
        $process = $managed.Process
        $state = $managed.State
        $endpoint = "http://$($state.AdvertiseAddress):$($state.Port)/mcp"

        Write-Host "Status:       RUNNING" -ForegroundColor Green
        Write-Host "Process ID:   $($process.Id)"
        Write-Host "Process:      $($process.ProcessName)"
        Write-Host "Bind address: $($state.BindAddress)"
        Write-Host "MCP URL:      $endpoint" -ForegroundColor Cyan

        $listening = Test-TcpEndpoint -Address ([string]$state.AdvertiseAddress) -TargetPort ([int]$state.Port)
        if ($listening) {
            Write-Host "TCP port:     LISTENING" -ForegroundColor Green
        }
        else {
            Write-Host "TCP port:     STARTING / NOT REACHABLE" -ForegroundColor Yellow
        }

        Write-Host "Output log:   $($state.StdoutLog)"
        Write-Host "Error log:    $($state.StderrLog)"
        return
    }

    Write-Host "Status:       STOPPED" -ForegroundColor Yellow

    try {
        $network = Resolve-BindConfiguration
        Write-Host "Expected URL: http://$($network.AdvertiseAddress):$Port/mcp"
    }
    catch {
        Write-Host "Tailscale:    NOT DETECTED" -ForegroundColor Yellow
    }

    $listener = Get-ListenerForPort -TargetPort $Port
    if ($listener) {
        Write-Host "Port ${Port}:    IN USE by PID $($listener.Pid) on $($listener.LocalAddress)" -ForegroundColor Yellow
    }
}

function Invoke-Validation {
    Write-Host "Running launcher preflight checks..." -ForegroundColor Cyan
    Write-Host ""

    $failed = $false
    $paths = Get-Paths

    $checks = @(
        @{ Name = "Wan2GP application folder"; Path = $paths.AppPath; Type = "Container" },
        @{ Name = "Wan2GP wgp.py"; Path = $paths.WgpScript; Type = "Leaf" },
        @{ Name = "Wan2GP MCP adapter"; Path = $paths.McpServer; Type = "Leaf" }
    )

    foreach ($check in $checks) {
        if (Test-Path -LiteralPath $check.Path -PathType $check.Type) {
            Write-Host "[PASS] $($check.Name)" -ForegroundColor Green
            Write-Host "       $($check.Path)"
        }
        else {
            Write-Host "[FAIL] $($check.Name)" -ForegroundColor Red
            Write-Host "       $($check.Path)"
            $failed = $true
        }
    }

    if ($paths.PythonExe) {
        Write-Host "[PASS] Virtual-environment Python" -ForegroundColor Green
        Write-Host "       $($paths.PythonExe)"
    }
    else {
        Write-Host "[FAIL] Virtual-environment Python" -ForegroundColor Red
        foreach ($candidate in $paths.PythonSearched) {
            Write-Host "       looked for $candidate"
        }
        $failed = $true
    }

    if (-not $failed) {
        try {
            $version = Get-PythonVersion -Paths $paths
            Write-Host "[PASS] Python starts successfully: $version" -ForegroundColor Green
        }
        catch {
            Write-Host "[FAIL] Python could not be started: $($_.Exception.Message)" -ForegroundColor Red
            $failed = $true
        }

        try {
            $missingArguments = @(Test-Wan2GPMcpArguments -Paths $paths)
            if ($missingArguments.Count -eq 0) {
                Write-Host "[PASS] Wan2GP contains the expected MCP command-line options" -ForegroundColor Green
            }
            else {
                Write-Host "[FAIL] Missing MCP options: $($missingArguments -join ', ')" -ForegroundColor Red
                Write-Host "       Update Wan2GP through Pinokio before launching MCP."
                $failed = $true
            }

            if (-not (Test-FilesystemReadsSupported -Paths $paths)) {
                Write-Host "[WARN] This Wan2GP build has no $FilesystemReadsFlag option" -ForegroundColor Yellow
                Write-Host "       Clients that send reference images by path will have every job refused."
            }
            elseif ($NoFilesystemReads) {
                Write-Host "[WARN] Filesystem reads are switched off by -NoFilesystemReads" -ForegroundColor Yellow
                Write-Host "       Clients that send reference images by path will have every job refused."
            }
            else {
                Write-Host "[PASS] Filesystem reads will be enabled ($FilesystemReadsFlag)" -ForegroundColor Green
            }
        }
        catch {
            Write-Host "[FAIL] Could not inspect wgp.py: $($_.Exception.Message)" -ForegroundColor Red
            $failed = $true
        }
    }

    try {
        $network = Resolve-BindConfiguration
        Write-Host "[PASS] Bind address: $($network.BindAddress)" -ForegroundColor Green
        Write-Host "[PASS] Client endpoint: http://$($network.AdvertiseAddress):$Port/mcp" -ForegroundColor Green
    }
    catch {
        Write-Host "[FAIL] Network binding: $($_.Exception.Message)" -ForegroundColor Red
        $failed = $true
    }

    $managed = Get-ManagedProcess
    $listener = Get-ListenerForPort -TargetPort $Port

    if ($managed) {
        Write-Host "[PASS] Launcher-managed Wan2GP process is running (PID $($managed.Process.Id))" -ForegroundColor Green
    }
    elseif ($listener) {
        Write-Host "[WARN] Port $Port is already in use by PID $($listener.Pid)." -ForegroundColor Yellow
        Write-Host "       The launcher will not start a second service on this port."
    }
    else {
        Write-Host "[PASS] Port $Port is available" -ForegroundColor Green
    }

    if (Test-Path -LiteralPath $paths.ConfigFile -PathType Leaf) {
        Write-Host "[PASS] Existing Wan2GP configuration found: $($paths.ConfigFile)" -ForegroundColor Green
    }
    else {
        Write-Host "[WARN] wgp_config.json was not found. Wan2GP may create/use defaults." -ForegroundColor Yellow
    }

    Write-Host ""
    if ($failed) {
        Write-Host "VALIDATION RESULT: FAILED" -ForegroundColor Red
        return $false
    }

    Write-Host "VALIDATION RESULT: PASSED" -ForegroundColor Green
    return $true
}

function Start-Wan2GPMcp {
    Ensure-DataFolder

    $paths = Get-Paths
    Assert-Prerequisites -Paths $paths

    $missingArguments = @(Test-Wan2GPMcpArguments -Paths $paths)
    if ($missingArguments.Count -gt 0) {
        throw "This Wan2GP installation is missing MCP options: $($missingArguments -join ', '). Update Wan2GP through Pinokio."
    }

    $existing = Get-ManagedProcess
    if ($existing) {
        Write-Host "Wan2GP MCP is already running with PID $($existing.Process.Id)." -ForegroundColor Yellow
        Show-Status
        return
    }

    $listener = Get-ListenerForPort -TargetPort $Port
    if ($listener) {
        throw "TCP port $Port is already in use by PID $($listener.Pid) on $($listener.LocalAddress). Stop that service or use another -Port value."
    }

    $network = Resolve-BindConfiguration
    $endpoint = "http://$($network.AdvertiseAddress):$Port/mcp"

    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
    $stdoutLog = Join-Path $LauncherDataPath "wan2gp-mcp_$timestamp.log"
    $stderrLog = Join-Path $LauncherDataPath "wan2gp-mcp_$timestamp.error.log"

    # -u makes redirected Python output unbuffered so live logs update promptly.
    $arguments = @(
        "-u"
        "`"$($paths.WgpScript)`""
        "--mcp"
        "--mcp-transport"
        "streamable-http"
        "--mcp-host"
        $network.BindAddress
        "--mcp-port"
        [string]$Port
    )

    $filesystemReads = -not $NoFilesystemReads
    if ($filesystemReads) {
        if (Test-FilesystemReadsSupported -Paths $paths) {
            $arguments += $FilesystemReadsFlag
        }
        else {
            $filesystemReads = $false
            Write-Host "[WARN] This Wan2GP build has no $FilesystemReadsFlag option, so clients that send file paths will be refused. Update Wan2GP through Pinokio." -ForegroundColor Yellow
        }
    }

    Write-Host "Starting Wan2GP MCP..." -ForegroundColor Cyan
    Write-Host "Wan2GP path: $($paths.AppPath)"
    Write-Host "Python:      $($paths.PythonExe)"
    Write-Host "Bind:        $($network.BindAddress):$Port"
    Write-Host "File paths:  $(if ($filesystemReads) { 'accepted' } else { 'refused - clients must supply Gallery ids' })"
    Write-Host "MCP URL:     $endpoint" -ForegroundColor Cyan
    Write-Host ""

    $process = Start-Process `
        -FilePath $paths.PythonExe `
        -ArgumentList $arguments `
        -WorkingDirectory $paths.AppPath `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -WindowStyle Hidden `
        -PassThru

    # Force StartTime evaluation while the process object is valid.
    $null = $process.StartTime
    Save-LauncherState -Process $process -Paths $paths -Network $network -StdoutLog $stdoutLog -StderrLog $stderrLog

    Write-Host "Process started with PID $($process.Id)." -ForegroundColor Green
    Write-Host "Waiting for TCP port $Port (up to $StartupTimeoutSeconds seconds)..." -ForegroundColor DarkGray

    $ready = $false
    for ($i = 0; $i -lt $StartupTimeoutSeconds; $i++) {
        Start-Sleep -Seconds 1
        $process.Refresh()

        if ($process.HasExited) {
            Write-Host ""
            Write-Host "Wan2GP exited during startup with code $($process.ExitCode)." -ForegroundColor Red
            Write-Host "Output log: $stdoutLog"
            Write-Host "Error log:  $stderrLog"

            if (Test-Path -LiteralPath $stderrLog -PathType Leaf) {
                Write-Host ""
                Write-Host "Recent error output:" -ForegroundColor Yellow
                Get-Content -LiteralPath $stderrLog -Tail 40 -ErrorAction SilentlyContinue
            }

            Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
            return
        }

        if (Test-TcpEndpoint -Address $network.AdvertiseAddress -TargetPort $Port) {
            $ready = $true
            break
        }

        if (($i % 5) -eq 0) {
            Write-Host "." -NoNewline -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    if ($ready) {
        Write-Host "Wan2GP MCP is listening." -ForegroundColor Green
        Write-Host "Endpoint: $endpoint" -ForegroundColor Cyan

        try {
            Set-Clipboard -Value $endpoint
            Write-Host "The MCP URL was copied to your clipboard." -ForegroundColor Green
        }
        catch {
            Write-Host "The URL could not be copied to the clipboard." -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "The process is still running, but the endpoint was not detected within the startup window." -ForegroundColor Yellow
        Write-Host "Review the output and error logs. Model/runtime initialization may still be continuing."
    }

    Write-Host ""
    Write-Host "Output log: $stdoutLog"
    Write-Host "Error log:  $stderrLog"
}

function Stop-Wan2GPMcp {
    Ensure-DataFolder
    $managed = Get-ManagedProcess

    if (-not $managed) {
        Write-Host "No launcher-managed Wan2GP MCP process is currently running." -ForegroundColor Yellow
        return
    }

    $process = $managed.Process
    Write-Host "Stopping Wan2GP MCP process tree for PID $($process.Id)..." -ForegroundColor Cyan

    try {
        $taskKill = Get-Command "taskkill.exe" -ErrorAction SilentlyContinue
        if ($taskKill) {
            & taskkill.exe /PID ([string]$process.Id) /T /F | Out-Null
        }
        else {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
        }

        try {
            Wait-Process -Id $process.Id -Timeout 20 -ErrorAction SilentlyContinue
        }
        catch {
            # Process may already be gone.
        }

        if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }

        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        Write-Host "Wan2GP MCP stopped." -ForegroundColor Green
    }
    catch {
        Write-Host "Unable to stop PID $($process.Id): $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Restart-Wan2GPMcp {
    Stop-Wan2GPMcp
    Start-Sleep -Seconds 2
    Start-Wan2GPMcp
}

function Open-LiveLogs {
    $stdoutLog = Get-CurrentLogPath
    $stderrLog = Get-CurrentErrorLogPath

    if (-not $stdoutLog -and -not $stderrLog) {
        Write-Host "No Wan2GP MCP logs are currently available." -ForegroundColor Yellow
        return
    }

    $paths = @()
    if ($stdoutLog) { $paths += $stdoutLog }
    if ($stderrLog) { $paths += $stderrLog }

    $quotedPaths = @()
    foreach ($path in $paths) {
        $quotedPaths += "'" + $path.Replace("'", "''") + "'"
    }

    $commandText = "`$host.UI.RawUI.WindowTitle='Wan2GP MCP Live Logs'; Get-Content -LiteralPath @($($quotedPaths -join ',')) -Tail 50 -Wait"
    $argumentText = "-NoLogo -NoProfile -NoExit -Command `"$commandText`""

    Start-Process -FilePath "powershell.exe" -ArgumentList $argumentText
    Write-Host "Live logs opened in a separate PowerShell window." -ForegroundColor Green
}

function Copy-McpUrl {
    $endpoint = Get-EndpointFromStateOrConfiguration
    Set-Clipboard -Value $endpoint
    Write-Host "Copied: $endpoint" -ForegroundColor Green
}

function Open-LogFolder {
    Ensure-DataFolder
    Start-Process -FilePath "explorer.exe" -ArgumentList "`"$LauncherDataPath`""
}

function Show-Menu {
    while ($true) {
        Write-Banner
        Show-Status
        Write-Host ""
        Write-Host "  [1] Start MCP server"
        Write-Host "  [2] Stop MCP server"
        Write-Host "  [3] Restart MCP server"
        Write-Host "  [4] Refresh status"
        Write-Host "  [5] Validate installation"
        Write-Host "  [6] Copy MCP URL"
        Write-Host "  [7] Open live logs"
        Write-Host "  [8] Open log folder"
        Write-Host "  [Q] Quit launcher (server keeps running)"
        Write-Host ""

        $choice = Read-Host "Choose an option"
        switch ($choice.ToUpperInvariant()) {
            "1" {
                Write-Banner
                Start-Wan2GPMcp
                Read-Host "`nPress Enter to continue" | Out-Null
            }
            "2" {
                Write-Banner
                Stop-Wan2GPMcp
                Read-Host "`nPress Enter to continue" | Out-Null
            }
            "3" {
                Write-Banner
                Restart-Wan2GPMcp
                Read-Host "`nPress Enter to continue" | Out-Null
            }
            "4" {
                continue
            }
            "5" {
                Write-Banner
                $null = Invoke-Validation
                Read-Host "`nPress Enter to continue" | Out-Null
            }
            "6" {
                Write-Banner
                Copy-McpUrl
                Read-Host "`nPress Enter to continue" | Out-Null
            }
            "7" {
                Write-Banner
                Open-LiveLogs
                Read-Host "`nPress Enter to continue" | Out-Null
            }
            "8" {
                Open-LogFolder
            }
            "Q" {
                return
            }
            default {
                Write-Host "Invalid selection." -ForegroundColor Yellow
                Start-Sleep -Seconds 1
            }
        }
    }
}

try {
    switch ($Action) {
        "Start" {
            Write-Banner
            Start-Wan2GPMcp
        }
        "Stop" {
            Write-Banner
            Stop-Wan2GPMcp
        }
        "Restart" {
            Write-Banner
            Restart-Wan2GPMcp
        }
        "Status" {
            Write-Banner
            Show-Status
        }
        "Validate" {
            Write-Banner
            $valid = Invoke-Validation
            if (-not $valid) {
                exit 1
            }
        }
        default {
            Show-Menu
        }
    }
}
catch {
    Write-Host ""
    Write-Host "Launcher error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Expected Wan2GP installation:" -ForegroundColor Yellow
    Write-Host "  $Wan2GPPath"
    Write-Host ""
    Write-Host "Example override:" -ForegroundColor Yellow
    Write-Host "  .\Wan2GP-MCP-Launcher.ps1 -Wan2GPPath `"C:\your\path\to\app`""
    exit 1
}
finally {
    if (-not $NoPause -and $Action -ne "Menu") {
        Write-Host ""
        Read-Host "Press Enter to close" | Out-Null
    }
}
