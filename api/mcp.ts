/**
 * ClinicDesk MCP on Vercel — the same eleven tools, a different transport.
 *
 * Cloudflare gives each client a Durable Object, so that deployment can hold a
 * session. A Vercel function is a fresh process per request, so this one runs
 * the transport **stateless**: `sessionIdGenerator: undefined` means no session
 * id is issued and none is validated, and a new server is constructed for each
 * request. That is legal Streamable HTTP and every MCP client handles it; it
 * only rules out server-initiated messages, which none of these tools send.
 *
 * Web-standard Request/Response throughout, which is also what the Worker uses
 * underneath — so the two deployments differ in about fifteen lines.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { INSTRUCTIONS, SERVER_INFO, registerTools } from '../src/tools';
import type { Env } from '../src/clinic';

export const config = { runtime: 'nodejs' };

export default async function handler(request: Request): Promise<Response> {
	const env = process.env as unknown as Env;
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
		// Fail loudly rather than answering every tool call with a type error.
		return Response.json({ error: 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_KEY' }, { status: 500 });
	}

	const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
	registerTools(server, env);

	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		// Plain JSON rather than an SSE stream: a serverless function is billed for
		// the time a stream stays open, and none of these tools push to the client.
		enableJsonResponse: true,
	});
	await server.connect(transport);

	const response = await transport.handleRequest(request);
	// The request is finished; nothing is reused across invocations.
	void server.close();
	return response;
}
