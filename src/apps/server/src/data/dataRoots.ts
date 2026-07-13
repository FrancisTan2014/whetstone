// The durable file roots a backup must capture alongside the database, resolved from server config.
// Kept pure and dependency-free so both the backup writer and the restore layout agree on exactly
// which roots exist and what they are named inside the archive (#600).

export type DataRootSpec = Readonly<{
  name: string;
  configuredPath: string;
}>;

export type DataRootConfig = Readonly<{
  sourceFilesDir: string;
  imageResourcesDir: string;
}>;

// Where the database dump and each file root land under a fresh restore target. The database goes
// under this subdirectory; each root goes under a subdirectory named for the root.
export const RESTORE_DATABASE_SUBDIR = "database";

export const SOURCE_FILES_ROOT = "sources";
export const IMAGE_RESOURCES_ROOT = "images";

export function resolveDataRoots(config: DataRootConfig): DataRootSpec[] {
  return [
    { name: SOURCE_FILES_ROOT, configuredPath: config.sourceFilesDir },
    { name: IMAGE_RESOURCES_ROOT, configuredPath: config.imageResourcesDir }
  ];
}
