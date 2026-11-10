// Starts the approval tool at http://127.0.0.1:3000
//   npm start               demo mode: recorded AI answers; loads the 10 demo emails the first time
//   npm start -- --live     live mode: the real AI reads new emails (API or paste form)
//   npm start -- --port 4000

import { QuoteService } from '../app/service.ts';
import { loadApiKey } from '../ai/live.ts';
import { loadInbox } from '../domain/load-emails.ts';
import { Store } from '../store/db.ts';
import { createAppServer } from '../web/server.ts';
import { demoCallers, liveCallers } from './callers.ts';

const args = process.argv.slice(2);
const live = args.includes('--live');
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 3000;
const HOST = '127.0.0.1';

const inbox = loadInbox('data/demo/emails');
let callers;
if (live) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('Live mode needs ANTHROPIC_API_KEY in .env (see .env.example). Without it, run: npm start');
    process.exit(1);
  }
  callers = liveCallers(apiKey);
} else {
  callers = demoCallers(inbox);
}

// Demo and live keep separate databases, so they never mix.
const store = new Store(live ? 'data/app-live.db' : 'data/app.db');
const service = new QuoteService(store, callers, { outboxDir: live ? 'outbox/live' : 'outbox/demo' });

async function loadDemoInbox() {
  for (const e of inbox) await service.ingest(e.email);
}

if (!live && store.list().length === 0) {
  console.log('Loading the 10 demo emails...');
  await loadDemoInbox();
}

createAppServer({
  service,
  mode: live ? 'live' : 'demo',
  resetDemo: async () => {
    store.clear();
    await loadDemoInbox();
  },
}).listen(port, HOST, () => {
  console.log(`Approval tool (${live ? 'LIVE' : 'DEMO'} mode) at http://${HOST}:${port}`);
  console.log('API for n8n: POST /api/requests  (JSON: from, subject, body, optional messageId and receivedAt)');
  console.log('Stop with Ctrl+C.');
});
