// Packaging guard: the packaged app ships NO node_modules for the server —
// electron-builder copies dist-server (tsc output of server/ minus tests and
// server/testing) next to the Electron app, and the entry runs on bare node
// builtins. Every shipped server file must therefore import only `node:*`
// builtins or relative `./x.ts` paths. A bare-specifier import compiles
// fine, passes local tests (repo node_modules), and then crashes the
// packaged app at boot — this guard fails the PR instead.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** Same file set tsconfig.server.build.json ships: server/**, minus
 * *.test.ts and server/testing (the fakes import vitest and stay dev-only). */
function shippedServerFiles(dir = SERVER_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(SERVER_DIR, path).split(sep)[0] === "testing") continue;
      out.push(...shippedServerFiles(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(path);
  }
  return out;
}

/** Static, side-effect, export-from, and dynamic import specifiers. */
export function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g, // import … from "x" / export … from "x"
    /\bimport\s+["']([^"']+)["']/g, // import "x" (side-effect)
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("x")
  ];
  for (const re of patterns) {
    for (let m = re.exec(source); m; m = re.exec(source)) specs.push(m[1]);
  }
  return specs;
}

const ALLOWED = /^(node:|\.\.?\/)/;

describe("server import hygiene (no-node_modules packaging rule)", () => {
  const files = shippedServerFiles();

  it("finds the shipped server tree", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith(`${sep}index.ts`))).toBe(true);
    expect(files.some((f) => f.includes(`${sep}drivers${sep}`))).toBe(true);
    expect(files.some((f) => f.endsWith(`hermes.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
    expect(files.some((f) => f.includes(`${sep}testing${sep}`))).toBe(false);
  });

  it("every shipped server file imports only node:* builtins or relative paths", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!ALLOWED.test(spec)) {
          violations.push(`${relative(SERVER_DIR, file)} → "${spec}"`);
        }
      }
    }
    expect(violations, `bare imports would crash the packaged server (ships without node_modules):\n${violations.join("\n")}`).toEqual([]);
  });

  it("catches the failure shapes it exists for", () => {
    expect(importSpecifiers('import { z } from "zod";')).toEqual(["zod"]);
    expect(importSpecifiers('export { x } from "@scope/pkg";')).toEqual(["@scope/pkg"]);
    expect(importSpecifiers('await import("lodash")')).toEqual(["lodash"]);
    expect(importSpecifiers('import "polyfill";')).toEqual(["polyfill"]);
    for (const bad of ["zod", "@scope/pkg", "lodash", "polyfill", "fs", "path"]) {
      expect(ALLOWED.test(bad), `"${bad}" must be flagged (want node:fs style)`).toBe(false);
    }
    for (const good of ["node:fs", "./config.ts", "../contracts.ts", "./drivers/builtIn.ts"]) {
      expect(ALLOWED.test(good), `"${good}" must be allowed`).toBe(true);
    }
  });
});
