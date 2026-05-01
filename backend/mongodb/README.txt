MongoDB is no longer used by the app at runtime.

Persistence now uses a local SQLite database file. This directory is retained only
as a historical placeholder and is not copied into production desktop builds.
