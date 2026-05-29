/**
 * Pre-spawn security checks adapted from Claude Code's bashSecurity + bashPermissions.
 * Run BEFORE spawning any subprocess to reject dangerous patterns.
 */

/* ------------------------------------------------------------------ */
/*  Command substitution & injection detection                        */
/* ------------------------------------------------------------------ */

/** Substitution patterns that enable arbitrary code execution inside a command string. */
const SUBSTITUTION_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /(?<![\\])`[^`]+`/, name: "backtick command substitution" },
  { pattern: /\$\(/, name: "$() command substitution" },
  { pattern: /\$\{/, name: "${} parameter substitution (if nested dangerously)" },
  { pattern: /<\(/, name: "process substitution <()" },
  { pattern: />\(/, name: "process substitution >()" },
  { pattern: /\$\[/, name: "$[] legacy arithmetic expansion" },
];

/** Heredocs containing substitution syntax that could be used to bypass checks. */
export function hasDangerousHeredoc(text: string): boolean {
  // Match <<HEREDOC patterns where the body contains $() or backticks
  return /<<-?\s*\w+[\s\S]*?\n[\s\S]*?\$\{?[\s\S]*?\n\s*\w+/.test(text);
}

/** Detect command substitution patterns in a command string. */
export function hasCommandSubstitution(cmd: string): string | null {
  for (const { pattern, name } of SUBSTITUTION_PATTERNS) {
    if (pattern.test(cmd)) return name;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  PATH hijack detection (LD_PRELOAD etc.)                           */
/* ------------------------------------------------------------------ */

/** Environment variables that can hijack binary execution. */
const BINARY_HIJACK_VARS = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PATH",
  "PYTHONPATH",
  "RUBYLIB",
  "PERL5LIB",
  "NODE_PATH",
  "LD_AUDIT",
  "LD_DEBUG",
  "LD_ORIGIN_PATH",
  "SHELL",
];

/** Check if a command tries to set hijack env vars, e.g. `LD_PRELOAD=./evil.so ./program`. */
export function hasBinaryHijackEnvVar(cmd: string): string | null {
  const upper = cmd.toUpperCase();
  for (const v of BINARY_HIJACK_VARS) {
    // Match VAR=value or VAR="value" at the start of a segment
    const re = new RegExp(`(?:^|[;&|])\\s*${v}=["']?`, "i");
    if (re.test(cmd)) return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Pattern checks for accidentally dangerous commands                */
/* ------------------------------------------------------------------ */

/** Patterns that are almost certainly mistakes when typed by an LLM. */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // rm -rf /
  { pattern: /\brm\s+(-rf?\s|-[rf]+\s+)\s*\//, name: "rm -rf / (filesystem root)" },
  // dd if=/dev/random (destructive on disk)
  { pattern: /\bdd\s+if=/, name: "dd (direct disk write)" },
  // chmod / chown on system dirs
  { pattern: /\bchmod\s+-R\s+(?:777|0+)\s+\//, name: "chmod -R / (system permissions)" },
  // > /dev/sda (direct block device access)
  { pattern: />\s+\/dev\/(?:sd[a-z]|nvme\d+n\d+|mmcblk\d+)/, name: "write to block device" },
];

export function hasDangerousPattern(cmd: string): string | null {
  for (const { pattern, name } of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) return name;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Zsh dangerous commands                                            */
/* ------------------------------------------------------------------ */

const ZSH_DANGEROUS_COMMANDS = new Set([
  "zmodload",
  "emulate",
  "sysopen",
  "sysread",
  "syswrite",
  "zpty",
  "ztcp",
]);

export function hasZshDangerousCommand(cmd: string): string | null {
  const firstWord = cmd
    .trim()
    .split(/[\s;|&]+/)[0]
    ?.toLowerCase();
  if (firstWord && ZSH_DANGEROUS_COMMANDS.has(firstWord)) return firstWord;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Unclosed quote detection                                          */
/* ------------------------------------------------------------------ */

export function hasUnclosedQuotes(cmd: string): string | null {
  let dq = false;
  let sq = false;
  let escaped = false;
  for (const ch of cmd) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && dq) {
      escaped = true;
      continue;
    }
    if (ch === '"' && !sq) {
      dq = !dq;
      continue;
    }
    if (ch === "'" && !dq) {
      sq = !sq;
    }
  }
  if (dq) return "double quote";
  if (sq) return "single quote";
  return null;
}

/* ------------------------------------------------------------------ */
/*  Composite check                                                   */
/* ------------------------------------------------------------------ */

export interface SecurityCheckResult {
  safe: boolean;
  reason?: string;
}

/** Run ALL pre-spawn security checks. Returns {safe:false, reason} on first hit. */
export function checkCommandSafety(cmd: string): SecurityCheckResult {
  if (!cmd || !cmd.trim()) return { safe: true };

  const sub = hasCommandSubstitution(cmd);
  if (sub) return { safe: false, reason: `命令包含危险的替换语法: ${sub}` };

  const hijack = hasBinaryHijackEnvVar(cmd);
  if (hijack) return { safe: false, reason: `命令试图设置危险环境变量: ${hijack}` };

  const danger = hasDangerousPattern(cmd);
  if (danger) return { safe: false, reason: `命令包含危险模式: ${danger}` };

  const zsh = hasZshDangerousCommand(cmd);
  if (zsh)
    return { safe: false, reason: `Zsh 危险命令: ${zsh}（仅在 Zsh 下有效，但拒绝以保安全）` };

  const heredoc = hasDangerousHeredoc(cmd);
  if (heredoc) return { safe: false, reason: "Heredoc 内容包含替换语法，可能存在注入风险" };

  const quotes = hasUnclosedQuotes(cmd);
  if (quotes) return { safe: false, reason: `未闭合的引号: ${quotes}` };

  return { safe: true };
}
