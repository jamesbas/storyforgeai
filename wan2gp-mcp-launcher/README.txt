WAN2GP MCP POWERSHELL LAUNCHER v1.4
====================================

QA COVERAGE
-----------
QA-REPORT.json and QA-SUMMARY.txt record the static validation of v1.2. The
v1.3 and v1.4 changes -- filesystem-read support and making Tailscale optional
-- are not covered by them. Run Validate-Wan2GP-MCP.cmd on the target machine
before relying on this package.

MANIFEST.json is regenerated whenever a file here changes; verify against it
rather than against the hashes quoted in the QA files.

PURPOSE
-------
This package starts the native Wan2GP/WanGP MCP server independently of
Pinokio while reusing the Python environment installed by Pinokio.

DEFAULT WAN2GP LOCATION
-----------------------
C:\pinokio\api\wan.git\app

Set the WAN2GP_PATH environment variable, or pass -Wan2GPPath, if yours is
somewhere else.

The launcher finds the virtual-environment Python itself, looking for:
  venv\Scripts\python.exe
  env\Scripts\python.exe
  .venv\Scripts\python.exe

Pinokio has renamed this folder between Wan2GP versions, so the launcher looks
rather than assumes. It does not need to activate the environment first.

FILES
-----
Wan2GP-MCP-Launcher.cmd
    Double-click for the interactive launcher.

Validate-Wan2GP-MCP.cmd
    Double-click to run preflight checks without starting the server.

Wan2GP-MCP-Launcher.ps1
    Main PowerShell script.

FIRST USE
---------
1. Extract this ZIP into a permanent folder, for example:
   C:\AI\Wan2GP-Launcher

2. Double-click:
   Validate-Wan2GP-MCP.cmd

3. Confirm the result says:
   VALIDATION RESULT: PASSED

4. Double-click:
   Wan2GP-MCP-Launcher.cmd

5. Choose:
   [1] Start MCP server

DEFAULT NETWORK CONFIGURATION
-----------------------------
The launcher detects the local Tailscale IPv4 address and binds Wan2GP
directly to it. On a machine that is not on a tailnet it warns and binds
127.0.0.1 instead, which serves a client running on the same PC.

To listen somewhere else, pass -BindAddress with the address you want, or
0.0.0.0 for every interface.

The endpoint is:
http://<bind address>:7866/mcp

No internet router port-forward should be created.

FILESYSTEM READS
----------------
Wan2GP made server file paths opt-in. A client that hands it a reference image
by path has every job refused with "Direct filesystem paths are disabled for
this MCP server", so the launcher passes --mcp-allow-read-file-system.

Pass -NoFilesystemReads to leave them disabled. Clients must then supply
Gallery ids for every media argument.

CURRENT WAN2GP MCP COMMAND
--------------------------
The launcher runs the equivalent of:

python -u wgp.py --mcp --mcp-transport streamable-http ^
  --mcp-host <bind address> --mcp-port 7866 --mcp-allow-read-file-system

The -u option makes redirected Python logs update without normal buffering.

MENU
----
[1] Start MCP server
[2] Stop MCP server
[3] Restart MCP server
[4] Refresh status
[5] Validate installation
[6] Copy MCP URL
[7] Open live logs
[8] Open log folder
[Q] Quit launcher; the server remains running

SAFETY AND PROCESS CONTROL
--------------------------
The launcher stores the process ID, process start time, Python path, command,
port, and logs in a state file.

Before stopping a process, it validates that the saved PID still corresponds
to the Wan2GP MCP process it started. This prevents a stale/reused PID from
causing another Python application to be terminated.

The Stop action terminates the validated Wan2GP process tree only. It does not
run "taskkill /IM python.exe".

LOGS AND STATE
--------------
%LOCALAPPDATA%\Wan2GP-MCP-Launcher

The launcher creates separate timestamped standard-output and error logs.

WINDOWS FIREWALL
----------------
The first time Python listens on the Tailscale interface, Windows may request
network permission. Permit it only on the network profiles appropriate for
your environment.

Do not create a public internet-facing router rule for port 7866.

If remote Tailscale devices cannot connect, an administrator can create a
restricted inbound firewall rule. Example:

New-NetFirewallRule `
  -DisplayName "Wan2GP MCP via Tailscale" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 7866 `
  -RemoteAddress 100.64.0.0/10 `
  -Action Allow

COMMAND-LINE EXAMPLES
---------------------
Validate:
powershell -ExecutionPolicy Bypass -File .\Wan2GP-MCP-Launcher.ps1 -Action Validate

Start:
powershell -ExecutionPolicy Bypass -File .\Wan2GP-MCP-Launcher.ps1 -Action Start

Stop:
powershell -ExecutionPolicy Bypass -File .\Wan2GP-MCP-Launcher.ps1 -Action Stop

Status:
powershell -ExecutionPolicy Bypass -File .\Wan2GP-MCP-Launcher.ps1 -Action Status

Force a specific bind address:
powershell -ExecutionPolicy Bypass -File .\Wan2GP-MCP-Launcher.ps1 `
  -BindAddress 100.100.100.100

Use a different port:
powershell -ExecutionPolicy Bypass -File .\Wan2GP-MCP-Launcher.ps1 -Port 7867

Start without filesystem reads:
powershell -ExecutionPolicy Bypass -File .\Wan2GP-MCP-Launcher.ps1 `
  -Action Start -NoFilesystemReads

TROUBLESHOOTING
---------------
If validation reports missing MCP options or shared\mcp_server.py, update the
Wan2GP application through Pinokio and run validation again.

If port 7866 is occupied, stop the listed process or select another port.

If direct binding to the Tailscale address fails, verify that Tailscale is
connected and that the address is still assigned to this PC.


VERSION 1.2 PARSER FIX
----------------------
Corrected a PowerShell interpolation error in the stopped-status display.

Incorrect:
Port $Port:

Correct:
Port ${Port}:

In PowerShell, a colon immediately following a variable name can be parsed as
part of a scoped-variable expression. Braces explicitly delimit the variable.
