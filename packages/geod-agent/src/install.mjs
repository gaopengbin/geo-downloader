import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_URL = 'https://laogao.xyz/geod-mcp/mcp';
export const MCP_NAME = 'geod-cloud';
const root = fileURLToPath(new URL('../', import.meta.url));
const skillSource = path.join(root, 'skill', 'geod-agent', 'SKILL.md');
const legacySources = ['geod-agent-0.1.0.md', 'geod-agent-0.1.2.md'].map(name => path.join(root, 'legacy', name));

function normalized(content) { return content.replace(/\r\n/g, '\n').trimEnd(); }
function backup(file) {
  const backupPath = `${file}.backup-geod-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  copyFileSync(file, backupPath);
  return backupPath;
}

export function skillUpdatePlan(destination) {
  const target = path.join(destination, 'SKILL.md');
  const incoming = normalized(readFileSync(skillSource, 'utf8'));
  if (!existsSync(destination)) return { target, action: 'create' };
  if (!existsSync(target)) throw new Error(`A different geod-agent directory already exists: ${destination}`);
  const current = normalized(readFileSync(target, 'utf8'));
  if (current === incoming) return { target, action: 'keep' };
  if (legacySources.some(file => current === normalized(readFileSync(file, 'utf8')))) return { target, action: 'upgrade' };
  throw new Error(`A modified GeoD Skill already exists at ${target}. Review it before replacing it.`);
}

export function installSkill(plan) {
  if (plan.action === 'keep') return { path: plan.target, action: 'kept' };
  mkdirSync(path.dirname(plan.target), { recursive: true });
  const previous = plan.action === 'upgrade' ? backup(plan.target) : undefined;
  writeFileSync(plan.target, readFileSync(skillSource));
  if (normalized(readFileSync(plan.target, 'utf8')) !== normalized(readFileSync(skillSource, 'utf8'))) throw new Error('GeoD Skill verification failed.');
  return { path: plan.target, action: plan.action === 'upgrade' ? 'upgraded' : 'installed', ...(previous ? { backup: previous } : {}) };
}

function defaultRunCodex(args, env) {
  if (args.join(' ') !== 'mcp list --json') throw new Error('Unsupported Codex CLI invocation.');
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'codex mcp list --json'], { encoding: 'utf8', env, windowsHide: true })
    : spawnSync('codex', args, { encoding: 'utf8', env });
  if (result.error) throw new Error(`Could not run Codex CLI: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function codexServers(runCodex, env) {
  const result = runCodex(['mcp', 'list', '--json'], env);
  if (result.status !== 0) throw new Error(`Could not inspect Codex MCP servers: ${result.stderr.trim() || 'unknown error'}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('Codex MCP list did not return JSON.'); }
  const servers = Array.isArray(parsed) ? parsed : parsed?.servers;
  if (!Array.isArray(servers)) throw new Error('Codex MCP list has an unexpected format.');
  return servers;
}

export function installCodex({ home = os.homedir(), env = process.env, runCodex = defaultRunCodex } = {}) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  const skillPlan = skillUpdatePlan(path.join(codexHome, 'skills', 'geod-agent'));
  const existing = codexServers(runCodex, env).find(server => server.name === MCP_NAME);
  const existingUrl = existing?.transport?.url || existing?.url;
  if (existing && existingUrl !== MCP_URL) throw new Error(`Codex already has a different ${MCP_NAME} MCP registration.`);
  const configPath = path.join(codexHome, 'config.toml');
  let configBackup;
  if (!existing) {
    const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    if (/^\s*\[mcp_servers\.(?:"geod-cloud"|geod-cloud)\]/m.test(current)) throw new Error('Codex config already declares geod-cloud but the CLI could not read it.');
    if (existsSync(configPath)) configBackup = backup(configPath);
    const temporary = `${configPath}.geod-${process.pid}.tmp`;
    writeFileSync(temporary, `${current.trimEnd()}${current.trim() ? '\n\n' : ''}[mcp_servers.geod-cloud]\nurl = "${MCP_URL}"\n`, 'utf8');
    renameSync(temporary, configPath);
  }
  try {
    const readback = codexServers(runCodex, env).find(server => server.name === MCP_NAME);
    if ((readback?.transport?.url || readback?.url) !== MCP_URL) throw new Error('Codex MCP registration verification failed.');
  } catch (error) {
    if (!existing) {
      if (configBackup) copyFileSync(configBackup, configPath);
      else unlinkSync(configPath);
    }
    throw error;
  }
  return { client: 'codex', mcp: { name: MCP_NAME, url: MCP_URL, config: configPath, action: existing ? 'kept' : 'added', ...(configBackup ? { backup: configBackup } : {}) }, skill: installSkill(skillPlan), next: 'Open a new Codex session, run `codex mcp login geod-cloud` if prompted, and authorize with your own GeoD account.' };
}

export function installWorkBuddy({ home = os.homedir() } = {}) {
  const configPath = path.join(home, '.workbuddy', 'mcp.json');
  const skillPlan = skillUpdatePlan(path.join(home, '.agents', 'skills', 'geod-agent'));
  let config = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw new Error(`WorkBuddy MCP config is not valid JSON: ${configPath}`); }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('WorkBuddy MCP config must be a JSON object.');
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) throw new Error('WorkBuddy mcpServers must be a JSON object.');
  const servers = config.mcpServers || {};
  const existing = servers[MCP_NAME];
  if (existing && (existing.url !== MCP_URL || !['http', 'streamableHttp', 'streamable-http'].includes(existing.type))) throw new Error(`WorkBuddy already has a different ${MCP_NAME} MCP registration.`);
  let configBackup;
  if (!existing) {
    mkdirSync(path.dirname(configPath), { recursive: true });
    if (existsSync(configPath)) configBackup = backup(configPath);
    config.mcpServers = { ...servers, [MCP_NAME]: { type: 'streamableHttp', url: MCP_URL } };
    const temporary = `${configPath}.geod-${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    renameSync(temporary, configPath);
  }
  const readback = JSON.parse(readFileSync(configPath, 'utf8'))?.mcpServers?.[MCP_NAME];
  if (readback?.url !== MCP_URL) throw new Error('WorkBuddy MCP registration verification failed.');
  return { client: 'workbuddy', mcp: { name: MCP_NAME, url: MCP_URL, config: configPath, action: existing ? 'kept' : 'added', ...(configBackup ? { backup: configBackup } : {}) }, skill: installSkill(skillPlan), next: 'Open a new WorkBuddy session and authorize with your own GeoD account when prompted.' };
}

export function detectClient({ home = os.homedir(), env = process.env } = {}) {
  if (env.CODEX_HOME && !existsSync(path.join(home, '.workbuddy'))) return 'codex';
  const codex = Boolean(env.CODEX_HOME || existsSync(path.join(home, '.codex')));
  const workbuddy = existsSync(path.join(home, '.workbuddy'));
  if (codex && !workbuddy) return 'codex';
  if (workbuddy && !codex) return 'workbuddy';
  throw new Error('Cannot choose the current Agent automatically. Run `geod-agent install codex` or `geod-agent install workbuddy`.');
}

export function install({ client, home = os.homedir(), env = process.env, runCodex } = {}) {
  const selected = client || detectClient({ home, env });
  if (selected === 'codex') return installCodex({ home, env, runCodex });
  if (selected === 'workbuddy') return installWorkBuddy({ home });
  throw new Error(`Unsupported Agent: ${selected}`);
}
