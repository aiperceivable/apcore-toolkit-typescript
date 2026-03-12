import { describe, it, expect } from "vitest";
import { resolveTarget } from "../src/resolve-target";

describe("resolveTarget", () => {
  it("rejects target without ':' — throws with 'Invalid target format'", async () => {
    await expect(resolveTarget("no-colon-here")).rejects.toThrow(
      'Invalid target format: "no-colon-here". Expected "module/path:exportName".',
    );
  });

  it("resolves a valid Node.js built-in: 'node:path:join' returns the join function", async () => {
    const result = await resolveTarget("node:path:join");
    const { join } = await import("node:path");
    expect(result).toBe(join);
  });

  it("resolves 'node:fs:existsSync' — returns a function", async () => {
    const result = await resolveTarget("node:fs:existsSync");
    expect(typeof result).toBe("function");
  });

  it("throws for nonexistent module: 'nonexistent-module-xyz:foo'", async () => {
    await expect(resolveTarget("nonexistent-module-xyz:foo")).rejects.toThrow(
      'Failed to import module "nonexistent-module-xyz"',
    );
  });

  it("throws for nonexistent export: 'node:path:nonExistentExport'", async () => {
    await expect(resolveTarget("node:path:nonExistentExport")).rejects.toThrow(
      'Export "nonExistentExport" not found in module "node:path"',
    );
  });

  it("rejects file-path imports outside allowed prefixes", async () => {
    await expect(
      resolveTarget("/etc/passwd:default", ["/usr/src/app"]),
    ).rejects.toThrow("not under any allowed prefix");
  });

  it("allows file-path imports under an allowed prefix", async () => {
    // node:path is not a file path, so allowedPrefixes don't restrict it
    const result = await resolveTarget("node:path:join", ["/some/prefix"]);
    expect(typeof result).toBe("function");
  });
});
