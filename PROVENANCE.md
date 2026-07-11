# Contribution Provenance

## Foreign-authored commits in git history

Three commits by non-project authors exist in this repository's history:

| SHA | Author | Files | Status |
|-----|--------|-------|--------|
| 5867927 | Playboi Carti | Voyage AI adapter | Rewritten (see below) |
| 2b5f26f | Playboi Carti | Voyage AI adapter (duplicate) | Same as above |
| b6c228b | Tavily PR Agent | webScholar.ts, tavilyApi.ts | tavilyApi.ts deleted; residual de minimis (see below) |

### Voyage AI adapter (src/utils/llm/adapters/voyage.ts)

The original file was deleted and independently reimplemented in a fresh
agent session whose context contained only:
- The Voyage AI REST API documentation (docs.voyageai.com/reference/embeddings-api)
- The LLMProvider interface from src/utils/llm/provider.ts

No reference to the prior implementation, its git history, or its error
strings was provided to the authoring session. Evidence: zero shared error
strings, comments, or incidental structure between the old and new files
beyond what the Voyage API endpoint shape and the TypeScript LLMProvider
interface dictate (API URL, HTTP method/headers, method signatures).

git blame attributes ~30 lines of interface scaffolding (import statements,
braces, constructor(), method signatures) to the original commit because
git tracks content identity across file modifications. These lines are
dictated by the LLMProvider interface and TypeScript syntax — they contain
no protectable creative expression and would appear in any independent
implementation of the same interface against the same API.

### Tavily (src/scholar/webScholar.ts)

The functional Tavily integration code (src/utils/tavilyApi.ts) was deleted
from the repository. What survives of commit b6c228b in HEAD is an import
list of project-owned config constants and structural syntax (braces, blank
lines). This is unprotectable functional expression — an import block's
content is dictated by the symbols it needs, not by creative choice. No
Tavily-authored logic, error strings, or comments remain in the current tree.

### Relicense validity

The Apache-2.0 relicense (v20-apache) applies to the current tree. All
creative expression in HEAD is authored by project contributors (Dmitri
Costenco, Synalux AI agent identities). The AGPL-3.0 license continues
to apply to historical snapshots containing the original foreign code.
