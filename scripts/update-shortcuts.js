import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execAsync = promisify(exec);

const psScript = `
$WshShell = New-Object -comObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = [Environment]::GetFolderPath("Programs")

$paths = @(
    "$desktop\\*.lnk",
    "$startMenu\\*.lnk",
    "$startMenu\\*\\*.lnk"
)

$found = 0
foreach ($path in $paths) {
    if (Test-Path $path) {
        $files = Get-ChildItem -Path $path -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            if ($file.Name -match '(?i)antigravity') {
                $Shortcut = $WshShell.CreateShortcut($file.FullName)
                if ($Shortcut.Arguments -notmatch '--remote-debugging-port=9000') {
                    $Shortcut.Arguments = "$($Shortcut.Arguments) --remote-debugging-port=9000".Trim()
                    $Shortcut.Save()
                    Write-Host "✅ Updated shortcut: $($file.Name)"
                    $found++
                } else {
                    Write-Host "⚡ Shortcut already configured: $($file.Name)"
                    $found++
                }
            }
        }
    }
}

if ($found -eq 0) {
    Write-Host "⚠️  No Antigravity shortcuts found. You may need to append --remote-debugging-port=9000 to your shortcut manually."
}
`;

async function updateShortcuts() {
    if (process.platform !== 'win32') {
        console.log("Not on Windows, skipping shortcut update.");
        return;
    }
    
    console.log("Configuring Antigravity shortcuts to enable DevTools Protocol...");
    const tmpScript = path.join(os.tmpdir(), `update-shortcuts-${Date.now()}.ps1`);
    fs.writeFileSync(tmpScript, psScript);
    
    try {
        const { stdout } = await execAsync(`powershell -ExecutionPolicy Bypass -NoProfile -File "${tmpScript}"`);
        console.log(stdout.trim());
    } catch (e) {
        console.error("Failed to update shortcuts automatically:", e.message);
    } finally {
        try { fs.unlinkSync(tmpScript); } catch(e) {}
    }
}

updateShortcuts();
