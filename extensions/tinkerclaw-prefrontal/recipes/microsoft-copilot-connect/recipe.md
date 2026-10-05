---
schema: "kit/1.0"
slug: "microsoft-copilot-connect"
title: "Connect work Microsoft 365 Copilot through TinkerClaw"
summary: "Connect your organisation's Microsoft 365 Copilot, not GitHub Copilot. Two routes: the official Graph Chat API (needs an approved Entra app, seven delegated scopes and a verified Microsoft 365 Copilot add-on license), or the Outlook-shaped route that reuses a signed-in browser profile as the session and replays the Chathub socket. A shared browser tab is only the fallback. Green is a real chat reply, never a minted token."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
subdivision: "models"
tags:
  [
    "microsoft 365 copilot",
    "copilot pro",
    "company copilot",
    "work copilot",
    "connect copilot",
    "copilot through tinkerclaw",
    "outlook token",
    "teams msal",
    "graph chat api",
    "m365.cloud.microsoft",
  ]
triggers:
  [
    "connect copilot",
    "copilot pro",
    "microsoft copilot",
    "company copilot",
    "work copilot",
    "configure copilot",
    "copilot through tinkerclaw",
    "m365 copilot",
  ]
testedHarnesses: ["OpenClaw"]
authoredBy: "jarvis"
---

# Connect work Microsoft 365 Copilot through TinkerClaw

## Goal

Leave TinkerClaw able to talk to **your organisation's Microsoft 365 Copilot**, signed in as one work account. Prefer the official Graph Chat API when an approved app, the delegated permissions and the license are all in place. Otherwise use the Outlook-shaped route below, and keep any existing consented shared-tab bridge as the fallback. Do not touch GitHub Copilot. Do not switch the fleet's primary model.

This procedure is based on a live bridge and on Microsoft Learn docs checked 2026-09-24. Revise it when an authenticated Graph chat succeeds or Microsoft changes the contract.

## When to Use

- The user says they have "Copilot Pro" and it comes through work (their company tenant).
- Anyone wires Copilot into TinkerClaw.

## Parameters

Set these once. Nothing below should hard-code an account, a path or a port. The names match the `m365-copilot` skill, which documents the shared-tab shim this recipe builds on.

| Name                   | Meaning                                                                                                                        | Neutral default                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `M365_EXPECTED_UPN`    | The work account every token must belong to                                                                                    | `user@example.com`                             |
| `M365_COPILOT_SCRIPTS` | Where your bridge scripts live (shim, context wrapper, headless driver, capture helper). They are not shipped with this recipe | `~/.openclaw/scripts/m365-copilot/`            |
| `COPILOT_SHIM_PORT`    | Loopback port of the OpenAI-compatible shim                                                                                    | `18795` (same as the `m365-copilot` skill)     |
| `COPILOT_TIMEZONE`     | IANA zone sent as `locationHint.timeZone`                                                                                      | `UTC`                                          |
| `CHROME_USER_DATA`     | Chrome user-data directory that holds the signed-in profile                                                                    | `~/.config/google-chrome`                      |
| `CHROME_WORK_PROFILE`  | Chrome profile directory already signed in to the work account                                                                 | `Default`                                      |
| `MSAL_TOKEN_FILE`      | Shared Outlook/Teams refresh-token store                                                                                       | `~/.openclaw/credentials/outlook-msal.json`    |
| `CHATHUB_URL_FILE`     | Last captured Chathub socket URL                                                                                               | `~/.openclaw/credentials/m365-chathub-url.txt` |

Keep every credential file outside git, mode `0600`.

## Product boundary

GitHub Copilot is the wrong product. If the user has only a free GitHub Copilot SKU, it is not what they mean. A ChatGPT Plus subscription goes through the `openai-codex/*` provider, not this recipe. This recipe is Microsoft 365 Copilot (work).

## What is known (checked 2026-09-24)

- **Reference bridge shape.** A local shim (for example `$M365_COPILOT_SCRIPTS/copilot-shim.mjs` on `127.0.0.1:$COPILOT_SHIM_PORT`, run as a user service) speaks the OpenAI API and forwards each ask to a shared browser tab. The `m365-copilot` skill describes that shim and its setup. It works, but it is NOT extension-free.
- **Official alternative.** `POST https://graph.microsoft.com/beta/copilot/conversations` with `{}`, then `POST /beta/copilot/conversations/{id}/chat` with `{"message":{"text":"Reply exactly: PONG"},"locationHint":{"timeZone":"<COPILOT_TIMEZONE>"}}`. A streaming endpoint also exists (`chatOverStream`).
- **Scopes.** Microsoft requires **all seven delegated scopes**: `Sites.Read.All`, `Mail.Read`, `People.Read.All`, `OnlineMeetingTranscript.Read.All`, `Chat.Read`, `ChannelMessage.Read.All`, `ExternalItem.Read.All`. Work/school accounts only. Application-only credentials are unsupported.
- **License.** The signed-in user needs the **Microsoft 365 Copilot add-on**. There is no extra Chat API charge with that license. Consumer Copilot Pro or basic work Copilot Chat access does not make you eligible. Verify the add-on for the actual user; do not assume it.
- **Preview.** This is a beta API. Microsoft says production use is unsupported. There is no documented "think deeper" or model-selection control, so do not promise parity with whatever model label the browser shows.
- **What a live auth check found.** The Outlook refresh token had expired (`AADSTS700084`, the 24-hour SPA lifetime). The cached Graph token held only 2 of the 7 required scopes. CLI for Microsoft 365 was logged out. So no authenticated Copilot API call was possible that day; the 403 listed under history below is older and not a fresh test.

## Strategy — the Outlook shape, reusing access you already hold

Use this when the owner will not register a new Entra app. The goal is the Outlook pattern: no shared tab at ask time, and a key you already hold. The two products differ, and the plan has to design around the difference.

**Outlook.** The Teams web client (`5e3ce6c0-2b1f-4285-8d4b-75ee78787346`, Microsoft's first-party app id) hands you a refresh token. Store it in `$MSAL_TOKEN_FILE` and mint a fresh Graph access token on demand. The Teams tab is only needed when that refresh token dies (SPA lifetime, `AADSTS700084`, about 24 h).

**Copilot.** The chat socket is `wss://substrate.office.com/m365Copilot/Chathub/{oid}@{tid}`. Its bearer has audience `https://substrate.office.com/sydney` and is issued to Microsoft's first-party Copilot client, "M365 Chat Client" `c0ab8ce9-e9a0-42e7-b064-33d422df41f1`, the same in every tenant (confirm the id in the page's MSAL `localStorage` keys on your tenant). That token cache is encrypted and brokered through Nested App Auth, so there is no refresh token you can redeem yourself. A saved socket URL in `$CHATHUB_URL_FILE` goes stale; one checked on 2026-09-24 had expired about 13 days earlier. The Teams refresh token cannot be swapped into this client (`AADSTS70000`).

**What works.** A headless Chrome launched from a _copy_ of the signed-in `$CHROME_WORK_PROFILE` opens `https://m365.cloud.microsoft/chat` already logged in, with no relay extension and no shared tab. The live profile cannot be opened twice, so copy it: `$CHROME_USER_DATA/Local State` plus the session parts of `$CHROME_USER_DATA/$CHROME_WORK_PROFILE/` (`Cookies`, `Local Storage`, `Session Storage`, `IndexedDB`, `Preferences`, `Secure Preferences`, `Network Persistent State`, `Web Data`) into a private scratch directory (mode `0700`, for example under `$XDG_RUNTIME_DIR`). Launch Chrome with `--user-data-dir=<scratch> --profile-directory=$CHROME_WORK_PROFILE --headless=new --remote-debugging-port=<free port> --disable-extensions`. The copy holds live session cookies: delete it when the browser closes. Typing into the page's Lexical editor fails: the text shows, the Send button stays disabled, and Enter does not submit. One manual pass on the same browser did get a reply. So the session is good and the editor driving is the broken part.

**The plan, in order.** Do not fight the text box again.

1. Keep the headless profile copy. It is the session, the way the refresh token is the session for Outlook.
2. On that page, capture the Chathub traffic the app makes itself: URL, bearer, one send frame and the streamed reply frames. Use CDP network hooks (`Network.webSocketCreated`, `Network.webSocketFrameSent`, `Network.webSocketFrameReceived`). Do not type. A page load is enough to see the socket open.
3. Replay that one frame from Node `ws` with `Origin: https://m365.cloud.microsoft` and confirm a unique-token answer comes back. That is the green test. A minted token is not.
4. Once replay works, the headless browser is only the refresher. Open it when the bearer is within a few minutes of expiry, read a new one, close it. Asks go straight to the socket, the way Outlook asks go straight to Graph.
5. Only then point the shim at the socket client. Keep the shared-tab helper as fallback until a gateway turn returns a real Copilot answer with the relay extension disabled.

**Do not.** Do not register a new Entra app for this route. Do not print or log the bearer. Do not send the agent's system prompt or private memory. Do not restart the gateway until step 5 is green.

## Context on every call

The shim wraps the newest user turn before it reaches Copilot. In the reference bridge the wrapper is a separate module (`copilot-context.mjs`). This is the first, read-only design. The `m365-copilot` skill documents a later one that sends the turn as attached files and offers the gateway tools; follow that skill if you run its shim.

- Every ask gets a short protocol plus the catalog rows that match the question (cap 40). A full skills-and-recipes catalog (about 160 entries, about 36k chars in one deployment) is too long to type into the chat box.
- Copilot may answer with exactly `TOOL read skill <slug>` or `TOOL read recipe <slug>`. The shim reads that file locally (12k char cap) and asks again, up to two reads. A tool line never reaches the caller.
- Reading is the only tool. Running a skill stays on the main agent, because several skills shell out.
- Drop the gateway system prompt. In one deployment it was about 96k chars and included private memory.
- A `GET /v1/models` answer only proves the shim process is up. A live Copilot turn with the tool loop still needs a working transport (the shared tab, or the socket replay above).

## Extension-free setup via Graph (needs a new app)

Use this when the owner and IT approve a new app registration.

1. Use a tenant-approved **Entra public-client app registration**, separate from the first-party Teams app and from `$MSAL_TOKEN_FILE`. App registration and permission grants are tenant changes: get owner/IT approval before creating or granting anything.
2. Request the seven Graph delegated scopes plus `offline_access` through MSAL device-code login or interactive desktop authorization with PKCE. Tenant consent policy applies; this permission set needs an administrator. A public client needs no client secret. If tenant policy blocks device code, use an approved interactive flow. Never bypass policy.
3. Complete one user sign-in (a normal browser page is fine, **no relay extension or permanently open tab**). Store the token cache privately, outside git. Refresh normally until revocation or conditional access forces a new sign-in. Do not promise permanent unattended credentials.
4. Verify the license, create a conversation (201), send a harmless unique-token prompt, and receive a real chat answer (200). A minted token or a 201 alone is NOT end-to-end success. Do not send the agent's system instructions, private memory or any appended reflection text.
5. Only after that succeeds, switch the shim's transport to Graph. Keep its OpenAI-compatible interface. Map conversation ids per TinkerClaw session, never one global shared chat. Do not silently fall back to browser automation when extension-free mode is requested. Surface auth and license failures clearly. Respect `Retry-After`. Do not blindly retry a conversation creation that already succeeded.
6. Verify with Chrome and the relay unavailable. The proof is a fresh gateway → shim → Graph answer, not a subagent's answer or a `/v1/models` listing. Leave the running shared-tab bridge unchanged until the replacement is verified and its activation approved.

Sources checked 2026-09-24:

- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview
- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/copilotroot-post-conversations
- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/copilotconversation-chat

## Historical investigation (2026-09-10; not current auth status)

- The GitHub Copilot plugin was turned off and its catalog rows removed. The primary model was left alone.
- The Teams/Outlook refresh token lives in `$MSAL_TOKEN_FILE`. Re-extract it from a shared Teams tab on `AADSTS700084` (24 h SPA lifetime). Refresh calls need `Origin: https://teams.cloud.microsoft`.
- That token **sees** work Copilot (`chatType: work` in the Office Home bootstrap; Sydney-audience tokens mint). It does **not** complete a Copilot chat turn.

## Steps

### 1. Confirm GitHub Copilot is gone

```bash
openclaw models list --provider github-copilot   # expect: No models found
```

If rows reappear, disable `github-copilot` again and delete `agents.defaults.models.github-copilot/*`. Do not device-login to GitHub.

### 2. Keep the Outlook/Teams token healthy

Shared Teams tab, then `teams token store` (see the `teams-hack` skill, which writes `$MSAL_TOKEN_FILE`). Keep the refresh token out of shell history and logs: `teams token store` reads it from stdin only, never as an argument. `teams token test` must report `$M365_EXPECTED_UPN`. A different account means the wrong browser profile was shared.

### 3. Historical first-party-client probe (not the extension-free setup)

Chat over `wss://substrate.office.com/m365Copilot/Chathub/…` wants the first-party Copilot client (`c0ab8ce9-…`). The Teams refresh token cannot be redeemed as that client (`AADSTS70000`). The official Graph Chat call (`POST /beta/copilot/conversations`) returns 403 with a Teams token, because the Teams client cannot grow the extra Copilot Chat scopes (`AADSTS65002`).

**Done when:** a tab at `https://m365.cloud.microsoft/chat` (or the Microsoft 365 Copilot host) is **shared** on the Chrome relay, and CDP `localStorage` shows client `c0ab8ce9-…`. `Target.createTarget` is disabled on the relay, so the user must share an existing tab.

This probe did not establish a durable extension-free session. Do not treat first-party token extraction as the setup plan on its own. Use the Graph OAuth route when an app is approved, or the socket-replay plan above when it is not. The browser fallback works only on explicitly shared tabs.

### 4. Green is a chat reply, not a token mint

A Copilot answer to a unique-token test prompt is green. A 201 from `POST /beta/copilot/conversations` proves only that a conversation was created; require the chat response too. `chatType: work` JSON, a minted Sydney JWT and Graph retrieval hits are not a TinkerClaw model.

Do not `openclaw models set` anything Copilot until that reply exists. Do not install a third-party M365 proxy unasked.

## Failures Overcome

- **2026-09-10:** GitHub Copilot was treated as the user's "Copilot Pro". The live SKU was `free_limited_copilot`. The owner clarified: work Copilot, remove GitHub Copilot, reuse the Outlook token path.
- A Teams Sydney token plus Node `ws` still got 403 on Chathub. The cause was the wrong client id, not a missing `Origin` header.
- Graph retrieval returned company SharePoint hits once, then 403 `User does not have valid license` on retry. Unstable; not a product.
- `m365copilotapp.svc.cloud.microsoft/chat` GET is the Office Home bootstrap (`chatType: work`). POST to it is not a completions endpoint.
- **2026-09-24:** driving the chat page by typing into its Lexical editor never enabled Send. Capture and replay the socket instead of automating the text box.
