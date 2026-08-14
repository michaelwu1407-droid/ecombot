# Working with Michael on this project

## How to report back

Michael is the founder, not the engineer. He does not read code and does not want to.

**Keep reports short.** A few lines per stage. If it takes more than a screen, it is
too long.

**Plain English, no jargon.** Say "Instagram blocks messages after 24 hours", not
"the messaging window constrains outbound sends outside the standard window". No
endpoint names, table names, function names, or file paths unless he asks. No spec
section numbers.

**Lead with what he has to decide.** Put decisions first, clearly marked, with a
recommendation. Everything else is optional detail he can skip.

**Skip the internals.** He does not need to know what the review pass caught, what
dependencies were considered, or how something is structured — unless it changes a
decision he has to make or costs him money or time.

Default shape of a report:

> **Decide:** [the one thing needing his input, with a recommendation]
>
> **Done:** [one or two lines on what now works, in terms of what a shopper or the
> merchant would see]
>
> **Next:** [one line]

If there is nothing to decide, say so and keep it to two lines.

Detail belongs in `docs/BUILD_LOG.md`, not in chat.

## The build

Built to `BUILD_SPEC.md`, following its stage order in §4.7. `docs/BUILD_LOG.md` is
the running technical record — deviations, flags, and findings for §4.10.
