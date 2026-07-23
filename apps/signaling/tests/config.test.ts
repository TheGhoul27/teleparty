import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOriginAllowed, loadConfig, loadDotEnv } from "../src/config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadConfig", () => {
  it("generates a temporary secret in development when ROOM_TOKEN_SECRET is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = loadConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(config.roomTokenSecret.length).toBeGreaterThanOrEqual(32);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ROOM_TOKEN_SECRET is not set"));
  });

  it("does not auto-detect dev TLS certificates outside development", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ROOM_TOKEN_SECRET: "an-explicit-secret-of-adequate-length"
    } as NodeJS.ProcessEnv);
    expect(config.tls).toBeNull();
  });

  it("requires ROOM_TOKEN_SECRET in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /ROOM_TOKEN_SECRET is required in production/
    );
  });

  it("accepts an explicit secret", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      ROOM_TOKEN_SECRET: "an-explicit-secret-of-adequate-length"
    } as NodeJS.ProcessEnv);
    expect(config.roomTokenSecret).toBe("an-explicit-secret-of-adequate-length");
  });
});

describe("isOriginAllowed", () => {
  const devConfig = loadConfig({
    NODE_ENV: "development",
    ROOM_TOKEN_SECRET: "an-explicit-secret-of-adequate-length"
  } as NodeJS.ProcessEnv);
  const prodConfig = loadConfig({
    NODE_ENV: "production",
    ROOM_TOKEN_SECRET: "an-explicit-secret-of-adequate-length",
    ALLOWED_ORIGINS: "https://watch.example.com"
  } as NodeJS.ProcessEnv);

  it("always accepts configured origins and requests without an Origin header", () => {
    expect(isOriginAllowed(devConfig, "http://localhost:3000")).toBe(true);
    expect(isOriginAllowed(prodConfig, "https://watch.example.com")).toBe(true);
    expect(isOriginAllowed(prodConfig, undefined)).toBe(true);
  });

  it("accepts private-network origins in development only", () => {
    expect(isOriginAllowed(devConfig, "http://192.168.1.20:3000")).toBe(true);
    expect(isOriginAllowed(devConfig, "https://10.0.0.5:3000")).toBe(true);
    expect(isOriginAllowed(devConfig, "http://172.20.0.2:3000")).toBe(true);
    // Tailscale / CGNAT range (100.64.0.0/10).
    expect(isOriginAllowed(devConfig, "https://100.77.210.45:3000")).toBe(true);
    expect(isOriginAllowed(devConfig, "http://100.63.0.1:3000")).toBe(false);
    expect(isOriginAllowed(devConfig, "http://100.128.0.1:3000")).toBe(false);
    expect(isOriginAllowed(prodConfig, "http://192.168.1.20:3000")).toBe(false);
  });

  it("rejects public or malformed origins in development", () => {
    expect(isOriginAllowed(devConfig, "https://evil.example.com")).toBe(false);
    expect(isOriginAllowed(devConfig, "http://8.8.8.8:3000")).toBe(false);
    expect(isOriginAllowed(devConfig, "not-a-url")).toBe(false);
  });
});

describe("loadDotEnv", () => {
  it("loads variables from .env without overriding existing ones", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "watchshare-env-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      writeFileSync(
        path.join(dir, ".env"),
        [
          "# comment",
          "ROOM_TOKEN_SECRET=from-dotenv-file-1234567890",
          'QUOTED="quoted value"',
          "EXISTING=from-file",
          "",
          "not-a-valid-line"
        ].join("\n")
      );
      const env: NodeJS.ProcessEnv = { EXISTING: "from-process" };
      loadDotEnv(env);
      expect(env.ROOM_TOKEN_SECRET).toBe("from-dotenv-file-1234567890");
      expect(env.QUOTED).toBe("quoted value");
      expect(env.EXISTING).toBe("from-process");
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
