# DevCrew

DevCrew is an AI dev team for your GitHub repository. You create a **workspace**, link it to one repository, and four AI agents (Analyst, Developer, Reviewer and Tester) pick up tasks from a Kanban board, write the code on a new branch, review it, verify it, and open a pull request.

- **Workspaces:** each one has a name, an icon or logo, and exactly one linked GitHub repository.
- **Kanban board:** Todo, In development, In review, Testing and Done. GitHub issues sync onto the board automatically.
- **AI team:** configure each agent's instructions, skills, budget and max turns. Spending is tracked and budgets are enforced.
- **Task pipeline:** run a Todo task (by hand or automatically) and the agents take it from plan to pull request.
- **Pull requests:** merge from the app, by hand or with auto merge. A merge conflict or failed check makes the Tester file a new Todo task.
- **Live agent office:** a pixel-art office where you can watch each agent's status in real time.
- **Switch Trust:** optional trust score and ROI tracking for your agents ([switchagents.ai](https://www.switchagents.ai/)).

> New to the codebase? Read this file to get it running, then [AGENTS.md](AGENTS.md) for the architecture, folder structure, design system and coding rules. [prompt.md](prompt.md) tells the story of how the app was built, prompt by prompt.

---

## Tech stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, React 19, Server Components, Server Actions) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4, with every color token in `app/globals.css` |
| UI | shadcn/ui (`base-nova` on `@base-ui/react`), `lucide-react` icons, `@dnd-kit` drag and drop |
| Auth | Hosted Better Auth (email, Google, GitHub) |
| Database | Postgres + Drizzle ORM |
| File storage | S3-compatible, private objects |
| GitHub | OAuth App, with the token encrypted at rest |
| AI | OpenAI Responses API (`openai` SDK) |
| Background jobs | Cloudhike Jobs |
| Agent trust and ROI | Switch Trust API |

---

## Prerequisites

- **Node.js 20.9 or newer** and npm
- **Postgres 14+**: local, Docker, or hosted (Neon, Supabase, RDS…)
- A **hosted Better Auth** project (Cloudhike Auth service, [cloudhike.dev](https://cloudhike.dev)), for sign-in
- A **GitHub OAuth App**, to link repositories
- An **OpenAI API key**, for the agents
- *Optional:* an S3-compatible bucket (custom workspace logos), a Cloudhike Jobs project (required in production), a Switch Trust account, and [ngrok](https://ngrok.com/) or another tunnel (to test jobs and Switch Trust locally)

---

## Getting started

### 1. Install

```bash
git clone <this-repo-url> devcrew
cd devcrew
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill it in. Every key in [.env.example](.env.example) has a comment that says what it does, whether it's required, and where to get it. The minimum for a working local setup:

| Key | How to get it |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` |
| `DATABASE_URL` | Your Postgres connection string |
| `AUTH_URL`, `AUTH_PUBLISHABLE_KEY` | Your Auth service project dashboard |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The GitHub OAuth App ([see below](#github-oauth-app)) |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 48` |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

Quick local Postgres with Docker:

```bash
docker run -d --name devcrew-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=devcrew postgres:16
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/devcrew
```

### 3. Create the database tables

```bash
npm run db:push
```

This applies [db/schema.ts](db/schema.ts) to your database. Run it again whenever the schema changes. There's no seed step: each workspace's four default agents are created automatically the first time they're needed.

### 4. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign up, create a workspace, connect GitHub and pick a repository.

### GitHub OAuth App

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps** → **New OAuth App**.
2. Set **Homepage URL** to your `NEXT_PUBLIC_APP_URL`.
3. Set **Authorization callback URL** to `<NEXT_PUBLIC_APP_URL>/api/github/callback` (for example, `http://localhost:3000/api/github/callback`).
4. Copy the client ID, generate a client secret, and put both in `.env`.

Use a separate OAuth App for each environment (local, staging, production), because each one has a single callback URL.

> GitHub **sign-in** (on the sign-in page) is different: it's configured in the hosted Auth service dashboard. The OAuth App above only grants the agents access to repositories.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build. Run it before you open a PR |
| `npm run start` | Serve the production build |
| `npx tsc --noEmit` | Typecheck |
| `npm run db:push` | Apply `db/schema.ts` to the database |
| `npm run db:generate` | Generate SQL migration files into `drizzle/` |
| `npm run db:studio` | Browse the database in Drizzle Studio |
| `npm run office:extract` | Regenerate the office scene from `office/office_1.json` |

---

## How it works

### User flow

1. **Sign in** at `/sign-in` or `/sign-up` (email, Google or GitHub).
2. **Workspaces** at `/workspaces`. A new user is sent to `/workspaces/new` to name the workspace, pick an icon or upload a logo, connect GitHub and choose a repository.
3. **Dashboard** at `/dashboard`, for the current workspace (stored in the `devcrew_workspace` cookie):
   - **Overview:** stats, upcoming tasks, the live agent office, recent activity
   - **Board:** the Kanban board, with GitHub issues synced in
   - **AI team:** agent cards, configuration, budgets, activity, Switch Trust
   - **Pull requests:** open PRs opened by the agents, with merge buttons
   - **Activity:** the workspace timeline
   - **Settings:** account GitHub connection, workspace details, AI workflow (task pickup and merge mode)

### The task pipeline

```
Todo ──▶ Analyst ──▶ Developer ──▶ Reviewer ──▶ Tester ──▶ Pull request ──▶ Merge
            plans      commits to     reviews      verifies    opened by       manual
                       a new branch     │            │          the Tester      or auto
                           ▲            │            │
                           └── rework ──┴────────────┘   (up to MAX_REWORK_ROUNDS)
```

- A run starts when you press **Run** on a Todo card, or automatically when **Settings → AI workflow** is set to automatic pickup.
- The Developer works on a new branch cut from the default branch. Agents can never write to the default branch, `.github/workflows` or `.env` files.
- Each agent stops at its **max turns** (defaults: Analyst 20, Developer 60, Reviewer 20, Tester 15), and its last turn forces the stage's submit tool.
- Every model and tool call checks the agent's **budget** first and records what it spent.
- If a merge hits a conflict or a failed check, the Tester files a new Todo task with the details.

The pipeline lives in [lib/task-runs.ts](lib/task-runs.ts), the agents' file tools in [lib/agent-tools.ts](lib/agent-tools.ts), and budget enforcement in [lib/agent-budget.ts](lib/agent-budget.ts).

### Background jobs: development vs production

Each step of a task run is a background job. Cloudhike Jobs calls the signed `/api/jobs/task-run` route, which must be reachable from the internet.

- **Local development:** with no `JOBS_API_URL`, or a non-public `NEXT_PUBLIC_APP_URL`, runs execute in the background of `npm run dev` (Next.js `after()`). Nothing extra to set up.
- **Production:** set `JOBS_API_URL`, `JOBS_API_KEY` and a public https `NEXT_PUBLIC_APP_URL`.
- **Switch Trust scans** always need Cloudhike Jobs and a public URL, because Switch Trust calls back into `/api/switch/agents/[id]`. To test them locally, run `ngrok http 3000` and set `NEXT_PUBLIC_APP_URL` to the ngrok https URL (and add a matching callback URL to a GitHub OAuth App for that URL).

### Switch Trust (optional)

1. Sign up at [switchagents.ai](https://www.switchagents.ai/) and create an API key.
2. In DevCrew, open **AI team** and add the key. It's stored encrypted per workspace.
3. Press **Scan** on an agent. The scan runs in the background, and the agent's trust score appears when it finishes.

### Live agent office

The office scene comes from an AgentWorld scene bundle in [office/](office/). After changing `office/office_1.json`, run `npm run office:extract`. It writes the character sprites to `public/office/` and the layout to `lib/office-scene.ts`, and uses `public/modern-office.png` as the background.

---

## Project structure

```
app/          Routes: (auth), workspaces, dashboard/*, api/* (auth, github, jobs, switch), globals.css (the theme)
components/   UI by feature: board, ai-team, office, overview, pull-requests, settings, …, plus ui/ primitives
db/           schema.ts (Drizzle tables) and the db client
lib/          Server logic: auth, workspaces, tasks, agents, task-runs, github, openai, jobs, crypto, storage
office/       Office scene bundles (input for npm run office:extract)
public/       Static assets, including the office background and sprites
scripts/      extract-office.mjs
proxy.ts      Optimistic auth redirect for /dashboard and /workspaces
```

[AGENTS.md](AGENTS.md) explains every file in `lib/`, where new code goes, the design system and the coding conventions. Read it before your first change. AI coding agents (Claude Code, Codex, Cursor) read it automatically.

---

## Contributing

- Follow the conventions in [AGENTS.md](AGENTS.md): server-first components, auth and ownership checks in every action, colors only from the tokens in `globals.css`, and `@/` imports.
- After changing [db/schema.ts](db/schema.ts), run `npm run db:push`.
- Before you open a PR, make sure `npx tsc --noEmit` and `npm run build` both pass.
- Never commit `.env`. When you add a new environment variable, add it to [.env.example](.env.example) with a comment.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| GitHub connect fails or loops back with an error | The OAuth App's callback URL must exactly match `<NEXT_PUBLIC_APP_URL>/api/github/callback`, including the protocol, port and `www`. |
| `TOKEN_ENCRYPTION_KEY must be set…` | Set it to 32 or more random characters. If you changed it, reconnect GitHub. |
| "Background jobs need to reach this app at a public https URL" | Set `NEXT_PUBLIC_APP_URL` to your deployed URL or an ngrok https URL. |
| Social sign-in fails ("We couldn't complete sign-in"), but email sign-in works | `AUTH_URL` probably points at a host that redirects (for example, `cloudhike.dev` → `www.cloudhike.dev`). `fetch` drops the `Authorization` header on a cross-host redirect, so set `AUTH_URL` to the final host. Also check that Google or GitHub is enabled in the Auth service dashboard. |
| Task runs don't start | Set `OPENAI_API_KEY`, and connect GitHub as the workspace owner. Check that the agent's budget isn't used up. |
| Logo upload fails | Fill in all five `S3_*` keys. The bucket can stay private. |
