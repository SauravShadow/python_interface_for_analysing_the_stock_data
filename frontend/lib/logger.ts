/**
 * lib/logger.ts — Lightweight frontend logger with timestamps.
 *
 * Usage:
 *   import { createLogger } from '@/lib/logger'
 *   const log = createLogger('LivePage')
 *   log.info('WebSocket connected')
 *   log.error('Quote fetch failed', err)
 *
 * Format:  2026-05-12 10:30:45.123 [INFO ] [LivePage] message
 * Debug logs are suppressed in production builds.
 */

type Level = 'DEBUG' | 'INFO ' | 'WARN ' | 'ERROR'

const isProd = process.env.NODE_ENV === 'production'

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23)
}

function emit(level: Level, module: string, msg: string, extra?: unknown) {
  const prefix = `${ts()} [${level}] [${module}]`
  if (level === 'ERROR') {
    extra !== undefined ? console.error(prefix, msg, extra) : console.error(prefix, msg)
  } else if (level === 'WARN ') {
    extra !== undefined ? console.warn(prefix, msg, extra) : console.warn(prefix, msg)
  } else if (level === 'DEBUG') {
    if (!isProd) {
      extra !== undefined ? console.debug(prefix, msg, extra) : console.debug(prefix, msg)
    }
  } else {
    extra !== undefined ? console.log(prefix, msg, extra) : console.log(prefix, msg)
  }
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('DEBUG', module, msg, extra),
    info:  (msg: string, extra?: unknown) => emit('INFO ', module, msg, extra),
    warn:  (msg: string, extra?: unknown) => emit('WARN ', module, msg, extra),
    error: (msg: string, extra?: unknown) => emit('ERROR', module, msg, extra),
  }
}
