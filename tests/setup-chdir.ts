import { resolve } from "node:path";
/** chdir to project root so process.cwd() resolves in tests. */
import { fileURLToPath } from "node:url";

try {
  const root = fileURLToPath(new URL("..", import.meta.url));
  process.chdir(resolve(root));
} catch {
  // skip in jsdom — those tests don't need cwd fix
}
