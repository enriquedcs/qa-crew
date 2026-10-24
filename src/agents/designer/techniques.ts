import type { Technique } from "../../crew/contracts.ts";

// Classic test design techniques, written as instructions a model can follow.
// They are the same techniques you would teach a junior tester, which is the point:
// the Designer's quality comes from your craft, not from the model's imagination.

export interface TechniqueGuide {
  name: Technique;
  useWhen: string;
  instructions: string;
}

export const TECHNIQUE_GUIDES: Record<Technique, TechniqueGuide> = {
  "equivalence-partitioning": {
    name: "equivalence-partitioning",
    useWhen: "an input has groups of values the system should treat the same way",
    instructions:
      "Split each input into valid and invalid classes. Write ONE case per class, not one per value. " +
      "Name the class in the title, for example 'a whole number of guests above capacity'.",
  },
  "boundary-values": {
    name: "boundary-values",
    useWhen: "a rule has a limit: a minimum, a maximum, a date, a count",
    instructions:
      "For every limit, test the value on the limit and the first value outside it (for example capacity and capacity + 1). " +
      "Use the boundary_values tool to get the exact values. Boundaries are where off-by-one bugs live.",
  },
  "decision-table": {
    name: "decision-table",
    useWhen: "the outcome depends on a combination of conditions",
    instructions:
      "List the conditions and their combinations, collapse combinations with the same outcome, " +
      "and write one case per remaining rule of the table.",
  },
  "state-transition": {
    name: "state-transition",
    useWhen: "an object moves through states: booked, cancelled, checked in",
    instructions:
      "Cover each valid transition once, then the invalid transitions that matter most " +
      "(for example cancelling twice, booking a room after its booking was cancelled).",
  },
  pairwise: {
    name: "pairwise",
    useWhen: "several independent inputs each have a few values and testing every combination is too expensive",
    instructions:
      "Cover every pair of values at least once instead of every combination. Use it for configuration-like inputs, " +
      "not for business rules with a clear boundary.",
  },
  "error-guessing": {
    name: "error-guessing",
    useWhen: "a past bug or a known weakness suggests a specific failure",
    instructions:
      "Turn the past bug into a test that would have caught it. Cite the bug in the title or the steps.",
  },
};

/** Render the chosen techniques as one section of the system prompt. */
export function techniquesPrompt(techniques: Technique[] = Object.keys(TECHNIQUE_GUIDES) as Technique[]): string {
  return techniques
    .map((t) => {
      const g = TECHNIQUE_GUIDES[t];
      return `- ${g.name} (use when ${g.useWhen}): ${g.instructions}`;
    })
    .join("\n");
}
