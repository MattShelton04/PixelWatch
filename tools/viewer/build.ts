import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { appScriptPath } from "../../packages/core/src/index.ts";

/** The actual classic browser app; no artifact/store executable enters this build. */
export async function buildViewerAssets(release: string): Promise<{ release: string; script: Uint8Array }> {
  appScriptPath(release);
  const result = await build({ entryPoints: [fileURLToPath(new URL("../../packages/viewer/src/client.ts", import.meta.url))],
    bundle: true, platform: "browser", format: "iife", target: ["es2022"], minify: true, write: false,
    define: { __PIXELWATCH_RELEASE__: JSON.stringify(release) }, legalComments: "inline", charset: "utf8" });
  const file = result.outputFiles[0]; if (file === undefined || result.outputFiles.length !== 1) throw new Error("viewer build unavailable");
  return { release, script: Uint8Array.from(file.contents) };
}
