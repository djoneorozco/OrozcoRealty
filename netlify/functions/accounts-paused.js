// Old clients receive an explicit retirement response. No database connection is made.
export default async () => Response.json({ ok: false, code: 'accounts_paused', error: 'Accounts and saved profiles are paused. Ask Elena is available without signing in.', chat: '/ask-elena' }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
