export function GET(): Response {
	return Response.json({ ok: true, server: 'clinicdesk', transport: 'streamable-http', endpoint: '/mcp' });
}
