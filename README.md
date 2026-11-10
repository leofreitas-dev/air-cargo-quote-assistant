# Air Cargo Quote Assistant

Reads air cargo quote requests from email, extracts the shipment details with AI, prices them with tested code, and queues a reply draft for a human to approve.

Work in progress. A portfolio project by Leonardo. Built with AI agents (Claude Code) under my direction.

## Run it (so far)

Requires Node 24 or later.

```
npm install
npm run demo                                     # the 10 demo emails, end to end, no API key needed
npm run demo -- --live                           # same, read by the real AI (needs ANTHROPIC_API_KEY in .env)
npm test                                         # all tests
npm run price -- GRU MIA 3x120x100x110cm 420kg   # price a shipment, step by step
npm run airport -- "Sao Paulo Guarulhos" XXX     # how an airport written in an email is read
```

All emails, companies and people in `data/demo/` are fictional (`.test` domains). All rates in `data/tariffs.json` are fictional. `data/airports.json` is a demo subset of real airports (public IATA data).
