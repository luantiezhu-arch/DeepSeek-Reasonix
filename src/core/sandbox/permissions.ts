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
  if (rule.wildcard) {
    const prefix = rule.pattern.replace(/:?\*$/, "").toLowerCase();
    if (rule.pattern.endsWith("*")) {
      return cmd.toLowerCase().startsWith(prefix);
    }
    return cmd.toLowerCase() === prefix;
  }
  return cmd.toLowerCase().startsWith(rule.pattern.toLowerCase());
}

/* ------------------------------------------------------------------ */
/*  Permission store                                                  */
/* ------------------------------------------------------------------ */

export class PermissionStore {
  private rules: PermissionRule[] = [];

  constructor() {
    // Each rule must have a unique id — duplicate ids overwrite
    const patterns = [
      "git status",
      "git diff",
      "git log",
      "cd",
      "npm run lint",
      "npm run test",
      "npx vitest run",
      "npx tsc",
      "npx biome check",
      "cargo check",
      "cargo test",
    ];
    patterns.forEach((pattern, i) => {
      this.addRule({ id: `builtin-ro-${i}`, action: "allow", pattern, persistent: true });
    });
  }

  addRule(rule: PermissionRule): void {
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
        return { action: rule.action, rule, message: `rule "${rule.id}" → ${rule.action}: ${cmd}` };
      }
    }
    return { action: "ask", message: `no matching rule: ${cmd}` };
  }
}

/** Global singleton — used by sandbox.ts for permission checks. */
export const globalPermissions = new PermissionStore();
