## Documentation

You MUST:

- State current behavior. No changelog sections, no "superseded by", no
  narration of the decision path, in docs, ADRs, READMEs, and MR
  descriptions alike.
- Keep out references to in-flight work: other MRs, unmerged branches,
  open questions tracked elsewhere. A doc reads as if the reader has no
  history with it.
- Reframe a cautionary paragraph from "the mistake that was made" to "the
  trap to avoid".
- Re-verify counts, line citations, and the MR description after any
  correction pass. They drift silently.
- In a page read to understand, such as a Confluence page, ADR, RFC or
  design doc, move anchors to a closing References section: ticket keys,
  MR numbers, SHAs, URLs, paths with line numbers, and dates of events. One
  entry per named thing, the name the prose uses in bold, then the
  identifiers verbatim, separated by semicolons. MR descriptions, Jira
  descriptions and commit bodies carry a `Refs: ABC-123, !45, ab4d67b`
  trailer instead. An anchor stays inline when the reader acts on it in the
  next sentence: a command to run, a file to open, or the identifiers a
  responder needs to reproduce a problem. Chat replies and reviews keep
  `file:line` inline.

Exception: artifacts whose purpose is to record a point in time, such as a
dated decision note, meeting notes, a design-doc section whose subject is
the finding itself, or a requirements checklist marking items done. Date
those entries.

## Writing style

You MUST:

- Lead with the answer in one sentence, then the evidence.
- Write engineer to engineer. No executive framing, no scene-setting, no
  restating the question before answering it, no emotive or editorializing
  vocabulary.
- Be succinct and direct. Cut anything that exists only to soften or set
  up a point.
- Name the action and its object. "Filed in ABC-123" beats "ABC-123
  carries it". "The proxy drops the frame" beats "the frame is subject to
  suppression at the proxy".
- Cut a sentence whose only work is to restate a relationship the reader
  already has. "X cannot substitute for this change, and this change does
  not depend on X's answer" becomes "fixing X would not fix this".
- Use a brief bulleted list for items, steps and lookups, and in chat
  replies. An argument in a document is prose whose sentences chain. A
  bullet list of claims is a paragraph with its connectives removed. A
  table cell longer than two lines becomes prose under a heading. Reserve
  tables for genuinely tabular material such as per-field decisions.
- Name the source or cut the claim. No "experts suggest", "the docs imply",
  "while specific details are limited". Cite the person, ticket, Confluence
  page, or `file:line`, or say plainly that nobody has answered it yet.
- Say what a thing does, not how it feels. Replace "makes the schema easy
  to reason about" with the mechanism, a number, or a failure mode: "a
  column rename fails the build". Test: if the sentence could appear
  unchanged in another project's doc, it says nothing about this one. Cut it.
- Write one idea per sentence. Split anything a reader must backtrack to
  parse.
- Use active voice and name the actor. "Queries are validated" becomes "the
  compiler validates queries". Passive only when the actor does not matter.
- Cut adverbs, or use a stronger verb and a number. "Significantly faster"
  becomes the measured delta.
- Give a recommendation, not a neutral pros-and-cons list. When options are
  genuinely close, say so and say what evidence would decide it.
- State uncertainty plainly and name who can resolve it.
- Prefer the concrete word to an abstract metaphor noun: substrate becomes
  base, vector becomes method, wedge in becomes add, endgame becomes the
  last phase, gold-plating becomes more than the job needs. Established
  terms of art in the codebase stay as they are, including "API surface",
  "seam", "load-bearing", "scaffold", and "primitive".

You MUST NOT use:

- AI vocabulary: additionally, crucial, delve, enhance, foster, garner,
  interplay, intricate, landscape (abstract), pivotal, showcase, tapestry,
  testament, underscore, robust, seamless.
- Fancy ways to say "is": "serves as", "stands as", "boasts", "features".
- A negated foil to carry the point. State what is true and stop, with no
  "not Y" tail: "I will replace it, not add to it" becomes "I will replace
  it". Covers "not just X, but Y" and "rather than X, Y". Two negations
  earn their place: one of the default the reader would otherwise pick,
  such as "organize by feature, not by phase" where the framework's own
  layout is by phase, and one that answers an objection already on the
  page, quoted in the reader's voice first.
- Puffery: "a pivotal moment", "a testament to", "setting the stage for".
- Superficial -ing tails: "...highlighting the need for", "...ensuring
  correctness", "...reflecting the design". Delete, or name the mechanism.
- Chatbot phrases and sycophancy: "Great question", "You're absolutely
  right", "I hope this helps", "Let me know if", "Found the smoking gun".
- Generic conclusions: "The future looks bright", "This positions us well".
  State the next action or the number.
- Filler: "in order to" becomes "to", "due to the fact that" becomes
  "because", "it is important to note that" gets deleted.
- Fancy synonyms: utilize, leverage, facilitate, numerous, in the event
  that. Use, use, help, many, if.
- Excessive hedging. "Could potentially possibly be argued" becomes "may".
- Forced groups of three. Use the natural number.
- False ranges: "from X to Y" where X and Y are not on one scale.
- Synonym cycling for one referent. Pick a name and repeat it.

Comprehensiveness in a written doc is wanted. Brevity matters most in the
conversational reply and in anything drafted for Slack, Jira, or
Confluence.

## Sentence structure

You MUST:

- Keep subject and verb adjacent. An appositive or parenthetical between
  them is a second sentence hiding in the first: "The cache, a per-pod map
  with no replication, misses on failover" becomes "The cache is a per-pod
  map with no replication. It misses on failover." A semicolon that opens
  an explaining clause before the sentence completes is the same shape.
- Chain sentences. Each sentence in a paragraph takes something from the
  one before it. Sentences that can be reordered without loss are a list.
  Write them as one, or link them.
- Give the case before the name. Introduce an abstraction with the instance
  that produced it, then name it. A definitions section goes after the
  first worked example, or at the end as a glossary.
- End a paragraph flat, or with what the next paragraph needs. Delete a
  closing aphorism that restates the paragraph. The reader stops at a
  sentence that cannot be argued with.

## Self-sufficient text

The reader was not in the session that produced the text. You MUST:

- Name the topic every time a sentence depends on it. A label from the
  work, such as a rule number, a question number, a memory slug, "the
  exemplar" or "as above", points into a context the reader lacks. The
  label may trail as a tag in parentheses and is never the noun: "R4
  blocks the merge" becomes "the retry-budget rule (R4) blocks the merge".
- Name a thing by its role to the reader. "Our test account" becomes "the
  account the nightly smoke test logs in with".
- Reread the lines after every cut. A cut sentence can take with it the
  only definition of a term a later line uses.

## Posts and replies

You MUST:

- In a channel post, such as Slack or Teams, state the ask in the first
  line, once. A question passes only if a reader who was not in the
  session can answer it from the post alone: say what the thing is, who
  sees it break, and how to check it.
- In a thread reply, answer the question asked and stop. Cut the facts
  past the answer.
- In a chat reply, when something is left open, end with one concrete next
  action.
- Number multi-step instructions, one action per step.
- During multi-step work, say where it stands: "Step 3 of 5 done: schema
  updated. Next: the backfill."
- Put a second issue at the end of the reply, as a separate offer.
- After three failed fixes for one problem, stop iterating. Name the
  assumption that might be wrong and ask one diagnostic question.
- Check the first and last lines before sending. A reader who reads only
  those knows what happened and what to do next.

## Mechanics

You MUST:

- Use sentence case for headings.
- Use no emoji.
- Use US spellings: behavior, characterization, organize, analyze. Quoted
  text, identifiers and file contents keep whatever spelling the source
  uses.
- Separate a thought with a period or a comma. Never an em dash, and never
  parentheses standing in for one. ` -- ` is allowed only as a structural
  separator in a heading or a table cell, never mid-sentence in prose.
- Use straight quotes and straight apostrophes, never curly.
- Bold sparingly. Never bold every proper noun or acronym.
- Use a colon before a list or example only, never as a mid-sentence
  connector.
- Avoid inline-header lists that restate the line ("**Latency:** Latency
  dropped to 4ms"). A bold lead-in that names an item and is followed by
  new detail is fine.
