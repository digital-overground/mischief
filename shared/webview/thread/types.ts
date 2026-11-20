export interface ElicitationField {
  defaultValue?: string | number | boolean | string[];
  description?: string;
  label: string;
  name: string;
  options?: { description?: string; name: string; value: string }[];
  required: boolean;
  type: "text" | "number" | "boolean" | "select" | "multiselect";
}

export type ThreadInteraction =
  | {
      id: string;
      kind: "permission";
      message: string;
      options: { id: string; kind: string; name: string }[];
    }
  | {
      context?: string;
      fields: ElicitationField[];
      id: string;
      kind: "elicitation";
      message: string;
    };

export type ThreadInteractionResponse =
  | { action: "select"; optionId: string }
  | { action: "accept"; values: Record<string, unknown> }
  | { action: "cancel" };
