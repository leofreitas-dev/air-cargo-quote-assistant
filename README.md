# Air Cargo Quote Assistant

Reads air cargo quote requests from email, extracts the shipment details with AI, prices them with tested code, and queues a reply draft for a human to approve.

Work in progress. A portfolio project by Leonardo. Built with AI agents (Claude Code) under my direction.

## Run it (so far)

Requires Node 24 or later.

```
npm install
npm start                                        # approval tool at http://127.0.0.1:3000 (demo mode), dashboard at /dashboard
npm run demo                                     # the 10 demo emails, end to end, no API key needed
npm run demo -- --drafts                         # plus the full reply draft for each email
npm run demo -- --live                           # same, with the real AI (needs ANTHROPIC_API_KEY in .env)
npm test                                         # all tests
npm run price -- GRU MIA 3x120x100x110cm 420kg   # price a shipment, step by step
npm run airport -- "Sao Paulo Guarulhos" XXX     # how an airport written in an email is read
```

**n8n:** `n8n/quote-intake.workflow.json` is the email intake as an n8n workflow (IMAP or test webhook, then the engine's API, with alerts). n8n only orchestrates; all logic stays in the engine. See [n8n/README.md](n8n/README.md).

All emails, companies and people in `data/demo/` are fictional (`.test` domains). All rates in `data/tariffs.json` are fictional. `data/airports.json` is a demo subset of real airports (public IATA data).
