import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CoordinatorBindingStore } from "./coordinator-binding-store.mjs";

const authority = {
  projectId: "bridge-team",
  coordinatorAgentId: "peiyuan-collab",
  coordinatorEpoch: 2,
  localAgentId: "peiyuan-collab",
  pmHumanOpenId: "ou_pm",
  defaultBranch: "main",
};

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-coordinator-binding-"));
  const filePath = path.join(directory, "binding.json");
  try { await run(filePath); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("binds a replaceable PM Coordinator Session only on the read-only default branch", async () => fixture(async (filePath) => {
  const store = await CoordinatorBindingStore.open(filePath, authority, { now: () => 1_800_000_000_000 });
  assert.deepEqual(store.status(), { state: "unbound" });
  await assert.rejects(() => store.bind({
    threadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
    branch: "task/code",
    readOnly: true,
    boundByHumanOpenId: "ou_pm",
  }), /default branch/);
  const binding = await store.bind({
    threadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
    branch: "main",
    readOnly: true,
    boundByHumanOpenId: "ou_pm",
  });
  assert.equal(binding.threadId, "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294");
  assert.equal(binding.coordinatorEpoch, 2);
  assert.equal((await CoordinatorBindingStore.open(filePath, authority)).status().state, "bound");
}));

test("invalidates rather than reusing a Session after Coordinator authority changes", async () => fixture(async (filePath) => {
  const store = await CoordinatorBindingStore.open(filePath, authority);
  await store.bind({
    threadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
    branch: "main",
    readOnly: true,
    boundByHumanOpenId: "ou_pm",
  });
  const changed = await CoordinatorBindingStore.open(filePath, {
    ...authority,
    coordinatorAgentId: "alice-collab",
    localAgentId: "alice-collab",
    pmHumanOpenId: "ou_alice",
    coordinatorEpoch: 3,
  });
  assert.equal(changed.get(), undefined);
  assert.equal(changed.status().state, "stale");
}));

test("a member cannot bind or clear the remote Coordinator Session", async () => fixture(async (filePath) => {
  const store = await CoordinatorBindingStore.open(filePath, {
    ...authority,
    localAgentId: "alice-collab",
  });
  assert.equal(store.status().state, "remote");
  await assert.rejects(() => store.bind({
    threadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
    branch: "main",
    readOnly: true,
    boundByHumanOpenId: "ou_pm",
  }), /active local Coordinator/);
  await assert.rejects(() => store.clear({ clearedByHumanOpenId: "ou_pm" }), /active local Coordinator/);
}));
