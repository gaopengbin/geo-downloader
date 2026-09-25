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
    if (typeof raw !== 'string' || raw.length > 2048) return false;
    const uri = new URL(raw);
    if (uri.username || uri.password || uri.hash) return false;
    if (uri.protocol === 'https:') return true;
    if (uri.protocol === 'http:') return ['127.0.0.1', '[::1]', 'localhost'].includes(uri.hostname);
    // RFC 7591 also permits application-specific redirects for native clients.
    return /^[a-z][a-z0-9+.-]*:$/.test(uri.protocol) &&
      !['about:', 'blob:', 'chrome:', 'data:', 'edge:', 'file:', 'ftp:', 'javascript:', 'ws:', 'wss:'].includes(uri.protocol);
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
  const page = (txId, clientName) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>授权 GeoD MCP</title>
<style>body{font:16px system-ui,sans-serif;background:#f7f8fa;color:#17212b;max-width:440px;margin:5vh auto;padding:24px}main{background:white;padding:28px;border:1px solid #ddd;border-radius:14px}h1{font-size:24px}label{display:block;margin:14px 0 6px;font-weight:600}input,button{box-sizing:border-box;width:100%;padding:12px;margin:6px 0;border:1px solid #bbb;border-radius:8px;font:inherit}button{background:#164c88;color:white;cursor:pointer}button:disabled{opacity:.6}.sub{background:#fff;color:#164c88}small,#passwordHelp{color:#556}#passwordHelp{margin:2px 0 10px;font-size:14px}#message{min-height:24px;color:#9b2226}</style>
<main><h1>授权 GeoD MCP</h1><p><strong>${escapeHtml(clientName)}</strong> 请求调用 GeoD 的规划、下载与成果读取工具。每个账号每天最多 3 次下载任务。</p>
<label for="email">邮箱</label><input id="email" type="email" placeholder="请输入邮箱" autocomplete="email">
<label for="password">密码</label><input id="password" type="password" placeholder="请输入密码" autocomplete="current-password" maxlength="128">
<p id="passwordHelp" hidden>注册密码为 8–128 个字符。</p>
<div id="login"><button id="loginBtn">登录并授权</button><button id="registerBtn" class="sub">注册账号</button></div>
<div id="register" hidden><button id="codeBtn" class="sub">发送邮箱验证码</button><label for="code">邮箱验证码</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位数字"><button id="createBtn">注册并授权</button><button id="backBtn" class="sub">返回登录</button></div>
<p id="message" role="status" aria-live="polite"></p><small>授权后将返回你的 Agent。GeoD 不保存你的账号密码；授权令牌只用于 GeoD MCP。</small></main><script>
const tx=${JSON.stringify(txId)},api='/geod-mcp/oauth/account/';let challengeId='';const $=id=>document.getElementById(id),msg=t=>$('message').textContent=t;
const errorText={INVALID_EMAIL:'请输入有效的邮箱地址。',INVALID_PASSWORD:'密码须为 8–128 个字符。',INVALID_CREDENTIALS:'邮箱或密码不正确，请检查后重试。',LOGIN_RATE_LIMIT:'登录尝试过多，请 15 分钟后再试。',VERIFICATION_INVALID:'验证码错误、已过期或已使用，请重新获取。',VERIFICATION_RATE_LIMIT:'验证码发送太频繁，请稍后再试。',VERIFICATION_SEND_FAILED:'验证码发送失败，请稍后重试。',ACCOUNT_ALREADY_REGISTERED:'该邮箱已注册，请返回登录；忘记密码请联系支持。',ACCOUNT_NOT_FOUND:'该邮箱尚未注册，请先注册。',AUTH_REQUIRED:'登录状态已失效，请重新登录。',IDENTITY_ALREADY_BOUND:'该邮箱或手机号已绑定其他账号。',ACCOUNT_UNAVAILABLE:'账号服务暂时不可用，请稍后重试。',temporarily_unavailable:'账号服务暂时不可用，请稍后重试。',invalid_request:'授权页面已过期，请从 Codex 重新发起登录。'};
function email(){const value=$('email').value.trim();if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value))throw Error(errorText.INVALID_EMAIL);return value}
async function post(url,data,method='POST'){let r;try{r=await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(data),credentials:'same-origin'})}catch{throw Error('网络连接失败，请检查网络后重试。')}let j;try{j=await r.json()}catch{throw Error('服务器响应异常，请稍后重试。')}if(!r.ok){const code=j.error?.code||j.error;throw Error(errorText[code]||(r.status>=500?'服务暂时不可用，请稍后重试。':'操作失败，请检查输入后重试。'))}return j}
async function approve(){const j=await post('/geod-mcp/oauth/approve',{transaction:tx});location.assign(j.redirect)}
async function run(fn){msg('处理中…');const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await fn()}catch(e){msg(e.message)}finally{buttons.forEach(b=>b.disabled=false)}}
$('loginBtn').onclick=()=>run(async()=>{const address=email();if(!$('password').value)throw Error('请输入密码。');await post(api+'login',{email:address,password:$('password').value});await approve()});
$('registerBtn').onclick=()=>{$('login').hidden=true;$('register').hidden=false;$('passwordHelp').hidden=false;$('password').autocomplete='new-password';msg('')};
$('backBtn').onclick=()=>{$('register').hidden=true;$('login').hidden=false;$('passwordHelp').hidden=true;$('password').autocomplete='current-password';msg('')};
$('codeBtn').onclick=()=>run(async()=>{const j=await post(api+'verification',{channel:'email',target:email(),purpose:'register'});challengeId=j.challengeId;msg('验证码已发送，请查收邮箱。验证码 5 分钟内有效。')});
$('createBtn').onclick=()=>run(async()=>{const address=email();if(!challengeId)throw Error('请先发送验证码。');if($('password').value.length<8||$('password').value.length>128)throw Error(errorText.INVALID_PASSWORD);if(!/^\\d{6}$/.test($('code').value.trim()))throw Error('请输入邮件中的 6 位验证码。');await post(api+'verification',{channel:'email',target:address,purpose:'register',challengeId,code:$('code').value.trim(),password:$('password').value},'PUT');await approve()});
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
    if (pathname === '/oauth/session' && req.method === 'GET') {
      const bearer = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{32,})$/)?.[1];
      const userId = bearer && validate(bearer);
      if (!userId) { error(res, 401, 'invalid_token', 'GeoD login required'); return true; }
      json(res, 200, { authenticated: true });
      return true;
    }
    if (pathname === '/oauth/register' && req.method === 'POST') {
      try {
        const input = await body(req);
        const reject = (code, reason) => {
          console.warn(`[geod-mcp] OAuth client registration rejected: ${reason}`);
          return error(res, 400, code, reason);
        };
        if (Object.keys(state.clients).length >= 1000) return reject('invalid_client_metadata', 'Client registration limit reached');
        if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 5) return reject('invalid_client_metadata', 'Expected 1 to 5 redirect URIs');
        if (!input.redirect_uris.every(validRedirect)) return reject('invalid_redirect_uri', 'Redirect URI must use HTTPS, a local HTTP loopback, or an application-specific scheme');
        if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') return reject('invalid_client_metadata', 'Only public clients with token_endpoint_auth_method none are supported');
        const clientId = secret();
        state.clients[clientId] = { name: String(input.client_name || 'Agent client').slice(0, 100), redirectUris: input.redirect_uris, created: now() };
        await save();
        json(res, 201, { client_id: clientId, client_name: state.clients[clientId].name, redirect_uris: input.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
      } catch {
        console.warn('[geod-mcp] OAuth client registration rejected: malformed request');
        error(res, 400, 'invalid_client_metadata', 'Invalid client registration request');
      }
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
