import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERATED_TYPES_PATH, generateTypes } from "../scripts/generate-types.ts";

describe("generated types", () => {
  it("match the schemas (run `pnpm schemas:types` if this fails)", async () => {
    expect(readFileSync(GENERATED_TYPES_PATH, "utf8")).toBe(await generateTypes());
  });
});
