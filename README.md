# Vexona Screen Recorder

Free desktop screen and window recording, custom regions, optional microphone/system audio and webcam, and local WebM files. Windows and Apple Silicon Mac builds are distributed through GitHub Releases.

## Recording safety

- Recording data is written to a temporary local file in bounded chunks while recording. The entire video is not held in memory.
- The app stays in Saving until finalization completes. A new recording cannot interrupt that save.
- Interrupted recordings appear in the recovery panel on the next launch. Recovery contains the data successfully written before interruption; review the ending before sharing.
- Failed writes can be retried or moved to another folder. Keep the app open to retain any unwritten buffered data.
- Quit and update installation wait for the recording to finish saving. UI sounds are muted during recording, pause and save so system loopback does not record those sounds.
- Gallery deletion moves a file to the system Trash or Recycle Bin.

## Privacy and supported formats

Captures are stored on the computer, without a recording-upload service or a Vexona account. The app checks its public GitHub repository for updates. Fonts and interface code are packaged locally.

The output format is WebM (VP9/VP8 video, Opus audio when enabled). Use a separate conversion tool if a destination requires MP4. System audio availability depends on the operating system, capture source and permissions. The Mac download is for Apple Silicon; no Intel build is advertised. Use the release notes and operating-system requirements for the selected build.

Windows installers currently have no publisher Authenticode certificate. Signing/notarization status should be verified for each published platform package; the existence of a Mac signature folder alone is not proof of Developer ID signing or notarization. Do not disable operating-system protections to run an untrusted download.

## Development and verification

```sh
npm ci
npm run check
npm test
npm run test:native
npm start
```

The native test uses generated video frames and synthetic audio with hidden test windows. It exercises the real sandboxed preload, recording pipeline, disk writer and local playback protocol. It does not access the desktop, camera or microphone. Native tests also run against the packaged app archive on Windows and macOS.

```sh
npm run build
npm run test:native -- --app-root dist/win-unpacked/resources/app.asar
```

Tag builds stage draft releases only after both platform checks pass. Check the generated SHA-256 manifests and native test reports before promoting a draft. Real-device checks remain necessary for OS permissions, microphone hardware, screen capture, mixed-DPI displays and sleep behavior.

License: MIT.
