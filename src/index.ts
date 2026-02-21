import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { currentWeatherTool } from './tools/current-weather.js';
import { forecastTool } from './tools/forecast.js';
import { metarTool } from './tools/metar.js';
import { astronomyTool } from './tools/astronomy.js';
import { airQualityTool } from './tools/air-quality.js';
import { sourceStatusTool } from './tools/source-status.js';

const server = new McpServer({
  name: 'weather',
  version: '1.0.0',
});

const tools = [
  currentWeatherTool,
  forecastTool,
  metarTool,
  astronomyTool,
  airQualityTool,
  sourceStatusTool,
];

for (const tool of tools) {
  server.tool(tool.name, tool.description, tool.schema, tool.handler);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Weather Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
