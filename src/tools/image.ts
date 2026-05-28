/** view_image — analyze a local image via deepseek-vision proxy. */

import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { readConfig } from "../config.js";
import type { ToolRegistry } from "../tools.js";

const DEFAULT_VISION_URL = "http://localhost:8000/v1/chat/completions";
const DEFAULT_MASTER_KEY = "123";
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

function mimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_MAP[ext] ?? "image/png";
}

function loadVisionConfig(): { url: string; key: string } {
  // 1. Environment variables override everything
  const envUrl = process.env.VISION_PROXY_URL;
  const envKey = process.env.VISION_PROXY_KEY || process.env.MASTER_API_KEY;
  if (envUrl) return { url: envUrl, key: envKey ?? DEFAULT_MASTER_KEY };

  // 2. Config file (~/.reasonix/config.json)
  try {
    const cfg = readConfig();
    const cfgUrl = (cfg as Record<string, unknown>).visionProxyUrl;
    const cfgKey = (cfg as Record<string, unknown>).visionProxyKey;
    if (typeof cfgUrl === "string" && cfgUrl) {
      return {
        url: cfgUrl,
        key: typeof cfgKey === "string" && cfgKey ? cfgKey : DEFAULT_MASTER_KEY,
      };
    }
  } catch {
    // ignore config read errors — fall through to defaults
  }

  return { url: DEFAULT_VISION_URL, key: DEFAULT_MASTER_KEY };
}

export function registerImageTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "view_image",
    description:
      "Analyze a local image file and return a text description. Uses a vision AI model to describe the image content, including text, objects, layout, and colors. By default connects to a deepseek-vision proxy at localhost:8000. Set VISION_PROXY_URL env var or `visionProxyUrl` in config to override.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the image file. Supports absolute paths and paths relative to the workspace root. Formats: PNG, JPEG, WebP, GIF, BMP.",
        },
        prompt: {
          type: "string",
          description:
            "Optional. What to ask about the image. Be specific for best results. Default: describe in detail (text, objects, layout, colors).",
        },
      },
      required: ["path"],
    },
    fn: async (args: { path: string; prompt?: string }) => {
      const { url: visionUrl, key: masterKey } = loadVisionConfig();
      const prompt = args.prompt ?? DEFAULT_PROMPT;

      // Try absolute path first, then resolve as relative
      let imagePath = args.path;
      let imageBuffer: Buffer | null = null;
      try {
        imageBuffer = readFileSync(imagePath);
      } catch {
        // Absolute path failed — try resolving against cwd/home
        for (const base of [process.cwd(), process.env.HOME ?? "", process.env.USERPROFILE ?? ""]) {
          if (!base) continue;
          try {
            imageBuffer = readFileSync(resolve(base, imagePath));
            imagePath = resolve(base, imagePath);
            break;
          } catch {}
        }
      }
      if (!imageBuffer) {
        throw new Error(
          `view_image: cannot read file "${args.path}" — file not found. Try using an absolute path like "C:\\Users\\...\\image.png".`,
        );
      }

      const base64 = imageBuffer.toString("base64");
      const mime = mimeType(imagePath);
      const dataUrl = `data:${mime};base64,${base64}`;

      let resp: Response;
      try {
        resp = await fetch(visionUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${masterKey}`,
          },
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
          `view_image: failed to reach vision proxy at ${visionUrl} — is it running?\n  (${(err as Error).message})\n  Start it with: python D:\\Code\\deepseek-vision\\main.py`,
        );
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `view_image: proxy returned HTTP ${resp.status}${text ? ` — ${text}` : ""}`,
        );
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;

      // Even with content:null, the proxy did its job — return what we have
      return (
        content ??
        `[Vision proxy processed the image but returned no text content.
Finish reason: ${(data.choices?.[0] as Record<string, unknown> | undefined)?.finish_reason ?? "unknown"}
Try a more specific prompt (e.g. "What text is on the button?" instead of a generic description).`
      );
    },
  });

  return registry;
}
