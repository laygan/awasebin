import test from 'node:test';
import assert from 'node:assert/strict';
import {token,hash,sign,verify,equal,bots,rangeHeader} from '../server/security.mjs';
import {config} from '../server/config.mjs';
test('tokens are unique 256-bit capabilities; only hashes are persisted',()=>{const values=new Set(Array.from({length:1000},token));assert.equal(values.size,1000);for(const t of values){assert.match(t,/^[\w-]{43}$/);assert.match(hash(t),/^[a-f0-9]{64}$/);}});
test('peer capability refuses tampering, wrong purpose, expired and wrong signing key',()=>{
 const secret='a'.repeat(64),t=sign({purpose:'peer',albumId:'one'},secret);
 assert.equal(verify(t,secret,'peer').albumId,'one');
 for(const [value,key,purpose] of [[t,'b'.repeat(64),'peer'],[t,secret,'upload'],[t+'x',secret,'peer'],['invalid',secret,'peer'],[sign({purpose:'peer'},secret,-1),secret,'peer']])assert.throws(()=>verify(value,key,purpose));
});
test('constant-time equality safely rejects malformed values',()=>{assert.equal(equal('abc','abc'),true);assert.equal(equal('abc','xyz'),false);assert.equal(equal(undefined,'abc'),false);assert.equal(equal('a','あ'),false);});
test('range downloads support resume, suffixes and clamping without accepting multiple ranges',()=>{
 assert.deepEqual(rangeHeader(undefined,100),{start:0,end:99,status:200});
 assert.deepEqual(rangeHeader('bytes=20-',100),{start:20,end:99,status:206});
 assert.deepEqual(rangeHeader('bytes=-20',100),{start:80,end:99,status:206});
 assert.deepEqual(rangeHeader('bytes=30-200',100),{start:30,end:99,status:206});
 for(const header of ['bytes=100-','bytes=9-2','bytes=-0','bytes=1-2,3-4','bytes=-','items=0-1','bytes=99999999999999999999-'])assert.equal(rangeHeader(header,100),null);
});
test('identified AI clients are denied while ordinary browsers pass',()=>{for(const ua of ['GPTBot/1.0','ChatGPT-User','ClaudeBot','Claude-User','OAI-SearchBot','Perplexity-User','Bytespider','python-requests/2'])assert.ok(bots.test(ua));assert.equal(bots.test('Mozilla/5.0 Chrome/140.0 Safari/537.36'),false);});
const env={TOKEN_SECRET:'a'.repeat(64),INTERNAL_SECRET:'b'.repeat(64),ORIGIN:'http://localhost:5173',RP_ID:'localhost'};
test('production config refuses insecure origin, reused secrets and mismatched RP',()=>{
 assert.equal(config(env).p2p,false);
 assert.throws(()=>config({...env,NODE_ENV:'production'}));
 assert.throws(()=>config({...env,INTERNAL_SECRET:env.TOKEN_SECRET}));
 assert.throws(()=>config({...env,RP_ID:'example.com'}));
 assert.throws(()=>config({...env,MAX_ALBUM_BYTES:'NaN'}));
 assert.throws(()=>config({...env,TOKEN_SECRET:'REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS'}));
});
