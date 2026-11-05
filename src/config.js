import path from 'node:path';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.NODE_ENV !== 'test') dotenv.config({ path: path.join(root, '.env'), quiet: true });

const appSecret = process.env.APP_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.APP_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[config] APP_SECRET not set - using a random secret (sessions and stored integration tokens will not survive a restart).');
}

// Hosted deployments must never start with a throwaway secret or the documented demo password.
if (process.env.NODE_ENV === 'production') {
  const problems = [];
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) problems.push('APP_SECRET (32+ characters)');
  if (process.env.SEED_DEMO_USERS !== 'false' && (!process.env.DEMO_PASSWORD || process.env.DEMO_PASSWORD === 'Bootcamp@2026' || process.env.DEMO_PASSWORD.length < 12)) {
    problems.push('DEMO_PASSWORD (12+ characters, not the documented default) or SEED_DEMO_USERS=false');
  }
  if (problems.length) {
    console.error(`[config] Refusing to start in production. Set: ${problems.join('; ')}`);
    process.exit(1);
  }
}

export const config = {
  root,
  port: Number(process.env.PORT || 3000),
  // Render and other PaaS route traffic to 0.0.0.0; locally stay on loopback only.
  host: process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1'),
  // Number of reverse proxies in front of the app (Render: 1) so client IPs and HTTPS are detected.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : (process.env.RENDER ? 1 : 'loopback'),
  env: process.env.NODE_ENV || 'development',
  appSecret,
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024,
  demoPassword: process.env.DEMO_PASSWORD || 'Bootcamp@2026',
  seedDemoUsers: process.env.SEED_DEMO_USERS !== 'false',
  // Allow Jira base URLs on private networks only when explicitly enabled (SSRF guard).
  allowPrivateIntegrationHosts: process.env.ALLOW_PRIVATE_INTEGRATION_HOSTS === 'true',
  azureOpenAI: {
    endpoint: (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, ''),
    apiKey: process.env.AZURE_OPENAI_API_KEY || '',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5-5',
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    timeoutMs: Number(process.env.AZURE_OPENAI_TIMEOUT_MS || 120000),
  },
  // "auto" = Azure OpenAI when configured, otherwise the offline mock engine.
  aiMode: process.env.AI_MODE || 'auto',
  criticSelfReviseThreshold: Number(process.env.CRITIC_SELF_REVISE_THRESHOLD || 70),
};

export function aiEnabled() {
  if (config.aiMode === 'mock') return false;
  return Boolean(config.azureOpenAI.endpoint && config.azureOpenAI.apiKey);
}
