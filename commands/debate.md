---
description: Hold a Claude ↔ GPT debate about a disputed decision
argument-hint: "[--rounds N] <debate topic>"
allowed-tools: mcp__plugin_tandem_codex__codex_ask
---

The user wants two models to analyze this topic: `$ARGUMENTS`

Conduct a structured exchange with two rounds by default (or N from `--rounds`):

1. **Your position.** Formulate it yourself, concisely and with specific reasoning. Do not hide behind “it all depends on the context.”
2. **Round 1.** Call `codex_ask`, passing your position in `context` and explicitly asking in `question` for it to be challenged rather than expanded upon.
3. **Round 2.** Respond to GPT's strongest objection—again through `codex_ask`, including your response and asking GPT either to accept it or make a final objection.
4. **Conclusion.** In a separate block, state what you agreed on, where you still disagree, and what needs to be tested experimentally to resolve the debate. Do not pretend there is agreement when there is none—the disagreement is more useful to the user.

If GPT fully agrees with you after the first round, do not run a pointless second round: say so and move on to the conclusion.
