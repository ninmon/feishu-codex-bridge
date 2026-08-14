import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runLarkCliJson } from "./feishu-feed-group.mjs";
import {
  buildCollaborationLedgerMarkdown,
  buildCollaborationProjectMarkdown,
  buildCollaborationTasksMarkdown,
  buildHandoffMarkdown,
  collaborationLedgerDocumentName,
  collaborationStatusDocumentName,
  handoffDocumentName,
} from "./collaboration-project-commands.mjs";

const DOCUMENT_NAME = /^[A-Za-z0-9._-]{1,180}$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function contentRevision(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function extractRemoteFile(envelope) {
  const data = envelope?.data || {};
  const candidates = [data, data.file, data.document, data.result, data.data].filter(Boolean);
  let fileToken;
  let url;
  for (const candidate of candidates) {
    fileToken ||= candidate.file_token || candidate.fileToken || candidate.token;
    url ||= candidate.url || candidate.file_url || candidate.fileUrl;
  }
  if (!fileToken || typeof fileToken !== "string") {
    throw new Error("Feishu Markdown create did not return a file token");
  }
  return { fileToken, ...(typeof url === "string" && url ? { url } : {}) };
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export class FeishuProjectDocumentPublisher {
  static async open({
    projectId,
    statePath,
    artifactDirectory,
    nodeExecutable,
    larkCliEntry,
    folderToken,
    identity = "user",
    profile,
    cwd = process.cwd(),
    runCommand = runLarkCliJson,
    now = Date.now,
  }) {
    let saved = { schemaVersion: 1, projectId, documents: [] };
    try { saved = JSON.parse(await fs.readFile(statePath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Project document state is unreadable: ${error.message}`);
    }
    return new FeishuProjectDocumentPublisher({
      projectId,
      statePath,
      artifactDirectory,
      nodeExecutable,
      larkCliEntry,
      folderToken,
      identity,
      profile,
      cwd,
      runCommand,
      now,
      saved,
    });
  }

  constructor({
    projectId,
    statePath,
    artifactDirectory,
    nodeExecutable,
    larkCliEntry,
    folderToken,
    identity,
    profile,
    cwd,
    runCommand,
    now,
    saved,
  }) {
    this.projectId = requiredString(projectId, "projectId");
    this.statePath = path.resolve(statePath);
    this.artifactDirectory = path.resolve(artifactDirectory);
    this.nodeExecutable = requiredString(nodeExecutable, "nodeExecutable");
    this.larkCliEntry = path.resolve(requiredString(larkCliEntry, "larkCliEntry"));
    this.folderToken = requiredString(folderToken, "folderToken");
    this.identity = String(identity || "user").trim();
    if (!new Set(["user", "bot"]).has(this.identity)) throw new TypeError("identity must be user or bot");
    this.profile = profile ? requiredString(profile, "profile") : undefined;
    this.cwd = cwd;
    this.runCommand = runCommand;
    this.now = now;
    this.tail = Promise.resolve();
    if (saved?.schemaVersion !== 1 || saved.projectId !== this.projectId || !Array.isArray(saved.documents)) {
      throw new Error("Project document state does not match this Collaboration Project");
    }
    this.documents = new Map(saved.documents.map((document) => [document.name, document]));
  }

  get(name) {
    return clone(this.documents.get(name));
  }

  list() {
    return [...this.documents.values()].sort((left, right) => left.name.localeCompare(right.name)).map(clone);
  }

  upsert({ name, content, immutable = false }) {
    const work = async () => this.upsertSerial({ name, content, immutable });
    const running = this.tail.catch(() => {}).then(work);
    this.tail = running.catch(() => {});
    return running;
  }

  async upsertSerial({ name, content, immutable }) {
    const normalizedName = requiredString(name, "name");
    if (!DOCUMENT_NAME.test(normalizedName)) throw new TypeError("Project document name is invalid");
    const normalizedContent = `${requiredString(content, "content")}\n`;
    const revision = contentRevision(normalizedContent);
    const existing = this.documents.get(normalizedName);
    if (existing?.immutable && existing.revision !== revision) {
      throw new Error(`Immutable Handoff document cannot be overwritten: ${normalizedName}`);
    }
    if (existing?.revision === revision) return clone(existing);
    if (immutable && existing) return clone(existing);

    const localPath = path.join(this.artifactDirectory, `${normalizedName}.md`);
    await writeAtomic(localPath, normalizedContent);
    const profileArgs = this.profile ? ["--profile", this.profile] : [];
    let remote;
    if (existing?.fileToken) {
      const envelope = await this.runCommand(this.nodeExecutable, this.larkCliEntry, [
        "markdown", "+overwrite",
        "--as", this.identity,
        "--file", localPath,
        "--name", `${normalizedName}.md`,
        "--file-token", existing.fileToken,
        "--format", "json",
        ...profileArgs,
      ], { cwd: this.cwd });
      remote = { fileToken: existing.fileToken, url: existing.url || envelope?.data?.url };
    } else {
      const envelope = await this.runCommand(this.nodeExecutable, this.larkCliEntry, [
        "markdown", "+create",
        "--as", this.identity,
        "--file", localPath,
        "--name", `${normalizedName}.md`,
        "--folder-token", this.folderToken,
        "--format", "json",
        ...profileArgs,
      ], { cwd: this.cwd });
      remote = extractRemoteFile(envelope);
    }
    const document = {
      schemaVersion: 1,
      projectId: this.projectId,
      name: normalizedName,
      fileToken: remote.fileToken,
      url: remote.url,
      immutable: immutable === true,
      revision,
      localFileName: `${normalizedName}.md`,
      createdAt: existing?.createdAt || this.now(),
      updatedAt: this.now(),
    };
    this.documents.set(normalizedName, document);
    await this.persist();
    return clone(document);
  }

  async persist() {
    await writeAtomic(this.statePath, `${JSON.stringify({
      schemaVersion: 1,
      projectId: this.projectId,
      documents: [...this.documents.values()],
    }, null, 2)}\n`);
  }
}

export class CollaborationProjectDocumentSynchronizer {
  constructor({ projectStore, coordinatorBindingStore, publisher }) {
    this.projectStore = projectStore;
    this.coordinatorBindingStore = coordinatorBindingStore;
    this.publisher = publisher;
    this.tail = Promise.resolve();
  }

  sync() {
    const running = this.tail.catch(() => {}).then(() => this.syncSerial());
    this.tail = running.catch(() => {});
    return running;
  }

  async syncSerial() {
    const project = this.projectStore.getProject();
    const tasks = this.projectStore.list({ limit: 500 });
    const statusName = collaborationStatusDocumentName(project);
    const status = [
      `# ${statusName}`,
      "",
      buildCollaborationProjectMarkdown(project, tasks, this.coordinatorBindingStore?.status()),
      "",
      buildCollaborationTasksMarkdown(tasks),
    ].join("\n");
    const records = [
      await this.publisher.upsert({ name: statusName, content: status }),
      await this.publisher.upsert({
        name: collaborationLedgerDocumentName(project),
        content: buildCollaborationLedgerMarkdown(project, this.projectStore.eventTail(500)),
      }),
    ];
    for (const task of tasks.filter((candidate) => candidate.result && candidate.assignment?.executorAgentId)) {
      const revision = Math.max(1, Number(task.resultRevision) || 1);
      const name = handoffDocumentName(task, {
        fromAgentId: task.assignment.executorAgentId,
        toAgentId: project.coordinatorAgentId,
        revision,
      });
      records.push(await this.publisher.upsert({
        name,
        content: buildHandoffMarkdown(task, {
          fromAgentId: task.assignment.executorAgentId,
          toAgentId: project.coordinatorAgentId,
          revision,
          createdAt: task.result.submittedAt,
        }),
        immutable: true,
      }));
    }
    return records;
  }
}
