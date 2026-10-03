---
tags: [input, tracking]
---
# Hand Tracking

Computer vision on headset cameras reconstructs the user's hands, typically as about 25 joints per hand, with no controller needed.

- Relies on [[Inside-Out Tracking]] cameras on the [[Head-Mounted Display]].
- Each joint has a pose, a position plus an orientation stored as a [[Quaternions|quaternion]].
- Exposed in [[WebXR]] through the `hand-tracking` feature.
- Lacks the haptics and buttons of [[VR Controllers]].
- Pinch gestures are a common select action.

Back to [[Index]].
