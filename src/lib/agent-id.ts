export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && value.length === 30 && /^agt_[A-Z2-7]{26}$/.test(value);
}

export function maskAgentId(agentId: string): string {
  return `${agentId.slice(0, 10)}...${agentId.slice(-5)}`;
}
