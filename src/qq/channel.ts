import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadQQConfig } from "../config.js";
import { loadDotenv } from "../env.js";
import { t } from "../i18n/index.js";
import { decideQQAccess, describeQQAccess, redactQQOpenId } from "./access.js";
import { type C2CMessage, QQBot } from "./bot.js";
import { formatQQAccessSummary } from "./strings.js";

const QQ_LOCK_FILE = join(homedir(), ".reasonix", "qq-channel.pid");
const QQ_DEDUP_FILE = join(homedir(), ".reasonix", "qq-dedup.json");
const QQ_STATE_FILE = join(homedir(), ".reasonix", "qq-channel.json");
const QQ_MAX_CHUNK_BYTES = 1500;
const NATURAL_SPLIT_MIN_FRACTION = 0.6;
const QQ_MARKDOWN_WRAPPER_RE = /^```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n```$/i;

interface QQDedupState {
  ids: string[];
  maxSize?: number;
}

interface QQChannelState {
  runtimeBoundOpenId: string | null;
}

const DEDUP_MAX_SIZE = 500;

function loadDedupState(): QQDedupState {
  try {
    if (!existsSync(QQ_DEDUP_FILE)) return { ids: [] };
    const raw = JSON.parse(readFileSync(QQ_DEDUP_FILE, "utf-8")) as QQDedupState;
    return { ids: raw.ids ?? [], maxSize: raw.maxSize ?? DEDUP_MAX_SIZE };
  } catch {
    return { ids: [] };
  }
}

function saveDedupState(state: QQDedupState): void {
  mkdirSync(dirname(QQ_DEDUP_FILE), { recursive: true });
  writeFileSync(QQ_DEDUP_FILE, JSON.stringify({ ids: state.ids }), "utf-8");
}

function loadChannelState(): QQChannelState {
  try {
    if (!existsSync(QQ_STATE_FILE)) return { runtimeBoundOpenId: null };
    return JSON.parse(readFileSync(QQ_STATE_FILE, "utf-8")) as QQChannelState;
  } catch {
    return { runtimeBoundOpenId: null };
  }
}

function saveChannelState(state: QQChannelState): void {
  mkdirSync(dirname(QQ_STATE_FILE), { recursive: true });
  writeFileSync(QQ_STATE_FILE, JSON.stringify(state), "utf-8");
}

function fitUtf8Slice(text: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const char of text) {
    const nextBytes = Buffer.byteLength(char, "utf8");
    if (bytes > 0 && bytes + nextBytes > maxBytes) break;
    end += char.length;
    bytes += nextBytes;
  }
  return end > 0 ? text.slice(0, end) : text.slice(0, 1);
}

function pickNaturalSplit(candidate: string): number {
  const minSplit = Math.floor(candidate.length * NATURAL_SPLIT_MIN_FRACTION);
  const splitters = ["\n\n", "\n", " "];
  for (const splitter of splitters) {
    const at = candidate.lastIndexOf(splitter);
    if (at >= minSplit) return at + splitter.length;
  }
  return candidate.length;
}

export function splitQQMessage(text: string, maxBytes = QQ_MAX_CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (Buffer.byteLength(remaining, "utf8") <= maxBytes) {
      chunks.push(remaining);
      break;
    }

    const candidate = fitUtf8Slice(remaining, maxBytes);
    const splitAt = pickNaturalSplit(candidate);
    chunks.push(candidate.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

export function normalizeQQMarkdownReply(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(QQ_MARKDOWN_WRAPPER_RE);
  if (!match) {
    return text;
  }
  return match[1] ?? text;
}

export class QQChannel {
  private bot: QQBot | null = null;
  private qqUserId: string | null = null;
  private qqMessageId: string | null = null;
  private ownerOpenId: string | undefined;
  private allowlist: string[] | undefined;
  private runtimeBoundOpenId: string | null = null;
  private processedMsgIds = new Set<string>();
  private processedMsgIdQueue: string[] = [];
  private lockAcquired = false;
  private nextOutboundMsgSeq = 1;
  private markdownDisabled = false;

  constructor(
    private callbacks: {
      onSubmitMessage: (text: string) => void;
      onError?: (msg: string) => void;
    },
  ) {
    // Restore persistent dedup state so restarts don't re-process old messages
    const dedup = loadDedupState();
    for (const id of dedup.ids) {
      this.processedMsgIds.add(id);
      this.processedMsgIdQueue.push(id);
    }
    const state = loadChannelState();
    this.runtimeBoundOpenId = state.runtimeBoundOpenId;
  }

  private rememberMessage(id: string): boolean {
    if (this.processedMsgIds.has(id)) return false;
    this.processedMsgIds.add(id);
    this.processedMsgIdQueue.push(id);
    while (this.processedMsgIdQueue.length > DEDUP_MAX_SIZE) {
      const oldest = this.processedMsgIdQueue.shift();
      if (oldest) this.processedMsgIds.delete(oldest);
    }
    // Persist so restarts won't re-process these messages
    saveDedupState({ ids: [...this.processedMsgIds] });
    return true;
  }

  private acquireLock(): void {
    try {
      const existing = Number(readFileSync(QQ_LOCK_FILE, "utf8").trim());
      if (Number.isInteger(existing) && existing > 0 && existing !== process.pid) {
        try {
          process.kill(existing, 0);
          throw new Error(t("handlers.qq.lockAlreadyRunning", { pid: existing }));
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== "ESRCH") throw err;
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }

    mkdirSync(dirname(QQ_LOCK_FILE), { recursive: true });
    writeFileSync(QQ_LOCK_FILE, String(process.pid), "utf8");
    this.lockAcquired = true;
  }

  private releaseLock(): void {
    if (!this.lockAcquired) return;
    try {
      const existing = Number(readFileSync(QQ_LOCK_FILE, "utf8").trim());
      if (existing === process.pid) unlinkSync(QQ_LOCK_FILE);
    } catch {}
    this.lockAcquired = false;
  }

  private applyAccessConfig(config: ReturnType<typeof loadQQConfig>): void {
    this.ownerOpenId = config.ownerOpenId;
    this.allowlist = config.allowlist;
    if (this.ownerOpenId || (this.allowlist?.length ?? 0) > 0) {
      this.runtimeBoundOpenId = null;
    }
  }

  private handlePrivateMessage(msg: C2CMessage): void {
    const text = msg.content?.trim();
    if (!text) return;
    if (!this.rememberMessage(msg.id)) return;

    const openid = msg.author.user_openid;
    const verdict = decideQQAccess(
      {
        ownerOpenId: this.ownerOpenId,
        allowlist: this.allowlist,
        runtimeBoundOpenId: this.runtimeBoundOpenId,
      },
      openid,
    );
    if (!verdict.accept) {
      this.callbacks.onError?.(
        t("handlers.qq.unauthorizedMessage", {
          openid: redactQQOpenId(openid),
          access: formatQQAccessSummary({
            ownerOpenId: this.ownerOpenId,
            allowlist: this.allowlist,
            runtimeBoundOpenId: this.runtimeBoundOpenId,
          }),
        }),
      );
      return;
    }
    if (verdict.bindRuntime) {
      this.runtimeBoundOpenId = openid;
      saveChannelState({ runtimeBoundOpenId: openid });
      this.callbacks.onError?.(
        t("handlers.qq.runtimeBound", {
          openid: redactQQOpenId(openid),
        }),
      );
    }

    this.qqUserId = openid;
    this.qqMessageId = msg.id;
    this.callbacks.onSubmitMessage(`[QQ] ${text}`);
  }

  refreshAccessConfig(): void {
    this.applyAccessConfig(loadQQConfig());
  }

  describeAccess(): string {
    return describeQQAccess({
      ownerOpenId: this.ownerOpenId,
      allowlist: this.allowlist,
      runtimeBoundOpenId: this.runtimeBoundOpenId,
    });
  }

  getRuntimeBoundOpenId(): string | null {
    return this.runtimeBoundOpenId;
  }

  async start(): Promise<void> {
    loadDotenv();
    this.acquireLock();

    const config = loadQQConfig();
    if (!config.appId) {
      this.releaseLock();
      throw new Error(t("handlers.qq.missingAppId"));
    }
    if (!config.appSecret) {
      this.releaseLock();
      throw new Error(t("handlers.qq.missingAppSecret"));
    }
    this.applyAccessConfig(config);

    const bot = new QQBot({
      appid: config.appId,
      secret: config.appSecret,
      sandbox: config.sandbox ?? false,
    });

    bot.on("online", () => {
      process.stderr.write("QQ bot is online!\n");
    });

    bot.on("bot_error", (msg: string) => {
      this.callbacks.onError?.(msg);
    });

    bot.on("message.private", (msg: C2CMessage) => {
      this.handlePrivateMessage(msg);
    });

    this.bot = bot;

    try {
      await bot.start();

      const readyOrError = await Promise.race([
        new Promise<"ready">((resolve) => bot.once("online", () => resolve("ready"))),
        new Promise<"error">((resolve) => bot.once("bot_error", () => resolve("error"))),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
      ]);

      if (readyOrError === "error") {
        throw new Error(t("handlers.qq.authFailed"));
      }
      if (readyOrError === "timeout") {
        throw new Error(t("handlers.qq.readyTimeout"));
      }
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  async sendResponse(text: string): Promise<void> {
    if (!this.bot || !this.qqUserId) return;
    const chunks = splitQQMessage(normalizeQQMarkdownReply(text));
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (!chunk) continue;
      try {
        const msgSeq = this.nextOutboundMsgSeq++;
        if (!this.markdownDisabled) {
          try {
            await this.bot.sendPrivateMessage(
              this.qqUserId,
              chunk,
              this.qqMessageId ?? undefined,
              msgSeq,
              true,
            );
            continue;
          } catch (err) {
            this.markdownDisabled = true;
            this.callbacks.onError?.(
              `QQ markdown delivery disabled after first failure: ${(err as Error).message}`,
            );
          }
        }

        await this.bot.sendPrivateMessage(
          this.qqUserId,
          chunk,
          this.qqMessageId ?? undefined,
          this.nextOutboundMsgSeq++,
          false,
        );
      } catch (err) {
        const msg = `QQ sendResponse chunk ${index + 1}/${chunks.length} failed: ${(err as Error).message}`;
        this.callbacks.onError?.(msg);
        break;
      }
    }
  }

  async stop(): Promise<void> {
    // Persist final state before shutdown
    if (this.processedMsgIds.size > 0) {
      saveDedupState({ ids: [...this.processedMsgIds] });
    }
    saveChannelState({ runtimeBoundOpenId: this.runtimeBoundOpenId });
    await this.bot?.stop();
    this.releaseLock();
  }
}
