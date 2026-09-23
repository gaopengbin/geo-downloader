import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const challengeFor = value => createHash('sha256').update(value).digest('base64url');
const secret = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const error = (res, status, code, description) => json(res, status, { error: code, error_description: description });
const validRedirect = raw => {
  try {
    const uri = new URL(raw);
    return !uri.username && !uri.password && !uri.hash && (uri.protocol === 'https:' ||
      (uri.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(uri.hostname)));
  } catch { return false; }
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
async function body(req, form = false) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 32768) throw new Error('request body too large');
  }
  return form ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
}

export async function createOAuth({ file, publicHost, accountApi = 'https://geod.laogao.xyz/api/account' }) {
  const issuer = `https://${publicHost}/geod-mcp`;
  const resource = `${issuer}/mcp`;
  const metadataUrl = `https://${publicHost}/.well-known/oauth-protected-resource/geod-mcp/mcp`;
  const accountUrl = new URL(accountApi);
  if (accountUrl.pathname !== '/api/account' || accountUrl.search || accountUrl.hash || accountUrl.username || accountUrl.password ||
    !(accountUrl.href === 'https://geod.laogao.xyz/api/account' ||
      (accountUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(accountUrl.hostname))))
    throw new Error('GEOD_ACCOUNT_API_URL must point to the GeoD account API');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let state = { clients: {}, transactions: {}, codes: {}, access: {}, refresh: {}, usage: {} };
  try { state = { ...state, ...JSON.parse(await readFile(file, 'utf8')) }; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  let pending = Promise.resolve();
  const save = () => {
    pending = pending.catch(() => {}).then(async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, file);
    });
    return pending;
  };
  // The previous hosted release issued tokens from an unrelated product's account database.
  // Keep registered Agent clients, but never accept or refresh those legacy tokens.
  if (state.identityProvider !== 'geod-studio-v1') {
    Object.assign(state, { identityProvider: 'geod-studio-v1', transactions: {}, codes: {}, access: {}, refresh: {}, usage: {} });
    await save();
  }
  const clean = () => {
    const time = now();
    for (const key of ['transactions', 'codes', 'access', 'refresh'])
      for (const [id, item] of Object.entries(state[key])) if (item.expires <= time) delete state[key][id];
    for (const [id, item] of Object.entries(state.usage)) if (item.date < new Date(Date.now() - 86400000).toISOString().slice(0, 10)) delete state.usage[id];
  };
  const validate = token => {
    const entry = state.access[digest(token || '')];
    return entry && entry.expires > now() && entry.resource === resource ? entry.userId : null;
  };
  const countJob = async userId => {
    const date = new Date().toISOString().slice(0, 10);
    const current = state.usage[userId];
    if (current?.date === date && current.count >= 3) throw Object.assign(new Error('Daily hosted GeoD job limit reached (3). Try again tomorrow.'), { code: 'DAILY_LIMIT' });
    state.usage[userId] = { date, count: current?.date === date ? current.count + 1 : 1 };
    await save();
  };
  const page = (txId, clientName) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>授权 GeoD MCP</title><style>body{font:16px system-ui,sans-serif;background:#f7f8fa;color:#17212b;max-width:440px;margin:5vh auto;padding:24px}main{background:white;padding:28px;border:1px solid #ddd;border-radius:14px}h1{font-size:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border:1px solid #bbb;border-radius:8px;font:inherit}button{background:#164c88;color:white;cursor:pointer}button:disabled{opacity:.6}.sub{background:#fff;color:#164c88}small{color:#556}#message{min-height:24px;color:#9b2226}</style><main><h1>授权 GeoD MCP</h1><p><strong>${escapeHtml(clientName)}</strong> 请求调用 GeoD 的规划、下载与成果读取工具。每个账号每天最多 3 次下载任务。</p><input id="email" type="email" placeholder="邮箱" autocomplete="email"><input id="password" type="password" placeholder="密码" autocomplete="current-password" minlength="12"><div id="login"><button id="loginBtn">登录并授权</button><button id="registerBtn" class="sub">注册账号</button></div><div id="register" hidden><button id="codeBtn" class="sub">发送邮箱验证码</button><input id="code" inputmode="numeric" placeholder="邮箱验证码"><button id="createBtn">注册并授权</button><button id="backBtn" class="sub">返回登录</button></div><p id="message" role="status"></p><small>授权后将返回你的 Agent。GeoD 不保存你的账号密码；授权令牌只用于 GeoD MCP。</small></main><script>
const tx=${JSON.stringify(txId)},api='/geod-mcp/oauth/account/';let challengeId='';const $=id=>document.getElementById(id),msg=t=>$('message').textContent=t;
async function post(url,data,method='POST'){const r=await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(data),credentials:'same-origin'});const j=await r.json();if(!r.ok)throw Error(j.error?.message||j.error_description||'请求失败');return j}
async function approve(){const j=await post('/geod-mcp/oauth/approve',{transaction:tx});location.assign(j.redirect)}
async function run(fn){msg('处理中…');try{await fn()}catch(e){msg(e.message)}}
$('loginBtn').onclick=()=>run(async()=>{await post(api+'login',{email:$('email').value,password:$('password').value});await approve()});
$('registerBtn').onclick=()=>{$('login').hidden=true;$('register').hidden=false;msg('')};$('backBtn').onclick=()=>{$('register').hidden=true;$('login').hidden=false;msg('')};
$('codeBtn').onclick=()=>run(async()=>{const j=await post(api+'verification',{channel:'email',target:$('email').value,purpose:'register'});challengeId=j.challengeId;msg('验证码已发送，请查收邮箱')});
$('createBtn').onclick=()=>run(async()=>{if(!challengeId)throw Error('请先发送验证码');await post(api+'verification',{channel:'email',target:$('email').value,purpose:'register',challengeId,code:$('code').value,password:$('password').value},'PUT');await approve()});
</script></html>`;

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (pathname === '/oauth/account/login' && req.method === 'POST' ||
        pathname === '/oauth/account/verification' && ['POST', 'PUT'].includes(req.method)) {
      if (req.headers.origin !== `https://${publicHost}` && !String(req.headers.host || '').startsWith('127.0.0.1:')) {
        error(res, 403, 'access_denied', 'Invalid origin'); return true;
      }
      try {
        const input = await body(req);
        const upstream = await fetch(`${accountUrl.href}${pathname.slice('/oauth/account'.length)}`, {
          method: req.method,
          headers: {
            'content-type': 'application/json', origin: accountUrl.origin, 'sec-fetch-site': 'same-origin',
            'x-forwarded-for': String(req.headers['x-real-ip'] || req.socket.remoteAddress || '127.0.0.1'),
          },
          body: JSON.stringify(input), signal: AbortSignal.timeout(10000),
        });
        const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
        const cookie = upstream.headers.getSetCookie().find(value => value.startsWith('geostyle_session='));
        if (cookie) headers['set-cookie'] = cookie.replace(/; Path=\/([;]|$)/i, '; Path=/geod-mcp/oauth/$1');
        res.writeHead(upstream.status, headers);
        res.end(await upstream.text());
      } catch { error(res, 503, 'temporarily_unavailable', 'GeoD account service unavailable'); }
      return true;
    }
    if (pathname === '/.well-known/oauth-protected-resource/geod-mcp/mcp' && req.method === 'GET') {
      json(res, 200, { resource, authorization_servers: [issuer], scopes_supported: ['geod:tools'], bearer_methods_supported: ['header'] }); return true;
    }
    if (pathname === '/.well-known/oauth-authorization-server/geod-mcp' && req.method === 'GET') {
      json(res, 200, { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['geod:tools'] }); return true;
    }
    if (pathname === '/oauth/register' && req.method === 'POST') {
      try {
        const input = await body(req);
        if (Object.keys(state.clients).length >= 1000 || !Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 5 || !input.redirect_uris.every(validRedirect) || input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') return error(res, 400, 'invalid_client_metadata', 'Invalid public client redirect URIs');
        const clientId = secret();
        state.clients[clientId] = { name: String(input.client_name || 'Agent client').slice(0, 100), redirectUris: input.redirect_uris, created: now() };
        await save();
        json(res, 201, { client_id: clientId, client_name: state.clients[clientId].name, redirect_uris: input.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
      } catch { error(res, 400, 'invalid_client_metadata', 'Invalid client registration'); }
      return true;
    }
    if (pathname === '/oauth/authorize' && req.method === 'GET') {
      clean();
      if (Object.keys(state.transactions).length >= 1000) { error(res, 429, 'temporarily_unavailable', 'Too many pending authorizations'); return true; }
      const q = url.searchParams, client = state.clients[q.get('client_id')];
      const redirect = q.get('redirect_uri'), challenge = q.get('code_challenge');
      if (!client || !client.redirectUris.includes(redirect) || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge || '') || q.get('resource') !== resource || !q.get('state') || (q.get('scope') && q.get('scope') !== 'geod:tools')) { error(res, 400, 'invalid_request', 'Invalid OAuth authorization request'); return true; }
      const transaction = secret();
      state.transactions[digest(transaction)] = { clientId: q.get('client_id'), redirect, challenge, state: q.get('state'), expires: now() + 600 };
      await save();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      res.end(page(transaction, client.name)); return true;
    }
    if (pathname === '/oauth/approve' && req.method === 'POST') {
      if (req.headers.origin !== `https://${publicHost}` && !String(req.headers.host || '').startsWith('127.0.0.1:')) { error(res, 403, 'access_denied', 'Invalid origin'); return true; }
      try {
        const input = await body(req), tx = state.transactions[digest(input.transaction || '')];
        if (!tx || tx.expires <= now()) { error(res, 400, 'invalid_request', 'Authorization page expired'); return true; }
        const session = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => /^geostyle_session=[A-Za-z0-9_-]{43}$/.test(item));
        if (!session) { error(res, 401, 'access_denied', 'Sign in with a GeoD account'); return true; }
        const profile = await fetch(accountUrl, { headers: { cookie: session }, signal: AbortSignal.timeout(5000) });
        const value = await profile.json();
        if (!profile.ok || !/^user-[a-f0-9-]{36}$/i.test(value.user?.id || '')) { error(res, 401, 'access_denied', 'GeoD account login is invalid'); return true; }
        delete state.transactions[digest(input.transaction)];
        const code = secret();
        state.codes[digest(code)] = { ...tx, userId: value.user.id, resource, expires: now() + 300 };
        await save();
        const redirect = new URL(tx.redirect); redirect.searchParams.set('code', code); redirect.searchParams.set('state', tx.state);
        json(res, 200, { redirect: redirect.href });
      } catch { error(res, 503, 'temporarily_unavailable', 'Account verification unavailable'); }
      return true;
    }
    if (pathname === '/oauth/token' && req.method === 'POST') {
      try {
        clean();
        const input = await body(req, true), client = state.clients[input.client_id];
        if (!client || input.resource !== resource) { error(res, 400, 'invalid_request', 'Unknown client or resource'); return true; }
        let userId;
        if (input.grant_type === 'authorization_code') {
          const record = state.codes[digest(input.code || '')];
          if (!record || record.expires <= now() || record.clientId !== input.client_id || record.redirect !== input.redirect_uri || challengeFor(input.code_verifier || '') !== record.challenge) { error(res, 400, 'invalid_grant', 'Code or PKCE verifier is invalid'); return true; }
          userId = record.userId; delete state.codes[digest(input.code)];
        } else if (input.grant_type === 'refresh_token') {
          const record = state.refresh[digest(input.refresh_token || '')];
          if (!record || record.expires <= now() || record.clientId !== input.client_id) { error(res, 400, 'invalid_grant', 'Refresh token is invalid'); return true; }
          userId = record.userId; delete state.refresh[digest(input.refresh_token)];
        } else { error(res, 400, 'unsupported_grant_type', 'Unsupported grant'); return true; }
        const access = secret(), refresh = secret();
        state.access[digest(access)] = { userId, resource, expires: now() + 3600 };
        state.refresh[digest(refresh)] = { userId, clientId: input.client_id, expires: now() + 30 * 86400 };
        await save();
        json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'geod:tools' });
      } catch { error(res, 400, 'invalid_request', 'Invalid token request'); }
      return true;
    }
    return false;
  }
  return { handle, validate, countJob, resource, metadataUrl };
}
