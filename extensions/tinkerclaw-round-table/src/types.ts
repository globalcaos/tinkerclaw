export interface DebateOptions {
  depth?: "quick" | "standard" | "deep";
  maxRounds?: number;
  roles?: string[];
}

export interface DebateResult {
  consensus: string;
  confidence: number;
  dissent: string[];
  actionItems: string[];
  diversityScore: number;
  rounds: DebateRound[];
}

export interface DebateRound {
  number: number;
  proposals: RoleProposal[];
  challenges: string[];
  resolution: string;
}

export interface RoleProposal {
  role: string;
  position: string;
  reasoning: string;
}
