import { identityKey, type SshIdentity } from "./identity.ts";

/** 只在扩展会话内存中持有；不参与 deny 裁决，仅决定是否代替用户确认。 */
export class SessionApproval {
  private grants = new Map<string, { project: string; identity: SshIdentity }>();
  private key(project: string, identity: SshIdentity) { return `${project}:${identityKey(identity)}`; }
  enable(project: string, identity: SshIdentity) {
    this.grants.set(this.key(project, identity), { project, identity });
  }
  allows(project: string | undefined, identity: SshIdentity): boolean {
    return !!project && this.grants.has(this.key(project, identity));
  }
  disable(project: string, alias: string) {
    for (const [key, grant] of this.grants) {
      if (grant.project === project && grant.identity.alias === alias) this.grants.delete(key);
    }
  }
  aliases(project: string) {
    return [...new Set([...this.grants.values()].filter((g) => g.project === project).map((g) => g.identity.alias))];
  }
  clear() { this.grants.clear(); }
}
