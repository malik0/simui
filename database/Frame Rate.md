---
tags: [performance, comfort]
---
# Frame Rate

Frames drawn per second. VR headsets commonly run at 72, 90 or 120 Hz.

- At 90 Hz you have about 11.1 ms to render each frame (1000 / 90).
- Dropped frames raise [[Latency]] and cause judder and [[Motion Sickness]].
- Rendering is doubled by [[Stereoscopic Rendering]], so VR is demanding.
- In [[Three.js]], use `renderer.setAnimationLoop` so the headset drives timing, see [[WebXR]].
- Heavy [[Shaders]] and a wide [[Field of View]] cost frame time.
- Techniques include foveated rendering and reprojection.

Back to [[Index]].
