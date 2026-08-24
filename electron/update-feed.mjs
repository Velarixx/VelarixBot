// Pure GitHub-Releases feed helpers for the packaged updater.
// Token never appears in return values — callers pass it as a header only.
export const GITHUB_OWNER = "Velarixx";
export const GITHUB_REPO = "VelarixBot";
export const NO_TOKEN_MESSAGE = "Set a GitHub token in App Settings to check private GitHub Releases.";
export const DEV_NOOP_MESSAGE = "Updates are only available in the packaged app.";

export function parseVersion(input) {
  const s = String(input ?? "")
    .trim()
    .replace(/^v/i, "");
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.](.+))?$/);
  if (!m) return [0, 0, 0, s];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
}

/** Numeric-aware prerelease compare so rc.10 > rc.2 (not lexicographic). */
function comparePrerelease(a, b) {
  const as = String(a).split(".");
  const bs = String(b).split(".");
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (i >= as.length) return -1;
    if (i >= bs.length) return 1;
    const an = /^\d+$/.test(as[i]);
    const bn = /^\d+$/.test(bs[i]);
    if (an && bn) {
      const d = Number(as[i]) - Number(bs[i]);
      if (d) return d;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  const ar = pa[3];
  const br = pb[3];
  if (!ar && !br) return 0;
  if (!ar) return 1;
  if (!br) return -1;
  return comparePrerelease(ar, br);
}

export function pickChecksumAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((a) => /^SHA256SUMS\.txt$/i.test(String(a?.name ?? ""))) ?? null;
}

export function pickAsset(release, platform, arch) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (platform === "darwin") {
    const tag = arch === "arm64" ? "arm64" : "x64";
    return assets.find((a) => /\.dmg$/i.test(a?.name ?? "") && String(a.name).includes(tag)) ?? null;
  }
  if (platform === "win32") {
    return assets.find((a) => /\.exe$/i.test(a?.name ?? "")) ?? null;
  }
  return null;
}

export function newestNewerRelease(releases, currentVersion) {
  const list = (Array.isArray(releases) ? releases : []).filter((r) => !r?.draft);
  list.sort((a, b) => compareVersions(b.tag_name || b.name || "", a.tag_name || a.name || ""));
  const newest = list[0];
  if (!newest) return null;
  if (compareVersions(newest.tag_name || newest.name || "", currentVersion) > 0) return newest;
  return null;
}

export function tokenConfigured(token) {
  return Boolean(token && String(token).trim());
}

const SECRET_REF_PREFIX = "secret://";

/** Resolve a `secret://<id>` reference against ~/.velarixbot/secrets.json
 * content (P1.5 SecretStore). `secrets.decrypt` is the caller-injected
 * safeStorage decryptor (main process only); "file"-backend entries are
 * base64 of the value and need no keychain. Unresolvable → "" (honest
 * unconfigured), never a throw. */
export function resolveSecretRef(ref, secrets) {
  const id = String(ref ?? "").slice(SECRET_REF_PREFIX.length);
  let entry = null;
  try {
    const parsed = JSON.parse(secrets?.fileText || "null");
    entry = parsed?.entries?.[id] ?? null;
  } catch {
    return "";
  }
  if (!entry || typeof entry.data !== "string") return "";
  try {
    if (entry.backend === "file") return Buffer.from(entry.data, "base64").toString("utf8");
    if (entry.backend === "safeStorage" && typeof secrets?.decrypt === "function") {
      return String(secrets.decrypt(Buffer.from(entry.data, "base64")) ?? "");
    }
  } catch {
    /* keychain refused or corrupt entry — fall through */
  }
  return "";
}

/** File token wins over env, matching server/config.ts merge order.
 * A `secret://` reference in config.json resolves through `secrets`
 * ({ fileText, decrypt }) — see resolveSecretRef. */
export function readGithubToken(env, fileText, secrets) {
  let fromFile = "";
  try {
    const cfg = JSON.parse(fileText || "null");
    if (cfg && typeof cfg === "object" && cfg.github && typeof cfg.github.token === "string") {
      fromFile = cfg.github.token;
    }
  } catch {
    /* missing or invalid config — env fallback below */
  }
  if (fromFile.startsWith(SECRET_REF_PREFIX)) fromFile = resolveSecretRef(fromFile, secrets);
  const fromEnv = env?.GITHUB_TOKEN || env?.GH_TOKEN || "";
  return String(fromFile || fromEnv || "").trim();
}

export function releasesUrl() {
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
}

export function publicState(state) {
  return {
    status: state.status,
    version: state.version,
    percent: state.percent,
    message: state.message,
    tokenConfigured: Boolean(state.tokenConfigured),
  };
}
