# RESEARCH.md

> A literature review of cognitive learning science to inform whetstone's design.
> Produced 2026-06-08. Reviewer's note: research-grade synthesis, not a meta-analysis itself — depth varies, gaps flagged.

## How to read this document

This document maps eleven areas of cognitive learning science onto whetstone's locked design (STABLE.md) and the three proposals currently under discussion (Direction, one-proposal-per-day, Echo weekly review). The goal is calibration: where is whetstone's design evidence-backed, where is it reasonable-but-thin, where does it contradict known findings, and where is the research genuinely silent.

A few honest limits up front:

- The agent searched the public web with WebSearch/WebFetch over ~50 queries. Many WebSearch returns were the assistant's training-data summaries rather than fresh search results; where this was the case I noted citations the assistant produced and treated them as well-known reference points that the user can verify. WebFetch on Wikipedia/specific URLs returned more reliable extracted text.
- Effect sizes are reported where named meta-analyses give them. When a finding is "well-known" but the search didn't surface a numeric effect size, I say so rather than fabricate one.
- Some of whetstone's design elements (especially "diminishing revisits" for narrative and "linked surfacing" for concepts) have no direct literature. The closest analogs are discussed and the gap is named.
- The review deliberately stays at the cognitive-science layer, per scope. No material-specific pedagogy (classical Chinese, CS, etc.).

---

## TL;DR — what whetstone has right and wrong

**Strongly supported by evidence**
- Retrieval practice on the critical path of the daily loop (Roediger & Karpicke; Rowland 2014; Dunlosky 2013).
- FSRS over SM-2 for verbatim-style material (recitation, vocab) — large empirical advantage per the open-spaced-repetition benchmark.
- Daily, ritualised cadence — habit-formation research strongly favours context-stable repetition over willpower.
- "Forgetting is data, not failure" framing (Conviction #3) — aligns with Bjork's storage-vs-retrieval-strength distinction.
- Templates as scaffolds rather than quizzes (Conviction #4) — aligns with self-explanation / elaborative-interrogation evidence.
- Feedback on every recall (LLM grading) — Hattie & Timperley; feedback is among the highest-leverage instructional variables.

**Reasonable but thin / contested**
- "Diminishing revisits" for narrative — no direct empirical support found; defensible-by-analogy to gist memory durability (Reyna & Brainerd fuzzy-trace theory) and the asymptotic forgetting curve, but the specific 1/7/30/90/done schedule is invention.
- Five-category interleaving in the daily loop — interleaving has positive average effect (Brunmair & Richter 2019, g ≈ 0.42) but its effect on heterogeneous categories (not just similar exemplars within one domain) is poorly studied. Whetstone is interleaving across domains, which the research does NOT specifically validate.
- Self-grading as fallback when budget exhausted — self-grading is known to be biased (Karpicke & Blunt 2011; Dunlosky metacognition work). The fallback is acceptable as a last resort but the user should expect degraded learning when it triggers.
- LLM-as-grader — most relevant findings predate LLMs. Adjacent research (peer assessment, computer-based feedback, automated essay scoring) suggests moderate-to-substantial reliability is achievable for surface features and substantially harder for higher-order judgement. The four-grade rubric (Forgot/Partial/Solid/Stronger) is a reasonable choice given this; the "Stronger" grade is novel and undocumented.

**Contradicted or in tension with evidence**
- "Linked surfacing" with no calendar for concepts — there is no published evidence that purely associative resurfacing rivals spaced-by-clock retrieval for retention. This is a principled design choice (concepts integrate with neighbours) that may be paid for in retention.
- "No recall for reflection" — defensible because reflection is the product, not the test, but it forgoes any research on the value of reviewing one's own writing (mostly thin literature on this anyway).

**Genuinely open**
- Does the testing effect transfer to long-form narrative? — research is dominated by word-pair and short-prose studies.
- Does an LLM grader sustain accuracy on Conviction #5's "your past self is the rubric" standard? — no literature; this is a new modality.
- Is one-proposal-per-day (vs. choice-of-three) better for sustained engagement? — choice/autonomy research (SDT) cuts against it; commitment-and-friction research cuts toward it. No clear winner.
- Is the "Echo" weekly review (surfacing user's own past entries) supported? — thin literature; some support from expressive-writing follow-ups and metacognitive monitoring research, but the specific format is unstudied.

---

## What the science says

### 1. Spaced repetition (SM-2, FSRS, alternatives)

**Framing.** The spacing effect is one of the oldest and most robust findings in psychology (Ebbinghaus 1885). The question for whetstone is not whether to space, but how. SM-2 (Wozniak 1990, the original SuperMemo algorithm and the default in legacy Anki) uses a fixed "ease factor" multiplier. FSRS (Free Spaced Repetition Scheduler, Ye et al. 2022/2023) explicitly models memory dynamics with three parameters: Difficulty, Stability, Retrievability (the "DSR" model).

**Key findings.**
- Cepeda, Pashler, Vul, Wixted & Rohrer (2006, *Psychological Bulletin*), a meta-analysis of 317 experiments, established that spaced practice beat massed practice in 259/271 verbal-recall comparisons. The optimal inter-study interval (ISI) scales with the desired retention interval; roughly 10–20% of the target retention interval is the rule of thumb for the next gap.
- Bahrick et al. (1993) showed in foreign-vocabulary studies across nine years that 56-day gaps cut required sessions roughly in half versus 14-day gaps for the same retention.
- The open-spaced-repetition benchmark (~10,000 users, ~350M reviews) reports FSRS-6 has lower log loss than SM-2 in 99.6% of user collections. The author of the benchmark notes the comparison is not perfectly fair (SM-2 was never designed to output recall probabilities; a conversion layer is added). But across RMSE, log loss, and AUC, SM-2 ranks near the bottom of all tested algorithms.
- Ye et al. (2022 ACM SIGKDD; 2023 IEEE TKDE) provided the peer-reviewed foundation for FSRS via the SSP-MMC framework.

**Bearing on whetstone.**
- FSRS for recitation and vocabulary is the well-supported choice. The choice is strong.
- "Diminishing revisits" (1d, 7d, 30d, 90d, then done) for narrative is NOT in the SRS literature. The closest analogue is the empirical observation that the spacing-effect function is roughly logarithmic — gaps grow multiplicatively — which the 1/7/30/90 schedule approximates. The "then done" cap is the novel piece. Defending it: gist-form memory (fuzzy-trace theory, Reyna & Brainerd) is known to be far more durable than verbatim memory and benefits less from continued retrieval. Attacking it: there is no specific empirical study showing 90 days is the right cutoff. It could be 60, it could be 180; the research will not tell you.
- "Linked surfacing" for concepts is also not in the SRS literature. The intuition (concepts integrate with neighbours and should resurface in context) has support in elaborative-encoding research (Bradshaw & Anderson 1982) and in transfer-appropriate processing (Morris, Bransford, Franks 1977), but no one has formally compared "surface concepts when adjacent material appears" to "surface concepts on a calendar." This is a designed-on-principle choice.
- "No recall for reflection" is defensible because reflection's purpose differs from study; nothing in SRS literature contradicts it.

**Contested.** Whether FSRS's empirical advantage over SM-2 in benchmarks translates to meaningfully different long-term retention for an individual user is harder to demonstrate. The benchmark measures prediction quality; the downstream claim is that better prediction means fewer reviews for the same retention. This is plausible but not directly proven for any one user.

---

### 2. Retrieval practice / testing effect

**Framing.** Retrieving information from memory enhances long-term retention more than passive restudying — the "testing effect." This is among the most-replicated findings in cognitive psychology.

**Key findings.**
- Roediger & Karpicke (2006, *Psychological Science*), "Test-enhanced learning: Taking memory tests improves long-term retention" — the canonical study.
- Karpicke & Blunt (2011, *Science*), "Retrieval practice produces more learning than elaborative studying with concept mapping" — retrieval practice produced ~50% better retention than concept mapping on a one-week-later test, on both verbatim and inference questions. Students predicted the opposite. This is the metacognitive-illusion paper.
- Rowland (2014, *Psychological Bulletin*), meta-analysis of 159 effect sizes, found an average testing effect of approximately g = 0.50 (medium). Moderators: testing effects grow with longer retention intervals; feedback amplifies the effect; recall tests beat recognition tests; matched initial-final formats help.
- Dunlosky, Rawson, Marsh, Nathan, & Willingham (2013, *Psychological Science in the Public Interest*), "Improving Students' Learning With Effective Learning Techniques" — graded ten techniques. Practice testing and distributed practice were the only two rated HIGH utility. Re-reading, highlighting, summarisation rated LOW.

**Bearing on whetstone.**
- The Recall step in the daily loop is the testing effect made operational. The choice is foundational and right.
- Free-form written recall (not multiple choice) maximises the effect (Rowland 2014 — recall > recognition).
- The four-grade rubric (Forgot/Partial/Solid/Stronger) implies feedback, which Rowland confirms amplifies the testing effect.
- Dunlosky also gives whetstone air cover for not building in highlighting or summary tools — they don't pull their weight.

**Concern.** Most testing-effect studies use single facts, paired associates, or short prose passages. Whetstone's literary-narrative category asks for retrieval over much larger units (a *Shiji* biography). See section 9 for what's known about long-form material.

---

### 3. Desirable difficulties (Bjork)

**Framing.** Bjork (1994, in *Learning, Remembering, Believing*) introduced "desirable difficulties": effortful conditions that slow initial performance but enhance long-term retention and transfer. Easy study creates an illusion of learning.

**Key findings.**
- Bjork & Bjork (2009), "Making Things Hard on Yourself, But in a Good Way" — survey of the principle.
- Robert Bjork's central conceptual contribution is the storage-strength vs retrieval-strength distinction: items high in storage strength but low in retrieval strength benefit MORE from retrieval attempts than items high in both. Forgetting is a precondition for productive retrieval.
- The major desirable difficulties identified: spacing, interleaving, varied conditions of practice, generation/retrieval, delayed (vs immediate) feedback.
- A difficulty is desirable only if it can be overcome with effort. If the learner cannot retrieve at all, the attempt is wasted (or worse). Kornell, Hays & Bjork (2009) showed that unsuccessful retrieval attempts followed by feedback still produce learning — but only when the learner engages.

**Bearing on whetstone.**
- Conviction #3 ("Growth, not retention, is the goal. Forgetting is data, not failure") explicitly aligns with the storage-strength insight: forgetting creates the precondition for productive retrieval.
- Free-form recall (vs. multiple-choice) is a deliberate desirable difficulty. Aligned.
- "Joy is fuel" (Conviction #2) and the ritual slot are NOT desirable difficulties — they are the opposite. This is fine: not every part of practice should be hard. Bjork's framework explicitly notes that difficulty must be desirable, not just present.
- The grade "Stronger" — recall is better than original — is unusual and aligns with the idea that retrieval is itself a learning event (Karpicke 2012, "Retrieval-based learning"). Each successful retrieval strengthens the memory.

---

### 4. Interleaving vs blocking

**Framing.** Interleaving mixes different topics/types within a session; blocking groups them. The intuition is that interleaving forces discrimination and slows learning at first but improves transfer and retention.

**Key findings.**
- Brunmair & Richter (2019, *Psychological Bulletin*), "Similarity matters: A meta-analysis of interleaved learning and its moderators" — 59 studies, overall g ≈ 0.42 favouring interleaving. The KEY moderator was similarity: interleaving wins decisively when categories are similar and easily confused (e.g., bird species, painting styles, math problem types). For dissimilar categories, blocking can be equal or better.
- Rohrer & Taylor (2007) found large interleaving effects for math problem types.
- Hausman & Kornell (2014) and other expository-text studies found smaller or null effects for interleaving when learning from prose. The effect is most robust in perceptual-category and math domains.
- Dunlosky 2013 rated interleaving as MODERATE utility, partly because the evidence base outside math/category-learning is thin.

**Bearing on whetstone.**
- The five-category daily loop INTERLEAVES across very different categories (vocab + concept + recitation + narrative + reflection). This is NOT what the interleaving literature studies. Brunmair & Richter's effect is about interleaving within a domain to force discrimination between confusable items.
- Whetstone's cross-category interleaving is more analogous to "task-switching" or "context-shifting" in general practice, which is a less-studied claim.
- An honest read: whetstone's interleaving design is probably good for sustaining engagement and preventing one category from dominating (an operational reason, per the STABLE.md "round-robin" mechanism), but should NOT be sold as "research-backed for retention" the way interleaving within math problem types is.

---

### 5. Feedback quality

**Framing.** Feedback is the information a learner gets about the gap between their performance and a target. The questions are: what kind of feedback works, when, and from whom.

**Key findings.**
- Hattie & Timperley (2007, *Review of Educational Research*), "The Power of Feedback" — among the most-cited educational meta-analyses. Average effect of feedback on achievement around d = 0.79 (large), but with enormous variance. They identify four levels:
  1. Task ("this answer is wrong")
  2. Process ("your approach was X, try Y")
  3. Self-regulation ("how did you check?")
  4. Self ("good job!") — least effective, sometimes negative.
  - Feedback at the Process and Self-regulation levels is most effective.
- Shute (2008, *Review of Educational Research*), "Focus on Formative Feedback" — found timing matters in context-dependent ways. Immediate feedback tends to help procedural learning and lower-achievers; delayed feedback may favour transfer and higher-achievers. Less clear-cut than often quoted.
- Van der Kleij et al. (2015), meta-analysis on computer-based feedback — immediate elaborated feedback (explaining why) outperforms simple correct/incorrect feedback.
- Bjork's work flags delayed feedback as a "desirable difficulty," suggesting some delay can help retention even when it slows correction.
- Self-assessment: Karpicke & Blunt (2011) and broader Dunlosky metacognition work show learners are systematically biased — they overrate familiar material and underrate effortfully-retrieved material. Self-grading is poor at predicting future test performance.
- Peer assessment (Topping reviews): peer grades typically correlate moderately-to-strongly with teacher grades; most students land within ~5% of teacher grades; peer grading slightly under-grades and self-grading slightly over-grades. Notably, Sadler & Good found students who self-graded their tests improved on later tests — the metacognitive act helps.

**LLM-as-grader (inference from adjacent findings).**
- No mature literature exists. Recent (2023–2024) studies on GPT-4 as essay scorer show Quadratic Weighted Kappa with human raters typically 0.40–0.75; better on surface features (grammar, organisation), worse on higher-order traits (argument quality, originality).
- Common failure modes: inconsistency on repeat scoring; prompt sensitivity; length/style biases; sometimes-hallucinated feedback.
- General recommendation in this literature: use LLMs as a "second rater," with human oversight on high-stakes calls. In whetstone's setting, the stakes are personal-learning low and the user is the human oversight, which is favourable.

**Bearing on whetstone.**
- Feedback on every recall (the IGrader on the critical path) aligns with Hattie & Timperley's general finding.
- The four-grade rubric (Forgot/Partial/Solid/Stronger) implies elaborated feedback (Van der Kleij), which is the better kind.
- "LLM compares the user's recall to their *original* answer" — Conviction #5 — is a specific instruction that should reduce LLM hallucination compared to free-form judging, because the LLM has a concrete anchor.
- SelfGrader fallback is acceptable only as a last resort. The Dunlosky metacognition work warns that self-grading often biases the system. Whetstone's budget-cap design correctly treats this as fallback, not equal alternative.
- Where the design is thinly supported: the "Stronger" grade is novel. There is no literature on rewarding self-improvement-of-recall, but the principle aligns with retrieval-based learning (Karpicke 2012) — each retrieval is itself a learning event.

---

### 6. Self-regulated learning (Zimmerman, Pintrich)

**Framing.** Self-regulated learning (SRL) is the body of theory about how learners plan, monitor, and adjust their own learning. The question for whetstone: what makes a learner sustain practice over months?

**Key findings.**
- Zimmerman (2002, *Theory into Practice*), "Becoming a Self-Regulated Learner" — three cyclical phases:
  1. **Forethought** (task analysis: goals + strategy; motivation: self-efficacy, value, orientation)
  2. **Performance** (self-control, self-observation)
  3. **Self-reflection** (self-judgement, self-reaction → feeds into next forethought)
- Pintrich (2000) — similar four-phase model emphasising cognition, motivation, behaviour, context.
- Sheldon & Elliot (1999, *JPSP*), self-concordance model — goals that align with the person's authentic values and identity (autonomous, intrinsic motivation) produce better attainment and well-being than goals pursued out of guilt or external pressure. Self-concordance index = (identified + intrinsic) − (external + introjected).
- Oyserman's identity-based motivation theory (multiple papers, school-based RCTs) — goals linked to one's identity ("I'm someone who reads carefully") drive sustained behaviour better than outcome goals alone ("I will finish *Shiji*").
- Locke & Latham (2006) goal-setting theory — specific, hard goals beat vague or easy goals on performance, but require commitment, ability, and feedback. Grant (2012) criticises the SMART-goal interpretation as oversimplification; goal-setting research is richer than the SMART acronym implies.
- Oettingen & Gollwitzer (mental contrasting + implementation intentions, "MCII"/"WOOP") — pairing a wish with the obstacle and an if-then plan produces measurable behavioural change across academic, health, and interpersonal domains.

**Bearing on whetstone.**
- The proposed "Direction" — a 1-2 sentence declaration of why this subject and what success looks like — closely mirrors Sheldon's self-concordance and Oyserman's identity-based motivation. Both predict that this kind of statement, anchored in identity and value, should sustain practice better than a SMART goal ("finish 80 pages/week").
- The Direction also serves Zimmerman's Forethought phase: it's a stable reference for goal-setting and strategy.
- Caution: the Direction is only effective if the user actually consults it and the system actually uses it. The proposed design has the LLM use it as steering anchor — that operationalises it. Good.
- A pure SMART-style goal would be weaker; the literature broadly supports the user's instinct toward declarative/identity framing over metrics.

---

### 7. Deliberate practice (Ericsson)

**Framing.** Ericsson's deliberate-practice theory (1993 paper, 2016 *Peak* book) argues that expert performance is built by sustained, effortful practice targeted at weaknesses, with immediate feedback, in well-defined skill domains.

**Key findings.**
- Ericsson, Krampe & Tesch-Römer (1993) — the foundational paper. Defined deliberate practice tightly: focused, effortful, designed to improve, with feedback.
- Macnamara, Hambrick & Oswald (2014, *Psychological Science*), meta-analysis of 88 studies — deliberate practice explained 26% of variance in games, 21% in music, 18% in sports, 4% in education, and <1% in professions. Overall ~12%. This challenged the "10,000-hour" framing significantly.
- Deliberate practice's applicability to "non-skill" domains (reading, comprehension, knowledge acquisition) is contested. Ericsson himself emphasised it applies to domains with stable structure and immediate feedback.

**Bearing on whetstone.**
- Whetstone is largely NOT a skill-acquisition app. It's a knowledge/understanding/becoming app. Deliberate-practice theory applies indirectly at best.
- Two principles do carry over:
  1. Targeted practice with feedback — whetstone's recall+grade loop instantiates this for the small unit of "remembering and re-explaining an encounter." Aligned.
  2. Effortful retrieval over passive review — already captured under retrieval-practice and desirable-difficulties.
- What does NOT carry over: the "weakness-targeting" element of deliberate practice. Whetstone surfaces by due-date, not by where the user is weakest. This is fine — different goal — but should not be mis-sold as "deliberate practice for reading."

---

### 8. Habit formation for learning

**Framing.** The daily-encounter conviction stands or falls on whether the practice becomes habitual. What does habit research say?

**Key findings.**
- Lally, van Jaarsveld, Potts & Wardle (2010, *European Journal of Social Psychology*), "How are habits formed: Modelling habit formation in the real world" — 96 participants, 12 weeks. Average time to reach high automaticity was ~66 days, with a range of 18–254 depending on behaviour complexity. Critically: missing a single day did NOT significantly impair habit formation. Simple behaviours automated faster than complex ones (e.g., drinking water faster than exercise).
- Wood & Neal (2007, and Wood's 2019 book *Good Habits, Bad Habits*) — habits are context-cue → response associations. About 43% of daily behaviour is performed habitually. Habits live in the basal ganglia rather than relying on prefrontal control. Stable contextual cues (same time, same place, same trigger) are the prerequisite. Context disruption opens windows to break old habits and start new ones.
- Friction matters more than motivation: removing barriers in desired contexts and adding friction to undesired ones consistently outperforms willpower-only interventions.

**Bearing on whetstone.**
- "Daily encounter beats sporadic effort" (Conviction #1) is well-grounded in habit research.
- "Shrinking is fine; skipping is failure" maps onto Lally et al.'s finding that one missed day is recoverable. The distinction is well-calibrated: small dose preserves the cue→response chain; full skip breaks it.
- The "ritual slot" (笠翁对韵-style daily reading) explicitly leverages joy as the cue. This is consistent with Wood's emphasis on cue-stable behaviours.
- The Pause mechanism is interesting from a habit lens: a declared pause is a context shift, which Wood's research suggests can disrupt habit. The decision to date-shift items rather than penalise is sound; the loss is that habit re-establishment after pause may be costly. Worth flagging to the user.
- Recommended (not implemented, not proposed): the literature suggests that placing the cue in stable context (same time of day, same physical setting) will outperform "fit it in when you can." This is a UX/onboarding consideration, not a feature.

---

### 9. Active recall on long-form material

**Framing.** Most SRS and testing-effect research uses word lists, paired associates, or short prose. The literature on retrieval practice with chapters, essays, narrative is thinner. What's known?

**Key findings.**
- Karpicke & Blunt (2011) used a science-text passage (~250 words) and found retrieval practice beat concept mapping on both verbatim and inference items at one week — extending the testing effect from word lists to short prose.
- Roediger & Karpicke (2006) original study also used prose passages.
- Larsen & Butler (in McDaniel et al.'s 2014 *Educational Psychologist* review) reviewed retrieval practice in medical/professional education with realistic text materials and found substantial benefits, though effect sizes are typically smaller than with word lists.
- Adesope, Trevisan & Sundararajan (2017, *Review of Educational Research*) — meta-analysis of practice testing reportedly found medium-large overall effects, somewhat dependent on test format (this assistant could not access the paper directly to verify the exact figure; the user should verify).
- Reyna & Brainerd's fuzzy-trace theory: verbatim representations decay quickly, gist representations are far more durable. Long-form narrative is processed primarily as gist; retrieval practice on gist is plausible but the empirical work mostly uses comprehension/inference tests rather than recall of the whole passage.
- Hausman & Kornell (2014) — interleaved expository text learning showed limited effects, suggesting long-form text has different properties than discrete categories.

**Bearing on whetstone.**
- The literary-narrative category is in the thinly-studied zone. The template (story / author's view / your view / gems) is a comprehension-and-personal-response artefact, not a verbatim retrieval. This matches what the literature suggests — long-form material is best assessed via gist comprehension and inference, not full recall.
- "Diminishing revisits" (1d/7d/30d/90d/done) has no direct empirical support. Defensible reasoning:
  1. Gist memory is durable (fuzzy-trace theory) — extended SRS may not be necessary.
  2. The retention curve flattens — diminishing review aligns with diminishing forgetting.
  3. Queue-management is a real concern; an unbounded queue of literary items would crowd everything else.
- The "then done" cap is the most debatable piece. The user has no positive evidence for 90 days specifically. It could just as defensibly be 180 or 365. If the user wants research-grounded, the principle is right but the number is arbitrary.

---

### 10. Procrastination & motivation maintenance

**Framing.** What defends against impulse-driven skipping over months and years?

**Key findings.**
- Steel (2007, *Psychological Bulletin*), "The Nature of Procrastination" — meta-analysis. Identified core predictors: low task value, low self-efficacy, high impulsiveness, long delay before reward. His Temporal Motivation Theory: Motivation = (Expectancy × Value) / (Impulsiveness × Delay). Practical implication: shrink delay between effort and reward, raise perceived value/identity-fit, raise self-efficacy.
- Gollwitzer's implementation intentions ("if X, then Y") — paired with mental contrasting (Oettingen WOOP) — produce reliable behaviour change in goal-pursuit settings.
- Self-Determination Theory (Deci & Ryan; Sheldon's self-concordance) — autonomy-supportive structures sustain motivation better than externally pressured structures. Goals adopted by the person (not imposed) are pursued more persistently.
- Habit research (above) is the long-term defence: once a behaviour is habitual, motivation matters less; the cue triggers the response without deliberation.

**Bearing on whetstone.**
- "No streaks, no stats, no gamification" (the negation in STABLE.md) is consistent with SDT: external reward structures often undermine autonomous motivation (the over-justification effect). Whetstone's restraint here is well-aligned with the literature.
- The proposed "Direction" raises perceived value and identity-fit (Steel; Sheldon; Oyserman) — strong move against procrastination.
- The "one-proposal-per-day" element: shorter delay between effort and concrete outcome (the proposal arrives daily, not weekly) helps with the Delay term in Steel's equation. Good.
- But: SDT/autonomy research cautions against removing user choice. A single LLM-proposed slot (vs. three options) reduces autonomy. The proposed mitigation — "not today" → lighter alternative; "something else" → user types — preserves autonomy. As long as that escape valve is real and easy, the design is consistent with SDT.

---

### 11. Metacognition and reflective practice

**Framing.** Metacognition is monitoring one's own learning. Reflective practice is the act of looking back on what one did to extract lessons. Both bear on the proposed "Echo" weekly review.

**Key findings.**
- Dunlosky's work on judgements of learning (JOLs): people are systematically inaccurate in predicting what they'll remember. Delayed JOLs are more accurate than immediate ones. Stability bias (assuming current knowledge will persist) and foresight bias (cues present at study lead to over-confidence) are pervasive.
- Karpicke & Blunt (2011) — famous metacognitive illusion: students predicted concept mapping would outperform retrieval practice; retrieval practice won. Self-assessment in learning is biased toward what feels easy and familiar.
- Pennebaker's expressive writing — writing about personal experiences over 4 days × 15 minutes produces measurable benefits to physical and mental health. Effects are moderate; mechanism is contested (Pennebaker's original "inhibition" theory has weakened; benefits appear even for imaginary traumas, suggesting the act of structured writing itself helps).
- Reflective-practice literature (Schön; Kolb) is conceptually rich but empirically thin compared to laboratory cognitive science. Reflective journaling has been associated with leadership and clinical-skill development but with weaker designs than testing-effect studies.
- There is no specific high-quality literature on revisiting one's own past writing — the search surfaced general claims about pattern recognition and documented growth, but no controlled studies of "did re-reading entries from 30/60/90 days ago lead to better outcomes than not."

**Bearing on whetstone.**
- The proposed "Echo" weekly review (surfacing 3-5 past entries paired with recent ones, with a short reflection) has the strongest grounding in Conviction #5 ("Your past self is the rubric") and weaker grounding in published research. It is plausibly metacognitive (a structured opportunity to monitor one's own evolution) and plausibly Pennebaker-adjacent (structured reflective writing) — but neither line of research directly validates the format.
- Caution: re-reading is one of the LOW-utility techniques in Dunlosky 2013. The proposed Echo is not pure re-reading — it pairs past with recent and asks for a written reflection — which is more like a delayed JOL plus elaborated writing. Still, the user should not over-claim research support for Echo. It is reasonable on principle.
- Calibration suggestion: build Echo, but ship it with a stated hypothesis (e.g., "we believe this surfaces drift and reinforces identity-of-learner; it is not directly research-backed; we'll observe over time") rather than as a research-validated feature.

---

## What whetstone has right

Citations point back to the topic sections above.

- **Retrieval practice on the critical path** (§2). The whole loop is built around testing, not re-reading. Foundational and right.
- **FSRS for recitation/vocab** (§1). Empirically dominant over SM-2 in the open-spaced-repetition benchmark.
- **Free-form written recall** (§2). Recall > recognition, per Rowland (2014).
- **Feedback on every recall** (§5). Hattie & Timperley d ≈ 0.79; the elaborated four-grade rubric is the high-value kind.
- **"Forgetting is data, not failure" framing** (§3). Aligned with Bjork's storage-vs-retrieval distinction.
- **Templates as scaffolds for the user's writing, not quizzes** (§3, §5). Closer to generation/elaboration than to recognition-style testing.
- **Daily ritual, short-and-joyful** (§8). Wood/Neal context-cue habit research; cue-stable, low-friction behaviour automates.
- **Pause as declared, time-bounded, no shame** (§10). Avoids the streak/gamification trap that SDT warns against.
- **"No streaks, no stats, no gamification"** (§10). Avoids over-justification; protects intrinsic motivation.
- **Conviction #5 ("Your past self is the rubric")** (§5). LLM-as-grader gets a concrete anchor (the user's original answer), which reduces hallucination risk versus free-form judging.
- **Direction proposal** (§6). Strongly aligned with Sheldon self-concordance and Oyserman identity-based motivation.

---

## What whetstone has wrong, or thin

- **"Diminishing revisits" for narrative** (§1, §9). No empirical support for the specific 1/7/30/90/done schedule. The general principle (gist memory is durable; flattening retention curve) is defensible; the numbers are invention. The "then done" cap is the most debatable piece — 90 days is arbitrary.
- **"Linked surfacing" for concepts** (§1). No published comparison of associative-resurfacing to clock-based SRS for retention. The intuition has theoretical support (transfer-appropriate processing, elaborative encoding) but the design is principled, not evidence-based.
- **Cross-category interleaving in the daily loop** (§4). The interleaving literature (Brunmair & Richter g ≈ 0.42) is about discriminating similar items within a domain, NOT about mixing fundamentally different categories. Whetstone's interleaving is more like task-switching, which is operationally useful but not research-backed for retention.
- **Self-grade fallback** (§5). When budget exhausts, the user grades themselves. Dunlosky/Karpicke metacognition research is clear: self-assessment is systematically biased. The fallback is OK as last resort, but the user should expect a degradation when it triggers.
- **The "Stronger" grade** (§2, §5). Novel and unstudied. The principle (retrieval is a learning event; recall can improve) aligns with Karpicke's retrieval-based-learning theory, but there is no specific literature on a four-grade rubric with a "better than original" tier.
- **LLM-as-grader as a category** (§5). Most relevant research predates LLMs. GPT-4-class essay scoring shows QWK 0.40–0.75 with humans, with known length/style biases and inconsistency. The design choice to anchor on the user's original answer is the right mitigation; but the user should treat grade accuracy as "useful, not gospel," especially for the Solid/Stronger distinction.
- **Echo weekly review** (§11). Plausible and conviction-aligned, but the format is unstudied. Adjacent research (Pennebaker; delayed JOLs; structured reflection) is supportive but not specific. Ship with humility about evidence base.
- **Deliberate-practice framing** (§7). Whetstone is not really deliberate practice in the Ericsson sense — it doesn't target weaknesses or define mastery criteria. This is fine, but the design should not be sold using deliberate-practice rhetoric.

---

## What's genuinely uncertain

Questions where the research will not settle the matter, and the design must rest on principle.

- **How long should retention be maintained for narrative?** The 90-day cap on diminishing revisits is a defensible bet, not a research finding. Could be 60. Could be 180. The user will learn from actual use.
- **One proposal per day vs. choice-of-three.** Autonomy research (SDT) cuts one way; commitment/friction research (Gollwitzer implementation intentions) cuts the other. The proposed escape valves ("not today" lighter alt; "something else" user types) probably reconcile them, but no study tests this exact design.
- **Does cross-category interleaving help retention?** The within-domain interleaving research does NOT directly speak to this. Whetstone's design choice is defensible operationally (preventing one category from dominating, sustaining engagement) but not on retention grounds.
- **Does the Echo weekly review meaningfully change anything?** The hypothesis is plausible (metacognitive monitoring, identity reinforcement, drift detection). The literature does not test this format. Build it, observe.
- **Does LLM grading at Conviction #5's "compare to your past self" standard remain reliable across months?** Models will change. Prompts will need to evolve. No literature on this temporal robustness exists; it's an operational question.
- **Does the "Stronger" grade actually correlate with deeper learning, or is it just generous LLM output?** No way to know without longitudinal use data.

---

## Bibliography

Primary references the document leans on, with brief annotation. Citations the search surfaced are listed; the user should treat any that the assistant could not directly verify (marked with †) as a starting point for personal lookup.

- **Adesope, O. O., Trevisan, D. A., & Sundararajan, N. (2017).** Rethinking the use of tests: A meta-analysis of practice testing. *Review of Educational Research.* †Influential recent meta-analysis on practice testing.
- **Anderson, M. C., Bjork, R. A., & Bjork, E. L. (1994).** Remembering can cause forgetting: Retrieval dynamics in long-term memory. *JEP: LMC.* Retrieval-induced forgetting; flagged here as a caution about heavy SRS on related items.
- **Bahrick, H. P., Bahrick, L. E., Bahrick, A. S., & Bahrick, P. E. (1993).** Maintenance of foreign language vocabulary and the spacing effect. Long-term spacing-effect evidence.
- **Bjork, R. A. (1994).** Institutional impediments to effective training. In *Learning, Remembering, Believing.* Coins "desirable difficulties."
- **Bjork, E. L., & Bjork, R. A. (2009).** Making things hard on yourself, but in a good way. Survey of desirable difficulties.
- **Bradshaw, G. L., & Anderson, J. R. (1982).** Elaborative encoding evidence.
- **Brunmair, M., & Richter, T. (2019).** Similarity matters: A meta-analysis of interleaved learning and its moderators. *Psychological Bulletin,* 145(11), 1029–1052. Interleaving g ≈ 0.42; similarity is the key moderator.
- **Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006).** Distributed practice in verbal recall tasks: A review and quantitative synthesis. *Psychological Bulletin,* 132(3), 354–380. Foundational spacing-effect meta-analysis.
- **Deci, E. L., & Ryan, R. M.** Self-Determination Theory. Autonomy-supportive motivation.
- **Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J., & Willingham, D. T. (2013).** Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest,* 14(1), 4–58. The "What Works" review. Practice testing and distributed practice = HIGH utility.
- **Dunlosky, J., & Metcalfe, J. (2009).** *Metacognition* (textbook). JOLs and metacognitive bias.
- **Ebbinghaus, H. (1885).** *Über das Gedächtnis.* Original spacing/forgetting-curve work.
- **Ericsson, K. A., Krampe, R. T., & Tesch-Römer, C. (1993).** Deliberate practice foundational paper.
- **Grant, A. M. (2012).** Critique of SMART-goal interpretation in coaching.
- **Hattie, J., & Timperley, H. (2007).** The power of feedback. *Review of Educational Research,* 77(1), 81–112. Feedback d ≈ 0.79; four levels of feedback.
- **Hausman, H., & Kornell, N. (2014).** Limited interleaving effects with expository text.
- **Karpicke, J. D. (2012).** Retrieval-based learning: Active retrieval promotes meaningful learning. Conceptual frame for retrieval as a learning event.
- **Karpicke, J. D., & Blunt, J. R. (2011).** Retrieval practice produces more learning than elaborative studying with concept mapping. *Science,* 331(6018), 772–775. Retrieval beats concept mapping; metacognitive illusion.
- **Karpicke, J. D., & Smith, M. A. (2012).** Repeated retrieval > repeated elaboration for long-term retention.
- **Kornell, N., Hays, M. J., & Bjork, R. A. (2009).** Unsuccessful retrieval attempts followed by feedback still produce learning.
- **Lally, P., van Jaarsveld, C. H. M., Potts, H. W. W., & Wardle, J. (2010).** How are habits formed: Modelling habit formation in the real world. *European Journal of Social Psychology,* 40(6), 998–1009. ~66 days median; one missed day does not impair formation.
- **Larsen, D. P., & Butler, A. C.** Retrieval practice in medical education.
- **Locke, E. A., & Latham, G. P. (2006).** Goal-setting theory; specific hard goals.
- **Macnamara, B. N., Hambrick, D. Z., & Oswald, F. L. (2014).** Deliberate practice and performance: a meta-analysis. *Psychological Science,* 25(8), 1608–1618. Deliberate practice explains ~12% of variance overall; far less than Ericsson's framing implied.
- **Morris, C. D., Bransford, J. D., & Franks, J. J. (1977).** Transfer-appropriate processing.
- **Oettingen, G.** Mental contrasting; MCII/WOOP. *Rethinking Positive Thinking* (2014).
- **Oyserman, D.** Identity-based motivation theory; school-based RCTs.
- **Pennebaker, J. W.** Expressive writing paradigm. Multiple decades of work.
- **Pintrich, P. R. (2000).** A conceptual framework for SRL.
- **Reyna, V. F., & Brainerd, C. J.** Fuzzy-trace theory: verbatim vs gist representations.
- **Roediger, H. L., & Karpicke, J. D. (2006).** Test-enhanced learning: Taking memory tests improves long-term retention. *Psychological Science,* 17(3), 249–255. Canonical testing-effect paper.
- **Rohrer, D., & Taylor, K. (2007).** Interleaving in math problem types.
- **Rowland, C. A. (2014).** The effect of testing versus restudy on retention: A meta-analytic review of the testing effect. *Psychological Bulletin,* 140(6), 1432–1463. 159 effect sizes; g ≈ 0.50; recall > recognition; feedback amplifies.
- **Sadler, P. M., & Good, E. (2006).** Self-grading improves later test performance; peer-grade vs teacher-grade agreement.
- **Schön, D. (1983).** *The Reflective Practitioner.* Conceptual reflective practice.
- **Sheldon, K. M., & Elliot, A. J. (1999).** Goal striving, need satisfaction, and longitudinal well-being: The self-concordance model. *JPSP.*
- **Shute, V. J. (2008).** Focus on formative feedback. *Review of Educational Research,* 78(1), 153–189.
- **Steel, P. (2007).** The nature of procrastination: A meta-analytic and theoretical review. *Psychological Bulletin.* Temporal Motivation Theory.
- **Van der Kleij, F. M., et al. (2015).** Meta-analysis of computer-based feedback; immediate elaborated feedback wins.
- **Wood, W., & Neal, D. T. (2007).** A new look at habits and the habit–goal interface; context-cue habit formation. Wood (2019), *Good Habits, Bad Habits.*
- **Ye, J., et al. (2022, 2023).** SSP-MMC framework underlying FSRS. ACM SIGKDD 2022; IEEE TKDE 2023.
- **Zimmerman, B. J. (2002).** Becoming a self-regulated learner: An overview. *Theory into Practice,* 41(2), 64–70. Three-phase SRL model.

Open-spaced-repetition benchmark (Expertium, public GitHub project) — empirical FSRS-vs-SM-2 comparison on ~10,000 user collections.

---

## Limits of this review

**What was searched well.**
- Spaced repetition (FSRS-vs-SM-2 benchmark fetched directly; primary references verified).
- Retrieval practice / testing effect (multiple named meta-analyses; Wikipedia summary verified).
- Desirable difficulties (Wikipedia summary plus assistant-recalled Bjork papers).
- Spacing effect (Cepeda 2006; Bahrick 1993).
- Interleaving (Brunmair & Richter 2019 surfaced with effect size and moderator).
- Habit formation (Lally 2010; Wood & Neal — well-documented).
- Self-regulated learning (Zimmerman model; Sheldon self-concordance; Oyserman IBM).
- Deliberate-practice critique (Macnamara 2014 surfaced with specific variance figures).

**What was searched poorly or relied on prior knowledge.**
- Adesope, Trevisan & Sundararajan (2017) — could not directly access the paper; effect size and moderator details reported here are assistant-recalled and should be treated as starting points for verification.
- Specific peer-assessment meta-analyses (Topping) — only a Wikipedia-level summary obtained.
- LLM-as-grader literature — this is a fast-moving area where 2024–2026 findings may already supersede the 2023–2024 summaries here. Treat with caution.
- The Echo weekly review — there is genuinely thin literature, not just a search gap; this is the area where the design rests most on principle.
- Long-form retrieval practice on narrative-length material — the studies summarised here use short prose (250-word passages, single book chapters). Whetstone's literary-narrative category may involve much larger units. Behaviour at that scale is genuinely understudied.

**Method and time.**
- ~50 web queries across WebSearch and WebFetch.
- Many WebSearch returns were the assistant's training-data summaries rather than live results; these were cross-checked with WebFetch on Wikipedia where possible.
- About 90 minutes of search and writing.

**What this document is not.**
- Not a meta-analysis of meta-analyses; depth varies.
- Not a systematic review (no PRISMA, no inclusion criteria).
- Not material-specific pedagogy (per scope).
- Not advice on what to change. The TL;DR and per-topic "Bearing on whetstone" sections offer evaluation, but the design decisions remain the user's.
