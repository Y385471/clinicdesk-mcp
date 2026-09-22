export const config = { runtime: 'nodejs' };

export default function handler(): Response {
	return Response.json({ ok: true, server: 'clinicdesk', transport: 'streamable-http', endpoint: '/mcp' });
}
