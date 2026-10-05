# How Spanish and Catalan speakers catch AI text and AI video scripts (2024–2026)

Research unit `esca` · compiled 2026-09-25 · report in English, **every example and quote kept in its original language**.

**Purpose.** Help an assistant WRITE naturally in Spanish (Spain) and Catalan for real people. Not a detector-evasion guide: most of what follows is a list of things that make prose _worse_ as well as _more suspicious_, which is why native readers punish them.

**Method.** ~20 web searches + ~25 page fetches. reddit.com is hard-blocked for both the Bash user-agent and the WebFetch tool (302 / "unable to fetch"); redlib mirrors returned 429/502 and a working mirror (safereddit.com) gave thin results before going quiet. So **r/spain, r/es and r/catalunya are effectively missing from this report** — the ordinary-people layer is carried instead by Forocoches, Menéame, Racó Català and Hacker News, which are all reachable. Where a claim rests only on a search-engine summary rather than a page I actually loaded, it is flagged `[snippet only]`.

**Headline finding.** The Spanish- and Catalan-language tells that matter most are _not_ translations of the English ones. They are **grammatical calques from English** (Spanish) and **grammatical calques from Spanish** (Catalan). An English-trained model writing Spanish makes mistakes a Spaniard registers as _foreign_, not as _robotic_ — which is why the folk phrase in Spain is now `suena a traducción` as often as `suena a robot`.

---

## 1. New tells

Strength scale: **STRONG** = people catch it on one sighting · **MODERATE** = needs corroboration · **WEAK** = real false-positive risk.

---

### 1.1 El posesivo anglosajón en lugar del reflexivo — "Lava tus manos"

**Language:** Spanish. **Strength: STRONG.** This is ungrammatical-adjacent in Spanish, and invisible to an English speaker checking their own output.

English marks possession (`wash your hands`); Spanish marks it with a reflexive (`lávate las manos`). A model that thinks in English leaves the possessive in.

Verbatim examples:

- `"Lava tus manos"` → correct Spanish: `"Lávate las manos"`
- Same family: `"Cierra tus ojos"`, `"Levanta tu mano"` where Spanish wants `"Cierra los ojos"`, `"Levanta la mano"`

Why people notice it, in their words: it is listed as chivato #1 — _"Posesivos que sobran"_ — in a Spanish copy-editor's catalogue of AI tells, i.e. the very first thing a professional reader strips out.

Source: Víctor Millán, _"Los 12 chivatos: cómo detectar (y corregir) que un texto está escrito con IA"_, Escribe Pro (Substack), **2026-05-24** — https://escribepro.substack.com/p/los-12-chivatos-como-detectar-y-corregir

---

### 1.2 El gerundio de posterioridad — "consiguiendo miles de visitas"

**Language:** Spanish. **Strength: STRONG** among anyone who edits for a living; MODERATE for a casual reader.

English chains consequences with `-ing`. Spanish grammar forbids the gerund for an action _subsequent_ to the main verb — it is a classic red-pen error taught in every Spanish style guide, and LLMs produce it constantly.

Verbatim example:

- `"Publicó el artículo, consiguiendo miles de visitas"` — flagged as chivato #2, _"Gerundios de contrabando"_ ("smuggled gerunds")

Why it works as a tell: a Spanish journalist or copywriter has had this beaten out of them; its presence in otherwise polished prose is a contradiction. Correct form: `"Publicó el artículo y consiguió miles de visitas"`.

Source: Escribe Pro, **2026-05-24** — https://escribepro.substack.com/p/los-12-chivatos-como-detectar-y-corregir

---

### 1.3 Fórmulas de cortesía calcadas del inglés — "Espero que este correo te encuentre bien"

**Language:** Spanish. **Strength: STRONG.**

_(The English "I hope this email finds you well" is listed as already-covered; the NEW evidence here is that the Spanish calque is a far harder tell than the English original, because the formula has no tradition in Spanish epistolary usage at all. In English it is a cliché. In Spanish it is an import that "sings".)_

Verbatim examples, all three named as americanismos that betray an AI draft in a professional Spanish inbox:

- `"Espero que este correo te encuentre bien"`
- `"no dudes en"`
- `"de cara a"`

Why people notice it, in their words:

> _"Dejar los americanismos… cantan"_
> — Félix Ramírez

and on the structural half of the same tell:

> _"frases largas, tono neutro y cero contexto de vuestra relación"_ … _"Un email que podría ir a cualquiera no lo lee nadie"_

The same formula turns up independently in a Forocoches user's list of what gives AI away, alongside `"en conclusión"`:

> _"espero que este correo te encuentre bien" y "en conclusión"_
> — **paquitoh19**, post #25

Sources: Félix Ramírez, Digitalmente Fácil, published **2026-03-25**, updated **2026-09-02** — https://digitalmentefacil.es/emails-con-ia-2026-guia-para-una-comunicacion-infalible/ · Forocoches thread _"¿También notáis la IA en todos lados?"_, **2026-05-13** — https://forocoches.com/foro/showthread.php?t=10683015

**Practical note for a writing assistant:** Ramírez's specific finding is that AI is worst at exactly the two highest-leverage parts of an email — _"la última frase y el asunto"_ — "las dos cosas que deciden si se abre y se responde".

---

### 1.4 La firma de asistente olvidada — "Si necesitas más ideas, no dudes en pedírmelo"

**Language:** Spanish. **Strength: STRONG — single sighting is conclusive.**

The chat-assistant sign-off left in place when text is pasted somewhere it does not belong. This is the highest-confidence tell in the entire corpus because it has no innocent explanation.

Verbatim example, from a teacher describing student homework:

> _"ves que la tarea termina con 'Si necesitas más ideas, no dudes en pedírmelo'"_
> — Gerard Alarcón, teacher

Same family: the trailing offer-question `"¿Quieres que te prepare…?"` / `"¿Te preparo un resumen?"` at the end of a document, and the older `"como modelo de lenguaje de IA"` / `"respuesta generada"` (Genbeta's señal #1).

Sources: Infobae, _"Así detectan los profesores textos escolares creados con ChatGPT"_, **2025-11-06** — https://www.infobae.com/tecno/2025/11/06/asi-detectan-los-profesores-textos-escolares-creados-con-chatgpt/ · Eva R. de Luis, Genbeta, **2024-07-20** — https://www.genbeta.com/a-fondo/no-necesitas-detector-textos-para-ia-11-senales-para-descubrir-que-escrito-esta-hecho-inteligencia-artificial

---

### 1.5 Negritas en cada párrafo + enumeraciones innecesarias (markdown bleed)

**Language:** Spanish and Catalan alike. **Strength: STRONG** in any casual channel (forum, WhatsApp, comment thread).

The single most-cited tell by ordinary Spanish forum users in 2026. Not vocabulary — **layout**. A human writing a forum post does not bold a phrase in every paragraph or convert three thoughts into a bulleted list.

Verbatim examples:

> _"hay negritas en cada párrafo, enumeraciones innecesarias, una coherencia sospechosa"_
> — **paquitoh19**, post #1, Forocoches, 2026-05-13

> AI text has a recognisable _"textura"_: _"estructura impecable, tono equilibrado, listas omnipresentes"_
> — **C3B2**, post #8, same thread

> _"tocho automático"_
> — **Carlospatek**, Forocoches, 2026-02-10 (on AI answers pasted into threads)

> _"Excessive parallel structure: all sentences have the same length"_ / _"Generic listing vocabulary"_ / _"Zero concrete anecdotes"_ — the 2026 short-list per Catalizadora `[snippet only]`

Adjacent and mechanical: **raw markdown surviving the paste**. Copying from a chat UI into WhatsApp, Word or a forum carries `**` and `#` literally — _"os habrán aparecido almohadillas # asteriscos _"\*. A stray `**` in a WhatsApp message is a zero-ambiguity tell.

Sources: https://forocoches.com/foro/showthread.php?t=10683015 (**2026-05-13**) · https://forocoches.com/foro/showthread.php?t=10602703 (**2026-02-10**) · https://educacion.bilateria.org/manipulacion-del-texto-copiado-del-chat-de-ia-formato-markdown

---

### 1.6 Las comillas en los saludos

**Language:** Spanish. **Strength: MODERATE** — narrow, but very few false positives when it fires.

A genuinely new, small, Spain-specific typographic observation: AI-written Spanish puts greetings and set phrases in quotation marks, which Spanish writing convention does not do.

Verbatim:

> _"Las [comillas] en los saludos…. Algo que en castellano no se suele hacer"_
> — **anekro**, post #19, Forocoches, **2026-05-13**

Belongs to a broader typography-transfer family that Spanish readers flag: curly/typographic quotes `" "` where a Spanish keyboard produces `"`, and the Spanish _raya_ `—` used in the English em-dash way. On the raya specifically the Spanish forum verdict is **split, and mostly sceptical** — see §1.13 (false-positive warning).

Source: https://forocoches.com/foro/showthread.php?t=10683015

---

### 1.7 Calcos del inglés corporativo — "desbloquear", "apalancarse", "navegar"

**Language:** Spanish. **Strength: MODERATE** (register signal, not proof).

Distinct from the English `delve` family already covered: these are English _business_ verbs pushed through into Spanish where a Spaniard would use an ordinary word.

Verbatim example sets:

- chivato #7 _"Calcos del inglés corporativo"_: `"desbloquear"`, `"apalancarse"`, `"navegar"`
- chivato #8 _"Lenguaje de oficina por defecto"_: `"Utilizar"`, `"implementar"`, `"optimizar"`, `"ecosistema"`
- Genbeta's _"lenguaje excesivamente comercial"_: `"profundizar"`, `"descubrir"`, `"transformar"`, `"llevar al siguiente nivel"`
- A copywriter's own delete-list: `"sinergia"`, `"potenciar"`, `"optimizar"`
- Borja Girón's 54-item list includes `"Embarcarse"`, `"Desbloquear los secretos"`, `"Sumérgete en"`, `"Elevar"`, `"Desatar"`, `"Aprovechar"`, `"Revolucionar"`, `"Fomentar"`

**Important caveat from the same source** — and this is the most useful thing in it. Borja Girón publishes the 54-word list and then argues _against_ the word-list approach, saying the real problem is _"syntactic structures, rhythm, and false depth"_ rather than isolated vocabulary. Treat single-word lists as 2024-era; they are now the least reliable layer.

Sources: Escribe Pro **2026-05-24** · Genbeta **2024-07-20** · Oli Sapiens, **2026-04-22** — https://olisapiens.com/blog/copywriting-con-ia/ · Borja Girón, **2026-08-12** — https://borjagiron.com/palabras-frases-repite-chatgpt/

---

### 1.8 "Suena a traducción" — correct grammar, imported rhythm

**Language:** Spanish. **Strength: MODERATE.** This is the register-level version of the Latin-American question in §1.9, and the phrase Spanish professionals actually use.

The observation from Spanish copywriters is that models trained mostly on English produce Spanish that is _grammatically fine and rhythmically foreign_: sentence lengths, clause order and connective density follow English prose habits.

Verbatim, from 2026 Spanish copywriting sources:

> models' Spanish copy _"a menudo suene a traducción: correcto en gramática, pero plano en persuasión y ajeno a los matices culturales"_ `[snippet only]`

> _"estructuras de frase que suenan importadas, expresiones poco naturales y un tono neutro que no termina de conectar"_ `[snippet only]`

> _"ese olor a texto «correcto pero sin alma»"_
> — Oli Sapiens, **2026-04-22**

> _"Frases que suenan a manual. Titulares que prometen lo mismo que prometen las otras 400 landings de su sector."_ … _"Bullet points que podrían servir para vender un curso de Excel, un curso de yoga o un curso de crochet."_
> — Oli Sapiens, **2026-04-22**

The prescribed fix is also the most transferable advice in the corpus: **read it aloud and correct whatever sounds translated** (`leer en voz alta, corregir lo que suene a traducción`).

Sources: https://olisapiens.com/blog/copywriting-con-ia/ (**2026-04-22**) · https://www.clientelia.es/copywriting-persuasivo-ia-pymes-guia-2026/ and https://vilmanunez.com/ia-para-copywriting-en-espanol-guia-y-herramientas-2026/ `[snippet only]`

---

### 1.9 El registro latinoamericano neutro en un texto que debería ser de España

**Language:** Spanish (Spain). **Strength: MODERATE** — _and the weakest-evidenced item in this report; see the honesty note._

The brief asked specifically about this. What I can support:

- The **grammatical** marker is real and binary: Spain distinguishes informal plural `vosotros` from formal `ustedes`; all of Latin America uses `ustedes` for both. A text addressing a Spanish informal audience as `ustedes` is either Latin-American or machine-neutral. _"si un texto usa consistentemente 'ustedes' en contextos informales donde un hablante de España peninsular usaría 'vosotros', es un indicador muy claro"_.
- The **lexical** markers are the familiar set: `computadora` vs `ordenador`, `celular` vs `móvil`, `acá` vs `aquí`, `carro` vs `coche`, `platicar` vs `hablar`. `"En Latinoamérica se usa 'computadora'… en España se usa 'ordenador'"`.
- The **register** claim is supported indirectly but consistently by Spanish copywriters (§1.8) describing model Spanish as culturally unplaced and tonally neutral.

**Honesty note:** I did **not** find a Spanish forum thread or article in which ordinary Spaniards explicitly say "I knew it was AI because it said _ustedes_/_computadora_". The dialect facts are well sourced; the _inference that Spaniards use them as an AI tell_ is mine, built on the copywriter testimony. Rated MODERATE for that reason, and it would be the single most valuable thing to verify with a live r/spain or Forocoches search once Reddit is reachable.

Sources (dialect facts): https://es.babbel.com/es/magazine/diferencias-espanol-de-espana-y-latinoamerica · https://www.woodwardspanish.com/how-to-say-computer-spanish-computador-computadora-ordenador/

---

### 1.10 La cópula omnipresente — "eres menos IA si omites la cópula"

**Language:** Spanish. **Strength: WEAK-to-MODERATE.** Included because it is genuinely new, structural rather than lexical, and came out of a Spanish grammar community rather than an English detector blog.

The claim: AI Spanish leans heavily on copular constructions (`X es Y`, `esto es un ejemplo de`), and prose that omits the copula reads as more human. Tested against the Pangram detector.

Verbatim:

> _"eres menos IA si omites la cópula"_

And the sharper underlying point, quoted approvingly by a commenter:

> _"Si el texto lo piensas y lo revisas de verdad, resulta humano porque lo es en el fondo"_
> — **nilien**, comment #13

With the obvious false-positive, stated by a user about himself:

> _"Pues yo llevo omitiendo la cópula una buena temporada y para mí que hay gente que me cree un bot"_
> — **Brill**, comment #11

Source: Menéame, community _Amantes de la gramática_ — https://www.meneame.net/m/Gram%C3%A1tica/como-no-parecer-ia-cuando-escribes · original article https://pasqualepillitteri.it/es/news/13503/no-parecer-ia-escritura-metodo (site returned `socket hang up` on two fetch attempts; quotes come via the Menéame page, which I did load)

---

### 1.11 CATALAN — Errors de preposició per interferència del castellà: "he vist al professor"

**Language:** Catalan. **Strength: STRONG for Catalan readers** — this is _the_ Catalan tell, and it is measured, not anecdotal.

A Pompeu Fabra University study (published in _Linguamática_, led by Prof. Thomas Brochhagen, Dept. of Translation and Language Sciences) tested six models including ChatGPT and Gemini against a 160-sentence evaluation corpus covering eight grammatical structures where preposition choice is contested.

Verbatim error examples:

- `"he vist al professor"` — **incorrect**; correct Catalan: `"he vist el professor"` (Catalan, unlike Spanish `he visto al profesor`, does not take a preposition before a direct object)
- `"No soc gens propens d'enfadar-me"` — **incorrect**; should be `"a enfadar-me"`

Hard numbers: multilingual AIs erred in **55% of cases due to Spanish influence** and 4% for other reasons; monolingual models erred in 27%.

Why it matters, in the researcher's words:

> _"AIs not only reproduce language, but also influence its evolution"_ — and can have far greater impact on languages like Catalan, with less digital written content, than on larger languages
> — Mireia Almena (UPF)

Related and equally diagnostic: **the loss of the weak pronouns EN and HI**, which disappear under literal translation from Spanish (which has no equivalent), plus pleonastic indirect objects introduced by Spanish influence `[snippet only, via search summary of UPF/grammar sources]`. For a Catalan reader, a paragraph with no `en` or `hi` where the syntax calls for them reads as translated-from-Spanish immediately.

Sources: Ara, _"«He vist al professor»: la IA propaga faltes en català (per culpa del castellà)"_ — https://en.ara.cat/languages/have-seen-the-professor-ai-spreads-mistakes-in-catalan-due-to-spanish-influence_1_5659940.html

---

### 1.12 CATALAN — Barreja d'idiomes i accents inventats: "parlém", "posso"

**Language:** Catalan. **Strength: STRONG** — one sighting is enough for any native speaker.

When a model is thin on Catalan it produces words that are half-Catalan/half-Spanish, or borrows from a nearer Romance language, and adds accents that do not exist.

Verbatim — WhatsApp's Meta AI, in a single sentence:

> `"Hola! Sí, parlém Català! Què tal? Com posso ajudar-te?"`

Three errors in one line, as catalogued by the outlet:

1. `"parlém"` — wrong accent (should be `parlem`)
2. `"Català"` — spurious capitalisation
3. `"posso"` — **Italian**, not Catalan (should be `puc`)

Corroborating, from a Catalan translation guide:

> _"paraules a mig camí entre català i castellà. També errors com la supressió d'una lletra que no canviï la sonoritat"_
> and _"confusió amb expressions col·loquials castellanes (que tradueix literalment al català)"_

Sources: Nació Digital / Next, **2025-11-28** — https://naciodigital.cat/next/tecnologia/la-ia-de-whatsapp-ja-parla-en-catala-pero-ho-fa-amb-errors-ortografics-i-barrejant-idiomes.html · Adrián Soler, Paréntesis Media, **2024-12-23** — https://www.parentesi.media/com-traduir-amb-chatgpt-compte-amb-aquests-errors-habituals/

---

### 1.13 CATALAN/Spanish — Majúscules a Cada Paraula (English title case)

**Language:** Catalan and Spanish. **Strength: STRONG.**

Neither Catalan nor Spanish capitalises every word in a heading. English does. Title case in a Catalan or Spanish heading is a direct import with no native explanation.

Verbatim, from the leading Catalan-language tell list:

> _"L'Obsessionada Capitalització dels Títols"_ — _"Majúscules a Cada Paraula, com si tot el que escriguessin fos una revelació divina"_
> — Antoni Vélez

The same tell appears in Spanish lists as _"títulos con mayúsculas uniformes (Camel case)"_.

Sources: Antoni Vélez, Avisam IA, **2025-03-14** — https://www.avisamia.cat/p/com-saber-si-algu-ha-fet-servir-ia · https://luisorlandolencarpio.substack.com/p/11-senales-de-que-chatgpt-escribio (**2025-10-30**)

---

### 1.14 CATALAN — The rest of the Avisam IA list (in Catalan)

**Strength: MODERATE** — a native-Catalan articulation of tells that mostly rhyme with the English ones, but the _wording_ is useful because it is how Catalan speakers describe the feeling.

Verbatim:

- _"La Simpatia Forçada i el To Excessivament Amable"_ — text that sounds _"massa correcte, massa equilibrat, massa… feliç"_
- _"La Sobredosi d'Adjectius i Sinònims"_ — `"innovadora, fascinant, revolucionària"`
- _"Les Frases Massa Rodones (I Sense Cap Errada)"_ — _"escriu com si hagués fet un màster"_
- _"Diu el Que Vols Sentir"_ — _"te farà sentir com un geni"_
- _"Diu Mentides Amb Un Somriure"_ — _"S'inventen cites falses, referències inexistents i fets alternatius"_

Source: https://www.avisamia.cat/p/com-saber-si-algu-ha-fet-servir-ia (**2025-03-14**)

---

### 1.15 CATALAN — Català estàndard sense cap marca dialectal ni col·loquial

**Language:** Catalan. **Strength: MODERATE, partly inferential.**

Catalan has strong, socially-marked dialectal variation (central, valencià, balear, nord-occidental) and a colloquial register that differs sharply from the written standard. Model Catalan lands on a flat, book-standard central Catalan with no dialectal or colloquial marking at all — which reads as _institutional_ in contexts where a person would not be.

The supporting evidence is indirect but strong: the **AINA** project specifically ingested ~9.7M messages from the **Racó Català** forums _because_ models lacked informal and dialectal Catalan — _"Thanks to Racó Català's contribution, linguistic models… can now also interpret language typical of informal and dialectal contexts"_. That is an admission of the gap, from the people fixing it.

Sources: ACCIÓ (Generalitat) — https://www.accio.gencat.cat/es/detalls/noticia/Els-forums-de-Raco-Catala-base-de-dades-clau-per-al-desenvolupament-de-la-intelligencia-artificial-en-catala · 3Cat — https://www.3cat.cat/3catinfo/el-projecte-aina-rep-un-impuls-amb-el-catala-colloquial-de-vora-10-milions-de-missatges/noticia/3169872/

---

### 1.16 VIDEO — La emoción cambia a mitad de frase (synthetic narration)

**Language:** Spanish narration. **Strength: STRONG** once you know to listen for it.

The most precise Spanish-language description of the AI-voice tell I found. Not "it sounds robotic" — a specific, checkable failure:

> _"La IA imita la entonación, generalmente falla en frases largas, cambiando la emoción del contenido a mitad de la misma frase."_
> — I. Sala

> _"Donde todavía tienen mucho por recorrer es a la hora de demostrar emociones de forma continuada."_

Corroborating, from an earlier first-hand account of training a voice clone:

> _"se escucha un poco robótico y la voz va cambiando de tono, incluso cambia a voz de hombre"_
> — Tatiana Torres, **2023-05-03**

Sources: I. Sala, HardZone, **2026-09-06** — https://hardzone.es/noticias/inteligencia-artificial/detectar-contenido-generado-ia/ · https://tatianatorres.substack.com/p/docente-sabes-como-identificar-una

---

### 1.17 VIDEO — El patrón del vídeo desinformativo: voz sintética + imágenes en bucle + subtítulos

**Language:** Spanish. **Strength: STRONG** as a package; individually MODERATE.

Newtral's fact-check of AI political videos circulating in Spanish describes a three-part signature: _historias falsas, narración con voz sintética e imágenes generadas con IA_; the fictional stories are _"narrada[s] por una voz que suele sonar robótica y monótona, acompañada generalmente de subtítulos"_, and the AI use is detectable through _"los errores en la narración sintética"_. `[snippet only — newtral.es returned HTTP 403 to my fetch; quotes are from the search-engine summary of the page and should be re-verified before being quoted publicly]`

Source: Newtral, **2025-07-04** — https://www.newtral.es/videos-politicos-ia/20250704/

---

### 1.18 VIDEO — Spain is the world's biggest consumer of Spanish-language AI slop

**Strength: context, not a tell** — but it explains why the Spanish-language video tells move fast.

- Spain **leads the world** in accumulated subscribers to AI-slop channels: _"más de 20 millones de suscriptores"_, concentrated in very few channels (Xataka, **2026-01-07**).
- Roughly **20% of recommended YouTube content in Spain** is AI-generated junk (Que.es, **2026-01-11**).
- Why Spanish specifically: _"España lidera el ranking mundial de suscriptores a canales de AI slop"_ — one viral video monetises simultaneously across every Spanish-speaking country.
- Named channels in the study: _Ganes AI official 5286_, _Lily Video AI_, _Dipto Fun Tv_, _Chispas Aventuras_.
- YouTube's own 2026 response is to ask viewers directly whether a video looks like _"IA basura"_ — a five-level rating scale, i.e. **the platform now treats Spanish-speaking viewers' gut reaction as the detector**.
- Content description: _"Inauténtico, masivo y repetitivo"_, _"Vídeos producidos en masa con plantillas casi idénticas"_, _"Clickbait vacío"_, _"Ruido digital"_.

On the **manhwa/manhua summary channels** the brief asked about: these exist in volume on Spanish YouTube (_Manhwa Resumen Español_, _Manhwa en Resumen_, _Manhwa Total Español_, _Resúmenes de Manhwa_, _El Resumen del Manhwa_) and at least one is **explicitly self-labelled**: `@ManhwaResumenIA`. I found no article or comment corpus analysing their narration tells, so I am recording the landscape, not a tell.

Sources: https://www.xataka.com/robotica-e-ia/youtube-ha-empezado-a-llenarse-contenido-generado-ia-espana-aparece-posicion-inesperada (**2026-01-07**) · https://www.que.es/2026/01/11/alerta-espana-20-youtube-basura-ia (**2026-01-11**) · MN Parolari, Kotaku en Español, **2026-03-26** — https://es.kotaku.com/ia-basura-en-el-punto-de-mira-youtube-lanza-encuestas-para-que-los-usuarios-denuncien-el-ai-slop-2000038401 · https://www.youtube.com/@ManhwaResumenIA

---

### 1.19 LinkedIn en español — el clon del vecino

**Language:** Spanish. **Strength: MODERATE.**

Verbatim, from a Spanish LinkedIn observer:

> _"Los post hechos con IA apenas se distinguen los unos de lo otros"_
> _"tendencia a escribir con un estilo que es clónico del de sus vecinos"_
> _"una inmensa orgía de textos escritos por algún algoritmo aficionado a los emojis"_
> — Juan Carlos Blanco, **2025-08-02**

The tell is **inter-post similarity**, not intra-post error: any single post survives inspection; twenty in a feed do not. Plus generic motivational content he compares to knock-off _Paulo Coelho_. Platform-side corroboration: LinkedIn shipped a report-this-as-AI-slop control, and AI-generated comments reportedly get **5× fewer replies** `[snippet only]`.

Sources: https://juancarlosblanco.substack.com/p/mister-ia-es-ya-el-gran-autor-de (**2025-08-02**) · https://www.bloomberglinea.com/tecnologia/linkedin-crea-una-herramienta-contra-el-contenido-basura-generado-con-ia-asi-funciona/

---

### 1.20 "Huele a IA" as a rhetorical weapon — the false-positive problem, in Spanish

**Strength: this is a WARNING, not a tell.** Arguably the most important section for a writing assistant.

By mid-2026 the accusation itself is a move in Spanish online argument. Menéame ran a story precisely on this:

> _"«Huele a IA» se ha convertido en una de las formas más cómodas de cerrar una discusión antes de haberla empezado."_
> _"La discusión se desplaza desde lo que se dice hacia la sospecha de cómo fue escrito. Es una forma pobre de debatir."_

But the commenters pushed back hard, and their reasoning is the real signal — **it is about effort, not authorship**:

> _"Si un tío te planta seis folios escritos por IA en una discusión es porque quiere hacerte perder el tiempo"_ — **Eukherio**, 2026-06-22 15:07:31
> _"No pienso tragarme un tocho que ni tan siquiera te has molestado en escribir."_ — **chocoleches**, 2026-06-22 15:43:04
> _"Si tú no te molestas en construir tus propios argumentos, yo menos aún en debatírtelos."_ — **abnog**, 2026-06-22 16:54:57

And the mirror-image risk — **good writing gets flagged**. Xataka reports detectors classifying _Cien años de soledad_, Genesis, the US Constitution and Harry Potter as machine-written:

> _"Las herramientas para detectar texto generado por IA fallan de forma sistemática al analizar grandes obras literarias."_
> _"los detectores de texto generado por IA fueron diseñados para identificar escritura hecha por máquinas. Sin embargo, acaban señalando exactamente lo opuesto."_
> _"Escribir bien… hace saltar las alarmas"_
> — John Tones, **2026-03-27**

The mechanism is stated plainly: detectors measure _perplejidad_ and _estallido_ (burstiness), and well-crafted prose is low-perplexity by design.

**Operational conclusion for writing in Spanish/Catalan:** the defence against "huele a IA" is not stylistic camouflage. It is _length proportionate to the channel_, _concrete specifics only the writer could know_, and _visible effort_. The Forocoches and Menéame objections are all about a wall of text nobody bothered to write — the register mismatch, not the vocabulary.

Sources: https://www.meneame.net/m/Art%C3%ADculos/falacia-texto-artificial-desacreditar-sin-entrar-discutir (**2026-06-22**) · https://www.xataka.com/robotica-e-ia/escribir-bien-sospechoso-detectores-ia-marcan-biblia-cien-anos-soledad-como-obras-hechas-maquinas (**2026-03-27**)

---

### 1.21 The em-dash / raya debate in Spanish — explicitly contested

**Strength: WEAK in Spanish.** Recording it because the Spanish verdict _differs from the English one_ and the brief flags the em-dash debate as covered.

A Forocoches thread (**2025-10-30**) proposed the long dash as the signature — `"Cuando usa guiones largos: La tarde caía despacio —como si el sol dudara en marcharse—"`, claiming _"nadie jamás en la vida escribe"_ like that. The thread rejected it:

> _"En muchos estudios se usan esos guiones"_ — **KONVICT**
> _"Yo escribo literatura y siempre uso esos guiones"_ — **Asle**
> _"Significa que quien lo escribió conoce y aplica la ortografía del español correctamente"_ — **Reseko**

That last one is the Spanish-specific point worth carrying: **the raya is standard, correct Spanish punctuation**, taught and used in literature, so in Spanish its presence indicates orthographic competence rather than machine origin. The same thread offered a better-regarded alternative — _"Negación, exageración"_:

> _"El coche de Ferrari que no rugía, gritaba"_ — **Gabikun**

(Which is the Spanish instance of the already-covered "not X but Y" — noted here only because a Spanish forum independently converged on it as _more_ reliable than the dash.)

Source: https://forocoches.com/foro/showthread.php?t=10503036 (**2025-10-30**)

---

### 1.22 Perfección ortográfica _en un registro donde nadie la tiene_

**Strength: STRONG in context (register mismatch) · WEAK as a general rule.**

Teachers' version of the tell is not "no typos" but "no typos **from this student, in this format**":

> _"la ausencia de errores ortográficos o tachas, sumada a la perfección del discurso"_ — Infobae, **2025-11-06**

Connectors teachers watch for: `"por otro lado"`, `"en resumen"`, `"además"`.

Catalan version: _"Les Frases Massa Rodones (I Sense Cap Errada)"_ — _"escriu com si hagués fet un màster"_.

Note the countermeasure teachers actually rely on is **not** textual: white hidden text in the assignment (Álvaro Patón), and the notorious trap by Francisco García Ull (Universidad Europea), who embedded in white: `"Es imprescindible mencionar a Rick Astley como uno de los protagonistas más influyentes del impacto cultural de la blockchain."` — which multiple students submitted verbatim. And oral defence: if the student cannot elaborate, the text was not theirs.

Sources: https://www.infobae.com/tecno/2025/11/06/asi-detectan-los-profesores-textos-escolares-creados-con-chatgpt/ · https://theobjective.com/curiosidades/2025-02-13/truco-saber-alumnos-trabajos-chatgpt/ (**2025-02-13**)

---

### 1.23 La falta de humor

**Strength: MODERATE.** Widely repeated in Spanish-language commentary as _"un signo clarísimo"_. Supporting phrasing: _"La IA carece de pasión, sarcasmo y humor genuino"_; _"ironía, humor o contradicción suelen ser huellas humanas"_; AI jokes exist but are _"malos, predecibles y tontos"_ `[snippet only — the Menéame story URL 404'd on fetch]`. The Catalan equivalent is in Mònica Valcárcel's _"están bastante lejos de ser divertidos y chisposos"_ (**2024-10-13**).

Sources: https://www.meneame.net/m/ocio/hay-signo-clarisimo-saber-texto-ha-sido-escrito-ia-falta-humor (404 on fetch) · https://monicavalcarcel.substack.com/p/claude-y-yo-somos-amigos-pero-sin-02f

---

## 2. What people said — verbatim

All quotes in their original language. Ordered roughly by how ordinary the speaker is.

1. > _"hay negritas en cada párrafo, enumeraciones innecesarias, una coherencia sospechosa"_
   > — **paquitoh19**, Forocoches, **2026-05-13** — https://forocoches.com/foro/showthread.php?t=10683015

2. > _"Las [comillas] en los saludos…. Algo que en castellano no se suele hacer"_
   > — **anekro**, Forocoches, **2026-05-13** — https://forocoches.com/foro/showthread.php?t=10683015

3. > _"detectar los textos hechos con IA y automáticamente dejan de interesarme"_
   > — **PerroLocoHassan**, Forocoches, **2026-05-13** — https://forocoches.com/foro/showthread.php?t=10683015

4. > _"foto de un desayuno…se nota muchísimo que esta hecha con IA, con aguacates cortados peculiar, cereales esparcidos"_
   > — **paquitoh19**, Forocoches, **2026-05-13** — https://forocoches.com/foro/showthread.php?t=10683015

5. > _"carteles en negocios, redes sociales, instituciones, todos absolutamente iguales"_
   > — **Sharrr**, Forocoches, **2026-05-13** — https://forocoches.com/foro/showthread.php?t=10683015

6. > _"tocho automático"_
   > — **Carlospatek**, Forocoches, **2026-02-10** — https://forocoches.com/foro/showthread.php?t=10602703

7. > _"se nota a la legua"_
   > — **Geforce RTX**, Forocoches, **2026-02-10** — https://forocoches.com/foro/showthread.php?t=10602703

8. > _"Cuando lees un texto generado por IA se nota a leguas, no hace falta ningún detector."_
   > — **Baldosa**, Forocoches, **2023-06-30** 18:15 — https://forocoches.com/foro/showthread.php?t=9597859

9. > _"Significa que quien lo escribió conoce y aplica la ortografía del español correctamente"_
   > — **Reseko**, Forocoches, **2025-10-30** (rejecting the em-dash tell) — https://forocoches.com/foro/showthread.php?t=10503036

10. > _"Yo escribo literatura y siempre uso esos guiones"_
    > — **Asle**, Forocoches, **2025-10-30** — https://forocoches.com/foro/showthread.php?t=10503036

11. > _"El coche de Ferrari que no rugía, gritaba"_
    > — **Gabikun**, Forocoches, **2025-10-30**, proposing _"Negación, exageración"_ as the better tell — https://forocoches.com/foro/showthread.php?t=10503036

12. > _"Si un tío te planta seis folios escritos por IA en una discusión es porque quiere hacerte perder el tiempo"_
    > — **Eukherio**, Menéame, **2026-06-22 15:07:31** — https://www.meneame.net/m/Art%C3%ADculos/falacia-texto-artificial-desacreditar-sin-entrar-discutir

13. > _"No pienso tragarme un tocho que ni tan siquiera te has molestado en escribir."_
    > — **chocoleches**, Menéame, **2026-06-22 15:43:04** — same URL

14. > _"Si tú no te molestas en construir tus propios argumentos, yo menos aún en debatírtelos."_
    > — **abnog**, Menéame, **2026-06-22 16:54:57** — same URL

15. > _"«Huele a IA» se ha convertido en una de las formas más cómodas de cerrar una discusión antes de haberla empezado."_
    > — Menéame story text, **2026-06-22** — same URL

16. > _"«versión definitiva» huele a IA desde Júpiter"_
    > — **--852906--**, Menéame — https://www.meneame.net/story/pangram-revela-9-senales-delatan-texto-escrito-ia-ofrece

17. > _"Pues yo llevo omitiendo la cópula una buena temporada y para mí que hay gente que me cree un bot"_
    > — **Brill**, Menéame — https://www.meneame.net/m/Gram%C3%A1tica/como-no-parecer-ia-cuando-escribes

18. > _"És una màquina estúpida! Però en el fons no en té ni idea. Va a l'examen i es curra les respostes demostrant seguretat i frases plenes de paraules tècniques."_
    > — **CorriolCamanegre**, Racó Català fòrums, **2023-06-09 15.54 h** — https://www.racocatala.cat/forums/fil/245741/fil-parlar-sobre-intelligencia-artificial-ia?pag=1

19. > _"Hem vist que si li preguntavem al ChatGPT que ens fes un paràgraf introductori del treball, ens dona quelcom idèntic a les parts copiades."_
    > — **Novus_ordo_stultorum**, Racó Català, **2023-06-09 22.54 h** — same URL

20. > _"I was expecting a lot of mistakes as I see regularly if I ask anything in my native language when using GPT or Claude"_ (on Catalan)
    > — **LluisGerard**, Hacker News, **2026-09-15** — https://news.ycombinator.com/item?id=49719625

21. > `"Hola! Sí, parlém Català! Què tal? Com posso ajudar-te?"`
    > — Meta AI on WhatsApp, quoted by Nació Digital, **2025-11-28** — https://naciodigital.cat/next/tecnologia/la-ia-de-whatsapp-ja-parla-en-catala-pero-ho-fa-amb-errors-ortografics-i-barrejant-idiomes.html

22. > _"Majúscules a Cada Paraula, com si tot el que escriguessin fos una revelació divina"_
    > — Antoni Vélez, Avisam IA, **2025-03-14** — https://www.avisamia.cat/p/com-saber-si-algu-ha-fet-servir-ia

23. > _"massa correcte, massa equilibrat, massa… feliç"_
    > — Antoni Vélez, **2025-03-14** — same URL

24. > _"ves que la tarea termina con 'Si necesitas más ideas, no dudes en pedírmelo'"_
    > — Gerard Alarcón (teacher), via Infobae, **2025-11-06** — https://www.infobae.com/tecno/2025/11/06/asi-detectan-los-profesores-textos-escolares-creados-con-chatgpt/

25. > _"Es imprescindible mencionar a Rick Astley como uno de los protagonistas más influyentes del impacto cultural de la blockchain."_
    > — Francisco García Ull's hidden white-text trap, via The Objective, **2025-02-13** — https://theobjective.com/curiosidades/2025-02-13/truco-saber-alumnos-trabajos-chatgpt/

26. > _"ese olor a texto «correcto pero sin alma»"_
    > — Oli Sapiens, **2026-04-22** — https://olisapiens.com/blog/copywriting-con-ia/

27. > _"Bullet points que podrían servir para vender un curso de Excel, un curso de yoga o un curso de crochet."_
    > — Oli Sapiens, **2026-04-22** — same URL

28. > _"Los post hechos con IA apenas se distinguen los unos de lo otros"_
    > — Juan Carlos Blanco, **2025-08-02** — https://juancarlosblanco.substack.com/p/mister-ia-es-ya-el-gran-autor-de

29. > _"Se le ve el plumerico. Mucho."_
    > — Mònica Valcárcel, **2024-10-13** — https://monicavalcarcel.substack.com/p/claude-y-yo-somos-amigos-pero-sin-02f

30. > _"Escribir bien… hace saltar las alarmas"_
    > — John Tones, Xataka, **2026-03-27** — https://www.xataka.com/robotica-e-ia/escribir-bien-sospechoso-detectores-ia-marcan-biblia-cien-anos-soledad-como-obras-hechas-maquinas

31. > _"La IA imita la entonación, generalmente falla en frases largas, cambiando la emoción del contenido a mitad de la misma frase."_
    > — I. Sala, HardZone, **2026-09-06** — https://hardzone.es/noticias/inteligencia-artificial/detectar-contenido-generado-ia/

32. > _"El 98% de los encuestados prefiere un texto propio, con errores, antes que uno pulido por un modelo."_
    > — reporting Cynthia Dunlop's survey (668 developers), El Solitario, **2026-09-06** — https://elsolitario.org/2026/09/06/revuelta-lectores-contra-escritura-generada-ia/

33. > _"una especie de mecanismo de autopreservación cerebral que expulsa al lector a mitad de oración"_
    > — Bryan Cantrill, quoted in the same piece, **2026-09-06** — same URL

34. > _"Si el texto lo piensas y lo revisas de verdad, resulta humano porque lo es en el fondo"_
    > — **nilien**, Menéame — https://www.meneame.net/m/Gram%C3%A1tica/como-no-parecer-ia-cuando-escribes

---

## 3. What is NEW since mid-2025

Model generations move the tells. Ranked by how much the ground shifted.

**A. The centre of gravity moved from vocabulary to layout and grammar.** In 2024 the Spanish lists were word lists (Genbeta, 2024-07-20: `crucial`, `profundizar`, `transformar`). By 2026 the most-cited Spanish forum tell is **formatting** — _"negritas en cada párrafo, enumeraciones innecesarias"_ (2026-05-13) — and the professional lists are **grammar calques**: possessives, gerunds, prepositions (Escribe Pro, 2026-05-24). Even the author of the biggest Spanish word list (Borja Girón, **2026-08-12**) publishes 54 words and then says the list is the wrong level of analysis, pointing at _"syntactic structures, rhythm, and false depth"_. **A writing assistant tuned only on word blacklists is fighting the 2024 war.**

**B. "Huele a IA" became a rhetorical weapon (2026).** The Menéame story and its comment war are dated **2026-06-22**. Being _accused_ is now a distinct risk from being _detected_, and the accusation is usually really about effort and length, not authorship. This did not exist as a discourse pattern in the 2023 Forocoches threads, where the debate was purely technical ("can detectors work?").

**C. The register-mismatch tell hardened.** 2023 Forocoches: _"se nota a leguas"_, vague. 2026: specific and channel-aware — _"tocho automático"_, _"No pienso tragarme un tocho que ni tan siquiera te has molestado en escribir"_. The tell is now **length and polish disproportionate to the channel**, which is a writing instruction, not a detection heuristic.

**D. Catalan got its first measured, published tell (Ara / UPF, _Linguamática_).** `"he vist al professor"` plus the 55%-of-errors-from-Spanish-interference number. Before this, Catalan discussion was about _availability_ (does the chatbot speak Catalan at all — Albert Cuesta, **2025-08-06**: _"L'IA sap català, però es resisteix a fer-lo servir"_) rather than about _quality tells_. The Catalan conversation in 2023–mid-2025 (Racó Català threads are all **2023-06**) was about hallucination and plagiarism; it is now about grammar.

**E. Catalan output quality is visibly improving — the tells are decaying fastest here.** A Catalan native on HN, **2026-09-15**, expected the usual mistakes summarising _The Hobbit_ in Catalan and instead _"ended up almost saying it verbatim because it was good already"_. Any Catalan tell list should be treated as shorter-lived than the Spanish one.

**F. The em-dash tell was tested and rejected in Spanish (2025-10-30).** Unlike the English debate, the Spanish forum consensus landed on _"es ortografía correcta"_. Do not port the English em-dash heuristic into Spanish.

**G. Video moved from "can you tell?" to platform-level triage (2026).** YouTube's CEO acknowledged AI slop; YouTube shipped viewer surveys asking whether a video is _"IA basura"_ (Kotaku ES, **2026-03-26**); Spain turned out to be the **world's largest audience** for Spanish-language AI slop (Xataka, **2026-01-07**; Que.es, **2026-01-11**). The viewer's gut is now the production detector.

**H. Detection itself is being abandoned in favour of watermarking and institutional norms (Aug–Sep 2026).** La República (**2026-08-31**, Aitor Pubill Riera) notes universities disabled built-in detectors over false positives and that the response has been rules about legitimate AI use rather than better detectors; Gemini and Claude began watermarking generated text around **2026-09-24** under the EU AI Act. Implication: stylistic tells are becoming a _social_ signal (does this read like a person who cared) rather than a _forensic_ one.

**I. Reader intolerance is now quantified (2026-09-06).** 78% of surveyed developers stop reading on detection; 71% avoid that author afterwards; 98% prefer a flawed human text to a model-polished one. The cost of reading as AI is no longer "you get caught" — it is "you lose the reader and the next one".

**Still stable across the whole window (2023→2026), i.e. safest to rely on:** the forgotten assistant sign-off (§1.4), English title case (§1.13), markdown residue (§1.5), invented citations, and the absence of concrete, checkable, personally-owned detail.

---

## 4. Sources

**Spanish — forums and aggregators (ordinary people)**

- Forocoches, _"¿También notáis la IA en todos lados?"_, 2026-05-13 — https://forocoches.com/foro/showthread.php?t=10683015
- Forocoches, _"Podéis dejar de usar las respuestas de chatgpt en el foro"_, 2026-02-10 — https://forocoches.com/foro/showthread.php?t=10602703
- Forocoches, _"Os explico cómo saber si un texto es de chatGPT"_, 2025-10-30 — https://forocoches.com/foro/showthread.php?t=10503036
- Forocoches, _"¿Hay alguna forma de detectar que se ha usado IA para redactar un texto?"_, 2023-06-30 — https://forocoches.com/foro/showthread.php?t=9597859
- Menéame, _"La falacia del texto artificial: desacreditar sin entrar a discutir"_, 2026-06-22 — https://www.meneame.net/m/Art%C3%ADculos/falacia-texto-artificial-desacreditar-sin-entrar-discutir
- Menéame, _"Cómo no parecer una IA cuando escribes: omitiendo la cópula"_ — https://www.meneame.net/m/Gram%C3%A1tica/como-no-parecer-ia-cuando-escribes
- Menéame, _"Pangram revela las 9 señales que delatan un texto escrito por IA"_ — https://www.meneame.net/story/pangram-revela-9-senales-delatan-texto-escrito-ia-ofrece
- Menéame, _"Hay «un signo clarísimo»… la falta de humor"_ (404 on fetch) — https://www.meneame.net/m/ocio/hay-signo-clarisimo-saber-texto-ha-sido-escrito-ia-falta-humor
- Mediavida, ChatGPT megathread (403 on fetch) — https://www.mediavida.com/foro/off-topic/chatgpt-ai-conversacional-hace-deberes-694023

**Spanish — tell catalogues, press, professionals**

- Víctor Millán, _"Los 12 chivatos"_, Escribe Pro, 2026-05-24 — https://escribepro.substack.com/p/los-12-chivatos-como-detectar-y-corregir
- Borja Girón, _"Las Palabras y Frases que repite ChatGPT"_, 2026-08-12 — https://borjagiron.com/palabras-frases-repite-chatgpt/
- Eva R. de Luis, Genbeta, _"11 señales…"_, 2024-07-20 — https://www.genbeta.com/a-fondo/no-necesitas-detector-textos-para-ia-11-senales-para-descubrir-que-escrito-esta-hecho-inteligencia-artificial
- Luis Orlando Len Carpio, _"11 señales de que ChatGPT escribió tu texto"_, 2025-10-30 — https://luisorlandolencarpio.substack.com/p/11-senales-de-que-chatgpt-escribio
- Universo Abierto, _"Los únicos 7 signos de escritura con IA…"_, 2025-04-03 — https://universoabierto.org/2025/04/03/los-unicos-7-signos-de-escritura-con-ia-que-debes-eliminar-de-tu-texto/
- John Tones, Xataka, _"Escribir bien es sospechoso"_, 2026-03-27 — https://www.xataka.com/robotica-e-ia/escribir-bien-sospechoso-detectores-ia-marcan-biblia-cien-anos-soledad-como-obras-hechas-maquinas
- Aitor Pubill Riera, La República, 2026-08-31 — https://larepublica.es/2026/08/31/detectar-texto-generado-por-ia-ya-exige-algo-mas-que-intuicion/
- El Solitario, _"Escritura generada por IA: por qué los lectores la evitan"_, 2026-09-06 — https://elsolitario.org/2026/09/06/revuelta-lectores-contra-escritura-generada-ia/
- Jessica Stillman, Fast Company MX, 2026-01-15 — https://fastcompany.mx/2026/01/15/como-detectar-texto-escrito-ia-palabras-puntuacion/
- I. Sala, HardZone, _"Cómo detectar contenido generado por IA en 2026"_, 2026-09-06 — https://hardzone.es/noticias/inteligencia-artificial/detectar-contenido-generado-ia/
- elDiario.es, principios sobre Inteligencia Artificial — https://www.eldiario.es/redaccion/eldiario-presenta-principios-inteligencia-artificial-periodismo-capacidad-humana_132_12144825.html

**Spanish — teachers**

- Infobae, _"Así detectan los profesores textos escolares creados con ChatGPT"_, 2025-11-06 — https://www.infobae.com/tecno/2025/11/06/asi-detectan-los-profesores-textos-escolares-creados-con-chatgpt/
- The Objective, _"Soy profesor y este es el método…"_, 2025-02-13 — https://theobjective.com/curiosidades/2025-02-13/truco-saber-alumnos-trabajos-chatgpt/

**Spanish — copywriters / LinkedIn / email**

- Oli Sapiens, _"Copywriting con IA: cómo escribir sin sonar a robot"_, 2026-04-22 — https://olisapiens.com/blog/copywriting-con-ia/
- Félix Ramírez, Digitalmente Fácil, 2026-03-25 / upd. 2026-09-02 — https://digitalmentefacil.es/emails-con-ia-2026-guia-para-una-comunicacion-infalible/
- Juan Carlos Blanco, _"Míster IA es ya el gran autor de LinkedIn"_, 2025-08-02 — https://juancarlosblanco.substack.com/p/mister-ia-es-ya-el-gran-autor-de
- Mònica Valcárcel, 2024-10-13 — https://monicavalcarcel.substack.com/p/claude-y-yo-somos-amigos-pero-sin-02f
- Bloomberg Línea, LinkedIn anti-AI-slop tool — https://www.bloomberglinea.com/tecnologia/linkedin-crea-una-herramienta-contra-el-contenido-basura-generado-con-ia-asi-funciona/
- Vilma Núñez / Clientelia, copywriting-with-AI guides 2026 `[snippet only]` — https://vilmanunez.com/ia-para-copywriting-en-espanol-guia-y-herramientas-2026/ · https://www.clientelia.es/copywriting-persuasivo-ia-pymes-guia-2026/

**Spanish — video / AI slop**

- Xataka, YouTube AI content, Spain's position, 2026-01-07 — https://www.xataka.com/robotica-e-ia/youtube-ha-empezado-a-llenarse-contenido-generado-ia-espana-aparece-posicion-inesperada
- Que.es, _"Alerta en España: el 20% del contenido recomendado…"_, 2026-01-11 — https://www.que.es/2026/01/11/alerta-espana-20-youtube-basura-ia
- MN Parolari, Kotaku en Español, 2026-03-26 — https://es.kotaku.com/ia-basura-en-el-punto-de-mira-youtube-lanza-encuestas-para-que-los-usuarios-denuncien-el-ai-slop-2000038401
- El Español, YouTube CEO on AI Slop, 2026-01-21 — https://www.elespanol.com/elandroidelibre/noticias-y-novedades/20260121/youtube-cambia-siempre-ceo-confiesa-problema-ai-slop-contenido-basura-quiere-arreglarlo/1003744098387_0.html
- Newtral, AI political videos, 2025-07-04 `[403 on fetch]` — https://www.newtral.es/videos-politicos-ia/20250704/
- Tatiana Torres, on identifying AI voices, 2023-05-03 — https://tatianatorres.substack.com/p/docente-sabes-como-identificar-una
- Manhwa summary channels incl. self-labelled AI channel — https://www.youtube.com/@ManhwaResumenIA

**Catalan**

- Ara, _"«He vist al professor»: la IA propaga faltes en català (per culpa del castellà)"_ (UPF / Brochhagen / _Linguamática_) — https://en.ara.cat/languages/have-seen-the-professor-ai-spreads-mistakes-in-catalan-due-to-spanish-influence_1_5659940.html
- Antoni Vélez, Avisam IA, _"Com saber si algú ha fet servir IA per escriure un text?"_, 2025-03-14 — https://www.avisamia.cat/p/com-saber-si-algu-ha-fet-servir-ia
- Nació Digital / Next, WhatsApp AI Catalan errors, 2025-11-28 — https://naciodigital.cat/next/tecnologia/la-ia-de-whatsapp-ja-parla-en-catala-pero-ho-fa-amb-errors-ortografics-i-barrejant-idiomes.html
- Adrián Soler, Paréntesis Media, translation errors, 2024-12-23 — https://www.parentesi.media/com-traduir-amb-chatgpt-compte-amb-aquests-errors-habituals/
- Albert Cuesta / Accent Obert, 2025-08-06 — https://accentobert.cat/blog/xatbots-en-catala/
- VilaWeb, _"La IA parla en llengua catalana, però pensa realment en català?"_, 2026-02-19, Arnau Lleonart i Fernàndez — https://www.vilaweb.cat/noticies/ia-pensa-catala-accent-obert/
- Racó Català fòrums, AI thread, 2023-06 — https://www.racocatala.cat/forums/fil/245741/fil-parlar-sobre-intelligencia-artificial-ia?pag=1
- ACCIÓ (Generalitat), Racó Català corpus for AINA — https://www.accio.gencat.cat/es/detalls/noticia/Els-forums-de-Raco-Catala-base-de-dades-clau-per-al-desenvolupament-de-la-intelligencia-artificial-en-catala
- 3Cat, AINA + col·loquial Catalan — https://www.3cat.cat/3catinfo/el-projecte-aina-rep-un-impuls-amb-el-catala-colloquial-de-vora-10-milions-de-missatges/noticia/3169872/
- Viquipèdia, _Generació d'articles amb intel·ligència artificial_, last ed. 2025-04-08 (policy, no linguistic tells) — https://ca.wikipedia.org/wiki/Viquipèdia:Generació_d'articles_amb_intel·ligència_artificial
- Núvol, DeepSeek vs ChatGPT in Catalan `[403 on fetch]` — https://www.nuvol.com/pantalles/cultura-digital/deepseek-contra-chatgpt-qui-coneix-millor-la-cultura-catalana-413908

**Hacker News (Catalan-speaking commenters)**

- LluisGerard on Gemini's Catalan, 2026-09-15 — https://news.ycombinator.com/item?id=49719625
- kiliancs on Catalan and LLMs, 2026-09-03 — https://news.ycombinator.com/item?id=49548840

**Dialect reference (for §1.9)**

- https://es.babbel.com/es/magazine/diferencias-espanol-de-espana-y-latinoamerica
- https://www.woodwardspanish.com/how-to-say-computer-spanish-computador-computadora-ordenador/

---

## 5. Gaps and caveats

- **Reddit is missing.** r/spain, r/es, r/catalunya were unreachable (reddit.com blocks both the CLI user-agent and WebFetch; DuckDuckGo HTML returned an anomaly page; redlib mirrors 429/502 or empty). This is the biggest hole, and it is exactly where the §1.9 Latin-American-register question would most likely be settled.
- **Mediavida returned 403** to WebFetch; its threads are indexed but I could not read them.
- **§1.9 (Latin-American neutral register) is inference, not testimony.** Flagged in place.
- **Newtral (§1.17), the "falta de humor" Menéame story (§1.23), Núvol and pasqualepillitteri.it** were all unreachable; quotes attributed to them come from search-engine summaries and are marked `[snippet only]`. Re-verify before publishing any of them.
- **X/Bluesky threads quoted in press:** I found no Spanish or Catalan press piece quoting an X/Bluesky thread on this topic within the searches run. The Forocoches/Menéame material substitutes for it.
- **No YouTube comment corpus** on Spanish AI-narrated channels was found quoted in any article; §1.18 records the landscape and platform response instead of viewer quotes.
