# Grabber

Desktop video/audio downloader. Electron UI on top of [yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg.

## Run
```
npm install
npm start
```

## Build installers locally
```
npm run dist      # output in dist/ (builds for the OS you're on)
```

## Notes
- The yt-dlp engine is downloaded on first launch into the app's data folder and self-updates on every start. Sites break extractors often, so restarting the app fixes most "can't download" errors.
- Builds are unsigned: Windows SmartScreen -> *More info -> Run anyway*. macOS -> right-click -> *Open*, or `xattr -cr /Applications/Grabber.app`.
- Single videos only (playlists are ignored on purpose).
- Replace `build/icon.png` (1024x1024) to change the app icon.
- Personal use only; respect copyright and each site's terms.
