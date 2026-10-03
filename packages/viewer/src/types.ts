import type { SiteUrls } from "@pixelwatch/core";
import type { Changes } from "@pixelwatch/schemas";

export interface EntryInput {
  readonly urls: SiteUrls;
  readonly repository: { readonly repositoryId: string; readonly owner: string; readonly name: string };
  readonly assets: { readonly release: string; readonly script: Uint8Array };
  readonly changes?: Changes;
  /** The projector supplies this only when the generated canonical PNG exists. */
  readonly previewPixelHash?: string;
}
