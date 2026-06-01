<#
  Lance Obsidian en mode Chrome DevTools Protocol (port de debug) pour les
  tests e2e. Le flag --remote-debugging-port ne prend effet qu'au démarrage du
  process : on tue donc toute instance existante avant de relancer.

  Obsidian rouvre le dernier vault ouvert — assure-toi que c'est bien le vault
  de test (lore-test-vault).

  Usage :
    powershell -ExecutionPolicy Bypass -File _test/launch-obsidian.ps1
    powershell -ExecutionPolicy Bypass -File _test/launch-obsidian.ps1 -Port 9333
#>
param([int]$Port = 9222)

$exe = "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe"
if (-not (Test-Path $exe)) {
  Write-Error "Obsidian introuvable a $exe"
  exit 1
}

$running = Get-Process Obsidian -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Arret de l'instance Obsidian existante (le flag debug n'agit qu'au demarrage)..."
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 700
}

Start-Process $exe -ArgumentList "--remote-debugging-port=$Port"
Write-Host "Obsidian lance en debug sur le port $Port."

# Met la fenetre au premier plan : Chromium met les requestAnimationFrame en
# pause quand la fenetre est masquee/minimisee, et tout le masquage du plugin
# repose sur le rAF. Les tests e2e seraient sinon faussement vides.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  $w = Get-Process Obsidian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($w) {
    [Win32Fg]::ShowWindow($w.MainWindowHandle, 9) | Out-Null  # SW_RESTORE
    [Win32Fg]::SetForegroundWindow($w.MainWindowHandle) | Out-Null
    Write-Host "Fenetre Obsidian au premier plan."
    break
  }
}
Write-Host "Verifie l'endpoint : http://localhost:$Port/json/version"
