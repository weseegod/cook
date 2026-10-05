---
name: skill-design-principles
description: Concise, high-signal principles for writing and editing skills well. Use whenever authoring or editing a skill.
---

# Skill design principles

Note: These principles should be applied both when writing skills from scratch and when editing existing skills. Before you respond, re-check your diff against every principle below **mechanically, not from memory**: for example, for each fact, value, or list you touched, search the skill files and confirm you did not deepen / add duplication in an unreasonable way. However, balance adherence to principles with the requests of the user --- never make significant changes / refactors that are not explicitly requested. If you notice such opportunities, complete the request first, then notify the user of the refactor opportunity after completing the request.   

- **One home per fact; maintain a single source of truth.** Keep each rule, value, or list in a single authoritative place others point to — don't restate it across files. If adding to / modifying a skill and you notice it already exists, do NOT refactor the user's skill unless explicitly requested to. Instead, make the requested change and notify the user of the existing redundancy and opportunity to refactor and reduce duplication. 

- **Avoid No-Op Statements / Sprawl.** If a statement is not required for the skill to function, remove it.
    - **Addendum: Avoid No-Op Guardrails.** It can often be tempting to add guardrails to avoid specific failures. However, it should be considered whether or not these guardrails are necessary in the context of concurrent edits. For example, if the skill contained "do X" and the user suggests to change to "do Y", the negation "do not do X" may not be necessary if it is sufficiently clear that "do Y" is the new instruction in the updated skill.

- **Avoid writing one-off-bandaids/patches for general problems.** Solve the underlying class of problem, not the single instance you were shown. Fix a bad output where the fact is owned so it cannot be produced, rather than adding a downstream check that only catches the one symptom; and prefer a general mechanism over minting a new hard-coded case that must then be enumerated everywhere. Generalize along predictable dimensions (for example, if the code crashed on a ".csv" file because delimited files are not supported, do not just state that ".csv" files are not supported, state that all delimited files are not supported) — but be precise, careful, and above all, correct in your generalizations. Do take care to avoid overgeneralizations. 