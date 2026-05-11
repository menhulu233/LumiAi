import { session } from 'electron';

const isDev = process.env.NODE_ENV === 'development';

export function setContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || '5175';
    const cspDirectives = [
      "default-src 'self'",
      isDev ? `script-src 'self' 'unsafe-inline' http://localhost:${devPort} ws://localhost:${devPort}` : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: http:",
      "connect-src *",
      "font-src 'self' data:",
      "media-src 'self'",
      "worker-src 'self' blob:",
      "frame-src 'self'"
    ];

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': cspDirectives.join('; ')
      }
    });
  });
}
