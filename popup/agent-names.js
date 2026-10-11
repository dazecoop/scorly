// MCP clientInfo names → what the user calls the app. Shared by the popup's
// agent strip and the AI agents settings page.
const SCORLY_AGENT_CLIENT_NAMES = [
  [/^claude-code$/i, 'Claude Code'],
  [/^claude-ai$|claude desktop/i, 'Claude Desktop'],
  [/cursor/i, 'Cursor'],
  [/visual studio code|vscode|copilot/i, 'VS Code'],
  [/^scorly-cli$/i, 'Scorly CLI'],
];

function scorlyAgentAppName(name) {
  const hit = SCORLY_AGENT_CLIENT_NAMES.find(([re]) => re.test(name));
  return hit ? hit[1] : name;
}
