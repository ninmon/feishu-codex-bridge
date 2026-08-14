import { promises as fs } from "node:fs";
import path from "node:path";

const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const THREAD_ID = /^[A-Za-z0-9._:-]{8,160}$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function normalizeAuthority(authority) {
  const projectId = requiredString(authority?.projectId, "authority.projectId");
  const coordinatorAgentId = requiredString(authority?.coordinatorAgentId, "authority.coordinatorAgentId");
  const localAgentId = requiredString(authority?.localAgentId, "authority.localAgentId");
  const pmHumanOpenId = requiredString(authority?.pmHumanOpenId, "authority.pmHumanOpenId");
  const defaultBranch = requiredString(authority?.defaultBranch, "authority.defaultBranch");
  if (!AGENT_ID.test(projectId)) throw new TypeError("authority.projectId is invalid");
  if (!AGENT_ID.test(coordinatorAgentId) || !AGENT_ID.test(localAgentId)) {
    throw new TypeError("Coordinator Agent identity is invalid");
  }
  const coordinatorEpoch = Number(authority?.coordinatorEpoch);
  if (!Number.isSafeInteger(coordinatorEpoch) || coordinatorEpoch < 1) {
    throw new TypeError("authority.coordinatorEpoch must be a positive integer");
  }
  return { projectId, coordinatorAgentId, coordinatorEpoch, localAgentId, pmHumanOpenId, defaultBranch };
}

async function writeAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export class CoordinatorBindingStore {
  static async open(filePath, authority, { now = Date.now } = {}) {
    const normalizedAuthority = normalizeAuthority(authority);
    let saved;
    try { saved = JSON.parse(await fs.readFile(filePath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Coordinator binding is unreadable: ${error.message}`);
    }
    return new CoordinatorBindingStore(filePath, normalizedAuthority, saved, { now });
  }

  constructor(filePath, authority, saved, { now = Date.now } = {}) {
    this.filePath = filePath;
    this.authority = authority;
    this.now = now;
    this.binding = undefined;
    this.staleBinding = undefined;
    this.writeTail = Promise.resolve();
    if (saved !== undefined) this.load(saved);
  }

  load(saved) {
    if (saved?.schemaVersion !== 1) throw new Error("Coordinator binding has an unsupported schema");
    if (!THREAD_ID.test(String(saved.threadId || ""))) throw new Error("Coordinator binding threadId is invalid");
    const sameAuthority = saved.projectId === this.authority.projectId
      && saved.coordinatorAgentId === this.authority.coordinatorAgentId
      && saved.coordinatorEpoch === this.authority.coordinatorEpoch;
    if (!sameAuthority) {
      this.staleBinding = clone(saved);
      return;
    }
    if (saved.branch !== this.authority.defaultBranch || saved.readOnly !== true) {
      throw new Error("Coordinator binding must use the protected default branch in read-only mode");
    }
    this.binding = clone(saved);
  }

  isLocalCoordinator() {
    return this.authority.localAgentId === this.authority.coordinatorAgentId;
  }

  get() {
    return clone(this.binding);
  }

  status() {
    if (!this.isLocalCoordinator()) return { state: "remote", coordinatorAgentId: this.authority.coordinatorAgentId };
    if (this.binding) return { state: "bound", binding: this.get() };
    if (this.staleBinding) {
      return {
        state: "stale",
        previousCoordinatorAgentId: this.staleBinding.coordinatorAgentId,
        previousCoordinatorEpoch: this.staleBinding.coordinatorEpoch,
      };
    }
    return { state: "unbound" };
  }

  async bind({ threadId, branch, readOnly, boundByHumanOpenId }) {
    if (!this.isLocalCoordinator()) throw new Error("Only the active local Coordinator can bind a Coordinator Session");
    if (boundByHumanOpenId !== this.authority.pmHumanOpenId) {
      throw new Error("Only the configured human PM can bind the Coordinator Session");
    }
    const normalizedThreadId = requiredString(threadId, "threadId");
    if (!THREAD_ID.test(normalizedThreadId)) throw new TypeError("Coordinator threadId is invalid");
    if (branch !== this.authority.defaultBranch) {
      throw new Error(`Coordinator Session must use the default branch ${this.authority.defaultBranch}`);
    }
    if (readOnly !== true) throw new Error("Coordinator Session must be read-only");
    const next = {
      schemaVersion: 1,
      projectId: this.authority.projectId,
      coordinatorAgentId: this.authority.coordinatorAgentId,
      coordinatorEpoch: this.authority.coordinatorEpoch,
      threadId: normalizedThreadId,
      branch,
      readOnly: true,
      boundByHumanOpenId,
      boundAt: this.now(),
    };
    this.binding = next;
    this.staleBinding = undefined;
    await this.persist(next);
    return this.get();
  }

  async clear({ clearedByHumanOpenId }) {
    if (!this.isLocalCoordinator()) throw new Error("Only the active local Coordinator can clear a Coordinator Session");
    if (clearedByHumanOpenId !== this.authority.pmHumanOpenId) {
      throw new Error("Only the configured human PM can clear the Coordinator Session");
    }
    this.binding = undefined;
    this.staleBinding = undefined;
    this.writeTail = this.writeTail.then(() => fs.rm(this.filePath, { force: true }));
    await this.writeTail;
  }

  async persist(value) {
    this.writeTail = this.writeTail.then(() => writeAtomic(this.filePath, value));
    await this.writeTail;
  }
}
