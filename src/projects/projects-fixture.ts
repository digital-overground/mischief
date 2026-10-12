import type { ProjectsSnapshot, Workspace } from "./projects";

export const projectsFixture = (snapshot: {
  projects: { name?: string; root: string; workspaces: Workspace[] }[];
  ungrouped: Workspace[];
}): ProjectsSnapshot => {
  const workspaces = [
    ...snapshot.projects.flatMap((project) => project.workspaces),
    ...snapshot.ungrouped,
  ].toSorted((left, right) => left.name.localeCompare(right.name));
  const workspace = workspaces.find((candidate) => candidate.current);
  const projectRoot = workspace
    ? snapshot.projects.find((project) =>
        project.workspaces.includes(workspace)
      )?.root
    : undefined;
  return {
    navigation: {
      workspaces,
      ...(workspace
        ? {
            current: {
              workspace,
              ...(projectRoot === undefined ? {} : { projectRoot }),
            },
          }
        : {}),
    },
  };
};
