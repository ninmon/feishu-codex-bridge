import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const COLLABORATION_TASK_STATES = Object.freeze([
  "draft",
  "awaiting_plan_approval",
  "approved",
  "offered",
  "assignment_accepted",
  "running",
  "submitted",
  "verifying",
  "changes_requested",
  "ready_for_pm",
  "result_accepted",
  "published",
  "closed",
  "blocked",
  "rejected",
  "cancelled",
]);

const STATE_SET = new Set(COLLABORATION_TASK_STATES);
const TERMINAL_STATES = new Set(["closed", "rejected", "cancelled"]);
const TASK_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._/-]{1,200}$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const MAX_TASKS = 1_000;
const MAX_EVENTS = 10_000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requiredString(value, field, max = 12_000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length > max) throw new TypeError(`${field} is too long`);
  return normalized;
}

function optionalString(value, field, max = 2_000) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, field, max);
}

function boundedStrings(values, field, { min = 0, max = 20, itemMax = 1_000 } = {}) {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  const normalized = [...new Set(values.map((value, index) => requiredString(value, `${field}[${index}]`, itemMax)))];
  if (normalized.length < min || normalized.length > max) {
    throw new TypeError(`${field} must contain between ${min} and ${max} entries`);
  }
  return normalized;
}

function normalizeGit(value, expectedBranch) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("resultGit is required");
  const remote = requiredString(value.remote, "resultGit.remote", 100);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new TypeError("resultGit.remote is invalid");
  const branch = requiredString(value.branch, "resultGit.branch", 200);
  if (!BRANCH.test(branch)) throw new TypeError("resultGit.branch is invalid");
  if (expectedBranch && branch !== expectedBranch) throw new Error(`Result branch must remain ${expectedBranch}`);
  const commit = requiredString(value.commit, "resultGit.commit", 40).toLowerCase();
  if (!COMMIT.test(commit)) throw new TypeError("resultGit.commit must be a full Git SHA");
  const prUrl = optionalString(value.prUrl, "resultGit.prUrl", 2_000);
  return { remote, branch, commit, ...(prUrl ? { prUrl } : {}) };
}

function normalizeProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) throw new TypeError("Collaboration Project is required");
  const id = requiredString(project.id, "project.id", 63);
  const coordinatorAgentId = requiredString(project.coordinatorAgentId, "project.coordinatorAgentId", 63);
  if (!AGENT_ID.test(id) || !AGENT_ID.test(coordinatorAgentId)) throw new TypeError("Project or Coordinator Agent id is invalid");
  const coordinatorEpoch = Number(project.coordinatorEpoch);
  if (!Number.isSafeInteger(coordinatorEpoch) || coordinatorEpoch < 1) throw new TypeError("project.coordinatorEpoch is invalid");
  const participants = (project.participants || []).filter(({ enabled }) => enabled !== false).map((participant) => ({
    agentId: requiredString(participant.agentId, "participants[].agentId", 63),
    humanOpenId: requiredString(participant.humanOpenId, "participants[].humanOpenId", 160),
    botOpenId: requiredString(participant.botOpenId, "participants[].botOpenId", 160),
    displayName: String(participant.displayName || participant.agentId).trim(),
    humanDisplayName: String(participant.humanDisplayName || participant.humanOpenId).trim(),
    roles: [...new Set(participant.roles || ["member"])],
    capabilities: [...new Set(participant.capabilities || [])],
    enabled: true,
  }));
  if (participants.length === 0) throw new TypeError("Collaboration Project requires participants");
  if (new Set(participants.map(({ agentId }) => agentId)).size !== participants.length) {
    throw new TypeError("Collaboration Project participant Agent ids must be unique");
  }
  const coordinator = participants.find((participant) => participant.agentId === coordinatorAgentId);
  if (!coordinator) throw new TypeError("Coordinator Agent must be a registered participant");
  const pmHumanOpenId = requiredString(project.pmHumanOpenId, "project.pmHumanOpenId", 160);
  if (coordinator.humanOpenId !== pmHumanOpenId) {
    throw new TypeError("The human PM must own the active Coordinator Agent");
  }
  return {
    id,
    name: requiredString(project.name || id, "project.name", 160),
    groupChatId: requiredString(project.groupChatId, "project.groupChatId", 160),
    controlGroupChatId: requiredString(project.controlGroupChatId, "project.controlGroupChatId", 160),
    githubRepository: requiredString(project.githubRepository, "project.githubRepository", 300),
    defaultBranch: requiredString(project.defaultBranch || "main", "project.defaultBranch", 200),
    coordinatorAgentId,
    coordinatorEpoch,
    pmHumanOpenId,
    participants,
    approvalPolicy: clone(project.approvalPolicy || {}),
  };
}

function projectAuthority(project) {
  return {
    id: project.id,
    name: project.name,
    groupChatId: project.groupChatId,
    controlGroupChatId: project.controlGroupChatId,
    githubRepository: project.githubRepository,
    defaultBranch: project.defaultBranch,
    coordinatorAgentId: project.coordinatorAgentId,
    coordinatorEpoch: project.coordinatorEpoch,
    pmHumanOpenId: project.pmHumanOpenId,
  };
}

function sameAuthority(left, right) {
  return JSON.stringify(projectAuthority(left)) === JSON.stringify(projectAuthority(right));
}

async function writeAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function collaborationProjectDefinition(config) {
  if (!config?.collaboration?.projectId) return undefined;
  return normalizeProject({
    id: config.collaboration.projectId,
    name: config.collaboration.projectName,
    groupChatId: config.collaboration.groupChatId,
    controlGroupChatId: config.collaboration.controlGroupChatId,
    githubRepository: config.collaboration.githubRepository,
    defaultBranch: config.project.defaultBranch,
    coordinatorAgentId: config.collaboration.coordinatorAgentId,
    coordinatorEpoch: config.collaboration.coordinatorEpoch,
    pmHumanOpenId: config.collaboration.pmHumanOpenId,
    participants: config.collaboration.participants,
    approvalPolicy: config.collaboration.approvalPolicy,
  });
}

export class CollaborationProjectStore {
  static async open(filePath, { project, localAgentId, now = Date.now, idFactory = randomUUID }) {
    const normalizedProject = normalizeProject(project);
    let saved;
    try { saved = JSON.parse(await fs.readFile(filePath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Collaboration Project store is unreadable: ${error.message}`);
    }
    return new CollaborationProjectStore(filePath, {
      project: normalizedProject,
      localAgentId,
      now,
      idFactory,
      saved,
    });
  }

  constructor(filePath, { project, localAgentId, now, idFactory, saved }) {
    if (!AGENT_ID.test(String(localAgentId || ""))) throw new TypeError("localAgentId is invalid");
    this.filePath = filePath;
    this.project = project;
    this.localAgentId = localAgentId;
    this.now = now;
    this.idFactory = idFactory;
    this.writeTail = Promise.resolve();
    this.tasks = new Map();
    this.events = [];
    this.seenAgentEventIds = new Set();
    this.nextSequence = 1;
    if (saved !== undefined) this.load(saved);
  }

  load(saved) {
    if (saved?.schemaVersion !== 1 || !Array.isArray(saved.tasks) || !Array.isArray(saved.events)) {
      throw new Error("Collaboration Project store has an unsupported schema");
    }
    const savedProject = normalizeProject(saved.project);
    if (!sameAuthority(savedProject, this.project)) {
      throw new Error("Collaboration Project authority differs from the durable ledger");
    }
    this.project = { ...this.project, participants: clone(savedProject.participants) };
    for (const task of saved.tasks) {
      if (!TASK_ID.test(String(task.taskId || "")) || !STATE_SET.has(task.state)) {
        throw new Error("Collaboration Project ledger contains an invalid task");
      }
      this.tasks.set(task.taskId, task);
    }
    this.events = saved.events;
    this.seenAgentEventIds = new Set(saved.seenAgentEventIds || []);
    this.nextSequence = Math.max(0, ...this.events.map(({ sequence }) => Number(sequence) || 0)) + 1;
  }

  isCoordinator() {
    return this.localAgentId === this.project.coordinatorAgentId;
  }

  getProject() {
    return clone(this.project);
  }

  get(taskId) {
    return clone(this.tasks.get(taskId));
  }

  list({ state, executorAgentId, limit = 100 } = {}) {
    return [...this.tasks.values()]
      .filter((task) => !state || task.state === state)
      .filter((task) => !executorAgentId || task.assignment?.executorAgentId === executorAgentId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
      .map(clone);
  }

  eventTail(limit = 100) {
    return this.events.slice(-Math.max(1, Math.min(500, Number(limit) || 100))).map(clone);
  }

  async createTask(input, { createdByHumanOpenId }) {
    this.requireCoordinator();
    this.requireParticipantHuman(createdByHumanOpenId);
    const taskId = input.taskId || `task:${this.idFactory()}`;
    if (!TASK_ID.test(taskId)) throw new TypeError("taskId is invalid");
    if (this.tasks.has(taskId)) throw new Error(`Task ${taskId} already exists`);
    const parentTaskId = input.parentTaskId ? requiredString(input.parentTaskId, "parentTaskId", 128) : undefined;
    if (parentTaskId && (!TASK_ID.test(parentTaskId) || !this.tasks.has(parentTaskId))) {
      throw new Error("parentTaskId must identify an existing Collaboration Project task");
    }
    const timestamp = this.now();
    const task = {
      schemaVersion: 1,
      taskId,
      parentTaskId,
      title: requiredString(input.title, "title", 160),
      objective: requiredString(input.objective, "objective", 12_000),
      scope: {
        in: boundedStrings(input.scope?.in || [], "scope.in", { max: 20 }),
        out: boundedStrings(input.scope?.out || [], "scope.out", { max: 20 }),
      },
      acceptanceCriteria: boundedStrings(input.acceptanceCriteria, "acceptanceCriteria", { min: 1, max: 20 }),
      evidenceRequired: boundedStrings(input.evidenceRequired || [], "evidenceRequired", { max: 20 }),
      dependencies: boundedStrings(input.dependencies || [], "dependencies", { max: 50, itemMax: 128 }),
      githubRepository: this.project.githubRepository,
      state: "draft",
      createdByHumanOpenId,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    };
    for (const dependency of task.dependencies) {
      if (!TASK_ID.test(dependency) || !this.tasks.has(dependency)) throw new Error(`Unknown task dependency: ${dependency}`);
    }
    this.tasks.set(taskId, task);
    this.appendEvent("task.created", task, { type: "human", id: createdByHumanOpenId }, { title: task.title });
    await this.persist();
    return clone(task);
  }

  async submitPlan(taskId, { submittedByAgentId, note } = {}) {
    this.requireCoordinator(submittedByAgentId);
    const task = this.requireTask(taskId, ["draft"]);
    this.transition(task, "awaiting_plan_approval", "plan.submitted", { type: "agent", id: this.project.coordinatorAgentId }, {
      note: optionalString(note, "note"),
    });
    await this.persist();
    return clone(task);
  }

  async approvePlan(taskId, { approvedByHumanOpenId, note } = {}) {
    this.requirePm(approvedByHumanOpenId);
    const task = this.requireTask(taskId, ["awaiting_plan_approval"]);
    task.planApproval = { approvedByHumanOpenId, note: optionalString(note, "note"), approvedAt: this.now() };
    this.transition(task, "approved", "plan.approved", { type: "human", id: approvedByHumanOpenId }, { note: task.planApproval.note });
    await this.persist();
    return clone(task);
  }

  async rejectPlan(taskId, { rejectedByHumanOpenId, reason }) {
    this.requirePm(rejectedByHumanOpenId);
    const task = this.requireTask(taskId, ["awaiting_plan_approval"]);
    task.reason = requiredString(reason, "reason", 2_000);
    this.transition(task, "rejected", "plan.rejected", { type: "human", id: rejectedByHumanOpenId }, { reason: task.reason });
    await this.persist();
    return clone(task);
  }

  async offerAssignment(taskId, {
    executorAgentId,
    reviewerAgentId,
    branch,
    baseGit,
    offeredByAgentId,
  }) {
    this.requireCoordinator(offeredByAgentId);
    const task = this.requireTask(taskId, ["approved"]);
    const executor = this.requireParticipantAgent(executorAgentId);
    const normalizedBranch = requiredString(branch, "branch", 200);
    if (!BRANCH.test(normalizedBranch)) throw new TypeError("branch is invalid");
    if (normalizedBranch === this.project.defaultBranch) {
      throw new Error(`A collaboration write task cannot target protected default branch ${this.project.defaultBranch}`);
    }
    if (!reviewerAgentId) throw new Error("Every collaboration task requires an independent technical reviewer");
    const reviewer = this.requireParticipantAgent(reviewerAgentId);
    if (reviewer.agentId === executor.agentId) throw new Error("Technical reviewer must be independent from the executor");
    for (const dependencyId of task.dependencies) {
      const dependency = this.tasks.get(dependencyId);
      if (!dependency || !new Set(["result_accepted", "published", "closed"]).has(dependency.state)) {
        throw new Error(`Task dependency is not accepted: ${dependencyId}`);
      }
    }
    const normalizedBaseGit = normalizeGit(baseGit);
    task.assignment = {
      executorAgentId: executor.agentId,
      reviewerAgentId: reviewer?.agentId,
      branch: normalizedBranch,
      baseGit: normalizedBaseGit,
      offeredAt: this.now(),
    };
    this.transition(task, "offered", "assignment.offered", { type: "agent", id: this.project.coordinatorAgentId }, {
      executorAgentId: executor.agentId,
      reviewerAgentId: reviewer?.agentId,
      branch: normalizedBranch,
      baseCommit: normalizedBaseGit.commit,
    });
    await this.persist();
    return clone(task);
  }

  async assignReviewer(taskId, { reviewerAgentId, assignedByAgentId }) {
    this.requireCoordinator(assignedByAgentId);
    const task = this.requireTask(taskId);
    if (!task.assignment || TERMINAL_STATES.has(task.state) || task.state === "published") {
      throw new Error(`Task ${taskId} cannot receive a reviewer from ${task.state}`);
    }
    const reviewer = this.requireParticipantAgent(reviewerAgentId);
    if (reviewer.agentId === task.assignment.executorAgentId) throw new Error("Technical reviewer must be independent from the executor");
    task.assignment.reviewerAgentId = reviewer.agentId;
    this.touch(task);
    this.appendEvent("reviewer.assigned", task, { type: "agent", id: this.project.coordinatorAgentId }, { reviewerAgentId });
    await this.persist();
    return clone(task);
  }

  async acceptAssignment(taskId, { acceptedByAgentId }) {
    const task = this.requireTask(taskId, ["offered"]);
    this.requireExecutor(task, acceptedByAgentId);
    this.transition(task, "assignment_accepted", "assignment.accepted", { type: "agent", id: acceptedByAgentId });
    await this.persist();
    return clone(task);
  }

  async rejectAssignment(taskId, { rejectedByAgentId, reason }) {
    const task = this.requireTask(taskId, ["offered"]);
    this.requireExecutor(task, rejectedByAgentId);
    task.reason = requiredString(reason, "reason", 2_000);
    this.transition(task, "rejected", "assignment.rejected", { type: "agent", id: rejectedByAgentId }, { reason: task.reason });
    await this.persist();
    return clone(task);
  }

  async startExecution(taskId, { startedByAgentId }) {
    const task = this.requireTask(taskId, ["assignment_accepted", "changes_requested"]);
    this.requireExecutor(task, startedByAgentId);
    this.transition(task, "running", "execution.started", { type: "agent", id: startedByAgentId });
    await this.persist();
    return clone(task);
  }

  async recordProgress(taskId, { reportedByAgentId, message }) {
    const task = this.requireTask(taskId, ["running"]);
    this.requireExecutor(task, reportedByAgentId);
    task.lastProgress = requiredString(message, "message", 2_000);
    this.touch(task);
    this.appendEvent("execution.progress", task, { type: "agent", id: reportedByAgentId }, { message: task.lastProgress });
    await this.persist();
    return clone(task);
  }

  async submitResult(taskId, { submittedByAgentId, summary, resultGit, evidence = [] }) {
    const task = this.requireTask(taskId, ["running", "assignment_accepted", "changes_requested"]);
    this.requireExecutor(task, submittedByAgentId);
    task.resultRevision = Number(task.resultRevision || 0) + 1;
    task.result = {
      summary: requiredString(summary, "summary", 12_000),
      git: normalizeGit(resultGit, task.assignment.branch),
      evidence: boundedStrings(evidence, "evidence", { max: 50, itemMax: 2_000 }),
      submittedAt: this.now(),
      submittedByAgentId,
    };
    this.transition(task, "submitted", "execution.submitted", { type: "agent", id: submittedByAgentId }, {
      branch: task.result.git.branch,
      commit: task.result.git.commit,
      evidenceCount: task.result.evidence.length,
    });
    await this.persist();
    return clone(task);
  }

  async startVerification(taskId, { reviewerAgentId }) {
    const task = this.requireTask(taskId, ["submitted"]);
    this.requireReviewer(task, reviewerAgentId);
    this.transition(task, "verifying", "verification.started", { type: "agent", id: reviewerAgentId });
    await this.persist();
    return clone(task);
  }

  async requestChanges(taskId, { reviewerAgentId, reason }) {
    const task = this.requireTask(taskId, ["verifying"]);
    this.requireReviewer(task, reviewerAgentId);
    task.reason = requiredString(reason, "reason", 2_000);
    this.transition(task, "changes_requested", "verification.changes_requested", { type: "agent", id: reviewerAgentId }, { reason: task.reason });
    await this.persist();
    return clone(task);
  }

  async passVerification(taskId, { reviewerAgentId, note, checks = [] }) {
    const task = this.requireTask(taskId, ["verifying"]);
    this.requireReviewer(task, reviewerAgentId);
    task.verification = {
      reviewerAgentId,
      note: optionalString(note, "note", 2_000),
      checks: boundedStrings(checks, "checks", { min: 1, max: 50, itemMax: 1_000 }),
      verifiedAt: this.now(),
    };
    this.transition(task, "ready_for_pm", "verification.passed", { type: "agent", id: reviewerAgentId }, {
      checkCount: task.verification.checks.length,
      note: task.verification.note,
    });
    await this.persist();
    return clone(task);
  }

  async acceptResult(taskId, { acceptedByHumanOpenId, note }) {
    this.requirePm(acceptedByHumanOpenId);
    const task = this.requireTask(taskId, ["ready_for_pm"]);
    task.resultAcceptance = {
      acceptedByHumanOpenId,
      note: optionalString(note, "note", 2_000),
      acceptedAt: this.now(),
    };
    this.transition(task, "result_accepted", "result.accepted", { type: "human", id: acceptedByHumanOpenId }, {
      note: task.resultAcceptance.note,
    });
    await this.persist();
    return clone(task);
  }

  async publish(taskId, { publishedByAgentId, note, prUrl } = {}) {
    this.requireCoordinator(publishedByAgentId);
    const task = this.requireTask(taskId, ["result_accepted"]);
    task.publication = {
      publishedByAgentId: this.project.coordinatorAgentId,
      note: optionalString(note, "note", 2_000),
      prUrl: optionalString(prUrl || task.result?.git?.prUrl, "prUrl", 2_000),
      publishedAt: this.now(),
    };
    this.transition(task, "published", "result.published", { type: "agent", id: this.project.coordinatorAgentId }, {
      commit: task.result?.git?.commit,
      prUrl: task.publication.prUrl,
    });
    await this.persist();
    return clone(task);
  }

  async close(taskId, { closedByHumanOpenId, note } = {}) {
    this.requirePm(closedByHumanOpenId);
    const task = this.requireTask(taskId, ["published"]);
    this.transition(task, "closed", "task.closed", { type: "human", id: closedByHumanOpenId }, {
      note: optionalString(note, "note", 2_000),
    });
    await this.persist();
    return clone(task);
  }

  async block(taskId, { blockedByAgentId, reason }) {
    const task = this.requireTask(taskId);
    if (!new Set(["offered", "assignment_accepted", "running", "submitted", "verifying", "changes_requested"]).has(task.state)) {
      throw new Error(`Task ${taskId} cannot be blocked from ${task.state}`);
    }
    if (blockedByAgentId !== this.project.coordinatorAgentId
      && blockedByAgentId !== task.assignment?.executorAgentId
      && blockedByAgentId !== task.assignment?.reviewerAgentId) {
      throw new Error("Only the Coordinator, executor, or reviewer can block this task");
    }
    task.resumeState = task.state;
    task.reason = requiredString(reason, "reason", 2_000);
    this.transition(task, "blocked", "task.blocked", { type: "agent", id: blockedByAgentId }, {
      reason: task.reason,
      resumeState: task.resumeState,
    });
    await this.persist();
    return clone(task);
  }

  async resume(taskId, { resumedByAgentId, note } = {}) {
    this.requireCoordinator(resumedByAgentId);
    const task = this.requireTask(taskId, ["blocked"]);
    if (!task.resumeState || !STATE_SET.has(task.resumeState) || task.resumeState === "blocked") {
      throw new Error("Blocked task has no valid resume state");
    }
    const target = task.resumeState;
    delete task.resumeState;
    delete task.reason;
    this.transition(task, target, "task.resumed", { type: "agent", id: this.project.coordinatorAgentId }, {
      note: optionalString(note, "note", 2_000),
    });
    await this.persist();
    return clone(task);
  }

  async cancel(taskId, { cancelledByHumanOpenId, reason }) {
    this.requirePm(cancelledByHumanOpenId);
    const task = this.requireTask(taskId);
    if (TERMINAL_STATES.has(task.state) || task.state === "published") {
      throw new Error(`Task ${taskId} cannot be cancelled from ${task.state}`);
    }
    task.reason = requiredString(reason, "reason", 2_000);
    this.transition(task, "cancelled", "task.cancelled", { type: "human", id: cancelledByHumanOpenId }, { reason: task.reason });
    await this.persist();
    return clone(task);
  }

  async transferCoordinator({ newCoordinatorAgentId, transferredByHumanOpenId }) {
    this.requirePm(transferredByHumanOpenId);
    this.requireCoordinator();
    const participant = this.requireParticipantAgent(newCoordinatorAgentId);
    if (participant.agentId === this.project.coordinatorAgentId) throw new Error("The requested Agent is already Coordinator");
    const previousAgentId = this.project.coordinatorAgentId;
    const previousEpoch = this.project.coordinatorEpoch;
    this.project.coordinatorAgentId = participant.agentId;
    this.project.pmHumanOpenId = participant.humanOpenId;
    this.project.coordinatorEpoch += 1;
    for (const candidate of this.project.participants) {
      candidate.roles = candidate.roles.filter((role) => role !== "pm");
      if (candidate.agentId === participant.agentId) candidate.roles.push("pm");
    }
    this.appendEvent("coordinator.transferred", undefined, { type: "human", id: transferredByHumanOpenId }, {
      previousAgentId,
      previousEpoch,
      coordinatorAgentId: participant.agentId,
      coordinatorEpoch: this.project.coordinatorEpoch,
    });
    await this.persist();
    return this.getProject();
  }

  async applyAgentEvent(event) {
    this.requireCoordinator();
    if (!event || typeof event !== "object") throw new TypeError("Agent event is required");
    if (this.seenAgentEventIds.has(event.eventId)) return { duplicate: true, task: this.get(event.taskId) };
    if (event.schemaVersion !== 3
      || event.collaborationProjectId !== this.project.id
      || event.coordinatorAgentId !== this.project.coordinatorAgentId
      || event.coordinatorEpoch !== this.project.coordinatorEpoch
      || event.groupChatId !== this.project.groupChatId
      || event.githubRepository !== this.project.githubRepository) {
      throw new Error("Agent event does not match the active Collaboration Project authority");
    }
    const task = this.requireTask(event.taskId);
    if (!task.assignment
      || event.requesterAgentId !== this.project.coordinatorAgentId
      || event.executorAgentId !== task.assignment.executorAgentId) {
      throw new Error("Agent event ownership does not match the durable project assignment");
    }
    const actor = { type: "agent", id: event.executorAgentId };
    if (event.kind === "task.accepted") {
      this.requireTask(event.taskId, ["offered"]);
      this.transition(task, "assignment_accepted", "assignment.accepted", actor, {
        landing: event.payload.landing,
        wireEventId: event.eventId,
      });
    } else if (event.kind === "task.progress") {
      this.requireTask(event.taskId, ["assignment_accepted", "running"]);
      if (task.state === "assignment_accepted") {
        this.transition(task, "running", "execution.started", actor, { wireEventId: event.eventId });
      }
      task.lastProgress = requiredString(event.payload.message, "payload.message", 2_000);
      this.touch(task);
      this.appendEvent("execution.progress", task, actor, {
        message: task.lastProgress,
        wireEventId: event.eventId,
      });
    } else if (event.kind === "task.result") {
      this.requireTask(event.taskId, ["assignment_accepted", "running", "changes_requested"]);
      task.resultRevision = Number(task.resultRevision || 0) + 1;
      task.result = {
        summary: requiredString(event.payload.summary, "payload.summary", 12_000),
        git: normalizeGit(event.payload.git, task.assignment.branch),
        evidence: [],
        submittedAt: this.now(),
        submittedByAgentId: event.executorAgentId,
      };
      this.transition(task, "submitted", "execution.submitted", actor, {
        branch: task.result.git.branch,
        commit: task.result.git.commit,
        wireEventId: event.eventId,
      });
    } else if (event.kind === "task.blocked") {
      if (!new Set(["offered", "assignment_accepted", "running", "submitted", "changes_requested"]).has(task.state)) {
        throw new Error(`Task ${task.taskId} cannot be blocked from ${task.state}`);
      }
      task.resumeState = task.state;
      task.reason = requiredString(event.payload.reason, "payload.reason", 2_000);
      this.transition(task, "blocked", "task.blocked", actor, {
        reason: task.reason,
        resumeState: task.resumeState,
        wireEventId: event.eventId,
      });
    } else if (event.kind === "task.rejected") {
      this.requireTask(event.taskId, ["offered"]);
      task.reason = requiredString(event.payload.reason, "payload.reason", 2_000);
      this.transition(task, "rejected", "assignment.rejected", actor, {
        reason: task.reason,
        wireEventId: event.eventId,
      });
    } else {
      throw new Error(`Agent event ${event.kind} is not an executor update for the Coordinator ledger`);
    }
    this.seenAgentEventIds.add(event.eventId);
    while (this.seenAgentEventIds.size > MAX_EVENTS) {
      this.seenAgentEventIds.delete(this.seenAgentEventIds.values().next().value);
    }
    await this.persist();
    return { duplicate: false, task: clone(task) };
  }

  transition(task, state, kind, actor, data = {}) {
    task.state = state;
    this.touch(task);
    this.appendEvent(kind, task, actor, data);
  }

  touch(task) {
    task.updatedAt = this.now();
    task.revision = Number(task.revision || 0) + 1;
  }

  appendEvent(kind, task, actor, data = {}) {
    const event = {
      schemaVersion: 1,
      sequence: this.nextSequence,
      eventId: `project-event:${this.idFactory()}`,
      projectId: this.project.id,
      coordinatorAgentId: this.project.coordinatorAgentId,
      coordinatorEpoch: this.project.coordinatorEpoch,
      kind,
      taskId: task?.taskId,
      actor: clone(actor),
      createdAt: this.now(),
      data: clone(Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))),
    };
    this.nextSequence += 1;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
  }

  requireCoordinator(agentId = this.localAgentId) {
    if (!this.isCoordinator() || agentId !== this.project.coordinatorAgentId) {
      throw new Error("Only the active Project Coordinator may perform this operation");
    }
  }

  requirePm(humanOpenId) {
    this.requireCoordinator();
    if (humanOpenId !== this.project.pmHumanOpenId) throw new Error("Only the configured human PM may perform this operation");
  }

  requireParticipantHuman(humanOpenId) {
    const participant = this.project.participants.find((candidate) => candidate.humanOpenId === humanOpenId);
    if (!participant) throw new Error("Human is not a registered Collaboration Project participant");
    return participant;
  }

  requireParticipantAgent(agentId) {
    if (!AGENT_ID.test(String(agentId || ""))) throw new TypeError("Participant Agent id is invalid");
    const participant = this.project.participants.find((candidate) => candidate.agentId === agentId);
    if (!participant) throw new Error(`Agent ${agentId} is not a registered Collaboration Project participant`);
    return participant;
  }

  requireTask(taskId, states) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown Collaboration Project task ${taskId}`);
    if (states && !states.includes(task.state)) {
      throw new Error(`Task ${taskId} cannot perform this transition from ${task.state}`);
    }
    return task;
  }

  requireExecutor(task, agentId) {
    if (!task.assignment || task.assignment.executorAgentId !== agentId) {
      throw new Error("Only the assigned executor Agent may perform this operation");
    }
  }

  requireReviewer(task, agentId) {
    if (!task.assignment?.reviewerAgentId) throw new Error("An independent technical reviewer must be assigned first");
    if (task.assignment.reviewerAgentId !== agentId) {
      throw new Error("Only the assigned technical reviewer Agent may perform this operation");
    }
    if (task.assignment.executorAgentId === agentId) throw new Error("Technical reviewer must be independent from the executor");
  }

  async persist() {
    const tasks = [...this.tasks.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_TASKS);
    this.tasks = new Map(tasks.map((task) => [task.taskId, task]));
    const snapshot = {
      schemaVersion: 1,
      project: this.project,
      tasks,
      events: this.events,
      seenAgentEventIds: [...this.seenAgentEventIds],
    };
    this.writeTail = this.writeTail.then(() => writeAtomic(this.filePath, snapshot));
    await this.writeTail;
  }
}
