# Collaboration Project v1

本版本在个人 Session Relay 上方增加多人项目协调层。它不会把共享群直接绑定到某个写代码的 Session，也不会让 PM 或其他 Agent 操纵成员机器上的本地路径。

## Bot 数量

若项目有 `N` 位成员：

- 保留每个人现有的 CLI Bot，继续负责一个群对应一个 Codex Session。
- 新增 `N` 个协作 Bot，每个人一个。
- 不新增独立的 PM Bot。人类 PM 的协作 Bot 同时担任唯一 active Coordinator。
- PM 转移时，Coordinator 角色和递增的 `epoch` 一起转给新 PM 的协作 Bot。

因此，单人开发测试只需比当前版本多一个协作 Bot。正式两人协作时需要两个新增协作 Bot。

CLI Bot 和协作 Bot 应使用不同的飞书应用身份及不同的 Bridge 实例。一个 `bridge.config.json` 只连接一个应用和一种运行模式；不要让同一 Bot 身份同时被 Session Relay 和 Project Agent 两个进程消费事件。

## 三类群

| 群 | 成员 | 作用 |
|---|---|---|
| `{Project}/协作` | 所有人类和所有协作 Bot | 需求、计划审批、任务分配、审查、PM 验收与发布 |
| `{Project}/{成员}/控制` | 成员、成员协作 Bot、成员 CLI Bot | 私人接单、选择 Session/worktree、处理本地阻塞 |
| `{Project}/{Session}` | 成员和 CLI Bot | 现有 Session Relay 的 Prompt、进度、最终答案和附件 |

共享群中只有真实 `@协作 Bot` 才会调用对应 Agent。个人控制群中，owner 的普通消息可以直接到达自己的协作 Agent。Bot-to-Bot 消息必须是真实提及、来自注册 Bot，并携带匹配的 Project、Repository、Coordinator 和 epoch。

## Coordinator Session

Coordinator 是 Bridge 中的确定性角色，不是 Codex Session 本身。项目身份、审批、任务状态和事件台账保存在 Bridge 的持久状态中。

人类 PM 另外准备一个长期存在的 Codex Session，用于理解自然语言、整理任务、提出验收标准和识别风险：

1. 在 PM 本机绑定的 Bridge Project 默认分支上创建一个空白 Session。
2. 建议命名为 `{Project}/Coordinator`。
3. 在 PM 的个人控制群中用 `/threads`、`/use` 选中它。
4. 发送 `/collab bind-current`。

Bridge 只允许把默认分支上的只读 Session 绑定为 Coordinator Session，并且无论普通沙箱设置如何，该 Session 始终以 `read-only` 运行。改名不影响绑定；归档或删除后，选择另一个只读 Session 再执行 `/collab bind-current`。

Coordinator Session 只负责建议。它不能直接把自己输出的文字视为已批准、已分配、已验收或已发布；所有状态变化必须经过确定性的 `/collab` 操作、已认证 Agent 事件或对应人类身份。

## 审批生命周期

```text
draft
  -> awaiting_plan_approval
  -> approved
  -> offered
  -> assignment_accepted
  -> running
  -> submitted
  -> verifying
  -> ready_for_pm
  -> result_accepted
  -> published
  -> closed
```

辅助状态为 `blocked`、`changes_requested`、`rejected` 和 `cancelled`。

- 人类 PM批准计划、接受最终结果并批准发布。
- Coordinator 建立台账、分配任务、跟踪事件、核验远端 Git 并更新项目文件。
- executor 只能接受和执行分配给自己的任务。
- reviewer 必须不同于 executor；PM/Coordinator 自己执行的任务也必须由其他成员独立审查。
- `published` 只表示结果 SHA 已在绑定远端核验且已向团队发布，不等于自动合并受保护分支。

## Git 和本地落点

Coordinator 派发任务时读取远端默认分支的精确完整 SHA，同时指定新的目标任务分支。接收端：

1. 验证群、Project、Repository、Bot、Coordinator 和 epoch。
2. 精确 fetch 默认分支 SHA。
3. 在目标任务分支创建或验证独立 worktree。
4. 按本地 `manual`、`recommend` 或 `auto` 策略选择已有 Session、新 Session 或新 worktree。
5. 完成后要求 worktree 干净，以非 force push 发布结果。

PM、Coordinator 和发送方都不能指定接收机器的绝对路径或 Codex thread ID。

## 项目文件

项目文件同步是显式可选功能。先由人类在飞书云空间准备一个已经对协作群可见的文件夹，然后把 folder token 只写入本机私有配置：

```json
"documents": {
  "enabled": true,
  "folderToken": "fldcn_pre_shared_project_folder",
  "identity": "user",
  "profile": "default"
}
```

Bridge 不会自动创建文件夹或扩大共享权限。只有 active Coordinator 写入：

```text
COLLAB-{ProjectId}-STATUS.md
COLLAB-{ProjectId}-LEDGER.md
HANDOFF-{TaskId}-{FromAgent}-TO-{ToAgent}-R{Revision}.md
```

`STATUS` 和 `LEDGER` 使用固定文件并覆盖更新；Handoff 一经创建不可覆盖，修改必须产生新的 revision。Ledger 只镜像状态转换元数据，不包含 Prompt 正文、隐藏思维链、本机路径、Session ID 或凭据。上传失败不会回滚任务状态；Bridge 会记录失败并周期性按当前权威台账重试。

## 命令

```text
/collab
/collab tasks
/collab coordinator
/collab bind-current
/collab unbind

/collab task <标题> | <目标> | <验收标准1>; <验收标准2>
/collab submit-plan <taskId> [说明]
/collab approve-plan <taskId> [说明]
/collab reject-plan <taskId> <原因>
/collab assign <taskId> <executorAgentId> <branch> <reviewerAgentId>
/collab review-start <taskId>
/collab review-pass <taskId> <检查项1>; <检查项2>
/collab changes <taskId> <原因>
/collab accept-result <taskId> [说明]
/collab publish <taskId> [GitHub PR URL 或说明]
/collab close <taskId> [说明]
/collab cancel <taskId> <原因>
```

任务变更命令只能在共享协作群执行；Coordinator Session 的绑定和解绑由人类 PM 执行。每次派发都必须同时指定一个与 executor 不同的独立 Reviewer。收到任务的成员继续在自己的个人控制群使用 `/team-options`、`/team-accept` 和 `/team-reject` 选择本地落点。

## 配置一致性

所有成员必须配置完全相同的：

- `collaboration.projectId`
- `collaboration.groupChatId`
- `collaboration.githubRepository`
- `collaboration.coordinatorAgentId`
- `collaboration.coordinatorEpoch`
- 参与者 Human/Bot/Agent 身份表

各成员可以不同的内容只有本地 Bridge Project ID、repo/worktree 绝对路径、个人控制群、Coordinator Session 绑定和本地自动化策略。参考 [bridge.config.collaboration.example.json](../bridge.config.collaboration.example.json)。
