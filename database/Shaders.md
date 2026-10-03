---
tags: [graphics, software]
---
# Shaders

Small programs that run on the GPU. The two main kinds are vertex shaders (position each vertex) and fragment shaders (color each pixel).

- Written in GLSL for [[WebGL]].
- [[Three.js]] materials generate shaders for you; `ShaderMaterial` lets you write your own.
- Lens distortion correction is a fragment shader, see [[Fresnel Lens]] and [[Stereoscopic Rendering]].
- Expensive shaders cut [[Frame Rate]], and VR renders everything twice.

Back to [[Index]].
