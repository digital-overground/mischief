# Synchronize profile state through a file database

Mischief Instances in one VS Code profile share independently replaceable Workspace and Thread files through one deep Profile Database module. Projects are derived by grouping Workspace records by canonical Git root; each Workspace window is the sole writer for its Workspace and Threads, while other windows poll and read. This avoids stale aggregate `globalState` writes and a broker process. See the [profile database plan](../profile-database-plan.md) for implementation details.
