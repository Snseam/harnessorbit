# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-15
- Primary product surfaces: local read-only Agent Monitor, started by the HarnessOrbit CLI.
- Evidence reviewed: README.md, docs/architecture.md, execution profiles, and two user-provided screenshots showing active/completed Codex agents and a phase-grouped Claude agent table. Screenshots are references, not shipped assets or instructions.

## Brand
- Personality: calm, precise, useful to a developer checking parallel work.
- Trust signals: visible connection state, last observation time, explicit source coverage and unknown states.
- Avoid: fake progress percentages, decorative charts, invented model names, equating idle with accepted work, remote assets or analytics.

## Product goals
- Goals: see the hierarchy and state of Codex coordinators/subagents, HarnessOrbit-dispatched agents, and their native children in one local page.
- Non-goals: terminal output, prompts, source diffs, launching/cancelling agents from the page, or provider/account configuration.
- Success signals: correct parent relationships, live state changes, no false completion, metadata-only network payloads, usable partial/empty/offline states.

## Personas and jobs
- Primary personas: a local developer using Codex and HarnessOrbit to coordinate coding sessions.
- User jobs: find running or blocked work, see which native children belong to a parent, distinguish observed completion from HarnessOrbit acceptance.
- Key contexts: many simultaneous tasks, long waits, interrupted agents, historical sessions, incomplete native telemetry.

## Information architecture
- Primary navigation: Project/Conversation switch within the selected project/run scope, agent/status filters, search, optional English/Chinese switch.
- Core routes/screens: one activity page with a hierarchical agent table and a metadata detail panel.
- Content hierarchy: scope and connection state; selected conversation and counts; active/waiting/finished/unknown agents with token usage; observation/source detail.
- Conversation identity: prefer the monitor-associated Codex conversation, preserve manual selection, and keep unverifiable ownership in Unlinked. Never infer parentage from a shared directory.
- Token interpretation: show native totals with scope/source/completeness in details; preserve recorded zero, show unavailable as a dash, and visibly mark partial observations. Do not sum parent and child rows into a task cost.

## Design principles
- Hierarchy before detail: keep ancestors visible when filtering a matching child.
- Evidence before confidence: show unknown/unavailable/stale explicitly. A native turn ending is distinct from a deliverable passing verification.
- Quiet updates: preserve selection, expansion, scroll and keyboard focus as data refreshes.
- Tradeoffs: readable density over decorative space; progressive disclosure for source and identity metadata.

## Visual language
- Color: warm ivory canvas and pale sidebar inspired by the user's reference; white surfaces; deep slate text; restrained violet selection; green/amber/red status accents paired with text/icons.
- Typography: offline system sans-serif, tabular numerals, monospaced abbreviated IDs in details; 14–16px body and no text below 12px.
- Spacing/layout rhythm: 4/8px increments, about 220px desktop sidebar, fluid main area, rows at least 44px.
- Shape/radius/elevation: subtle borders and 8–12px corners; little or no shadow.
- Motion: short 150–200ms state feedback; no layout animations or scroll reveal. Respect reduced motion.
- Imagery/iconography: small consistent local inline SVGs, no emoji structural icons, no copied app brand artwork.

## Components
- Existing components to reuse: none; this is the first browser surface.
- New/changed components: scope selector, source connection badge, count cards, filters, expandable agent rows, status badge, metadata panel, empty/offline notice.
- Variants and states: running, waiting, idle, completed, failed, cancelled, unknown; stale and source confidence are independent metadata.
- Token/component ownership: web/monitor/styles.css owns semantic CSS variables; web/monitor/app.mjs owns rendering and state; server only sends metadata.

## Accessibility
- Target standard: WCAG 2.2 AA-oriented implementation.
- Keyboard/focus behavior: native buttons/selects/inputs, visible focus, aria-expanded for disclosure, labelled controls, accessible detail close action.
- Contrast/readability: 4.5:1 body text; statuses always include words.
- Screen-reader semantics: headings, labelled activity region/table, concise polite connection announcements rather than every row update.
- Reduced motion and sensory considerations: disable decorative motion; never flash status changes.

## Responsive behavior
- Supported breakpoints/devices: desktop 1440/1024, tablet 768, mobile 375.
- Layout adaptations: collapse sidebar into scope controls; hide secondary columns into details; retain agent, hierarchy, status and tokens; reduce deep indentation and wrap task names on narrow screens; avoid page-level horizontal overflow.
- Touch/hover differences: clicks/taps are the primary actions; hover only adds feedback.

## Interaction states
- Loading: clear initial loading state, no fabricated rows.
- Empty: explain that no matching sessions are available and suggest checking scope or starting work through HarnessOrbit.
- Error: source-specific failures retain other valid data; no raw diagnostics containing paths/messages/secrets.
- Success: connected state plus accurate last refresh time.
- Disabled: unavailable metadata is shown as an em dash, not zero.
- Offline/slow network: retain last snapshot with explicit stale/disconnected notice and retry action.

## Content voice
- Tone: concise and factual.
- Terminology: Agent activity, Waiting, Finished turn, Accepted, Unknown; distinguish task delivery from native runtime state.
- Microcopy rules: no terminal details or tool payloads; explain only uncertainty that affects how users interpret the status.

## Implementation constraints
- Framework/styling system: plain HTML/CSS/ES modules; Node.js built-ins, no new npm runtime dependencies.
- Design-token constraints: semantic variables, no externally downloaded fonts/assets.
- Performance constraints: bounded source scans and result sizes, stable row order, incremental polling/stream updates; paginate large lists.
- Compatibility constraints: current local Codex/Claude interfaces, explicit fallback coverage, localhost-only authenticated metadata endpoints.
- Test/screenshot expectations: synthetic hierarchy/status fixtures, source and API privacy tests, real browser desktop/mobile/keyboard checks, real native parent-child lifecycle evidence when available.

## Open questions
- [ ] Native metadata coverage varies by version and hooks; document actual observed support, and never fill missing states by guessing.
- [x] User confirmed: default to the current HarnessOrbit project and its linked Codex/Claude descendants. Machine scope is an explicit CLI option; never silently collect unrelated projects.
