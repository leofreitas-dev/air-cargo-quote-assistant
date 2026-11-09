# Air Cargo Quote Assistant

Reads air cargo quote requests from email, extracts the shipment details with AI, prices them with tested code, and queues a reply draft for a human to approve.

Work in progress. A portfolio project by Leonardo. Built with AI agents (Claude Code) under my direction.

## Run it (so far)

Requires Node 24 or later.

```
npm install
npm test                                         # pricing tests
npm run price -- GRU MIA 3x120x100x110cm 420kg   # price a shipment, step by step
```

All rates in `data/tariffs.json` are fictional.
