'use strict';

// Used by the Dockerfile HEALTHCHECK. Written in node so it respects PORT and
// doesn't depend on whichever shell tools the base image happens to ship.
const http = require('http');

const port = process.env.PORT || 3000;
const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 2000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
