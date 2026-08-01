import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config, engineName, hasLlm, providerLabel } from './config.js';
import { router } from './routes/runs.js';
import * as store from './lib/store.js';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, engine: engineName(), uptimeSeconds: Math.round(process.uptime()) });
});

app.use('/api', router);

// Serve the built frontend from the same origin in production, so a deployment
// is one URL and the SSE stream never crosses an origin boundary.
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('text/plain')
      .send('API is running. The frontend has not been built yet — run `npm run build`, or use the Vite dev server on :5173.');
  });
}

app.use((err, _req, res, _next) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: err?.message ?? 'Something went wrong on the server.' });
});

const server = app.listen(config.port, config.host, () => {
  console.log('');
  console.log('  Agent Console');
  console.log(`  API           http://localhost:${config.port}`);
  console.log(
    `  Engine        ${engineName()}${hasLlm() ? ` — ${config.model} via ${providerLabel()}` : ' — set ANTHROPIC_API_KEY or OPENAI_API_KEY for model-driven runs'}`,
  );
  console.log(`  Data          ${config.dataDir}`);
  console.log(`  Frontend      ${fs.existsSync(config.webDist) ? 'served from ' + config.webDist : 'not built (use http://localhost:5173 in dev)'}`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use.`);
    console.error('  Something else — most likely an earlier copy of this server — is still holding it.\n');
    console.error('  Windows:  taskkill /F /IM node.exe');
    console.error('  macOS/Linux:  lsof -ti :' + config.port + ' | xargs kill');
    console.error(`  Or run on another port:  PORT=8788 npm start\n`);
    process.exit(1);
  }
  console.error('[api] server error:', err);
  process.exit(1);
});

const shutdown = async (signal) => {
  console.log(`\n[api] ${signal} received, flushing run data…`);
  server.close();
  await store.flush();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => console.error('[api] unhandled rejection:', reason));
