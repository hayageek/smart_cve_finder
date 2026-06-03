import { config } from '../config.js';
import { MCP_TOOL_NAMES } from '../mcp/server.js';

const API_KEY_PLACEHOLDER = '${env:MCP_API_KEY}';

function resolveMcpAuthBearer(): string {
  const key = config.MCP_API_KEY?.trim();
  return key ? key : API_KEY_PLACEHOLDER;
}

export function resolveMcpPublicBaseUrl(): string {
  if (config.MCP_PUBLIC_URL) return config.MCP_PUBLIC_URL.replace(/\/$/, '');
  const host = config.API_HOST === '0.0.0.0' ? 'localhost' : config.API_HOST;
  return `http://${host}:${config.API_PORT}`;
}

export function buildMcpConfigPayload() {
  const publicBaseUrl = resolveMcpPublicBaseUrl();
  const mcpPath = config.MCP_PATH.startsWith('/') ? config.MCP_PATH : `/${config.MCP_PATH}`;
  const mcpUrl = `${publicBaseUrl}${mcpPath}`;
  const serverName = config.MCP_SERVER_NAME;
  const authBearer = resolveMcpAuthBearer();

  const cursorConfig = {
    mcpServers: {
      [serverName]: {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${authBearer}`,
        },
      },
    },
  };

  const claudeDesktopConfig = {
    mcpServers: {
      [serverName]: {
        command: 'npx',
        args: [
          '-y',
          'mcp-remote',
          mcpUrl,
          '--header',
          `Authorization: Bearer ${authBearer}`,
        ],
      },
    },
  };

  return {
    enabled: config.MCP_ENABLED,
    apiKeyConfigured: Boolean(config.MCP_API_KEY),
    publicBaseUrl,
    mcpPath,
    mcpUrl,
    serverName,
    tools: [...MCP_TOOL_NAMES],
    cursor: cursorConfig,
    claudeDesktop: claudeDesktopConfig,
    cursorJson: JSON.stringify(cursorConfig, null, 2),
    claudeJson: JSON.stringify(claudeDesktopConfig, null, 2),
    setupSteps: {
      cursor: [
        'Copy the Cursor JSON below (includes MCP_API_KEY when configured in the API .env).',
        'Paste into ~/.cursor/mcp.json or your project .cursor/mcp.json.',
        'Open Cursor Settings → Features → Model Context Protocol and reload the server.',
      ],
      claude: [
        'Install/use mcp-remote via npx (included in the generated config).',
        'Copy the Claude JSON below (includes MCP_API_KEY when configured in the API .env).',
        'Paste into claude_desktop_config.json (see paths in the UI).',
        'Restart Claude Desktop. For cloud Claude, the API must be publicly reachable.',
      ],
    },
  };
}
