type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Level[] = ['debug', 'info', 'warn', 'error'];
const threshold = ORDER.indexOf((process.env.LOG_LEVEL as Level) ?? 'info');

function emit(level: Level, ctx: unknown, msg?: string) {
  if (ORDER.indexOf(level) < threshold) return;
  const line = { t: new Date().toISOString(), level, msg: msg ?? String(ctx), ...(msg ? { ctx } : {}) };
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (ctx: unknown, msg?: string) => emit('debug', ctx, msg),
  info: (ctx: unknown, msg?: string) => emit('info', ctx, msg),
  warn: (ctx: unknown, msg?: string) => emit('warn', ctx, msg),
  error: (ctx: unknown, msg?: string) => emit('error', ctx, msg),
};
