/**
 * 权限策略（需求 6.4）：
 * - 默认 YOLO 模式：工人/调度中心的所有权限请求一律自动批准并记录，不打断使用者。
 * - 极少数灾难性操作在任何模式下都硬性拦截（固定规则判断，不依赖大模型）：
 *   1) 格式化磁盘  2) 删除项目目录以外的系统目录或用户主目录  3) 修改系统启动与安全设置
 * - 分级询问模式：除只读操作外（写文件、删除、安装、联网下载、杀进程等）弹出决策卡片。
 *
 * 规则均为字符串/正则匹配，可在设置中心查看（需求 6.8）。
 */

export type Verdict = "allow" | "ask" | "block";

export interface Rule {
  id: string;
  label: string; // 设置中心展示的中文说明
  test: RegExp;
}

/** 硬性拦截清单（灾难性操作，YOLO 也拦）。 */
export const HARD_BLOCK_RULES: Rule[] = [
  {
    id: "format-disk",
    label: "格式化磁盘 / 写入裸设备",
    // 注意：结尾不能用 \b —— "format C:" 以冒号结尾、"shutdown /r" 以空格+斜杠结尾时
    // 冒号/空格都是非单词字符，\b 永远不成立，导致漏拦（已用 A6 用例覆盖）
    test: new RegExp(
      [
        "format(\\.com)?\\s+[a-zA-Z]:",
        "mkfs(\\.\\w+)?(\\s|$)",
        "diskpart",
        "fdisk\\s+/dev/",
        "dd\\s+[^|;]*\\bof=/dev/(sd[a-z]+|nvme\\w*|hd[a-z]+|vd[a-z]+|disk\\w*|mapper/\\w+)",
      ].join("|"),
      "i"
    ),
  },
  {
    id: "rm-system",
    label: "删除系统目录 / 用户主目录 / 根目录",
    test: new RegExp(
      [
        "rm\\s+[^;|&]*(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)",
        "(del|rd|rmdir)(\\s+/[sqr]+)*\\s+[^&|]*([cC]:\\\\(Windows|Program Files|Users|ProgramData)|%SystemRoot%|%USERPROFILE%)",
        "rm\\s+[^;|&]*(-\\S+\\s+)*(\\/|\\/\\*|\\/~|~\\/\\*|\\/home|\\/root|\\/usr|\\/etc|\\/var|\\/bin|\\/sbin|\\/boot|\\/lib|\\/opt|\\/dev|\\/proc|\\/sys)(\\s|\\/\\*|$)",
        "\\$(HOME|USERPROFILE)\\b[^;|&]*(rm\\s)",
        "Remove-Item\\s+[^|;]*([cC]:\\\\(Windows|Program Files|Users)|\\$env:(SystemRoot|USERPROFILE))",
      ].join("|"),
      "i"
    ),
  },
  {
    id: "boot-security",
    label: "修改系统启动与安全设置",
    // 同上：结尾用 (?![a-zA-Z]) 而不是 \b，避免 "shutdown /r" 这类后跟非单词字符时漏拦
    test: /\b(bcdedit|bootrec|reg(\.exe)?\s+add\s+HKLM\\(SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run|SYSTEM\\CurrentControlSet)|Set-MpPreference|Add-MpPreference|netsh\s+(advfirewall|firewall)|systemctl\s+(disable|mask)\s+(ssh|firewalld|ufw|iptables)|ufw\s+disable|shutdown(\.exe)?(\s|$)|reboot|poweroff)(?![a-zA-Z])/i,
  },
];

/** 分级询问清单（graded 模式下需要决策卡片的操作）。 */
export const ASK_RULES: Rule[] = [
  { id: "delete-file", label: "删除文件 / 目录", test: /(^|\s|")(rm|rmdir|del|rd|erase|Remove-Item|ri)\s/i },
  { id: "install-software", label: "安装软件 / 依赖", test: /(^|\s|")(npm|pnpm|yarn|pip|pip3|conda|choco|winget|apt|apt-get|brew|nuget)\s+(i|install|add)\b/i },
  { id: "download-exec", label: "联网下载并执行", test: /(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)[^|;&]*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)/i },
  { id: "kill-process", label: "结束进程 / 服务", test: /(^|\s|")(taskkill|kill|killall|pkill|Stop-Process)\b/i },
  { id: "change-perms", label: "修改文件权限 / 所有者", test: /(^|\s|")(chmod|chown|icacls|takeown|Set-ExecutionPolicy)\b/i },
  { id: "git-push", label: "git push（对外发布）", test: /\bgit\s+push\b/i },
];

/** YOLO 模式下这些操作也会被记录为「自动批准」（用于右栏自动处理记录）。 */
export function classifyCommand(command: string, mode: "yolo" | "graded"): { verdict: Verdict; rule?: Rule } {
  const cmd = command.replace(/\\r|\\n/g, " ");
  for (const rule of HARD_BLOCK_RULES) {
    if (rule.test.test(cmd)) return { verdict: "block", rule };
  }
  if (mode === "yolo") {
    // YOLO：除硬拦截外全部自动批准
    const askRule = ASK_RULES.find((r) => r.test.test(cmd));
    return { verdict: "allow", rule: askRule }; // rule 仅用于记录类别
  }
  for (const rule of ASK_RULES) {
    if (rule.test.test(cmd)) return { verdict: "ask", rule };
  }
  return { verdict: "allow" };
}

/** 自动处理记录：每次自动批准/拦截都追加一条（需求 5.3.5、6.4）。 */
export interface PolicyRecord {
  time: string;
  mode: "yolo" | "graded";
  verdict: Verdict;
  action: string;
  ruleId?: string;
  ruleLabel?: string;
}

export class PolicyLedger {
  records: PolicyRecord[] = [];

  record(mode: "yolo" | "graded", verdict: Verdict, action: string, rule?: Rule): PolicyRecord {
    const rec: PolicyRecord = {
      time: new Date().toISOString(),
      mode,
      verdict,
      action,
      ruleId: rule?.id,
      ruleLabel: rule?.label,
    };
    this.records.push(rec);
    if (this.records.length > 1000) this.records.shift();
    return rec;
  }

  /** 供设置中心展示的规则清单。 */
  static describe(): { hardBlock: { id: string; label: string }[]; ask: { id: string; label: string }[] } {
    return {
      hardBlock: HARD_BLOCK_RULES.map((r) => ({ id: r.id, label: r.label })),
      ask: ASK_RULES.map((r) => ({ id: r.id, label: r.label })),
    };
  }
}
