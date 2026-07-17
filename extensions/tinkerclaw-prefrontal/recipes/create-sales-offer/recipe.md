---
schema: "kit/1.0"
slug: "create-sales-offer"
title: "Create a sales offer / quote from a template"
summary: "Generate a short, dense sales offer/quote for a customer from your house template + structure, pulling concrete data from your project knowledge. Keeps the universal pattern (register, offer number, sections, clarity) shareable while your real values (template, terms, bank details, paths) stay private variables. A human reviews + sends."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
subdivision: "sales"
tags:
  [
    "offer",
    "oferta",
    "quote",
    "presupuesto",
    "proposal",
    "sales offer",
    "sales proposal",
    "cotización",
    "crear oferta",
    "crear una oferta",
    "crea una oferta",
    "nueva oferta",
    "hacer una oferta",
    "una oferta para",
    "oferta para un cliente",
    "oferta para cliente",
    "preparar una oferta",
    "generar una oferta",
    "redactar una oferta",
    "hazme una oferta",
    "create an offer",
    "create a sales offer",
    "write an offer",
    "draft an offer",
    "prepare an offer",
    "generate a proposal",
    "make a quote",
    "create a quote",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
    - [6]
params:
  product_name:
    { type: "string", required: true, description: "The product/service the offer is for." }
  offer_language: { type: "string", description: "Language the offer is written in (e.g. es, en)." }
  knowledge_source:
    {
      type: "string",
      description: "Where the customer's concrete data lives (project-knowledge / fact-sheet + visit sources), and the source hierarchy to trust.",
    }
  doc_sections:
    { type: "string", description: "The ordered list of sections the offer must contain." }
  offer_template:
    {
      type: "string",
      secret: true,
      description: "Path to the document template to copy + rewrite (may hold real bank/legal text).",
    }
  offer_number_format:
    {
      type: "string",
      description: "The register / offer-numbering convention (e.g. year + customer code + sequence).",
    }
  naming_convention: { type: "string", description: "The output filename format." }
  fixed_terms:
    {
      type: "string",
      description: "The checklist of fixed commercial + legal terms to include (EXW/tax/warranty/milestones/bank details/legal clauses).",
    }
  pricing_model:
    {
      type: "string",
      description: "Pricing + discount rules (concrete figures). The final sale price is the single most-scrutinised value. Discount is OFF by default — applied ONLY when an explicit gating condition is met (e.g. first offer to a group, or a multi-unit order); as its own non-cumulative line.",
    }
  product_specific_constraints:
    {
      type: "string",
      description: "Product-specific technical/design constraints to reflect (e.g. fail-safe integration, component-specific quantities).",
    }
  reviewer:
    {
      type: "string",
      required: true,
      description: "Who reviews and sends the final offer — the agent NEVER sends.",
    }
  output_dir: { type: "string", secret: true, description: "Where to save the generated document." }
---

# Create a sales offer / quote from a template

> Generate a short, dense sales offer/quote for a customer from your house template + structure, pulling concrete data from your project knowledge. Keeps the universal pattern (register, offer number, sections, clarity) shareable while your real values (template, terms, bank details, paths) stay private variables. A human reviews + sends.

## Goal

Produce a short, dense, ready-to-review sales offer for {{product_name}} in {{offer_language}}, following your house structure, with concrete figures — ready for {{reviewer}} to review and send.

## When to Use

- A customer needs a {{product_name}} offer/quote
- Producing a sales proposal from your house template + project knowledge

## Steps

### 1. Gather the customer's concrete data

**Tools:** Read, Bash
**Done when:** You have every concrete data point for this customer.

Read the customer's project knowledge from {{knowledge_source}} (their fact sheet + visit sources: notes/photos, reports, emails). From there come ALL the concrete data: contact, installation, casework, sensing, quantities, prices. Respect the source hierarchy in {{knowledge_source}} (e.g. commercial = high-level context, technical = prices + engineering, the responsible's synthesis wins). A contact's role/title comes from their email signature, not third-party reports.

### 2. Lay out the document structure

**Tools:** Bash
**Done when:** You know the sections to produce and have the template.

Start from {{offer_template}}. Produce the sections in {{doc_sections}} — a generic product intro, the customer's real current state (their own vocabulary), the operative description, included components, price + volume scaling, assumptions, work plan, sale conditions, and bank/legal. The product intro is **fixed, generic boilerplate** reused verbatim across every offer — do NOT customise it per customer (so it stays correct and never has to be re-edited).

### 3. Keep it short and dense

**Done when:** The text is concise with no justifications.

The document must be as SHORT and detailed as possible. Do NOT add justifications or explanatory rationale that bloat it (why something was chosen, advantages, motivations) — that reasoning lives in the project knowledge, NOT in the offer. Use the installation's real vocabulary, not generic terms.

Two rules that carry real commercial/legal weight:

- **Under-promise capabilities.** Every claim about what the product DOES is future leverage for the customer to withhold payment or demand more work for the same price. State capabilities as _can / may / depending on configuration_, never as guaranteed, and make each one factually exact (don't inherit overstatements from the template).
- **The offer reassures, it does not alarm.** Don't surface internal worries or product concerns as highlighted problems or as extra price lines. Such caveats belong in the **final legal clauses** (conditions), in small print — not in the current-state section or the price table.

### 4. Apply the fixed terms + pricing model

**Done when:** The fixed values and the discount rule are in place.

Apply the fixed terms in {{fixed_terms}} (common to every offer) and the {{pricing_model}}: concrete figures, never [to confirm].

The **final sale price is the most important value in the document — check it many times.** Discount is **OFF by default**: apply one only when an explicit gating condition in {{pricing_model}} is met (e.g. first offer to a group, or a multi-unit order) AND you are completely sure it applies. **Never replicate a discount, an optional line, or a total copied from another customer's offer** — derive each figure from {{pricing_model}} for THIS customer. If there are justified ways to raise the cost, weigh them rather than rounding down. When a discount does apply, put it on its own line, not cumulative with the volume scaling.

### 5. Reflect product-specific constraints

**Done when:** Any product-specific design/technical constraint is reflected.

Reflect {{product_specific_constraints}} where relevant (e.g. a fail-safe integration with the customer's existing system: the product delivers a signal, the customer wires it, so if the product is off the customer's system keeps working as before; component-specific quantities are concrete and justified, not part of the standard).

### 6. Generate the document

**Tools:** Bash
**Done when:** The document exists with the correct name and structure.

Copy {{offer_template}} (or the customer's canonical version if one exists) and rewrite it preserving the template's formatting. Reuse the real template file — clone its style-prototype paragraphs and tables via python-docx (a setter that keeps each run's format) and swap only the body; do NOT regenerate via markdown→docx (that strips header/footer/logo/fonts/styles). Name it per {{naming_convention}}, with the number per {{offer_number_format}}; no '(draft)' tag, no date. Save it to {{output_dir}}.

Then **verify VISUALLY** that it respects the template: render to PDF and look at the first page plus a table page (header + logo, footer, fonts, styled tables present). "Preserves formatting" fails silently — confirm with your eyes, not just a structural check.

### 7. Hand to the reviewer

**Done when:** {{reviewer}} has the version and the list of what to confirm.

Tell {{reviewer}} the version and exactly what to confirm (the final number, prices, quantities, and the decisions that are the customer's). {{reviewer}} reviews, adjusts, and sends. The agent NEVER sends the offer.

## Constraints

- Offer written in {{offer_language}}.
- SHORT + dense — no rationale that bloats it (reasoning lives in project knowledge, not the offer).
- The installation's real vocabulary, not generic terms.
- Capabilities stated as _can / may / depending on configuration_, never guaranteed (any claim is future leverage for the customer); concerns go in the final legal clauses, not as problems or price lines. The offer reassures, not alarms.
- The product intro is fixed generic boilerplate, reused verbatim, not customised per customer.
- Concrete prices, never [to confirm]. The final price is the most-scrutinised value; discount is OFF by default (only on an explicit gating rule, and only if completely sure), never copied from another customer's offer.
- Reflect product-specific + fail-safe constraints where relevant.
- NEVER mention incidents at a competitor or another customer (accidents, and above all fatalities, are absolutely off-limits) — the reader concludes you would expose THEIR dirty laundry next. Motivate with generic sector risk + the customer's own situation; the most that is ever admissible is "a recent incident" with no place or date, and the default is not even that. Real anecdotes stay in internal notes.
- Generate by cloning the real template (python-docx), never markdown→docx; verify the result visually.
- Name per {{naming_convention}}.
- The agent drafts; {{reviewer}} reviews and sends.

## Safety Notes

- Never send the offer to the customer — sending is {{reviewer}}'s manual action.
- Your real specifics (template, fixed terms, bank details, output paths) live in the PRIVATE VarStore (gitignored, chmod 600), never in this recipe — the recipe stays a shareable skeleton.

## Failures Overcome

- Earlier versions hardcoded the customer's data + the business's specifics inside the recipe — now the recipe is GENERIC (typed variables), the customer data lives in project knowledge, and the business specifics live in the private VarStore. This is the shareable-bare-bones + private-variables pattern.
- A draft copied another customer's promotional discount, an optional line, and computed total — wrong on all three. The fix is encoded above: discount OFF by default (gated, only if completely sure), the final price scrutinised many times, figures derived for THIS customer (never inherited from another offer), capabilities hedged (any claim = future leverage), product concerns kept to the legal clauses (not problems/price lines), and the intro a fixed generic block. The two things that really matter in an offer are: don't give the customer ammunition (capabilities), and lock down the final sale price.
- A draft was regenerated via markdown→pandoc and lost the whole template (header, logo, footer, fonts, styled tables). Fix: clone the real template's style prototypes via python-docx and verify the output visually.
- A draft motivated the purchase by naming a fatal accident at another company's plant — commercially toxic (the customer reads it as "they'll expose OUR incidents too"). Fix encoded above: generic sector risk only; competitor/other-customer incidents never appear in anything customer-facing.
