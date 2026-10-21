import path from 'node:path';
export function config(env = process.env) {
  const number = (key, fallback) => { const n = Number(env[key] ?? fallback); if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${key}`); return n; };
  const production = env.NODE_ENV === 'production';
  const origin = env.ORIGIN || 'http://localhost:5173';
  const secret = key => { const v = env[key]; if (!v || v.length < 32 || v.startsWith('REPLACE_')) throw new Error(`${key}: set an independent random secret (32+ characters)`); return v; };
  if (production && !origin.startsWith('https://')) throw new Error('HTTPS ORIGIN required');
  const c = { production, origin, rpID: env.RP_ID || 'localhost', host: env.HOST || '127.0.0.1', port: number('PORT', 3000),
    databaseURL: env.DATABASE_URL, root: path.resolve(env.DATA_ROOT || './data'), tokenSecret: secret('TOKEN_SECRET'), internalSecret: secret('INTERNAL_SECRET'),
    trackerURL: env.TRACKER_URL || 'ws://localhost:3002/tracker', seederURL: env.SEEDER_URL || 'http://127.0.0.1:3001',
    trackerPort: number('TRACKER_PORT',3002), seederPort: number('SEEDER_PORT',3001), p2p: env.P2P_ENABLED === 'true', p2pAllowed:env.P2P_ENABLED === 'true',
    stun: (env.STUN_URLS || '').split(',').filter(Boolean), maxAlbum: number('MAX_ALBUM_BYTES', 200 * 1024 ** 3),
    budget: number('STORAGE_BUDGET_BYTES',2 * 1024 ** 4), maxUploads: number('MAX_UPLOADS',2), maxPeers: number('MAX_PEERS',10),
    retention: number('RETENTION_DAYS',7), sessionSeconds: number('SESSION_SECONDS',3600), contact: env.CONTACT || '' };
  if (c.tokenSecret === c.internalSecret) throw new Error('Secrets must differ');
  if (new URL(origin).hostname !== c.rpID && !new URL(origin).hostname.endsWith(`.${c.rpID}`)) throw new Error('RP_ID must match ORIGIN');
  if (production && !c.trackerURL.startsWith('wss://')) throw new Error('WSS tracker required');
  return c;
}
