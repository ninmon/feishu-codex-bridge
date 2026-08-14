import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCollaborationProjectMarkdown,
  buildCollaborationTasksMarkdown,
  buildHandoffMarkdown,
  collaborationStatusDocumentName,
  handoffDocumentName,
  parseCollaborationProjectCommand,
} from "./collaboration-project-commands.mjs";

test("parses the deterministic Collaboration Project approval workflow", () => {
  assert.deepEqual(parseCollaborationProjectCommand("/collab"), { action: "status" });
  assert.deepEqual(parseCollaborationProjectCommand("/collab task Fix routing | Keep peer events scoped | Tests pass; Unknown peers fail"), {
    action: "task",
    task: {
      title: "Fix routing",
      objective: "Keep peer events scoped",
      acceptanceCriteria: ["Tests pass", "Unknown peers fail"],
      scope: { in: [], out: [] },
      evidenceRequired: [],
      dependencies: [],
    },
  });
  assert.deepEqual(parseCollaborationProjectCommand("/collab assign task:12345678 alice-collab task/T-001 bob-collab"), {
    action: "assign",
    taskId: "task:12345678",
    executorAgentId: "alice-collab",
    branch: "task/T-001",
    reviewerAgentId: "bob-collab",
  });
  assert.match(
    parseCollaborationProjectCommand("/collab assign task:12345678 alice-collab task/T-001").error,
    /reviewerAgentId/,
  );
  assert.deepEqual(parseCollaborationProjectCommand("/collab review-pass task:12345678 Tests pass; Diff is scoped"), {
    action: "review-pass",
    taskId: "task:12345678",
    checks: ["Tests pass", "Diff is scoped"],
  });
  assert.match(parseCollaborationProjectCommand("/collab cancel task:12345678").error, /原因/);
});

test("renders status, tasks, and immutable handoff names without local execution identities", () => {
  const project = {
    id: "bridge-team",
    name: "Bridge",
    githubRepository: "example/bridge",
    pmHumanOpenId: "ou_pm",
    coordinatorAgentId: "pm-collab",
    coordinatorEpoch: 1,
    participants: [{}, {}, {}],
  };
  const task = {
    taskId: "task:12345678",
    title: "Fix routing",
    objective: "Keep routing fail closed.",
    state: "submitted",
    githubRepository: "example/bridge",
    acceptanceCriteria: ["Tests pass"],
    assignment: { executorAgentId: "alice-collab", reviewerAgentId: "bob-collab", branch: "task/T-001", baseGit: { commit: "1".repeat(40) } },
    result: { summary: "Done", git: { commit: "2".repeat(40) }, evidence: ["node --test"] },
  };
  const status = buildCollaborationProjectMarkdown(project, [task], { state: "bound" });
  assert.match(status, /已绑定专用只读 Session/);
  assert.match(status, /COLLAB-bridge-team-STATUS/);
  assert.equal(collaborationStatusDocumentName(project), "COLLAB-bridge-team-STATUS");
  assert.match(buildCollaborationTasksMarkdown([task]), /alice-collab/);
  assert.equal(handoffDocumentName(task, { fromAgentId: "alice-collab", toAgentId: "pm-collab", revision: 2 }),
    "HANDOFF-task-12345678-alice-collab-TO-pm-collab-R2");
  const handoff = buildHandoffMarkdown(task, { fromAgentId: "alice-collab", toAgentId: "pm-collab", revision: 2, createdAt: 0 });
  assert.match(handoff, /Keep routing fail closed/);
  assert.doesNotMatch(handoff, /C:\\|threadId|App Secret.*[=:]/i);
});
