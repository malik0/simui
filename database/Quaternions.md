---
tags: [math, tracking]
---
# Quaternions

A quaternion is a four-component number (x, y, z, w) that represents a 3D rotation.

- Avoids gimbal lock, which affects Euler angles.
- Interpolates smoothly with slerp.
- Compact and cheap to combine by multiplication.
- Used for orientation in [[Six Degrees of Freedom]] poses and in [[Hand Tracking]] joints.
- [[Three.js]] objects in the [[Scene Graph]] expose `.quaternion` alongside `.rotation`.
- The [[WebXR]] API returns poses with orientation as a quaternion.

Back to [[Index]].
