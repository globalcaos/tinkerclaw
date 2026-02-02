import { html, nothing } from "lit";
import type { ToolCard } from "../types/chat-types";
import { icons } from "../icons";
import { formatToolDetail, resolveToolDisplay } from "../tool-display";
import { TOOL_INLINE_THRESHOLD } from "./constants";
import { extractTextCached } from "./message-extract";
import { isToolResultMessage } from "./message-normalizer";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") continue;
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({ kind: "result", name, text });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

/**
 * Security level classification for exec commands
 */
type SecurityLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

const SECURITY_LEVELS: Record<SecurityLevel, { emoji: string; label: string; desc: string }> = {
  safe: { emoji: '🟢', label: 'SAFE', desc: 'Read-only information gathering' },
  low: { emoji: '🔵', label: 'LOW', desc: 'Project file modifications' },
  medium: { emoji: '🟡', label: 'MEDIUM', desc: 'Configuration or dependency changes' },
  high: { emoji: '🟠', label: 'HIGH', desc: 'System-level changes' },
  critical: { emoji: '🔴', label: 'CRITICAL', desc: 'Potential data loss or security risk' },
};

const COMMAND_PATTERNS: Record<SecurityLevel, string[]> = {
  critical: [
    'sudo', 'rm -rf', 'rm -fr', 'mkfs', 'dd if=', 'dd of=', 'shred',
    'chmod 777 -R', 'shutdown', 'reboot', 'halt', 'poweroff', 'kill -9 -1',
    'DROP TABLE', 'DROP DATABASE', 'TRUNCATE', 'curl | sh', 'curl | bash'
  ],
  high: [
    'systemctl start', 'systemctl stop', 'systemctl restart', 'systemctl enable',
    'apt install', 'apt remove', 'apt purge', 'apt upgrade', 'apt-get install',
    'brew install', 'brew uninstall', 'dnf install', 'pacman -S',
    'npm install -g', 'pip install --user', 'useradd', 'userdel', 'usermod',
    'chown -R', 'chmod -R', 'ufw', 'iptables', 'crontab', 'mount', 'umount'
  ],
  medium: [
    'npm install', 'npm update', 'pnpm install', 'pnpm add', 'yarn install', 'yarn add',
    'pip install', 'pip3 install', 'composer install', 'bundle install', 'gem install',
    'go get', 'cargo add', 'git push', 'git pull', 'git merge', 'git rebase', 'git reset',
    'docker run', 'docker exec', 'docker build', 'docker stop', 'kubectl apply',
    'chmod', 'chown', 'ln -s', 'make install', 'ssh', 'scp', 'rsync'
  ],
  low: [
    'touch', 'mkdir', 'cp', 'mv', 'rm', 'rmdir', 'git add', 'git commit', 'git stash',
    'git checkout', 'git branch', 'git switch', 'echo >', 'cat >', 'tee', 'sed -i',
    'make', 'npm run', 'pnpm run', 'yarn run', 'node', 'python', 'python3',
    'tar', 'unzip', 'zip', 'gzip'
  ],
  safe: [
    'ls', 'll', 'la', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'find',
    'which', 'whereis', 'type', 'pwd', 'cd', 'whoami', 'id', 'groups', 'date', 'cal',
    'uptime', 'uname', 'hostname', 'echo', 'printf', 'env', 'printenv', 'man', 'help',
    '--help', '--version', '-v', '-V', 'file', 'stat', 'wc', 'du', 'df', 'free',
    'top', 'htop', 'ps', 'netstat', 'ss', 'ip addr', 'ping', 'dig', 'nslookup',
    'git status', 'git log', 'git diff', 'git show', 'git branch -l', 'git remote',
    'npm list', 'npm view', 'npm outdated', 'pip list', 'pip show',
    'docker ps', 'docker images', 'docker logs', 'tree', 'jq', 'sort', 'diff'
  ]
};

const LEVEL_ORDER: SecurityLevel[] = ['critical', 'high', 'medium', 'low', 'safe'];

function classifyCommand(cmd: string): SecurityLevel {
  const lower = cmd.trim().toLowerCase();
  for (const level of LEVEL_ORDER) {
    for (const pattern of COMMAND_PATTERNS[level]) {
      if (lower.includes(pattern.toLowerCase())) {
        return level;
      }
    }
  }
  return 'medium';
}

/**
 * Compact one-line tool card renderer
 */
export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());
  const canClick = Boolean(onOpenSidebar);
  
  const handleClick = canClick
    ? () => {
        if (hasText) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*No output — tool completed successfully.*`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isExec = card.name === 'exec' || card.name === 'bash';
  const command = detail || display.label;
  const level = isExec ? classifyCommand(command) : 'medium';
  const levelInfo = SECURITY_LEVELS[level];
  
  const isError = card.text?.toLowerCase().includes('error') || 
                  card.text?.toLowerCase().includes('failed') ||
                  card.text?.includes('exited with code');
  
  const statusIcon = isError ? '✗' : '✓';

  return html`
    <div
      class="chat-tool-compact chat-tool-compact--${level} ${canClick ? "chat-tool-compact--clickable" : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${canClick ? (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick?.(); } } : nothing}
    >
      <span class="chat-tool-compact__icon">${levelInfo.emoji}</span>
      <span class="chat-tool-compact__status">${statusIcon}</span>
      <span class="chat-tool-compact__cmd">${command}</span>
      <span class="chat-tool-compact__sep">│</span>
      <span class="chat-tool-compact__level">${levelInfo.label}</span>
      <span class="chat-tool-compact__sep">│</span>
      <span class="chat-tool-compact__desc">${levelInfo.desc}</span>
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  return undefined;
}
