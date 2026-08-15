import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const DAILY_EXPORT_LIMIT = 10
const FOLLOW_BONUS_EXPORTS = 20
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const FOLLOW_CODE_LIFETIME_MS = 15 * 60 * 1000
const FOLLOW_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function accountError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function one(database, sql, parameters = []) {
  const statement = database.prepare(sql)
  try {
    statement.bind(parameters)
    return statement.step() ? statement.getAsObject() : null
  } finally {
    statement.free()
  }
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase()
}

function validateRegistration(input) {
  const email = normalizeEmail(input?.email)
  const password = String(input?.password ?? '')
  const displayName = String(input?.display_name ?? '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    throw accountError(400, 'invalid_email', '请输入有效邮箱')
  }
  if (password.length < 8 || password.length > 72) {
    throw accountError(400, 'invalid_password', '密码长度需为 8 到 72 个字符')
  }
  if (displayName.length < 1 || displayName.length > 32) {
    throw accountError(400, 'invalid_display_name', '昵称长度需为 1 到 32 个字符')
  }
  return { email, password, displayName }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function followCode() {
  const bytes = randomBytes(8)
  const part = (offset) => Array.from(bytes.subarray(offset, offset + 4), value =>
    FOLLOW_CODE_ALPHABET[value % FOLLOW_CODE_ALPHABET.length]).join('')
  return `LG-${part(0)}-${part(4)}`
}

async function passwordHash(password, salt) {
  return Buffer.from(await scrypt(password, salt, 64)).toString('hex')
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
  }
}

function chinaDay(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function initializeAccounts(database) {
  database.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      bonus_exports INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS account_sessions_user_idx ON account_sessions(user_id);
    CREATE TABLE IF NOT EXISTS export_usage (
      user_id TEXT NOT NULL,
      usage_day TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, usage_day),
      FOREIGN KEY(user_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS export_actions (
      action_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS account_redemptions (
      user_id TEXT NOT NULL,
      campaign TEXT NOT NULL,
      redeemed_at TEXT NOT NULL,
      PRIMARY KEY(user_id, campaign),
      FOREIGN KEY(user_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS wechat_followers (
      openid_hash TEXT PRIMARY KEY,
      subscribed_at TEXT NOT NULL,
      last_interaction_at TEXT NOT NULL,
      unsubscribed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS wechat_follow_codes (
      openid_hash TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      redeemed_by TEXT,
      redeemed_at TEXT,
      FOREIGN KEY(redeemed_by) REFERENCES accounts(id) ON DELETE SET NULL
    );
  `)
}

export function createAccountService(database, serializedWrite) {
  function quota(userId) {
    const day = chinaDay()
    const row = one(database, `
      SELECT accounts.bonus_exports,
        COALESCE(export_usage.used_count, 0) AS daily_used
      FROM accounts
      LEFT JOIN export_usage
        ON export_usage.user_id = accounts.id AND export_usage.usage_day = ?
      WHERE accounts.id = ?
    `, [day, userId])
    if (!row) throw accountError(404, 'account_not_found', '账户不存在')
    const dailyUsed = Number(row.daily_used)
    const bonus = Number(row.bonus_exports)
    return {
      daily_limit: DAILY_EXPORT_LIMIT,
      daily_used: dailyUsed,
      daily_remaining: Math.max(0, DAILY_EXPORT_LIMIT - dailyUsed),
      bonus_remaining: bonus,
      total_remaining: Math.max(0, DAILY_EXPORT_LIMIT - dailyUsed) + bonus,
      resets_at: `${day}T16:00:00.000Z`,
    }
  }

  function createSession(userId) {
    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    database.run(
      'INSERT INTO account_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [hashToken(token), userId, now.toISOString(), new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString()],
    )
    return token
  }

  return {
    async register(input) {
      const { email, password, displayName } = validateRegistration(input)
      const salt = randomBytes(16).toString('hex')
      const hash = await passwordHash(password, salt)
      return serializedWrite(() => {
        if (one(database, 'SELECT id FROM accounts WHERE email = ?', [email])) {
          throw accountError(409, 'email_exists', '该邮箱已注册')
        }
        const id = randomUUID()
        const now = new Date().toISOString()
        database.run(`
          INSERT INTO accounts (id, email, display_name, password_hash, password_salt, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, email, displayName, hash, salt, now, now])
        const token = createSession(id)
        return { token, user: publicUser(one(database, 'SELECT * FROM accounts WHERE id = ?', [id])), quota: quota(id) }
      })
    },

    async login(input) {
      const email = normalizeEmail(input?.email)
      const password = String(input?.password ?? '')
      const row = one(database, 'SELECT * FROM accounts WHERE email = ?', [email])
      const attempted = await passwordHash(password, row?.password_salt ?? randomBytes(16).toString('hex'))
      if (!row || !safeEqual(attempted, row.password_hash)) {
        throw accountError(401, 'invalid_credentials', '邮箱或密码不正确')
      }
      return serializedWrite(() => {
        const token = createSession(row.id)
        return { token, user: publicUser(row), quota: quota(row.id) }
      })
    },

    authenticate(token) {
      if (!token) throw accountError(401, 'authentication_required', '请先登录')
      const row = one(database, `
        SELECT accounts.*, account_sessions.expires_at
        FROM account_sessions
        JOIN accounts ON accounts.id = account_sessions.user_id
        WHERE account_sessions.token_hash = ?
      `, [hashToken(token)])
      if (!row || Date.parse(row.expires_at) <= Date.now()) {
        throw accountError(401, 'invalid_session', '登录状态已失效，请重新登录')
      }
      return publicUser(row)
    },

    profile(token) {
      const user = this.authenticate(token)
      return { user, quota: quota(user.id) }
    },

    logout(token) {
      return serializedWrite(() => {
        if (token) database.run('DELETE FROM account_sessions WHERE token_hash = ?', [hashToken(token)])
        return { ok: true }
      })
    },

    consume(token, actionId) {
      const user = this.authenticate(token)
      if (!/^[0-9a-f-]{36}$/i.test(String(actionId ?? ''))) {
        throw accountError(400, 'invalid_action_id', '导出请求标识无效')
      }
      return serializedWrite(() => {
        const existing = one(database, 'SELECT source FROM export_actions WHERE action_id = ? AND user_id = ?', [actionId, user.id])
        if (existing) return { consumed: false, source: existing.source, quota: quota(user.id) }
        const current = quota(user.id)
        const day = chinaDay()
        let source
        database.run('BEGIN TRANSACTION')
        try {
          if (current.daily_remaining > 0) {
            database.run(`
              INSERT INTO export_usage (user_id, usage_day, used_count) VALUES (?, ?, 1)
              ON CONFLICT(user_id, usage_day) DO UPDATE SET used_count = used_count + 1
            `, [user.id, day])
            source = 'daily'
          } else if (current.bonus_remaining > 0) {
            database.run('UPDATE accounts SET bonus_exports = bonus_exports - 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), user.id])
            source = 'bonus'
          } else {
            throw accountError(402, 'quota_exhausted', '今日免费额度已用完')
          }
          database.run('INSERT INTO export_actions (action_id, user_id, source, created_at) VALUES (?, ?, ?, ?)', [actionId, user.id, source, new Date().toISOString()])
          database.run('COMMIT')
        } catch (error) {
          database.run('ROLLBACK')
          throw error
        }
        return { consumed: true, source, quota: quota(user.id) }
      })
    },

    recordWechatFollow(openid, subscribed = true) {
      const openidHash = hashToken(String(openid ?? ''))
      const now = new Date().toISOString()
      return serializedWrite(() => {
        if (subscribed) {
          database.run(`
            INSERT INTO wechat_followers (openid_hash, subscribed_at, last_interaction_at, unsubscribed_at)
            VALUES (?, ?, ?, NULL)
            ON CONFLICT(openid_hash) DO UPDATE SET
              subscribed_at = excluded.subscribed_at,
              last_interaction_at = excluded.last_interaction_at,
              unsubscribed_at = NULL
          `, [openidHash, now, now])
        } else {
          database.run(`
            UPDATE wechat_followers SET unsubscribed_at = ?, last_interaction_at = ?
            WHERE openid_hash = ?
          `, [now, now, openidHash])
        }
        return { ok: true }
      })
    },

    issueFollowCode(openid) {
      if (!String(openid ?? '').trim()) throw accountError(400, 'invalid_openid', '微信用户标识无效')
      const openidHash = hashToken(String(openid))
      const code = followCode()
      const now = new Date()
      const expiresAt = new Date(now.getTime() + FOLLOW_CODE_LIFETIME_MS)
      return serializedWrite(() => {
        database.run(`
          INSERT INTO wechat_followers (openid_hash, subscribed_at, last_interaction_at, unsubscribed_at)
          VALUES (?, ?, ?, NULL)
          ON CONFLICT(openid_hash) DO UPDATE SET
            last_interaction_at = excluded.last_interaction_at,
            unsubscribed_at = NULL
        `, [openidHash, now.toISOString(), now.toISOString()])
        database.run(`
          INSERT INTO wechat_follow_codes (
            openid_hash, code_hash, created_at, expires_at, redeemed_by, redeemed_at
          ) VALUES (?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(openid_hash) DO UPDATE SET
            code_hash = excluded.code_hash,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at,
            redeemed_by = NULL,
            redeemed_at = NULL
        `, [openidHash, hashToken(code), now.toISOString(), expiresAt.toISOString()])
        return { code, expires_at: expiresAt.toISOString() }
      })
    },

    redeem(token, submittedCode) {
      const user = this.authenticate(token)
      const normalizedCode = String(submittedCode ?? '').trim().toUpperCase()
      if (!/^LG-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalizedCode)) {
        throw accountError(400, 'invalid_redeem_code', '兑换码格式不正确')
      }
      return serializedWrite(() => {
        if (one(database, 'SELECT 1 AS found FROM account_redemptions WHERE user_id = ? AND campaign = ?', [user.id, 'wechat-follow-v1'])) {
          throw accountError(409, 'already_redeemed', '该账户已领取过关注奖励')
        }
        const codeHash = hashToken(normalizedCode)
        const issued = one(database, `
          SELECT code_hash FROM wechat_follow_codes
          WHERE code_hash = ? AND redeemed_by IS NULL AND expires_at > ?
        `, [codeHash, new Date().toISOString()])
        if (!issued) throw accountError(400, 'invalid_redeem_code', '兑换码无效或已过期，请重新回复“额度”获取')
        const now = new Date().toISOString()
        database.run('BEGIN TRANSACTION')
        try {
          database.run(`
            UPDATE wechat_follow_codes SET redeemed_by = ?, redeemed_at = ?
            WHERE code_hash = ? AND redeemed_by IS NULL
          `, [user.id, now, codeHash])
          if (database.getRowsModified() !== 1) {
            throw accountError(409, 'code_already_used', '该兑换码已被使用')
          }
          database.run('INSERT INTO account_redemptions (user_id, campaign, redeemed_at) VALUES (?, ?, ?)', [user.id, 'wechat-follow-v1', now])
          database.run('UPDATE accounts SET bonus_exports = bonus_exports + ?, updated_at = ? WHERE id = ?', [FOLLOW_BONUS_EXPORTS, now, user.id])
          database.run('COMMIT')
        } catch (error) {
          database.run('ROLLBACK')
          throw error
        }
        return { granted: FOLLOW_BONUS_EXPORTS, quota: quota(user.id) }
      })
    },
  }
}

export const accountLimits = {
  dailyExports: DAILY_EXPORT_LIMIT,
  followBonusExports: FOLLOW_BONUS_EXPORTS,
}
