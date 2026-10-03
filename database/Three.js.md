---
tags: [software, library]
---
# Three.js

A JavaScript 3D library created by Ricardo Cabello (mrdoob) and first released in 2010. It wraps [[WebGL]] with a friendlier API.

- Core objects: `Scene`, `Camera`, `Renderer`, `Mesh`, see [[Scene Graph]].
- Materials compile to [[Shaders]]; custom ones use `ShaderMaterial`.
- XR support: set `renderer.xr.enabled = true` and add a `VRButton`, see [[WebXR]].
- Use `renderer.setAnimationLoop` for the render loop, see [[Frame Rate]].
- Handles stereo cameras for [[Stereoscopic Rendering]].
- Bundled and served during development with [[Vite]].
- This project's first demo is a rotating cube.

Back to [[Index]].
