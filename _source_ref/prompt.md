# How DevCrew was built: the prompt log

DevCrew was built feature by feature with an AI coding agent (Claude Code). This file records the prompts in the order they were used. Each one comes with:

- **Why:** the reason for the prompt at that point in the build
- **What it built:** what it added or changed in the codebase, and where to look

Read it to see how the app grew, why things are shaped the way they are, and how to write prompts for the next feature.

Notes:

- Prompts are shown as they were written, with spelling tidied up. Secrets, OAuth codes and project IDs have been removed.
- Small follow-ups (fix this error, tweak that size) sit under the main prompt they belong to.
- The project started from a plain `create-next-app` scaffold (Next.js, TypeScript, Tailwind) before the first prompt.
- [AGENTS.md](AGENTS.md) is the rulebook the agent follows on every prompt. Prompt 2 created it, and later prompts kept it up to date.

## Contents

| # | Date | Feature |
| --- | --- | --- |
| 1 | Oct 22 | [Authentication](#1-authentication) |
| 2 | Oct 22 | [Workspaces, GitHub connection and the design system](#2-workspaces-github-connection-and-the-design-system) |
| 3 | Oct 22 | [Dashboard layout and sidebar](#3-dashboard-layout-and-sidebar) |
| 4 | Oct 22 | [Overview page layout](#4-overview-page-layout) |
| 5 | Oct 22 | [Sign-in fixes](#5-sign-in-fixes) |
| 6 | Oct 22 | [Kanban board](#6-kanban-board) |
| 7 | Oct 22 | [AI team page](#7-ai-team-page) |
| 8 | Oct 22 | [Budget enforcement](#8-budget-enforcement) |
| 9 | Oct 22 | [GitHub issues on the board and the Run button](#9-github-issues-on-the-board-and-the-run-button) |
| 10 | Oct 23 | [Planning the Switch Trust integration](#10-planning-the-switch-trust-integration) |
| 11 | Oct 23 | [Switch Trust integration with Cloudhike Jobs](#11-switch-trust-integration-with-cloudhike-jobs) |
| 12 | Oct 23 | [Switch Trust UI clean-up](#12-switch-trust-ui-clean-up) |
| 13 | Oct 23 | [The AI task pipeline](#13-the-ai-task-pipeline) |
| 14 | Oct 23 | [Real data on Overview and Activity](#14-real-data-on-overview-and-activity) |
| 15 | Oct 24 | [Live agent office](#15-live-agent-office) |
| 16 | Oct 25 | [Office scene assets](#16-office-scene-assets) |
| 17 | Oct 25 | [Landing page and placeholder clean-up](#17-landing-page-and-placeholder-clean-up) |
| 18 | Oct 25 | [Developer handoff docs](#18-developer-handoff-docs) |

---

## 1. Authentication

> Let's implement authentication using Better Auth. Use email/password, Gmail and GitHub sign-in. I already added `AUTH_URL`, `AUTH_PUBLISHABLE_KEY` and `AUTH_SECRET_KEY` in `.env.local`. Also, once a user signs in or signs up for the first time, save the user's information to the database (no webhook needed). Make sure the UI/UX for sign-in and sign-up is professional.

**Why:** Every other feature belongs to a user, so auth came first. A hosted Better Auth service meant no auth server to run. "No webhook needed" asked for a simple design: create the user row on first sign-in.

**What it built:**
- `/sign-in` and `/sign-up` pages with email, Google and GitHub, in `app/(auth)/`
- `lib/auth.ts`: the session cookie, `getCurrentUser()` and `getDbUser()`, which creates the `users` row the first time someone signs in
- `app/auth/callback/` and `app/api/auth/social/` for social sign-in
- `proxy.ts`: an optimistic redirect for signed-out visitors

---

## 2. Workspaces, GitHub connection and the design system

> Let's implement the Workspace page immediately after the user signs in. If the user is new or hasn't created any workspaces yet, redirect them to the **Create new workspace** page.
>
> Each workspace should have one GitHub repository attached, so AI agents can work on that repository's project.
>
> On the Workspace page, add options to enter a workspace name, select an icon or upload a custom logo, and connect a GitHub account. Once connected, the user should be able to select a GitHub repository and link it to the workspace.
>
> After completing these steps, clicking the **Next** button should take the user to the Dashboard page.
>
> Also, use the attached **design and typography palette** as a reference to keep the UI/UX consistent throughout the application.
>
> Add proper **design guidelines, typography rules, coding conventions and project folder structure** to `AGENTS.md`, so AI agents can follow them consistently.
>
> Make sure all theme colors are defined as **global CSS variables in `globals.css`**, so we can update the application's color scheme from a single file without modifying individual components.

Follow-up: pasted the URL of a failed GitHub OAuth callback ("Not connecting GitHub account"), which led to a fix in the GitHub connection flow.

**Why:** A workspace is the core idea: one team, one repository, one AI crew. The same prompt set up the rules for everything after it. `AGENTS.md` makes every later prompt follow the same conventions without repeating them, and putting every color in `globals.css` means the app can be re-themed in one file.

**What it built:**
- `/workspaces` (picker) and `/workspaces/new` (create flow), with server actions in `app/workspaces/actions.ts`
- A GitHub OAuth App flow (`app/api/github/connect` → `callback` → `repos`) with the token encrypted at rest (`lib/github.ts`, `lib/crypto.ts`)
- Private logo uploads to S3 (`lib/storage.ts`, `lib/workspace-logo.ts`), served through `app/api/workspaces/[id]/logo`
- `AGENTS.md`: the product, stack, folder structure, design system and coding conventions
- `app/globals.css`: `--palette-*` raw colors mapped to semantic Tailwind tokens

---

## 3. Dashboard layout and sidebar

> Let's implement the dashboard layout with a collapsible sidebar (icon-only mode).
>
> At the top, display the logo and app name. Below that, add a dropdown with the workspace name and an option to create a new workspace.
>
> Then show these sidebar menu options: 1. Overview 2. Board 3. AI Team 4. Pull Requests 5. Activity
>
> At the footer, show the user's profile image and name. When clicked, show the settings options.
>
> Also, add a header to the right of the sidebar with the user profile icon, notification icon, etc.

Follow-ups:
- "Increase the sidebar menu size a little. No need to use the exact shadcn component sizes."
- "Also use nice, colorful icons. I don't want a boring, typical UI/UX. I want a modern Dribbble-style template design."
- "Fix the sidebar collapsing to icons only."

**Why:** The dashboard shell is the frame every later page sits in, so it was built before the pages themselves. The follow-ups set the visual tone: colorful, modern, not stock shadcn.

**What it built:** `app/dashboard/layout.tsx`, the collapsible sidebar with a workspace switcher, the header, and the colorful icon tiles (`components/dashboard/icon-tile.tsx`, the `tone-*` color tokens).

---

## 4. Overview page layout

> Let's implement the Overview page layout. At the top, show three stats cards: **Open tasks, In progress, and PR ready**, with nice icons.
>
> Below that, show the **Upcoming tasks** list on the left and the **AI agent office space** on the right (just a placeholder for now).
>
> Below that, show the **Recent activity** section as a list.
>
> Since we don't have any real data yet, use dummy data for now. We'll update it with real data later.

**Why:** It locked in the layout of the home screen before the data behind it existed. Dummy data kept the prompt small. Real data replaced it in prompt 14.

**What it built:** `app/dashboard/page.tsx` and the cards in `components/overview/`.

---

## 5. Sign-in fixes

> Sign-in failed. We couldn't complete sign-in. Please try again.

> How do I get rid of `www`?

**Why:** Email sign-in worked, but Google and GitHub sign-in failed. `AUTH_URL` pointed at a host that redirected to its `www` version, and Node's `fetch` drops the `Authorization` header when it follows a redirect to another host. So the session lookup after social sign-in arrived without its token. The follow-up asked how to remove that `www` redirect at the domain level.

**What it built:** No code change. `AUTH_URL` was corrected in `.env` to avoid the redirect, and the follow-up covered turning off the domain's `www` redirect in the hosting settings. Lesson: point `AUTH_URL` (and every service URL) at the final host, with no redirect in between.

---

## 6. Kanban board

> Let's implement the Kanban board page. Create 5 vertical columns: **Todo, In development, In review, Testing and Done**.
>
> Use nice, light colors for each column and keep the UI/UX clean, modern and professional.
>
> Show cards for different issues, bugs and features. Add an option to create a new issue, bug or feature. When clicked, open a dialog where users can enter the important details, set the priority, and add other basic information.
>
> Also, make sure the cards can be dragged and dropped between columns.

Follow-up: "Remove the description line from the card. Clicking any card should open a dialog with its details, using the existing dialog form. Remove the Assignee field from the form."

**Why:** The board is where work enters the system. Its columns match the agent pipeline built later (Analyst → Developer → Reviewer → Tester → Done).

**What it built:** `app/dashboard/board/`, `components/board/` (columns, draggable cards with `@dnd-kit`, the create and edit dialog), the `tasks` table, and `lib/tasks.ts` / `lib/board.ts`.

---

## 7. AI team page

> Let's implement the AI agent page. At the top, add 3 stats cards: **Active agents, Switch Trust score and Monthly spending**.
>
> Below that, create and show 4 default agents with avatars: **Analyst, Developer, Reviewer and Tester**. Show each agent in a card with its status, budget progress against its budget, and **Configure** and **View activity** options.
>
> When the user clicks Configure, open a dialog to configure the agent's instructions, description, attached skills (default skills should already be included) and budget. Also show the Switch Trust score with a **Scan again** button, spending details, etc., with a nice design.
>
> When the user clicks View activity, open a side drawer with the agent's activity list.
>
> Use OpenAI to configure each agent with appropriate instructions. Give each agent access to all the default OpenAI agent tools, and show the available tools as chips.
>
> If anything is missing, let me know so we can implement it, or implement it and tell me what you added.
>
> Below that, add a placeholder for the **Live agent office workspace**, which we'll implement later.

Follow-ups:
- Pasted a runtime error (`formatCents is not a function`), which was fixed in `lib/format.ts`.
- "On the agent card, remove the description. The dialog also has too much data; trim it down a bit."

**Why:** The four agents are the product. This prompt gave them an identity (role, instructions, skills, tools) and a cost (budget, spending) before they did any real work. "Let me know what's missing" invited the agent to point out gaps, which became prompt 8.

**What it built:** `app/dashboard/ai-team/`, `components/ai-team/` (stats, agent cards, configure dialog, activity drawer), the `agents` and `agent_activities` tables, `lib/agents.ts` (seeds the default four), `lib/agent-defaults.ts`, `lib/ai-team.ts`, and "Write with AI" in `lib/openai.ts`.

---

## 8. Budget enforcement

> Let's implement point 2: budgets aren't enforced.

**Why:** After prompt 7, the agent listed what was missing, and point 2 was that budgets were only shown, never enforced. An agent that can spend without a limit is a real cost risk, so this was fixed before agents ran real tasks.

**What it built:** `lib/agent-budget.ts`: `assertAgentCanRun()` before every run and every model or tool call, and `recordAgentSpend()` as the only way to record a cost. The rule is in `AGENTS.md` under "Agent budgets".

---

## 9. GitHub issues on the board and the Run button

> Let's fetch the actual GitHub issues onto the Kanban board, so users see an issue as soon as it's added on GitHub. Also add a refresh button that fetches new issues from GitHub any time. Remove the Kanban placeholder dummy data.

Follow-ups:
- "Delete the dummy data for the Kanban board from the database too."
- "In the 3-dot menu on the task card, remove every option except Delete, and add a new Run option. Also add a green play button to run from the card. Basically, it assigns the task to the Analyst agent to start working on it."
- "Don't implement the Inngest logic yet." (Inngest was later removed in favor of Cloudhike Jobs.)

**Why:** It connected the board to the linked repository, so real issues become agent work. The Run button is the entry point for the pipeline built in prompt 13. The background job logic was deliberately left for later.

**What it built:** `lib/github-issues.ts` (syncs on board load, every 30 seconds while the board is open, and on Refresh), the Refresh button, and the Run action on cards.

---

## 10. Planning the Switch Trust integration

> To add Switch Agents Trust and ROI, and to explain the flow properly in my video chapter, give me the steps to show, so I can show them and then integrate step by step. (Do not implement it.)

> Not like that. I mean steps like: first go to https://www.switchagents.ai/, sign up, then the next step, like that.

> In our app, I want users to connect to SwitchAgents.ai with their own API key. Once it's added and connected, Switch Trust automatically scans our AI agents and scores them properly. Same for ROI. Tell me step by step how we can proceed. (Do not implement.)

> Check https://www.switchagents.ai/ and https://docs.switchagents.ai/, and now give me updated steps.

> So we can integrate it in our app, right?

**Why:** Planning prompts, deliberately marked "Do not implement". They checked that the integration was possible, using the real docs, before any code was written, and produced a step-by-step flow for the video. This pattern is worth reusing for any third-party integration.

**What it built:** No code. It produced a plan, which prompt 11 implemented.

---

## 11. Switch Trust integration with Cloudhike Jobs

> I want to integrate **Switch Agents Trust and ROI** into my app, so that Switch Trust scans my 4 AI agents as soon as the user adds their API key. Add an option on the AI agent page to add the Switch Agents API key when none is present, and save it.
>
> Whenever a user changes an AI agent, there should be a **Switch Agents scan** option to scan that agent and get a report with its trust score.
>
> Use only **one fast agent code scan**, so it finishes within a few seconds. Do not run all 4 agent evaluations.
>
> Also, make sure the scan runs **on demand**, so users can trigger it manually whenever they want.
>
> Use the **Cloudhike.dev Jobs service** for background jobs. Refer to the attached code reference and the API keys already in `.env`. Make sure it runs in the background and updates the score once it's ready.
>
> Refer to the Switch Agents Trust and ROI docs: https://docs.switchagents.ai/
>
> *(Attached: Cloudhike Jobs example code: `POST /runs` with `x-api-key`, then poll `/runs/{id}`.)*

Follow-ups, each pasting the exact error the app showed:
- "This key isn't linked to a Switch Agents Trust workspace." (after entering a key)
- "The last Switch Agents scan failed. Switch Trust: Evaluation run not found"
- "…aborted after 5 consecutive failures. Make sure to run only the agent code scan (static analysis), which runs for a short time."
- "…Your Switch Trust workspace has no 'Agent code scan (static analysis)' evaluation. Please check https://docs.switchagents.ai/"
- "Which scan is the easiest and fastest? Which evaluation runs fastest?"
- Pasted a failed Cloudhike run ("The URL answered 500", 4 of 4 attempts): "The job is failing on the Switch scan; fix it."

**Why:** It gives each agent an independent trust score, using the customer's own Switch Trust account. Scans take time, so they run as background jobs. Pasting real error messages and docs links got the agent to fix the integration step by step.

**What it built:**
- `lib/switch-trust.ts` (client, connection, agent registration, evaluations, cost caps) and `lib/switch-scan.ts` (the scan as a chain of jobs)
- `lib/jobs.ts`: the Cloudhike Jobs client, which enqueues jobs and verifies `x-cloudhike-signature`
- `app/api/jobs/switch-scan` (job target) and `app/api/switch/agents/[id]` (the endpoint Switch Trust red-teams, with a per-agent HMAC token)
- The `switch_connections` table, with the API key encrypted

---

## 12. Switch Trust UI clean-up

> Remove the trust scan from the dialog, and show an option to scan with Switch Trust. Show the evaluation score once the agent has been scanned, and only then show the score with a circular graph, like before. Also remove the trust score from the card and keep only the Switch Trust score.

> Remove the Switch Trust and ROI card from the agent page once it's connected with the API key. We don't need it after connecting, because we already show the stats.

**Why:** Once the real Switch Trust score existed, the earlier built-in trust score and the setup card were duplicates. These prompts removed them, so each number appears in exactly one place.

**What it built:** Changes to `components/ai-team/` (configure dialog, agent card, Switch Trust card).

---

## 13. The AI task pipeline

> Let's integrate our AI agents with the Kanban board. Here are the workflow steps.
>
> Add a setting on the Settings page to either **automatically pick up Todo tasks with the Analyst agent** or **manually run Todo tasks**. For development, we'll use the manual option for now.
>
> When a Todo task is run, the Analyst agent picks it up, understands the issue, bug or feature, and assigns it to the right agent.
>
> If the task needs development, the Developer agent picks it up, creates a new branch from the main branch of the connected GitHub repository, and starts working from the task requirements and any extra instructions from the Analyst.
>
> When development is done, the task moves to the Reviewer agent to review code quality, and then to the Tester agent to verify the implementation.
>
> The Tester only needs to verify that the changes were added to the right files, the branch was created properly, and everything is set up correctly. **No actual testing is needed for now.**
>
> After verification, either the Tester or the Developer should create a pull request (you decide which is better). Save the PR information to the database so we can show it on the Pull Requests page, where users can review and merge PRs.
>
> Also add a setting to control **PR merging: auto merge or manual merge**.
>
> If merge conflicts or build errors happen while merging, the Tester should create a new issue with all the relevant details and add it to the Todo column.
>
> Make sure each agent has a properly configured **max-turns limit**. This is very important, so agents can work through multiple iterations to finish their tasks.
>
> If you have any other questions, let me know.

Follow-up: "Once the Tester creates the PR, change the Run button and Run option to a check icon, and change the card color to show the PR is created, so the user knows."

**Why:** This is the core of the product: agents turning a ticket into a pull request. The prompt spelled out every hand-off, kept testing deliberately shallow for a first version, and insisted on max-turn limits so agent loops always end.

**What it built:**
- `lib/task-runs.ts`: starting runs, automatic pickup, the turn loop, stage hand-offs, rework rounds (`MAX_REWORK_ROUNDS`) and failures. Each step is a Cloudhike job at `/api/jobs/task-run`, or runs in `after()` during local development.
- `lib/agent-tools.ts`: the function tools agents use (list, read, write and delete files, diff), plus submit-call validation
- `lib/github-repo.ts`: branches, files, diffs, PRs and checks, with writes blocked on the default branch, `.github/workflows` and `.env` files
- `lib/pull-requests.ts`, `app/dashboard/pull-requests/` (merge buttons), and the Settings options in `lib/workflow.ts` (task pickup mode, merge mode, max turns)
- The `task_runs` and `pull_requests` tables, and the "PR created" state on board cards

---

## 14. Real data on Overview and Activity

> Let's update the Overview page with real data. Delete all the dummy data from the Overview page, and if there's no data, show an empty state. Do the same for the Activity page.

> On the Overview page, keep the AI team section empty, because we want to show the live agent office there.

**Why:** With real tasks, runs and PRs in place, the dummy data from prompt 4 could be replaced. Empty states keep new workspaces from looking broken.

**What it built:** `lib/overview.ts` (stats and upcoming tasks), `lib/activity.ts` (agent activity merged with tasks added to the board), `app/dashboard/activity/`, and the `components/activity/` timeline.

---

## 15. Live agent office

> Let's implement the live agent office space. I've already added the required JSON files to the `office` folder.
>
> Use the office image from the `public` folder or the JSON's `background` field, and position the agent assets on the office image at their exact positions.
>
> Even when the screen size changes, the characters' positions must stay consistent.
>
> For each agent, add a nice popover just above their head showing their current status.
>
> Also add a nice hover effect that shows a bit more about each agent, including what they're working on, their status, etc.
>
> Make it feel like a real, live office where AI agents are actively working.
>
> Reuse the same component on the AI agent page.
>
> Always keep the agents' statuses updated in real time, and show live typing animations according to the JSON files.

Follow-up: "Show a nice glow effect when hovering over an agent."

**Why:** It makes the AI team visible and fun to watch: you can see who's working on what, right now. It's the signature visual of the product, and the same component appears on Overview, the AI team page and the landing page.

**What it built:** `components/office/` (the scene with polling, each desk's sprite, status bubble and hover card), `lib/office.ts` (desk types, poll and animation timings), and the live statuses in `lib/agents.ts`.

---

## 16. Office scene assets

> Update `OFFICE_SCENE` with the new JSON file `office_1.json`.

> I updated `office_1.json`. If you think all the base64 images need converting, convert them into images, put them in the `public` folder, and update the office scene properly.

> Use `modern-office.png` as the office.

**Why:** The scene bundle stores every sprite as a base64 string, which made the client bundle huge. Turning them into static files makes the page load faster, and a script makes the conversion repeatable whenever the office design changes.

**What it built:** `scripts/extract-office.mjs` and `npm run office:extract`, which write sprites to `public/office/` and the layout to the generated `lib/office-scene.ts`, using `public/modern-office.png` as the background.

---

## 17. Landing page and placeholder clean-up

> Let's implement or remove any unused placeholder pages if there's no data available, and also implement a nice landing screen for the project.

**Why:** To get ready to share the app: no dead-end placeholder pages, and a public home page that explains the product.

**What it built:** `app/page.tsx` and `components/landing/` (including a sample agent office), with leftover placeholder pages implemented or removed.

---

## 18. Developer handoff docs

> Let's add every prompt we've used so far to a `prompt.md` file, with a proper comment on each explaining why we used it and what we were building. Also create a `.env.example` file with the proper env keys, and a `README.md` with the project setup. Make this project easy for other developers to understand.

**Why:** To hand the project to other developers.

**What it built:** This file, [README.md](README.md) (setup and how it works) and [.env.example](.env.example) (every environment variable, with a comment).

---

## Tips for your next prompt

What worked well in this project:

1. **Describe the feature as a user flow.** "When the user clicks X, open Y, which shows Z" gave better results than a list of components.
2. **Plan before you integrate.** For third-party services, ask for the steps first and say "Do not implement" (prompt 10). Then implement in a separate prompt.
3. **Link the real docs and paste example code.** Linking the Switch Trust docs and pasting the Cloudhike snippet kept the integration accurate.
4. **Paste exact errors.** Copying the error message, the job log or the failing URL got fixes much faster than describing the problem.
5. **Use dummy data first, real data later.** Build the layout with placeholders (prompt 4), then replace them in a focused prompt (prompt 14).
6. **Ask what's missing.** "Let me know what's missing, or implement it and tell me what you added" surfaced the budget gap (prompt 8).
7. **Put standing rules in `AGENTS.md`, not in every prompt.** Design tokens, conventions and safety rules (budgets, max turns, protected files) live there, so every prompt follows them automatically.
8. **Defer on purpose.** "Don't implement the Inngest logic yet" kept the scope tight until the right tool (Cloudhike Jobs) was chosen.
