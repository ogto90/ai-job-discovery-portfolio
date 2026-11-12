# Candidate Evidence Profile

`candidate_profile.py` defines a profession-neutral candidate source of truth
for future job matching. It is intentionally evidence-backed rather than a
flat keyword list: capabilities and tools refer to provenance items containing
the CV section, role/employer, dates, and exact or near-exact CV text.

Evidence levels are conservative:

- `4`: explicit ownership, leadership, or implementation in real professional work.
- `3`: direct hands-on professional experience with clear work-history evidence.
- `2`: practical exposure, use, evaluation, or a proof of concept with limited depth or ownership.
- `1`: fundamentals, learning, skills-only, old/one-off, or weakly adjacent evidence.
- `0`: no evidence.

Skills-only and fundamentals evidence cannot claim professional experience or
ownership. Ownership requires real-work evidence, and level 4 requires both
professional experience and ownership. Individual capability years are not
inferred from a tool or skill name.

`matching.domains` contains optional profession-specific semantic rules. The
generic normalizer does not know that a cybersecurity tool maps to a named
security capability; domain rules may add that relationship while preserving
the original provenance and evidence strength.

`search_profile.py` defines typed, user-owned search preferences. Search
profiles are intentionally separate from candidate evidence and may represent
different career directions for the same person.

Later CV parsing must populate this model conservatively and preserve every
provenance reference. Later job evaluation must use this profile instead of
freely inferring capabilities from raw CV text. This layer does not call the
OpenAI API, connect to Supabase, or implement matching/UI behavior.
