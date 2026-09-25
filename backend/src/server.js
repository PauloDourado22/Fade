import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { publicRouter } from './routes/public.js';
import { appointmentsRouter } from './routes/appointments.js';
import { adminRouter } from './routes/admin.js';
import { webhooksRouter } from './routes/webhooks.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));

// IMPORTANT ORDERING: the Stripe webhook route needs the raw request body to
// verify the signature, so it's mounted with express.raw() *before* the
// global express.json() below. If express.json() ran first, it would
// consume and parse the body, and the webhook route would never see the raw
// bytes it needs. This is the single easiest thing to get wrong wiring up
// Stripe webhooks — leaving this comment so future-me doesn't reorder it.
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);

app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRouter);
app.use('/api/public', publicRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/admin', adminRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status ?? 500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Barbershop booking API listening on http://localhost:${config.port}`);
});
