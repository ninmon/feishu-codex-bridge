const TASK_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._/-]{1,200}$/;

function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function compact(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function taskId(value) {
  if (!TASK_ID.test(String(value || ""))) return undefined;
  return String(value);
}

function splitNote(argument) {
  const match = String(argument || "").trim().match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!match || !taskId(match[1])) return { error: "任务 ID 格式无效。" };
  return { taskId: match[1], note: String(match[2] || "").trim() };
}

export function parseCollaborationProjectCommand(content) {
  const text = String(content || "").trim();
  if (!text.startsWith("/collab")) return undefined;
  const rest = text.slice("/collab".length).trim();
  if (!rest || rest === "status") return { action: "status" };
  if (rest === "tasks") return { action: "tasks" };
  if (rest === "coordinator") return { action: "coordinator" };
  if (rest === "bind-current") return { action: "bind-current" };
  if (rest === "unbind") return { action: "unbind" };

  const separator = rest.search(/\s/);
  const action = separator < 0 ? rest : rest.slice(0, separator);
  const argument = separator < 0 ? "" : rest.slice(separator).trim();
  if (action === "task") {
    const parts = argument.split("|").map((part) => part.trim());
    if (parts.length !== 3 || !parts.every(Boolean)) {
      return { error: "用法：`/collab task <标题> | <目标> | <验收标准1>; <验收标准2>`" };
    }
    const acceptanceCriteria = parts[2].split(";").map((item) => item.trim()).filter(Boolean);
    if (!acceptanceCriteria.length) return { error: "至少需要一条验收标准。" };
    return {
      action: "task",
      task: {
        title: parts[0],
        objective: parts[1],
        acceptanceCriteria,
        scope: { in: [], out: [] },
        evidenceRequired: [],
        dependencies: [],
      },
    };
  }
  if (action === "submit-plan") {
    const parsed = splitNote(argument);
    return parsed.error ? parsed : { action, ...parsed };
  }
  if (action === "approve-plan" || action === "accept-result" || action === "publish" || action === "close") {
    const parsed = splitNote(argument);
    return parsed.error ? parsed : { action, ...parsed };
  }
  if (action === "reject-plan" || action === "changes" || action === "cancel") {
    const parsed = splitNote(argument);
    if (parsed.error) return parsed;
    if (!parsed.note) return { error: "该操作必须填写原因。" };
    return { action, ...parsed };
  }
  if (action === "assign") {
    const match = argument.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
    if (!match || !taskId(match[1])) return { error: "用法：`/collab assign <taskId> <executorAgentId> <branch> <reviewerAgentId>`" };
    if (!AGENT_ID.test(match[2]) || !AGENT_ID.test(match[4])) return { error: "Agent ID 格式无效。" };
    if (!BRANCH.test(match[3])) return { error: "目标 branch 格式无效。" };
    return { action, taskId: match[1], executorAgentId: match[2], branch: match[3], reviewerAgentId: match[4] };
  }
  if (action === "review-start") {
    const parsed = splitNote(argument);
    return parsed.error ? parsed : { action, taskId: parsed.taskId };
  }
  if (action === "review-pass") {
    const parsed = splitNote(argument);
    if (parsed.error) return parsed;
    const checks = parsed.note.split(";").map((item) => item.trim()).filter(Boolean);
    if (!checks.length) return { error: "至少需要一条审查检查项。" };
    return { action, taskId: parsed.taskId, checks };
  }
  return { error: "未知 `/collab` 操作。发送 `/collab` 查看当前项目状态。" };
}

export function collaborationStatusDocumentName(project) {
  return `COLLAB-${project.id}-STATUS`;
}

export function collaborationDecisionsDocumentName(project) {
  return `COLLAB-${project.id}-DECISIONS`;
}

export function collaborationLedgerDocumentName(project) {
  return `COLLAB-${project.id}-LEDGER`;
}

export function handoffDocumentName(task, { fromAgentId, toAgentId, revision = 1 }) {
  if (!TASK_ID.test(String(task?.taskId || ""))) throw new TypeError("A valid task is required");
  if (!AGENT_ID.test(String(fromAgentId || "")) || !AGENT_ID.test(String(toAgentId || ""))) {
    throw new TypeError("Handoff Agent identity is invalid");
  }
  const safeTaskId = task.taskId.replace(/[^A-Za-z0-9._-]/g, "-");
  return `HANDOFF-${safeTaskId}-${fromAgentId}-TO-${toAgentId}-R${Math.max(1, Number(revision) || 1)}`;
}

export function buildCollaborationProjectMarkdown(project, tasks, coordinatorStatus) {
  const counts = tasks.reduce((result, task) => ({ ...result, [task.state]: (result[task.state] || 0) + 1 }), {});
  const active = tasks.filter((task) => !new Set(["closed", "rejected", "cancelled"]).has(task.state)).length;
  const blocked = counts.blocked || 0;
  const coordinatorLine = coordinatorStatus?.state === "bound"
    ? "已绑定专用只读 Session"
    : coordinatorStatus?.state === "remote"
      ? `由 ${inlineCode(coordinatorStatus.coordinatorAgentId)} 承担`
      : coordinatorStatus?.state === "stale"
        ? "原 Session 已因 Coordinator 任期变化失效，等待重新绑定"
        : "尚未绑定专用 Session";
  return [
    `## ${project.name} · 协作状态`,
    "",
    `- Collaboration Project：${inlineCode(project.id)}`,
    `- GitHub：${inlineCode(project.githubRepository)}`,
    `- 人类 PM：${inlineCode(project.pmHumanOpenId)}`,
    `- Coordinator：${inlineCode(project.coordinatorAgentId)} · epoch ${inlineCode(project.coordinatorEpoch)}`,
    `- Coordinator Session：${coordinatorLine}`,
    `- 注册成员：${project.participants.length} 人 / ${project.participants.length} 个协作 Bot`,
    `- 任务：${tasks.length} 个；活动 ${active}；阻塞 ${blocked}`,
    `- 固定状态文档：${inlineCode(collaborationStatusDocumentName(project))}`,
    "",
    "> PM 决定目标、优先级、验收和发布；Coordinator 维护台账、派发、跟踪、机械验证与文档。Session 只是可替换的自然语言判断界面，不保存项目权威状态。",
  ].join("\n");
}

export function buildCollaborationTasksMarkdown(tasks) {
  const lines = tasks.map((task, index) => [
    `${index + 1}. **${compact(task.title, 100)}** · ${inlineCode(task.state)}`,
    `   ${inlineCode(task.taskId)} · executor ${inlineCode(task.assignment?.executorAgentId || "未分配")} · reviewer ${inlineCode(task.assignment?.reviewerAgentId || "未分配")}`,
    task.assignment?.branch ? `   Git ${inlineCode(`${task.assignment.branch}@${(task.result?.git?.commit || task.assignment.baseGit?.commit || "unknown").slice(0, 12)}`)}` : undefined,
    task.reason ? `   原因：${compact(task.reason, 200)}` : undefined,
  ].filter(Boolean).join("\n"));
  return [
    "## Collaboration Project 任务",
    "",
    ...(lines.length ? lines : ["当前没有项目任务。"]),
  ].join("\n");
}

export function buildHandoffMarkdown(task, { fromAgentId, toAgentId, revision = 1, createdAt = Date.now() }) {
  const name = handoffDocumentName(task, { fromAgentId, toAgentId, revision });
  return [
    `# ${name}`,
    "",
    `- Task：${inlineCode(task.taskId)}`,
    `- Repository：${inlineCode(task.githubRepository)}`,
    `- From：${inlineCode(fromAgentId)}`,
    `- To：${inlineCode(toAgentId)}`,
    `- Revision：${inlineCode(revision)}`,
    `- Created：${new Date(createdAt).toISOString()}`,
    task.assignment?.branch ? `- Branch：${inlineCode(task.assignment.branch)}` : undefined,
    task.result?.git?.commit ? `- Commit：${inlineCode(task.result.git.commit)}` : undefined,
    "",
    "## 目标",
    "",
    task.objective,
    "",
    "## 验收标准",
    "",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## 当前结果",
    "",
    task.result?.summary || "尚未提交结果。",
    "",
    "## 证据",
    "",
    ...(task.result?.evidence?.length ? task.result.evidence.map((item) => `- ${item}`) : ["- 尚无证据。"]),
    "",
    "> 本文档不包含本机绝对路径、Codex thread ID、App Secret、OAuth token 或其他凭据。修改内容时必须创建新的 Handoff revision。",
  ].filter((line) => line !== undefined).join("\n");
}

export function buildCollaborationLedgerMarkdown(project, events) {
  const lines = events.map((event) => {
    const actor = event.actor?.id ? `${event.actor.type || "actor"}:${event.actor.id}` : "system";
    return `- #${event.sequence} · ${new Date(event.createdAt).toISOString()} · ${inlineCode(event.kind)} · ${inlineCode(event.taskId || "project")} · ${inlineCode(actor)} · epoch ${event.coordinatorEpoch}`;
  });
  return [
    `# ${collaborationLedgerDocumentName(project)}`,
    "",
    `Project：${inlineCode(project.id)}  `,
    `Repository：${inlineCode(project.githubRepository)}  `,
    `Coordinator：${inlineCode(project.coordinatorAgentId)} · epoch ${inlineCode(project.coordinatorEpoch)}`,
    "",
    "> 这是面向人的状态转换镜像。Bridge 本机的持久事件台账仍是机器权威；本文不保存 Prompt 正文、隐藏思维链、本机路径、Session ID 或凭据。",
    "",
    ...(lines.length ? lines : ["尚无项目事件。"]),
  ].join("\n");
}
