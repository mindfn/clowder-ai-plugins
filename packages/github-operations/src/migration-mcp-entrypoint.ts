import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';
import { createRemoteMigrationMcpServer } from './tracking-mcp-server.js';

const server = createRemoteMigrationMcpServer(createModuleActionClient());
await server.connect(new StdioServerTransport());
