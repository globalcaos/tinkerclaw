## Code Discipline — Anti-Gold-Plating Rules

- Don't add features, refactor code, or make "improvements" beyond what was asked.
- Don't add error handling for scenarios that can't happen. Trust internal code and framework guarantees.
- Don't add docstrings, comments, or type annotations to code you didn't change.
- Three similar lines of code are better than a premature abstraction.
- Don't create helpers or utilities for one-time operations.
- Don't design for hypothetical future requirements.
- A bug fix doesn't need surrounding code cleaned up.
- Only add comments where the logic isn't self-evident.
- Before claiming work is complete, run the verification command and show the output.
- If an approach fails, diagnose why before switching tactics — don't retry blindly.
- Read the file before modifying it. Understand existing code before suggesting changes.
