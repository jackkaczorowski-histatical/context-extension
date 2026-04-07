const Sentry = require('@sentry/node');

let initialized = false;

function initSentry() {
  if (initialized) return;
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.VERCEL_ENV || 'development',
  });
  initialized = true;
}

function captureError(err, context = {}) {
  initSentry();
  Sentry.withScope(scope => {
    Object.entries(context).forEach(([key, val]) => scope.setExtra(key, val));
    Sentry.captureException(err);
  });
}

module.exports = { initSentry, captureError };
