# 1.0.8

- Write bounded recording chunks to disk during capture, with interrupted-recording recovery, retry and save-to-another-folder controls.
- Prevent overlapping recordings, retain failed saves and wait for finalization before quitting or installing an update.
- Restrict privileged operations to their exact packaged window and frame; reject paths outside selected capture folders, filename traversal and symbolic links. Keep all windows sandboxed with web security and Content Security Policy.
- Use opaque local playback URLs with seeking support. Move gallery deletions to Trash/Recycle Bin and create unique filenames without replacing earlier captures.
- Keep recording timers active while minimized; correct selected-display region coordinates and show the region selector in its own native window.
- Clean up capture devices on failures, cancellation and disconnects; bound device startup, show audio levels and requested-audio failures, and mute interface sounds during capture.
- Update Electron and dependency packages; add regression tests, synthetic native recording/playback/audio/screenshot tests and Windows/Mac packaged-code release checks.

Recordings remain local WebM files. Recovery can contain only data written before an interruption. Existing Windows packages are unsigned. Real-device OS permission, hardware, mixed-DPI and sleep checks are separate from the automated synthetic tests.
