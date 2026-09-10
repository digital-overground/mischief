# Synchronize profile state through shared files

Mischief Instances in one VS Code profile coordinate through one deep Profile Sync module backed by independently owned files in profile storage. Per-record files and polling avoid stale `globalState` overwrites without introducing a broker, while each Workspace window retains ownership of its Agent runtime and running Threads. See the [profile synchronization plan](../profile-sync-plan.md) for implementation details.
