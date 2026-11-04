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
- Prefer a brief bulleted list to paragraphs. Reserve tables for genuinely
  tabular material such as per-field decisions.
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
  it". Covers "not just X, but Y" and "rather than X, Y".
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
