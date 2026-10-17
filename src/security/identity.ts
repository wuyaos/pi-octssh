import crypto from "node:crypto";

/**
 * 连接身份：绑定真实端点而不是别名。
 *
 * ssh_config 把别名重指向别的 HostName/User 后，`identityKey` 必然改变，
 * 因此基于旧身份的信任与授权不会静默继承。
 */
export type SshIdentity = {
  alias: string;
  host: string;
  port: number;
  user: string;
  jump?: { host: string; port: number; user: string };
};

const IDENTITY_KEY_VERSION = "octssh-id-v1";

/**
 * 稳定摘要：同一端点在同一别名下始终得到同一个值，任一组成部分变化即改变。
 */
export function identityKey(identity: SshIdentity): string {
  const jump = identity.jump
    ? `${identity.jump.user}@${identity.jump.host}:${identity.jump.port}`
    : "";
  const payload = [
    IDENTITY_KEY_VERSION,
    identity.alias,
    identity.host,
    String(identity.port),
    identity.user,
    jump,
  ].join("\0");
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  return `${IDENTITY_KEY_VERSION}:${digest}`;
}

/** 供确认弹窗、信任列表与错误信息展示的人读形式。 */
export function displayIdentity(identity: SshIdentity): string {
  const base = `${identity.user}@${identity.host}:${identity.port}`;
  if (!identity.jump) return `${base} (${identity.alias})`;
  return `${base} (${identity.alias}) via ${identity.jump.user}@${identity.jump.host}:${identity.jump.port}`;
}
