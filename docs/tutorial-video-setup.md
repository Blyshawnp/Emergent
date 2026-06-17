# Tutorial Video Setup

Mock Testing Suite supports an optional local tutorial video in Help. The guided step-by-step tutorial remains the fallback and no video is required.

## Recommended Location

Place the video in:

`frontend/public/assets/tutorial/`

Recommended filenames:

- `tutorial.mp4`
- `mts-tutorial.mp4`

## Supported Formats

Use MP4 with H.264 video and AAC audio for the most reliable Electron playback.

## Rebuild and Package

After adding or replacing the video, rebuild the React app and then rebuild/package the desktop app with the normal release process. For this repo, run the normal frontend build from `desktop`:

`npm run build:react`

Then run the normal packaging or clean rebuild command for the release you are preparing.

## No Video Behavior

If neither recommended file exists, Help does not show the "Watch Tutorial Video" button. The existing guided tutorial remains available from Help and first-run setup.

## Test Checklist

1. Add the MP4 file to `frontend/public/assets/tutorial/`.
2. Run `npm run build:react` from `desktop`.
3. Open Help.
4. Confirm "Watch Tutorial Video" appears.
5. Click it and confirm the local video opens.
6. Remove or rename the video.
7. Rebuild and confirm Help falls back to only "Replay Tutorial".
