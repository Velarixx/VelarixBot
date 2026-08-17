// Local-computer UI gate and copy. Darwin keeps "This Mac"; Windows is
// "This PC". Linux stays unsupported (no bundled CUA). Browser (no
// platform) still offers local — the panel then says it needs the desktop app.

export function localComputerSupported(platform: string | undefined): boolean {
  return platform !== "linux";
}

export function localComputerLabel(platform: string | undefined): "This Mac" | "This PC" {
  return platform === "win32" ? "This PC" : "This Mac";
}

export function localComputerNoun(platform: string | undefined): "this Mac" | "this PC" {
  return platform === "win32" ? "this PC" : "this Mac";
}

export function localComputerModes(platform: string | undefined): Array<["local", "This Mac" | "This PC"]> {
  return localComputerSupported(platform) ? [["local", localComputerLabel(platform)]] : [];
}

export function localUnavailableCopy(platform: string | undefined, inDesktop: boolean): string {
  if (!inDesktop) return "Local preview needs the desktop app — run pnpm dev:desktop";
  if (platform === "linux") {
    return "Local computer control is unavailable on Linux — choose Cloud box or Off";
  }
  return "Local computer control is unavailable — choose Cloud box or Off";
}

export function localAutoHint(platform: string | undefined): string {
  if (!localComputerSupported(platform)) return "Auto: the cloud box when one exists, else Off. ";
  return `Auto: the cloud box when one exists, else ${localComputerNoun(platform)}. `;
}
