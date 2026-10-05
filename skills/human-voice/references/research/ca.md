# Tells of AI-written CATALAN (2024–2026)

**Report language: English. All examples, word lists and rewrites: Catalan.**
Compiled 2026-09-24. Purpose: help an assistant **write like a clear, natural human** in real Catalan emails and messages. Not a detector-evasion guide.

---

## 0. Evidence note — read this before trusting any single tell

**The Catalan-specific literature is THIN but not empty.** What exists, and what it does and does not cover:

| Layer                                                 | Catalan-native evidence?                                                                     | Quality                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Grammar / preposition bias under Spanish interference | **YES — one strong peer-reviewed study** (UPF, Linguamática 2026)                            | Primary, quantitative                                |
| Stock-phrase / structural tells                       | **PARTIAL** — one Catalan university list (UB CRAI 2023), otherwise Spanish/English research | Mixed                                                |
| Catalan-specific AI vocabulary blacklist              | **NO** — nothing equivalent to the English "delve" corpora exists                            | My inference, marked                                 |
| Register (tu/vostè/vós, greetings, closings)          | **YES — rich, but from style guides, not AI research**                                       | Primary for human norms; the AI link is my inference |
| Real-speaker "how I spot it" threads                  | **SPARSE** — Racó Català yes; Reddit r/catalunya not retrievable through this search tool    | Thin                                                 |
| Dialect handling                                      | **YES** (Aina/MATXA coverage; one Valencian-press piece)                                     | Adequate                                             |

**Three structural cautions that apply to everything below:**

1. **The UPF study measured model _preferences_, not chatbot prose.** Almena & Brochhagen scored minimal pairs by negative log-likelihood on six language models (incl. BERTa-v2, X-MOD, TwHIN-BERT, XLM-V). It proves a **directional bias in the underlying models**. It does NOT prove that a given ChatGPT paragraph will contain those errors — RLHF'd chat products are a different surface. Treat it as _what machine Catalan drifts toward_, not _what it always does_.
2. **Almost every "AI Catalan" tell is also a "Catalan written by a Spanish-dominant human" tell.** This is the single biggest false-positive engine in Catalan, and it has no English equivalent. A bilingual city twenty-something texting fast produces `a que`, `olor a`, `degut a` natively. See §1-F.
3. **Detectors are worse in Catalan than in English and are documented to be biased.** The Stanford/HAI work found an average **61.3% false-positive rate** on non-native TOEFL essays, with every one of seven detectors affected. Catalan-language support in mainstream detectors is incomplete — the Ara teachers' roundup (30/10/2024) flags Winston IA and Corrector.app as **not supporting Catalan at all**. Never treat a detector score as evidence in Catalan.

Throughout: **[SOURCED]** = backed by a cited URL. **[INFERENCE]** = my own reasoning from adjacent evidence, explicitly flagged.

---

## 1. Tells taxonomy

Strength key: **STRONG** (almost only AI) · **MODERATE** (AI-typical in density) · **WEAK** (humans do it constantly — false-positive trap).

---

### GROUP A — Grammatical tells with measured Catalan evidence

#### A1. Preposition restored before _que_ (caiguda de preposició failure)

Normative formal Catalan **elides** `a / de / amb / en` before the conjunction `que` (GIEC §26.4.1). Spanish does not. Multilingual models prefer the non-normative Spanish-shaped form.

- ❌ `Em refereixo **a que** va cantar.` → ✅ `Em refereixo que va cantar.` / `Em refereixo al fet que va cantar.`
- ❌ `Tinc esperança **de que** vindrà.` → ✅ `Tinc esperança que vindrà.`
- ❌ `Confio **en que** ho farà.` → ✅ `Confio que ho farà.`

**Strength: MODERATE.** Real evidence of model bias, but native speakers do this constantly in speech and informal writing. It is a _normativity_ signal far more than an _authorship_ signal.
Sources: [Almena & Brochhagen, Linguamática 2026 (PDF)](https://brochhagen.github.io/content/ms/normaus.pdf) · [Viquipèdia, Interferències gramaticals](https://ca.wikipedia.org/wiki/Interfer%C3%A8ncies_gramaticals_del_castell%C3%A0_sobre_el_catal%C3%A0)

#### A2. Preposition `a` before a direct object

Catalan direct objects take **no** preposition (GIEC §19.3.2); Spanish uses personal _a_.

- ❌ `He vist **al** cotxe nou.` → ✅ `He vist **el** cotxe nou.`
- ❌ `Això afecta **al** trànsit aeri.` → ✅ `Això afecta **el** trànsit aeri.`

**Strength: MODERATE.** Same caveat as A1 — very common in Spanish-dominant human Catalan.
Sources: same two as A1.

#### A3. `de` → `a` in governed complements

- ❌ `Fa molta olor **a** fregit.` → ✅ `Fa molta olor **de** fregit.`
- Normative government: `contradictori **de**`, `diferent **de**`, `fer cas **de**`, `rebuig **de**`.

**Strength: MODERATE.**
Source: [Almena & Brochhagen 2026](https://brochhagen.github.io/content/ms/normaus.pdf) (Estructura 3, citing Murtra et al. 2025 and the UOC preposition criteria).

#### A4. Preposition alternation before an infinitive

Formal registers prefer the switch to `a` or `de` (GIEC §26.5.2).

- ❌ `Insisteixen **en** tornar cap a casa.` → ✅ `Insisteixen **a** tornar cap a casa.`

**Strength: MODERATE.**

#### A5. Non-interference verb-government slips — the interesting ones

These are **NOT** Spanish calques, and the study separated them deliberately. Models get these _right_ far more often (~96% normative preference) — which is itself diagnostic.

- ❌ `propens **de** enfadar-se` → ✅ `propens **a** enfadar-se`
- ❌ `**en** motiu del mal temps` → ✅ `**amb** motiu del mal temps`
- ❌ `confiar **amb** el criteri` → ✅ `confiar **en** el criteri`
- ❌ `Si no vas **en** compte` → ✅ `Si no vas **amb** compte`

**Strength: WEAK as an AI tell — STRONG as a _human_ tell.** This is the most useful finding in the whole report and it runs backwards from intuition:

> **`confiar amb`, `anar en compte`, `tractar` + noun without `de` are things REAL Catalan speakers say and machines tend NOT to produce.** The measured probabilities (Figure 1C): models prefer the normative form ~96% of the time when there is no Spanish interference, vs ~45% (multilingual) when there is.

**[INFERENCE]** For an assistant _writing_ Catalan: a text that is flawlessly normative on native-deviation items while sloppy on Spanish-calque items has a machine's exact error signature. Natural human Catalan usually shows the opposite profile.

**The quantitative result** (Figure 1C + 1D, read from the paper directly):

| Condition                                    | P(prefers normative form) |
| -------------------------------------------- | ------------------------- |
| No Spanish interference (either model type)  | **≈ 0.96**                |
| Spanish interference, monolingual model      | ≈ 0.74                    |
| Spanish interference, **multilingual** model | **≈ 0.45**                |

Regression: `Interferència` = −2.10 (95% CI −3.47 … −0.81); `Interferència × Multilingüe` = −1.72 (CI −2.70 … −0.75). Multilingualism alone has **no** main effect (0.46, CI −0.53 … 1.50) — it is the _interaction_ that bites.
So: press reports of "55% errors" (multilingual, interference), "27%" (monolingual, interference) and "4%" (no interference) all reconcile against this figure.
Source: [Almena & Brochhagen 2026](https://brochhagen.github.io/content/ms/normaus.pdf) · coverage: [Racó Català 26/02/2026](https://www.racocatala.cat/noticia/70165/estudi-avisa-algunes-ia-generatives-propaguen-formes-no-normatives-catala) · [NacióDigital](https://naciodigital.cat/next/tecnologia/la-ia-esta-castellanitzant-el-catala-lalerta-dun-estudi-de-la-upf-sobre-chatgpt-i-gemini.html)

---

### GROUP B — Calque and lexical tells

#### B1. `doncs` used causally (= Spanish _pues_)

- ❌ `No vindré, **doncs** estic malalt.` → ✅ `No vindré, **perquè** estic malalt.` / `…, **ja que** estic malalt.`
- `doncs` in Catalan is **consecutive** (`Penses, doncs, que no cal?`), never causal.

**Strength: MODERATE.** **[INFERENCE]** — this is canonical Catalan style-guide doctrine, but I found no study measuring it in AI output. Widespread in Spanish-dominant human Catalan too.

#### B2. `en base a`

Optimot: the form **is not normative**. Replacements, by context: `d'acord amb`, `a partir de`, `segons`, `partint de`, `sobre la base de`.

- ❌ `**En base a** les dades…` → ✅ `**A partir de** les dades…` / `**Segons** les dades…`

**Strength: WEAK–MODERATE.** Rampant in human administrative and journalistic Catalan. As an authorship signal it is nearly worthless; as a _quality_ signal it is real.
Source: [Optimot fitxa "en base a" / "sobre la base de"](https://aplicacions.llengua.gencat.cat/llc/AppJava/index.html?action=Principal&method=detall&input_cercar=en+base+a&database=FITXES_PUB&idFont=12428&tipusFont=Fitxes+de+l%27Optimot)

#### B3. `degut a` as a causal connector

- ❌ `**Degut a** la pluja, s'ha suspès.` → ✅ `**A causa de** la pluja…` / `**Per culpa de** la pluja…`
- **Important nuance:** the 2016 IEC grammar **partially admitted** `degut a`. Condemning it outright is now outdated.

**Strength: WEAK.** Explicitly a **false-positive trap** — it is both extremely common in humans and no longer clearly wrong.
Source: [Núvol, "Els 10 errors més freqüents en català"](https://www.nuvol.com/llengua/els-10-errors-mes-frequents-en-catala-31810) (page 403s to automated fetch; content surfaced via search index)

#### B4. Missing weak pronouns (`en`, `hi`)

Catalan requires clitics where Spanish drops them. Machine Catalan translated from Spanish tends to omit them.

- ❌ `Ara **vaig**.` → ✅ `Ara **hi** vaig.`
- ❌ `No **tinc**.` → ✅ `No **en** tinc.`
- ❌ `**Vull una gran.**` → ✅ `**En** vull una **de** gran.`

**Strength: MODERATE.** **[INFERENCE]** that this is AI-typical; **[SOURCED]** that it is a Spanish-interference pattern. A missing `hi`/`en` is one of the strongest "this was written through Spanish" signals in the language — but a fluent human writing fast also drops them.
Source: [Viquipèdia, Interferències gramaticals](https://ca.wikipedia.org/wiki/Interfer%C3%A8ncies_gramaticals_del_castell%C3%A0_sobre_el_catal%C3%A0)

#### B5. Spurious reflexives / missing negative reinforcement

- ❌ `**M'he** caigut.` → ✅ `**He** caigut.` (likewise `m'he pujat`, `m'he baixat`)
- ❌ `**Mai vindré.**` → ✅ `**Mai no** vindré.` (the `no` is normatively expected)

**Strength: WEAK.** The `mai no` rule is receding in real usage; its **absence** is normal modern Catalan, so do not treat it as a tell in either direction.

#### B6. `a més a més` / `tanmateix` as universal connectors

Both are perfectly good Catalan. The tell is **density and mechanical placement**, never the word.

- AI pattern: `A més a més,` opening paragraph 2, `Tanmateix,` opening paragraph 3, `En definitiva,` opening paragraph 4 — one connector per paragraph, in a tidy adversative-additive-conclusive rhythm.
- Natural rewrite: delete two of the three. Catalan prose does not need a signposting adverb on every paragraph. `Tanmateix` in particular is a **written-register** word — it is rare in email and near-absent in WhatsApp; a chatty message that contains it reads translated.

**Strength: MODERATE in density, WEAK per instance.** **[INFERENCE]** on the AI attribution; **[SOURCED]** that these are the standard connector inventory taught for formal writing.
Source: [UB Llibre d'estil, Connectors](https://www.ub.edu/llibre-estil/criteri.php?id=607) · [Diputació (provincial council, diba.cat), Connectors (PDF)](https://media.diba.cat/diba/html/formacio/centre_rec/continguts/018CRI_01/recursos/descargas/ca/connectors.pdf)

---

### GROUP C — Register tells (the highest-yield group for email and messaging)

#### C1. Over-formal opening in a casual context — **the single best Catalan tell**

Catalan has a genuinely graded salutation ladder, and machine Catalan reaches too high on it by default.

The UB ladder, most → least formal: `Distingit senyor` · `Senyor` · `Benvolgut senyor` · `Benvolgut professor` · `Benvolguda companya` · `Benvolgut amic`.

- ❌ (to a colleague you see daily) `**Benvolgut Marc,**` → ✅ `**Hola, Marc!**` or `**Bon dia, Marc,**`
- ❌ `**Benvolguda senyora,** Em plau de comunicar-vos…` in a two-line internal email → ✅ `**Hola!** Et passo el que em vas demanar.`

**Strength: STRONG in context.** `Benvolgut/Benvolguda` in a short internal note or a message to someone you're on first-name terms with is one of the clearest artificial notes in Catalan. **[INFERENCE]** on the AI attribution — but it follows directly from the sourced fact that models default to the most formal register available.
Sources: [UB Llibre d'estil, Salutació i comiat](https://www.ub.edu/cub/criteri.php?id=3050) · [CPNL, El correu electrònic](https://www.cpnl.cat/gramatica/125/23-el-correu-electronic)

#### C2. `vostè` where a human would use `tu` — and the missing `vós`

Catalan has **three** treatments, not two: `vós` (most formal, traditional, still alive in administrative Catalan) · `vostè` (formal) · `tu`/`vosaltres` (informal).

Two separate tells:

- **(a)** Official guidance is explicit that email is a _tu_ medium: _"en les comunicacions per correu electrònic, en què les relacions entre emissor i receptor són més directes, **el tractament de tu és habitual i, alhora, natural**."_ Machine Catalan defaults to `vostè`.
- **(b)** **[INFERENCE, and a good one]** Models trained through Spanish map `usted → vostè` and essentially **never produce `vós`**. `vós` is the traditional Catalan form; `vostè` derives from `vostra mercè`, itself from Castilian `vuestra merced`. So authentic formal Catalan — especially institutional — often uses `vós` (`Us saludo atentament`), and its total absence across a corpus of formal Catalan is suspicious.
- ❌ `**Li** agraeixo **la seva** resposta.` (in a peer email) → ✅ `**T'**agraeixo **la teva** resposta.` → better: `**Gràcies** per la resposta!`
- Also: **treatment must stay constant** — _"És important mantenir el tractament escollit al llarg de tot el text."_ Mid-text drift between `tu` and `vostè` is a machine artifact **[INFERENCE]**.

**Strength: STRONG (a) · MODERATE (b) · STRONG (drift).**
Sources: [CPNL](https://www.cpnl.cat/gramatica/125/23-el-correu-electronic) · [Diputació de Girona, Llibre d'estil 8.1](https://www.ddgi.cat/recursos-linguistics/llibre-estil/31/164/165/criteris-generals) · [en altres paraules: sobre el tractament de vostè](http://en-altres-paraules.blogspot.com/2015/01/sobre-el-tractament-de-voste-en-catala.html)

#### C3. Mismatched salutation and closing

The rule is explicit: _"Les fórmules de salutació i de comiat estan correlacionades, és a dir, corresponen al mateix grau de formalitat, i per tant no sempre són intercanviables."_

- ❌ `Hola, Anna!` … `Us saludo amb respecte.`
- ❌ `Distingit senyor,` … `Fins aviat!`

**Strength: MODERATE.** **[INFERENCE]** — humans mismatch too, but a _systematic_ pairing error across several messages suggests formula-assembly rather than writing.
Source: [UB Llibre d'estil](https://www.ub.edu/cub/criteri.php?id=3050)

#### C4. `Salutacions` as a closing

Flagged by a real speaker (see §4) as reading like a direct rendering of Spanish `Saludos`. Natural Catalan closings, by register:

- Formal: `Atentament,` `Ben atentament,` `Cordialment,` `Ben cordialment,` `Salutacions cordials,` `Us saludo atentament.`
- Neutral: `Gràcies!` `Salut,`
- Warm/informal: `Una abraçada,` `Fins aviat!` `A reveure,` `Que vagi bé!` `Un petó,` `Un petonàs!` `Bon vent,` `Salut i força al canut,`

**Strength: WEAK.** Plenty of humans write `Salutacions`. Listed because it is a _quality_ improvement, not a detection signal.
Source: [Racó Català, "Frase de comiat en cartes i correus electrònics"](https://www.racocatala.cat/forums/fil/206887/despedida-cartes-correus-electronics)

#### C5. Punctuation of the vocative — a small, sharp one

Catalan rule: comma **before** a bare proper-name vocative, **no** comma when an adjective accompanies it.

- ✅ `Hola, Anna` · ✅ `Benvolguda Anna` · ❌ `Hola Anna` · ❌ `Benvolguda, Anna`
  Closings: comma if there is no conjugated verb, full stop if there is. `Atentament,` / `Us saludo atentament.`

**Strength: WEAK.** Humans get this wrong constantly. **[INFERENCE]**: worth noting that AI often gets it _right_, which contributes to the "too clean" signature in §3.
Source: [UB Llibre d'estil](https://www.ub.edu/cub/criteri.php?id=3050)

---

### GROUP D — Dialect tells

#### D1. Silent default to central Catalan

Models default to **central Catalan standard** unless explicitly prompted. Valencian and Balearic forms appear only on request.

- Default output: `aquest`, `nosaltres`, `meva`, `avui`, `vermell`, `sóc`
- Valencian on request: `este`, `meua/meues`, plurals in `-es`, `hui`, `dènou`, `roig`

**[INFERENCE]** The tell for a Valencian or Balearic correspondent: a text that is _lexically_ Valencian but _syntactically and rhythmically_ central — e.g. `hui` and `meua` present, but central-standard sentence shapes and no local phraseology — reads like a translated-then-relabelled text rather than someone's own variety.
Source: [Diari La Veu, "La IA també parla valencià?", Francesc Fenollosa i Ten, 18/07/2026](https://www.diarilaveu.cat/llengua/la-ia-tambe-parla-valencia-642537/)

#### D2. Mid-text dialect mixing

**[INFERENCE — logically strong, not directly measured.]** A single short message containing both `aquest` and `este`, or both `avui` and `hui`, or `meva` and `meua`, is near-impossible from a native writer: everyone has one system. Mixing indicates sampling from a mixed corpus.
**Strength: STRONG when it occurs** (rare event, high information). Standardisation doctrine explicitly warns against "la mescla de sistemes."
Source: [CPNL, Les varietats del català](https://www.cpnl.cat/gramatica/119/36-les-varietats-del-catala)

#### D3. Silent language-switching mid-conversation

Documented repeatedly by real users: Catalan output flips to Spanish partway through. See §4.
**Strength: STRONG but only visible in dialogue**, not in a finished text.

---

### GROUP E — Catalan stock-phrase tells

The **only Catalan-native list** I found is the UB CRAI's (09/06/2023). It is dated (GPT-3.5 era) but it is real Catalan evidence, so it leads:

- `"en resum"` as an automatic closing move
- `"és important"` as the default hedging/emphasis frame
- `"tema controvertit, objecte de debat"` for anything contested
- `"estudiants"` used invariantly, never varied (`alumnat`, `alumnes`, `la classe`)
- lists where **every item begins with a bolded title followed by a colon**
- rigid introducció → desenvolupament → conclusió
- an illustrative example supplied for literally every point

**Strength: MODERATE individually, STRONG stacked.**
Source: [UB CRAI Docència, "Com detectar textos escrits per ChatGPT", 09/06/2023](https://www.ub.edu/docenciacrai/Blog-TACTIC/com-detectar-textos-escrits-chatgpt)

---

### GROUP F — FALSE POSITIVES: what looks like AI and is not

This section matters more in Catalan than in most languages.

1. **Spanish-influenced Catalan is the native register of millions.** Every tell in Group A and most of Group B fires on ordinary bilingual humans. In Catalonia, Spanish-dominant Catalan is not an error state, it is a sociolinguistic fact. **Do not read `a que` / `olor a` / `degut a` as a machine signature.**
2. **Institutional and administrative Catalan is genuinely formal.** `Benvolgut senyor`, `Us saludo atentament`, `vós` and heavy connector use are correct in a Generalitat letter. C1/C2 fire only when the register **mismatches the relationship**.
3. **Learners and L2 writers** produce over-normative, connector-heavy, cautiously-hedged prose because that is what coursebooks teach. This is exactly the population detectors already misclassify — 61.3% average false-positive rate on non-native essays.
4. **Corrector-passed text.** A human text run through the Softcatalà corrector or LanguageTool loses precisely the small irregularities used as humanity evidence. Editing ≠ generation.
5. **Professionally edited journalism** is structurally tidy by trade. Tidiness is a _genre_ signal, not an _authorship_ signal.
6. **Detector output in Catalan is not evidence.** Several mainstream tools do not support Catalan at all; ChatGPT asked to self-diagnose gives conclusions that are `"opinativa"` and `"molts cops poc fiable"`.

**The operative rule, and it is the same one the English-language literature converges on:** _one_ tell is noise; **three or four stacked in one short text** is signal. In Catalan, weight Group C (register) and Group D (dialect) above Group A (grammar), because Group A is contaminated by ordinary bilingualism.

---

## 2. Word and phrase list — overused AI Catalan, with plain replacements

**Provenance:** no Catalan corpus study of AI vocabulary exists. This list is **[INFERENCE]**: the documented English and Spanish AI stock-phrase inventories mapped into Catalan, cross-checked against the UB CRAI list (which independently confirms `en resum` and `és important`) and against Catalan connector guides. Treat it as a **writing** blacklist, not a detection instrument.

### Openings

| Overused                                    | Plain replacements                       |
| ------------------------------------------- | ---------------------------------------- |
| `En el món actual…`                         | _(delete — start with the actual point)_ |
| `En un món cada cop més digital…`           | _(delete)_                               |
| `Avui dia, vivim en una societat…`          | _(delete)_                               |
| `En l'era de la intel·ligència artificial…` | _(delete)_                               |
| `Cal tenir en compte que…`                  | `Tingues en compte que…` / _(delete)_    |

### Emphasis and signposting

| Overused                     | Plain replacements           |
| ---------------------------- | ---------------------------- |
| `Cal destacar que…`          | _(delete, or just state it)_ |
| `És important destacar que…` | _(delete)_                   |
| `És fonamental…`             | `Cal…` · `Has de…`           |
| `Un aspecte clau és…`        | `El que compta és…`          |
| `Val la pena esmentar que…`  | _(delete)_                   |
| `Cal subratllar…`            | _(delete)_                   |

### Connectors (the words are fine; the _density_ is the problem)

| Overused                            | Plain replacements                       |
| ----------------------------------- | ---------------------------------------- |
| `A més a més,` (every paragraph)    | `També` · `I` · _(delete)_               |
| `Tanmateix,` (as generic "however") | `Però` · `Ara bé,` · `Això sí,`          |
| `No obstant això,`                  | `Però` · `Tot i això,`                   |
| `D'altra banda,`                    | `També` · _(delete)_                     |
| `En aquest sentit,`                 | _(delete — almost always empty)_         |
| `De cara a`                         | `Per a` · `Amb vista a`                  |
| `En base a`                         | `A partir de` · `Segons` · `D'acord amb` |
| `Degut a`                           | `A causa de` · `Per`                     |
| `Doncs` (causal)                    | `Perquè` · `Ja que` · `Com que`          |

### Closings

| Overused                                         | Plain replacements                                  |
| ------------------------------------------------ | --------------------------------------------------- |
| `En conclusió,`                                  | _(delete — stop when you're done)_                  |
| `En resum,`                                      | _(delete)_                                          |
| `En definitiva,`                                 | _(delete)_                                          |
| `Per concloure,`                                 | _(delete)_                                          |
| `En última instància,`                           | `Al final` · _(delete)_                             |
| `Espero que aquesta informació et sigui útil.`   | `Digue'm si et va bé.` · `Qualsevol cosa, em dius.` |
| `No dubtis a contactar-me si tens cap pregunta.` | `Si tens dubtes, escriu-me.`                        |

### Inflated vocabulary

| Overused                                                | Plain replacements                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `endinsar-se en`                                        | `mirar` · `estudiar` · `entrar en`                                                                      |
| `submergir-se en`                                       | `posar-se a` · `centrar-se en`                                                                          |
| `aprofundir en` (reflex)                                | `mirar més a fons` · `estudiar`                                                                         |
| `un munt de` (as neutral "many")                        | `molts` · `força` — _`un munt de` is colloquial and fine in chat; the tell is using it in formal prose_ |
| `robust` / `sòlid` (of arguments)                       | `bo` · `que funciona`                                                                                   |
| `crucial` · `essencial` · `primordial`                  | `important` · `necessari`                                                                               |
| `panorama` · `paisatge` (figurative)                    | `situació` · `sector`                                                                                   |
| `fascinant` · `apassionant`                             | _(delete or be specific)_                                                                               |
| `en el seu conjunt`                                     | _(delete)_                                                                                              |
| `el teixit de…`                                         | _(delete)_                                                                                              |
| `desbloquejar el potencial`                             | `aprofitar`                                                                                             |
| `enfortir` · `potenciar` · `impulsar` (as filler verbs) | `millorar` · `ajudar` · `fer créixer`                                                                   |

### The "not X, but Y" frame

`No es tracta només de X, sinó de Y` · `No és X; és Y` — the single most recognisable rhetorical AI frame, and it transfers straight into Catalan.
→ **Just say Y.**

---

## 3. Structural and genre tells — these matter more than any single word

**[SOURCED for the general pattern (English/Spanish/UB CRAI); [INFERENCE] for the Catalan-specific manifestations.]**

1. **Symmetry.** Equal-length paragraphs, equal-length bullets, the same number of sub-points under each heading. Human Catalan prose is lumpy: one paragraph of six lines, then one of two.
2. **The tricolon reflex.** Three-item lists everywhere — `ràpid, fiable i escalable`. Catalan takes tricolons well, which makes this _harder_ to spot than in English. Watch for **every** enumeration being exactly three.
3. **Bold-title-plus-colon bullets.** Explicitly named in the UB CRAI list. `**Rapidesa:** el sistema respon en…` repeated down a list is a near-signature. Real people write bullets as bare fragments.
4. **The restating conclusion.** A final paragraph that adds nothing and re-labels what was already said. Human emails just stop.
5. **Total absence of deixis.** No `com et deia ahir`, no `el que vam parlar`, no `t'adjunto el que em vas demanar`. AI text is context-free because the model has no shared history. **This is the strongest structural tell in real correspondence** — a genuine email is _embedded in a relationship_ and refers outward to it.
6. **No cost, no hedge-with-a-reason.** Real people write `no hi arribo fins dijous`, `ho tinc a mitges`, `no ho sé segur`. AI hedges abstractly (`és possible que`) but rarely admits a concrete personal limit.
7. **Uniform sentence length.** Human Catalan messages mix a 25-word sentence with a 3-word one. Machine text hovers at 15–20.
8. **Punctuation too clean.** Correct `l'`/`d'` apostrophes, correct `·` in `intel·ligència`, correct accents on `què`/`més`/`sóc` throughout, no typos, no missing diacritics. **[INFERENCE — and specific to Catalan]:** the `ela geminada` (`·`) is awkward to type and real people drop it (`intelligencia`, `installar`); flawless `·` across a casual WhatsApp message is quietly anomalous. Likewise a text with **zero** missing accents in a chat context.
9. **Emoji placement.** AI puts one tidy emoji at the end of a line, or one per bullet. Catalan chat uses them mid-sentence, in runs, or not at all.
10. **No register drop within the message.** Real emails start semi-formal and loosen by the last line (`Gràcies! Fins dijous 😊`). AI holds one register to the full stop.
11. **The answer is complete.** Humans answer two of your three questions and forget the third.
12. **Openings that restate the question.** `M'has preguntat sobre X. Doncs bé, X és…`

### What natural Catalan email and WhatsApp actually looks like

**Email, colleague-level** — the realistic shape:

```
Hola, Marc,

Perdona la tardança. T'adjunto el pressupost revisat — he tret la partida
de muntatge perquè al final ho farem nosaltres.

Si veus res estrany, digue-m'ho i ho mirem dijous.

Gràcies!
Anna
```

Note: `Hola, Marc,` not `Benvolgut`; `tu` throughout; a reason given for a change; a concrete next step; a one-word closing.

**WhatsApp** — documented features of real Catalan digital writing: dropped accents, `k` for `qu`, omitted vowels, phonetic and numeric rebus spellings, repeated letters and exclamation marks for prosody, emoticons as tone-markers.

- `tb` (`també`) · `pq` / `xq` (`perquè`) · `q` (`que`) · `x` (`per`) · `kdd` (`quedada`) · `a10` (`adéu`) · `6plau` (`sisplau`) · `9se` (`no ho sé`) · `dsp` (`després`) · `ns` (`no sé`)
- Greetings: `Bon dia!` · `Ei!` · `Eiii!!!` · `Holaaa` · `holes` (to a group)
- Reactions: `Molt bé` · `Perfecte` · `Va bé` · `Doncs sí` · `Ostres` · `Apa` · `Gràcies!`
- Closings: `Fins aviat!` · `Una abraçada` · `Un petó` · `Un petonàs!` · `Que vagi bé!` · `A reveure`
- Diminutives as warmth markers: `platgeta`, `cafetó`, `una estoneta`

Sources: [Softcatalà / Torres i Vilatarsana & Payrató, 21/01/2002](https://www.softcatala.org/noticies/catala-joves-xats-correus-electronics-missatges-mobils-nova-varietat-colloquial/) · [Viquipèdia, Llenguatge SMS](https://ca.wikipedia.org/wiki/Llenguatge_SMS) · [correccioencatala.cat, correu formal i informal](https://correccioencatala.cat/correu-electronic-formal-informal/)

**⚠️ Caution on SMS-style abbreviations:** the Softcatalà study is from **2002**, the SMS-keypad era. Modern smartphone Catalan uses far fewer of these — the compression pressure is gone. `tb`, `pq`, `q` survive; `a10`, `6plau`, `9se` now read as dated or jokey. **[INFERENCE]** An assistant that sprinkles `a10` into a message to sound human will overshoot into 2005.

---

## 4. What real people said

Verbatim or closely paraphrased, with attribution. **Catalan-language community material on this specific topic is genuinely sparse** — Racó Català is the main retrievable venue; Reddit r/catalunya could not be reached through this search tool (searches returned no Reddit results and direct fetch is blocked).

1. **Capitàn·carxofa**, Racó Català, 03/12/2022 — _"No parla bon català aquest bot."_ — [link](https://www.racocatala.cat/forums/fil/243473/chatgpt?pag=1)
2. **Eimeric**, Racó Català, 28/03/2023 — _"Cada vuit respostes (aproximadament) canvia del català al castellà, no sé per què"_ — the language-drift tell, observed live. [link](https://www.racocatala.cat/forums/fil/243473/chatgpt?pag=1)
3. **pastor_de_bits**, Racó Català, 29/03/2023 — _"Normalment reiniciant la conversa i condicionant-lo des del principi dient-li explícitament que em parli en català ja no em fot res en castellà."_ — users had to _engineer_ Catalan out of it. [link](https://www.racocatala.cat/forums/fil/243473/chatgpt?pag=1)
4. **Pere_pirillós**, Racó Català, 27/03/2023 — _"molt curiós com el tipus de redactat no té res a veure en les dues llengües"_ — the register differs between the model's Catalan and its Spanish. [link](https://www.racocatala.cat/forums/fil/243473/chatgpt?pag=1)
5. **PuntVolat**, Racó Català, 27/03/2023 — _"Flipes com de cop i volta… Escriu millor que jo."_ — the counter-position, and a warning: fluency impresses speakers, so "it reads well" is not evidence of human authorship. [link](https://www.racocatala.cat/forums/fil/243473/chatgpt?pag=1)
6. **rotllan**, Racó Català, 24/03/2023 — reports it _"a vegades agafa sintaxi d'un altre"_ language. [link](https://www.racocatala.cat/forums/fil/243473/chatgpt?pag=1)
7. **Racó Català user on closings** — objects that `Salutacions` is _"una traducció molt literal del castellà 'Saludos'"_. A native ear rejecting a calqued formula. [link](https://www.racocatala.cat/forums/fil/206887/despedida-cartes-correus-electronics)
8. **Racó Català, same thread** — several participants note formality depends on the relationship, and worry `una abraçada` is too warm between professional acquaintances. The relationship-calibration that machine text skips. [link](https://www.racocatala.cat/forums/fil/206887/despedida-cartes-correus-electronics)
9. **Racó Català, "Diàlegs amb les IA"** — a user reports Meta AI on WhatsApp writing _"Encara no entenc català, però hi estic treballant"_ **in fluent Catalan**. [link](https://www.racocatala.cat/forums/fil/257377/dialegs-amb-les-ia)
10. **Joint Catalan universities' language services** (UAB/UB/UPC/UPF/UdL/UdG/URV/UVic) — _"ChatGPT pot cometre errors de llengua. No fa servir la llengua com ho fa una persona que sap català; per utilitzar-la analitza molts textos, n'extreu patrons i els aplica en les converses."_ [PDF](https://www.upc.edu/slt/ca/acollida/recursos/apren-cat-chatgpt-segur.pdf)
11. **Same guide, on sycophancy** — _"si demanes a ChatGPT que et corregeixi textos, tingues en compte que alguns dels errors li passen desapercebuts i que té una tendència general a voler-te complaure i dir-te que ho fas bé."_ [PDF](https://www.upc.edu/slt/ca/acollida/recursos/apren-cat-chatgpt-segur.pdf)
12. **Mireia Almena (UPF)**, 26/02/2026 — the models _"no només reprodueixen la llengua, sinó que també en poden influir l'evolució, especialment en llengües com el català, amb menys volum de contingut escrit als mitjans digitals."_ [link](https://naciodigital.cat/next/tecnologia/la-ia-esta-castellanitzant-el-catala-lalerta-dun-estudi-de-la-upf-sobre-chatgpt-i-gemini.html)
13. **Arnau Lleonart i Fernàndez, VilaWeb**, 19/02/2026 — describes the pipeline: _"el xatbot rep la nostra consulta feta en català, la tradueix a l'anglès, la processa… n'elabora una resposta en anglès i la lliura traduïda al català"_ — the mechanical reason machine Catalan reads translated. [link](https://www.vilaweb.cat/noticies/ia-pensa-catala-accent-obert/)
14. **Accent Obert**, 19/02/2026 — warns of models that speak Catalan _"amb marcs aliens a la realitat dels Països Catalans"_; announced testing chatbots against PAU, nivell C and ESO exams to see if they have _"un domini real del català."_ [link](https://www.racocatala.cat/noticia/70087/catala-amenacat-per-lavenc-lia)
15. **Francesc Fenollosa i Ten, Diari La Veu**, 18/07/2026 — on Valencian: text quality is _"més que notable"_ once instructed, but the models default to `català estàndard central` and still fail on `accents occidentals… i les e i o obertes`. [link](https://www.diarilaveu.cat/llengua/la-ia-tambe-parla-valencia-642537/)

---

## 5. Sources

**Primary research**

- [Almena Rodríguez, M. & Brochhagen, T. (2026), "Norma, ús i interferència: biaixos lingüístics en els models de llenguatge en català", _Linguamática_ — PDF](https://brochhagen.github.io/content/ms/normaus.pdf) — the only quantitative Catalan study located; 160 minimal pairs, 8 structures, 6 models; DOI 10.21814/lm.18.1.497. Read directly (pp. 3–5). 2026.
- [UPF e-Repositori record](https://repositori.upf.edu/items/25501ba9-78f4-4242-b067-05d67a74e1cd) — repository entry for the above.
- Stanford HAI / Liang et al. (2023) on detector bias — 61.3% average false-positive rate on non-native TOEFL essays; surfaced via [Tech & Learning](https://www.techlearning.com/news/ai-detectors-discriminate-against-non-native-speakers-says-stanford-research) and [The Markup, 14/08/2023](https://themarkup.org/machine-learning/2023/08/14/ai-detection-tools-falsely-accuse-international-students-of-cheating).

**Catalan institutional guidance**

- [UB CRAI Docència, "Com detectar textos escrits per ChatGPT", 09/06/2023](https://www.ub.edu/docenciacrai/Blog-TACTIC/com-detectar-textos-escrits-chatgpt) — the only Catalan-authored list of stylistic tells found.
- [Catalan universities' language services, "Aprèn català parlant amb la intel·ligència artificial" (PDF)](https://www.upc.edu/slt/ca/acollida/recursos/apren-cat-chatgpt-segur.pdf) — coordinated by UAB; explicit on ChatGPT's Catalan error profile and sycophancy.
- [UB Llibre d'estil — Salutació i comiat](https://www.ub.edu/cub/criteri.php?id=3050) · [Connectors](https://www.ub.edu/llibre-estil/criteri.php?id=607)
- [CPNL — El correu electrònic](https://www.cpnl.cat/gramatica/125/23-el-correu-electronic) · [Les varietats del català](https://www.cpnl.cat/gramatica/119/36-les-varietats-del-catala)
- [Optimot — fitxa "en base a" / "sobre la base de"](https://aplicacions.llengua.gencat.cat/llc/AppJava/index.html?action=Principal&method=detall&input_cercar=en+base+a&database=FITXES_PUB&idFont=12428&tipusFont=Fitxes+de+l%27Optimot)
- [Diputació de Girona, Llibre d'estil §8.1 — criteris generals de tractament](https://www.ddgi.cat/recursos-linguistics/llibre-estil/31/164/165/criteris-generals)
- [Diputació (provincial council, diba.cat) — Connectors (PDF)](https://media.diba.cat/diba/html/formacio/centre_rec/continguts/018CRI_01/recursos/descargas/ca/connectors.pdf)
- [Diputació (diba.cat) / Local.ia — "Detectar textos generats amb IA: eines, límits i recomanacions"](https://www.diba.cat/ca/web/local-ia/-/detectar-textos-generats-amb-ia) — _noted but not read: redirects to localia.cat, which failed TLS verification from this machine._

**Catalan press and community**

- [VilaWeb — "La IA parla en llengua catalana, però pensa realment en català?", Arnau Lleonart i Fernàndez, 19/02/2026](https://www.vilaweb.cat/noticies/ia-pensa-catala-accent-obert/)
- [Racó Català — "Un estudi avisa que algunes IA generatives propaguen formes no normatives del català per culpa del castellà", 26/02/2026](https://www.racocatala.cat/noticia/70165/estudi-avisa-algunes-ia-generatives-propaguen-formes-no-normatives-catala)
- [Racó Català — "El català, amenaçat per l'avenç de l'IA" (Accent Obert), 19/02/2026](https://www.racocatala.cat/noticia/70087/catala-amenacat-per-lavenc-lia)
- [NacióDigital — "La IA està castellanitzant el català", 26/02/2026](https://naciodigital.cat/next/tecnologia/la-ia-esta-castellanitzant-el-catala-lalerta-dun-estudi-de-la-upf-sobre-chatgpt-i-gemini.html)
- [Racó Català fòrums — "ChatGPT" (2022–2023)](https://www.racocatala.cat/forums/fil/243473/chatgpt?pag=1) · [— "Diàlegs amb les IA"](https://www.racocatala.cat/forums/fil/257377/dialegs-amb-les-ia) · [— "Frase de comiat en cartes i correus electrònics"](https://www.racocatala.cat/forums/fil/206887/despedida-cartes-correus-electronics)
- [Diari La Veu — "La IA també parla valencià?", Francesc Fenollosa i Ten, 18/07/2026](https://www.diarilaveu.cat/llengua/la-ia-tambe-parla-valencia-642537/)
- [Criatures/Ara — "Vuit eines per a docents que detecten si un treball està fet amb IA", 30/10/2024](https://criatures.ara.cat/escola/vuit-eines-docents-detecten-treball-fet-intel-ligencia-artificial_1_5170234.html)
- [Softcatalà — "El català dels joves en els xats, correus electrònics i missatges a mòbils", Torres i Vilatarsana & Payrató, 21/01/2002](https://www.softcatala.org/noticies/catala-joves-xats-correus-electronics-missatges-mobils-nova-varietat-colloquial/)
- [Softcatalà — "La intel·ligència artificial en català al vostre ordinador personal"](https://www.softcatala.org/noticies/la-intelligencia-artificial-en-catala-al-teu-ordinador-personal/) — Softcatalà's own model evaluations; currently recommends the Gemma 3 family, then Mistral Small, for Catalan.

**Catalan grammar reference**

- [Viquipèdia — Interferències gramaticals del castellà sobre el català](https://ca.wikipedia.org/wiki/Interfer%C3%A8ncies_gramaticals_del_castell%C3%A0_sobre_el_catal%C3%A0)
- [Núvol — "Els 10 errors més freqüents en català"](https://www.nuvol.com/llengua/els-10-errors-mes-frequents-en-catala-31810) — _403 to automated fetch; content reached through the search index only._
- [Viquipèdia — Llenguatge SMS](https://ca.wikipedia.org/wiki/Llenguatge_SMS)
- [correccioencatala.cat — El correu electrònic formal i informal](https://correccioencatala.cat/correu-electronic-formal-informal/)

**Comparative (non-Catalan, used for inference)**

- [Borja Girón — "Las palabras y frases que repite ChatGPT"](https://borjagiron.com/palabras-frases-repite-chatgpt/) — Spanish stock-phrase inventory (`cabe destacar`, `en conclusión`, `por un lado / por otro lado`).
- [gestioneducativa.net — "¿Cómo detectar textos escritos por ChatGPT? 10 señales"](https://gestioneducativa.net/como-detectar-textos-escritos-por-chatgpt-10-senales-para-descubrirlo/) — triads, rigid symmetry, `En un mundo cada vez más digital…`.
- [Detect AI Writing: Smart, Proven Tells and Real Limits, 25/08/2026](https://www.progressiverobot.com/2026/08/25/detect-ai-writing-tells-and-limits/) — the cumulative-signal rule and the em-dash caveat.
- [oliviacal.com — AI writing tells and word blacklist, 2026](https://www.oliviacal.com/post/ai-writing-tells) — "it's not X, it's Y", tricolon, `In conclusion` restating endings.

---

## 6. Bottom line for a Catalan-writing assistant

Ranked by what actually improves the writing:

1. **Match the register to the relationship.** `Hola, Marc,` + `tu` + `Gràcies!` for anyone you know. Reserve `Benvolgut` and `vostè` for genuine strangers and institutions. Hold one treatment throughout.
2. **Refer outward.** Name the previous message, the shared plan, the thing they asked. Context-free text is the loudest machine signal in real correspondence.
3. **Stop when finished.** No `En conclusió`, no `En resum`, no `Espero que aquesta informació et sigui útil`.
4. **One connector per three paragraphs, not one per paragraph.** Delete `En aquest sentit` on sight.
5. **Break the symmetry.** Vary paragraph and sentence length. Not every list needs three items.
6. **Say the concrete cost.** `No hi arribo fins dijous` beats `és possible que hi hagi un retard`.
7. **Pick one dialect and stay in it.** Never mix `aquest`/`este` or `avui`/`hui`.
8. **Don't fake errors to seem human.** Dropping a `hi` on purpose, or reaching for `a10`, overshoots. Natural comes from register and reference, not from planted mistakes.
