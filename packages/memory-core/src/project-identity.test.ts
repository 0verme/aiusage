import { describe, expect, it } from "vitest";
import { normalizeRepositoryUrl, resolveProjectIdentity } from "./project-identity.js";

describe("project identity", () => {
  it("uses the same identity for git worktrees", () => {
    const main = resolveProjectIdentity({
      cwd: String.raw`E:\vbcoding\lakehouse-toolkit`,
      repositoryRoot: String.raw`E:\vbcoding\lakehouse-toolkit`,
      gitCommonDir: String.raw`E:\vbcoding\lakehouse-toolkit\.git`,
      remoteUrl: "git@github.com:0verme/lakehouse-toolkit.git",
    });
    const worktree = resolveProjectIdentity({
      cwd: String.raw`E:\vbcoding\lakehouse-toolkit-wt-45`,
      repositoryRoot: String.raw`E:\vbcoding\lakehouse-toolkit-wt-45`,
      gitCommonDir: String.raw`E:\vbcoding\lakehouse-toolkit\.git`,
      remoteUrl: "https://github.com/0verme/lakehouse-toolkit.git",
    });

    expect(worktree.projectId).toBe(main.projectId);
    expect(worktree.projectName).toBe("lakehouse-toolkit");
    expect(worktree.worktreePath).toContain("wt-45");
  });

  it("falls back to the shared git directory without a remote", () => {
    const left = resolveProjectIdentity({
      cwd: "/workspace/tool-wt-1",
      repositoryRoot: "/workspace/tool-wt-1",
      gitCommonDir: "/workspace/tool/.git",
    });
    const right = resolveProjectIdentity({
      cwd: "/workspace/tool-wt-2",
      repositoryRoot: "/workspace/tool-wt-2",
      gitCommonDir: "/workspace/tool/.git",
    });

    expect(left.projectId).toBe(right.projectId);
  });

  it("normalizes common remote URL forms", () => {
    expect(normalizeRepositoryUrl("git@github.com:0verme/aiusage.git")).toBe(
      "github.com/0verme/aiusage",
    );
    expect(normalizeRepositoryUrl("https://github.com/0verme/aiusage.git/")).toBe(
      "github.com/0verme/aiusage",
    );
  });

  it("uses a configured alias for the display name", () => {
    expect(resolveProjectIdentity({
      cwd: "/workspace/aiusage",
      remoteUrl: "git@github.com:0verme/aiusage.git",
      projectAlias: "AI Usage",
    }).projectName).toBe("AI Usage");
  });
});
