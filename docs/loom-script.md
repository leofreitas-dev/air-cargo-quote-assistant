# Loom script (about 2 minutes)

One case that works, one case that goes wrong, and how the tool handles it.

**Before recording**

- `npm start`, open http://127.0.0.1:3000 and click **Reset demo** (bottom of the queue page), so all 10 requests are waiting.
- Browser zoom at 110 to 125%, one tab, notifications off.
- Optional for the end: the n8n editor open in a second tab.

Timings are a guide. Speak slowly; the screen does most of the talking.

---

## 0:00 - 0:15 · The problem

*Screen: the approval queue.*

> "Freight forwarders still answer air cargo quote requests by hand: read the email, work out the chargeable weight, look up the rate, type the reply. I built an assistant that does the reading and the maths, and leaves the reply for a person to approve. Here is the queue: ten real-looking emails, already processed."

## 0:15 - 1:00 · A case that works (REQ-001, GRU to Miami, 3 pallets)

*Click REQ-001.*

> "On the left, the original email. On the right, what the AI read from it, with a confidence score for every field."

*Scroll to "Price calculation (by code)".*

> "The price is never calculated by the AI. It's plain code, covered by tests. Three pallets weigh 420 kilos, but by volume they count as 660, so 660 is what gets charged. Then the rate for that weight break, fuel and security surcharges: 2,706 dollars."

*Scroll to the reply draft.*

> "The draft: the AI writes only the friendly sentences, and it isn't allowed to write a single digit. Every number in the reply comes from the code."

*Click **Approve**.*

> "I approve, and the reply goes to an outbox folder. Nothing is ever sent without a person."

## 1:00 - 1:40 · A case that goes wrong (REQ-004, coffee to Lisbon, no weight)

*Back to the queue. Click REQ-004.*

> "Now a harder one. This customer forgot the weight. A tool that guesses would send a wrong price. This one doesn't."

*Point at "Why this needs review".*

> "It's held for review, and it says why: weight missing. And the AI wasn't sure about the cargo type, 70 percent, so it says that too."

*Scroll to the draft.*

> "Instead of a price, the draft asks the customer for exactly what's missing, and repeats what we already know. Dangerous goods, duplicates, unknown airports and AI failures all work the same way: every error has a way out, and a person sees the reason."

## 1:40 - 2:00 · Dashboard and wrap-up

*Click **Dashboard**.*

> "The dashboard tracks volume, problems by type, time to decision, and what the AI costs: about 60 cents for a thousand emails."

*Optional: switch to the n8n tab for two seconds.*

> "And for teams on n8n, there's a workflow that watches the mailbox and calls this engine. It runs without an API key, and the code is on GitHub. I built it by directing AI agents. Thanks for watching."

---

**If you are short on time:** skip the n8n line and the dashboard sentence. The two cases are the part that matters.
