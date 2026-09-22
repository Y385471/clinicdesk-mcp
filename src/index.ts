/**
 * ClinicDesk MCP on Cloudflare Workers.
 *
 * Transport only: Streamable HTTP at /mcp (spec revision 2025-11-25), with one
 * Durable Object per client session so a conversation keeps its state. The
 * tools themselves live in src/tools.ts and are shared with the Vercel
 * deployment in api/mcp.ts.
 *
 * Routes:
 *   /        a real page, because an MCP URL pasted into a browser is a 404
 *   /mcp     the endpoint
 *   /health  plain JSON heartbeat
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { INSTRUCTIONS, SERVER_INFO, registerTools } from './tools';
import type { Env } from './clinic';
import LANDING_HTML from '../public/index.html';

export class ClinicDeskMCP extends McpAgent<Env> {
	server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

	async init() {
		registerTools(this.server, this.env);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === '/mcp') {
			return ClinicDeskMCP.serve('/mcp').fetch(request, env, ctx);
		}
		if (url.pathname === '/health') {
			return Response.json({ ok: true, server: 'clinicdesk', transport: 'streamable-http', endpoint: '/mcp' });
		}
		if (url.pathname === '/') {
			return new Response(LANDING_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
		}
		return new Response('Not found. The MCP endpoint is /mcp.', { status: 404 });
	},
};
