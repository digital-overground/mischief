export interface AgentLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentSessionOperations {
  branchSummary: boolean;
  forkMessage: boolean;
  treeNavigation: boolean;
}

export interface AgentTreeNavigationOptions {
  summarize: boolean;
  customInstructions?: string;
}

export interface AgentTreeNavigationResult {
  draft?: string;
}
