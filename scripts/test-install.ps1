$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $env:RUNNER_TEMP 'vexona-recorder-install-check'
$resolved = [IO.Path]::GetFullPath($testRoot)
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $resolved.StartsWith($runnerRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test installation path' }
if (Test-Path -LiteralPath $testRoot) { throw 'Test installation path already exists' }
$installer = (Get-ChildItem -LiteralPath 'dist' -Filter '*Setup*.exe' | Select-Object -First 1).FullName
if (-not $installer) { throw 'Installer missing' }
$process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$testRoot") -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -notin @(0,3010)) { throw "Installer failed: $($process.ExitCode)" }
$exe = Join-Path $testRoot 'Vexona Screen Recorder.exe'
$archive = Join-Path $testRoot 'resources/app.asar'
if (-not (Test-Path -LiteralPath $archive)) { throw 'Installed app archive missing' }
$version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
$expected = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
if ($version -notlike "$expected*") { throw "Installed version mismatch: $version" }
& node scripts/run-native.cjs --app-root $archive
if ($LASTEXITCODE -ne 0) { throw 'Installed application regression check failed' }
# Only this isolated CI installation may be stopped if the installer launched it.
Get-Process | Where-Object { $_.Path -eq $exe } | Stop-Process
$uninstaller = Join-Path $testRoot 'Uninstall Vexona Screen Recorder.exe'
if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller missing' }
$removed = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
if ($removed.ExitCode -ne 0) { throw "Uninstaller failed: $($removed.ExitCode)" }
Start-Sleep -Milliseconds 600
if (Test-Path -LiteralPath $exe) { throw 'Uninstaller left the executable installed' }
@{version=$version;installerExit=$process.ExitCode;installedCodeTested=$true;uninstalled=$true} | ConvertTo-Json | Set-Content -LiteralPath 'test-output/windows-installer.json' -Encoding utf8
