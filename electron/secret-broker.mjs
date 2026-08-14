// Main-process half of the P1.5 SecretStore. Electron safeStorage (macOS
// Keychain / Windows DPAPI / Linux libsecret-kwallet) only exists in the
// MAIN process; the packaged harness server runs as a utilityProcess, so it
// brokers encrypt/decrypt here over its parent port:
//
//   server → main  { velarixSecrets: true, id, op: "encrypt"|"decrypt", data }
//   main → server  { velarixSecrets: true, id, ok: true, data }
//                  { velarixSecrets: true, id, ok: false, error }
//
// encrypt: data is the plaintext, the reply is base64 ciphertext.
// decrypt: data is base64 ciphertext, the reply is the plaintext.
// The port is in-app IPC between our own processes — values never touch
// argv, logs, or the renderer. Error replies are generic op names only:
// exception text from a crypto layer must never ride back with (or leak)
// a value.
export function createSecretBrokerHandler({ encryptString, decryptString }) {
  return function handleSecretMessage(msg) {
    if (!msg || msg.velarixSecrets !== true || typeof msg.id !== "number") return null;
    const reply = (patch) => ({ velarixSecrets: true, id: msg.id, ...patch });
    try {
      if (msg.op === "encrypt") {
        return reply({ ok: true, data: encryptString(String(msg.data)).toString("base64") });
      }
      if (msg.op === "decrypt") {
        return reply({ ok: true, data: decryptString(Buffer.from(String(msg.data), "base64")) });
      }
      return reply({ ok: false, error: "unknown op" });
    } catch {
      return reply({ ok: false, error: `${String(msg.op)} failed` });
    }
  };
}
