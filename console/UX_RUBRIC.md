# Gateway Console UX Rubric

Score every completed cycle against this rubric. A cycle may checkpoint at 80/100 or higher only when no safety or honesty gate fails.

## Safety and honesty — 25 points

- 5: Fixture data is unmistakable.
- 5: Delivery states remain distinct.
- 5: Unknown, zero, stale, unavailable, and error remain distinct.
- 5: No credential, prompt, argument, output, command, path, file, or environment value is exposed.
- 5: No interaction implies a mutation occurred when it did not.

**Hard gate:** any failure in this section blocks the checkpoint.

## Operator usefulness — 25 points

- 5: The first viewport answers what needs attention.
- 5: Traffic health and failures are immediately visible.
- 5: Tenant, environment, time range, and freshness are clear.
- 5: Every summary can lead to underlying evidence.
- 5: Common investigation paths require few steps.

## Information architecture — 20 points

- 5: Operate, Traffic, Control, Revenue, and System remain coherent.
- 5: Shipped operations are more prominent than planned products.
- 5: Dense information remains scannable.
- 5: Terminology matches Gateway contracts and documentation.

## Interaction quality — 15 points

- 5: Keyboard focus and overlays behave correctly.
- 5: Filters and drill-downs have clear state.
- 5: Loading, empty, stale, partial, and error experiences are useful.

## Visual quality — 10 points

- 5: The team-preview visual language is preserved: grid, black type, purple signal, restrained surfaces.
- 5: The logged-in product does not read like a landing page.

## Responsive quality — 5 points

- 3: No horizontal page overflow at 375px.
- 2: Primary operations remain understandable on mobile.

## Required evidence

Each cycle report records:

- selected backlog item;
- changed files;
- deterministic test result;
- desktop browser result;
- mobile browser result;
- browser-console result;
- rubric score;
- remaining risks;
- checkpoint commit.
