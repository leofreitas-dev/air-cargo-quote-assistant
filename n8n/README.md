# n8n workflow: email intake

`quote-intake.workflow.json` is the way this project would be delivered to a client who already runs n8n: n8n watches the mailbox and hands each email to the quote engine. **n8n only orchestrates.** Reading the email with AI, validation, pricing and review rules all live in the engine, in tested TypeScript. There is one copy of the logic, so the two can never disagree.

```
[New quote email (IMAP)] ─┐
                          ├─> Normalize email ─> Send to quote engine ─┬─> Needs attention now? ─┬─ yes ─> Write alert ─┐
[Test email (webhook)]  ──┘                      POST /api/requests     │                         └─ no ──> Waiting for approval
                                                 3 tries, 5 s apart     │                                                   ├─> Notify Slack (optional)
                                                                        └─ engine did not answer ─> Engine did not answer ──┘
```

| Node | What it does |
|---|---|
| New quote email (IMAP) | The real trigger. Disabled in the export: add your IMAP credential and enable it. |
| Test email (webhook) | `POST /webhook/quote-email` with a JSON email, so the flow can be tested without a mailbox. |
| Normalize email | Turns either input into `{ messageId, from, subject, receivedAt, body }`. No business logic. |
| Send to quote engine | `POST http://127.0.0.1:3000/api/requests`. Retries 3 times; on failure goes to the error branch instead of stopping. |
| Needs attention now? | New request that is urgent, needs review, or landed in the error queue. |
| Write alert | One line for a person: what came in, why it needs attention, and the link to the approval page. |
| Engine did not answer | The engine was down or timed out. Says so, and that the execution is safe to re-run. |
| Notify Slack (optional) | Disabled. Add a Slack credential and enable it to get the alerts in a channel. |

Nothing is ever sent to a customer from n8n. Every reply is approved by a person in the engine's approval page.

## Why repeating a call is safe

The engine keys every email by its Message-ID. Sending the same email twice (an n8n retry, a re-run execution, a mailbox read twice) returns the existing request with `"created": false`: no duplicate request, no second AI charge. That is why the HTTP node can retry freely and why the alert only fires for `created: true`.

One n8n detail found while testing: n8n treats any node output with a filled `error` field as a failed call and retries it. The engine's API therefore reports problems in `errorReason`, not `error`.

## Run it locally

1. Start the engine: `npm start` (demo mode, port 3000).
2. Start n8n (Node 24): `npx n8n`, open http://127.0.0.1:5678 and create the local owner account.
3. Import: *Workflows > Import from file* > `n8n/quote-intake.workflow.json`, then publish (activate) it.
4. Send a test email:

```
curl -X POST -H 'content-type: application/json' \
  --data @data/demo/emails/05-lithium-batteries.json \
  http://127.0.0.1:5678/webhook/quote-email
```

The answer is the engine's verdict, for example:

```json
{ "id": "REQ-005", "status": "pending", "outcome": "quote", "needsReview": true,
  "reviewReasons": ["Dangerous goods (... UN3481): check DG documents and airline acceptance before sending"],
  "url": "/requests/REQ-005" }
```

In demo mode the engine only has recorded AI answers for the 10 demo emails. Any other email goes to the error queue (and n8n writes the alert), which is a quick way to see the error path. Start the engine with `npm start -- --live` to read new emails with the real AI.

## Tested paths

| Case | Result |
|---|---|
| Demo email (lithium batteries) | Request created, `needsReview: true`, reason shown. |
| Same email sent again | Same request returned at once, `created: false`, no alert. |
| Unknown email in demo mode | Request in the error queue; alert written with the reason and the link. |
| Engine stopped | 3 tries, then "Quote engine did not answer ... safe to repeat" (about 10 s). |
