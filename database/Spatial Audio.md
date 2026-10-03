---
tags: [audio, perception]
---
# Spatial Audio

Sound rendered so it appears to come from a specific direction and distance, usually via headphones.

- Uses head-related transfer functions (HRTFs) to model how the ears and head filter sound.
- Listener pose comes from [[Six Degrees of Freedom]] tracking of the [[Head-Mounted Display]].
- The browser's Web Audio `PannerNode` supports it; [[Three.js]] wraps it as `PositionalAudio` attached to objects in the [[Scene Graph]].
- Must stay in sync with visuals, so it is sensitive to [[Latency]].
- Strongly improves presence in [[Virtual Reality]].

Back to [[Index]].
