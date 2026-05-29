/**
 * Permission rule system for the Reasonix sandbox.
 * Adapted from Claude Code's permission model — rules are evaluated before spawn.
 */

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  /** Unique rule ID for user reference (e.g. "allow-git-status"). */
  id: string;
  /** What to do when this rule matches. */
  action: PermissionAction;
  /** Command prefix to match (e.g. "git status", "docker"). */
  pattern: string;
  /** When true, pattern is a glob-style wildcard (e.g. "docker:*" matches "docker ps"). */
  wildcard?: boolean;
  /** Optional expiration — session-only rules don't persist. */
  persistent?: boolean;
}

export interface PermissionResult {
  action: PermissionAction;
  rule?: PermissionRule;
  /** Human-readable explanation for the user. */
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Rule matching                                                     */
/* ------------------------------------------------------------------ */

function matchRule(cmd: string, rule: PermissionRule): boolean {
  const cmdName = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (rule.pattern.startsWith("cd")) {
    // `cd` special handling — always allowed (resolved by runChain)
    if (cmdName === "cd") return true;
  }
  if (rule.wildcard) {
    // pattern: "docker:*" matches "docker ps", "docker run ..."
    const prefix = rule.pattern.replace(/:?\*$/, "").toLowerCase();
    if (rule.pattern.endsWith("*")) {
      return cmd.toLowerCase().startsWith(prefix) || cmdName === prefix;
    }
    return cmd.toLowerCase() === prefix;
  }
  // Exact prefix match
  return cmd.toLowerCase().startsWith(rule.pattern.toLowerCase());
}

/* ------------------------------------------------------------------ */
/*  Permission store                                                  */
/* ------------------------------------------------------------------ */

export class PermissionStore {
  private rules: PermissionRule[] = [];

  constructor() {
    // Built-in safe rules
    this.addRule({
      id: "builtin-readonly",
      action: "allow",
      pattern: "git status",
      persistent: true,
    });
    this.addRule({
      id: "builtin-readonly",
      action: "allow",
      pattern: "git diff",
      persistent: true,
    });
    this.addRule({ id: "builtin-readonly", action: "allow", pattern: "git log", persistent: true });
    this.addRule({ id: "builtin-readonly", action: "allow", pattern: "cd", persistent: true });
    this.addRule({
      id: "builtin-ro-npm",
      action: "allow",
      pattern: "npm run lint",
      persistent: true,
    });
    this.addRule({
      id: "builtin-ro-npm",
      action: "allow",
      pattern: "npm run test",
      persistent: true,
    });
    this.addRule({
      id: "builtin-ro-npx",
      action: "allow",
      pattern: "npx vitest run",
      persistent: true,
    });
    this.addRule({ id: "builtin-ro-tsc", action: "allow", pattern: "npx tsc", persistent: true });
    this.addRule({
      id: "builtin-ro-biome",
      action: "allow",
      pattern: "npx biome check",
      persistent: true,
    });
    this.addRule({
      id: "builtin-ro-cargo",
      action: "allow",
      pattern: "cargo check",
      persistent: true,
    });
    this.addRule({
      id: "builtin-ro-cargo",
      action: "allow",
      pattern: "cargo test",
      persistent: true,
    });
  }

  addRule(rule: PermissionRule): void {
    // Replace existing rule with same id
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) this.rules[idx] = rule;
    else this.rules.push(rule);
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  /** Evaluate a command against all rules. First match wins. */
  evaluate(cmd: string): PermissionResult {
    for (const rule of this.rules) {
      if (matchRule(cmd, rule)) {
        return { action: rule.action, rule, message: `规则 "${rule.id}" → ${rule.action}: ${cmd}` };
      }
    }
    // Default: ask user
    return { action: "ask", message: `无匹配规则，需要用户确认: ${cmd}` };
  }
}

/** Global permission store — imported and used by sandbox.ts. */
export const globalPermissions = new PermissionStore();
