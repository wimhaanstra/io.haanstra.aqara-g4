# [APP][Pro] Aqara G4 Doorbell – live video, presses and settings, fully local

The Aqara G4 video doorbell now works in Homey with its camera.

Until now there were two ways to get the G4 into Homey, and neither showed the camera:

- The **official Aqara app** doesn't support the G4.
- The **HomeKit Controller app** can pair with it, but can't show its live video.

This app talks HomeKit to the doorbell directly, including the encrypted camera stream, and hands the video to Homey's own streaming service. That gives you:

- **Live video** in the Homey app, the web app and dashboards (Tiledash works too), on as many screens at once as you like. The app serves the stream to Homey once, so extra viewers don't strain it.
- **"Someone rang the doorbell"** Flow trigger with a snapshot of your visitor, ready to send as a push notification.
- **Motion** and **battery** on the device.
- **Doorbell controls**: chime on/off, chime volume, speaker volume, microphone, camera on/off (privacy mode), night vision and status light. Each is a device control, some with Flow cards ("Set chime volume", "Turn the chime on or off", "Turn the camera on or off", "Make the doorbell beep").
- **Snapshots** as the device's camera image, plus a "Take a snapshot" Flow action.
- **Live video quality** setting: High (1080p), Normal (720p) or Low (360p).
- Everything runs on your **local network**, without the Aqara cloud.

## Before you pair

A HomeKit accessory accepts only one controller. Remove the G4 from **Apple Home** or the **HomeKit Controller app** first.

If removing it there doesn't free the doorbell (Homey doesn't find it, or pairing fails with "already paired"), reset its HomeKit pairing in the Aqara Home app. On my doorbell that also reset its Wi-Fi, so it had to be set up in Aqara Home again. Skip the "add to Apple Home" step at the end.

Then add **Aqara G4 Doorbell** in Homey and type the 8-digit HomeKit setup code, or scan the HomeKit QR code on the doorbell or in its manual.

## Requirements

Homey Pro (2023 or later), Homey Pro mini or Homey Self-Hosted Server, version 12.12.0 or newer.

## Not (yet) included

- **Audio** in the live view (the doorbell uses AAC-ELD, which needs converting first).
- Settings that the G4 only exposes through the Aqara cloud: ringtones, motion sensitivity, face recognition and motion zones.

Feedback and bug reports are very welcome in this topic.
