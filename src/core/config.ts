import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_API_BASE_URL } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  /** WebSocket endpoint of the NapCat OneBot implementation */
  napcatWs: string;
  /** Access token of the NapCat OneBot implementation */
  napcatToken: string;
  /** Master key used to encrypt user credentials at rest (64 hex chars) */
  encryptionKey: string;
  /** Words that trigger this bot in chat messages */
  commandNames: string[];
  /** How many times a failed billing fetch is retried */
  billingRetryCount: number;
  /** Base URL of the Dushu Lake (慧湖通) API */
  apiBaseUrl: string;
}

/**
 * Load and validate config.json.
 *
 * config.json is the single source of truth for runtime configuration;
 * see config.example.json for a template.
 */
function loadConfig(): AppConfig {
  const configPath = path.join(__dirname, '..', '..', 'config.json');

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `无法读取配置文件 ${configPath}：${error instanceof Error ? error.message : String(error)}\n` +
        '请复制 config.example.json 为 config.json 并填写后重试。'
    );
  }

  const errors: string[] = [];

  const requireString = (key: string, nonEmpty = true): string => {
    const value = raw[key];
    if (typeof value !== 'string' || (nonEmpty && value.trim() === '')) {
      errors.push(`缺少或非法的配置项：${key}`);
      return '';
    }
    return value;
  };

  const napcatWs = requireString('napcatWs');
  requireString('napcatToken', false);
  const encryptionKey = requireString('encryptionKey');

  const commandNames = raw.commandNames;
  if (
    !Array.isArray(commandNames) ||
    commandNames.length === 0 ||
    !commandNames.every((name) => typeof name === 'string' && name.trim() !== '')
  ) {
    errors.push('配置项 commandNames 必须是非空的字符串数组');
  }

  const billingRetryCountRaw = raw.billingRetryCount ?? 3;
  if (
    typeof billingRetryCountRaw !== 'number' ||
    !Number.isInteger(billingRetryCountRaw) ||
    billingRetryCountRaw < 0
  ) {
    errors.push('配置项 billingRetryCount 必须是非负整数');
  }

  if (errors.length > 0) {
    throw new Error(`配置文件校验失败：\n- ${errors.join('\n- ')}\n请参考 config.example.json。`);
  }

  if (!/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new Error(
      "配置项 encryptionKey 必须是 64 位十六进制字符（32 字节），可用 `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` 生成。"
    );
  }

  return {
    napcatWs,
    napcatToken: raw.napcatToken as string,
    encryptionKey,
    commandNames: commandNames as string[],
    billingRetryCount: billingRetryCountRaw as number,
    apiBaseUrl:
      typeof raw.apiBaseUrl === 'string' && raw.apiBaseUrl ? raw.apiBaseUrl : DEFAULT_API_BASE_URL
  };
}

export const config = loadConfig();
