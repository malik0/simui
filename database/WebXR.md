---
tags: [software, web]
---
# WebXR

The WebXR Device API lets web pages use [[Virtual Reality]] and augmented reality hardware. It replaced the older WebVR API.

- Requires a secure context (HTTPS, or localhost during development).
- A session is requested with `navigator.xr.requestSession('immersive-vr')`, which must follow a user gesture.
- Frames are driven by `requestAnimationFrame` on the session, see [[Frame Rate]].
- Provides poses for the viewer, [[VR Controllers]] and [[Hand Tracking]].
- Rendering goes through [[WebGL]].
- [[Three.js]] integrates it via `renderer.xr`.

Back to [[Index]].
