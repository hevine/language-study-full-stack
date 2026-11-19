import { env } from '../config/env';
import { redactSecret } from './secret';

type Level = 'debug' | 'info' | 'warn' | 'error';

const WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = WEIGHT[env.logLevel];

export type Fields = Record<string, unknown>;

/** 日志里绝不出现明文 Key：上游报错体偶尔会回显 Authorization，这里统一抹掉 */
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecret(value);
  if (depth >= 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => scrub(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = /apikey|api_key|token|secret|authorization|password|cipher/i.test(key) ? '***' : scrub(item, depth + 1);
  }
  return output;
}

function emit(level: Level, msg: string, fields: Fields = {}) {
  if (WEIGHT[level] < THRESHOLD) return;
  const record = { ts: new Date().toISOString(), level, msg: redactSecret(msg), ...(scrub(fields) as Fields) };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export function createLogger(base: Fields = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', msg, { ...base, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...base, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...base, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...base, ...fields }),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export const logger = createLogger({ app: 'waiyu-baodian' });
