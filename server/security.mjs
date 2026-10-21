import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = v => createHash('sha256').update(v).digest('hex');
export const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const bots = /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|CCBot|Google-Extended|Bytespider|Amazonbot|PerplexityBot|Perplexity-User|cohere-ai|Diffbot|FacebookBot|meta-externalagent|AI2Bot|Applebot-Extended|scrapy|wget|python-requests/i;
export function sign(payload, secret, seconds = 300) {
  const body = Buffer.from(JSON.stringify({...payload, exp: Math.floor(Date.now()/1000)+seconds, nonce: token()})).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function verify(value, secret, purpose) {
  const [body, mac, extra] = (value || '').split('.');
  if (!body || !mac || extra || !equal(createHmac('sha256',secret).update(body).digest('base64url'), mac)) throw Object.assign(new Error('無効な権限です'),{statusCode:401});
  const p = JSON.parse(Buffer.from(body,'base64url').toString());
  if (p.purpose !== purpose || !Number.isFinite(p.exp) || p.exp <= Date.now()/1000) throw Object.assign(new Error('権限の有効期限が切れています'),{statusCode:401});
  return p;
}
export const fail = (statusCode,message) => { throw Object.assign(new Error(message),{statusCode}); };
export function rangeHeader(header,size) {
  if (!header) return {start:0,end:size-1,status:200};
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : Math.max(0,size-Number(m[2]));
  let end = m[1] && m[2] ? Math.min(Number(m[2]),size-1) : size-1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return {start,end,status:206};
}
