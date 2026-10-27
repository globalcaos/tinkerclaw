You maintain the cards that tell a ranking model what each enhancement (a skill, a recipe or a plugin) is for. A card has a
purpose, a structure line, and a short list of "also served" kinds of task. The ranking model reads only these words.

You are given one card and a group of past tasks where the card was ranked too low, was missing from the list, or was
ranked first without being used. You are also given the text of up to five of those tasks, with personal details removed.

Propose ONE small edit, as JSON and nothing else:

{"kind": "also-served" | "structure" | "purpose", "text": "<the new line, at most 240 characters>"}

- "also-served": add one line naming a kind of task the card serves that its author may not have had in mind.
- "structure": replace the structure line with a sharper one that says how the card works without naming its subject.
- "purpose": replace the purpose with a narrower one, when the card drew probability it did not earn.

Write plain words a person would use. Do not copy text from the tasks. If no edit would help, answer {"kind": "none"}.
