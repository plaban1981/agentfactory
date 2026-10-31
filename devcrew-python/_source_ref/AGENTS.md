# AGENTS.md

Guidance for AI coding agents working in this repository. Read it before making changes, and follow it.

## Product

DevCrew lets a team create **workspaces**. Each workspace is linked to exactly **one GitHub repository**, which the AI agents in that workspace work on.

User flow:

1. Sign in or sign up at `/sign-in` or `/sign-up` (hosted Better Auth: email, Google, GitHub).
2. Land on `/workspaces`. A user with no workspaces is redirected to `/workspaces/new`.
3. On `/workspaces/new`, the user enters a name, picks an icon or uploads a logo, connects GitHub, and selects a repository. **Next** creates the workspace and opens `/dashboard`.
4. `/dashboard` shows the current workspace (stored in the `devcrew_workspace` cookie). It redirects to `/workspaces/new` when the user has no workspaces.
5. Running a Todo task on the board (by hand, or automatically with the "AI workflow" setting) starts a **task run**: the Analyst plans it, the Developer commits to a new branch from the default branch, the Reviewer reviews it, and the Tester verifies the branch and opens a pull request. Review and verification can send the work back to the Developer up to `MAX_REWORK_ROUNDS` times. Pull requests are merged from `/dashboard/pull-requests`, or automatically with auto merge. A merge conflict or failed check makes the Tester file a Todo task.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, React 19, Server Components, Server Actions) |
| Language | TypeScript, strict |
| Styling | Tailwind CSS v4, with theme tokens in `app/globals.css` |
| UI primitives | shadcn/ui, `base-nova` style on `@base-ui/react` (`components/ui`) |
| Icons | `lucide-react` |
| Auth | Hosted Better Auth, used from the server only (`lib/auth.ts`) |
| Database | Postgres with Drizzle ORM (`db/schema.ts`) |
| File storage | S3, private objects (`lib/storage.ts`) |
| GitHub | OAuth App, with the token encrypted at rest (`lib/github.ts`, `lib/crypto.ts`) |
| Background jobs | Cloudhike Jobs, server only (`lib/jobs.ts`): it calls signed `/api/jobs/*` routes, optionally after a delay |
| AI | OpenAI Responses API via the `openai` SDK, server only (`lib/openai.ts`) |
| Task pipeline | `lib/task-runs.ts`: each step of a task run is a Cloudhike job (`/api/jobs/task-run`); without a public URL in development it runs in `after()` |
| Agent trust and ROI | Switch Trust API, server only (`lib/switch-trust.ts`), scans run as Cloudhike jobs (`lib/switch-scan.ts`) |

Commands:

```bash
npm run dev          # start the dev server
npm run build        # production build; run before you finish a task
npx tsc --noEmit     # typecheck
npm run db:push      # apply db/schema.ts to the database
npm run db:studio    # browse the database
npm run office:extract  # regenerate the office scene from office/office_1.json
```

## Folder structure

```
app/
  (auth)/              Sign-in and sign-up pages, their layout, and auth server actions
  auth/callback/       Social sign-in landing page (token arrives in the URL fragment)
  api/
    auth/social/       Starts Google or GitHub sign-in
    github/            connect → callback (OAuth for repository access), repos (list)
    workspaces/[id]/   logo: streams a private logo to the workspace owner
    switch/agents/[id] Evaluation endpoint Switch Trust red-teams (per-agent HMAC bearer token, only during a scan)
    jobs/              Cloudhike job targets (switch-scan, task-run); each verifies the x-cloudhike-signature
  github/connected/    End of GitHub OAuth: notifies the opener popup or redirects back
  workspaces/          Picker (page.tsx), new/ (create flow), actions.ts (server actions)
  dashboard/           Dashboard for the current workspace (page.tsx: Overview; activity/: workspace feed; board/: Kanban board; ai-team/: agents; pull-requests/; settings/; each with its actions.ts)
  globals.css          THE theme: every color token lives here
components/
  ui/                  Generic primitives (shadcn): button, input, label, card, form-alert
  layout/              App chrome: logo, app-header
  auth/                Auth-only components
  workspace/           Workspace components: form, pickers, avatar, icon registry
  board/               Kanban board: columns, draggable cards (@dnd-kit), create and edit task dialog
  ai-team/             AI team: stats, agent cards, configure dialog, activity drawer, Switch Trust card
  office/              Live agent office: the scene with polling (agent-office) and each desk's sprite, status bubble and hover card
  pull-requests/       Pull request list with merge buttons
  overview/            Overview cards: stats, upcoming tasks, AI team (the live office), recent activity
  activity/            Workspace activity timeline and its icon styles
  settings/            Settings forms (account GitHub connection, workspace name and icon, AI workflow)
  landing/             Public landing page pieces (the sample agent office)
db/
  schema.ts            Drizzle tables and inferred types
  index.ts             db client; re-exports the schema
lib/
  auth.ts              Session cookie, getCurrentUser(), getDbUser(), safeRedirect()
  workspaces.ts        Workspace queries and the current-workspace cookie
  tasks.ts             Board task queries, always scoped to a workspace
  overview.ts          Overview stats and upcoming tasks
  activity.ts          Workspace activity feed: agent activities merged with tasks added to the board
  board.ts             Task statuses, types, priorities and limits shared by client and server
  ai-team.ts           Agent roles, skills, OpenAI tools, limits and types shared by client and server
  workflow.ts          Task pickup and merge modes, run stages, max-turn limits and pipeline types shared by client and server
  agents.ts            Agent queries (seeds the four default agents), the office's live statuses and the trust scan
  office.ts            Office scene and desk types, poll and animation timings, shared by client and server
  office-scene.ts      Generated by `npm run office:extract` from office/*.json: background, seat positions and frames
  agent-budget.ts      Budget enforcement: run gate and the only way to record agent spend
  agent-defaults.ts    Default name, description, instructions, skills, budget and max turns per role
  agent-tools.ts       Function tools agents use on a run (list, read, write and delete files, diff) and submit-call validation
  task-runs.ts         The task pipeline: starting runs, automatic pickup, the turn loop, stage hand-offs and failures
  pull-requests.ts     Opens, lists, refreshes and merges pull requests; files a Todo task when a merge is blocked
  openai.ts            OpenAI client: writes agent instructions, reviews them, and answers prompts as an agent
  switch-trust.ts      Switch Trust client: connection, agent registration, evaluations, cost caps, scan queueing
  switch-scan.ts       Switch Trust scan, run as a chain of Cloudhike jobs
  jobs.ts              Cloudhike Jobs client: enqueue jobs and verify their signatures
  github.ts            GitHub API client and repository types
  github-repo.ts       Branches, files, diffs, pull requests and checks, by repository id
  github-issues.ts     Syncs repository issues onto the board (on board load, every 30s while open, and on Refresh)
  crypto.ts            AES-256-GCM encrypt/decrypt for secrets at rest
  storage.ts           S3 put/get/delete
  workspace-limits.ts  Validation limits shared by client and server
  workspace-logo.ts    Validates uploaded workspace logos by their bytes and names their S3 keys
  format.ts            Formatting helpers (timeAgo)
  utils.ts             cn()
office/                AgentWorld scene bundles; `npm run office:extract` writes their sprites to public/office/; the background is public/modern-office.png
scripts/               extract-office.mjs
proxy.ts               Optimistic auth redirect for /dashboard and /workspaces
```

Where new code goes:

- A new feature gets its own `components/<feature>/` folder and, if it has routes, `app/<feature>/`.
- Server actions go in an `actions.ts` next to the route that owns them.
- Server-only modules start with `import "server-only";`.
- Constants that both client and server code need go in a plain module in `lib/`. A `"use server"` file may only export async functions, and route files may only export HTTP handlers and route config.
- `components/ui` is for generic, feature-agnostic primitives only. Add shadcn components with `npx shadcn@latest add <name>`, then make sure they use theme tokens.

## Design system

The visual reference is the **Blue Theme Color Palette**, a modern developer SaaS look: a calm slate canvas, white cards, one confident blue for actions, and generous whitespace.

### Colors: always use tokens

All colors are defined **once**, as CSS variables in `app/globals.css`:

1. `--palette-*` holds the raw hex values for light mode (`:root`) and dark mode (`.dark`). **To re-theme the app, change only these values.**
2. Semantic tokens (`--primary`, `--heading`, `--success`, …) point at palette variables and are exposed to Tailwind through `@theme inline`.

Rules:

- **Never** hardcode hex, rgb or oklch values, and never use Tailwind palette colors (`blue-600`, `zinc-900`, `emerald-500`, `white`, `black`) in components. If a color is missing, add a palette variable and a semantic token in `globals.css`.
- Use opacity modifiers for soft variants: `bg-success/10`, `border-destructive/30`, `ring-primary/20`.

| Palette | Hex (light) | Tailwind token | Use for |
| --- | --- | --- | --- |
| Primary | `#2563EB` | `bg-primary`, `text-primary`, `border-primary` | Primary buttons, links, active and selected states |
| Primary Hover | `#1D4ED8` | `hover:bg-primary-hover`, `text-primary-hover` | Hover on primary; text on tinted backgrounds |
| Accent | `#3B82F6` | `brand-accent`, `ring` | Highlights, hover borders, focus rings |
| Soft Blue | `#DBEAFE` | `brand-soft` | Subtle backgrounds, avatar borders, badges |
| Tint | `#EFF6FF` | `brand-tint`, `accent`, `secondary` | Light sections, hover and selected rows |
| Heading | `#0F172A` | `text-heading`, `foreground` | Headings, titles, emphasized values |
| Body | `#334155` | `text-body` (default on `body`) | Body copy |
| Secondary | `#64748B` | `text-subtle`, `text-muted-foreground` | Descriptions, helper text, metadata |
| Muted | `#94A3B8` | `text-faint` | Placeholders, hints, decorative icons only (low contrast: never for essential text) |
| Border | `#E2E8F0` | `border` (default), `input` | All borders and dividers |
| Surface | `#FFFFFF` | `bg-card`, `bg-popover` | Cards, panels, inputs, menus |
| Canvas | `#F8FAFC` | `bg-background`, `bg-muted` | App background, wells, empty states |
| Success | `#10B981` | `success` | Success states, "connected" dots |
| Warning | `#F59E0B` | `warning` | Warnings |
| Error | `#EF4444` | `destructive` | Errors, destructive actions, `aria-invalid` |
| Info | `#3B82F6` | `info` | Informational notices |
| Ink | `#0F172A` | `brand-panel`, `brand-panel-foreground` | Always-dark brand panels (auth showcase) |
| Tones | blue `#3B82F6`, violet `#8B5CF6`, pink `#EC4899`, emerald `#10B981`, amber `#F59E0B`, cyan `#06B6D4` | `tone-blue` … `tone-cyan` | Decorative only: icon tiles (`<IconTile>` in `components/dashboard/icon-tile.tsx`) and illustrations. Never for text |

Text on filled primary or status backgrounds uses the matching `*-foreground` token (`text-primary-foreground`).

### Typography

Font: **Geist Sans** (`font-sans`, the default) for all UI. Use **Geist Mono** (`font-mono`) for code, branch names, hashes and IDs. Use only these two families.

| Role | Classes |
| --- | --- |
| Page title (h1) | `text-3xl font-semibold tracking-tight` (auth pages: `text-2xl`) |
| Section title (h2) | `text-base font-semibold tracking-tight` (`text-lg` for standalone cards) |
| Eyebrow | `text-sm font-semibold text-primary` or `text-xs font-semibold tracking-wide uppercase text-subtle` |
| Lead or subtitle | `text-base text-subtle` |
| Body | `text-sm text-body` (the default UI size is `text-sm`) |
| Label | `text-sm font-medium` (the `<Label>` component) |
| Helper or meta | `text-xs text-subtle`, or `text-xs text-faint` for non-essential hints |
| Code | `font-mono text-body` |

- Headings get `text-heading` automatically from the base layer. Don't recolor them.
- Use weights 400, 500 and 600 only. Use `font-bold` only in the logo mark.
- Use sentence case everywhere ("Create workspace", not "Create Workspace").

### Layout and components

- **Page shell:** `min-h-svh bg-background`, with `<AppHeader>` at the top. Content sits in `mx-auto px-4 sm:px-6` with `max-w-2xl` (forms), `max-w-3xl` (lists) or `max-w-6xl` (dashboards), and `py-10 sm:py-14`.
- **Cards and sections:** `rounded-2xl border bg-card p-6 shadow-xs`. Smaller rows use `rounded-xl` or `rounded-lg`.
- **Spacing:** `space-y-6` between sections, `space-y-4`/`space-y-5` inside them, and `space-y-2` between a label and its input.
- **Buttons:** use `<Button>` from `components/ui/button`. Use `variant="default"` (primary) for the main action, with one primary button per view. Use `outline` for secondary actions and `ghost` for tertiary actions. Main form actions use `size="lg"` with `h-10`. For links that look like buttons, use `buttonVariants()` or the matching token classes.
- **Inputs:** use `<Input>` and `<Label>`. Height is `h-10`. Validation errors set `aria-invalid`.
- **Alerts:** use `<FormAlert tone="error" | "success" | "info">` from `components/ui/form-alert`.
- **Selectable items** (icon grid, repository list): use `role="radio"` with `aria-checked`. The resting state is `border bg-card`, hover is `hover:border-brand-accent hover:bg-brand-tint`, and the selected state is `border-primary bg-brand-tint text-primary`.
- **Focus:** every interactive element needs a visible focus style (`focus-visible:ring-3 focus-visible:ring-ring/40`).
- **Loading:** show `Loader2` with `animate-spin` inside the button and change its label ("Creating workspace…"). Skeletons use `animate-pulse rounded bg-border`.
- **Empty states:** use `border border-dashed bg-muted`, a centered icon in a `bg-card` tile, a short title and one action.
- **Icons:** lucide at `size-4` inline and `size-5` in tiles. Brand logos (Google, GitHub) live in `components/auth/provider-icons.tsx`.
- **Workspace identity:** always render it with `<WorkspaceAvatar>`. Built-in icons are registered in `components/workspace/workspace-icons.tsx`.
- **Responsiveness:** design mobile-first, with no horizontal scroll at 360px. Hide secondary labels below `sm:`.

## Coding conventions

- **Server first.** Pages are async Server Components that load data and `redirect()` when needed. Add `"use client"` only to leaf components that need state, effects or browser APIs.
- **Auth checks:** every page, route handler and server action that touches user data calls `getDbUser()` (or `getCurrentUser()`) itself. `proxy.ts` is an optimistic redirect only, not a security boundary.
- **Ownership:** query workspaces through `lib/workspaces.ts` helpers, which always filter by `ownerId`. Never load a workspace by id alone.
- **Server actions:** take `(prevState, formData)` with `useActionState`. Validate every field on the server and return `{ error, field }` for problems the user can fix. Call `redirect()` on success.
- **Untrusted input:** validate uploads by their bytes, not their MIME type. Pass redirect targets through `safeRedirect()`. Re-fetch external resources (for example, the GitHub repo by id) instead of trusting client-sent details.
- **Agent budgets:** anything that runs an agent calls `assertAgentCanRun()` from `lib/agent-budget.ts` before the run and before every model or tool call, and records every cost with `recordAgentSpend()`. Never insert activities with a `costCents` directly.
- **Agent turns:** every agent loop stops at the agent's `maxTurns`, and its last turn forces the stage's submit tool. Agents only write to their run's branch, never to the default branch, `.github/workflows` or `.env` files (`lib/github-repo.ts`).
- **Secrets:** OAuth tokens are encrypted with `lib/crypto.ts` before they are stored and are never sent to the client. Never add `NEXT_PUBLIC_` to a secret.
- **Files:** S3 objects are private. Serve them through an authenticated route handler, never through public URLs.
- **Database:** change `db/schema.ts`, then run `npm run db:push`. Tables use snake_case columns and camelCase TypeScript fields, include `createdAt` (and `updatedAt` when rows are mutable), and use `onDelete: "cascade"` from owned rows to their user.
- **Naming:** files are `kebab-case.tsx`. Components are `PascalCase` named exports (except Next.js `page`/`layout` defaults). Hooks are `useX`. Server actions end in `Action`. Constants are `SCREAMING_SNAKE_CASE`.
- **Imports:** always use the `@/` alias. Order them: React and Next, third-party, `@/lib`, `@/app`, `@/components`.
- **Style:** use double quotes, semicolons and two-space indentation. Write a short comment only where intent isn't obvious. Don't leave dead code or unused style objects behind.
- **Accessibility:** use semantic elements, give icon-only buttons an `aria-label`, use `role="alert"` for errors, and give decorative images `alt=""`.
- **Before finishing:** run `npx tsc --noEmit` and `npm run build`, and make sure both pass.

## Environment variables

See `.env.example`. Workspaces require these in addition to the auth and database settings:

- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: a GitHub **OAuth App** whose callback URL is `<NEXT_PUBLIC_APP_URL>/api/github/callback`. It requests the scopes `repo read:user`.
- `TOKEN_ENCRYPTION_KEY`: a random string of 32 or more characters. Changing it invalidates stored GitHub tokens, and users must reconnect.
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: storage for workspace logos.
- `OPENAI_API_KEY` (optional) and `OPENAI_MODEL` (optional, defaults to `gpt-5-mini`): "Write with AI" for agent instructions and the OpenAI half of the trust scan. Without a key, scans use the built-in checks only.
- Task runs need `OPENAI_API_KEY` and the workspace owner's GitHub connection. In production they also need `JOBS_API_URL`, `JOBS_API_KEY` and a public https `NEXT_PUBLIC_APP_URL` so Cloudhike can reach `/api/jobs/task-run`; in development without them, runs work in the background of the dev server.
- Switch Trust has no environment variables: each workspace adds its API key (encrypted at rest) on the AI Team page. Scans need `OPENAI_API_KEY`, `JOBS_API_URL` and `JOBS_API_KEY` (Cloudhike Jobs), and a public https `NEXT_PUBLIC_APP_URL` so Cloudhike can reach `/api/jobs/switch-scan` and Switch Trust can reach `/api/switch/agents/[id]`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
