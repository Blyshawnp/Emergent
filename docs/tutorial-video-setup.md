# Tutorial Video Setup

MTS and SAM support optional local tutorial videos. No video is required, and no placeholder video should be committed. When the expected file is missing, the guided step-by-step tutorial remains the fallback.

## Recommended Location

Place tutorial videos in:

`frontend/public/assets/tutorial/`

Recommended MTS filenames:

- `tutorial.mp4`
- `mts-tutorial.mp4`

Recommended SAM filenames:

- `sam-tutorial.mp4`
- `sam-intro.mp4`

## Supported Formats

Use MP4 with H.264 video and AAC audio for the most reliable Electron playback.

## SAM Video Settings

SAM Help includes local tutorial video settings:

- Show video before tutorial
- Show video after tutorial
- Use video instead of tutorial
- Disable tutorial video
- Disable guided tutorial after video

These settings only affect the local device. If no SAM video exists, SAM ignores the video settings and uses the guided tutorial normally.

## Rebuild and Package

After adding or replacing a video, rebuild the React app and then rebuild/package the desktop app with the normal release process. For this repo, run the frontend build from `desktop`:

`npm run build:react`

Then run the normal packaging or clean rebuild command for the release you are preparing.

## No Video Behavior

If no recommended MTS file exists, MTS Help does not show "Watch Tutorial Video" and still shows Replay Tutorial.

If no recommended SAM file exists, SAM does not show "Watch Tutorial Video" and first-run/replay tutorial behavior stays guided-only.

## Test Checklist

1. Add an MP4 file to `frontend/public/assets/tutorial/` using one of the recommended MTS or SAM filenames.
2. Run `npm run build:react` from `desktop`.
3. Open MTS Help and confirm "Watch Tutorial Video" appears for an MTS video.
4. Open SAM Help and confirm "Watch Tutorial Video" appears for a SAM video.
5. Use SAM Help settings to test before, after, instead, and disabled modes.
6. Click the video button and confirm the local video opens with controls.
7. Remove or rename the video.
8. Rebuild and confirm each app falls back to Replay Tutorial without showing video controls.
