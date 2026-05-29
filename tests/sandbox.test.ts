/** Tests for sandbox security checks + permissions. */

import { describe, expect, it } from "vitest";
import { PermissionStore, globalPermissions } from "../src/core/sandbox/permissions.js";
import { checkCommandSafety } from "../src/core/sandbox/security.js";

/* ------------------------------------------------------------------ */
/*  Security checks                                                   */
/* ------------------------------------------------------------------ */

describe("checkCommandSafety", () => {
  it("passes safe commands", () => {
    expect(checkCommandSafety("git status").safe).toBe(true);
    expect(checkCommandSafety("npm run test").safe).toBe(true);
    expect(checkCommandSafety("node --version").safe).toBe(true);
    expect(checkCommandSafety("cargo check").safe).toBe(true);
  });

  it("rejects $() command substitution", () => {
    const r = checkCommandSafety("echo $(cat /etc/passwd)");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("$()");
  });

  it("rejects backtick substitution", () => {
    const r = checkCommandSafety("echo `whoami`");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("backtick");
  });

  it("rejects process substitution <()", () => {
    const r = checkCommandSafety("diff <(cat a) <(cat b)");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("<()");
  });

  it("detects LD_PRELOAD hijack", () => {
    const r = checkCommandSafety("LD_PRELOAD=./evil.so ./program");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("LD_PRELOAD");
  });

  it("detects PATH hijack via env var", () => {
    const r = checkCommandSafety("PATH=/evil:$PATH ls");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("PATH");
  });

  it("detects dangerous rm -rf /", () => {
    const r = checkCommandSafety("rm -rf /");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("rm");
  });

  it("detects unclosed double quotes", () => {
    const r = checkCommandSafety('echo "hello');
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("double quote");
  });

  it("detects unclosed single quotes", () => {
    const r = checkCommandSafety("echo 'hello");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("single quote");
  });

  it("passes empty command", () => {
    expect(checkCommandSafety("").safe).toBe(true);
    expect(checkCommandSafety("   ").safe).toBe(true);
  });

  it("detects dangerous dd command", () => {
    const r = checkCommandSafety("dd if=/dev/zero of=/dev/sda");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("dd");
  });

  it("detects heredoc with substitution", () => {
    const r = checkCommandSafety("cat <<EOF\n$(evil)\nEOF");
    expect(r.safe).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Permission rules                                                  */
/* ------------------------------------------------------------------ */

describe("PermissionStore", () => {
  it("allows built-in readonly commands with fresh store", () => {
    const store = new PermissionStore();
    const r = store.evaluate("git status");
    expect(r.action).toBe("allow");
  });

  it("allows built-in test/lint commands with fresh store", () => {
    const store = new PermissionStore();
    expect(store.evaluate("npm run lint").action).toBe("allow");
    expect(store.evaluate("npm run test").action).toBe("allow");
    expect(store.evaluate("cargo check").action).toBe("allow");
  });

  it("returns ask for unknown commands", () => {
    const store = new PermissionStore();
    const r = store.evaluate("sudo rm -rf /");
    expect(r.action).toBe("ask");
  });

  it("respects custom deny rules", () => {
    const store = new PermissionStore();
    store.addRule({ id: "test-deny", action: "deny", pattern: "curl", persistent: false });
    const r = store.evaluate("curl http://evil.com");
    expect(r.action).toBe("deny");
  });

  it("resolves cd as allowed via builtin rule", () => {
    const store = new PermissionStore();
    const r = store.evaluate("cd /tmp");
    expect(r.action).toBe("allow");
  });
});
