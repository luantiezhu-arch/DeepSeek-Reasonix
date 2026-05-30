/** view_image — analyze a local image via deepseek-vision proxy. Supports follow-up queries. */

import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { readConfig } from "../config.js";
import type { ToolRegistry } from "../tools.js";

const DEFAULT_VISION_URL = "http://localhost:8000/v1/chat/completions";
function getVisionKey(): string {
  return process.env.VISION_API_KEY || process.env.MASTER_API_KEY || "";
}
const DEFAULT_PROMPT =
  "Describe this image in detail. Be specific about text, objects, layout, and colors.";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

let _lastImagePath = "";

function mimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_MAP[ext] ?? "image/png";
}

function loadVisionConfig(): { url: string; key: string } {
  const envUrl = process.env.VISION_PROXY_URL;
  const envKey = process.env.VISION_PROXY_KEY || getVisionKey();
  if (envUrl) return { url: envUrl, key: envKey };
  try {
    const cfg = readConfig();
    const cfgUrl = (cfg as Record<string, unknown>).visionProxyUrl;
    const cfgKey = (cfg as Record<string, unknown>).visionProxyKey;
    if (typeof cfgUrl === "string" && cfgUrl) {
      return {
        url: cfgUrl,
        key: typeof cfgKey === "string" && cfgKey ? cfgKey : getVisionKey(),
      };
    }
  } catch {}
  return { url: DEFAULT_VISION_URL, key: getVisionKey() };
}

export function registerImageTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "view_image",
    description: "分析本地图片并返回文字描述。支持追问（自动复用上次图片路径）。",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the image file. Can be omitted on follow-up queries — reuses the last image.",
        },
        prompt: {
          type: "string",
          description: "What to ask about the image. Be specific for best results.",
        },
      },
    },
    fn: async (args: { path?: string; prompt?: string }) => {
      const { url: visionUrl, key: masterKey } = loadVisionConfig();
      const prompt = args.prompt ?? DEFAULT_PROMPT;

      // Use provided path or fall back to last image
      let imagePath = args.path ?? _lastImagePath;
      if (!imagePath)
        throw new Error("view_image: 请提供图片路径，或在分析过图片后不加 path 参数进行追问。");

      let imageBuffer: Buffer | null = null;
      try {
        imageBuffer = readFileSync(imagePath);
      } catch {
        for (const base of [process.cwd(), process.env.HOME ?? "", process.env.USERPROFILE ?? ""]) {
          if (!base) continue;
          try {
            imageBuffer = readFileSync(resolve(base, imagePath));
            imagePath = resolve(base, imagePath);
            break;
          } catch {}
        }
      }
      if (!imageBuffer) throw new Error(`view_image: 找不到文件 "${args.path ?? _lastImagePath}"`);

      // Remember for follow-up
      _lastImagePath = imagePath;

      const base64 = imageBuffer.toString("base64");
      const mime = mimeType(imagePath);
      const dataUrl = `data:${mime};base64,${base64}`;

      let resp: Response;
      try {
        resp = await fetch(visionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterKey}` },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ],
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        throw new Error(
          `view_image: 无法连接到视觉代理 ${visionUrl} — 是否在运行？\n  (${(err as Error).message})`,
        );
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`view_image: 代理返回 HTTP ${resp.status}${text ? ` — ${text}` : ""}`);
      }

      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      return (
        content ??
        `[视觉代理处理了图片但未返回文本内容。]\nFinish reason: ${(data.choices?.[0] as Record<string, unknown> | undefined)?.finish_reason ?? "unknown"}`
      );
    },
  });

  return registry;
}
