---
tags: [software, tooling]
---
# Vite

A frontend build tool and dev server created by Evan You. "Vite" is French for "quick".

- Serves source files as native ES modules in development, giving fast startup and hot module replacement.
- Production builds are bundled for deployment.
- Resolves bare imports like `import * as THREE from 'three'`, see [[Three.js]].
- The dev server runs on localhost, which counts as a secure context for [[WebXR]]. Testing on a headset over a LAN IP needs HTTPS.
- Scripts in this project: `npm run dev`, `build`, `preview`.

Back to [[Index]].
