import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CollaborationProjectDocumentSynchronizer,
  FeishuProjectDocumentPublisher,
} from "./feishu-project-documents.mjs";

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-project-documents-"));
  const calls = [];
  let sequence = 0;
  const runCommand = async (_node, _entry, args) => {
    calls.push(args);
    sequence += 1;
    return {
      ok: true,
      data: {
        file_token: `boxcn_token_${sequence}`,
        url: `https://example.feishu.cn/file/token-${sequence}`,
      },
    };
  };
  try {
    const publisher = await FeishuProjectDocumentPublisher.open({
      projectId: "bridge-team",
      statePath: path.join(directory, "state.json"),
      artifactDirectory: path.join(directory, "artifacts"),
      nodeExecutable: "node.exe",
      larkCliEntry: path.join(directory, "lark-cli.js"),
      folderToken: "fldcn_shared",
      identity: "user",
      profile: "team",
      runCommand,
      now: () => 1_800_000_000_000,
    });
    await run({ publisher, calls, directory });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("creates then overwrites one fixed Project status document", async () => fixture(async ({ publisher, calls, directory }) => {
  const first = await publisher.upsert({ name: "COLLAB-bridge-team-STATUS", content: "# Status\nDraft" });
  const second = await publisher.upsert({ name: "COLLAB-bridge-team-STATUS", content: "# Status\nApproved" });
  assert.equal(first.fileToken, second.fileToken);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["markdown", "+create"]);
  assert.deepEqual(calls[1].slice(0, 2), ["markdown", "+overwrite"]);
  assert.equal(calls[0].includes("fldcn_shared"), true);
  assert.equal(calls[0].includes("team"), true);
  assert.match(await fs.readFile(path.join(directory, "artifacts", "COLLAB-bridge-team-STATUS.md"), "utf8"), /Approved/);
}));

test("keeps a Handoff immutable and idempotent", async () => fixture(async ({ publisher, calls }) => {
  const name = "HANDOFF-task-12345678-alice-TO-pm-R1";
  const first = await publisher.upsert({ name, content: "# Handoff\nDone", immutable: true });
  const duplicate = await publisher.upsert({ name, content: "# Handoff\nDone", immutable: true });
  assert.equal(first.fileToken, duplicate.fileToken);
  assert.equal(calls.length, 1);
  await assert.rejects(() => publisher.upsert({ name, content: "# Handoff\nChanged", immutable: true }), /cannot be overwritten/);
}));

test("single-writer sync publishes fixed STATUS and LEDGER plus immutable Handoff revisions", async () => fixture(async ({ publisher }) => {
  const project = {
    id: "bridge-team",
    name: "Bridge",
    githubRepository: "example/bridge",
    pmHumanOpenId: "ou_pm",
    coordinatorAgentId: "pm-collab",
    coordinatorEpoch: 1,
    participants: [{}, {}],
  };
  const task = {
    taskId: "task:12345678",
    title: "Implement",
    objective: "Implement the approved change.",
    state: "submitted",
    githubRepository: "example/bridge",
    acceptanceCriteria: ["Tests pass"],
    assignment: { executorAgentId: "alice-collab", reviewerAgentId: "pm-collab", branch: "task/T-001", baseGit: { commit: "1".repeat(40) } },
    resultRevision: 2,
    result: {
      summary: "Done",
      git: { branch: "task/T-001", commit: "2".repeat(40) },
      evidence: ["node --test"],
      submittedAt: 1_800_000_000_000,
    },
  };
  const synchronizer = new CollaborationProjectDocumentSynchronizer({
    projectStore: {
      getProject: () => project,
      list: () => [task],
      eventTail: () => [{
        sequence: 1,
        kind: "execution.submitted",
        taskId: task.taskId,
        actor: { type: "agent", id: "alice-collab" },
        createdAt: 1_800_000_000_000,
        coordinatorEpoch: 1,
      }],
    },
    coordinatorBindingStore: { status: () => ({ state: "bound" }) },
    publisher,
  });
  const records = await synchronizer.sync();
  assert.deepEqual(records.map(({ name }) => name), [
    "COLLAB-bridge-team-STATUS",
    "COLLAB-bridge-team-LEDGER",
    "HANDOFF-task-12345678-alice-collab-TO-pm-collab-R2",
  ]);
  assert.equal(records[2].immutable, true);
}));
