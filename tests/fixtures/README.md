# Test fixtures

`CA.jpg`, `C.jpg`, `video1.mp4` and `dashinit.mp4` are signed sample files from the C2PA project
(https://github.com/contentauth/c2pa-rs, `sdk/tests/fixtures`), used to test Content Credentials
verification against real data. They are signed with C2PA's *test* certificates.
c2pa-rs is dual-licensed under MIT and Apache-2.0.

`viper.mp3` (MDN webaudio-examples), `mdn_video.webm` (MDN learning-area, "rabbit320") and `test1_head.mkv`
(first 1.5 MB of the Matroska project's official `test1.mkv`) are real third-party media files used to check that the
container parsers report the values stored in the files. The `.ogg` files were encoded with libsndfile (Vorbis and
Opus), `tiny_mono_aac.m4a` with macOS `afconvert`, from `tiny.wav`.
