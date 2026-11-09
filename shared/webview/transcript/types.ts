export interface TranscriptImage {
  data: string;
  mimeType: string;
}

export interface RenderedTranscriptItem {
  id: string;
  kind:
    | "user"
    | "assistant"
    | "thought"
    | "tool"
    | "plan"
    | "completedPlan"
    | "system"
    | "branchSummary";
  text?: string;
  html?: string;
  images?: TranscriptImage[];
  title?: string;
  status?: string;
  toolKind?: string;
  input?: string;
  output?: string;
  locations?: { path: string; line?: number }[];
  diffs?: { path: string; oldText?: string; newText: string }[];
  queued?: number;
  cancelled?: boolean;
}

export interface RenderedThreadDetail {
  id: string | null;
  status: string;
  items: RenderedTranscriptItem[];
  forkSupported?: boolean;
  treeNavigationSupported?: boolean;
  sessionOperation?: string;
}

export interface RenderedSetupStep {
  item: RenderedTranscriptItem;
  options?: { id: string; label: string; description: string }[];
}
