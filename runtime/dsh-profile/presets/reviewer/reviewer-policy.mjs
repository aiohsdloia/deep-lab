const MUTATING_TOOLS = new Set([
  "apply_patch",
  "bash",
  "edit",
  "pwsh",
  "str_replace_editor",
  "todo_write",
  "write",
]);

export const name = "deeplab-reviewer-policy";
export const inject = ["tools"];

export function apply(ctx) {
  // Host-level tools may include app integrations or user-configured MCP
  // connectors. The reviewer sees only tools registered inside its preset.
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard((execution) =>
    MUTATING_TOOLS.has(execution.name)
      ? "DeepLab Reviewer is read-only and cannot change the workspace."
      : undefined,
  );
}
