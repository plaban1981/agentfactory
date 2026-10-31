// The live agent office: the scene layout (generated into lib/office-scene.ts) and what each desk shows.
import type { AgentRole, AgentStatus } from "@/lib/ai-team";
import type { TaskRunStage } from "@/lib/workflow";

// Positions are in the background image's pixels, measured from its top-left corner.
export type OfficeSeat = {
  id: string;
  label: string;
  x: number;
  y: number;
  // Rendered width of the character; its height follows the sprite's aspect ratio.
  width: number;
  zIndex: number;
  character: { id: string; width: number; height: number; frames: string[] };
};

export type OfficeScene = {
  name: string;
  width: number;
  height: number;
  background: string;
  seats: OfficeSeat[];
};

// An agent at its desk, as sent to the office UI.
export type OfficeAgent = {
  id: string;
  role: AgentRole;
  name: string;
  status: AgentStatus;
  // The stage of a running task run this agent owns
  task: {
    key: string;
    title: string;
    stage: TaskRunStage;
    turns: number;
    maxTurns: number;
    round: number;
    branch: string | null;
    startedAt: string;
  } | null;
  lastActivity: { title: string; createdAt: string } | null;
  spentCents: number;
  budgetCents: number;
};

// How often the office polls for fresh statuses: quickly while someone is typing, slower when the team is idle.
export const OFFICE_REFRESH_MS = 3_000;
export const OFFICE_IDLE_REFRESH_MS = 10_000;
// Time per frame of the typing animation.
export const OFFICE_FRAME_MS = 140;
