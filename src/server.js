import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config, aiEnabled } from './config.js';
import { seedUsers } from './db.js';
import { authenticate, csrfGuard } from './security.js';
import { engineName } from './llm.js';
import { seedDemoProject, seedStatus } from './seed-demo.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import projectRoutes from './routes/projects.js';

export function createApp() {
  seedUsers();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  }));
  app.use(express.json({ limit: '3mb' }));
  app.use(cookieParser());
  app.use('/api', csrfGuard);
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', (req, res) => res.json({ ok: true, engine: engineName(), aiEnabled: aiEnabled(), sampleProject: seedStatus.state }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', authenticate, adminRoutes);
  app.use('/api/projects', authenticate, projectRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(pub, { index: 'index.html', maxAge: 0 }));

  // Never leak stack traces or internals to the client.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[error]', err);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(config.port, config.host, () => {
    console.log(`AI SDLC Copilot running at http://${config.host}:${config.port}  (AI engine: ${engineName()})`);
    seedDemoProject();
  });
}
