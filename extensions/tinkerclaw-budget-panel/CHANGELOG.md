# Changelog

- 0.1.2 — config.models and anatomy.* are now opt-in (exposeModelConfig / exposeAnatomyTimeline, both off by default); config.models reads the runtime config instead of openclaw.json and returns only provider/mode/label per auth profile; plugin config is read from the real plugin entry (budgets were silently ignored); src/tracker.ts now ships with index.ts; the manifest now names the real xAI host (cli-chat-proxy.grok.com, not api.x.ai) and the client-identity headers the xAI and Copilot quota calls send.
- 0.1.1 — Read only credentials given to this gateway. Disclose 10-minute polling and gateway methods.
