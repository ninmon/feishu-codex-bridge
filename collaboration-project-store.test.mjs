import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentEvent } from "./agent-protocol.mjs";
import { CollaborationProjectStore } from "./collaboration-project-store.mjs";

const now = 1_800_000_000_000;
const project = {
  id: "bridge-team",
  name: "Feishu Codex Bridge",
  groupChatId: "oc_shared",
  controlGroupChatId: "oc_pm_control",
  githubRepository: "example/bridge",
  coordinatorAgentId: "pm-collab",
  coordinatorEpoch: 1,
  pmHumanOpenId: "ou_pm",
  approvalPolicy: {
    plan: "pm",
    assignment: "pm",
    landing: "participant",
    technicalReview: "independent-reviewer",
    publish: "pm",
    pmOwnWork: "independent-reviewer",
  },
  participants: [
    { agentId: "pm-collab", humanOpenId: "ou_pm", botOpenId: "ou_pm_bot", roles: ["member", "pm"] },
    { agentId: "alice-collab", humanOpenId: "ou_alice", botOpenId: "ou_alice_bot", roles: ["member"] },
    { agentId: "bob-collab", humanOpenId: "ou_bob", botOpenId: "ou_bob_bot", roles: ["member", "reviewer"] },
  ],
};
const baseGit = { remote: "origin", branch: "main", commit: "1".repeat(40) };
const resultGit = { remote: "origin", branch: "task/T-001", commit: "2".repeat(40) };

async function fixture(run, { localAgentId = "pm-collab", projectDefinition = project } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-project-ledger-"));
  const filePath = path.join(directory, "project.json");
  try {
    const store = await CollaborationProjectStore.open(filePath, {
      project: projectDefinition,
      localAgentId,
      now: () => now,
    });
    await run(store, filePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function createApproved(store, overrides = {}) {
  let task = await store.createTask({
    taskId: overrides.taskId || "task:T-000001",
    title: overrides.title || "Implement project ledger",
    objective: "Implement and test the durable Collaboration Project ledger.",
    scope: { in: ["project workflow"], out: ["production deployment"] },
    acceptanceCriteria: ["All state transitions are tested", "No local paths cross Agent boundaries"],
    evidenceRequired: ["node --test"],
    dependencies: overrides.dependencies || [],
  }, { createdByHumanOpenId: overrides.createdByHumanOpenId || "ou_pm" });
  task = await store.submitPlan(task.taskId, { submittedByAgentId: "pm-collab" });
  task = await store.approvePlan(task.taskId, { approvedByHumanOpenId: "ou_pm", note: "Plan approved" });
  return task;
}

test("enforces plan, assignment, independent review, PM acceptance, publication, and closure", async () => fixture(async (store, filePath) => {
  let task = await createApproved(store);
  assert.equal(task.state, "approved");
  task = await store.offerAssignment(task.taskId, {
    executorAgentId: "alice-collab",
    reviewerAgentId: "bob-collab",
    branch: "task/T-001",
    baseGit,
    offeredByAgentId: "pm-collab",
  });
  task = await store.acceptAssignment(task.taskId, { acceptedByAgentId: "alice-collab" });
  task = await store.startExecution(task.taskId, { startedByAgentId: "alice-collab" });
  task = await store.recordProgress(task.taskId, { reportedByAgentId: "alice-collab", message: "Tests are running" });
  task = await store.submitResult(task.taskId, {
    submittedByAgentId: "alice-collab",
    summary: "Implemented the ledger and tests.",
    resultGit,
    evidence: ["node --test collaboration-project-store.test.mjs"],
  });
  task = await store.startVerification(task.taskId, { reviewerAgentId: "bob-collab" });
  task = await store.passVerification(task.taskId, {
    reviewerAgentId: "bob-collab",
    note: "Independent review passed",
    checks: ["Tests pass", "Diff is in scope"],
  });
  task = await store.acceptResult(task.taskId, { acceptedByHumanOpenId: "ou_pm", note: "Meets acceptance criteria" });
  task = await store.publish(task.taskId, { publishedByAgentId: "pm-collab", prUrl: "https://github.com/example/bridge/pull/1" });
  task = await store.close(task.taskId, { closedByHumanOpenId: "ou_pm" });
  assert.equal(task.state, "closed");
  assert.equal(task.result.git.commit, "2".repeat(40));
  assert.equal(task.assignment.reviewerAgentId, "bob-collab");
  assert.deepEqual(store.eventTail(3).map(({ kind }) => kind), ["result.accepted", "result.published", "task.closed"]);

  const reopened = await CollaborationProjectStore.open(filePath, {
    project,
    localAgentId: "pm-collab",
    now: () => now,
  });
  assert.equal(reopened.get(task.taskId).state, "closed");
}));

test("requires a separate reviewer for every implementation", async () => fixture(async (store) => {
  const task = await createApproved(store);
  await assert.rejects(() => store.offerAssignment(task.taskId, {
    executorAgentId: "alice-collab",
    branch: "task/alice-work",
    baseGit,
    offeredByAgentId: "pm-collab",
  }), /independent technical reviewer/);
  const offered = await store.offerAssignment(task.taskId, {
    executorAgentId: "pm-collab",
    reviewerAgentId: "bob-collab",
    branch: "task/pm-own-work",
    baseGit,
    offeredByAgentId: "pm-collab",
  });
  assert.equal(offered.assignment.reviewerAgentId, "bob-collab");
}));

test("protects the configured default branch rather than assuming main", async () => fixture(async (store) => {
  const task = await createApproved(store);
  await assert.rejects(() => store.offerAssignment(task.taskId, {
    executorAgentId: "alice-collab",
    reviewerAgentId: "bob-collab",
    branch: "trunk",
    baseGit: { ...baseGit, branch: "trunk" },
    offeredByAgentId: "pm-collab",
  }), /protected default branch trunk/);
}, { projectDefinition: { ...project, defaultBranch: "trunk" } }));

test("refuses role confusion, premature acceptance, and unmet dependencies", async () => fixture(async (store) => {
  const dependency = await createApproved(store, { taskId: "task:DEPENDENCY" });
  const dependent = await createApproved(store, { taskId: "task:DEPENDENT1", dependencies: [dependency.taskId] });
  await assert.rejects(() => store.offerAssignment(dependent.taskId, {
    executorAgentId: "alice-collab",
    reviewerAgentId: "bob-collab",
    branch: "task/dependent",
    baseGit,
    offeredByAgentId: "pm-collab",
  }), /dependency is not accepted/);
  await assert.rejects(() => store.acceptResult(dependency.taskId, {
    acceptedByHumanOpenId: "ou_pm",
  }), /from approved/);
  await assert.rejects(() => store.approvePlan(dependent.taskId, {
    approvedByHumanOpenId: "ou_alice",
  }), /human PM/);
}));

test("blocks and resumes the exact prior state without losing the assignment", async () => fixture(async (store) => {
  let task = await createApproved(store);
  task = await store.offerAssignment(task.taskId, {
    executorAgentId: "alice-collab",
    reviewerAgentId: "bob-collab",
    branch: "task/T-001",
    baseGit,
    offeredByAgentId: "pm-collab",
  });
  task = await store.acceptAssignment(task.taskId, { acceptedByAgentId: "alice-collab" });
  task = await store.startExecution(task.taskId, { startedByAgentId: "alice-collab" });
  task = await store.block(task.taskId, { blockedByAgentId: "alice-collab", reason: "Need an API decision" });
  assert.equal(task.resumeState, "running");
  task = await store.resume(task.taskId, { resumedByAgentId: "pm-collab", note: "Decision recorded" });
  assert.equal(task.state, "running");
  assert.equal(task.assignment.executorAgentId, "alice-collab");
}));

test("transfers the single Coordinator with a monotonically increasing epoch", async () => fixture(async (store, filePath) => {
  const transferred = await store.transferCoordinator({
    newCoordinatorAgentId: "alice-collab",
    transferredByHumanOpenId: "ou_pm",
  });
  assert.equal(transferred.coordinatorAgentId, "alice-collab");
  assert.equal(transferred.pmHumanOpenId, "ou_alice");
  assert.equal(transferred.coordinatorEpoch, 2);
  await assert.rejects(() => store.createTask({
    title: "Old coordinator must stop",
    objective: "This must be rejected.",
    acceptanceCriteria: ["Rejected"],
  }, { createdByHumanOpenId: "ou_pm" }), /active Project Coordinator/);

  const reopened = await CollaborationProjectStore.open(filePath, {
    project: {
      ...project,
      coordinatorAgentId: "alice-collab",
      coordinatorEpoch: 2,
      pmHumanOpenId: "ou_alice",
      participants: project.participants.map((participant) => ({
        ...participant,
        roles: participant.agentId === "alice-collab"
          ? [...participant.roles.filter((role) => role !== "pm"), "pm"]
          : participant.roles.filter((role) => role !== "pm"),
      })),
    },
    localAgentId: "alice-collab",
    now: () => now,
  });
  assert.equal(reopened.isCoordinator(), true);
  assert.equal(reopened.eventTail(1)[0].kind, "coordinator.transferred");
}));

test("a member mirror cannot mutate the Coordinator-owned ledger", async () => fixture(async (store) => {
  await assert.rejects(() => store.createTask({
    title: "Unauthorized",
    objective: "A member must not create canonical state directly.",
    acceptanceCriteria: ["Rejected"],
  }, { createdByHumanOpenId: "ou_alice" }), /active Project Coordinator/);
}, { localAgentId: "alice-collab" }));

test("projects authenticated executor Agent events into the Coordinator ledger exactly once", async () => fixture(async (store) => {
  let task = await createApproved(store);
  task = await store.offerAssignment(task.taskId, {
    executorAgentId: "alice-collab",
    reviewerAgentId: "bob-collab",
    branch: "task/T-001",
    baseGit,
    offeredByAgentId: "pm-collab",
  });
  const event = (kind, payload) => createAgentEvent({
    kind,
    taskId: task.taskId,
    groupChatId: project.groupChatId,
    githubRepository: project.githubRepository,
    fromAgentId: "alice-collab",
    toAgentId: "pm-collab",
    requesterAgentId: "pm-collab",
    executorAgentId: "alice-collab",
    collaborationProjectId: project.id,
    coordinatorAgentId: "pm-collab",
    coordinatorEpoch: 1,
    payload,
  }, { now, ttlMs: 60_000 });
  const accepted = event("task.accepted", { landing: "new-worktree", message: "Accepted" });
  assert.equal((await store.applyAgentEvent(accepted)).task.state, "assignment_accepted");
  assert.equal((await store.applyAgentEvent(accepted)).duplicate, true);
  assert.equal((await store.applyAgentEvent(event("task.progress", { message: "Running tests" }))).task.state, "running");
  const completed = await store.applyAgentEvent(event("task.result", {
    summary: "Done",
    git: resultGit,
  }));
  assert.equal(completed.task.state, "submitted");
  assert.equal(completed.task.result.git.commit, "2".repeat(40));
}));
