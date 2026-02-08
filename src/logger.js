const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

function log(level, message, data) {
  const ts = new Date().toISOString();
  const tag = LEVELS[level] || 'INFO';
  const line = data !== undefined
    ? `[${ts}] [${tag}] ${message} ${JSON.stringify(data)}`
    : `[${ts}] [${tag}] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message, data) => log('info', message, data),
  warn: (message, data) => log('warn', message, data),
  error: (message, data) => log('error', message, data),
};
