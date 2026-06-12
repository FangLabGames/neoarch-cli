/// Foundry-compatible encrypted keystores (v0.6.0) — no raw keys in your shell.
///
/// Reads Web3 Secret Storage v3 files: the exact format `cast wallet new` /
/// `cast wallet import` writes under ~/.foundry/keystores/<name>. One wallet,
/// imported once with Foundry, usable interchangeably from `cast --account`
/// and this CLI's `--account`. Decryption is fully local (node:crypto scrypt /
/// pbkdf2 + AES-128-CTR, keccak-256 MAC check) — nothing leaves the machine.
///
/// Password sources, in priority order:
///   1. --password-file <path>   (for systemd / unattended runs; chmod 600)
///   2. KEYSTORE_PASSWORD env
///   3. interactive hidden prompt (TTY only)

import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";

interface KeystoreCrypto {
  cipher: string;
  ciphertext: string;
  cipherparams: { iv: string };
  kdf: string;
  kdfparams: {
    dklen: number;
    salt: string;
    n?: number;
    r?: number;
    p?: number;
    c?: number;
    prf?: string;
  };
  mac: string;
}

export function decryptKeystore(json: string, password: string): Hex {
  const parsed = JSON.parse(json) as { version?: number; crypto?: KeystoreCrypto; Crypto?: KeystoreCrypto };
  const c = parsed.crypto ?? parsed.Crypto;
  if (!c) throw new Error("not a keystore file (missing crypto section)");
  if (parsed.version !== 3) throw new Error(`unsupported keystore version ${parsed.version} (want 3)`);

  const salt = Buffer.from(c.kdfparams.salt, "hex");
  let derived: Buffer;
  if (c.kdf === "scrypt") {
    const { n, r, p, dklen } = c.kdfparams;
    if (!n || !r || !p) throw new Error("malformed scrypt kdfparams");
    // maxmem must cover 128·N·r bytes (geth-default N=262144,r=8 → 256 MiB).
    derived = scryptSync(password, salt, dklen, { N: n, r, p, maxmem: 512 * 1024 * 1024 });
  } else if (c.kdf === "pbkdf2") {
    if (c.kdfparams.prf !== "hmac-sha256") throw new Error(`unsupported pbkdf2 prf ${c.kdfparams.prf}`);
    derived = pbkdf2Sync(password, salt, c.kdfparams.c ?? 0, c.kdfparams.dklen, "sha256");
  } else {
    throw new Error(`unsupported kdf ${c.kdf}`);
  }

  // MAC = keccak256(derived[16..32] ‖ ciphertext) — checked before decrypting
  // so a wrong password fails loudly instead of yielding a garbage key.
  const ciphertext = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext]));
  if (mac.toLowerCase() !== `0x${c.mac.toLowerCase()}`) {
    throw new Error("wrong password (keystore MAC mismatch)");
  }

  if (c.cipher !== "aes-128-ctr") throw new Error(`unsupported cipher ${c.cipher}`);
  const decipher = createDecipheriv(
    "aes-128-ctr",
    derived.subarray(0, 16),
    Buffer.from(c.cipherparams.iv, "hex"),
  );
  const pk = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return `0x${pk.toString("hex")}` as Hex;
}

/// `--account <name>` → ~/.foundry/keystores/<name> (FOUNDRY_DIR respected).
export function keystorePathForAccount(account: string): string {
  const base = process.env.FOUNDRY_DIR ?? join(homedir(), ".foundry");
  return join(base, "keystores", account);
}

/// Hidden-input password prompt (raw-mode TTY, echo off, backspace handled).
export function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin as NodeJS.ReadStream;
    if (!stdin.isTTY) {
      reject(new Error("no TTY for password prompt — use --password-file or KEYSTORE_PASSWORD"));
      return;
    }
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export interface KeySource {
  pk: Hex;
  /// Human description for banners: "keystore my-agent" / "env AGENT_PK" / …
  source: string;
}

/// Resolve the signing key. Keystore (--account / --keystore) takes priority;
/// a raw env key stays supported as the legacy fallback.
export async function loadPrivateKey(opts: {
  account?: string;
  keystorePath?: string;
  passwordFile?: string;
  envPk?: string;
  envPkName?: string;
}): Promise<KeySource> {
  const path = opts.keystorePath || (opts.account ? keystorePathForAccount(opts.account) : "");
  if (path) {
    if (!existsSync(path)) {
      throw new Error(
        `keystore not found: ${path}` +
          (opts.account ? ` — import it once with: cast wallet import ${opts.account} --interactive` : ""),
      );
    }
    let password: string;
    if (opts.passwordFile) {
      password = readFileSync(opts.passwordFile, "utf8").trim();
    } else if (process.env.KEYSTORE_PASSWORD) {
      password = process.env.KEYSTORE_PASSWORD;
    } else {
      password = await promptHidden(`keystore password (${opts.account ?? path}): `);
    }
    return {
      pk: decryptKeystore(readFileSync(path, "utf8"), password),
      source: opts.account ? `keystore ${opts.account}` : `keystore ${path}`,
    };
  }
  if (opts.envPk) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(opts.envPk)) {
      throw new Error(`${opts.envPkName ?? "private key env"} is malformed (want 0x + 64 hex)`);
    }
    return { pk: opts.envPk as Hex, source: `env ${opts.envPkName ?? "PK"} (consider --account: cast wallet import <name> --interactive)` };
  }
  throw new Error(
    `no signing key — use --account <foundry-keystore-name> (recommended) or set ${opts.envPkName ?? "the PK env var"}`,
  );
}
