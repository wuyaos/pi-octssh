import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { discoverHostAliases } from "../ssh/config/hosts.ts";

export function completeOctsshArguments(prefix: string): AutocompleteItem[] | null {
  const trimmed = prefix.trim();
  const trailingSpace = /\s$/.test(prefix);
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  const fragment = trailingSpace ? "" : (parts.pop() ?? "");
  let choices: [string, string][] = [];
  if (!parts.length) {
    choices = [["allow-all", "本会话免确认"], ["trust", "主机密钥"], ["permissions", "项目权限"], ["tasks", "任务与通知"], ["credentials", "凭据管理"]];
  } else if (parts.length === 1) {
    switch (parts[0]) {
      case "allow-all":
        // 配置读取失败只影响建议，不能在编辑输入时抛错或发起连接。
        try { choices = discoverHostAliases().map((host) => [host, "SSH 主机"]); }
        catch { return null; }
        break;
      case "trust": choices = [["forget", "移除主机密钥记录"]]; break;
      case "permissions": choices = [["remove", "移除规则（后接规则 ID）"]]; break;
      case "tasks": choices = [["wake", "自动唤醒开关"]]; break;
      case "credentials": choices = [["clear", "清除内存凭据"]]; break;
    }
  } else if (parts.length === 2 && (parts[0] === "allow-all" || (parts[0] === "tasks" && parts[1] === "wake"))) {
    choices = [["on", "开启"], ["off", "关闭"]];
  }
  const items = choices.filter(([value]) => value.startsWith(fragment)).map(([value, description]) => ({
    value: [...parts, value].join(" "), label: value, description,
  }));
  return items.length ? items : null;
}
