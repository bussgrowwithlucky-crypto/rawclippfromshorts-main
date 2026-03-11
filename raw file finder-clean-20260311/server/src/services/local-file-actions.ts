import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function revealLocalPath(targetPath: string): Promise<void> {
  await execFileAsync("explorer.exe", ["/select,", targetPath], {
    windowsHide: false,
  });
}
