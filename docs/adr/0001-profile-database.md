# Synchronize profile state through a file database

Mischief Instances in one VS Code profile share independently replaceable Workspace, Thread, and Workspace-selection files through one deep Profile Database module. Projects are derived by grouping Workspace records by canonical Git root; any Instance may change Workspace visibility, while each Workspace window is the sole writer for its Threads and other windows poll and read. This avoids stale aggregate `globalState` writes and a broker process. See the [profile database plan](../profile-database-plan.md) for implementation details.
