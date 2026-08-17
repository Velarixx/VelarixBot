// Listen-error handler for the HTTP server. EADDRINUSE (and any other
// listen failure) must exit non-zero — a process that never listens must
// not stay alive. Extracted so tests can emit a fake server error without
// a real port fight.

export function attachListenError(
  server: { on(event: "error", listener: (err: NodeJS.ErrnoException) => void): void },
  opts: { log?: (msg: string) => void; exit?: (code: number) => void } = {},
): void {
  const log = opts.log ?? ((msg) => console.error(msg));
  const exit = opts.exit ?? ((code) => process.exit(code));
  server.on("error", (err) => {
    const code = err.code ? `${err.code} ` : "";
    log(`[server] listen failed: ${code}${err.message}`.trim());
    exit(1);
  });
}
