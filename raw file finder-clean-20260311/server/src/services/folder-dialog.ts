import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function selectLocalFolder(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Native folder selection is currently only available on Windows. Paste the path manually.");
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select the local archive root folder'",
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  Write-Output $dialog.SelectedPath",
    "}",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", script],
    {
      windowsHide: false,
      maxBuffer: 1024 * 1024,
    },
  );

  const selectedPath = stdout.trim();
  if (!selectedPath) {
    throw new Error("No folder was selected.");
  }

  return selectedPath;
}
