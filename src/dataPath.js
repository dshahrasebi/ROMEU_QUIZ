'use strict';
/**
 * Resolves the persistent data directory once, shared by server.js and db.js.
 *
 * Root cause this guards against: Railway wipes the container filesystem on every
 * redeploy. Data only survives if it's written to the mounted Volume. Railway
 * auto-injects RAILWAY_VOLUME_MOUNT_PATH when a Volume is attached to the service —
 * that's the source of truth. A stale/relative DATA_PATH (e.g. "./data", left over
 * from local-dev config copied into production) silently overrides the safe default
 * and points writes at the ephemeral container layer instead of the volume, so all
 * quizzes vanish on the next deploy even though the volume is attached correctly.
 */

const path = require('path');

function resolveDataPath(env = process.env) {
  const railwayVolume = env.RAILWAY_VOLUME_MOUNT_PATH;
  const explicit = env.DATA_PATH;

  // A relative DATA_PATH in production never survives a redeploy (the whole
  // container filesystem is rebuilt). If Railway tells us where the real
  // Volume is mounted, trust that over a relative override.
  const explicitIsUnsafeRelative = explicit && !path.isAbsolute(explicit) && env.NODE_ENV === 'production';

  if (railwayVolume && (!explicit || explicitIsUnsafeRelative)) {
    if (explicitIsUnsafeRelative) {
      console.warn(
        `[dataPath] Ignoring relative DATA_PATH="${explicit}" in production — it does not persist across redeploys. ` +
        `Using Railway's mounted volume at "${railwayVolume}" instead.`
      );
    }
    return railwayVolume;
  }

  if (explicit) return explicit;

  return '/data';
}

const DATA_PATH = resolveDataPath();

if (process.env.NODE_ENV === 'production' && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn(
    `[dataPath] WARNING: No RAILWAY_VOLUME_MOUNT_PATH detected. Resolved data directory "${DATA_PATH}" ` +
    `will NOT survive a redeploy unless a Volume is attached and mounted there. ` +
    `Attach a Volume in Railway → Settings → Volumes, or your quizzes will be lost on every deploy.`
  );
} else {
  console.log(`[dataPath] Using data directory: ${DATA_PATH}`);
}

module.exports = { DATA_PATH, resolveDataPath };
