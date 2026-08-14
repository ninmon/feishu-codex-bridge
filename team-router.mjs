export function classifyInboundMessage(msg, config, localBotOpenId = config.agent.botOpenId) {
  if (!msg || msg.rawContentType !== "text") return { kind: "ignore", reason: "non_text" };
  const senderIsBot = msg.senderIsBot === true || msg.senderType === "bot";

  if (msg.chatType === "p2p") {
    if (senderIsBot) return { kind: "ignore", reason: "bot_dm" };
    const allowedDmHumans = config.collaboration.projectId
      ? [config.agent.ownerOpenId]
      : config.agent.allowedHumanOpenIds;
    if (!allowedDmHumans.includes(msg.senderId)) {
      return { kind: "ignore", reason: "untrusted_human" };
    }
    return { kind: "human", scope: "dm" };
  }

  if (msg.chatType !== "group" && msg.chatType !== "topic") {
    return { kind: "ignore", reason: "unsupported_chat" };
  }
  if (!config.collaboration.enabled) return { kind: "ignore", reason: "collaboration_disabled" };
  const isSharedGroup = config.collaboration.groupChatId === msg.chatId;
  const isControlGroup = config.collaboration.controlGroupChatId === msg.chatId;
  if (!isSharedGroup && !isControlGroup) {
    return { kind: "ignore", reason: "untrusted_group" };
  }
  if (msg.mentionAll) return { kind: "ignore", reason: "mention_all" };

  if (isControlGroup) {
    if (senderIsBot) return { kind: "ignore", reason: "bot_control_group" };
    if (msg.senderId !== config.agent.ownerOpenId) return { kind: "ignore", reason: "untrusted_human" };
    return {
      kind: "human",
      scope: "control",
      addressedBy: msg.mentionedBot ? "mention" : "owner-message",
    };
  }

  if (senderIsBot) {
    if (!msg.mentionedBot) return { kind: "ignore", reason: "not_mentioned" };
    if (localBotOpenId && msg.senderId === localBotOpenId) {
      return { kind: "ignore", reason: "self_message" };
    }
    const peer = config.collaboration.trustedPeers.find(
      (candidate) => candidate.enabled && candidate.botOpenId === msg.senderId,
    );
    if (!peer) return { kind: "ignore", reason: "untrusted_peer" };
    return { kind: "peer", scope: "shared", peer };
  }

  const sharedHumanOpenIds = config.collaboration.participants
    ? config.collaboration.participants.filter(({ enabled }) => enabled !== false).map(({ humanOpenId }) => humanOpenId)
    : config.agent.allowedHumanOpenIds;
  if (!sharedHumanOpenIds.includes(msg.senderId)) {
    return { kind: "ignore", reason: "untrusted_human" };
  }
  if (msg.mentionedBot) return { kind: "human", scope: "shared", addressedBy: "mention" };
  if (config.collaboration.groupHumanMessageMode === "owner" && msg.senderId === config.agent.ownerOpenId) {
    return { kind: "human", scope: "shared", addressedBy: "owner-message" };
  }
  return { kind: "ignore", reason: "not_mentioned" };
}
